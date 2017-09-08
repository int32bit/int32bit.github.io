---
layout: post
title: OpenStack虚拟机挂载数据卷过程分析
catalog: true
tags: [OpenStack]
---

## 1 关于OpenStack

OpenStack是一个IaaS开源项目，实现公有云和私有云的部署及管理，目前已经成为了最流行的一种开源云解决方案。其中提供计算服务组件Nova、网络服务组件Neutron以及块存储服务组件Cinder是OpenStack的最为核心的组件。这里我们重点关注Nova和Cinder组件，Neutron组件将在下一篇文章中详细介绍。

### 1.1 计算服务Nova

Nova组件为OpenStack提供计算服务(Compute as Service)，类似AWS的EC2服务。Nova管理的主要对象为云主机（server)，用户可通过Nova API申请云主机(server)资源。云主机通常对应一个虚拟机，但不是绝对，也有可能是一个容器(docker driver)或者裸机(对接ironic driver)。

Nova创建一台云主机的三个必要参数为:

* image: 即云主机启动时的镜像，这个镜像source可能是从Glance中下载，也有可能是Cinder中的一个volume卷(boot from volume)。
* flavor: flavor包含申请的资源数量，比如CPU核数、内存大小以及根磁盘大小、swap大小等。除了资源数量，flavor还包含一些特性配置，称为`extra specs`，可以实现设置io限速、cpu拓扑等功能。
* network: 云主机的租户网络。

创建一台云主机的CLI为:

```sh
nova boot --image ${IMAGE_ID} --flavor m1.small --nic net-id=${NETWORK_ID} int32bit-test-1
```

使用`nova list`可以查看租户的所有云主机列表。

### 1.2 块存储服务Cinder

Cinder组件为OpenStack提供块存储服务(Block Storage as Service)，类似AWS的EBS服务。Cinder管理的主要对象为数据卷(volume)，用户通过Cinder API可以对volume执行创建、删除、扩容、快照、备份等操作。

创建一个volume有两个必要参数:

* volume_type: volume_type关联了后端存储信息，比如存储后端、QoS信息等。
* size: 创建volume的大小。

创建一个20G的volume：

```sh
cinder create --volume-type ssd --name int32bit-test-volume 20
```

Cinder目前最典型的应用场景就是为Nova云主机提供云硬盘功能，用户可以把一个volume卷挂载到Nova的云主机中，当作云主机的一个虚拟块设备使用。

挂载volume是在Nova端完成的:

```sh
nova volume-attach ${server_id} ${volume_id}
```

