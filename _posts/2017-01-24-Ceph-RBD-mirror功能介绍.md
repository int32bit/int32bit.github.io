---
layout: post
title: Ceph RBD mirror功能介绍
catalog: true
tags: [Ceph, OpenStack]
---

## 1.Ceph RBD mirror简介

Ceph采用的是强一致性同步模型，所有副本都必须完成写操作才算一次写入成功，这就导致不能很好地支持跨域部署，因为如果副本在异地，网络延迟就会很大，拖垮整个集群的写性能。因此，Ceph集群很少有跨域部署的，也就缺乏异地容灾。Ceph RBD mirror是Ceph Jewel版本引入的新功能，支持两个Ceph集群数据同步，其原理非常类似mysql的主从同步机制，前者基于journaling，后者基于binlog,二者都是基于日志回放完成主从同步的。

## 2.Ceph RBD mirror配置

### 2.1 环境准备

体验Ceph RBD mirror功能，必须准备好以下环境：

* Ceph版本Jewel或以上。
* 两个Ceph集群，并且这两个集群可以互通。
* Ceph集群开启journal特性。

我们知道一个ceph client节点可以同时访问多个Ceph集群，所有的ceph命令都可以通过`-–cluster`参数指定集群名字（更确切地说应该是一个命名空间），不指定该参数，则默认值为`ceph`，集群名字是通过`/etc/ceph`目录下的配置文件名区分的，`/etc/ceph/ceph.conf`对应名称为`ceph`的集群名配置，而`/etc/ceph/openstack.conf`则对应名称为`openstack`的Ceph集群。密钥文件命名也一样。

假设我们在server-31、server-32上都部署了两套独立的allinone ceph环境，分别命名为31节点、32节点，这两个环境的ceph版本都是Jewel。在31节点上同时访问这两个ceph集群，只需要复制配置文件到/etc/ceph目录下即可，并且指定配置文件和密钥文件名，如下:

```sh
cd /etc/ceph
cp ceph.conf server-31.conf
cp ceph.client.admin.keyring server-31.client.admin.keyring
scp server-32:/etc/ceph/ceph.conf server-32.conf
scp server-32:/etc/ceph/ceph.client.admin.keyring server-32.client.admin.keyring
```
最后ceph配置如下:

```
[root@server-31 ceph]# ll server*
-rw-r--r-- 1 root root 137 Jan 23 11:58 server-31.client.admin.keyring
-rw-r--r-- 1 root root 497 Jan 23 11:59 server-31.conf
-rw-r--r-- 1 root root 129 Jan 23 11:28 server-32.client.admin.keyring
-rw-r--r-- 1 root root 276 Jan 23 11:33 server-32.conf
```

**请确认ceph用户具有读权限，否则服务起不来**

验证：

```
[root@server-31 ceph]# ceph --cluster server-31 df
GLOBAL:
    SIZE     AVAIL     RAW USED     %RAW USED
    249G      235G       14669M          5.74
POOLS:
    NAME              ID     USED     %USED     MAX AVAIL     OBJECTS
    openstack         5      169M      0.07          235G          81
    rbd               6         0         0          235G           0
    int32bit-test     8      1040         0          235G          18
[root@server-31 ceph]# ceph --cluster server-32 df
GLOBAL:
    SIZE     AVAIL     RAW USED     %RAW USED
    249G      243G        6413M          2.51
POOLS:
    NAME              ID     USED     %USED     MAX AVAIL     OBJECTS
    rbd               10      114         0          243G           4
    int32bit-test     13      228         0          243G          10
```

