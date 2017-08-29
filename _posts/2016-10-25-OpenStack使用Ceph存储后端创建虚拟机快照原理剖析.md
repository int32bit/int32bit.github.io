---
layout: post
title: OpenStack使用Ceph存储后端创建虚拟机快照原理剖析
subtitle: OpenStack源码分析系列
catalog: true
tags: [Ceph, OpenStack]
---

## 1.背景知识

### 1.1 Ceph基础知识

Ceph是一个开源的统一分布式存储系统，最初由Sage Weill于2007年开发，其目标是设计基于POSIX的无单点故障的分布式存储系统，同时提了统一存储系统下的高可扩展的对象存储、块存储以及文件系统存储。其中rbd块存储目前最常见的应用场景之一是作为OpenStack的共享分布式存储后端，为OpenStack计算服务Nova、镜像服务Glance以及块存储服务Cinder提供共享的统一存储服务。RBD官方描述为：

> RBD : Ceph’s RADOS Block Devices , Ceph block devices are thin-provisioned, resizable and store data striped over multiple OSDs in a Ceph cluster.

Ceph RBD的其中的一个优点是支持thin-provisioned，即当创建了一个100GB的image时，并不会立即占用100GB（若副本数为3，则应该为300GB)磁盘空间，而是当我们写入数据时动态分配磁盘空间，这类似于Linux系统的[sparse文件](https://zh.wikipedia.org/wiki/%E7%A8%80%E7%96%8F%E6%96%87%E4%BB%B6)。

rbd image还支持快照功能，通过快照保存image当前状态，方便备份和回滚操作。其中的一个高级特性是rbd还支持基于COW技术的分层快照，使rbd能够快速、简便地clone镜像，其原理类似Docker Image，即从原来的镜像克隆一个新镜像时是基于原来镜像的只读快照（protected snapshot），原来的镜像称为parent image，克隆的新镜像属性（如镜像大小）和原来的镜像一样，但其实它最开始是完全空的，共享父镜像的所有对象，自身不占用任何存储空间。

克隆的新镜像是一个可读写层，当访问一个对象时，若在该层中访问的对象不存在，则往parent image中查找直到遍历到base image。更新一个对象时，不能直接修改parent image的对象，而必须先从parent image中拷贝到自己的image中，然后修改自己镜像的对象。

显然，克隆的镜像和原来的镜像是有层级依赖的，因此不允许修改parent image（这也是原来的镜像快照必须protect的原因），也不允许删除parent image。克隆出来的镜像需要保存对parent image的引用。要从子克隆镜像中删除这些到父快照的引用，需要合并所有的父镜像，即flatten操作。这类似于Qcow2镜像的commit操作。flatten操作会拷贝所有父镜像的对象到自己的image中，这会耗费大量的网络IO，取决于image大小以及和父镜像的差量大小，通常需要花费数分钟的时间。flatten后的image不再与父镜像共享对象，因此占用的存储空间大幅度增大。

### 1.2 OpenStack创建虚拟机镜像过程

当Openstac存储后端使用本地文件系统并且不共享存储时，第一次启动虚拟机时计算节点没有需要的镜像，需要从glance仓库中拷贝镜像到本地，网络IO开销巨大，通常需要数分钟才能完成镜像的完全拷贝，因此启动虚拟机通常需要花费数分钟的时间。如果使用Qcow2镜像格式，创建快照时需要commit当前镜像与base镜像合并并且上传到Glance中，这个过程也通常需要花费数分钟的时间。

而当Glance、Nova使用Ceph做存储后端时，虚拟机镜像和根磁盘都是Ceph RBD image。由于使用共享分布式存储，启动虚拟机时不需要从Glance里全量拷贝镜像到计算节点，而只需要从原来的镜像中clone一个新的镜像。RBD image clone使用了COW技术，即写时拷贝，克隆操作并不会立即复制所有的对象，而只有当需要写入对象时才从parent image中拷贝对象到当前image中。因此，创建虚拟机几乎能够在秒级完成。

总结下使用Ceph做存储后端创建虚拟机时镜像操作过程如下：

#### 1.2.1 上传镜像到Glance

此步骤相当于import image到RBD中：

```
rbd import xxxx.raw --new-format --order 22 --image 1b364055-e323-4785-8e94-ebef1553a33b
```

以上`1b364055-e323-4785-8e94-ebef1553a33b`为glance image uuid。

**注意Glance使用Ceph RBD做存储后端时，镜像必须为raw格式，否则启动虚拟机时需要先在计算节点下载镜像到本地，并转为为raw格式，这开销非常大。**

### 1.2.2 创建镜像快照

由于RBD image clone必须基于只读快照，因此上传镜像完成时还需要创建对应image snapshot(默认快照名为`snap`)并protect，即只允许读操作，不允许写操作。

```
rbd snap create 1b364055-e323-4785-8e94-ebef1553a33b@snap
rbd snap protect 1b364055-e323-4785-8e94-ebef1553a33b@snap
```

### 1.2.3 创建虚拟机根磁盘

创建虚拟机时，直接从glance镜像的快照中clone一个新的RBD image作为虚拟机根磁盘:

```
rbd clone 1b364055-e323-4785-8e94-ebef1553a33b@snap fe4c108a-7ba0-4238-9953-15a7b389e43a_disk
```

其中fe4c108a-7ba0-4238-9953-15a7b389e43a为虚拟机uuid。

### 1.2.4 启动虚拟机

启动虚拟机时指定刚刚创建的根磁盘，由于libvirt支持直接读写rbd镜像，因此不需要任何下载、导出工作。启动虚拟机的xml文件对应的disk字段为:

```
<disk type='network' device='disk'>
      <driver name='qemu' type='raw' cache='writeback'/>
      <auth username='admin'>
        <secret type='ceph' uuid='bdf77f5d-bf0b-1053-5f56-cd76b32520dc'/>
      </auth>
      <source protocol='rbd' name='pool-033b93bd9fea48e398ae395d4d7eeba5/fe4c108a-7ba0-4238-9953-15a7b389e43a_disk'>
        <host name='10.10.0.21' port='6789'/>
      </source>
      <backingStore/>
      <target dev='vda' bus='virtio'/>
      <alias name='virtio-disk0'/>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x04' function='0x0'/>
</disk>
```

以上分析了使用Ceph做OpenStack存储后端启动虚拟机的原理并阐述了为什么能够在秒级内创建虚拟机的原因。但是即使创建虚拟机能够秒级完成，当我们创建虚拟机快照时却往往需要花费数分钟的时间。为了弄清楚为什么创建虚拟机快照这么慢，需要深入研究创建虚拟机快照的原理，完成了哪些工作。本文接下来将从源码入手，分析创建虚拟机快照的过程。

## 2. 源码分析

创建虚拟机快照的实现在`nova/compute/manager.py`的`snapshot_instance`方法，如果不了解OpenStack项目源码结构可以参考[如何优雅的阅读openstack源代码?](https://www.zhihu.com/question/50040895/answer/119633695)。该方法更新task state后调用了`_snapshot_instance`方法后:

```python
 def _snapshot_instance(self, context, image_id, instance,
                           expected_task_state):
   ...
   self.driver.snapshot(context, instance, image_id,update_task_state)
   ...
```

该方法最终通过调用driver的snapshot方法完成虚拟机的快照。由于我们使用的`LibvirtDriver`，因此直接查看`nova/virt/libvirt/driver.py`的snapshot实现.该方法与快照相关的核心代码为：

```python
snapshot_backend = self.image_backend.snapshot(instance,
                disk_path,
                image_type=source_type)
   
# 如果image backend实现了direct_snapshot方法，则调用该方法创建快照   
metadata['location'] = snapshot_backend.direct_snapshot(
                context, snapshot_name, image_format, image_id,
                instance.image_ref)
```

以上先根据image type获取image backend，使用Ceph作为存储后端时，image type为rbd，`self.image_backend`在`LibvirtDriver`构造方法中完成初始化:

```
self.image_backend = imagebackend.Backend(CONF.use_cow_images)
```

`imagebackend.Backend`类在`imagebackend.py`中定义：

```
class Backend(object):
    def __init__(self, use_cow):
        self.BACKEND = {
            'raw': Flat,
            'flat': Flat,
            'qcow2': Qcow2,
            'lvm': Lvm,
            'rbd': Rbd,
            'ploop': Ploop,
            'default': Qcow2 if use_cow else Flat
        }
        
     def backend(self, image_type=None):
        if not image_type:
            image_type = CONF.libvirt.images_type
        image = self.BACKEND.get(image_type)
        if not image:
            raise RuntimeError(_('Unknown image_type=%s') % image_type)
        return image
        
     def snapshot(self, instance, disk_path, image_type=None):
        """Returns snapshot for given image

        :path: path to image
        :image_type: type of image
        """
        backend = self.backend(image_type)
        return backend(instance=instance, path=disk_path)
```

因此上述`self.image_backend.snapshot`最终返回的是Rbd实例，该类同样在imagebackend.py中定义，我们发现目前RBD类是唯一实现了`direct_snapshot`方法的Image backend，其它的诸如Qcow2、Lvm均未实现。

分析Rbd image backend中`direct_snapshot`方法的实现,这是最为关键的部分:

```
def direct_snapshot(self, context, snapshot_name, image_format,
                        image_id, base_image_id):
        """Creates an RBD snapshot directly.
        """
        fsid = self.driver.get_fsid()
        self.driver.create_snap(self.rbd_name, snapshot_name, protect=True)
        location = {'url': 'rbd://%(fsid)s/%(pool)s/%(image)s/%(snap)s' %
                           dict(fsid=fsid,
                                pool=self.pool,
                                image=self.rbd_name,
                                snap=snapshot_name)}
        try:
            self.driver.clone(location, image_id, dest_pool=parent_pool)
            # Flatten the image, which detaches it from the source snapshot
            self.driver.flatten(image_id, pool=parent_pool)
        finally:
            # all done with the source snapshot, clean it up
            self.cleanup_direct_snapshot(location)

        self.driver.create_snap(image_id, 'snap', pool=parent_pool,
                                protect=True)
        return ('rbd://%(fsid)s/%(pool)s/%(image)s/snap' %
                dict(fsid=fsid, pool=parent_pool, image=image_id))
```

从以上代码分析，创建快照主要包括以下几个步骤:

### 2.1  获取ceph fsid

相当于：

```bash
ceph -s | awk '/cluster/ {print $2}'
```

### 2.2 创建rbd image快照并protect

相当于:

```
rbd snap create pool-xx/server_uuid_disk@snapshot_name
rbd snap protect pool-xx/server_uuid_disk@snapshot_name
```

### 2.3 克隆rbd image

相当于:

```
rbd clone pool-xx/server_uuid_disk@snapshot_name pool-yy/image_id
```

### 2.4 flatten rbd image

相当于:

```
rbd flatten pool-yy/image_id
```

### 2.5 删除源image快照

相当于:

```
rbd snap unprotect pool-xx/server_uuid_disk@snapshot_name
rbd snap rm pool-xx/server_uuid_disk@snapshot_name
```

### 2.6 创建新image快照

相当于:

```
rbd snap create pool-yy/image_id@snap
rbd snap protect  pool-yy/image_id@snap
```

从以上分析结果看，创建虚拟机快照时需要先对源镜像image创建快照并且clone，然后flatten操作与原来的镜像独立开来，最后创建新image的快照。整个过程中主要开销在flatten操作，该操作需要和源rbd image合并，如果新image中不存在的对象，则需要从源镜像中拷贝，因此IO开销非常大，花费的时间也较长。

## 3. 一个值得思考的问题

以上分析创建快照时性能瓶颈主要在image的flatten操作，有人可能会问为什么不flatten镜像直接上传clone的新image呢？其实社区也有讨论这个问题，不执行flatten的原因主要有以下两点:

* 当image存在克隆image或者快照时，该image不能删除。这意味着我们创建了虚拟机快照后，虚拟机就不能删除了，这显然不合理。
* 当访问某个对象在该image不存在时，会往其parent image中找，直到遍历到base image。这意味着，如果快照链很长时，image的链也很长，读写性能明显下降。

因此虚拟机快照必须执行flatten操作，从源镜像中解耦。因此虚拟机快照是一个完整image，不依赖于任何image。

## 4. 总结

本文首先介绍了ceph基础知识以及OpenStack创建虚拟机镜像的过程，然后从源码分析了为什么创建虚拟机快照需要花费很长时间的原因，最后讨论了为什么创建虚拟机快照需要flatten操作。
