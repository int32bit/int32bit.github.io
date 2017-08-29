---
layout: post
title: OpenStack Nova组件对象模型以及数据库访问机制
catalog: true
tags: [OpenStack]
---

## 1. 背景介绍

在OpenStack G版以前，Nova的所有服务（包括nova-compute服务）都是直接访问数据库的，数据库访问接口在nova/db/api.py模块中实现，而该模块只是调用了IMPL的方法，即该模块只是一个代理，真正实现由IMPL实现，IMPL是一个可配置的动态加载驱动模块，通常使用Python sqlalchemy库实现，对应的代码为`nova.db.sqlalchemy.api`：

```pythohn
_BACKEND_MAPPING = {'sqlalchemy': 'nova.db.sqlalchemy.api'}
```

该模块不仅实现了model的CRUD操作，还封装了一些高级API，比如:

* instance_get_all: 获取所有虚拟机实例。
* instance_update: 更新虚拟机熟悉。
* ...

这种直接访问数据库的设计至少存在以下两个问题：

* 所有服务与数据模型耦合，当数据模型变更时，可能需要涉及所有代码的调整，并难以支持版本控制。
* 所有的主机都能访问数据库，大大增加了数据库的暴露风险。

为了实现Nova服务与数据库访问解耦，从G版本开始引入了nova-conductor服务，该服务的一个重要作用就是访问数据库，其它服务访问数据库时需要向nova-conductor发起RPC请求，由nova-conductor代理请求数据库。

以上方式基本解决了服务与数据库访问解耦，并且防止其它服务直接访问数据库，但仍然没有解决对象模型的版本控制。从I版本开始引入了对象模型的概念，所有的对象模型定义在`nova/objects`。在此之前访问数据库是直接调用数据库的model的，比如更新一个flavor一个字段，调用Flavor的update方法（由sqlalchemy)实现。引入对象模型后，相当于在服务与数据库之间又添加了一级对象层，各个服务直接和资源对象交互，资源对象再和数据库接口交互，数据库返回时也会相应的转化为对象模型中的对象。

对象模型的对象不仅封装了数据库访问，还支持了版本控制。每个对象都会维护一个版本号，发起RPC请求时必须指定对象的版本号。新版本的对象通常能够兼容旧版本对象，比如nova-conductor升级了使用对象模型版本为1.2，但nova-compute服务可能还没有升级完成，仍然使用的是1.1版本，此时请求返回时会把conductor的返回的对象转化为1.1版本兼容的对象。

