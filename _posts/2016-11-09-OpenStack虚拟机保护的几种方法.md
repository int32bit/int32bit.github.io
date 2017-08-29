---
layout: post
title: OpenStack虚拟机保护的几种方法
catalog: true
tags: [OpenStack]
---

## 1.虚拟机保护的重要性

虚拟机是OpenStack中最重要的角色之一，我们接触比较多的Nova服务就是通过虚拟机方式提供计算虚拟化服务。除此之外，还有很多高层服务也是完全依赖于Nova服务提供的虚拟机，比如Sahara大数据服务、Magnum容器编排服务、Manila文件共享服务以及Trove数据库服务等，这些服务底层都是基于虚拟机实现的。虚拟机的保护至关重要，不仅承载着用户活动的业务，还保存着用户的重要数据。虚拟机意外丢失不仅可能导致用户业务中止，还可能导致重要数据的丢失，甚至造成重大生产事故，**虚拟机的保护不容忽视！**

OpenStack Nova服务相对来说比较成熟了，虚拟机通常不会出现突然消失的情况，排除天灾，剩下的就是人祸了，最危险的莫过于误删除操作，危险等级不亚于以下几种:

1. `rm -rf /`
2. `ceph osd pool delete rbd rbd --yes-i-really-really-mean-it`
3. `drop database nova;`

不幸的是，OpenStack一直没有一套完善的虚拟机保护机制，默认的权限策略也存在一定的问题:

* admin是全局的，只要属于admin组，就能够操作所有租户的资源，删除所有虚拟机只需一个命令。
* 虚拟机的Lock感觉形同虚设，admin完全无视任何锁。

当然尽管不完善，OpenStack针对虚拟机的保护措施还是做了一些工作的，本文接下来将逐一介绍。

## 2.Lock机制

OpenStack很早就开始支持对虚拟机加锁操作:

```
usage: nova lock <server>
Lock a server. A normal (non-admin) user will not be able to execute actions
on a locked server.
```

被locked的虚拟机不允许非管理员执行任何操作，包括delete、reboot、resize、rebuild、migrate等等。但是到目前为止也没有实现通过API获取虚拟机的锁状态，换句话说，只有当你执行以上操作时，才会莫名其妙地告诉你执行失败了，因为虚拟机被加锁了:

```
$ nova delete 5a7b14b0-a47c-47be-98bb-92e139d16b00
Instance 5a7b14b0-a47c-47be-98bb-92e139d16b00 is locked (HTTP 409) (Request-ID: req-6366a53b-d696-47cc-8111-1a760b8d0253)
ERROR (CommandError): Unable to delete the specified server(s).
```