开启journaling功能，可以在创建RBD image时通过`--image-feature`参数指定，也可以通过配置文件设置默认开启的features，features通过一个无符号长整型数的位标识，参考[CEPH RBD Features](https://github.com/ceph/ceph/blob/60c008d4df1b9eb5307dc8336a0d9bb0562aabd2/src/include/rbd/features.h#L4-L11)，代码如下:

```c
#define RBD_FEATURE_LAYERING		(1ULL<<0)
#define RBD_FEATURE_STRIPINGV2		(1ULL<<1)
#define RBD_FEATURE_EXCLUSIVE_LOCK	(1ULL<<2)
#define RBD_FEATURE_OBJECT_MAP		(1ULL<<3)
#define RBD_FEATURE_FAST_DIFF           (1ULL<<4)
#define RBD_FEATURE_DEEP_FLATTEN        (1ULL<<5)
#define RBD_FEATURE_JOURNALING          (1ULL<<6)
#define RBD_FEATURE_DATA_POOL           (1ULL<<7)
```

我们设置`default_rbd_features`值为`125`，在所有的配置文件的`[global]`配置组下配置：

```
rbd_default_features = 125
```

### 2.2 安装rbd-mirror服务

开启Ceph RBD mirror功能，必须额外安装rbd-mirror服务，CentOS下直接安装即可:

```
yum install -y rbd-mirror
```

启动服务：

```
systemctl enable ceph-rbd-mirror@admin.service
systemctl start ceph-rbd-mirror@admin.service
```

以上`@admin`的`admin`是client的用户名，我们使用admin这个用户。

注意，以上操作，必须在31、32节点上都执行。

### 2.3 RBD mirror配置

RBD mirror既可以针对一个pool进行配置，此时pool的每一个image都会自动同步，也可以针对某一个RBD image进行mirror，此时只会同步该指定的image，接下来以mirror pool为例。

首先在31、32节点上创建两个相同的pool:

```
ceph --cluster server-31 osd pool create int32bit-test 64 64
ceph --cluster server-32 osd pool create int32bit-test 64 64
```

开启pool mirror功能:

```
rbd --cluster server-31 mirror pool enable int32bit-test pool
rbd --cluster server-32 mirror pool enable int32bit-test pool
```

分别设置peer集群，即需要同步的目标集群，这里我们设置他们互为peer:

```
rbd --cluster server-31 mirror pool peer add int32bit-test client.admin@server-32
rbd --cluster server-32 mirror pool peer add int32bit-test client.admin@server-31
```

查看peer状态:

```
# rbd -p int32bit-test mirror pool info
Mode: pool
Peers:
  UUID                                 NAME      CLIENT
  068cd9a1-a7ff-4120-8194-88261e37a39a server-32 client.admin
```

在31集群上创建一个rbd image，并在server-32集群上查看是否同步:

```
rbd --cluster server-31 -p int32bit-test create rbd-mirror-test --size 1024
rbd --cluster server-32 -p int32bit-test info rbd-mirror-test
rbd image 'rbd-mirror-test':
        size 1024 MB in 256 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.ada71ca0c5fa
        format: 2
        features: layering, exclusive-lock, object-map, fast-diff, deep-flatten, journaling
        flags:
        journal: ada71ca0c5fa
        mirroring state: enabled
        mirroring global id: 163688ba-52fe-4610-a3d5-eb90c663bd4c
        mirroring primary: false
```

从结果上看，我们在server-31集群上创建的image已经同步到server-32上，并且从info中可以查看mirror信息。其中`mirroring primary`属性标明是否主image，只有primary image才能写，非primary image是只读的，不能进行写操作。通过rbd命令可以把主image降级为非primary image，或者把非primary image提升为prmary image，换句话说，rbd mirror不支持多写模式，只支持主备模式。除此之外，mirror目前只支持1对1，不支持一对多模式,即不能对一个pool或者image同时设置多个peer。

可以使用`rbd mirror image status`命令查看同步状态:

```
[root@server-31 int32bit]# rbd --cluster server-32 mirror image status int32bit-test/rbd-mirror-test
rbd-mirror-test:
  global_id:   163688ba-52fe-4610-a3d5-eb90c663bd4c
  state:       up+syncing
  description: bootstrapping, OPEN_LOCAL_IMAGE
  last_update: 2017-01-24 11:42:37
```

`syncing`表示正在同步，同步完成后状态为`replaying`。也可以通过`rbd mirror pool status`查看整个pool的同步状态:

```
# rbd --cluster server-32 mirror pool status  --verbose int32bit-test
health: OK
images: 5 total
    4 replaying
    1 stopped
    ...
```

当health为OK时，说明所有image同步完成。

### 2.4 关于map操作

当RBD image开启了某些高级特性后，内核可能不支持，因此不能执行rbd map操作，否则出现`RBD image feature set mismatch`错误。

```
# rbd map int32bit-test/mirror-test
rbd: sysfs write failed
RBD image feature set mismatch. You can disable features unsupported by the kernel with "rbd feature disable".
In some cases useful info is found in syslog - try "dmesg | tail" or so.
```

好在从J版本后，RBD支持将RBD image map为本地nbd设备，通过`rbd nbd map`命令即可映射为本地nbd设备。首先需要安装`rbd-nbd`模块:

```
yum install rbd-nbd
```

map image到本地nbd设备:

```
# rbd nbd map int32bit-test/mirror-test
/dev/nbd0
```

安装文件系统后就可以挂载到本地文件系统了:

```
mkfs.ext4 /dev/nbd0
mount /dev/nbd0 /mnt
```

由此解决了无法map的问题。

## 3.Ceph RBD mirror原理介绍

Ceph RBD mirror原理其实和mysql的主从同步原理非常类似，简单地说就是通过日志进行回放(replay)。[Sébastien Han的博客](http://www.sebastien-han.fr/blog/2016/03/28/ceph-jewel-preview-ceph-rbd-mirroring/)描述地非常清楚，有兴趣的读者可以参考下。这里仅简单介绍下。

前面提到RBD mirror必须依赖于journeling特性，且需要额外部署rbd-mirror服务。

![ceph rbd mirror](/img/posts/Ceph-RBD-mirror介绍以及原理分析/ceph-rbd-mirror.png)

rbd-mirror服务负责不同Ceph集群的数据同步，当用户执行IO write操作时（必须写入primary image），首先会尝试写入journal，一旦写入完成会向client发起ACK确认，此时开始执行底层的image写入操作，与此同时rbd-mirror开始根据journal执行回放操作，同步到远端的ceph集群中。如图所示:

![ceph rbd mirror inside](/img/posts/Ceph-RBD-mirror介绍以及原理分析/ceph-rbd-mirror-inside.png)

需要注意的是，一旦同步出现脑裂情况，rbd-mirror将中止同步操作，此时你必须手动决定哪边的image是有用的，然后通过手动执行`rbd mirror image resync`命令恢复同步。

## 4.Ceph RBD mirror在OpenStack上的实践

目前很多用户都会选择使用Ceph作为OpenStack后端存储，对接Glance、Nova以及Cinder服务，甚至使用RGW对接Swift API。目前OpenStack也对异地容灾支持也不太好，可选的多region方案也存在很多问题。OpenStack异地容灾的关键是存储的容灾，即块设备容灾，这些包括了用户的所有虚拟机根磁盘、glance镜像以及cinder数据卷，DRBD是一种策略。如果能够把RBD mirror应用到OpenStack中，或许能够解决异地容灾问题。

OpenStack后端开启mirror功能，并不需要额外修改OpenStack的配置，只需要部署rbd-mirror服务并对OpenStack使用的pool开启mirror功能即可。

![openstack multisite ceph no regions](/img/posts/Ceph-RBD-mirror介绍以及原理分析/openstack-multisite-ceph-no-regions.png)

## 参考文献

1. [docs: rbd-mirroring](http://docs.ceph.com/docs/jewel/rbd/rbd-mirroring/).
2. [ceph jewel preview: ceph rbd mirroring](http://www.sebastien-han.fr/blog/2016/03/28/ceph-jewel-preview-ceph-rbd-mirroring).
