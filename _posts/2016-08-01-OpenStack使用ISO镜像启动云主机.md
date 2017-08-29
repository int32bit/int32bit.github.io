---
layout: post
title: OpenStack使用ISO镜像启动云主机
catalog: true
tags: [OpenStack]
---

## 1. 基础知识

大多数OpenStack新手都很疑惑一个问题，为什么OpenStack只能上传qcow2、raw格式镜像，而不是我们装系统的ISO格式镜像。其实OpenStack原生支持ISO镜像格式，只是使用方法和直接使用qcow2、raw等格式会有点不同。

### 1.1 什么是ISO镜像

ISO文件是电脑上光盘镜像存储格式之一，它是根据ISO-9660有关CD-ROM文件系统标准存储的文件，所以通常在电脑中以后缀.iso命名，俗称iso镜像文件。其本质就是一个压缩打包后文件，和Linux下的tar类似。而ISO镜像文件就是把一系列安装某一个操作系统所需要的文件和工具打包成一个压缩包文件，打包格式为ISO。我们可以使用解包工具打开ISO文件浏览文件内容。

### 1.2 安装操作系统流程

我们回顾下使用ISO镜像安装操作系统的步骤，以ubuntu 14.04为例，主要包括以下几个过程：

* 在官方网站下载ubuntu 14.04 ISO镜像。
* 使用`Startup Disk Creator`或者`unetbootin`工具制作USB Live CD.
* 插入U盘，重启系统，在BIOS中设置引导顺序，选择从U盘启动。
* 进入安装界面，并执行相关配置，比如时区、键盘映射、语言等。
* 安装程序会识别计算机的硬盘，比如/dev/sda，并进入分区引导界面。
* 分区完成后，开始拷贝操作系统所需要的文件
* 用户自定义设置，包括创建用户、预装程序等。
* 安装grub引导程序，退出重启。

以上是安装ubuntu操作系统的基本步骤，我们使用U盘充当了cdrom，并把操作系统安装到/dev/sda这块硬盘中，重启后，选择从硬盘启动，即可进入操作系统。

我们从以上过程可以看出，ISO本质就是提供安装操作系统的一系列工具，负责把操作系统安装在硬盘(/dev/sda)上，并安装引导程序grub到硬盘MBR中。

### 1.3 制作OpenStack镜像流程