目前Cinder服务还是直接访问数据库，目前已经在社区有对应的BP关于增加cinder-conductor服务[Create conductor service for cinder like nova-conductor](https://blueprints.launchpad.net/cinder/+spec/no-db-volume), 该BP于2013年6月提出，到当前最新版本N还尚未实现。

## 2. Nova配置

以上我们介绍了nova-conductor以及对象模型的背景，我们了解到所有服务访问数据库都必须通过RPC调用nova-conductor服务请求，但这并不是强制的，如果不考虑数据库访问安全，你仍然可以使用本地访问方式，nova-compute服务可以直接访问数据库而不发起nova-conductor RPC调用。我们看nova-compute服务的初始化，它位于`nova/cmd/compute.y`：

```python
def main():
    # ...
    if not CONF.conductor.use_local:
        cmd_common.block_db_access('nova-compute')
        objects_base.NovaObject.indirection_api = \
            conductor_rpcapi.ConductorAPI()
    else:
        LOG.warning(_LW('Conductor local mode is deprecated and will '
                        'be removed in a subsequent release'))
    # ...
```

因此在`/etc/nova.conf`配置文件中可以配置是否直接访问数据库。以上`indirection_api`是Nova对象模型的一个字段，初始化为`None`。

如果设置use_local为true，则`indirection_api`为None，否则将初始化为`conductor_rpcapi.ConductorAPI`，从这里我们也可以看出调用conductor的入口。

我们可能会想到说在对象模型访问数据库时会有一堆if-else来判断是否使用use_local，事实上是否这样呢，我们接下来将分析源码，从而理解OpenStack的设计理念。

## 3. 源码分析

### 3.1 nova-compute源码分析

本小节主要以删除虚拟机为例，分析nova-compute在删除虚拟机时如何操作数据库的。删除虚拟机的API入口为`nova/compute/manager.py`的`_delete_instance`方法，方法原型为:

```
_delete_instance(self, context, instance, bdms, quotas)
```

该方法有4个参数，`context`是上下文信息，包含用户、租户等信息，`instance`就是我们上面提到的对象模型中`Instance`对象实例，`bdms`是`blockDeviceMappingList`对象实例，保存着block设备映射列表，quotas是`nova.objects.quotas.Quotas`对象实例，保存该租户的quota信息。

该方法涉及的数据库操作代码为:

```
instance.vm_state = vm_states.DELETED
instance.task_state = None
instance.power_state = power_state.NOSTATE
instance.terminated_at = timeutils.utcnow()
instance.save()
system_meta = instance.system_metadata
instance.destroy()
```

从代码中可以看到，首先更新instance的几个字段，然后调用save()方法保存到数据库中，最后调用destroy方法删除该实例(注意，这里的删除并不一定是真的从数据库中删除记录，也有可能仅仅做个删除的标识)。

我们先找到以上的save()方法，它位于`nova/object/instance.py`模块中，方法原型为:

```
@base.remotable
save(self, expected_vm_state=None,
     expected_task_state=None, admin_state_reset=False)
```

save方法会记录需要更新的字段，并调用db接口保存到数据库中。关键是该方法的wrapper remotable，这个注解(python不叫注解，不过为了习惯这里就叫注解吧)非常重要，该方法在[oslo](https://github.com/openstack/oslo.versionedobjects)中定义:

```python
def remotable(fn):
    """Decorator for remotable object methods."""
    @six.wraps(fn)
    def wrapper(self, *args, **kwargs):
        ctxt = self._context
        if ctxt is None:
            raise exception.OrphanedObjectError(method=fn.__name__,
                                                objtype=self.obj_name())
        if self.indirection_api:
            updates, result = self.indirection_api.object_action(
                ctxt, self, fn.__name__, args, kwargs)
            for key, value in six.iteritems(updates):
                if key in self.fields:
                    field = self.fields[key]
                    # NOTE(ndipanov): Since VersionedObjectSerializer will have
                    # deserialized any object fields into objects already,
                    # we do not try to deserialize them again here.
                    if isinstance(value, VersionedObject):
                        setattr(self, key, value)
                    else:
                        setattr(self, key,
                                field.from_primitive(self, key, value))
            self.obj_reset_changes()
            self._changed_fields = set(updates.get('obj_what_changed', []))
            return result
        else:
            return fn(self, *args, **kwargs)

    wrapper.remotable = True
    wrapper.original_fn = fn
    return wrapper
```

从代码看到，当`indirection_api`不为`None`时会调用`indirection_api`的`object_action`方法，由前面我们知道这个值由配置项`use_local`决定，当`use_local`为`False`时`indirection_api`为`conductor_rpcapi.ConductorAPI`。从这里了解到对象并不是通过一堆if-else来判断是否使用`use_local`的，而是通过`@remotable`注解实现的，remotable封装了if-else，当使用local时直接调用原来对象实例的save方法，否则调用`indirection_api`的`object_action`方法。

注意: 除了`@remotable`注解，还定义了`@remotable_classmethod`注解，该注解功能和`@remotable`类似，仅仅相当于又封装了个`@classmethod`注解。

### 3.2 RPC调用

前面我们分析到调用`conductor_rpcapi.ConductorAPI`的`object_action`方法，该方法在`nova/conductor/rpcapi.py`中定义：

```
def object_action(self, context, objinst, objmethod, args, kwargs):
        cctxt = self.client.prepare()
        return cctxt.call(context, 'object_action', objinst=objinst,
                          objmethod=objmethod, args=args, kwargs=kwargs)
```

`rpcapi.py`封装了client端的所有RPC调用方法，从代码上看，发起了RPC server端的`object_action`同步调用。此时nova-compute工作顺利转接到nova-conductor，并堵塞等待nova-conducor返回。

### 3.3 nova-conductor源码分析

nova-conductor RPC server端接收到RPC请求后调用`manager.py`的`object_action`方法(`nova/conductor/manager.py`):

```python

    def object_action(self, context, objinst, objmethod, args, kwargs):
        """Perform an action on an object."""
        oldobj = objinst.obj_clone()
        result = self._object_dispatch(objinst, objmethod, args, kwargs)
        updates = dict()
        # NOTE(danms): Diff the object with the one passed to us and
        # generate a list of changes to forward back
        for name, field in objinst.fields.items():
            if not objinst.obj_attr_is_set(name):
                # Avoid demand-loading anything
                continue
            if (not oldobj.obj_attr_is_set(name) or
                    getattr(oldobj, name) != getattr(objinst, name)):
                updates[name] = field.to_primitive(objinst, name,
                                                   getattr(objinst, name))
        # This is safe since a field named this would conflict with the
        # method anyway
        updates['obj_what_changed'] = objinst.obj_what_changed()
        return updates, result
```

该方法首先调用`obj_clone()`方法备份原来的对象，主要为了后续统计哪些字段更新了。然后调用了`_object_dispatch`方法:


```
def _object_dispatch(self, target, method, args, kwargs):
        try:
            return getattr(target, method)(*args, **kwargs)
        except Exception:
            raise messaging.ExpectedException()
```

该方法利用反射机制通过方法名调用，这里我们的方法名为`save`方法，因此显然调用了`target.save()`方法，即最终还是调用的`instance.save()`方法，不过此时已经是在conductor端调用了.

又回到了`nova/objects/instance.py`的`save`方法，有人会说难道这不会无限递归RPC调用吗？显然不会，这是因为nova-conductor的`indirection_api`为`None`，在`@remotable`中肯定走`else`分支。

## 4. 思考一个问题

还记得在`_delete_instance`方法的数据库调用代码吗？这里再贴下代码:

```python
instance.vm_state = vm_states.DELETED
instance.task_state = None
instance.power_state = power_state.NOSTATE
instance.terminated_at = timeutils.utcnow()
instance.save()
system_meta = instance.system_metadata
instance.destroy()
```

有人会说instance记录都要删了，直接调用destory方法不得了，前面一堆更新字段然后save方法是干什么的。这是因为Nova在处理删除记录时使用的是软删除策略，即不会真正得把记录彻底删除，而是在记录中有个`deleted`字段标记是否已经被删除。这样的好处是方便以后审计甚至数据恢复。

## 5. 总结

本文首先介绍了OpenStack Nova组件数据库访问的发展历程，然后基于源码分析了当前Nova访问数据库的过程，最后解释了Nova使用软删除的原因。