2014年2月就已经有人提关于查看虚拟机lock状态API实现BP：[get-lock-status-of-instance](https://blueprints.launchpad.net/nova/+spec/get-lock-status-of-instance)，目前已被标记为`Slow progress`。

需要注意的是，正如前面所言，管理员账号是无视锁的，检查锁的代码非常简单:

```python
def check_instance_lock(function):
    @functools.wraps(function)
    def inner(self, context, instance, *args, **kwargs):
        if instance.locked and not context.is_admin:
            raise exception.InstanceIsLocked(instance_uuid=instance.uuid)
        return function(self, context, instance, *args, **kwargs)
    return inner
```

我们为了强化锁的作用，直接把if后面的`and not context.is_admin`去掉了，这样即使是管理员在确认需要删除虚拟机时也必须先unlock，一定程度上提高了虚拟机的安全性。

注意: **锁定的虚拟机即使执行`nova force-delete`也会失败。**

## 3.soft-delete

微信聊天时如果不小心说错话了，两分钟内可以立马撤回消息，~~并不明觉厉地向对方扔一个`对方撤回了一条消息`~~。不小心误删虚拟机时，你是否也会在心里想如果可以撤回刚刚的操作该多好！

值得庆幸的是，OpenStack原生支持软删除操作。开启了软删除功能后，删除的虚拟机不会立刻清除，而是会保留一段时间（比如一天），在虚拟机保留期内你可以随时restore恢复。

开启办法是修改Nova配置文件`/etc/nova/nova.conf`,在`DEFAULT`配置组下设置`reclaim_instance_interval`值，该值表示删除虚拟机后保留的时间，单位为秒。

我们简单验证下:

我们首先创建了一个虚拟机，uuid为`c6fd7a92-bf51-4000-b9e1-18850090ab47`:

```
$ nova list | grep c6fd7a92-bf51-4000-b9e1-18850090ab47
| c6fd7a92-bf51-4000-b9e1-18850090ab47 | int32bit-test-3 | ACTIVE | -          | Running     | rally-shared-net=10.168.0.18 |
```

然后执行删除操作:

```
nova delete c6fd7a92-bf51-4000-b9e1-18850090ab47
```

查看虚拟机状态，注意`--deleted`选项，否则看不到已经删除的虚拟机:

```
$ nova list --deleted | grep c6fd7a92-bf51-4000-b9e1-18850090ab47
| c6fd7a92-bf51-4000-b9e1-18850090ab47 | int32bit-test-3| SOFT_DELETED | - |Shutdown| rally-shared-net=10.168.0.18|
```

可见虚拟机此时为`SOFT_DELETED`状态，此时我们可以使用`nova restore`操作恢复:

```bash
nova restore c6fd7a92-bf51-4000-b9e1-18850090ab47
```

再次使用`nova list`可发现虚拟机已经回来了。

软删除的代码实现也相对简单，直接上核心代码（`nova/compute/manager.py`:

```python
    def soft_delete_instance(self, context, instance, reservations):
        # ...
        try:
            self._notify_about_instance_usage(context, instance,
                                              "soft_delete.start")
            try:
                self.driver.soft_delete(instance)
            except NotImplementedError:
                self.driver.power_off(instance)
            instance.power_state = self._get_power_state(context, instance)
            instance.vm_state = vm_states.SOFT_DELETED
            instance.task_state = None
            instance.save(expected_task_state=[task_states.SOFT_DELETING])
        except Exception:
            with excutils.save_and_reraise_exception():
                quotas.rollback()
        quotas.commit()
```

从代码发现会调用driver的`soft_delete`方法，但实际上libvirt driver并未实现该方法，因此会fallback到except语句，即执行简单关机操作，然后更新虚拟机状态到数据库即完成软删除操作。

**因此，虚拟机的软删除操作原理就是关机虚拟机并标记为软删除。**

需要注意的是: **`nova force-delete`会立即强制删除虚拟机，不会保留虚拟机，请小心操作。**

## 4.禁止删除

这个应该算是Nova的隐藏功能了，不阅读源码真的不知道，虚拟机有一个`disable_terminate`标记，具有该标记的虚拟机无法通过任何API删除虚拟机，无论你是admin还是force-delete都会删除失败，对于非常重要的虚拟机，万万不能删除的虚拟机，可以设置该标记。

不过目前并没有API设置该标记，社区提了好几个与之相关的BP:

* [ability-to-set-disable-terminate](https://blueprints.launchpad.net/nova/+spec/ability-to-set-disable-terminate)；
* [support-disable-terminate-for-instance](https://blueprints.launchpad.net/nova/+spec/support-disable-terminate-for-instance)；
* [disable-terminate](https://blueprints.launchpad.net/nova/+spec/disable-terminate)。

目前只能靠操作数据库查看和设置该标记了。

```sql
update  instances set disable_terminate=1 where uuid='a80d78c0-9f5f-4f01-8ace-72a5133a4763';
```

此时执行删除虚拟机操作不会有任何反应。

实现方式非常简单，在`nova/compute.api.py`，只要设置了该标记，直接return:

```python
def _delete(self, context, instance, delete_type, cb, **instance_attrs):
        if instance.disable_terminate:
            LOG.info(_LI('instance termination disabled'),
                     instance=instance)
            return
        # ...
```

## 5. 快照备份

以上都是通过删除保护方式来保证虚拟机的安全性，为了更全面地保护虚拟机，快照备份也是保护虚拟机的有效途径，可参考的方式如下:

1. 使用`nova image-create`创建虚拟机快照。
2. 使用`nova backup`定期快照备份。
3. 如果使用Ceph做后端存储，可以考虑使用rbd mirror。
4. 挂载的volume可以使用cinder backup服务增量备份。

## 6.总结

虽然OpenStack提供的虚拟机保护措施还不够完善，但做的工作还是不少的，用户可以根据自己的需求选择适合自己的方案。
