---
layout: post
title: Docker使用OpenStack Cinder持久化volume原理分析及实践
catalog: true
tag: [OpenStack, Docker]
---

## 1 背景知识

### 1.1 OpenStack Cinder简介

OpenStack Cinder为OpenStack提供块存储服务，其功能类似AWS的EBS服务，目前使用最多的是为OpenStack Nova虚拟机提供虚拟硬盘功能，即把volume挂载到虚拟机中，作为附加弹性硬盘使用，关于OpenStack Cinder volume挂载到虚拟机的过程分析可以参考之前写的博客[OpenStack虚拟机挂载数据卷过程分析](http://int32bit.me/2017/09/08/OpenStack%E8%99%9A%E6%8B%9F%E6%9C%BA%E6%8C%82%E8%BD%BD%E6%95%B0%E6%8D%AE%E5%8D%B7%E8%BF%87%E7%A8%8B%E5%88%86%E6%9E%90/)，这篇博客也是了解本文内容的基础。

但是，OpenStack Cinder不仅仅是为Nova虚拟机提供云硬盘功能，事实上，Cinder并不关心是谁在消费它的volume，除了虚拟机，还有可能是物理机和容器。Cinder volume挂载到物理机前面已经介绍过，可以参考[OpenStack中那些很少见但很有用的操作](http://int32bit.me/2017/09/25/OpenStack%E4%B8%AD%E9%82%A3%E4%BA%9B%E5%B0%91%E8%A7%81%E4%BD%86%E5%BE%88%E6%9C%89%E7%94%A8%E7%9A%84%E6%93%8D%E4%BD%9C/)。Cinder volume挂载到虚拟机以及物理机都介绍过了，剩下最后一个内容，Cinder volume如何挂载到Docker容器中呢，本文接下来将详细介绍并通过两个driver实例实践。

### 1.2 Docker volume简介

我们知道Docker容器本身是无状态的，意味着容器退出后不会保存任何数据。但实际使用场景，肯定是需要保存业务数据的，Docker通过volume实现数据的持久化存储以及共享。

默认情况下，Docker会使用本地目录作为容器的volume挂载到容器实例指定的路径。用户可以指定已经存在的路径作为Docker volume，如下:

```
mkdir data
docker run -t -i --rm -v `pwd`/data:/data busybox
```

以上把本地`data`目录挂载到容器`/data`路径中，注意源目录路径必须使用绝对路径，否则Docker会当作volume name。

你也可以不指定本地路径，此时Docker会自动创建一个新的空目录作为Docker volume：

```sh
docker run -t -i --rm -v /data busybox
```

可以使用`docker volume ls`查看创建的volume:

```sh
$ docker volume ls
DRIVER              VOLUME NAME
local               0e8d4d3936ec3b84c2ee4db388f45cbe5c84194d89d69be6b7a616fbdf1ea788
```

通过`inspect`子命令查看源路径path：

```
$ docker volume inspect 0e8d4d3936ec3b84c2ee4db388f45cbe5c84194d89d69be6b7a616fbdf1ea788
[
    {
        "CreatedAt": "2017-09-30T17:21:56+08:00",
        "Driver": "local",
        "Labels": null,
        "Mountpoint": "/var/lib/docker/volumes/0e8d4d3936ec3b84c2ee4db388f45cbe5c84194d89d69be6b7a616fbdf1ea788/_data",
        "Name": "0e8d4d3936ec3b84c2ee4db388f45cbe5c84194d89d69be6b7a616fbdf1ea788",
        "Options": {},
        "Scope": "local"
    }
]
```

从以上输出的结果可看出本地源目录为`/var/lib/docker/volumes/0e8d4d3936ec3b84c2ee4db388f45cbe5c84194d89d69be6b7a616fbdf1ea788/_data`，这个目录是Docker自动创建的。

由此我们也得出结论，Docker创建的volume只能用于当前宿主机的容器使用，不能挂载到其它宿主机的容器中，这种情况下只能运行些无状态服务，对于需要满足HA的有状态服务，则需要使用分布式共享volume持久化数据，保证宿主机挂了后，容器能够迁移到另一台宿主机中。而Docker本身并没有提供分布式共享存储方案，而是通过插件(plugin)机制实现与第三方存储系统对接集成，下节我们详细介绍。

### 1.3 Docker volume plugin介绍 

前面提到Docker本身并没有提供分布式共享volume方案实现，而是提供了一种灵活的插件机制，通过插件能够集成第三方的分布式共享系统，用户只需要实现plugin driver的接口就可以对接自己的任何存储系统。如当前非常流行的开源分布式存储系统Ceph、AWS EBS、OpenStack Cinder等，这些外部存储系统我们称为Provider。

值得一提的是，官方在[volume plugin协议文档](https://docs.docker.com/engine/extend/plugins_volume/#volumedrivermount)中强调:

>If a plugin registers itself as a VolumeDriver when activated, it must provide the Docker Daemon with writeable paths on the host filesystem. 

这句话的理解就是说，Docker不能直接读写外部存储系统，而必须把存储系统挂载到宿主机的本地文件系统中，Docker当作本地目录挂载到容器中，换句话说，**只要外部存储设备能够挂载到本地文件系统就可以作为Docker的volume**。比如对于ceph rbd，需要先map到本地，并挂载到宿主机指定的路径中，这个路径称为path。这里和虚拟机不一样，rbd挂载到虚拟机，QEMU能够直接通过rbd协议读写，不需要map到本地。

我们要想了解Docker挂载分布式存储系统的原理，首先需要了解下官方定义的plugin协议接口：

* create: 创建一个volume。
* remove: 删除一个volume。
* mount: 挂载一个volume到容器中。
* umount: 从容器中卸载一个volume。
* get/list: 获取volume信息。

以上create和remove都比较简单，最为核心的两个接口为mount和umount，不同的存储系统，接口实现不一样，我们这里只关心Cinder接口的实现。在此之前我没有过多研究，不妨我们就用前面了解的知识大胆猜想下Docker使用Cinder volume的实现原理。

### 1.4 Docker使用Cinder volume原理猜想

前面我们介绍了Docker plugin接口，现在假设我们需要对接OpenStack Cinder，Cinder存储后端(backend)使用LVM，猜测Docker plugin接口实现如下:

* create: 直接调用Cinder API创建一个volume。
* remote: 直接调用Cinder API删除一个volume。
* get/list: 直接调用Cinder API获取volume列表。
* mount: 前面提到Docker volume必须先挂载到本地，而这不正是恰好对应Cinder的local-attach么，具体内容可以参考[OpenStack中那些很少见但很有用的操作](http://int32bit.me/2017/09/25/OpenStack%E4%B8%AD%E9%82%A3%E4%BA%9B%E5%B0%91%E8%A7%81%E4%BD%86%E5%BE%88%E6%9C%89%E7%94%A8%E7%9A%84%E6%93%8D%E4%BD%9C/)。local attach到本地设备后，如果块设备没有安装文件系统，则mount操作还需要执行文件系统格式化。创建完文件系统后，只需要mount到宿主机文件系统就可以了，Docker并不关心底层到底是什么存储系统，它只是把它当作宿主机的一个目录，剩下的工作就和Docker挂载本地目录一样了。
* umount: 不需要解释，已经非常明了，只需要从本地文件系统umount，然后从本地设备detach。

目前Docker挂载Cinder volume的方案还挺多的，如:

* [docker cinder driver](https://github.com/j-griffith/cinder-docker-driver): Docker Volume Plugin to enable consumption of OpenStack-Cinder Block Storage with containers.
* [fuxi](https://docs.openstack.org/fuxi/latest/readme.html): Enable Docker container to use Cinder volume and Manila share.
* [REX-Ray](https://rexray.readthedocs.io/en/stable/)：storage management solution designed to support container runtimes such as Docker and Mesos.
* [Flocker](https://clusterhq.com/flocker/introduction/): Flocker is an open-source container data volume orchestrator for your Dockerized applications.

以上原理只是我们的猜想，猜想是不是成立，我们接下来通过以上方案研究实践下即可验证。

## 2 docker cinder driver实践

### 2.1 docker cinder driver简介

docker-cinder-driver是由john griffith开发的，实现了Docker挂载Cinder卷Driver。作者还写了篇专门的博客介绍[Cinder - Block Storage for things other than Nova](https://j-griffith.github.io/articles/2016-09/cinder-providing-block-storage-for-more-than-just-nova)，也可以参考作者于OpenStack Days East 2016的分享ppt[slides: Consuming Cinder from Docker](https://www.slideshare.net/jgriffith8/consuming-cinder-from-docker-65993634)以及2016年奥斯汀分享视频[cinder and docker like peanut butter and chocolate](https://www.openstack.org/videos/austin-2016/cinder-and-docker-like-peanut-butter-and-chocolate)。

### 2.2 环境准备

实验之前本人已经使用[DevStack](https://docs.openstack.org/devstack/latest/)工具部署了一个allinone OpenStack测试环境，代码基于最新的master分支，对应Cinder commit为`2b58f2bb04c229c738b5cc806575ed3503fd1bfe`。 Cinder使用LVM后端存储(backend)，配置如下:

```ini
[lvmdriver-1]
image_volume_cache_enabled = True
volume_clear = zero
lvm_type = auto
iscsi_helper = tgtadm
volume_group = stack-volumes-lvmdriver-1
volume_driver = cinder.volume.drivers.lvm.LVMVolumeDriver
volume_backend_name = lvmdriver-1

```

后续操作都是在这个DevStack环境中进行，不再强调。

docker cinder driver文档中说可以直接通过`install.sh`脚本下载:

```sh
curl -sSl https://raw.githubusercontent.com/j-griffith/cinder-docker-driver/master/install.sh | sh
```

但这样下载的可能不是最新代码编译的（亲测有坑)，为了使用最新的版本，我们只能手动编译，首先需要安装go开发环境，关于go语言开发环境可以参考[官方安装文档](https://golang.org/doc/install#install)。

ubuntu可以直接使用apt-get安装:

```sh
sudo apt-get install golang-go
```

下载cinder-docker-driver源码到本地:

```sh
git clone https://github.com/j-griffith/cinder-docker-driver
```

使用`go build`直接编译:

```sh
cd cinder-docker-driver
mkdir -p vendor/src
ln -s `pwd`/vendor/golang.org/ vendor/src
ln -s `pwd`/vendor/github.com vendor/src
export GOPATH=`pwd`/vendor
go build
```

创建配置文件，主要包含Cinder的认证信息:

```sh
mkdir -p /var/lib/cinder/dockerdriver
cat >/var/lib/cinder/dockerdriver/config.json <<EOF
{
  "Endpoint": "http://10.0.2.15/identity/v3",
  "Username": "admin",
  "Password": "nomoresecret",
  "TenantID": "ae21d957967d4df0865411f0389ed7e8",
  "DomainName": "Default",
  "Region": "RegionOne"
}
EOF
```

其中`Endpoint`为认证URL，注意包含版本`/v3`，且必须包含`DomainName`配置项。

配置完成后就可以直接运行cinder-docker-driver服务了:

```sh
nohup ./cinder-docker-driver &
tailf ./nohup
```

### 2.3 功能验证

使用docker创建一个volume，如下:

```sh
root@devstack:~# docker volume create -d cinder --name int32bit-test-1 -o size=2
int32bit-test-1
root@devstack:~# docker volume ls
DRIVER              VOLUME NAME
cinder              int32bit-test-1
```

启动一个容器并挂载`int32bit-test-1`:

```sh
root@devstack:~# docker run -t -i --rm -v int32bit-test-1:/int32bit-test-1 busybox
/ # cd /int32bit-test-1/
/int32bit-test-1 # ls
lost+found
/int32bit-test-1 # echo "HelloWorld" >hello.txt
/int32bit-test-1 # ls
hello.txt   lost+found
/int32bit-test-1 #
```

以上我们挂载刚刚创建的volume到`/int32bit-test-1`中，并写了`HelloWorld`到`hello.txt`文件中。

启动容器时cinder-docker-driver日志如下:

```
time="2017-09-29T21:29:44+08:00" level=debug msg="Found Volume ID: 58837c2b-af79-4f89-97ea-40e2622d2c52"
time="2017-09-29T21:29:44+08:00" level=debug msg="Gather up initiator IQNs..."
time="2017-09-29T21:29:44+08:00" level=debug msg="Found the following iqns: [iqn.1993-08.org.debian:01:19a8a9ca754f]"
time="2017-09-29T21:29:44+08:00" level=debug msg="Value of IPs is=[127.0.0.1/8 10.0.2.15/24 192.168.99.101/24 192.168.122.1/24 172.17.0.1/16 ::1/128 fe80::a00:27ff:fe94:2f20/64 fe80::a00:27ff:fe69:2326/64 fe80::42:bcff:fee4:89ac/64]\n"
time="2017-09-29T21:29:44+08:00" level=debug msg="Issue InitializeConnection..."
time="2017-09-29T21:29:47+08:00" level=debug msg="Create the node entry using args:  [-m node -T iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52 -p 10.0.2.15:3260]"
time="2017-09-29T21:29:47+08:00" level=debug msg="Update username to: 36eDQkERhAAKXGi8CMFC"
time="2017-09-29T21:29:47+08:00" level=debug msg="Update password to: GLFkwC6eV8abbtk8"
time="2017-09-29T21:29:48+08:00" level=info msg="Logged into iSCSI target without error: [-m node -T iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52 -p 10.0.2.15:3260 --login]"
time="2017-09-29T21:29:48+08:00" level=info msg="Waiting for path"
time="2017-09-29T21:29:49+08:00" level=debug msg="path found: /dev/disk/by-path/ip-10.0.2.15:3260-iscsi-iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52-lun-1"
time="2017-09-29T21:29:49+08:00" level=debug msg="Begin utils.getDeviceFileFromIscsiPath: /dev/disk/by-path/ip-10.0.2.15:3260-iscsi-iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52-lun-1"
time="2017-09-29T21:29:49+08:00" level=debug msg="Found device: [lrwxrwxrwx 1 root root 9 Sep 29 21:29 /dev/disk/by-path/ip-10.0.2.15:3260-iscsi-iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52-lun-1 ->  sdd\n]"
time="2017-09-29T21:29:49+08:00" level=debug msg="using base of: /dev/sdd"
time="2017-09-29T21:29:49+08:00" level=debug msg="Attached volume at (path, devfile): /dev/disk/by-path/ip-10.0.2.15:3260-iscsi-iqn.2010-10.org.openstack:volume-58837c2b-af79-4f89-97ea-40e2622d2c52-lun-1, /dev/sdd"
time="2017-09-29T21:29:49+08:00" level=debug msg="iSCSI connection done"
time="2017-09-29T21:29:49+08:00" level=debug msg="Begin utils.GetFSType: /dev/sdd"
time="2017-09-29T21:29:49+08:00" level=debug msg="Formatting device"
time="2017-09-29T21:29:49+08:00" level=debug msg="Begin utils.FormatVolume: /dev/sdd, ext4"
time="2017-09-29T21:29:49+08:00" level=debug msg="Perform mkfs.ext4 on device: /dev/sdd"
time="2017-09-29T21:29:50+08:00" level=debug msg="Result of mkfs cmd: mke2fs 1.42.13 (17-May-2015)\nCreating filesystem with 524288 4k blocks and 131072 inodes\nFilesystem UUID: 02318688-7448-4d25-98dd-0527a2bd9733
Superblock backups stored on blocks: 
	32768, 98304, 163840, 229376, 294912
	Allocating group tables: 0/16 done                            
	Writing inode tables:  0/16 done                            
	Creating journal (16384 blocks): done
	Writing superblocks and filesystem accounting information:  0/16 done"
time="2017-09-29T21:29:50+08:00" level=debug msg="Begin utils.Mount device: /dev/sdd on: /var/lib/cinder/mount/int32bit-test-1"
time="2017-09-29T21:29:50+08:00" level=debug msg="Response from mount /dev/sdd at /var/lib/cinder/mount/int32bit-test-1: "
time="2017-09-29T21:29:50+08:00" level=debug msg="Call gophercloud Attach..."
time="2017-09-29T21:29:50+08:00" level=debug msg="Attach results: {ErrResult:{Result:{Body:<nil> Header:map[] Err:<nil>}}}"
```

从日志中可以看出挂载volume本质就是通过iscsi把volume attach到本地(local attach)，格式化为ext4文件系统，然后挂载到宿主机`/var/lib/cinder/mount`目录中，与我们猜想过程基本一致。

可以通过`lsblk`确认:

```
root@devstack:~/cinder-docker-driver# lsblk -s | grep int32bit-test
sdd		8:48   0    2G  0 disk /var/lib/cinder/mount/int32bit-test-1
```

从docker容器实例中退出，此时会自动把volume从本地detach。

我们使用cinder把创建的卷手动attach到本地并挂载，关于Cinder的local attach，可参考[OpenStack中那些很少见但很有用的操作](http://int32bit.me/2017/09/25/OpenStack%E4%B8%AD%E9%82%A3%E4%BA%9B%E5%B0%91%E8%A7%81%E4%BD%86%E5%BE%88%E6%9C%89%E7%94%A8%E7%9A%84%E6%93%8D%E4%BD%9C/)。

```sh
root@devstack:~# cinder list
+--------------------------------------+-----------+-----------------+------+-------------+----------+-------------+
| ID                                   | Status    | Name            | Size | Volume Type | Bootable | Attached to |
+--------------------------------------+-----------+-----------------+------+-------------+----------+-------------+
| 58837c2b-af79-4f89-97ea-40e2622d2c52 | available | int32bit-test-1 | 2    | lvmdriver-1 | false    |             |
+--------------------------------------+-----------+-----------------+------+-------------+----------+-------------+
root@devstack:~# cinder local-attach 58837c2b-af79-4f89-97ea-40e2622d2c52
+----------+-----------------------------------+
| Property | Value                             |
+----------+-----------------------------------+
| path     | /dev/sdd                          |
| scsi_wwn | 360000000000000000e00000000010001 |
| type     | block                             |
+----------+-----------------------------------+
root@devstack:~# mount /dev/sdd /mnt
```

查看前面我们写的文件:

```sh
root@devstack:~# cat /mnt/hello.txt
HelloWorld
```

可见输出了我们通过容器写的`HelloWorld`。

通过docker cinder driver基本验证了我们之前的猜想是正确的。

## 3 fuxi

### 3.1 fuxi项目简介

[OpenStack fuxi](https://docs.openstack.org/fuxi/latest/readme.html)是一个比较新的项目，最初是从magnum项目分离出来，于2016年2月26号被OpenStack社区接受成为社区项目，目前主要由华为主导开发，其目标是使Docker容器可以使用Cinder volume和Manila share作为持久化存储卷。

### 3.2 环境准备

OpenStack环境仍然使用之前的DevStack环境，fuxi安装过程如下。

首先安装依赖的包，这些包其实DevStack基本都已经安装完成了。

```sh
sudo apt-get update
sudo apt-get install python-dev git libffi-dev libssl-dev gcc
sudo apt-get install open-iscsi
sudo apt-get install sysfsutils
```

下载fuxi源码并安装:

```sh
git clone https://github.com/openstack/fuxi.git
cd fuxi
sudo pip install -r requirements.txt
sudo python setup.py install
ln -s /lib/udev/scsi_id /usr/local/bin # for root
```

使用`generate_config_file_samples.sh`生成配置文件模板，并拷贝到`/etc/fuxi`目录下。

```sh
./tools/generate_config_file_samples.sh
sudo cp etc/fuxi.conf.sample /etc/fuxi/fuxi.conf
```

修复配置文件，最终配置文件如下:

```ini
root@devstack:~# cat /etc/fuxi/fuxi.conf  | grep -v '^#' | grep -v '^$'
[DEFAULT]
my_ip = 10.0.2.15
volume_providers = cinder
[cinder]
region_name = RegionOne
volume_connector = osbrick
fstype = ext4
auth_url = http://10.0.2.15/identity/v3
project_name = admin
project_domain_name = Default
username = admin
user_domain_name = Default
password = nomoresecret
[keystone]
[manila]
volume_connector = osbrick
auth_type = password
[nova]
```

注意`auth_url`必须包含版本，如`/v3`。

启动服务:

```sh
fuxi-server --config-file /etc/fuxi/fuxi.conf
```

### 3.3 功能验证

使用Docker创建一个volume:

```sh
$ docker volume create -d fuxi --name int32bit-test-fuxi
int32bit-test-fuxi
$ docker volume ls | grep int32bit-test-fuxi
fuxi                int32bit-test-fuxi
```

挂载volume到Docker容器中:

```sh
$ docker run -ti --rm -v int32bit-test-fuxi:/int32bit-test-fuxi busybox
/ # cd /int32bit-test-fuxi/
/int32bit-test-fuxi # ls
a           b           c           lost+found
```

我们可以验证volume其实是映射到本地路径的:

```
$ lsblk -Sf
NAME HCTL       TYPE VENDOR   MODEL             REV TRAN   NAME FSTYPE LABEL UUID                                 MOUNTPOINT
sda  2:0:0:0    disk ATA      VBOX HARDDISK    1.0  sata   sda
sdb  11:0:0:1   disk IET      VIRTUAL-DISK     0001 iscsi  sdb  ext4         d04b16a1-3392-41df-999f-e6c36b5d0cd6 /fuxi/data/cinder/int32bit-test-fuxi
sr0  1:0:0:0    rom  VBOX     CD-ROM           1.0  ata    sr0
```

由此可见，fuxi首先把Volume attach到本地，并mount到指定路径中，然后mount到Docker容器中，又和我们的猜想一致，接下来我们从源码角度分析。

### 3.4 Docker使用fuxi挂载volume源码分析

fuxi挂载是通过`fuxi/volumeprovider/cinder.py`模块的`Cinder`类实现的，该类实现了`provider.Provider`接口，而该接口就是对应前面介绍的Docker volume plugin接口。我们主要研究其mount方法:

```python
def mount(self, docker_volume_name):
    cinder_volume, state = self._get_docker_volume(docker_volume_name)
    LOG.info("Get docker volume %(d_v)s %(vol)s with state %(st)s",
             {'d_v': docker_volume_name, 'vol': cinder_volume,
              'st': state})

    connector = self._get_connector()
    if state == NOT_ATTACH:
        connector.connect_volume(cinder_volume)
    elif state == ATTACH_TO_OTHER:
        if cinder_volume.multiattach:
            connector.connect_volume(cinder_volume)
        else:
            msg = _("Volume {0} {1} is not shareable").format(
                docker_volume_name, cinder_volume)
            raise exceptions.FuxiException(msg)
    elif state != ATTACH_TO_THIS:
        msg = _("Volume %(vol_name)s %(c_vol)s is not in correct state, "
                "current state is %(state)s")
        LOG.error(msg, {'vol_name': docker_volume_name,
                        'c_vol': cinder_volume,
                        'state': state})
        raise exceptions.NotMatchedState()
...        
```

以上主要通过Cinder API获取volume信息，检查其attach情况:

* 如果volume没有attach，则直接attach。
* 如果volume已经attach（in-use）到其它主机，则检查其是否支持`multiattach`，如果支持多挂载，则直接挂载，否则抛出异常，挂载失败。
* 如果volume已经attach到当前主机，则说明已经挂载到本地了，但这不是我们所期望的，因此直接抛出异常。

假设前面都没有问题，顺利把volume attach到本地，则我们可以获取映射到本地的虚拟设备名，接下来的代码就是检查该路径是否就绪:

```python
    ...
    link_path = connector.get_device_path(cinder_volume)
    if not os.path.exists(link_path):
        LOG.warning("Could not find device link file, "
                    "so rebuild it")
        connector.disconnect_volume(cinder_volume)
        connector.connect_volume(cinder_volume)

    devpath = os.path.realpath(link_path)
    if not devpath or not os.path.exists(devpath):
        msg = _("Can't find volume device path")
        LOG.error(msg)
        raise exceptions.FuxiException(msg)
    ...
```

如果前面顺利获取的volume到设备名，比如`/dev/sdd`，则最后的工作就是mount到本地文件系统了:

```python
    ...
    mountpoint = self._get_mountpoint(docker_volume_name)
    self._create_mountpoint(mountpoint)
    fstype = cinder_volume.metadata.get('fstype', cinder_conf.fstype)
    mount.do_mount(devpath, mountpoint, fstype)
    return mountpoint
```

其中`mountpoint`是挂载的目标目录，其路径为`volume_dir + volume_type + volume_name`，其中`volume_dir`通过配置文件配置，默认为`/fuxi/data`，`volume_type`这里为`cinder`，假设volume name为`int32bit-test-volume`，则挂载路径为`/fuxi/data/cinder/int32bit-test-volume`。

`create_mountpoint`就是创建挂载目录:

```python
def _create_mountpoint(self, mountpoint):
    """Create mount point directory for Docker volume.
    :param mountpoint: The path of Docker volume.
    """
    try:
        if not os.path.exists(mountpoint) or not os.path.isdir(mountpoint):
            utils.execute('mkdir', '-p', '-m=755', mountpoint,
                          run_as_root=True)
            LOG.info("Create mountpoint %s successfully", mountpoint)
    except processutils.ProcessExecutionError as e:
        LOG.error("Error happened when create volume "
                  "directory. Error: %s", e)
        raise
```

最后调用`mount.do_mount`，`mount`是fuxi实现的一个通用的mount库，代码位于`fuxi/common/mount.py`。

```python
def do_mount(devpath, mountpoint, fstype):
    """Execute device mount operation.

    :param devpath: The path of mount device.
    :param mountpoint: The path of mount point.
    :param fstype: The file system type.
    """
    try:
        if check_already_mounted(devpath, mountpoint):
            return

        mounter = Mounter()
        mounter.mount(devpath, mountpoint, fstype)
    except exceptions.MountException:
        try:
            mounter.make_filesystem(devpath, fstype)
            mounter.mount(devpath, mountpoint, fstype)
        except exceptions.FuxiException as e:
            with excutils.save_and_reraise_exception():
                LOG.error(str(e))
```

该方法直接调用`Mounter`的mount方法，如果mount失败，则重新创建格式化文件系统后再次挂载(第一次挂载时没有安装文件系统，因此mount必然失败)。`mount`方法如下:

```python
def mount(self, devpath, mountpoint, fstype=None):
    try:
        if fstype:
            utils.execute('mount', '-t', fstype, devpath, mountpoint,
                          run_as_root=True)
        else:
            utils.execute('mount', devpath, mountpoint,
                          run_as_root=True)
    except processutils.ProcessExecutionError as e:
        msg = _("Unexpected error while mount block device. "
                "Devpath: {0}, "
                "Mountpoint: {1} "
                "Error: {2}").format(devpath, mountpoint, e)
        raise exceptions.MountException(msg)
```

由此我们通过研究源码，再次验证了我们之前的猜想是正确的。

## 4 REX-Ray

REX-Ray是一个EMC团队领导的开源项目，为Docker、Mesos及其他容器运行环境提供持续的存储访问。其设计旨在囊括通用存储、虚拟化和云平台，提供高级的存储功能。换句话说，REX-Ray进一步封装，提供一个统一的为Docker提供volume的工具，整合了各种不同的provide，如Ceph、Cinder、EBS等。但遗憾的是，目前Docker挂载Cinder卷，Docker必须安装在Nova虚拟机中，虚拟机还必须能够和OpenStack管理网打通，参考[Cinder: failed to attach volume while using cinder driver](https://github.com/codedellemc/rexray/issues/922)，因此实际使用场景有限，本文不再详细介绍。

## 5 参考文献

1. [docker extend: plugin volume](https://docs.docker.com/engine/extend/plugins_volume/).
2. [How to use OpenStack Cinder for Docker](http://superuser.openstack.org/articles/how-to-use-openstack-cinder-for-docker/).
3. [Cinder - Block Storage for things other than Nova](https://j-griffith.github.io/articles/2016-09/cinder-providing-block-storage-for-more-than-just-nova).
4. [cinder-docker-driver](https://github.com/j-griffith/cinder-docker-driver).
5. [What is Floker](https://clusterhq.com/flocker/introduction/).
6. [Rex-Ray](https://rexray.readthedocs.io/en/stable/).
7. [fuxi](https://github.com/openstack/fuxi).
8. [Cinder: failed to attach volume while using cinder driver](https://github.com/codedellemc/rexray/issues/922).
9. [OpenStack中那些很少见但很有用的操作](http://int32bit.me/2017/09/25/OpenStack%E4%B8%AD%E9%82%A3%E4%BA%9B%E5%B0%91%E8%A7%81%E4%BD%86%E5%BE%88%E6%9C%89%E7%94%A8%E7%9A%84%E6%93%8D%E4%BD%9C/).
10. [OpenStack虚拟机挂载数据卷过程分析](http://int32bit.me/2017/09/08/OpenStack%E8%99%9A%E6%8B%9F%E6%9C%BA%E6%8C%82%E8%BD%BD%E6%95%B0%E6%8D%AE%E5%8D%B7%E8%BF%87%E7%A8%8B%E5%88%86%E6%9E%90/).

**中秋节快乐!**