我们再回顾下制作OpenStack镜像流程，仍然以ubuntu 14.04为例，参考[OpenStack官方文档](http://docs.openstack.org/image-guide/ubuntu-image.html),主要包括以下几个过程:

* 在官方网站下载ubuntu 14.04 ISO镜像。
* 使用qemu-img工具创建一个虚拟硬盘。

```bash
qemu-img create -f qcow2 /tmp/trusty.qcow2 10G
```

* 以ISO文件作为cdrom，qcow2文件作为第一块虚拟硬盘，启动虚拟机

```bash
virt-install --virt-type kvm --name trusty --ram 1024 \
  --cdrom=/data/isos/trusty-64-mini.iso \
  --disk /tmp/trusty.qcow2,format=qcow2 \
  --network network=default \
  --graphics vnc,listen=0.0.0.0 --noautoconsole \
  --os-type=linux --os-variant=ubuntutrusty
```
 
* 进入安装界面，进行相关配置，比如时区、键盘映射、语言等。
* 安装程序会识别虚拟机的虚拟硬盘，即qcow2文件，映射为/dev/vda，并进入分区引导界面。
* 分区完成后，开始拷贝操作系统所需要的文件。
* 用户自定义设置，包括创建用户、预装程序。
* 安装grub引导程序，退出重启，此时操作系统已经安装到qcow2虚拟硬盘中。
* 从硬盘启动，进入虚拟机，安装cloud-init、growpart、qemu-guest-agent等工具。
* 删除虚拟机，只需要保留qcow2虚拟硬盘文件，镜像制作完成。
* 上传qcow2到glance中即可。
 

我们从以上步骤可以看出，基本和安装操作系统到物理机过程大体相同，区别在于前者把操作系统安装在物理硬盘上，而后者把操作系统固定安装在虚拟硬盘中。我们的qcow2、raw等文件本质就是虚拟机的虚拟硬盘（相当于/dev/sda），制作镜像时本质就是把操作系统安装在虚拟硬盘了，因此我们使用OpenStack启动虚拟机，并不需要执行一系列安装过程，直接就能启动了。

## 2. OpenStack云主机启动方式

我们从OpenStack Dashboard上可以看出OpenStack启动虚拟机的几种方式:

![instance boot sources](/img/posts/OpenStack使用ISO镜像启动云主机/1.png)

我们排除boot from snapshot和boot from volume snapshot两种启动方式，因为这两者和直接boot from image和boot from volume是一样的，区别在于从image本身启动还是从快照启动。因此实际上我们主要归纳为三种启动方式:

* 从image启动(boot from image)
* 从volume卷启动(boot from volume)
* 从image启动并挂载一个volume空白卷(Boot instance from image and attach non-bootable volume)

在nova boot命令时可以指定`--block-device`参数，该参数可以指定source(比如volume、image等）、volume size、dest、bootindex（类似于BIOS启动顺序)。若没有指定bootindex，nova会优先从image启动，即若同时指定了image和volume，则会先从image中启动，否则若只指定了volume，而没有指定image，则nova将尝试从volume启动。

### 2.1 从glance镜像启动

这是最常用最经典的启动方式，我们上传镜像到glance中，然后从glance中选择其中一个镜像启动虚拟机，启动方式命令行为:

```bash
nova boot  --flavor $FLAVOR --image f80ba429-417d-4ae7-8b4d-855a484f8454 --nic net-id=$NETWORK $NAME
```

使用virsh命令查看block 设备:

```
$ virsh  domblklist 46f4bb89-446f-45d2-a6d8-70a5b2715906
Target     Source
------------------------------------------------
vda        openstack-00/46f4bb89-446f-45d2-a6d8-70a5b2715906_disk
hdd        openstack-00/46f4bb89-446f-45d2-a6d8-70a5b2715906_disk.config
```

由于我们后端存储使用了ceph，其中`openstack-00/46f4bb89-446f-45d2-a6d8-70a5b2715906_disk`就是rbd image，因此直接使用rbd命令查看根磁盘详细信息:

```
$ rbd info openstack-00/46f4bb89-446f-45d2-a6d8-70a5b2715906_disk
rbd image '46f4bb89-446f-45d2-a6d8-70a5b2715906_disk':
        size 81920 MB in 20480 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.ee6d26b1fa54d
        format: 2
        features: layering, striping
        flags:
        parent: openstack-00/f80ba429-417d-4ae7-8b4d-855a484f8454@snap
        overlap: 20480 MB
        stripe unit: 4096 kB
        stripe count: 1
```

我们从image启动方式本质就是从glance镜像中克隆一个副本到计算节点中（直接clone还是拷贝取决于是否使用共享分布式存储系统)，然后以这个副本作为根磁盘启动虚拟机（第1节中已经介绍glance镜像本质就是已经安装好操作系统的虚拟硬盘)。

### 2.2 从cinder volume卷启动

这个和boot from image没有什么大的区别，前者是从glance中克隆某一镜像作为系统根磁盘，并从该根磁盘里启动，而后者是直接使用cinder的volume卷作为根磁盘启动。前提是这个cinder volume必须是可启动的（bootable)。

boot from volume的实践过程:

#### 2.2.1 创建一个cinder，并指定image

```bash
cinder create --image-id f80ba429-417d-4ae7-8b4d-855a484f8454 --display_name=int32bit-from-image 20
```

该命令会从glance image中拷贝一个副本作为新建的volume卷，如果是ceph后端，则直接clone，我们可以使用rbd命令验证:

```bash
rbd info openstack-00/volume-5b540b6a-3a98-4417-9a86-6df94d9767b7
rbd image 'volume-5b540b6a-3a98-4417-9a86-6df94d9767b7':
        size 20480 MB in 5120 objects
        order 22 (4096 kB objects)
        block_name_prefix: rbd_data.ee3eafcb48a9
        format: 2
        features: layering, striping
        flags:
        parent: openstack-00/f80ba429-417d-4ae7-8b4d-855a484f8454@snap
        overlap: 20480 MB
        stripe unit: 4096 kB
        stripe count: 1
```

其中`5b540b6a-3a98-4417-9a86-6df94d9767b7`是新创建volume卷的id。

为了保证该cinder volume是可启动的，我们需要确定bootable值是否为true:

```bash
cinder show ${VOLUME_ID}  | grep bootable | awk '{print $4}' # 返回true
```


#### 2.2.2 从volume中启动

```bash 
nova boot --flavor m1.small \
  	--block-device source=volume,id=${VOLUME_ID},dest=volume,size=10,shutdown=preserve,bootindex=0 \
	int32bit-boot-from-volume
```
使用`nova show`查看信息:

![boot from volume](/img/posts/OpenStack使用ISO镜像启动云主机/2.png)