Cinder除了能够为Nova云主机提供云硬盘功能，还能为裸机、容器等提供数据卷功能。[john griffith](https://j-griffith.github.io/)写了一篇博客介绍如何使用Cinder为Docker提供volume功能：[Cinder providing block storage for more than just Nova](https://j-griffith.github.io/articles/2016-09/cinder-providing-block-storage-for-more-than-just-nova)。

本文接下来将重点介绍OpenStack如何将volume挂载到虚拟机中，分析Nova和Cinder之间的交互过程。

## 2 存储基础

### 2.1 什么是iSCSI

iSCSI是一种通过TCP/IP共享块设备的协议，通过该协议，一台服务器能够把本地的块设备共享给其它服务器。换句话说，这种协议实现了通过internet向设备发送SCSI指令。

iSCSI server端称为`Target`，client端称为`Initiator`，一台服务器可以同时运行多个Target，一个Target可以认为是一个物理存储池，它可以包含多个`backstores`，backstore就是实际要共享出去的设备，实际应用主要有两种类型：

* block。即一个块设备，可以是本地的一个硬盘，如`/dev/sda`，也可以是一个LVM卷。
* fileio。把本地的一个文件当作一个块设备，如一个raw格式的虚拟硬盘。

除了以上两类，还有pscsi、ramdisk等。

backstore需要添加到指定的target中，target会把这些物理设备映射成逻辑设备，并分配一个id，称为LUN(逻辑单元号)。

为了更好的理解iSCSI，我们下节将一步步手动实践下如何使用iSCSI。

### 2.2 iSCSI实践

首先我们准备一台iscsi server服务器作为target，这里以CentOS 7为例，安装并启动iscsi服务:

```sh
yum install targetcli -y
systemctl enable target
systemctl start target
```

运行`targetcli`检查是否安装成功:

```
int32bit $ targetcli
targetcli shell version 2.1.fb41
Copyright 2011-2013 by Datera, Inc and others.
For help on commands, type 'help'.

/> ls
o- / .................................... [...]
  o- backstores ......................... [...]
  | o- block ............. [Storage Objects: 0]
  | o- fileio ............ [Storage Objects: 0]
  | o- pscsi ............. [Storage Objects: 0]
  | o- ramdisk ........... [Storage Objects: 0]
  o- iscsi ....................... [Targets: 0]
  o- loopback .................... [Targets: 0]
```

如果正常的话会进入targetcli shell，在根目录下运行`ls`命令可以查看所有的backstores和iscsi target。

具体的targetcli命令可以查看[官方文档](http://linux-iscsi.org/wiki/Targetcli)，这里需要说明的是，targetcli shell是有context session(上下文），简单理解就是类似Linux的文件系统目录，你处于哪个目录位置，对应不同的功能，比如你在`/backstores`目录则可以对backstores进行管理，你在`/iscsi`目录，则可以管理所有的iscsi target。你可以使用`pwd`查看当前工作目录，`cd`切换工作目录，`help`查看当前工作环境的帮助信息，`ls`查看子目录结构等，你可以使用`tab`键补全命令，和我们Linux shell操作非常相似，因此使用起来还是比较顺手的。

为了简单起见，我们创建一个fileio类型的backstore，首先我们`cd`到`/backstores/fileio`目录:

```sh
/> cd /backstores/fileio
/backstores/fileio> create test_fileio /tmp/test_fileio.raw 2G write_back=false
Created fileio test_fileio with size 2147483648
```

我们创建了一个名为`test_fileio`的fileio类型backstore，文件路径为`/tmp/test_fileio.raw`，大小为2G，如果文件不存在会自动创建。

创建了backstore后，我们创建一个target，`cd`到`/iscsi`目录:

```sh
/iscsi> create iqn.2017-09.me.int32bit:int32bit
Created target iqn.2017-09.me.int32bit:int32bit.
Created TPG 1.
Default portal not created, TPGs within a target cannot share ip:port.
/iscsi>
```

以上我们创建了一个名为`int32bit`的target，前面的`iqn.2017-09.me.int32bit`是iSCSI Qualified Name (IQN)，具体含义参考[wikipedia-ISCSI](https://en.wikipedia.org/wiki/ISCSI)，这里简单理解为一个独一无二的namespace就好。使用`ls`命令我们发现创建一个目录`iqn.2017-09.me.int32bit:int32bit`（注意：实际上并不是目录，我们暂且这么理解）。

创建完target后，我们还需要把这个target export出去，即进入监听状态，我们称为portal，创建portal也很简单:

```sh
/iscsi> cd iqn.2017-09.me.int32bit:int32bit/tpg1/portals/
/iscsi/iqn.20.../tpg1/portals> create 10.0.0.4
Using default IP port 3260
Created network portal 10.0.0.4:3260.
```

以上`10.0.0.4`是server的ip，不指定端口的话就会使用默认的端口3260。

target创建完毕，此时我们可以把我们之前创建的backstore加到这个target中:

```sh
/iscsi/iqn.20.../tpg1/portals> cd ../luns
/iscsi/iqn.20...bit/tpg1/luns> create /backstores/fileio/test_fileio
Created LUN 0.
```

此时我们的target包含有一个lun设备了:

```sh
/iscsi/iqn.20...bit/tpg1/luns> ls /iscsi/iqn.2017-09.me.int32bit:int32bit/
o- iqn.2017-09.me.int32bit:int32bit ...................................................................................... [TPGs: 1]
  o- tpg1 ................................................................................................... [no-gen-acls, no-auth]
    o- acls .............................................................................................................. [ACLs: 0]
    o- luns .............................................................................................................. [LUNs: 1]
    | o- lun0 .......................................................................... [fileio/test_fileio (/tmp/test_fileio.raw)]
    o- portals ........................................................................................................ [Portals: 0]
```

接下来我们配置client端，即iSCSI Initiator：

```
yum install iscsi-initiator-utils -y
systemctl enable iscsid iscsi
systemctl start iscsid iscsi
```

拿到本机的initiator name:

```
int32bit $ cat /etc/iscsi/initiatorname.iscsi
InitiatorName=iqn.1994-05.com.redhat:e0db637c5ce
```

client需要连接server target，还需要ACL认证，我们在server端增加client的访问权限，在server端运行:

```sh
int32bit $ targetcli
targetcli shell version 2.1.fb41
Copyright 2011-2013 by Datera, Inc and others.
For help on commands, type 'help'.

/> cd /iscsi/iqn.2017-09.me.int32bit:int32bit/tpg1/acls
/iscsi/iqn.20...bit/tpg1/acls> create iqn.1994-05.com.redhat:e0db637c5ce
Created Node ACL for iqn.1994-05.com.redhat:e0db637c5ce
Created mapped LUN 0.
```

**注意：以上我们没有设置账户和密码，client直接就能登录。**

一切准备就绪，接下来让我们在client端连接我们的target吧。

首先我们使用`iscsiadm`命令自动发现本地可见的target列表:

```sh
int32bit $ iscsiadm --mode discovery --type sendtargets --portal 10.0.0.4 | grep int32bit
10.0.0.4:3260,1 iqn.2017-09.me.int32bit:int32bit
```

发现target后，我们登录验证后才能使用：

```sh
int32bit $ iscsiadm -m node -T iqn.2017-09.me.int32bit:int32bit -l
Logging in to [iface: default, target: iqn.2017-09.me.int32bit:int32bit, portal: 10.0.0.4,3260] (multiple)
Login to [iface: default, target: iqn.2017-09.me.int32bit:int32bit, portal: 10.0.0.4,3260] successful.
```

我们可以查看所有已经登录的target:

```sh
int32bit $ iscsiadm -m session
tcp: [173] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-1e062767-f0bc-40fb-9a03-7b0df61b5671 (non-flash)
tcp: [198] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-060fe764-c17b-45da-af6d-868c1f5e19df (non-flash)
tcp: [199] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-757f6281-8c71-430e-9f7c-5df2e3008b46 (non-flash)
tcp: [203] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063 (non-flash)
tcp: [205] 10.0.0.4:3260,1 iqn.2017-09.me.int32bit:int32bit (non-flash)
```

此时target已经自动映射到本地块设备，我们可以使用`lsblk`查看:

```
int32bit $ lsblk --scsi
NAME HCTL       TYPE VENDOR   MODEL             REV TRAN
sda  0:0:2:0    disk ATA      INTEL SSDSC2BX40 DL2B
sdb  0:0:3:0    disk ATA      INTEL SSDSC2BX40 DL2B
sdc  0:0:4:0    disk ATA      INTEL SSDSC2BX40 DL2B
sdd  0:0:5:0    disk ATA      INTEL SSDSC2BX40 DL2B
sde  0:0:6:0    disk ATA      INTEL SSDSC2BX40 DL2B
sdf  0:0:7:0    disk ATA      INTEL SSDSC2BX40 DL2B
sdg  0:2:0:0    disk DELL     PERC H330 Mini   4.26
sdh  183:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdi  208:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdj  209:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdk  213:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdm  215:0:0:0  disk LIO-ORG  test_fileio      4.0  iscsi
```

可见映射本地设备为`/dev/shm`。接下来就可以当作本地硬盘一样使用了。

以上我们是通过target服务器的一个本地文件以块形式共享的，通常这只是用来测试，生产环境下一般都通过商业存储提供真实的块设备来共享。OpenStack Cinder如果使用的LVM driver，则是通过LVM卷共享的，这其实不难实现，只需要把LVM对应LV PATH加到block backstore即可，本文后面会重点介绍这种情况。

### 2.3 cinder-rtstool工具简介

前面我们使用的`targetcli`是Datera公司开发的，不仅提供了这个CLI工具，Datera还提供了一个Python库-rtslib，该项目地址为[rtslib](https://github.com/Datera/rtslib)。可能由于某些原因，社区fork自rtslib项目，并单独维护了一个分支，命名为“free branch”，即[rtslib-fb](https://github.com/open-iscsi/rtslib-fb)项目，目前这两个分支可能不兼容，因此确保targetcli、rtslib以及configshell是在同一个版本分支，要么全是fb，要么全是non-fb。

OpenStack社区基于rtstool封装了一个CLI工具，即我们要介绍的cinder-rtstool工具。该工具使用起来非常简单，我们查看它的`help`信息:

```sh
$ cinder-rtstool --help
Usage:
cinder-rtstool create [device] [name] [userid] [password] [iser_enabled] <initiator_iqn,iqn2,iqn3,...> [-a<IP1,IP2,...>] [-pPORT]
cinder-rtstool add-initiator [target_iqn] [userid] [password] [initiator_iqn]
cinder-rtstool delete-initiator [target_iqn] [initiator_iqn]
cinder-rtstool get-targets
cinder-rtstool delete [iqn]
cinder-rtstool verify
cinder-rtstool save [path_to_file]
```

该工具主要运行在target端，即cinder-volume所在节点，其中`create`命令用于快速创建一个`target`，并把设备加到该`target`中，当然也包括创建对应的`portal`。`add-initiator`对应就是创建`acls`，`get-targets`列出当前服务器的创建的所有`target`。其它命令不过多介绍，基本都能大概猜出什么功能。

### 2.4 ceph rbd介绍

Ceph是开源分布式存储系统，具有高扩展性、高性能、高可靠性等优点，同时提供块存储服务(rbd)、对象存储服务(rgw)以及文件系统存储服务(cephfs)。目前也是OpenStack的主流后端存储，为OpenStack提供统一共享存储服务。使用ceph作为OpenStack后端存储，至少包含以下几个优点：

1. 所有的计算节点共享存储，迁移时不需要拷贝块设备，即使计算节点挂了，也能立即在另一个计算节点启动虚拟机（evacuate）。
2. 利用COW特性，创建虚拟机时，只需要基于镜像clone即可，不需要下载整个镜像，而clone操作基本是0开销。
3. ceph rbd支持thin provisioning，即按需分配空间，有点类似Linux文件系统的sparse稀疏文件。你开始创建一个20GB的虚拟硬盘时，实际上不占用真正的物理存储空间，只有当写入数据时，才逐一分配空间，从而实现了磁盘的overload。

ceph的更多知识可以参考[官方文档](http://ceph.com/)，这里我们仅仅简单介绍下rbd。

前面我们介绍的iSCSI有个`target`的概念，存储设备必须加到指定的`target`中，映射为lun。rbd中也有一个`pool`的概念，rbd创建的虚拟块设备实例我们称为`image`，所有的`image`必须包含在一个`pool`中。这里我们暂且不讨论`pool`的作用，简单理解是一个`namespace`即可。

我们可以通过`rbd`命令创建一个rbd `image`：

```sh
$ rbd -p test2 create --size 1024 int32bit-test-rbd --new-format
$ rbd -p test2 ls
int32bit-test-rbd
centos7.raw
$ rbd -p test2 info int32bit-test-rbd
rbd image 'int32bit-test-rbd':
        size 1024 MB in 256 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.9beee82ae8944a
        format: 2
        features: layering
        flags:
```

以上我们通过`create`子命令创建了一个name为`int32bit-test-rbd`，大小为1G的 `image`，其中`-p`的参数值`test2`就是`pool`名称。通过`ls`命令可以查看所有的`image`列表，`info`命令查看`image`的详细信息。

iSCSI创建lun设备后，Initiator端通过`login`把设备映射到本地。`rbd image`则是通过`map`操作映射到本地的，在client端安装ceph client包并配置好证书后，只需要通过`rbd map`即可映射到本地中:

```
$ rbd -p test2 map int32bit-test-rbd
/dev/rbd0
```

此时我们把创建的`image`映射到了`/dev/rbd0`中，作为本地的一个块设备，现在可以对该设备像本地磁盘一样使用。

### 2.5 如何把块设备挂载到虚拟机

如何把一个块设备提供给虚拟机使用，`qemu-kvm`只需要通过`--drive`参数指定即可。如果使用libvirt，以CLI `virsh`为例，可以通过`attach-device`子命令挂载设备给虚拟机使用，该命令包含两个必要参数，一个是`domain`，即虚拟机id，另一个是xml文件,文件包含设备的地址信息。

```sh
$ virsh  help attach-device
  NAME
    attach-device - attach device from an XML file

  SYNOPSIS
    attach-device <domain> <file> [--persistent] [--config] [--live] [--current]

  DESCRIPTION
    Attach device from an XML <file>.

  OPTIONS
    [--domain] <string>  domain name, id or uuid
    [--file] <string>  XML file
    --persistent     make live change persistent
    --config         affect next boot
    --live           affect running domain
    --current        affect current domain
```

iSCSI设备需要先把lun设备映射到宿主机本地，然后当做本地设备挂载即可。一个简单的demo xml为:

```xml
<disk type='block' device='disk'>
      <driver name='qemu' type='raw' cache='none' io='native'/>
      <source dev='/dev/disk/by-path/ip-10.0.0.2:3260-iscsi-iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063-lun-0'/>
      <target dev='vdb' bus='virtio'/>
      <serial>2ed1b04c-b34f-437d-9aa3-3feeb683d063</serial>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x06' function='0x0'/>
</disk>
```

可见`source`就是lun设备映射到本地的路径。

值得一提的是，libvirt支持直接挂载rbd `image`（宿主机需要包含rbd内核模块），通过rbd协议访问image，而不需要先`map`到宿主机本地，一个demo xml文件为:

```xml
<disk type='network' device='disk'>
      <driver name='qemu' type='raw' cache='writeback'/>
      <auth username='admin'>
        <secret type='ceph' uuid='bdf77f5d-bf0b-1053-5f56-cd76b32520dc'/>
      </auth>
      <source protocol='rbd' name='nova-pool/962b8560-95c3-4d2d-a77d-e91c44536759_disk'>
        <host name='10.0.0.2' port='6789'/>
        <host name='10.0.0.3' port='6789'/>
        <host name='10.0.0.4' port='6789'/>
      </source>
      <target dev='vda' bus='virtio'/>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x05' function='0x0'/>
</disk>
```

所以我们Cinder如果使用LVM driver，则需要先把LV加到iSCSI target中，然后映射到计算节点的宿主机，而如果使用rbd driver，不需要映射到计算节点，直接挂载即可。

以上介绍了存储的一些基础知识，有了这些知识，再去理解OpenStack nova和cinder就非常简单了，接下来我们开始进入我们的正式主题，分析OpenStack虚拟机挂载数据卷的流程。

## 3 OpenStack虚拟机挂载volume源码分析

这里我们先以Ciner使用LVM driver为例，iSCSI驱动使用`lioadm`，backend配置如下:

```ini
[lvm]
iscsi_helper=lioadm
volume_driver=cinder.volume.drivers.lvm.LVMVolumeDriver
volume_backend_name=lvm
volume_group = cinder-volumes
```

OpenStack源码阅读方法可以参考[如何阅读OpenStack源码](http://int32bit.me/2017/08/28/%E5%A6%82%E4%BD%95%E9%98%85%E8%AF%BBOpenStack%E6%BA%90%E7%A0%81/)，这里不过多介绍。这里需要说明的是，Nova中有一个数据库表专门用户存储数据卷和虚拟机的映射关系的，这个表名为`block_device_mapping`，其字段如下：

```
MariaDB [nova]> desc block_device_mapping;
+-----------------------+--------------+------+-----+---------+----------------+
| Field                 | Type         | Null | Key | Default | Extra          |
+-----------------------+--------------+------+-----+---------+----------------+
| created_at            | datetime     | YES  |     | NULL    |                |
| updated_at            | datetime     | YES  |     | NULL    |                |
| deleted_at            | datetime     | YES  |     | NULL    |                |
| id                    | int(11)      | NO   | PRI | NULL    | auto_increment |
| device_name           | varchar(255) | YES  |     | NULL    |                |
| delete_on_termination | tinyint(1)   | YES  |     | NULL    |                |
| snapshot_id           | varchar(36)  | YES  | MUL | NULL    |                |
| volume_id             | varchar(36)  | YES  | MUL | NULL    |                |
| volume_size           | int(11)      | YES  |     | NULL    |                |
| no_device             | tinyint(1)   | YES  |     | NULL    |                |
| connection_info       | mediumtext   | YES  |     | NULL    |                |
| instance_uuid         | varchar(36)  | YES  | MUL | NULL    |                |
| deleted               | int(11)      | YES  |     | NULL    |                |
| source_type           | varchar(255) | YES  |     | NULL    |                |
| destination_type      | varchar(255) | YES  |     | NULL    |                |
| guest_format          | varchar(255) | YES  |     | NULL    |                |
| device_type           | varchar(255) | YES  |     | NULL    |                |
| disk_bus              | varchar(255) | YES  |     | NULL    |                |
| boot_index            | int(11)      | YES  |     | NULL    |                |
| image_id              | varchar(36)  | YES  |     | NULL    |                |
+-----------------------+--------------+------+-----+---------+----------------+
```

Cinder中也有一个单独的表`volume_attachment`用来记录挂载情况:

```sh
MariaDB [cinder]> desc volume_attachment;
+---------------+--------------+------+-----+---------+-------+
| Field         | Type         | Null | Key | Default | Extra |
+---------------+--------------+------+-----+---------+-------+
| created_at    | datetime     | YES  |     | NULL    |       |
| updated_at    | datetime     | YES  |     | NULL    |       |
| deleted_at    | datetime     | YES  |     | NULL    |       |
| deleted       | tinyint(1)   | YES  |     | NULL    |       |
| id            | varchar(36)  | NO   | PRI | NULL    |       |
| volume_id     | varchar(36)  | NO   | MUL | NULL    |       |
| attached_host | varchar(255) | YES  |     | NULL    |       |
| instance_uuid | varchar(36)  | YES  |     | NULL    |       |
| mountpoint    | varchar(255) | YES  |     | NULL    |       |
| attach_time   | datetime     | YES  |     | NULL    |       |
| detach_time   | datetime     | YES  |     | NULL    |       |
| attach_mode   | varchar(36)  | YES  |     | NULL    |       |
| attach_status | varchar(255) | YES  |     | NULL    |       |
+---------------+--------------+------+-----+---------+-------+
13 rows in set (0.00 sec)
```

接下来我们从nova-api开始一步步跟踪其过程。

### S1 nova-api

nova-api挂载volume入口为`nova/api/openstack/compute/volumes.py`，controller为`VolumeAttachmentController`，`create`就是虚拟机挂载volume的方法。

该方法首先检查该volume是不是已经挂载到这个虚拟机了:

```python
bdms = objects.BlockDeviceMappingList.get_by_instance_uuid(
                context, instance.uuid)
for bdm in bdms:
    if bdm.volume_id == volume_id:
        _msg = _("Volume %(volume_id)s have been attaced to "
                 "instance %(server_id)s.") % {
                 'volume_id': volume_id,
                 'server_id': server_id}
        raise exc.HTTPConflict(explanation=_msg)
```

然后调用`nova/compute/api.py`的`attach_volume`方法，该方法的工作内容为:

#### (1) `create_volume_bdm()`

即在`block_device_mapping`表中创建对应的记录，由于API节点无法拿到目标虚拟机挂载后的设备名，比如`/dev/vdb`，只有计算节点才知道自己虚拟机映射到哪个设备。因此bdm不是在API节点创建的，而是通过RPC请求到虚拟机所在的计算节点创建，请求方法为`reserve_block_device_name`，该方法首先调用libvirt分配一个设备名，比如`/dev/vdb`，然后创建对应的bdm实例。

#### (2) `check_attach_and_reserve_volume()`

这里包含`check_attach`和`reserve_volume`两个过程，`check_attach`就是检查这个volume能不能挂载，比如status必须为`avaliable`，或者支持多挂载情况下状态为`in-use`或者`avaliable`。该方法位置为`nova/volume/cinder.py`的`check_attach`方法。而`reserve_volume`是由Cinder完成的，nova-api会调用cinder API。该方法其实不做什么工作，仅仅是把volume的status置为`attaching`。该方法流程:`nova-api -> cinder-api -> reserver_volume`，该方法位于`cinder/volume/api.py`：

```python
@wrap_check_policy
def reserve_volume(self, context, volume):
    expected = {'multiattach': volume.multiattach,
                'status': (('available', 'in-use') if volume.multiattach
                           else 'available')}

    result = volume.conditional_update({'status': 'attaching'}, expected)

    if not result:
        expected_status = utils.build_or_str(expected['status'])
        msg = _('Volume status must be %s to reserve.') % expected_status
        LOG.error(msg)
        raise exception.InvalidVolume(reason=msg)

    LOG.info(_LI("Reserve volume completed successfully."),
             resource=volume)
``` 
#### (3) RPC计算节点的`attach_volume()`

此时nova-api会向目标计算节点发起RPC请求，由于`rpcapi.py`的`attach_volume`方法调用的是`cast`方法，因此该RPC是异步调用。由此，nova-api的工作结束，剩下的工作由虚拟机所在的计算节点完成。

### S2 nova-compute

nova-compute接收到RPC请求，callback函数入口为`nova/compute/manager.py`的`attach_volume`方法，该方法会根据之前创建的bdm实例参数转化为`driver_block_device`，然后调用该类的`attach`方法，这就已经到了具体的硬件层，它会根据volume的类型实例化不同的具体类，这里我们的类型是volume，因此对应为`DriverVolumeBlockDevice`，位于`nova/virt/block_device.py`。

我们看其`attach`方法，该方法是虚拟机挂载卷的最重要方法，也是实现的核心。该方法分好几个阶段，我们一个一个阶段看。

#### (1) `get_volume_connector()`

该方法首先调用的是`virt_driver.get_volume_connector(instance)`，其中`virt_driver`这里就是`libvirt`，该方法位于`nova/virt/libvirt/driver.py`，其实就是调用os-brick的`get_connector_properties`:

```python
def get_volume_connector(self, instance):
   root_helper = utils.get_root_helper()
   return connector.get_connector_properties(
       root_helper, CONF.my_block_storage_ip,
       CONF.libvirt.iscsi_use_multipath,
       enforce_multipath=True,
       host=CONF.host)
```

os-brick是从Cinder项目分离出来的，专门用于管理各种存储系统卷的库，代码仓库为[os-brick](https://github.com/openstack/os-brick)。其中`get_connector_properties`方法位于`os_brick/initiator/connector.py`:

```python
def get_connector_properties(root_helper, my_ip, multipath, enforce_multipath,
                             host=None):
    iscsi = ISCSIConnector(root_helper=root_helper)
    fc = linuxfc.LinuxFibreChannel(root_helper=root_helper)

    props = {}
    props['ip'] = my_ip
    props['host'] = host if host else socket.gethostname()
    initiator = iscsi.get_initiator()
    if initiator:
        props['initiator'] = initiator
    wwpns = fc.get_fc_wwpns()
    if wwpns:
        props['wwpns'] = wwpns
    wwnns = fc.get_fc_wwnns()
    if wwnns:
        props['wwnns'] = wwnns
    props['multipath'] = (multipath and
                          _check_multipathd_running(root_helper,
                                                    enforce_multipath))
    props['platform'] = platform.machine()
    props['os_type'] = sys.platform
    return props
```

该方法最重要的工作就是返回该计算节点的信息（如ip、操作系统类型等)以及`initiator name`(参考第2节内容)。

#### (2) `volume_api.initialize_connection()`

终于轮到Cinder真正干点活了！该方法会调用Cinder API的`initialize_connection`方法，该方法又会RPC请求给volume所在的`cinder-volume`服务节点。我们略去`cinder-api`，直接到`cinder-volume`。

### S3 cinder-volume

代码位置为`cinder/volume/manager.py`，该方法也是分阶段的。

#### (1) `driver.validate_connector()`

该方法不同的driver不一样，对于LVM + iSCSI来说，就是检查有没有`initiator`字段，即nova-compute节点的initiator信息，代码位于`cinder/volume/targets/iscsi.py`：

```python
def validate_connector(self, connector):
   # NOTE(jdg): api passes in connector which is initiator info
   if 'initiator' not in connector:
       err_msg = (_LE('The volume driver requires the iSCSI initiator '
                      'name in the connector.'))
       LOG.error(err_msg)
       raise exception.InvalidConnectorException(missing='initiator')
   return True
```

注意以上代码跳转过程：`drivers/lvm.py -> targets/lio.py` -> `targets/iscsi.py`。即我们的lvm driver会调用`target`相应的方法，这里我们用的是`lio`，因此调到`lio.py`，而`lio`又继承自`iscsi`，因此跳到`iscsi.py`。下面分析将省去这些细节直接跳转。

#### (2) `driver.create_export()`

该方法位于`cinder/volume/targets/iscsi.py`:

```python
def create_export(self, context, volume, volume_path):
    # 'iscsi_name': 'iqn.2010-10.org.openstack:volume-00000001'
    iscsi_name = "%s%s" % (self.configuration.iscsi_target_prefix,
                           volume['name'])
    iscsi_target, lun = self._get_target_and_lun(context, volume)
    chap_auth = self._get_target_chap_auth(context, iscsi_name)
    if not chap_auth:
        chap_auth = (vutils.generate_username(),
                     vutils.generate_password())

    # Get portals ips and port
    portals_config = self._get_portals_config()
    tid = self.create_iscsi_target(iscsi_name,
                                   iscsi_target,
                                   lun,
                                   volume_path,
                                   chap_auth,
                                   **portals_config)
    data = {}
    data['location'] = self._iscsi_location(
        self.configuration.iscsi_ip_address, tid, iscsi_name, lun,
        self.configuration.iscsi_secondary_ip_addresses)
    LOG.debug('Set provider_location to: %s', data['location'])
    data['auth'] = self._iscsi_authentication(
        'CHAP', *chap_auth)
    return data
```

该方法最重要的操作是调用了`create_iscsi_target`方法，该方法其实就是调用了`cinder-rtstool`的`create`方法:

```python
command_args = ['cinder-rtstool',
            'create',
            path,
            name,
            chap_auth_userid,
            chap_auth_password,
            self.iscsi_protocol == 'iser'] + optional_args
self._execute(*command_args, run_as_root=True)
```

即`create_export`方法的主要工作就是调用`cinder-rtstool`工具创建target，并把设备添加到target中。

在cinder-volume节点可以通过`targetcli`查看所有`export`的target:

```sh
/iscsi> ls /iscsi/ 1
o- iscsi .............................................................................................................. [Targets: 5]
  o- iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063 ............................................... [TPGs: 1]
  o- iqn.2010-10.org.openstack:volume-70347e2a-cdfc-4575-a891-3973ec264ec0 ............................................... [TPGs: 1]
  o- iqn.2010-10.org.openstack:volume-980eaf85-9d63-4e1e-9e47-75f1a14ecc40 ............................................... [TPGs: 1]
  o- iqn.2010-10.org.openstack:volume-db6aa94d-64cc-4996-805e-f768346d8082 ............................................... [TPGs: 1]
```

#### (3) `driver.initialize_connection()`

这是最后一步。该方法位于`cinder/volume/targets/lio.py`:

```python
def initialize_connection(self, volume, connector):
    volume_iqn = volume['provider_location'].split(' ')[1]
    (auth_method, auth_user, auth_pass) = \
        volume['provider_auth'].split(' ', 3)
    # Add initiator iqns to target ACL
    try:
        self._execute('cinder-rtstool', 'add-initiator',
                      volume_iqn,
                      auth_user,
                      auth_pass,
                      connector['initiator'],
                      run_as_root=True)
    except putils.ProcessExecutionError:
        LOG.exception(_LE("Failed to add initiator iqn %s to target"),
                      connector['initiator'])
        raise exception.ISCSITargetAttachFailed(
            volume_id=volume['id'])
    self._persist_configuration(volume['id'])
    return super(LioAdm, self).initialize_connection(volume, connector)
```

该方法的重要工作就是调用`cinder-rtstool`的`add-initiator`子命令，即把计算节点的initiator增加到刚刚创建的target acls中。

`targetcli`输出结果如下:

```sh
/iscsi> ls /iscsi/iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063/tpg1/acls/
o- acls .................................................................................................................. [ACLs: 1]
  o- iqn.1994-05.com.redhat:e0db637c5ce ............................................................... [1-way auth, Mapped LUNs: 1]
    o- mapped_lun0 ......................... [lun0 block/iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063 (rw)]
```

因此Cinder的主要工作就是创建volume的iSCSI target以及acls。cinder-volume工作结束，我们返回到nova-compute。

### S4 nova-compute

回到nova-compute的第(2)步，调用`volume_api.initialize_connection()`后，执行第(3)步。

#### (3) `virt_driver.attach_volume()`

此时到达libvirt层，代码位于`nova/virt/libvirt/driver.py`，该方法分为如下几个步骤。

##### 1. `_connect_volume()`

该方法会调用`nova/virt/libvirt/volume/iscsi.py`的`connect_volume()`方法，该方法其实是直接调用os-brick的`connect_volume()`方法，该方法位于`os_brick/initiator/connector.py`中`ISCSIConnector`类中的`connect_volume`方法，该方法会调用前面介绍的`iscsiadm`命令的`discovory`以及`login`子命令，即把lun设备映射到本地设备。

可以使用`iscsiadm`查看已经connect(login)的所有volume:

```sh
$ iscsiadm -m session
tcp: [203] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063 (non-flash)
tcp: [206] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-980eaf85-9d63-4e1e-9e47-75f1a14ecc40 (non-flash)
tcp: [207] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-70347e2a-cdfc-4575-a891-3973ec264ec0 (non-flash)
tcp: [208] 10.0.0.4:3260,1 iqn.2010-10.org.openstack:volume-db6aa94d-64cc-4996-805e-f768346d8082 (non-flash)
```

使用`lsblk`查看映射路径:

```sh
$ lsblk --scsi
NAME HCTL       TYPE VENDOR   MODEL             REV TRAN
... # 略去部分输出
sdh  216:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdi  217:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdj  218:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
sdk  213:0:0:0  disk LIO-ORG  IBLOCK           4.0  iscsi
```

也可以在Linux的`/dev/disk`中`by-path`找到:

```sh
$ ls -l /dev/disk/by-path/
total 0
lrwxrwxrwx 1 root root  9 Sep  6 17:21 ip-10.0.0.4:3260-iscsi-iqn.2010-10.org.openstack:volume-2ed1b04c-b34f-437d-9aa3-3feeb683d063-lun-0 -> ../../sdk
lrwxrwxrwx 1 root root  9 Sep  8 17:34 ip-10.0.0.4:3260-iscsi-iqn.2010-10.org.openstack:volume-70347e2a-cdfc-4575-a891-3973ec264ec0-lun-0 -> ../../sdi
lrwxrwxrwx 1 root root  9 Sep  8 17:29 ip-10.0.0.4:3260-iscsi-iqn.2010-10.org.openstack:volume-980eaf85-9d63-4e1e-9e47-75f1a14ecc40-lun-0 -> ../../sdh
lrwxrwxrwx 1 root root  9 Sep  8 17:35 ip-10.0.0.4:3260-iscsi-iqn.2010-10.org.openstack:volume-db6aa94d-64cc-4996-805e-f768346d8082-lun-0 -> ../../sdj
```

##### 2. `_get_volume_config()`

获取`volume`的信息，其实也就是我们生成xml需要的信息，最重要的就是拿到映射后的本地设备的路径，如`/dev/disk/by-path/ip-10.0.0.2:3260-iscsi-iqn.2010-10.org.openstack:volume-060fe764-c17b-45da-af6d-868c1f5e19df-lun-0`,返回的conf最终会转化成xml格式。该代码位于`nova/virt/libvirt/volume/iscsi.py`：

```python
def get_config(self, connection_info, disk_info):
    """Returns xml for libvirt."""
    conf = super(LibvirtISCSIVolumeDriver,
                 self).get_config(connection_info, disk_info)
    conf.source_type = "block"
    conf.source_path = connection_info['data']['device_path']
    conf.driver_io = "native"
    return conf
```

##### 3. `guest.attach_device()`

终于到了最后一步，该步骤其实就类似于调用`virsh attach-device`命令把设备挂载到虚拟机中，该代码位于`nova/virt/libvirt/guest.py`：

```python
def attach_device(self, conf, persistent=False, live=False):
   """Attaches device to the guest.

   :param conf: A LibvirtConfigObject of the device to attach
   :param persistent: A bool to indicate whether the change is
                      persistent or not
   :param live: A bool to indicate whether it affect the guest
                in running state
   """
   flags = persistent and libvirt.VIR_DOMAIN_AFFECT_CONFIG or 0
   flags |= live and libvirt.VIR_DOMAIN_AFFECT_LIVE or 0
   self._domain.attachDeviceFlags(conf.to_xml(), flags=flags)
```

libvirt的工作完成，此时volume已经挂载到虚拟机中了。

#### (4) `volume_api.attach()`

回到`nova/virt/block_device.py`，最后调用了`volume_api.attach()`方法，该方法向Cinder发起API请求。此时cinder-api通过RPC请求到`cinder-volume`，代码位于`cinder/volume/manager.py`，该方法没有做什么工作，其实就是更新数据库，把volume状态改为`in-use`，并创建对应的`attach`记录。

到此，OpenStack整个挂载流程终于结束了，我们是从Nova的视角分析，如果从Cinder的视角分析，其实Cinder的工作并不多，总结有如下三点:

* `reserve_volume`: 把volume的状态改为`attaching`，阻止其它节点执行挂载操作。
* `initialize_connection`: 创建target、lun、acls等。
* `attach_volume`: 把volume状态改为`in-use`，挂载成功。

## 4 OpenStack虚拟机挂载rbd分析

前面我们分析了LVM + lio的volume挂载流程，如果挂载rbd会有什么不同呢。这里我们不再详细介绍其细节过程，直接从cinder-volume的`initialize_connection`入手。我们前面已经分析cinder-volume的`initialize_connection`步骤:

* `driver.validate_connector()`
* `driver.create_export()`
* `driver.initialize_connection()`

这些步骤对应ceph rbd就特别简单。因为rbd不需要像iSCSI那样创建target、创建portal，因此rbd driver的`create_export()`方法为空:

```python
def create_export(self, context, volume, connector):
    """Exports the volume."""
    pass
```

`initialize_connection()`方法也很简单，直接返回rbd image信息，如pool、image name、mon地址以及ceph配置信息等。

```python
def initialize_connection(self, volume, connector):
    hosts, ports = self._get_mon_addrs()
    data = {
        'driver_volume_type': 'rbd',
        'data': {
            'name': '%s/%s' % (self.configuration.rbd_pool,
                               volume.name),
            'hosts': hosts,
            'ports': ports,
            'auth_enabled': (self.configuration.rbd_user is not None),
            'auth_username': self.configuration.rbd_user,
            'secret_type': 'ceph',
            'secret_uuid': self.configuration.rbd_secret_uuid,
            'volume_id': volume.id,
            'rbd_ceph_conf': self.configuration.rbd_ceph_conf,
        }
    }
    LOG.debug('connection data: %s', data)
```

而前面介绍过了，rbd不需要映射虚拟设备到宿主机，因此`connect_volume`方法也是为空。

剩下的工作其实就是nova-compute节点libvirt调用`get_config()`方法获取ceph的mon地址、rbd image信息、认证信息等，并转为成xml格式，最后调用`guest.attach_device()`即完成了volume的挂载。

因此，相对iSCSI，rbd挂载过程简单得多。

## 4 总结

总结下整个过程，仍以LVM+LIO为例，从创建volume到挂载volume的流程如下:

1. 创建一个volume，相当于在cinder-volume节点指定的LVM volume group(vg)中创建一个LVM volume卷(lv)。
2. 挂载volume由nova发起，nova-api会检查volume状态，然后通知cinder，cinder把volume状态置为`attaching`。
3. 剩余大多数工作由nova-compute完成，它先拿到自己所在节点的iscsi name。
4. nova-compute向cinder请求，cinder会创建对应的target，并把nova-compute节点加到acls中。
5. nova-compute节点通过iscsiadm命令把volume映射到本地，这个过程称为connect volume。
6. nova-compute节点生成挂载的xml配置文件。
7. nova-compute调用libvirt的`attach-device`接口把volume挂载到虚拟机。


挂载过程总结为以下流图:

![OpenStack attach volume flow](/img/posts/OpenStack虚拟机挂载数据卷过程分析/flow.png)

需要注意的是，以上分析都是基于老版本的`attach API`，社区从Ocata版本开始引入和开发新的`volume attach API`，整个流程可能需要重新设计，具体可参考[add new attch apis](http://specs.openstack.org/openstack/cinder-specs/specs/ocata/add-new-attach-apis.html)，这个新的API设计将更好的实现多挂载(multi-attach)以及更好地解决cinder和nova状态不一致问题。

## 参考文献

1. [how to configure an iscsi target and initiator in linux](https://www.rootusers.com/how-to-configure-an-iscsi-target-and-initiator-in-linux/).
2. [block device mapping](https://docs.openstack.org/nova/latest/user/block-device-mapping.html).
3. [create centralized secure storage using iscsi target in linux](https://www.tecmint.com/create-centralized-secure-storage-using-iscsi-targetin-linux/).
4. [linux iscsi](http://linux-iscsi.org).
5. [Targetcli](http://linux-iscsi.org/wiki/Targetcli).
6. [volume attach code flow in cinder](https://griffithscorner.wordpress.com/2015/07/16/volume-attach-code-flow-in-cinder/).
7. [cinder new attach apis](https://specs.openstack.org/openstack/nova-specs/specs/pike/approved/cinder-new-attach-apis.html)
8. [add new attach apis](http://specs.openstack.org/openstack/cinder-specs/specs/ocata/add-new-attach-apis.html)

## 附：OpenStack attach volume flow

以上的流程图可能看不太清楚，可以直接在[Draw sequence diagrams online in seconds](https://www.websequencediagrams.com/)查看原始图，以下是flow源码:

```
title OpenStack attach volume flow

participant client
participant nova-api
participant cinder
participant nova-compute
participant libvirt

client -> nova-api: volume_attach
activate client
activate nova-api
note over nova-api: check if volume has been attached
nova-api->nova-compute: reserve_block_device_name
activate nova-compute

nova-compute->libvirt: get device name for instance
activate libvirt
libvirt->nova-compute: return /dev/vdb
deactivate libvirt

note over nova-compute: create bdm
nova-compute->nova-api: return new bdm
deactivate nova-compute
note over nova-api: check attach
nova-api->cinder: reserve_volume
activate cinder
note over cinder: set volume status to 'attaching'
cinder->nova-api: done
deactivate cinder

nova-api->nova-compute: attach_volume
deactivate nova-api
deactivate client
activate nova-compute
note over nova-compute: convert bdm to block device driver
note over nova-compute: get_volume_connector

nova-compute->cinder: initialize_connection
activate cinder
note over cinder: require driver initialized
note over cinder: validate connector
note over cinder: create export
note over cinder: do driver initialize connection
cinder->nova-compute: return connection info
deactivate cinder

nova-compute->libvirt: attach_volume
activate libvirt
note over libvirt: connect volume
note over libvirt: get volume conf and convert to xml
note over libvirt: attach device
libvirt->nova-compute: done
deactivate libvirt

nova-compute->cinder:attach_volume
activate cinder
note over cinder: set volume status to 'in-use'
note over cinder: create attachment
cinder->nova-compute: return attachment
deactivate cinder

note over nova-compute: END
deactivate nova-compute
```
