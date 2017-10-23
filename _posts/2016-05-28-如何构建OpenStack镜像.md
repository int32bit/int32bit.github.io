---
layout: post
title: 如何构建OpenStack镜像
catalog: true
tags: [OpenStack]
---

本文以制作`CentOS7.2`镜像为例，详细介绍手动制作OpenStack镜像详细步骤，解释每一步这么做的原因。镜像上传到OpenStack glance，支持以下几个功能：

* 支持密码注入功能(nova boot时通过`--admin-pass`参数指定设置初始密码）
* 支持根分区自动调整(根分区自动调整为`flavor disk`大小，而不是原始镜像分区大小)
* 支持动态修改密码(使用`nova set-password`命令可以修改管理员密码)

手动制作镜像非常麻烦和耗时，本文后面会介绍一个专门用于自动化构建镜像的项目DIB，通过DIB只需要在命令行上指定elements即可制作镜像，省去了重复下载镜像、启动虚拟机配置镜像的繁杂步骤。

镜像的宿主机操作系统为`Ubuntu 14.04`，开启了`VT`功能(使用`kvm-ok`命令验证)并安装了`libvirt`系列工具，包括`virsh`、`virt-manager`、`libguestfs-tools`等。

## 1 手动制作OpenStack镜像

### 1.1 下载镜像

访问官方[镜像地址](https://www.centos.org/download/mirrors/)下载，注意选择中国的镜像源，相对国外镜像下载速度更快，进入后选择版本为`7.2.1511`，在`isos`目录下下载`x86_64`的`Minimal`镜像，如果网速不给力，最好不要选择下载`Netinstall`镜像，因为这会在安装时联网下载大量的软件包，重新安装时需要重新下载这些软件包。

### 1.2 创建虚拟机

首先创建一个qcow2格式镜像文件，用于虚拟机的根磁盘，大小10G就够了。

```bash
qemu-img create -f qcow2 centos.qcow2 10G # create disk image
```

使用以下脚本创建并启动虚拟机：

```bash
NAME=centos
ROOT_DISK=centos.qcow2
CDROM=`pwd`/CentOS-7-x86_64-Minimal-1511.iso
sudo virt-install --virt-type kvm --name $NAME --ram 1024 \
  --disk $ROOT_DISK,format=qcow2 \
  --network network=default \
  --graphics vnc,listen=0.0.0.0 --noautoconsole \
  --os-type=linux --os-variant=rhel7 \
  --cdrom=$CDROM
```

启动完成后，使用vnc client连接或者使用`virt-manager`、`virt-viewer`连接。

### 1.3 安装OS

进入虚拟机控制台可以看到CentOS的启动菜单，选择`Install Centos 7`，继续选择语言后将进入`INSTALLION SUMMARY`，其中大多数配置默认即可，`SOFTWARE SELECTION`选择`Minimal Install`，`INSTALLATION DESTINATION`需要选择手动配置分区，我们只需要一个根分区即可，不需要`swap`分区，文件系统选择`ext4`或者`xfs`，存储驱动选择`Virtio Block Device`，如图：

![分区表设置](/img/posts/如何构建OpenStack镜像/filesystem.png)

配置完成后就可以开始安装了，在`CONFIGURATION`中设置root临时密码，只需要暂时记住这个临时密码，制作完后`cloud-init`会重新设置root初始密码。

大约几分钟后，即可自动完成安装配置工作，最后点击右下角的reboot重启退出虚拟机。

### 1.4 配置OS

安装好系统后，需要进行配置才能作为glance镜像使用。首先启动虚拟机（虽然上一步执行的是reboot，但貌似并不会自动启动)：

```bash
sudo virsh start centos
```

如果云主机需要支持root ssh远程登录，需要开启root远程ssh登录功能，修改配置文件`/etc/ssh/sshd_config`并修改`PermitRootLogin`值为`yes`，重启ssh服务生效:

```bash
sudo systemctl restart sshd
```

注意：

* 不建议开启密码登录功能，使用密钥登录更安全。
* 不建议开启root远程登录。

为了加快安装速度，可以配置为本地软件源仓库，若没有本地镜像仓库，则选择国内的软件源，相对官网的速度下载要快。

```bash
mv my_repo.repo /etc/yum.repos.d/
```

#### acpid

[acpid](https://wiki.archlinux.org/index.php/acpid)是一个用户空间的服务进程, 用来处理电源相关事件,比如将kernel中的电源事件转发给应用程序，告诉应用程序安全的退出，防止应用程序异常退出导致数据损坏。libvirt可以通过向guest虚拟机发送acpid事件触发电源操作，使虚拟机安全关机、重启等操作，相对于强制执行关闭电源操作更安全。通过acpid事件发送开关机信号即我们经常所说的软重启或者软关机。

为了支持软操作，虚拟机需要安装`acpid`服务，并设置开机自启动：

```bash
yum install -y acpid
systemctl enable acpid
```

**提示:**

* 用户执行重启或者关机操作时，OpenStack会首先尝试调用libvirt的`shutdown`方法，即软关机。
* 当软关机执行失败或者超时(默认120秒)，则会调动libvirt的`destroy`方法，即强制关机，因此如果虚拟机关机或者重启很慢，很可能是acpid没有正常运行。
* 为了使虚拟机进程安全退出，减少数据损坏风险，尽量使用软操作，硬操作可能导致程序崩溃或者数据丢失。

#### console log

当操作系统内核崩溃时会报出内核系统crash出错信息，通常启动的时候一闪而过, 而此时系统还没有起来，不能通过远程工具(比如ssh)进入系统查看，我们可以通过配置grub，把这些日志重定向到Serial Console中，这样我们就可以通过Serial console来访问错误信息，以供分析和排错使用。

修改配置文件`/etc/default/grub`，设置`GRUB_CMDLINE_LINUX`，：

```bash
GRUB_CMDLINE_LINUX="crashkernel=auto console=tty0 console=ttyS0,115200n8"
```
通过这个配置，内核信息会以115200的波特率同时发送到tty0和ttyS0串行端口设备。libvirt可以通过一个普通文件模拟这个串行端口：

```xml
<serial type='file'>
      <source path='/var/lib/nova/instances/99579ce1-f4c4-4031-a56c-68e85a3d037a/console.log'/>
      <target port='0'/>
</serial>
```

这样内核产生的日志发到ttyS0，实际上写到`console.log`文件中。

OpenStack通过`nova console-log`命令可以获取该文件内容，查看错误日志。

#### qemu-guest-agent

qemu-guest-agent是运行在虚拟机内部的一个服务，libvirt会在本地创建一个unix socket，模拟为虚拟机内部的一个串口设备，从而实现了宿主机与虚拟机通信，这种方式不依赖于TCP/IP网络，实现方式简单方便。

```
<channel type='unix'>
      <source mode='bind' path='/var/lib/libvirt/qemu/org.qemu.guest_agent.0.instance-00003c2c.sock'/>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
      <address type='virtio-serial' controller='0' bus='0' port='1'/>
</channel>
```

如上宿主机的socket文件为`org.qemu.guest_agent.0.instance-00003c2c.sock`，在虚拟机内部为`/dev/virtio-ports/org.qemu.guest_agent.0`。

通过这种方式，宿主机可以发送指令写到socket文件中，虚拟机内部的qemu-guest-agent会轮询查看这个串行设备是否有指令，一旦接收到指令就可以执行对应的脚本，从而实现了宿主机控制虚拟机执行命令的功能，其中最常用的指令就是通过libvirt修改虚拟机密码。更多关于qemu-guest-agent请参考[官方文档](http://wiki.qemu.org/Features/QAPI/GuestAgent)。

为了支持OpenStack平台动态修改虚拟机密码功能，我们需要手动安装qemu-guest-agent：

```bash
yum install -y qemu-guest-agent
```

修改`/etc/sysconfig/qemu-ga`配置文件:

```
TRANSPORT_METHOD="virtio-serial"
DEVPATH="/dev/virtio-ports/org.qemu.guest_agent.0"
LOGFILE="/var/log/qemu-ga/qemu-ga.log"
PIDFILE="/var/run/qemu-ga.pid"
BLACKLIST_RPC=""
FSFREEZE_HOOK_ENABLE=0
```

可以查看qemu-guest-agent支持的指令:

```
$ virsh qemu-agent-command instance-000028d5 '{"execute":"guest-info"}' | python -m json.tool | grep 'name' | cut -d ':' -f 2 | tr -d '",'
 guest-get-memory-block-info
 guest-set-memory-blocks
 guest-get-memory-blocks
 guest-set-user-password
 guest-get-fsinfo
 guest-set-vcpus
 guest-get-vcpus
 guest-network-get-interfaces
 guest-suspend-hybrid
 guest-suspend-ram
 guest-suspend-disk
 guest-fstrim
 guest-fsfreeze-thaw
 guest-fsfreeze-freeze-list
 guest-fsfreeze-freeze
 guest-fsfreeze-status
 guest-file-flush
 guest-file-seek
 guest-file-write
 guest-file-read
 guest-file-close
 guest-file-open
 guest-shutdown
 guest-info
 guest-set-time
 guest-get-time
 guest-ping
 guest-sync
 guest-sync-delimited
```

确认包含`guest-set-user-password`指令，支持修改管理员密码。

#### zeroconf

zeroconf是一种古老的自动网络配置技术，在没有DHCP服务的年代，所有服务器都需要网管手动配置IP、hostname等，非常麻烦，zeroconf正好解决了这个问题，不过目前通常都通过DHCP获取地址了。不过一些操作系统仍然会开启这个服务，当DHCP获取IP失败时，会尝试通过zeroconf配置。

zeroconf启动时会自动创建一条路由`169.254.0.0/16`，而虚拟机访问metadata服务的地址正好是`169.254.169.254`，如果启动了zeroconf服务，由于路由冲突，虚拟机不能通过169.254.169.254路由到网络节点的metadata服务了。OpenStack虚拟机通常都是通过DHCP获取IP的，因此我们并不需要zeroconf服务。为了虚拟机能够访问metadata服务，我们必须禁止zeroconf服务，关于该问题的更详细讨论可参考[bug#983611](https://bugzilla.redhat.com/show_bug.cgi?id=983611)：

```bash
echo "NOZEROCONF=yes" >> /etc/sysconfig/network
```

#### cloud-init

接下来安装cloud-init，cloud-init是虚拟机第一次启动时执行的脚本，主要负责从metadata服务中拉取配置信息，完成虚拟机的初始化工作，比如设置主机名、初始化密码以及注入密钥等。

```bash
# yum install -y cloud-init-0.7.6-bzr1.el7.centos.noarch.rpm
yum install -y cloud-init
```

#### growpart

虚拟机制作镜像时指定了根分区大小（比如我们设置为10GB），为了使虚拟机能够自动调整为flavor disk指定的根磁盘大小，即自动扩容, 我们需要安装glowpart(老版本叫growroot)并完成以下配置：

```bash
yum update -y
yum install -y epel-release
yum install -y cloud-utils-growpart.x86.64
rpm -qa kernel | sed 's/^kernel-//'  | xargs -I {} dracut -f /boot/initramfs-{}.img {}
```

完成以上工作后，我们的镜像配置基本结束，删除一些无用文件，清理history命令后执行关机：

```bash
/sbin/shutdown -h now
```

### 1.5 移除本地信息

在宿主机上运行以下命名，移除宿主机信息，比如mac地址等。

```bash
virt-sysprep -d centos # cleanup tasks such as removing the MAC address references
```

删除虚拟机，镜像制作完成。

```bash
virsh undefine centos # 删除虚拟机
```

## 2.上传镜像

### 2.1 使用glance命令上传镜像

镜像制作完成，上传`centos.qcow2`到`glance`服务中。

```
glance image-create --file ./centos.qcow2 --disk-format qcow2 --container-format bare --name CentOS-7.2 --progress
```

### 2.2 通过rbd直接导入镜像

由于镜像通常比较大，上传时如果使用glance API,则通过HTTP上传，由于HTTP协议的限制，导致上传非常慢，非常耗时。
如果Glance使用Ceph作为存储后端，可以通过rbd直接导入(import)方式上传到Ceph中，速度会大幅度提高。

首先需要把镜像转为raw格式：

```bash
qemu-img convert -f qcow2 -O raw centos.qcow2 centos.raw
```

通过`glance create`创建一个空镜像，并记录uuid（不需要指定文件路径以及其它字段，只是占个坑）：

```
glance image-create
```

使用rbd命令直接导入镜像并创建快照：

```bash
rbd -p glance import centos.raw --image=$IMAGE_ID --new-format --order 24
rbd -p glance snap create $IMAGE_ID@snap
rbd -p glance snap protect $IMAGE_ID@snap
```

设置glance镜像location url:

```bash
FS_ID=`ceph -s | grep cluster | awk '{print $2}'`
glance location-add --url rbd://${FS_ID}/glance/${IMAGE_ID}/snap $IMAGE_ID
```

设置glance镜像其它属性：

```bash
glance image-update --name="CentOS-7.2-64bit" --disk-format=raw --container-format=bare
```

### 2.3 添加qemu-guest-agent属性

OpenStack Nova是通过判断镜像元数据`hw_qemu_guest_agent`是否为`yes`决定是否支持qemu-guest-agent，代码如下：

```python
# nova/virt/libvirt/driver.py
def _add_qga_device(self, guest, instance):
    qga = vconfig.LibvirtConfigGuestChannel()
    qga.type = "unix"
    qga.target_name = "org.qemu.guest_agent.0"
    qga.source_path = ("/var/lib/libvirt/qemu/%s.%s.sock" %
                      ("org.qemu.guest_agent.0", instance.name))
    guest.add_device(qga)

def _set_qemu_guest_agent(self, guest, flavor, instance, image_meta):
    # Enable qga only if the 'hw_qemu_guest_agent' is equal to yes
    if image_meta.properties.get('hw_qemu_guest_agent', False):
        LOG.debug("Qemu guest agent is enabled through image "
                  "metadata", instance=instance)
        self._add_qga_device(guest, instance)
    ...
```

由此可知，我们必须添加镜像property`hw_qemu_guest_agent=yes`,否则libvert启动虚拟机时不会创建qemu-guest-agent设备，虚拟机的qemu-guest-agent由于找不到对应的串行设备而导致修改密码失败。

```bash
glance image-update --property hw_qemu_guest_agent=yes $IMAGE_ID
```

## 3 DIB工具介绍

前面介绍了手动制作镜像的过程，从镜像下载到启动虚拟机安装操作系统，然后在虚拟机中完成配置，最后清除本地信息，整个过程非常繁杂、耗时，并且一旦制作镜像的镜像有点问题，就需要启动虚拟机重新再来一遍，重复工作多，效率非常低。

假设制作镜像时某个配置项错了，能不能不通过启动虚拟机进入系统去更改呢？答案是肯定的！我们只需要把制作好的镜像通过loop设备挂载到本地（如果是qcow2格式，则需要通过nbd挂载），然后chroot到挂载目录中修改配置文件即可，相对于启动虚拟机进入系统去更改方便高效很多。

由此我们自然想到，我们可以把最初启动虚拟机时安装操作系统完成后的镜像保存为base镜像，以后再做镜像时，只需要基于该base镜像调整即可，省去了下载镜像以及安装操作系统这两大耗时步骤。修改镜像也不再需要启动虚拟机，只需要根据前面介绍的方法，把镜像挂载到本地，然后chroot到根分区修改即可。

OpenStack社区正是基于该思路，开发了[DIB(disk image builder)](https://github.com/openstack/diskimage-builder)，它目前是OpenStack TripleO项目的子项目，专门用于构建OpenStack镜像：

>diskimage-builder is a flexible suite of components for building a wide-range of disk images, filesystem images and ramdisk images for use with OpenStack.
>

DIB把一些操作封装成脚本，比如创建用户(devuser)、安装cloud-init(cloud-init)、配置yum源(yum)、部署tgtadm(deploy-tgtadm)等，这些脚本称为elements，位于目录`diskimage-builder/diskimage_builder/elements`，你可以根据自己的需求自己定制elements，elements之间会有依赖，依赖通过`element-deps`文件指定，比如elements centos7的element-deps为：

```
cache-url
redhat-common
rpm-distro
source-repositories
yum
```

DIB会首先下载一个base镜像，然后通过用户指定的elements，一个一个chroot进去执行，从而完成了镜像的制作，整个过程不需要启动虚拟机。这有点类似Dockerfile的构建过程，Dockerfile的每个指令都会生成一个临时的容器，然后在容器里面执行命令。DIB则每个elements都会chroot到镜像中，执行elements中的脚本。

比如制作ubuntu 14.04镜像：

```bash
export DIB_RELEASE=trusty
disk-image-create -o ubuntu-trusty.qcow2 vm ubuntu
```

创建Trove percona镜像:

```bash
disk-image-create -a amd64 -o ubuntu-trusty-percona-5.6.33-guest-image -x ubuntu vm cloud-init-datasources ubuntu-trusty-guest ubuntu-trusty-percona
```

其中`ubuntu-trustry-guest`会安装trove-guest-agent，`ubuntu-trusty-percona`会安装percona组件。

制作镜像时可以通过环境变量进行配置，比如创建ironic镜像:

```bash
# 生成用户镜像
# ubuntu.qcow2：用户最终使用的镜像
# ubuntu.vmlinuz："Virtual Memory"的缩写，具有引导的压缩内核
# ubuntu.initrd: "initial ramdisk"的缩写，Linux系统引导过程中使用的临时根文件系统，包含基本linux命令，如ls，cd，tftp等
export DIB_DEV_USER_USERNAME=cloud-user
export DIB_DEV_USER_PASSWORD=secret
export DIB_DEV_USER_PWDLESS_SUDO=YES
DIB_CLOUD_INIT_DATASOURCES="ConfigDrive, OpenStack" disk-image-create -o centos7 centos7 baremetal dhcp-all-interfaces grub2 cloud-init-datasources devuser
```

以上制作镜像时会创建cloud-user用户，密码为secret，支持免密码sudo，cloud-init的datasources为`ConfigDriver`和`OpenStack`。

通过DIB制作镜像能够更方便地管理和维护，实现自动化构建镜像，建议OpenStack镜像都直接使用DIB构建。

## 4.功能验证

### 4.1 注入密码和密钥

使用刚刚创建的镜像启动一台云主机，如果使用nova CLI工具，需要传`--admin-pass`参数指定root密码，并指定disk大小为20G的`flavor`。如果使用OpenStack Dashborad创建，需要简单配置下dashborad使其支持配置云主机密码，如图：

![设置密码面板](/img/posts/如何构建OpenStack镜像/set_password.png)
 
创建成功后进入vnc界面，使用root账号以及设置的新密码，如果登录成功，说明注入密码成功。

在创建一个同样配额的虚拟机，指定keypair，创建完后，使用密钥登录，如果能够登录，说明密钥注入成功。

### 4.2 动态调整根磁盘分区大小

运行以下命令检查根磁盘是否自动调整分区和文件系统大小：

```bash
lsblk
df -h
```

如图：

![查看磁盘信息](/img/posts/如何构建OpenStack镜像/disk.png)

镜像原始根分区大小为10GB，如果`lsblk`显示`vda`大小为`20GB`，说明操作系统识别出根磁盘大小。如果df显示`/dev/sda1`size为20GB，说明根磁盘的分区和文件系统均自动完成了扩容操作，growpart运行正常。

### 7.4 动态修改密码

nova通过`set-password`子命令修改虚拟机管理员密码:

```bash
nova set-password ${server_uuid}
```

重复输入两次密码，如果执行成功，不会有任何输出。

回到终端，退出之前的登录，然后使用新的密码重新登录，如果登录成功，则说明动态修改密码成功！


## 5 总结

本文首先介绍了手动制作的OpenStack的镜像步骤，然后提出一种更快捷的镜像上传方法，该方法只能适用于Ceph后端，最后引入OpenStack镜像制作项目DIB，介绍了DIB的优势。

## 6 参考文献

1. [OpenStack image guid](https://docs.openstack.org/image-guide/centos-image.html).
2. [acpid](https://wiki.archlinux.org/index.php/acpid).
3. [Zero-configuration networking](https://en.wikipedia.org/wiki/Zero-configuration_networking).
4. [Qemu guest agent](https://wiki.libvirt.org/page/Qemu_guest_agent).
5. [Image building tools for OpenStack](https://github.com/openstack/diskimage-builder).