从nova信息的image项看出，由于没有指定image，因此尝试从volume启动。

使用virsh命令查看其block设备:

```bash
$ virsh  domblklist 2a531f5f-bc3f-42dd-b9d4-6edb4fdb8a3c
Target     Source
------------------------------------------------
hdd        openstack-00/2a531f5f-bc3f-42dd-b9d4-6edb4fdb8a3c_disk.config
vda        openstack-00/volume-5b540b6a-3a98-4417-9a86-6df94d9767b7
```
我们发现volume卷作为云主机的根磁盘。

*注意*:

* 当volume作为root device volume（根磁盘）时，不能执行卸载操作。

```
$ nova volume-detach 2a531f5f-bc3f-42dd-b9d4-6edb4fdb8a3c 5b540b6a-3a98-4417-9a86-6df94d9767b7
ERROR (Forbidden): Can't detach root device volume (HTTP 403) (Request-ID: req-6b7be725-a0d8-4406-989e-ccf7fb0bbaf4)
``` 

* 删除云主机时，并不会级联删除根磁盘的volume卷，必须手动使用cinder API删除。

### 2.3 从image启动并挂载空白卷

这种方式其实就是前面两种方式的组合，即从image启动，并同时挂载一个volume卷作为第二块硬盘。

我们首先创建一个空白volume卷:

```bash
cinder create --name blank_volume 20G
```

然后从image启动，并指定空白volume:

```bash
FLAVOR_ID=b30ee3a4-904b-44b1-b34c-dc7711b05722
VOLUME_ID=739bfe68-052a-4b6e-bfb0-ba83e49c63d6
NETWORK_ID=2109924d-3bc8-43e1-a287-ca2c22608ccc
IMAGE_ID=f2d3e1f5-6dc8-415c-b1a4-4baf9030ba6a
nova boot --flavor $FLAVOR_ID --image $IMAGE_ID \
  --block-device source=volume,id=$VOLUME_ID,dest=volume,shutdown=preserve --nic net-id=$NETWORK_ID int32bit-boot-from-volume
```

由前面可知，当同时指定了image和volume时会优先从image启动，查看info:

![Boot instance from image and attach non-bootable volume](/img/posts/OpenStack使用ISO镜像启动云主机/3.png)

使用virsh命令查看:

```
$ virsh domblklist 78ae95b1-ef47-4391-bb6f-a020df47ebbe
Target     Source
------------------------------------------------
hda        openstack-00/78ae95b1-ef47-4391-bb6f-a020df47ebbe_disk
hdd        openstack-00/78ae95b1-ef47-4391-bb6f-a020df47ebbe_disk.config
vda        openstack-00/volume-739bfe68-052a-4b6e-bfb0-ba83e49c63d6
```

从以上信息看出，指定的volume最终作为云硬盘挂载到云主机上。因此这种启动方式本质就是创建云主机的同时挂载一个块默认云云盘。

由于volume卷不是root device（根磁盘)， 因此可以使用nova detach命令卸载云硬盘:

```
nova volume-detach 78ae95b1-ef47-4391-bb6f-a020df47ebbe 739bfe68-052a-4b6e-bfb0-ba83e49c63d6
# 卸载成功
```

以上详细介绍了OpenStack的三种云主机启动方式，接下来将开始介绍如何在OpenStack平台上使用ISO镜像安装云主机。

## 3.使用ISO镜像启动云主机

### 3.1 思路

我们前面介绍了OpenStack启动云主机的几种方式，并详细介绍了使用ISO镜像安装操作系统的原理，简单总结下:

* ISO本质就是安装操作系统的工具，包括了一系列操作系统所依赖的文件以及安装工具
* ISO最终会把操作系统安装到指定硬盘中，并安装启动程序到硬盘的MBR中
* 从image启动并挂载一个空白volume卷，本质就是启动云主机的同时挂载一个默认的volume卷

我们可以利用第三种启动方式，从ISO image启动并同时挂载一个云硬盘，这时我们相当于可以把image作为cdrom，安装操作系统到挂载的云硬盘中。

### 3.2 上传镜像

以ubuntu 16.04为例，首先需要从官方下载ISO镜像并上传到glance中:

```bash
glance image-create \
	--file ubuntu-16.04.1-server-amd64.iso \
	--disk-format iso \
	--container-format bare \
	--visibility public \
	--progress \
	--name ubuntu-16.04.1-server-amd64
```

### 3.3 从ISO镜像启动并挂载一个空白volume卷

