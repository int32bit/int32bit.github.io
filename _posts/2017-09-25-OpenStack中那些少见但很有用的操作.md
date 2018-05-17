---
layout: post
title: OpenStack中那些很少见但很有用的操作
catalog: false
tag: [OpenStack]
---

从2013年开始折腾OpenStack也有好几年的时间了，在使用过程中，我发现很多很有用的功能，但是却很少被提及，比如Cinder volume过户、Glance镜像分享、纳管外部volume、挂载volume到宿主机等等。

本文将列举几个本人使用过的认为很有用的OpenStack操作，也欢迎读者补充更多关于被忽视却很有用的OpenStack操作。

## Glance

### member

镜像是OpenStack中非常重要的数据，保存了用户的操作系统数据，因此保证镜像的安全性非常重要。通常上传到Glance的镜像可见性(visibility)可以设置为`public`和`private`，`public`的镜像表示对所有的租户可见，而`private`镜像只有租户自己以及管理员可见。在新版本的Glance中，引入了一种新的可见性状态--`shared`，该状态的镜像允许设置共享给指定的一个或者多个租户。共享的租户我们称为`member`，我们只需要把租户加到镜像的`member`中就可以访问其它租户的镜像了。

在测试环境下实验下，首先我们在`admin`租户下创建一个镜像如下:

```
glance image-create --disk-format raw --container-format bare --name cirror-3.0 --file cirros-3.0.img
```

在demo租户下该镜像不可见:

```
$ source  openrc_demo
$ glance image-list
+----+------+
| ID | Name |
+----+------+
+----+------+
```

我们把`demo`租户加到镜像`member`中:

```sh
$ glance member-create ec5426f5-ab4d-43a6-a1e1-5a1919aa7bea fb498fdd27e74750a6b209158437696c
+--------------------------------------+----------------------------------+---------+
| Image ID                             | Member ID                        | Status  |
+--------------------------------------+----------------------------------+---------+
| ec5426f5-ab4d-43a6-a1e1-5a1919aa7bea | fb498fdd27e74750a6b209158437696c | pending |
+--------------------------------------+----------------------------------+---------+
```

`admin`这边把`demo`加入到`member`中，还需要`demo`这边确认，把`member`状态更新为`accepted`，表示接收共享的镜像:

```
$ glance member-update ec5426f5-ab4d-43a6-a1e1-5a1919aa7bea fb498fdd27e74750a6b209158437696c accepted
+--------------------------------------+----------------------------------+----------+
| Image ID                             | Member ID                        | Status   |
+--------------------------------------+----------------------------------+----------+
| ec5426f5-ab4d-43a6-a1e1-5a1919aa7bea | fb498fdd27e74750a6b209158437696c | accepted |
+--------------------------------------+----------------------------------+----------+
```

此时在demo租户下可以看到共享的镜像了:

```
$ glance image-list
+--------------------------------------+------------+
| ID                                   | Name       |
+--------------------------------------+------------+
| ec5426f5-ab4d-43a6-a1e1-5a1919aa7bea | cirror-3.0 |
+--------------------------------------+------------+
```

### task

通常我们通过`glance image-create`上传镜像，这至少存在以下两个问题：

1. 镜像没有校验，你可以随便上传一个图片啥的，或者上传一个恶意文件，你甚至可以把Glance当作对象存储使用。
2. 镜像通常很大，上传占资源多并且慢，上传大镜像经常会由于上传超时而导致失败。

