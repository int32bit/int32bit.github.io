---
layout: post
title: OpenStack使用Ceph存储，Ceph到底做了什么?
catalog: true
tags: [OpenStack, Ceph]
---

## 1 背景知识

### 1.1 Ceph简介

Ceph是当前非常流行的开源分布式存储系统，具有高扩展性、高性能、高可靠性等优点，同时提供块存储服务(rbd)、对象存储服务(rgw)以及文件系统存储服务(cephfs)。目前也是OpenStack的主流后端存储，和OpenStack亲如兄弟，为OpenStack提供统一共享存储服务。使用Ceph作为OpenStack后端存储，具有如下优点：

* 所有的计算节点共享存储，迁移时不需要拷贝根磁盘，即使计算节点挂了，也能立即在另一个计算节点启动虚拟机（evacuate）。
* 利用COW（Copy On Write)特性，创建虚拟机时，只需要基于镜像clone即可，不需要下载整个镜像，而clone操作基本是0开销，从而实现了秒级创建虚拟机。
* Ceph RBD支持thin provisioning，即按需分配空间，有点类似Linux文件系统的sparse稀疏文件。创建一个20GB的虚拟硬盘时，最开始并不占用物理存储空间，只有当写入数据时，才按需分配存储空间。

Ceph的更多知识可以参考[官方文档](http://ceph.com/)，这里我们只关注RBD，RBD管理的核心对象为块设备(block device)，通常我们称为volume，不过Ceph中习惯称之为image（注意和OpenStack image的区别）。Ceph中还有一个pool的概念，类似于namespace，不同的pool可以定义不同的副本数、pg数、放置策略等。每个image都必须指定pool。image的命名规范为`pool_name/image_name@snapshot`，比如`openstack/test-volume@test-snap`，表示在`openstack`pool中`test-volume`image的快照`test-snap`。因此以下两个命令效果是等同的:

```
rbd snap create --pool openstack --image test-image --snap test-snap
rbd snap create openstack/test-image@test-snap
```

在`openstack` pool上创建一个1G的image命令为:

```
rbd -p openstack create --size 1024 int32bit-test-1
```

image支持快照(snapshot)的功能，创建一个快照即保存当前image的状态，相当于`git commit`操作，用户可以随时把image回滚到任意快照点上(`git reset`)。创建快照命令如下:

```sh
rbd -p openstack snap create int32bit-test-1@snap-1
```

查看rbd列表:

```
$ rbd -p openstack ls -l | grep int32bit-test
int32bit-test-1        1024M 2
int32bit-test-1@snap-1 1024M 2
```

基于快照可以创建一个新的image，称为clone，clone不会立即复制原来的image，而是使用COW策略，即写时拷贝，只有当需要写入一个对象时，才从parent中拷贝那个对象到本地，因此clone操作基本秒级完成，并且需要注意的是基于同一个快照创建的所有image共享快照之前的image数据，因此在clone之前我们必须保护(protect)快照，被保护的快照不允许删除。clone操作类似于`git branch`操作，clone一个image命令如下:

```sh
rbd -p openstack snap protect int32bit-test-1@snap-1
rbd -p openstack clone int32bit-test-1@snap-1 int32bit-test-2
```

我们可以查看一个image的子image(children)有哪些，也能查看一个image是基于哪个image clone的(parent)：

```
$ rbd -p openstack children int32bit-test-1@snap-1
openstack/int32bit-test-2
$ rbd -p openstack info int32bit-test-2 | grep parent
parent: openstack/int32bit-test-1@snap-1
```

以上我们可以发现`int32bit-test-2`是`int32bit-test-1`的children，而`int32bit-test-1`是`int32bit-test-2`的parent。

不断地创建快照并clone image，就会形成一条很长的image链，链很长时，不仅会影响读写性能，还会导致管理非常麻烦。可幸的是Ceph支持合并链上的所有image为一个独立的image，这个操作称为`flatten`，类似于`git merge`操作，`flatten`需要一层一层拷贝所有顶层不存在的数据，因此通常会非常耗时。

```
$ rbd -p openstack flatten int32bit-test-2
Image flatten: 31% complete...
```

此时我们再次查看其parrent-children关系:

```
rbd -p openstack children int32bit-test-1@snap-1
```

此时`int32bit-test-1`没有children了，`int32bit-test-2`完全独立了。

当然Ceph也支持完全拷贝，称为`copy`：

```
rbd -p openstack cp int32bit-test-1 int32bit-test-3
```

`copy`会完全拷贝一个image，因此会非常耗时，但注意`copy`不会拷贝原来的快照信息。

Ceph支持将一个RBD image导出(`export`):

```
rbd -p openstack export int32bit-test-1 int32bit-1.raw
```

导出会把整个image导出，Ceph还支持差量导出(export-diff)，即指定从某个快照点开始导出：

```
rbd -p openstack export-diff int32bit-test-1 --from-snap snap-1 --snap snap-2 int32bit-test-1-diff.raw
```

以上导出从快照点`snap-1`到快照点`snap-2`的数据。

当然与之相反的操作为`import`以及`import-diff`。通过`export`/`import`支持image的全量备份，而`export-diff`/`import-diff`实现了image的差量备份。

Rbd image是动态分配存储空间，通过`du`命令可以查看image实际占用的物理存储空间:

```
$ rbd du int32bit-test-1
NAME            PROVISIONED   USED
int32bit-test-1       1024M 12288k
```

以上image分配的大小为1024M，实际占用的空间为12288KB。

删除image，注意必须先删除其所有快照，并且保证没有依赖的children:

```
rbd -p openstack snap unprotect int32bit-test-1@snap-1
rbd -p openstack snap rm int32bit-test-1@snap-1
rbd -p openstack rm int32bit-test-1
```

### 1.2 OpenStack简介

OpenStack是一个IaaS层的云计算平台开源实现，关于OpenStack的更多介绍欢迎访问我的个人博客，这里只专注于当OpenStack对接Ceph存储系统时，基于源码分析一步步探测Ceph到底做了些什么工作。本文不会详细介绍OpenStack的整个工作流程，而只关心与Ceph相关的实现，如果有不清楚OpenStack源码架构的，可以参考我之前写的文章[如何阅读OpenStack源码](https://zhuanlan.zhihu.com/p/28959724)。

阅读完本文可以理解以下几个问题:

1. 为什么上传的镜像必须要转化为raw格式?
2. 如何高效上传一个大的镜像文件?
3. 为什么能够实现秒级创建虚拟机？
4. 为什么创建虚拟机快照需要数分钟时间，而创建volume快照能够秒级完成？
5. 为什么当有虚拟机存在时，不能删除镜像?
6. 为什么一定要把备份恢复到一个空卷中，而不能覆盖已经存在的volume？
7. 从镜像中创建volume，能否删除镜像?

注意本文都是在基于使用Ceph存储的前提下，即Glance、Nova、Cinder都是使用的Ceph，其它情况下结论不一定成立。

另外本文会先贴源代码，很长很枯燥，你可以快速跳到[总结部分](## 5 总结)查看OpenStack各个操作对应的Ceph工作。

## 2 Glance

### 2.1 Glance介绍

**Glance管理的核心实体是image**，它是OpenStack的核心组件之一，为OpenStack提供镜像服务(Image as Service)，主要负责OpenStack镜像以及镜像元数据的生命周期管理、检索、下载等功能。Glance支持将镜像保存到多种存储系统中，后端存储系统称为store，访问镜像的地址称为location，location可以是一个http地址，也可以是一个rbd协议地址。只要实现store的driver就可以作为Glance的存储后端，其中driver的主要接口如下:

* get: 获取镜像的location。
* get_size: 获取镜像的大小。
* get_schemes: 获取访问镜像的URL前缀(协议部分)，比如rbd、swift+https、http等。
* add: 上传镜像到后端存储中。
* delete: 删除镜像。
* set_acls: 设置后端存储的读写访问权限。

为了便于维护，glance store目前已经作为独立的库从Glance代码中分离出来，由项目[glance_store](https://github.com/openstack/glance_store)维护。目前社区支持的store列表如下:

* filesystem: 保存到本地文件系统，默认保存`/var/lib/glance/images`到目录下。
* cinder: 保存到Cinder中。
* rbd：保存到Ceph中。
* sheepdog：保存到sheepdog中。
* swift: 保存到Swift对象存储中。
* vmware datastore: 保存到Vmware datastore中。
* http: 以上的所有store都会保存镜像数据，唯独http store比较特殊，它不保存镜像的任何数据，因此没有实现`add`方法，它仅仅保存镜像的URL地址，启动虚拟机时由计算节点从指定的http地址中下载镜像。

本文主要关注rbd store，它的源码在[这里](https://github.com/openstack/glance_store/blob/master/glance_store/_drivers/rbd.py)，该store的driver代码主要由国内[Fei Long Wang](flwang%40catalyst.net.nz)负责维护，其它store的实现细节可以参考源码[glance store drivers](https://github.com/openstack/glance_store/tree/master/glance_store/_drivers).

### 2.2 镜像上传

由前面的介绍可知，镜像上传主要由store的`add`方法实现：

```python
@capabilities.check
def add(self, image_id, image_file, image_size, context=None,
        verifier=None):
    checksum = hashlib.md5()
    image_name = str(image_id)
    with self.get_connection(conffile=self.conf_file,
                             rados_id=self.user) as conn:
        fsid = None
        if hasattr(conn, 'get_fsid'):
            fsid = conn.get_fsid()
        with conn.open_ioctx(self.pool) as ioctx:
            order = int(math.log(self.WRITE_CHUNKSIZE, 2))
            try:
                loc = self._create_image(fsid, conn, ioctx, image_name,
                                         image_size, order)
            except rbd.ImageExists:
                msg = _('RBD image %s already exists') % image_id
                raise exceptions.Duplicate(message=msg)
                ...
```

其中注意`image_file`不是一个文件，而是`LimitingReader`实例，该实例保存了镜像的所有数据，通过`read(bytes)`方法读取镜像内容。

从以上源码中看，glance首先获取ceph的连接session，然后调用`_create_image`方法创建了一个rbd image，大小和镜像的size一样:

```python
def _create_image(self, fsid, conn, ioctx, image_name,
                  size, order, context=None):
    librbd = rbd.RBD()
    features = conn.conf_get('rbd_default_features')
    librbd.create(ioctx, image_name, size, order, old_format=False,
                  features=int(features))
    return StoreLocation({
        'fsid': fsid,
        'pool': self.pool,
        'image': image_name,
        'snapshot': DEFAULT_SNAPNAME,
    }, self.conf)
```

因此以上步骤通过rbd命令表达大致为:

```
rbd -p ${rbd_store_pool} create --size ${image_size} ${image_id}
```

在ceph中创建完rbd image后，接下来：

```python
with rbd.Image(ioctx, image_name) as image:
    bytes_written = 0
    offset = 0
    chunks = utils.chunkreadable(image_file,
                                 self.WRITE_CHUNKSIZE)
    for chunk in chunks:
        offset += image.write(chunk, offset)
        checksum.update(chunk)
```

可见Glance逐块从image_file中读取数据写入到刚刚创建的rbd image中并计算checksum，其中块大小由`rbd_store_chunk_size`配置，默认为8MB。

我们接着看最后步骤:

```python
if loc.snapshot:
    image.create_snap(loc.snapshot)
    image.protect_snap(loc.snapshot)
```

从代码中可以看出，最后步骤为创建image快照（快照名为snap）并保护起来。

假设我们上传的镜像为cirros，镜像大小为39MB，镜像uuid为`d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6`，配置保存在ceph的`openstack` pool中，则对应ceph的操作流程大致为:

```sh
rbd -p openstack create --size 39 d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6
rbd -p openstack snap create d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap
rbd -p openstack snap protect d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap
```

我们可以通过rbd命令验证:

```
int32bit rbd ls -l | grep d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6
d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6      40162k  2
d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap 40162k  2 yes
```

#### 启示

我们前面介绍了镜像上传到Ceph的过程，省略了镜像上传到Glance的流程，但毋容置疑的是镜像肯定是通过Glance API上传到Glance中的。当镜像非常大时，由于通过Glance API走HTTP协议，导致非常耗时且占用API管理网带宽。我们可以通过`rbd import`直接导入镜像的方式大幅度提高上传镜像的效率。

首先使用Glance创建一个空镜像，记下它的uuid:

```
glance image-create
```

假设uuid为`d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6`，使用rbd命令直接导入镜像并创建快照：

```
rbd -p openstack import cirros.raw --image=d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6
rbd -p openstack snap create d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap
rbd -p openstack snap protect d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap
```

设置glance镜像location url:

```sh
FS_ID=`ceph -s | grep cluster | awk '{print $2}'`
glance location-add --url rbd://${FS_ID}/openstack/d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6/snap d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6 
```

设置glance镜像其它属性：

```sh
glance image-update --name="cirros" \
    --disk-format=raw --container-format=bare d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6
```

### 2.3 镜像删除

删除镜像就是相反的过程，即先执行`unprotext` -> `snap rm` -> `rm`，如下:

```python
try:
    self._unprotect_snapshot(image, snapshot_name)
    image.remove_snap(snapshot_name)
except rbd.ImageBusy as exc:
    raise exceptions.InUseByStore()
rbd.RBD().remove(ioctx, image_name)
```

删除镜像必须保证当前rbd image没有子image，否则删除会失败。

## 3 Nova

### 3.1 Nova介绍

**Nova管理的核心实体为server**，为OpenStack提供计算服务，它是OpenStack最核心的组件。注意Nova中的server不只是指虚拟机，它可以是任何计算资源的抽象，除了虚拟机以外，也有可能是baremetal裸机、容器等。

不过我们在这里假定:

* server为虚拟机。
* image type为rbd。
* compute driver为libvirt。

启动虚拟机之前首先需要准备根磁盘(root disk)，Nova称为image，和Glance一样，Nova的image也支持存储到本地磁盘、Ceph以及Cinder(boot from volume)中。需要注意的是，image保存到哪里是通过image type决定的，存储到本地磁盘可以是raw、qcow2、ploop等，如果image type为rbd，则image存储到Ceph中。不同的image type由不同的image backend负责，其中rbd的backend为`nova/virt/libvirt/imageackend`中的`Rbd`类模块实现。

### 3.2 创建虚拟机

创建虚拟机的过程不再详细分析，不清楚的可以查看我之前写的博客，我们直接进入研究Nova的libvirt driver是如何为虚拟机准备根磁盘image的，代码位于`nova/virt/libvirt/driver.py`的`spawn`方法，其中创建image调用了`_create_image`方法。

```python
def spawn(self, context, instance, image_meta, injected_files,
          admin_password, network_info=None, block_device_info=None):
    ...
    self._create_image(context, instance, disk_info['mapping'],
                       injection_info=injection_info,
                       block_device_info=block_device_info)
    ...
```

`_create_image`方法部分代码如下:

```python
def _create_image(self, context, instance,
                  disk_mapping, injection_info=None, suffix='',
                  disk_images=None, block_device_info=None,
                  fallback_from_host=None,
                  ignore_bdi_for_swap=False):
    booted_from_volume = self._is_booted_from_volume(block_device_info)
    ...
    # ensure directories exist and are writable
    fileutils.ensure_tree(libvirt_utils.get_instance_path(instance))
    ...
    self._create_and_inject_local_root(context, instance,
                                       booted_from_volume, suffix,
                                       disk_images, injection_info,
                                       fallback_from_host)
    ...
```

该方法首先在本地创建虚拟机的数据目录`/var/lib/nova/instances/${uuid}/`，然后调用了`_create_and_inject_local_root`方法创建根磁盘。

```python
def _create_and_inject_local_root(self, context, instance,
                                  booted_from_volume, suffix, disk_images,
                                  injection_info, fallback_from_host):
    ...
    if not booted_from_volume:
        root_fname = imagecache.get_cache_fname(disk_images['image_id'])
        size = instance.flavor.root_gb * units.Gi
        backend = self.image_backend.by_name(instance, 'disk' + suffix,
                                             CONF.libvirt.images_type)
        if backend.SUPPORTS_CLONE:
            def clone_fallback_to_fetch(*args, **kwargs):
                try:
                    backend.clone(context, disk_images['image_id'])
                except exception.ImageUnacceptable:
                    libvirt_utils.fetch_image(*args, **kwargs)
            fetch_func = clone_fallback_to_fetch
        else:
            fetch_func = libvirt_utils.fetch_image
        self._try_fetch_image_cache(backend, fetch_func, context,
                                    root_fname, disk_images['image_id'],
                                    instance, size, fallback_from_host)
        ...
```

其中`image_backend.by_name()`方法通过image type名称返回image `backend`实例，这里是`Rbd`。从代码中看出，如果backend支持clone操作(SUPPORTS_CLONE)，则会调用backend的`clone()`方法，否则通过`fetch_image()`方法下载镜像。显然Ceph rbd是支持clone的。我们查看`Rbd`的`clone()`方法，代码位于`nova/virt/libvirt/imagebackend.py`模块:

```python
def clone(self, context, image_id_or_uri):
    ...
    for location in locations:
        if self.driver.is_cloneable(location, image_meta):
            LOG.debug('Selected location: %(loc)s', {'loc': location})
            return self.driver.clone(location, self.rbd_name)
    ...
```

该方法遍历Glance image的所有locations，然后通过`driver.is_cloneable()`方法判断是否支持clone，若支持clone则调用`driver.clone()`方法。其中`driver`是Nova的storage driver，代码位于`nova/virt/libvirt/storage`，其中rbd driver在`rbd_utils.py`模块下，我们首先查看`is_cloneable()`方法:

```python
 def is_cloneable(self, image_location, image_meta):
        url = image_location['url']
        try:
            fsid, pool, image, snapshot = self.parse_url(url)
        except exception.ImageUnacceptable as e:
            return False
        if self.get_fsid() != fsid:
            return False
        if image_meta.get('disk_format') != 'raw':
            return False
        # check that we can read the image
        try:
            return self.exists(image, pool=pool, snapshot=snapshot)
        except rbd.Error as e:
            LOG.debug('Unable to open image %(loc)s: %(err)s',
                      dict(loc=url, err=e))
            return False
```

可见如下情况不支持clone:

1. Glance中的rbd image location不合法，rbd location必须包含fsid、pool、image id，snapshot 4个字段，字段通过`/`划分。
2. Glance和Nova对接的是不同的Ceph集群。
3. **Glance镜像非raw格式。**
4. Glance的rbd image不存在名为`snap`的快照。

其中尤其注意第三条，如果镜像为非raw格式，Nova创建虚拟机时不支持clone操作，因此必须从Glance中下载镜像。这就是为什么Glance使用Ceph存储时，镜像必须转化为raw格式的原因。

最后我们看`clone`方法:

```python
def clone(self, image_location, dest_name, dest_pool=None):
    _fsid, pool, image, snapshot = self.parse_url(
            image_location['url'])
    with RADOSClient(self, str(pool)) as src_client:
        with RADOSClient(self, dest_pool) as dest_client:
            try:
                RbdProxy().clone(src_client.ioctx,
                                 image,
                                 snapshot,
                                 dest_client.ioctx,
                                 str(dest_name),
                                 features=src_client.features)
            except rbd.PermissionError:
                raise exception.Forbidden(_('no write permission on '
                                            'storage pool %s') % dest_pool)
```

该方法只调用了ceph的`clone`方法，可能会有人疑问都是使用同一个Ceph cluster，为什么需要两个`ioctx`？这是因为Glance和Nova可能使用的不是同一个Ceph pool，一个pool对应一个`ioctx`。

以上操作大致相当于如下rbd命令:

```sh
rbd clone ${glance_pool}/${镜像uuid}@snap ${nova_pool}/${虚拟机uuid}.disk
```

假设Nova和Glance使用的pool都是`openstack`，Glance镜像uuid为`d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6`，Nova虚拟机的uuid为`cbf44290-f142-41f8-86e1-d63c902b38ed`，则对应的rbd命令大致为:

```sh
rbd clone \
openstack/d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap \
openstack/cbf44290-f142-41f8-86e1-d63c902b38ed_disk
```

我们进一步验证:

```
int32bit $ rbd -p openstack ls | grep cbf44290-f142-41f8-86e1-d63c902b38ed
cbf44290-f142-41f8-86e1-d63c902b38ed_disk
int32bit $ rbd -p openstack info cbf44290-f142-41f8-86e1-d63c902b38ed_disk
rbd image 'cbf44290-f142-41f8-86e1-d63c902b38ed_disk':
        size 2048 MB in 256 objects
        order 23 (8192 kB objects)
        block_name_prefix: rbd_data.9f756763845e
        format: 2
        features: layering, exclusive-lock, object-map, fast-diff, deep-flatten
        flags:
        create_timestamp: Wed Nov 22 05:11:17 2017
        parent: openstack/d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap
        overlap: 40162 kB
```

由输出可见，Nova确实创建了一个名为`cbf44290-f142-41f8-86e1-d63c902b38ed_disk` rbd image，并且它的parent为`openstack/d1a06da9-8ccd-4d3e-9b63-6dcd3ead29e6@snap`。


#### 启示

1. 创建虚拟机时并没有拷贝镜像，也不需要下载镜像，而是一个简单clone操作，因此创建虚拟机基本可以在秒级完成。
2. 如果镜像中还有虚拟机依赖，则不能删除该镜像，换句话说，删除镜像之前，必须删除基于该镜像创建的所有虚拟机。

### 3.3 创建虚拟机快照

首先说点题外话，我感觉Nova把create image和create snapshot弄混乱了，我理解的这二者的区别:

* create image：把虚拟机的根磁盘上传到Glance中。
* create snapshot: 根据image格式对虚拟机做快照，qcow2和rbd格式显然都支持快照。快照不应该保存到Glance中，由Nova或者Cinder(boot from Cinder)管理。

可事实上，Nova创建快照的子命令为`image-create`，API方法也叫`_action_create_image()`，之后调用的方法叫`snapshot()`。而实际上，对于大多数image type，如果不是从云硬盘启动(boot from volume)，其实就是create image，即上传镜像到Glance中，而非真正的snapshot。

当然只是命名的区别而已，这里对create image和create snapshot不做任何区别。

虚拟机的快照由`libvirt`driver的`snapshot()`方法实现，代码位于`nova/virt/libvirt/driver.py`，核心代码如下:

```python
def snapshot(self, context, instance, image_id, update_task_state):
    ...
    root_disk = self.image_backend.by_libvirt_path(
        instance, disk_path, image_type=source_type)
    try:
        update_task_state(task_state=task_states.IMAGE_UPLOADING,
                          expected_state=task_states.IMAGE_PENDING_UPLOAD)
        metadata['location'] = root_disk.direct_snapshot(
            context, snapshot_name, image_format, image_id,
            instance.image_ref)
        self._snapshot_domain(context, live_snapshot, virt_dom, state,
                              instance)
        self._image_api.update(context, image_id, metadata,
                               purge_props=False)
    except (NotImplementedError, exception.ImageUnacceptable) as e:
        ...
```

Nova首先通过`disk_path`获取对应的image backend，这里返回的是`imagebackend.Rbd`，然后调用了backend的`direct_snapshot()`方法，该方法如下:

```python
def direct_snapshot(self, context, snapshot_name, image_format,
                    image_id, base_image_id):
    fsid = self.driver.get_fsid()
    parent_pool = self._get_parent_pool(context, base_image_id, fsid)

    self.driver.create_snap(self.rbd_name, snapshot_name, protect=True)
    location = {'url': 'rbd://%(fsid)s/%(pool)s/%(image)s/%(snap)s' %
                       dict(fsid=fsid,
                            pool=self.pool,
                            image=self.rbd_name,
                            snap=snapshot_name)}
    try:
        self.driver.clone(location, image_id, dest_pool=parent_pool)
        self.driver.flatten(image_id, pool=parent_pool)
    finally:
        self.cleanup_direct_snapshot(location)
    self.driver.create_snap(image_id, 'snap', pool=parent_pool,
                            protect=True)
    return ('rbd://%(fsid)s/%(pool)s/%(image)s/snap' %
            dict(fsid=fsid, pool=parent_pool, image=image_id))
```

从代码中分析，大体可分为以下几个步骤:

* 获取Ceph集群的fsid。
* 对虚拟机根磁盘对应的rbd image创建一个临时快照，快照名是一个随机uuid。
* 将创建的快照保护起来（protect）。
* 基于快照clone一个新的rbd image，名称为snapshot uuid。
* 对clone的image执行flatten操作。
* 删除创建的临时快照。
* 对clone的rbd image创建快照，快照名为snap，并执行protect。

对应rbd命令，假设虚拟机uuid为`cbf44290-f142-41f8-86e1-d63c902b38ed`，快照的uuid为`db2b6552-394a-42d2-9de8-2295fe2b3180`，则对应rbd命令为:

```sh
# Snapshot the disk and clone it into Glance's storage pool
rbd -p openstack snap create \
cbf44290-f142-41f8-86e1-d63c902b38ed_disk@3437a9bbba5842629cc76e78aa613c70
rbd -p openstack snap protect \
cbf44290-f142-41f8-86e1-d63c902b38ed_disk@3437a9bbba5842629cc76e78aa613c70
rbd -p openstack clone \
cbf44290-f142-41f8-86e1-d63c902b38ed_disk@3437a9bbba5842629cc76e78aa613c70 \
db2b6552-394a-42d2-9de8-2295fe2b3180
# Flatten the image, which detaches it from the source snapshot
rbd -p openstack flatten db2b6552-394a-42d2-9de8-2295fe2b3180
# all done with the source snapshot, clean it up
rbd -p openstack snap unprotect \
cbf44290-f142-41f8-86e1-d63c902b38ed_disk@3437a9bbba5842629cc76e78aa613c70
rbd -p openstack snap rm \
cbf44290-f142-41f8-86e1-d63c902b38ed_disk@3437a9bbba5842629cc76e78aa613c70
# Makes a protected snapshot called 'snap' on uploaded images and hands it out
rbd -p openstack snap create db2b6552-394a-42d2-9de8-2295fe2b3180@snap
rbd -p openstack snap protect db2b6552-394a-42d2-9de8-2295fe2b3180@snap
```

其中`3437a9bbba5842629cc76e78aa613c70`是产生的临时快照名称，它一个随机生成的uuid。

#### 启示

其它存储后端主要耗时会在镜像上传过程，而当使用Ceph存储时，主要耗在rbd的flatten过程，因此创建虚拟机快照通常要好几分钟的时间。有人可能会疑问，为什么一定要执行flatten操作呢，直接clone不就完事了吗？社区这么做是有原因的：

* 如果不执行flatten操作，则虚拟机快照依赖于虚拟机，换句话说，虚拟机只要存在快照就不能删除虚拟机了，这显然不合理。
* 上一个问题继续延展，假设基于快照又创建虚拟机，虚拟机又创建快照，如此反复，整个rbd image的依赖会非常复杂，根本管理不了。
* 当rbd image链越来越长时，对应的IO读写性能也会越来越差。
* ...

### 3.4 删除虚拟机

libvirt driver删除虚拟机的代码位于`nova/virt/libvirt/driver.py`的`destroy`方法:

```python
def destroy(self, context, instance, network_info, block_device_info=None,
                destroy_disks=True):
    self._destroy(instance)
    self.cleanup(context, instance, network_info, block_device_info,
                 destroy_disks)
```

注意前面的`_destroy`方法其实就是虚拟机关机操作，即Nova会首先让虚拟机先关机再执行删除操作。紧接着调用`cleanup()`方法，该方法执行资源的清理工作。这里我们只关注清理disks的过程:

```python
...
if destroy_disks:
    # NOTE(haomai): destroy volumes if needed
    if CONF.libvirt.images_type == 'lvm':
        self._cleanup_lvm(instance, block_device_info)
    if CONF.libvirt.images_type == 'rbd':
        self._cleanup_rbd(instance)
...
```

由于我们的image type为rbd，因此调用的`_cleanup_rbd()`方法:

```python
def _cleanup_rbd(self, instance):
    if instance.task_state == task_states.RESIZE_REVERTING:
        filter_fn = lambda disk: (disk.startswith(instance.uuid) and
                                  disk.endswith('disk.local'))
    else:
        filter_fn = lambda disk: disk.startswith(instance.uuid)
    LibvirtDriver._get_rbd_driver().cleanup_volumes(filter_fn)
```

我们只考虑正常删除操作，忽略resize撤回操作，则`filter_fn`为`lambda disk: disk.startswith(instance.uuid)`，即所有以虚拟机uuid开头的disk(rbd image)。需要注意，这里没有调用`imagebackend`的`Rbd` driver，而是直接调用`storage driver`，代码位于`nova/virt/libvirt/storage/rbd_utils.py`:

```python
def cleanup_volumes(self, filter_fn):
    with RADOSClient(self, self.pool) as client:
        volumes = RbdProxy().list(client.ioctx)
        for volume in filter(filter_fn, volumes):
            self._destroy_volume(client, volume)
```

该方法首先获取所有的rbd image列表，然后通过`filter_fn`方法过滤以虚拟机uuid开头的image，调用`_destroy_volume`方法:

```python
def _destroy_volume(self, client, volume, pool=None):
    """Destroy an RBD volume, retrying as needed.
    """
    def _cleanup_vol(ioctx, volume, retryctx):
        try:
            RbdProxy().remove(ioctx, volume)
            raise loopingcall.LoopingCallDone(retvalue=False)
        except rbd.ImageHasSnapshots:
            self.remove_snap(volume, libvirt_utils.RESIZE_SNAPSHOT_NAME,
                             ignore_errors=True)
        except (rbd.ImageBusy, rbd.ImageHasSnapshots):
            LOG.warning('rbd remove %(volume)s in pool %(pool)s failed',
                        {'volume': volume, 'pool': self.pool})
        retryctx['retries'] -= 1
        if retryctx['retries'] <= 0:
            raise loopingcall.LoopingCallDone()

    # NOTE(danms): We let it go for ten seconds
    retryctx = {'retries': 10}
    timer = loopingcall.FixedIntervalLoopingCall(
        _cleanup_vol, client.ioctx, volume, retryctx)
    timed_out = timer.start(interval=1).wait()
    if timed_out:
        # NOTE(danms): Run this again to propagate the error, but
        # if it succeeds, don't raise the loopingcall exception
        try:
            _cleanup_vol(client.ioctx, volume, retryctx)
        except loopingcall.LoopingCallDone:
            pass
```

该方法最多会尝试10+1次`_cleanup_vol()`方法删除rbd image，如果有快照，则会先删除快照。

假设虚拟机的uuid为`cbf44290-f142-41f8-86e1-d63c902b38ed`，则对应rbd命令大致为:

```sh
for image in $(rbd -p openstack ls | grep '^cbf44290-f142-41f8-86e1-d63c902b38ed');
do
    rbd -p openstack rm "$image";
done
```

## 4 Cinder

### 4.1 Cinder介绍

Cinder是OpenStack的块存储服务，类似AWS的EBS，管理的实体为volume。Cinder并没有实现volume provide功能，而是负责管理各种存储系统的volume，比如Ceph、fujitsu、netapp等，支持volume的创建、快照、备份等功能，对接的存储系统我们称为backend。只要实现了`cinder/volume/driver.py`中`VolumeDriver`类定义的接口，Cinder就可以对接该存储系统。

Cinder不仅支持本地volume的管理，还能把本地volume备份到远端存储系统中，比如备份到另一个Ceph集群或者Swift对象存储系统中，本文将只考虑从源Ceph集群备份到远端Ceph集群中的情况。

### 4.2 创建volume

创建volume由cinder-volume服务完成，入口为`cinder/volume/manager.py`的`create_volume()`方法，

```python
def create_volume(self, context, volume, request_spec=None,
                  filter_properties=None, allow_reschedule=True):
    ...              
    try:
        # NOTE(flaper87): Driver initialization is
        # verified by the task itself.
        flow_engine = create_volume.get_flow(
            context_elevated,
            self,
            self.db,
            self.driver,
            self.scheduler_rpcapi,
            self.host,
            volume,
            allow_reschedule,
            context,
            request_spec,
            filter_properties,
            image_volume_cache=self.image_volume_cache,
        )
    except Exception:
        msg = _("Create manager volume flow failed.")
        LOG.exception(msg, resource={'type': 'volume', 'id': volume.id})
        raise exception.CinderException(msg)
...        
```

Cinder创建volume的流程使用了[taskflow框架](https://docs.openstack.org/taskflow/latest/)，taskflow具体实现位于`cinder/volume/flows/manager/create_volume.py`，我们关注其`execute()`方法:

```python
def execute(self, context, volume, volume_spec):
    ...
    if create_type == 'raw':
        model_update = self._create_raw_volume(volume, **volume_spec)
    elif create_type == 'snap':
        model_update = self._create_from_snapshot(context, volume,
                                                  **volume_spec)
    elif create_type == 'source_vol':
        model_update = self._create_from_source_volume(
            context, volume, **volume_spec)
    elif create_type == 'image':
        model_update = self._create_from_image(context,
                                               volume,
                                               **volume_spec)
    else:
        raise exception.VolumeTypeNotFound(volume_type_id=create_type)
    ...    
```

从代码中我们可以看出，创建volume分为4种类型：

* raw: 创建空白卷。
* create from snapshot: 基于快照创建volume。
* create from volume: 相当于复制一个已存在的volume。
* create from image: 基于Glance image创建一个volume。

#### raw

创建空白卷是最简单的方式，代码如下:

```python
def _create_raw_volume(self, volume, **kwargs):
    ret = self.driver.create_volume(volume)
    ...
```

直接调用driver的`create_volume()`方法，这里driver是`RBDDriver`，代码位于`cinder/volume/drivers/rbd.py`:

```python
def create_volume(self, volume):
    with RADOSClient(self) as client:
        self.RBDProxy().create(client.ioctx,
                               vol_name,
                               size,
                               order,
                               old_format=False,
                               features=client.features)

        try:
            volume_update = self._enable_replication_if_needed(volume)
        except Exception:
            self.RBDProxy().remove(client.ioctx, vol_name)
            err_msg = (_('Failed to enable image replication'))
            raise exception.ReplicationError(reason=err_msg,
                                             volume_id=volume.id)
```

其中`size`单位为MB，`vol_name`为`volume-${volume_uuid}`。

假设volume的uuid为`bf2d1c54-6c98-4a78-9c20-3e8ea033c3db`，Ceph池为`openstack`，创建的volume大小为1GB，则对应的rbd命令相当于:

```
rbd -p openstack create \
--new-format --size 1024 \
volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db
```

我们可以通过rbd命令验证:

```
int32bit $ rbd -p openstack ls | grep bf2d1c54-6c98-4a78-9c20-3e8ea033c3db
volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db
```

#### create from snapshot

从快照中创建volume也是直接调用driver的方法，如下:

```
def _create_from_snapshot(self, context, volume, snapshot_id,
                          **kwargs):
    snapshot = objects.Snapshot.get_by_id(context, snapshot_id)
    model_update = self.driver.create_volume_from_snapshot(volume,
                                                           snapshot)
```

我们查看`RBDDriver`的`create_volume_from_snapshot()`方法:

```python
def create_volume_from_snapshot(self, volume, snapshot):
    """Creates a volume from a snapshot."""
    volume_update = self._clone(volume, self.configuration.rbd_pool,
                                snapshot.volume_name, snapshot.name)
    if self.configuration.rbd_flatten_volume_from_snapshot:
        self._flatten(self.configuration.rbd_pool, volume.name)
    if int(volume.size):
        self._resize(volume)
    return volume_update
```

从代码中看出，从snapshot中创建快照分为3个步骤:

* 从rbd快照中执行clone操作。
* 如果`rbd_flatten_volume_from_snapshot`配置为`True`，则执行`flatten`操作。
* 如果创建中指定了`size`，则执行`resize`操作。

假设新创建的volume的uuid为`e6bc8618-879b-4655-aac0-05e5a1ce0e06`，快照的uuid为`snapshot-e4e534fc-420b-45c6-8e9f-b23dcfcb7f86`，快照的源volume uuid为`bf2d1c54-6c98-4a78-9c20-3e8ea033c3db`，指定的size为2，`rbd_flatten_volume_from_snapshot`为`False`（默认值)，则对应的rbd命令为:

```sh
rbd clone openstack/volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db@snapshot-e4e534fc-420b-45c6-8e9f-b23dcfcb7f86 openstack/volume-e6bc8618-879b-4655-aac0-05e5a1ce0e06
rbd resize --size 2048 openstack/volume-e6bc8618-879b-4655-aac0-05e5a1ce0e06
```

从源码上分析，Cinder从快照中创建volume时，用户可以配置是否执行flatten操作：

* 如果执行flatten操作，则从快照中创建volume可能需要数分钟的时间，创建后可以随时删除快照。
* 如果不执行flatten操作，则需要注意在删除所有基于该快照创建的volume之前，不能删除该快照，也不能删除快照的源volume。

第二点可能会更复杂，比如基于快照创建了一个volume，然后基于该volume又创建了快照，基于该快照创建了volume，则用户不能删除源volume，不能删除快照。

#### create from volume

从volume中创建volume，需要指定源volume id(`source_volid`):

```python
def _create_from_source_volume(self, context, volume, source_volid,
                               **kwargs):
    # NOTE(harlowja): if the source volume has disappeared this will be our
    # detection of that since this database call should fail.
    #
    # NOTE(harlowja): likely this is not the best place for this to happen
    # and we should have proper locks on the source volume while actions
    # that use the source volume are underway.
    srcvol_ref = objects.Volume.get_by_id(context, source_volid)
    model_update = self.driver.create_cloned_volume(volume, srcvol_ref)
```

我们直接查看driver的`create_cloned_volume()`方法，该方法中有一个很重要的配置项`rbd_max_clone_depth`，即允许rbd image clone允许的最长深度，如果`rbd_max_clone_depth <= 0`，则表示不允许clone:

```python
# Do full copy if requested
if self.configuration.rbd_max_clone_depth <= 0:
    with RBDVolumeProxy(self, src_name, read_only=True) as vol:
        vol.copy(vol.ioctx, dest_name)
        self._extend_if_required(volume, src_vref)
    return
```

此时相当于rbd的copy命令。

如果`rbd_max_clone_depth > 0`:

```python
# Otherwise do COW clone.
with RADOSClient(self) as client:
    src_volume = self.rbd.Image(client.ioctx, src_name)
    LOG.debug("creating snapshot='%s'", clone_snap)
    try:
        # Create new snapshot of source volume
        src_volume.create_snap(clone_snap)
        src_volume.protect_snap(clone_snap)
        # Now clone source volume snapshot
        LOG.debug("cloning '%(src_vol)s@%(src_snap)s' to "
                  "'%(dest)s'",
                  {'src_vol': src_name, 'src_snap': clone_snap,
                   'dest': dest_name})
        self.RBDProxy().clone(client.ioctx, src_name, clone_snap,
                              client.ioctx, dest_name,
                              features=client.features)
```

这个过程和创建虚拟机快照非常相似，二者都是先基于源image创建snapshot，然后基于snapshot执行clone操作，区别在于是否执行flatten操作，创建虚拟机快照时一定会执行flatten操作，而该操作则取决于clone深度:

```python
depth = self._get_clone_depth(client, src_name)
if depth >= self.configuration.rbd_max_clone_depth:
        dest_volume = self.rbd.Image(client.ioctx, dest_name)
        try:
            dest_volume.flatten()
        except Exception as e:
            ...

        try:
            src_volume.unprotect_snap(clone_snap)
            src_volume.remove_snap(clone_snap)
        except Exception as e:
            ...           
```

如果当前depth超过了允许的最大深度`rbd_max_clone_depth`则执行flatten操作，并删除创建的快照。

假设创建的volume uuid为`3b8b15a4-3020-41a0-80be-afaa35ed5eef`，源volume uuid为`bf2d1c54-6c98-4a78-9c20-3e8ea033c3db`，则对应的rbd命令为:

```sh
VOLID=3b8b15a4-3020-41a0-80be-afaa35ed5eef
SOURCE_VOLID=bf2d1c54-6c98-4a78-9c20-3e8ea033c3db
CINDER_POOL=openstack
# Do full copy if rbd_max_clone_depth <= 0.
if [[ "$rbd_max_clone_depth" -le 0 ]]; then
    rbd copy ${CINDER_POOL}/volume-${SOURCE_VOLID} openstack/volume-${VOLID}
    exit 0
fi
# Otherwise do COW clone.
# Create new snapshot of source volume
rbd snap create ${CINDER_POOL}/volume-${SOURCE_VOLID}@volume-${VOLID}.clone_snap
rbd snap protect ${CINDER_POOL}/volume-${SOURCE_VOLID}@volume-${VOLID}.clone_snap
# Now clone source volume snapshot
rbd clone \
${CINDER_POOL}/volume-${SOURCE_VOLID}@volume-${VOLID}.clone_snap \
${CINDER_POOL}/volume-${VOLID}
# If dest volume is a clone and rbd_max_clone_depth reached,
# flatten the dest after cloning.
depth=$(get_clone_depth ${CINDER_POOL}/volume-${VOLID})
if [[ "$depth" -ge "$rbd_max_clone_depth" ]]; then
    # Flatten destination volume
    rbd flatten ${CINDER_POOL}/volume-${VOLID}
    # remove temporary snap
    rbd snap unprotect \
    ${CINDER_POOL}/volume-${SOURCE_VOLID}@volume-${VOLID}.clone_snap
    rbd snap rm ${CINDER_POOL}/volume-${SOURCE_VOLID}@volume-${VOLID}.clone_snap
fi
```

当`rbd_max_clone_depth > 0`且`depth < rbd_max_clone_depth`时，通过rbd命令验证:

```
int32bit $ rbd info volume-3b8b15a4-3020-41a0-80be-afaa35ed5eef
rbd image 'volume-3b8b15a4-3020-41a0-80be-afaa35ed5eef':
        size 1024 MB in 256 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.ae2e437c177a
        format: 2
        features: layering, exclusive-lock, object-map, fast-diff, deep-flatten
        flags:
        create_timestamp: Wed Nov 22 12:32:09 2017
        parent: openstack/volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db@volume-3b8b15a4-3020-41a0-80be-afaa35ed5eef.clone_snap
        overlap: 1024 MB
```

可见`volume-3b8b15a4-3020-41a0-80be-afaa35ed5eef`的parent为:

```
volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db@volume-3b8b15a4-3020-41a0-80be-afaa35ed5eef.clone_snap`
```

#### create from image

从镜像中创建volume，这里假定Glance和Cinder都使用的同一个Ceph集群，则Cinder可以直接从Glance中clone，不需要下载镜像:

```python
def _create_from_image(self, context, volume,
                       image_location, image_id, image_meta,
                       image_service, **kwargs):
    ...
    model_update, cloned = self.driver.clone_image(
        context,
        volume,
        image_location,
        image_meta,
        image_service)
   ...
```

我们查看driver的`clone_image()`方法：

```python
def clone_image(self, context, volume,
                image_location, image_meta,
                image_service):
    # iterate all locations to look for a cloneable one.
    for url_location in url_locations:
        if url_location and self._is_cloneable(
                url_location, image_meta):
            _prefix, pool, image, snapshot = \
                self._parse_location(url_location)
            volume_update = self._clone(volume, pool, image, snapshot)
            volume_update['provider_location'] = None
            self._resize(volume)
            return volume_update, True
    return ({}, False)
```

rbd直接clone，这个过程和创建虚拟机基本一致。如果创建volume时指定了新的大小，则调用rbd resize执行扩容操作。

假设新创建的volume uuid为`87ee1ec6-3fe4-413b-a4c0-8ec7756bf1b4`，glance image uuid为`db2b6552-394a-42d2-9de8-2295fe2b3180`，则rbd命令为:

```sh
rbd clone openstack/db2b6552-394a-42d2-9de8-2295fe2b3180@snap \
 openstack/volume-87ee1ec6-3fe4-413b-a4c0-8ec7756bf1b4

if [[ -n "$size" ]]; then
    rbd resize --size $size \
    openstack/volume-87ee1ec6-3fe4-413b-a4c0-8ec7756bf1b4
fi
```

通过rbd命令验证如下:

```sh
int32bit $ rbd info openstack/volume-87ee1ec6-3fe4-413b-a4c0-8ec7756bf1b4
rbd image 'volume-87ee1ec6-3fe4-413b-a4c0-8ec7756bf1b4':
        size 3072 MB in 768 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.affc488ac1a
        format: 2
        features: layering, exclusive-lock, object-map, fast-diff, deep-flatten
        flags:
        create_timestamp: Wed Nov 22 13:07:50 2017
        parent: openstack/db2b6552-394a-42d2-9de8-2295fe2b3180@snap
        overlap: 2048 MB
```

可见新创建的rbd image的parent为`openstack/db2b6552-394a-42d2-9de8-2295fe2b3180@snap`。

**注：其实我个人认为该方法需要执行`flatten`操作，否则当有volume存在时，Glance不能删除镜像，相当于Glance服务依赖于Cinder服务状态，这有点不合理。**

### 4.3 创建快照

创建快照入口为`cinder/volume/manager.py`的`create_snapshot()`方法，该方法没有使用taskflow框架，而是直接调用的driver `create_snapshot()`方法，如下:

```python
...
try:
    utils.require_driver_initialized(self.driver)
    snapshot.context = context
    model_update = self.driver.create_snapshot(snapshot)
    ...
except Exception:
    ...
```

`RBDDriver`的`create_snapshot()`方法非常简单:

```python
def create_snapshot(self, snapshot):
    """Creates an rbd snapshot."""
    with RBDVolumeProxy(self, snapshot.volume_name) as volume:
        snap = utils.convert_str(snapshot.name)
        volume.create_snap(snap)
        volume.protect_snap(snap)
```

因此volume的快照其实就是对应Ceph rbd image快照，假设snapshot uuid为`e4e534fc-420b-45c6-8e9f-b23dcfcb7f86`，volume uuid为`bf2d1c54-6c98-4a78-9c20-3e8ea033c3db`，则对应的rbd命令大致如下:

```sh
rbd -p openstack snap create \
volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db@snapshot-e4e534fc-420b-45c6-8e9f-b23dcfcb7f86
rbd -p openstack snap protect \
volume-bf2d1c54-6c98-4a78-9c20-3e8ea033c3db@snapshot-e4e534fc-420b-45c6-8e9f-b23dcfcb7f86
```

从这里我们可以看出虚拟机快照和volume快照的区别，虚拟机快照需要从根磁盘rbd image快照中clone然后flatten，而volume的快照只需要创建rbd image快照，因此虚拟机快照通常需要数分钟的时间，而volume快照能够秒级完成。


### 4.4 创建volume备份

在了解volume备份之前，首先需要理清快照和备份的区别。我们可以通过`git`类比，快照类似`git commit`操作，只是表明数据提交了，主要用于回溯与回滚。当集群奔溃导致数据丢失，通常不能从快照中完全恢复数据。而备份则类似于`git push`，把数据安全推送到了远端存储系统中，主要用于保证数据安全，即使本地数据丢失，也能从备份中恢复。Cinder的磁盘备份也支持多种存储后端，这里我们只考虑volume和backup driver都是Ceph的情况，其它细节可以参考[Cinder数据卷备份原理与实践](http://int32bit.me/2017/03/30/Cinder%E6%95%B0%E6%8D%AE%E5%8D%B7%E5%A4%87%E4%BB%BD%E5%8E%9F%E7%90%86%E5%92%8C%E5%AE%9E%E8%B7%B5/)。生产中volume和backup必须使用不同的Ceph集群，这样才能保证当volume ceph集群挂了，也能从另一个集群中快速恢复数据。本文只是为了测试功能，因此使用的是同一个Ceph集群，通过pool区分，volume使用`openstack`pool，而backup使用`cinder_backup`pool。

另外，Cinder支持增量备份，用户可以指定`--incremental`参数决定使用的是全量备份还是增量备份。但是对于Ceph后端来说，Cinder总是先尝试执行增量备份，只有当增量备份失败时，才会fallback到全量备份，而不管用户有没有指定`--incremental`参数。尽管如此，我们仍然把备份分为全量备份和增量备份两种情况，注意只有第一次备份才有可能是全量备份，剩下的备份都是增量备份。

#### 全量备份(第一次备份)

我们直接查看`CephBackupDriver`的`backup()`方法，代码位于`cinder/backup/drivers/ceph.py`。

```python
if self._file_is_rbd(volume_file):
    # If volume an RBD, attempt incremental backup.
    LOG.debug("Volume file is RBD: attempting incremental backup.")
    try:
        updates = self._backup_rbd(backup, volume_file,
                                   volume.name, length)
    except exception.BackupRBDOperationFailed:
        LOG.debug("Forcing full backup of volume %s.", volume.id)
        do_full_backup = True
```

这里主要判断源volume是否是rbd，即是否使用Ceph后端，只有当volume也使用Ceph存储后端情况下才能执行增量备份。

我们查看`_backup_rbd()`方法:

```python
from_snap = self._get_most_recent_snap(source_rbd_image)
base_name = self._get_backup_base_name(volume_id, diff_format=True)
image_created = False
with rbd_driver.RADOSClient(self, backup.container) as client:
    if base_name not in self.rbd.RBD().list(ioctx=client.ioctx):
        ...
        # Create new base image
        self._create_base_image(base_name, length, client)
        image_created = True
    else:
        ...
```

`from_snap`为上一次备份时的快照点，由于我们这是第一次备份，因此`from_snap`为`None`，`base_name`格式为`volume-%s.backup.base`，这个base是做什么的呢？我们查看下`_create_base_image()`方法就知道了:

```python
def _create_base_image(self, name, size, rados_client):
    old_format, features = self._get_rbd_support()
    self.rbd.RBD().create(ioctx=rados_client.ioctx,
                          name=name,
                          size=size,
                          old_format=old_format,
                          features=features,
                          stripe_unit=self.rbd_stripe_unit,
                          stripe_count=self.rbd_stripe_count)
```

可见base其实就是一个空卷，大小和之前的volume大小一致。

也就是说如果是第一次备份，在backup的Ceph集群首先会创建一个大小和volume一样的空卷。

我们继续看源码:

```python
def _backup_rbd(self, backup, volume_file, volume_name, length):
    ...
    new_snap = self._get_new_snap_name(backup.id)
    LOG.debug("Creating backup snapshot='%s'", new_snap)
    source_rbd_image.create_snap(new_snap)

    try:
        self._rbd_diff_transfer(volume_name, rbd_pool, base_name,
                                backup.container,
                                src_user=rbd_user,
                                src_conf=rbd_conf,
                                dest_user=self._ceph_backup_user,
                                dest_conf=self._ceph_backup_conf,
                                src_snap=new_snap,
                                from_snap=from_snap)
                            
def _get_new_snap_name(self, backup_id):
    return utils.convert_str("backup.%s.snap.%s"
                             % (backup_id, time.time()))
```

首先在源volume中创建了一个新快照，快照名为`backup.${backup_id}.snap.${timestamp}`，然后调用了`rbd_diff_transfer()`方法:

```python
def _rbd_diff_transfer(self, src_name, src_pool, dest_name, dest_pool,
                       src_user, src_conf, dest_user, dest_conf,
                       src_snap=None, from_snap=None):
    src_ceph_args = self._ceph_args(src_user, src_conf, pool=src_pool)
    dest_ceph_args = self._ceph_args(dest_user, dest_conf, pool=dest_pool)

    cmd1 = ['rbd', 'export-diff'] + src_ceph_args
    if from_snap is not None:
        cmd1.extend(['--from-snap', from_snap])
    if src_snap:
        path = utils.convert_str("%s/%s@%s"
                                 % (src_pool, src_name, src_snap))
    else:
        path = utils.convert_str("%s/%s" % (src_pool, src_name))
    cmd1.extend([path, '-'])

    cmd2 = ['rbd', 'import-diff'] + dest_ceph_args
    rbd_path = utils.convert_str("%s/%s" % (dest_pool, dest_name))
    cmd2.extend(['-', rbd_path])

    ret, stderr = self._piped_execute(cmd1, cmd2)
    if ret:
        msg = (_("RBD diff op failed - (ret=%(ret)s stderr=%(stderr)s)") %
               {'ret': ret, 'stderr': stderr})
        LOG.info(msg)
        raise exception.BackupRBDOperationFailed(msg)
```

方法调用了rbd命令，先通过`export-diff`子命令导出源rbd image的差量文件，然后通过`import-diff`导入到backup的image中。

假设源volume的uuid为`075c06ed-37e2-407d-b998-e270c4edc53c`，大小为1GB，backup uuid为`db563496-0c15-4349-95f3-fc5194bfb11a`，这对应的rbd命令大致如下:

```sh
VOLUME_ID=075c06ed-37e2-407d-b998-e270c4edc53c
BACKUP_ID=db563496-0c15-4349-95f3-fc5194bfb11a
rbd -p cinder_backup create --size 1024 volume-${VOLUME_ID}.backup.base
new_snap=volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.1511344566.67
rbd -p openstack snap create ${new_snap}
rbd export-diff --pool openstack ${new_snap} - \
| rbd import-diff --pool cinder_backup - volume-${VOLUME_ID}.backup.base
```

我们可以通过rbd命令验证如下:

```sh
# volume ceph cluster
int32bit $ rbd -p openstack snap ls volume-075c06ed-37e2-407d-b998-e270c4edc53c
SNAPID NAME                                                              SIZE TIMESTAMP
    52 backup.db563496-0c15-4349-95f3-fc5194bfb11a.snap.1511344566.67 1024 MB Wed Nov 22 17:56:15 2017
# backup ceph cluster
int32bit $ rbd -p cinder_backup ls -l
NAME                                                                                                                    SIZE PARENT FMT PROT LOCK
volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base                                                                1024M 2
volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base@backup.db563496-0c15-4349-95f3-fc5194bfb11a.snap.1511344566.67 1024M  2
```

从输出上看，源volume创建了一个快照，ID为`52`，在backup的Ceph集群中创建了一个空卷`volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base`，并且包含一个快照`backup.xxx.snap.1511344566.67`，该快照是通过`import-diff`创建的。

#### 增量备份

前面的过程和全量备份一样，我们直接跳到`_backup_rbd()`方法:

```python
from_snap = self._get_most_recent_snap(source_rbd_image)
with rbd_driver.RADOSClient(self, backup.container) as client:
    if base_name not in self.rbd.RBD().list(ioctx=client.ioctx):
        ...
    else:
        if not self._snap_exists(base_name, from_snap, client):
            errmsg = (_("Snapshot='%(snap)s' does not exist in base "
                        "image='%(base)s' - aborting incremental "
                        "backup") %
                      {'snap': from_snap, 'base': base_name})
            LOG.info(errmsg)
            raise exception.BackupRBDOperationFailed(errmsg)
```

首先获取源volume对应rbd image的最新快照最为parent，然后判断在backup的Ceph集群的base中是否存在相同的快照（根据前面的全量备份，一定存在和源volume一样的快照。

我们继续看后面的部分:

```python
new_snap = self._get_new_snap_name(backup.id)
source_rbd_image.create_snap(new_snap)

try:
    before = time.time()
    self._rbd_diff_transfer(volume_name, rbd_pool, base_name,
                            backup.container,
                            src_user=rbd_user,
                            src_conf=rbd_conf,
                            dest_user=self._ceph_backup_user,
                            dest_conf=self._ceph_backup_conf,
                            src_snap=new_snap,
                            from_snap=from_snap)
    if from_snap:
        source_rbd_image.remove_snap(from_snap)
```

这个和全量备份基本是一样的，唯一区别在于此时`from_snap`不是`None`，并且后面会删掉`from_snap`。`_rbd_diff_transfer`方法可以翻前面代码。

假设源volume uuid为`075c06ed-37e2-407d-b998-e270c4edc53c`，backup uuid为`e3db9e85-d352-47e2-bced-5bad68da853b`，parent backup uuid为`db563496-0c15-4349-95f3-fc5194bfb11a`，则对应的rbd命令大致如下:

```sh
VOLUME_ID=075c06ed-37e2-407d-b998-e270c4edc53c
BACKUP_ID=e3db9e85-d352-47e2-bced-5bad68da853b
PARENT_ID=db563496-0c15-4349-95f3-fc5194bfb11a
rbd -p openstack snap create \
volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.1511348180.27
rbd export-diff  --pool openstack \
--from-snap backup.${PARENT_ID}.snap.1511344566.67 \
openstack/volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.1511348180.27 - \
| rbd import-diff --pool cinder_backup - \
cinder_backup/volume-${VOLUME_ID}.backup.base
rbd -p openstack snap rm \
volume-${VOLUME_ID}.backup.base@backup.${PARENT_ID}.snap.1511344566.67
```

我们通过rbd命令验证如下:

```sh
int32bit $ rbd -p openstack snap ls volume-075c06ed-37e2-407d-b998-e270c4edc53c
SNAPID NAME                                                              SIZE TIMESTAMP
    53 backup.e3db9e85-d352-47e2-bced-5bad68da853b.snap.1511348180.27 1024 MB Wed Nov 22 18:56:20 2017
int32bit $ rbd -p cinder_backup ls -l
NAME                                                                                                                    SIZE PARENT FMT PROT LOCK
volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base                                                                1024M          2
volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base@backup.db563496-0c15-4349-95f3-fc5194bfb11a.snap.1511344566.67 1024M          2
volume-075c06ed-37e2-407d-b998-e270c4edc53c.backup.base@backup.e3db9e85-d352-47e2-bced-5bad68da853b.snap.1511348180.27 1024M          2
```

和我们分析的结果一致，源volume的快照会删除旧的而只保留最新的一个，backup则会保留所有的快照。

### 4.5 备份恢复

备份恢复是备份的逆过程，即从远端存储还原数据到本地。备份恢复的源码位于`cinder/backup/drivers/ceph.py`的`restore()`方法，该方法直接调用了`_restore_volume()`方法，因此我们直接看`_restore_volume()`方法:

```python
def _restore_volume(self, backup, volume, volume_file):
    length = int(volume.size) * units.Gi

    base_name = self._get_backup_base_name(backup.volume_id,
                                           diff_format=True)
    with rbd_driver.RADOSClient(self, backup.container) as client:
        diff_allowed, restore_point = \
            self._diff_restore_allowed(base_name, backup, volume,
                                       volume_file, client)
```

其中`_diff_restore_allowed()`是一个非常重要的方法，该方法判断是否支持通过直接导入方式恢复，我们查看该方法实现:

```python
def _diff_restore_allowed(self, base_name, backup, volume, volume_file,
                          rados_client):
    rbd_exists, base_name = self._rbd_image_exists(base_name,
                                                   backup.volume_id,
                                                   rados_client)
    if not rbd_exists:
        return False, None
    restore_point = self._get_restore_point(base_name, backup.id)
    if restore_point:
        if self._file_is_rbd(volume_file):
            if volume.id == backup.volume_id:
                return False, restore_point
            if self._rbd_has_extents(volume_file.rbd_image):
                return False, restore_point
            return True, restore_point
```

从该方法中我们可以看出支持差量导入方式恢复数据，需要满足以下所有条件:

* backup集群对应volume的rbd base image必须存在。
* 恢复点必须存在，即backup base image对应的快照必须存在。
* 恢复目标的volume必须是RBD，即volume的存储后端也必须是Ceph。
* 恢复目标的volume必须是空卷，既不支持覆盖已经有内容的image。
* 恢复目标的volume uuid和backup的源volume uuid不能是一样的，即不能覆盖原来的volume。

换句话说，虽然Cinder支持将数据还复到已有的volume（包括源volume）中，但如果使用Ceph后端就不支持增量恢复，导致效率会非常低。

**因此如果使用Ceph存储后端，官方文档中建议将备份恢复到空卷中（不指定volume)，不建议恢复到已有的volume中**。

>Note that Cinder supports restoring to a new volume or the original volume the
backup was taken from. For the latter case, a full copy is enforced since this
was deemed the safest action to take. It is therefore recommended to always
restore to a new volume (default).
>

这里假定我们恢复到空卷中，命令如下:

```sh
cinder backup-restore --name int32bit-restore-1 \
e3db9e85-d352-47e2-bced-5bad68da853b
```

注意我们没有指定`--volume`参数。此时执行增量恢复，代码实现如下:

```python
def _diff_restore_rbd(self, backup, restore_file, restore_name,
                      restore_point, restore_length):
    rbd_user = restore_file.rbd_user
    rbd_pool = restore_file.rbd_pool
    rbd_conf = restore_file.rbd_conf
    base_name = self._get_backup_base_name(backup.volume_id,
                                           diff_format=True)
    before = time.time()
    try:
        self._rbd_diff_transfer(base_name, backup.container,
                                restore_name, rbd_pool,
                                src_user=self._ceph_backup_user,
                                src_conf=self._ceph_backup_conf,
                                dest_user=rbd_user, dest_conf=rbd_conf,
                                src_snap=restore_point)
    except exception.BackupRBDOperationFailed:
        raise
    self._check_restore_vol_size(backup, restore_name, restore_length,
                                 rbd_pool)
```

可见增量恢复非常简单，仅仅调用前面介绍的`_rbd_diff_transfer()`方法把backup Ceph集群对应的base image的快照`export-diff`到volume的Ceph集群中，并调整大小。

假设backup uuid为`e3db9e85-d352-47e2-bced-5bad68da853b`，源volume uuid为`075c06ed-37e2-407d-b998-e270c4edc53c`，目标volume uuid为`f65cf534-5266-44bb-ad57-ddba21d9e5f9`，则对应的rbd命令为:

```sh
BACKUP_ID=e3db9e85-d352-47e2-bced-5bad68da853b
SOURCE_VOLUME_ID=075c06ed-37e2-407d-b998-e270c4edc53c
DEST_VOLUME_ID=f65cf534-5266-44bb-ad57-ddba21d9e5f9
rbd export-diff --pool cinder_backup \
cinder_backup/volume-${SOURCE_VOLUME_ID}.backup.base@backup.${BACKUP_ID}.snap.1511348180.27 - \
| rbd import-diff --pool openstack - openstack/volume-${DEST_VOLUME_ID}
rbd -p openstack resize --size ${new_size} volume-${DEST_VOLUME_ID}
```

如果不满足以上5个条件之一，则Cinder会执行全量备份，全量备份就是一块一块数据写入:

```python
def _transfer_data(self, src, src_name, dest, dest_name, length):
    chunks = int(length / self.chunk_size)
    for chunk in range(0, chunks):
        before = time.time()
        data = src.read(self.chunk_size)
        dest.write(data)
        dest.flush()
        delta = (time.time() - before)
        rate = (self.chunk_size / delta) / 1024
        # yield to any other pending backups
        eventlet.sleep(0)
    rem = int(length % self.chunk_size)
    if rem:
        dest.write(data)
        dest.flush()
        # yield to any other pending backups
        eventlet.sleep(0)
```


这种情况下效率很低，非常耗时，不建议使用。

## 5 总结

### 5.1 Glance

#### 1. 上传镜像

```sh
rbd -p ${GLANCE_POOL} create --size ${SIZE} ${IMAGE_ID}
rbd -p ${GLANCE_POOL} snap create ${IMAGE_ID}@snap
rbd -p ${GLANCE_POOL} snap protect ${IMAGE_ID}@snap
```

#### 2. 删除镜像

```sh
rbd -p ${GLANCE_POOL} snap unprotect ${IMAGE_ID}@snap
rbd -p ${GLANCE_POOL} snap rm ${IMAGE_ID}@snap
rbd -p ${GLANCE_POOL} rm ${IMAGE_ID}
```

### 5.2 Nova

#### 1 创建虚拟机

```sh
rbd clone ${GLANCE_POOL}/${IMAGE_ID}@snap ${NOVA_POOL}/${SERVER_ID}_disk
```

#### 2 创建虚拟机快照

```sh
# Snapshot the disk and clone it into Glance's storage pool
rbd -p ${NOVA_POOL} snap create ${SERVER_ID}_disk@${RANDOM_UUID}
rbd -p ${NOVA_POOL} snap protect ${SERVER_ID}_disk@${RANDOM_UUID}
rbd clone ${NOVA_POOL}/${SERVER_ID}_disk@${RANDOM_UUID} ${GLANCE_POOL}/${IMAGE_ID}
# Flatten the image, which detaches it from the source snapshot
rbd -p ${GLANCE_POOL} flatten ${IMAGE_ID}
# all done with the source snapshot, clean it up
rbd -p ${NOVA_POOL} snap unprotect ${SERVER_ID}_disk@${RANDOM_UUID}
rbd -p ${NOVA_POOL} snap rm ${SERVER_ID}_disk@${RANDOM_UUID}
# Makes a protected snapshot called 'snap' on uploaded images and hands it out
rbd -p ${GLANCE_POOL} snap create ${IMAGE_ID}@snap
rbd -p ${GLANCE_POOL} snap protect ${IMAGE_ID}@snap
```

#### 3 删除虚拟机

```sh
for image in $(rbd -p ${NOVA_POOL} ls | grep "^${SERVER_ID}");
    do rbd -p ${NOVA_POOL} rm "$image";
done
```

### 5.3 Cinder

#### 1 创建volume

(1) 创建空白卷

```sh
rbd -p ${CINDER_POOL} create --new-format --size ${SIZE} volume-${VOLUME_ID}
```

(2) 从快照中创建

```sh
rbd clone \
${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@snapshot-${SNAPSHOT_ID} \
${CINDER_POOL}/volume-${VOLUME_ID}
rbd resize --size ${SIZE} openstack/volume-${VOLUME_ID}
```

(3) 从volume中创建

```sh
# Do full copy if rbd_max_clone_depth <= 0.
if [[ "$rbd_max_clone_depth" -le 0 ]]; then
    rbd copy \
    ${CINDER_POOL}/volume-${SOURCE_VOLUME_ID} ${CINDER_POOL}/volume-${VOLUME_ID}
    exit 0
fi
# Otherwise do COW clone.
# Create new snapshot of source volume
rbd snap create \
${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@volume-${VOLUME_ID}.clone_snap
rbd snap protect \
${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@volume-${VOLUME_ID}.clone_snap
# Now clone source volume snapshot
rbd clone \
${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@volume-${VOLUME_ID}.clone_snap \
${CINDER_POOL}/volume-${VOLUME_ID}
# If dest volume is a clone and rbd_max_clone_depth reached,
# flatten the dest after cloning.
depth=$(get_clone_depth ${CINDER_POOL}/volume-${VOLUME_ID})
if [[ "$depth" -ge "$rbd_max_clone_depth" ]]; then
    # Flatten destination volume
    rbd flatten ${CINDER_POOL}/volume-${VOLUME_ID}
    # remove temporary snap
    rbd snap unprotect \
    ${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@volume-${VOLUME_ID}.clone_snap
    rbd snap rm \
    ${CINDER_POOL}/volume-${SOURCE_VOLUME_ID}@volume-${VOLUME_ID}.clone_snap
fi
```

(4) 从镜像中创建

```sh
rbd clone ${GLANCE_POOL}/${IMAGE_ID}@snap ${CINDER_POOL}/volume-${VOLUME_ID}
if [[ -n "${SIZE}" ]]; then
    rbd resize --size ${SIZE} ${CINDER_POOL}/volume-${VOLUME_ID}
fi
```

#### 2 创建快照

```sh
rbd -p ${CINDER_POOL} snap create volume-${VOLUME_ID}@snapshot-${SNAPSHOT_ID}
rbd -p ${CINDER_POOL} snap protect volume-${VOLUME_ID}@snapshot-${SNAPSHOT_ID}
```

#### 3 创建备份

(1) 第一次备份

```sh
rbd -p ${BACKUP_POOL} create --size \
${VOLUME_SIZE} volume-${VOLUME_ID}.backup.base
NEW_SNAP=volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.${TIMESTAMP}
rbd -p ${CINDER_POOL} snap create ${NEW_SNAP}
rbd export-diff ${CINDER_POOL}/volume-${VOLUME_ID}${NEW_SNAP} - \
| rbd import-diff --pool ${BACKUP_POOL} - volume-${VOLUME_ID}.backup.base
```

(2) 增量备份

```sh
rbd -p ${CINDER_POOL} snap create \
volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.${TIMESTAMP}
rbd export-diff  --pool ${CINDER_POOL} \
--from-snap backup.${PARENT_ID}.snap.${LAST_TIMESTAMP} \
${CINDER_POOL}/volume-${VOLUME_ID}@backup.${BACKUP_ID}.snap.${TIMESTRAMP} - \
| rbd import-diff --pool ${BACKUP_POOL} - \
${BACKUP_POOL}/volume-${VOLUME_ID}.backup.base
rbd -p ${CINDER_POOL} snap rm \
volume-${VOLUME_ID}.backup.base@backup.${PARENT_ID}.snap.${LAST_TIMESTAMP}
```

#### 4 备份恢复

```sh
rbd export-diff --pool ${BACKUP_POOL} \
volume-${SOURCE_VOLUME_ID}.backup.base@backup.${BACKUP_ID}.snap.${TIMESTRAMP} - \
| rbd import-diff --pool ${CINDER_POOL} - volume-${DEST_VOLUME_ID}
rbd -p ${CINDER_POOL} resize --size ${new_size} volume-${DEST_VOLUME_ID}
```