从Dashboard选择`Boot from image(creates a new volume`,指定上传的ISO镜像即可。也可以使用nova命令行:

```bash
cinder create --name blank_image 20
FLAVOR_ID=b30ee3a4-904b-44b1-b34c-dc7711b05722 # Flavor disk必须大于镜像大小
VOLUME_ID=21324408-e1bf-4028-b81d-9c9173f89ac6 # 刚刚创建的volume id
NETWORK_ID=2109924d-3bc8-43e1-a287-ca2c22608ccc
IMAGE_ID=f2d3e1f5-6dc8-415c-b1a4-4baf9030ba6a # 刚刚上传的ISO镜像
nova boot --flavor $FLAVOR_ID --image $IMAGE_ID \
  --block-device source=volume,id=$VOLUME_ID,dest=volume,shutdown=preserve --nic net-id=$NETWORK_ID int32bit-boot-from-volume
```

在进入vnc界面，直接通过Dashboard或者从命令行获取vnc地址:

```bash
nova get-vnc-console 7b4190b6-efa7-4299-9fbd-23a98a77ac23 novnc
```
此时进入ubuntu安装界面，如图:

![install interface](/img/posts/OpenStack使用ISO镜像启动云主机/4.png)

按照正常流程安装系统即可，在分区设置时，可以只设置根分区即可，如图:

![install interface](/img/posts/OpenStack使用ISO镜像启动云主机/5.png)

执行完安装过程，操作系统已经安装到空白volume卷中，原来的云主机已经没用了，我们安装操作系统也一样的道理，安装完后会移除cdrom，这里我们相当于移除image。

删除原来的云主机，:

```bash
nova delete 7b4190b6-efa7-4299-9fbd-23a98a77ac23
```

### 3.4 从volume启动云主机

首先需要设置原来的空白volume卷为bootable:

```bash
cinder set-bootable 21324408-e1bf-4028-b81d-9c9173f89ac6 true
```

从该volume启动云主机:

```bash
FLAVOR_ID=b30ee3a4-904b-44b1-b34c-dc7711b05722
VOLUME_ID=21324408-e1bf-4028-b81d-9c9173f89ac6
NETWORK_ID=2109924d-3bc8-43e1-a287-ca2c22608ccc
IMAGE_ID=f2d3e1f5-6dc8-415c-b1a4-4baf9030ba6a
nova boot --flavor $FLAVOR_ID \
  --block-device source=volume,id=$VOLUME_ID,dest=volume,size=20,shutdown=preserve,bootindex=0 --nic net-id=$NETWORK_ID int32bit-boot-from-volume-2
```

从启动参数看，我们移除了image参数，只指定了volume。
云主机创建成功后，打开vnc界面，如图:

![install interface](/img/posts/OpenStack使用ISO镜像启动云主机/6.png)

我们成功地进入ubuntu系统。

**注意**

* volume不能像image一样启动多次，每次启动都直接写入volume中。
* 目前glance不支持直接从volume中创建image，但可以从云主机instance中创建，可以通过这种方式永久保存该系统到glance中,这相当于对云主机打快照。
* 也可以导出volume到本地，然后手动上传到glance中。

## 4. Boot from PXE

很多人可能会问，OpenStack是否支持从PXE启动，即网络启动方式，遗憾的是这个bp从2013年开始提出，到现在也没有实现，[这里是bp地址](https://blueprints.launchpad.net/nova/+spec/libvirt-empty-vm-boot-pxe)。但目前有解决方案:

* 在bootloader上安装ipxe,然后上传到glance镜像中，这种方式有点麻烦，排除。
* 在xml文件中os node增加network启动项:

```xml
<os>
    <type arch='x86_64' machine='pc-i440fx-rhel7.1.0'>hvm</type>
    <boot dev='hd'/>
    <boot dev='network'/>
    <smbios mode='sysinfo'/>
  </os>
```

以上可以直接通过virsh edit命令修改，然后重启，使用vnc查看:

![boot from pxe](/img/posts/OpenStack使用ISO镜像启动云主机/7.png)

我们若hd启动失败，则会尝试从pxe启动，只是我们pxe没有部署，因此也启动失败了。

以上是临时解决办法，若需要永久生效，需要修改nova源码了, 最简单的patch为:

![patch pxe](/img/posts/OpenStack使用ISO镜像启动云主机/8.png)

## 参考文献

1. [Launch an instance from a volume](http://docs.openstack.org/user-guide/cli_nova_launch_instance_from_volume.html)
2. [ubuntu doc](http://www.ubuntu.com/)