因此Glance从V2版本开始提出了`task`的概念，`task`可以定义上传镜像的任务流程，Glance会异步去执行并反馈结果，关于Glance `task`介绍可以参考[Get started with tasks api in glance](https://geetikabatra.wordpress.com/2015/06/15/getting-started-with-tasks-api-in-glance/).

首先定义`task`，json文件如下:

```json
{
    "input": {
        "image_properties": {
            "container_format": "bare",
            "disk_format": "raw",
            "name": "cirros-0.3.5-x86_64"
        },
        "import_from": "http://download.cirros-cloud.net/0.3.5/cirros-0.3.5-x86_64-disk.img",
        "import_from_format": "raw"
    },
    "type": "import"
}
```

创建`task`:

```sh
$ glance task-create --type import --input "$(cat import_image.json | jq '.input')"
+------------+----------------------------------------------------------------------------------+
| Property   | Value                                                                            |
+------------+----------------------------------------------------------------------------------+
| created_at | 2017-09-28T08:03:47Z                                                             |
| id         | 564b5ee4-56db-4360-bb71-d1d1c4d896a2                                             |
| input      | {"image_properties": {"container_format": "bare", "name":                        |
|            | "cirros-0.3.5-x86_64"}, "import_from_format": "raw", "import_from":              |
|            | "http://download.cirros-cloud.net/0.3.5/cirros-0.3.5-x86_64-disk.img"}           |
| message    |                                                                                  |
| owner      | ae21d957967d4df0865411f0389ed7e8                                                 |
| result     | None                                                                             |
| status     | pending                                                                          |
| type       | import                                                                           |
| updated_at | 2017-09-28T08:03:47Z                                                             |
+------------+----------------------------------------------------------------------------------+
```

查看`task`:

```sh
$ glance task-list
+--------------------------------------+--------+------------+----------------------------------+
| ID                                   | Type   | Status     | Owner                            |
+--------------------------------------+--------+------------+----------------------------------+
| 564b5ee4-56db-4360-bb71-d1d1c4d896a2 | import | processing | ae21d957967d4df0865411f0389ed7e8 |
+--------------------------------------+--------+------------+----------------------------------+
```

此时Glance会异步从指定的URL中下载镜像，完成后状态变成`success`：

```
$ glance task-show 564b5ee4-56db-4360-bb71-d1d1c4d896a2
+------------+----------------------------------------------------------------------------------+
| Property   | Value                                                                            |
+------------+----------------------------------------------------------------------------------+
| created_at | 2017-09-28T09:32:10Z                                                             |
| expires_at | 2017-09-30T09:33:54Z                                                             |
| id         | 564b5ee4-56db-4360-bb71-d1d1c4d896a2                                             |
| input      | {"image_properties": {"container_format": "bare", "disk_format": "raw", "name":  |
|            | "cirros-0.3.5-x86_64"}, "import_from_format": "raw", "import_from":              |
|            | "http://download.cirros-cloud.net/0.3.5/cirros-0.3.5-x86_64-disk.img"}           |
| message    |                                                                                  |
| owner      | ae21d957967d4df0865411f0389ed7e8                                                 |
| result     | {"image_id": "e5f8a941-f14f-4065-b381-b537271eba4c"}                             |
| status     | success                                                                          |
| type       | import                                                                           |
| updated_at | 2017-09-28T09:33:54Z                                                             |
+------------+----------------------------------------------------------------------------------+
```

`result`中保存了image的`id`。

该设计初衷是好的，不过从Mitaka版本开始，`task` API废弃了，社区准备重构`import image`流程，参考[image import refactor](https://specs.openstack.org/openstack/glance-specs/specs/mitaka/approved/image-import/image-import-refactor.html)。

## Nova

### lock

这个功能比较好理解，就是对虚拟机进行锁定，被锁定的虚拟机除了管理员的其他任何用户不能对虚拟机执行任何变更操作。管理员通过该操作可以保证虚拟机的安全性，有效阻止普通用户对虚拟机执行非计划的删除、关机重启等高危操作。

**但是需要注意的是，`lock`只作用于普通用户，管理员是无视`lock`的。**

我们创建一台虚拟机：

```sh
nova boot --image f0b1239a-bb34-4cfb-ad06-e18cbb8ee4b9 --flavor m1.small --nic net-id=9f3aad86-f3c1-499b-ba62-5708dd229466 int32bit-test-lock
```

使用管理员账号对虚拟机进行`lock`操作:

```sh
nova lock d7873036-15b0-4a06-9507-999dbf097c62
```

我们使用普通用户对虚拟机分别执行重启、删除操作::

```sh
$ source openrc_demo
$ nova reboot d7873036-15b0-4a06-9507-999dbf097c62
Instance d7873036-15b0-4a06-9507-999dbf097c62 is locked (HTTP 409) (Request-ID: req-60271d7d-9afd-4ff4-a150-dfb632d5007f)
ERROR (CommandError): Unable to reboot the specified server(s).
$ nova delete d7873036-15b0-4a06-9507-999dbf097c62
Instance d7873036-15b0-4a06-9507-999dbf097c62 is locked (HTTP 409) (Request-ID: req-3e63515b-6e2e-419a-8c91-b27b1a546f12)
ERROR (CommandError): Unable to delete the specified server(s).
```

从以上输出可见这两个操作都失败了，符合我们的预期。

另外需要强调的是，其实普通用户也是可以对虚拟机执行`lock`操作的，不过普通用户加的`lock`，其他任意用户都可以执行`unlock`。而默认policy下，只有管理员添加的`lock`，才能阻止普通用户执行`unlock`:

```sh
$ nova unlock d7873036-15b0-4a06-9507-999dbf097c62
ERROR (Forbidden): Policy doesn't allow os_compute_api:os-lock-server:unlock:unlock_override to be performed. (HTTP 403) (Request-ID: req-9fabda60-4857-429e-ab1d-6ca6fb36844e)
```

### shelve

对于一些长期不用的虚拟机，即使关机了，仍然占用着集群资源，或者在公有云上用户欠费时间很长，又没有及时主动删掉虚拟机，导致一直占据着资源。此时我们可以通过`shelve`（搁置）操作临时释放资源。

`shelve`操作的原理分为两种情况：

* 如果虚拟机是从Glance image创建的(boot from image)，则先给虚拟机创建一个快照并上传到glance中，然后把虚拟机从OpenStack中删掉，释放所有资源。
* 如果虚拟机是从Cinder volume中创建的(boot from volume)，则直接删除虚拟机，但不会从Cinder中删除根磁盘。
我们假定虚拟机是从Glance镜像中创建的，通过`shelve`子命令对虚拟机执行搁置操作：

```sh
nova shelve 5b540e93-e931-45ed-a7f3-1dc2e88d8d33
```

`shelve`完成后我们查看虚拟机是否彻底从libvirt底层删除:

```
$ nova list --fields id,name,status,instance_name
+--------------------------------------+--------------------------------------+----------------------+-------------------+-------------------+
| ID                                   | Id                                   | Name                 | Status            | Instance Name     |
+--------------------------------------+--------------------------------------+----------------------+-------------------+-------------------+
| 5b540e93-e931-45ed-a7f3-1dc2e88d8d33 | 5b540e93-e931-45ed-a7f3-1dc2e88d8d33 | int32ibt-test-shelve | SHELVED_OFFLOADED | instance-0000033b |
+--------------------------------------+--------------------------------------+----------------------+-------------------+-------------------+
$ virsh list --all | grep instance-0000033b
```

可以发现`instance-0000033b`已经删除了。

使用Glance可以查看`shelve`操作创建的新快照:

```sh
$ glance image-list | grep shelved
| 36d7d6a0-aa18-4373-ad79-afcae8609489 | int32ibt-test-shelve-shelved              |
```

删除的虚拟机可以通过`unshelve`操作恢复虚拟机，该操作基于快照重新启动（`rebuild`）虚拟机，并把快照从Glance中删掉。

```sh
$ nova unshelve 5b540e93-e931-45ed-a7f3-1dc2e88d8d33
$ nova list
+--------------------------------------+----------------------+--------+------------+-------------+---------------------+
| ID                                   | Name                 | Status | Task State | Power State | Networks            |
+--------------------------------------+----------------------+--------+------------+-------------+---------------------+
| 5b540e93-e931-45ed-a7f3-1dc2e88d8d33 | int32ibt-test-shelve | ACTIVE | -          | Running     | test-net=10.0.51.22 |
+--------------------------------------+----------------------+--------+------------+-------------+---------------------+
```

### rescue

我们经常在文件系统奔溃时，进入rescue模式修复，或者通过Live CD进入一个临时操作系统来修复奔溃的文件系统。

假如我们使用OpenStack启动的虚拟机出现问题导致启动不起来了，该怎么处理呢。

当然你可以把虚拟机的根磁盘挂载到本地(如果使用的是Ceph，则直接通过`rbd map`)，然后在宿主机中修复。但是作为云提供商，显然是不可能这么做，否则用户的数据太不安全了。我们需要用户自己去修复。

Nova提供了`rescue` API，其实现原理和我们前面提到的方式基本一样，先来看看`rescue`子命令用法:

```
nova rescue [--password <password>] [--image <image>] <server>
```

`rescue`会使用指定的image重新创建(`rebuild`)一个虚拟机，同时把原来的虚拟机根磁盘作为附加磁盘挂载到新创建的虚拟机，它会重用原来虚拟机的所有信息，如flavor、network等。

题外话：通过rescue新创建的虚拟机不支持指定keypair。另外其实rebuild也不支持指定keypair，在前几天的邮件列表中看到有讨论这个问题，估计在Q版本中会实现。

接下来我们实验下`rescue`功能：

```sh
$ nova rescue  --image f0b1239a-bb34-4cfb-ad06-e18cbb8ee4b9 5b540e93-e931-45ed-a7f3-1dc2e88d8d33
+-----------+--------------+
| Property  | Value        |
+-----------+--------------+
| adminPass | 4mDD7BGsfvMN |
+-----------+--------------+
$ nova list
+--------------------------------------+------+--------+------------+-------------+---------------------+
| ID                                   | Name | Status | Task State | Power State | Networks            |
+--------------------------------------+------+--------+------------+-------------+---------------------+
| 5b540e93-e931-45ed-a7f3-1dc2e88d8d33 | 2    | ACTIVE | rescuing   | Running     | test-net=10.0.51.22 |
+--------------------------------------+------+--------+------------+-------------+---------------------+
```

当虚拟机`rebuild`完成后，查看其状态:

```sh
$ nova list
+--------------------------------------+------+--------+------------+-------------+---------------------+
| ID                                   | Name | Status | Task State | Power State | Networks            |
+--------------------------------------+------+--------+------------+-------------+---------------------+
| 5b540e93-e931-45ed-a7f3-1dc2e88d8d33 | 2    | RESCUE | -          | Running     | test-net=10.0.51.22 |
+--------------------------------------+------+--------+------------+-------------+---------------------+
```

虚拟机状态变为`RESCUE`。

我们通过查看挂载的block设备：

```sh
$ virsh domblklist 5b540e93-e931-45ed-a7f3-1dc2e88d8d33
Target     Source
------------------------------------------------
vda        /var/lib/nova/instances/5b540e93-e931-45ed-a7f3-1dc2e88d8d33/disk.rescue
vdb        /var/lib/nova/instances/5b540e93-e931-45ed-a7f3-1dc2e88d8d33/disk
```

其中`disk.rescue`是新创建虚拟机的临时根磁盘，`disk`是原来虚拟机的根磁盘。此时进入新创建的虚拟机，就可以对原来虚拟机的根磁盘进行修复操作了。

操作完成后，可以通过`unrescue`子命令恢复：

```sh
nova unrescue 5b540e93-e931-45ed-a7f3-1dc2e88d8d33
```

`unrescue`会再次`rebuild`虚拟机，并重新使用之前的根磁盘作为根磁盘，删除前面创建的临时根磁盘。

## Cinder

### manage

Cinder创建一个volume时会调用后端存储系统创建一个数据卷，并与Cinder volume一一对应。

如果我们存储系统中已经有一些数据卷了，比如Ceph中已有的一些rbd image或者本地文件系统已经存在的LV，如何让Cinder纳管起来呢？可幸的是，Cinder支持导入OpenStack外部存储数据卷，这个操作称为`manage`。接下来我们演示下这个过程。

假设我们使用的是LVM后端driver，首先我们创建一个LV:

```
$ lvcreate --name int32bit-test-LV --size 1G cinder-volumes
  Logical volume "int32bit-test-LV" created.
$ lvs | grep int32bit
int32bit-test-LV                               cinder-volumes -wi-a-----  1.00g
```

使用`manage`子命令纳管刚刚创建的LV:

```
$ cinder manage --name int32bit-test-manage 'devstack@lvm#cinder-volumes' int32bit-test-LV
+--------------------------------+--------------------------------------+
|            Property            |                Value                 |
+--------------------------------+--------------------------------------+
|          attachments           |                  []                  |
|       availability_zone        |                 nova                 |
|            bootable            |                false                 |
|      consistencygroup_id       |                 None                 |
|           created_at           |      2017-09-28T03:09:55.000000      |
|          description           |                 None                 |
|           encrypted            |                False                 |
|               id               | 9394b827-4ad0-488e-8df8-26476b3a8662 |
|            metadata            |                  {}                  |
|        migration_status        |                 None                 |
|          multiattach           |                False                 |
|              name              |      int32bit-test-manage            |
|     os-vol-host-attr:host      |     devstack@lvm#cinder-volumes      |
| os-vol-mig-status-attr:migstat |                 None                 |
| os-vol-mig-status-attr:name_id |                 None                 |
|  os-vol-tenant-attr:tenant_id  |   42ee53fa480f49149ce5c3df4a953a6b   |
|       replication_status       |                 None                 |
|              size              |                  0                   |
|          snapshot_id           |                 None                 |
|          source_volid          |                 None                 |
|             status             |               creating               |
|           updated_at           |                 None                 |
|            user_id             |   a61a3c0659bd4cca8cb5f66ea2fe3df7   |
|          volume_type           |                 None                 |
+--------------------------------+--------------------------------------+
```

以上两个参数，其中第一个参数是`host`，Cinder的`host`格式为`hostname@backend#pool`，如果不清楚，使用admin账号show其中一个volume，查看其`os-vol-host-attr:host`属性。另一个参数为`identifier`，即后端存储数据卷名，对应LVM即LV name，对应Ceph rbd则为image name。

当volume状态变为`available`时，说明volume创建成功，并纳管了指定的LV。

我们使用`lvs`查看我们创建的LV是否还存在:

```sh
$ lvs | grep int32bit
```

我们发现创建的int32bit-test-LV不存在了，这是怎么回事呢？查看实现源码如下:

```python
def manage_existing(self, volume, existing_ref):
   lv_name = existing_ref['source-name']
   self.vg.get_volume(lv_name)

   if volutils.check_already_managed_volume(self.db, lv_name):
       raise exception.ManageExistingAlreadyManaged(volume_ref=lv_name)

   # Attempt to rename the LV to match the OpenStack internal name.
   try:
       self.vg.rename_volume(lv_name, volume['name'])
   except processutils.ProcessExecutionError as exc:
       exception_message = (_("Failed to rename logical volume %(name)s, "
                              "error message was: %(err_msg)s")
                            % {'name': lv_name,
                               'err_msg': exc.stderr})
       raise exception.VolumeBackendAPIException(
           data=exception_message)
```

从源码中发现，Cinder会自动把LV重命名，与Cinder volume对应起来。由此可见`manage`和`create`其实很类似，唯一不同的是:

* `create`会调用后端driver创建一个volume。
* `manage`则会调用后端driver重命名一个volume。

当然，也有一个相反的操作，即`unmanage`，这个和`delete`操作基本一样，唯一不同的是，`delete`会调用后端存储把数据卷从底层彻底删除，而`unmanage`只是删除volume数据库记录，并不会删除后端存储的数据卷。

不过Cinder目前还不支持从本地文件系统中导入volume以及把volume导出到本地文件系统中，其实当初manage功能就是为了实现前面的`import/export` volume blue print，参考[add export import volume](https://blueprints.launchpad.net/cinder/+spec/add-export-import-volumes).

### local-attach

Cinder作为OpenStack的块存储服务，最典型的应用是挂载到OpenStack虚拟机中，当作虚拟硬盘使用。但volume能不能挂载到物理机呢，或者说挂载到宿主机呢？答案是可以！我们把volume挂载到本地，称为`local attach`。

不过默认的cinderclient没有`local attach`命令，我们需要安装`cinderclient`扩展包:

```sh
pip install python-brick-cinderclient-ext
```

安装完后，可以发现cinder CLI多了两个子命令:

```sh
$ cinder --help | grep local
local-attach
local-detach
```

下面演示如何把一个volume挂载到本地：

首先创建一个volume:

```
$ cinder create --volume-type lvm --name int32bit-test-local-attach 1
+--------------------------------+--------------------------------------+
| Property                       | Value                                |
+--------------------------------+--------------------------------------+
| attached_servers               | []                                   |
| attachment_ids                 | []                                   |
| availability_zone              | nova                                 |
| bootable                       | false                                |
| consistencygroup_id            | None                                 |
| created_at                     | 2017-09-28T02:50:16.000000           |
| description                    | None                                 |
| encrypted                      | False                                |
| id                             | af767c74-1902-4a7a-8fff-4ea68695a3f8 |
| metadata                       | {}                                   |
| migration_status               | None                                 |
| multiattach                    | False                                |
| name                           | int32bit-test-local-attach           |
| os-vol-host-attr:host          | None                                 |
| os-vol-mig-status-attr:migstat | None                                 |
| os-vol-mig-status-attr:name_id | None                                 |
| os-vol-tenant-attr:tenant_id   | ae21d957967d4df0865411f0389ed7e8     |
| replication_status             | None                                 |
| size                           | 1                                    |
| snapshot_id                    | None                                 |
| source_volid                   | None                                 |
| status                         | creating                             |
| updated_at                     | None                                 |
| user_id                        | 70828c56f2844a9090d286c29a1fb599     |
| volume_type                    | lvm                                  |
+--------------------------------+--------------------------------------+
```

等待volume状态变为`available`后，我们使用`local-attach`子命令挂载到本地:

```
$ cinder local-attach af767c74-1902-4a7a-8fff-4ea68695a3f8
+----------+-----------------------------------+
| Property | Value                             |
+----------+-----------------------------------+
| path     | /dev/sdb                          |
| scsi_wwn | 360000000000000000e00000000010001 |
| type     | block                             |
+----------+-----------------------------------+
```

以上输出说明成功挂载volume到本地中，并映射为`/dev/sdb`。

我们安装文件系统并`mount`到本地:

```
$ mkfs.ext4 /dev/sdb
mke2fs 1.42.13 (17-May-2015)
Creating filesystem with 262144 4k blocks and 65536 inodes
Filesystem UUID: 2a3fdcac-3a68-494a-830d-2bbebddaa875
Superblock backups stored on blocks:
        32768, 98304, 163840, 229376

Allocating group tables: done
Writing inode tables: done
Creating journal (8192 blocks): done
Writing superblocks and filesystem accounting information: done

$ mount /dev/sdb /mnt
$ ls /mnt
lost+found
```

此时我们可以把volume当作本地的一个硬盘使用了。可以使用`local-detach`子命令从本地中卸载volume。

### transfer

我们知道Glance支持通过member把一个镜像分享给其它租户，自然想到的是，Cinder能不能把其中一个volume分享给其它租户呢？很遗憾，Cinder没有member的概念，即不支持通过member把一个volume共享给其它租户,这是因为volume通常是互斥挂载的，不能同时共享挂载到多个虚拟机。

不过Cinder有个类似的功能，称为过户。该功能支持把一个volume的所有权转移给另一个租户，这种操作称为`transfer`。

首先我们在`admin`租户下创建一个volume:

```sh
cinder create --name int32bit-test-transfer 1
```

此时我们在`demo`的租户下看不到刚刚创建的volume:

```
$ source  openrc_demo
$ cinder list
+----+--------+------+------+-------------+----------+-------------+
| ID | Status | Name | Size | Volume Type | Bootable | Attached to |
+----+--------+------+------+-------------+----------+-------------+
+----+--------+------+------+-------------+----------+-------------+
```

在`admin`租户下创建一个`transfer`：

```
$ cinder transfer-create --name test-transfer int32bit-test-transfer
+------------+--------------------------------------+
| Property   | Value                                |
+------------+--------------------------------------+
| auth_key   | c259b651426121fd                     |
| created_at | 2017-09-28T05:25:20.105051           |
| id         | b03c0b07-1e1c-4df3-b096-be3c66b433f7 |
| name       | test-transfer                        |
| volume_id  | 093f41b1-39f9-4a01-bfb8-116baf1dbe2f |
+------------+--------------------------------------+
```

此时volume的状态变为`awaiting-transfer`。

以上输出的`auth_key`非常重要，并且只有创建的时候会输出，之后通过API就拿不到这个`auth_key`了。这是交易凭证，双方通过这个`auth_key`完成过户转移。

在`demo`租户下`accept`过户请求:

```
$ cinder transfer-accept b03c0b07-1e1c-4df3-b096-be3c66b433f7 c259b651426121fd
+-----------+--------------------------------------+
| Property  | Value                                |
+-----------+--------------------------------------+
| id        | b03c0b07-1e1c-4df3-b096-be3c66b433f7 |
| name      | test-transfer                        |
| volume_id | 093f41b1-39f9-4a01-bfb8-116baf1dbe2f |
+-----------+--------------------------------------+
```

其中第一个参数为`transfer id`，第二个参数就是前面提到的`auth_key`。

我们在`demo`上查看volume:

```
$ cinder list
+--------------------------------------+-----------+------------------------+------+-------------+----------+-------------+
| ID                                   | Status    | Name                   | Size | Volume Type | Bootable | Attached to |
+--------------------------------------+-----------+------------------------+------+-------------+----------+-------------+
| 093f41b1-39f9-4a01-bfb8-116baf1dbe2f | available | int32bit-test-transfer | 1    | lvmdriver-1 | false    |             |
+--------------------------------------+-----------+------------------------+------+-------------+----------+-------------+
```

可见该volume已经成功转接给`demo`租户。

需要注意的是，任何人拿到`transfer_id`和`auth_key`都可以接收转接的volume，因此注意`auth_key`保密。`auth_key`只能使用一次，完成交接后，对应的`transfer`实例将自动删除。

### backup-export

Cinder backup可以把Cinder volume备份到远端的存储系统中，如Ceph、Swift等。但是backup的元数据怎么办呢，万一数据库记录丢失了，数据还是恢复不了。

有人可能会说，备份的时候不是会保存backup的元数据吗，为什么不用backup的元数据呢。这是因为并不是所有的备份都会在远端保存元数据，比如若cinder-volume和备份存储后端都是使用Ceph driver，则备份时直接使用RBD的`import`，不需要元数据，因此在备份的ceph中也不会保存元数据。

幸运的是，Cinder支持`backup export`，把metadata导出。

```sh
$ cinder --debug backup-export fcbbfcca-b83e-4fab-acb6-7dbbd017b151
{
    "backup-record": {
        "backup_service": "cinder.backup.drivers.swift",
        "backup_url": "eyJzdGF0dXM...efQ=="
    }
}
```

以上`eyJzdGF0dXM...efQ==`字符串很长，为了便于排版，省略了中间一大部分。输出的`backup_url`是一串字符串什么用途呢，我们查看源码:

```python
def export_record(self, context, backup):
# ...
# Call driver to create backup description string
try:
   backup_service = self.service.get_backup_driver(context)
   driver_info = backup_service.export_record(backup)
   backup_url = backup.encode_record(driver_info=driver_info)
   backup_record['backup_url'] = backup_url
except Exception as err:
   msg = six.text_type(err)
   raise exception.InvalidBackup(reason=msg)
```

我们从源码中发现`export_record`就是通过`backup`实例调用`encode_record`完成的，`encode_record`的作用很明显就是序列化过程，我们查看其源码:

```python
@base.remotable
def encode_record(self, **kwargs):
    """Serialize backup object, with optional extra info, into a string."""
    # We don't want to export extra fields and we want to force lazy
    # loading, so we can't use dict(self) or self.obj_to_primitive
    record = {name: field.to_primitive(self, name, getattr(self, name))
              for name, field in self.fields.items()}
    # We must update kwargs instead of record to ensure we don't overwrite
    # "real" data from the backup
    kwargs.update(record)
    retval = jsonutils.dump_as_bytes(kwargs)
    return base64.encode_as_text(retval)
```

从源码中可以看出，首先把backup序列化为json格式，然后转化为`base64`，我可以验证下:

```python
$ python
Python 2.7.5 (default, Nov  6 2016, 00:28:07)
[GCC 4.8.5 20150623 (Red Hat 4.8.5-11)] on linux2
Type "help", "copyright", "credits" or "license" for more information.
>>> import base64
>>> base64.b64decode('eyJzdGF0dXM...fQ==')
'{"status": "available", "temp_snapshot_id": null, "display_name": "2", "availability_zone": "nova", "deleted": false, "volume_id": "676ec7a5-d4ae-43d9-88cd-bd93dc143538", "restore_volume_id": null, "updated_at": "2017-08-30T05:56:47Z", "host": "devstack", "snapshot_id": null, "user_id": "a61a3c0659bd4cca8cb5f66ea2fe3df7", "service_metadata": "volume_676ec7a5-d4ae-43d9-88cd-bd93dc143538/20170830055626/az_nova_backup_fcbbfcca-b83e-4fab-acb6-7dbbd017b151", "id": "fcbbfcca-b83e-4fab-acb6-7dbbd017b151", "size": 1, "object_count": 22, "deleted_at": null, "container": "cinder-backup", "service": "cinder.backup.drivers.swift", "driver_info": {}, "created_at": "2017-08-30T05:56:23Z", "disk_size": 3444122, "display_description": "", "data_timestamp": "2017-08-30T05:56:23Z", "parent_id": null, "num_dependent_backups": 0, "fail_reason": null, "project_id": "42ee53fa480f49149ce5c3df4a953a6b", "temp_volume_id": null}'
```

下面我们从数据库中删除该`backup`记录:

```sql
MariaDB [cinder]> delete from backups where id='fcbbfcca-b83e-4fab-acb6-7dbbd017b151';
Query OK, 1 row affected (0.00 sec)
```

此时Cinder已经找不到该`backup`记录了:

```sh
$ cinder backup-show fcbbfcca-b83e-4fab-acb6-7dbbd017b151
ERROR: No volumebackup with a name or ID of 'fcbbfcca-b83e-4fab-acb6-7dbbd017b151' exists.
```

接下来我们使用`backup-import`恢复记录:

```
$ cinder backup-import cinder.backup.drivers.swift eyJzdGF0dXM...efQ==
+------------+--------------------------------------+
|  Property  |                Value                 |
+------------+--------------------------------------+
|     id     | fcbbfcca-b83e-4fab-acb6-7dbbd017b151 |
|    name    |                 None                 |
| parent_id  |                 None                 |
| project_id |   42ee53fa480f49149ce5c3df4a953a6b   |
+------------+--------------------------------------+
```

backup记录成功恢复：

```sh
$ cinder backup-show fcbbfcca-b83e-4fab-acb6-7dbbd017b151
+-----------------------+--------------------------------------+
|        Property       |                Value                 |
+-----------------------+--------------------------------------+
|   availability_zone   |                 nova                 |
|       container       |            cinder-backup             |
|       created_at      |      2017-08-30T05:56:23.000000      |
|     data_timestamp    |      2017-08-30T05:56:23.000000      |
|      description      |                                      |
|       disk_size       |               3444122                |
|      fail_reason      |                                      |
| has_dependent_backups |                False                 |
|           id          | fcbbfcca-b83e-4fab-acb6-7dbbd017b151 |
|     is_incremental    |                False                 |
|          name         |                  2                   |
|      object_count     |                  22                  |
|       parent_id       |                 None                 |
|       project_id      |   42ee53fa480f49149ce5c3df4a953a6b   |
|          size         |                  1                   |
|      snapshot_id      |                 None                 |
|         status        |              available               |
|       updated_at      |      2017-08-30T05:56:47.000000      |
|       volume_id       | 676ec7a5-d4ae-43d9-88cd-bd93dc143538 |
+-----------------------+--------------------------------------+
```

## 总结

以上我们介绍了OpenStack的一些非常有用的操作，主要内容包括如下:

* glance member
* glance task
* nova lock
* nova shelve
* nova rescue
* cinder manage
* cinder local-attach
* cinder backup-export
* cinder transfer

欢迎读者在评论区补充更多有用的OpenStack操作。
