---
layout: post
title: 手动制作Openstack镜像
subtitle: 支持密码注入、磁盘自动扩容、动态修改密码功能
catalog: true
tags:
     - Openstack
---
本文以制作`Centos7.2`镜像为例，详细介绍制作镜像的步骤，该镜像上传到Openstack Glance中，相对于官方镜像，增加如下几个功能：

* 支持密码注入功能(nova boot时通过`--admin-pass`参数指定设置初始密码）
* 支持根分区自动调整(根分区自动调整为`flavor disk`大小，而不是原始镜像分区大小)
* 支持动态修改密码(使用`nova set-password`命令可以修改管理员密码)

本文制作镜像的宿主机操作系统为`Ubuntu14.04`，开启了`VT`功能(使用`kvm-ok`命令验证）并安装了`libvirt`系列工具，包括`virsh`、`virt-manager`、`libguestfs-tools`等。

## 1.下载镜像

直接访问官方[镜像地址](https://www.centos.org/download/mirrors/)下载，注意选择中国的镜像源，相对国外镜像下载速率比较快，进入后选择版本为`7.2.1511`，在`isos`目录下下载`x86_64`的`Minimal`镜像，如果网速不给力，最好不要选择下载`Netinstall`镜像，因为这会在安装时联网下载大量的软件包，重新安装时需要重新下载这些软件包，浪费大量的时间。

## 2.创建虚拟机

首先需要创建一个qcow2格式镜像文件，用于作为虚拟机的磁盘，大小10G足矣。

```bash
qemu-img create -f qcow2 centos.qcow2 10G # create disk image
```

使用以下脚本快速创建并启动虚拟机：

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
启动完成后，使用vnc client连接，个人认为直接使用`virt-manager`或者`virt-viewer`更直接方便。

## 3. 安装OS

进入虚拟机控制台可以看到Centos的启动菜单，选择`Install Centos 7`，继续选择语言后将进入`INSTALLION SUMMARY`，其中大多数配置默认即可，`SOFTWARE SELECTION`选择`Minimal Install`，`INSTALLATION DESTINATION`需要选择手动配置分区，我们只需要一个根分区即可，不需要`swap`分区，文件系统选择`ext4`，存储驱动选择`Virtio Block Device`，如图：

![分区表设置](/img/posts/手动制作Openstack镜像/filesystem.png)

配置完成后就可以开始安装了，在`CONFIGURATION`中设置root临时密码，自己记住即可，制作完后`cloud-init`将会重新设置root初始密码。

大约几分钟后，即可自动完成安装配置工作，最后点击右下角的reboot重启退出虚拟机。

## 4. 配置OS

安装好系统后，还需要进行配置才能作为glance镜像使用。首先需要启动虚拟机（虽然上一步执行的是reboot，但貌似并不会自动启动)：

```bash
sudo virsh start centos
```

客户的云主机需要支持root ssh远程登录，因此需要开启root远程ssh登录功能，修改配置文件`/etc/ssh/sshd_config`并修改`PermitRootLogin`值为`yes`，重启ssh服务生效:

```bash
sudo systemctl restart sshd
```

接下来的所有操作均通过宿主机ssh登录到虚拟机执行，这样方便复制（默认终端不和宿主机共享粘贴缓冲区）。

为了加快安装速度，建议配置本地软件源仓库，若没有本地镜像仓库，则选择国内的软件源，会相对官网的速度下载要快，提高执行效率。

```bash
mv my_repo.repo /etc/yum.repos.d/
```

`hypervisor`通过发送对应的信号、事件等到虚拟机中，虚拟机根据接收的信号或者事件执行相应的操作，比如关机、重启等。虚拟机需要开启acpid（Advanced Configuration and Power Interface event daemon）服务，关于acpid的更多资料，参考[Arch文档中关于acpid的介绍以及使用](https://wiki.archlinux.org/index.php/acpid)。为了开启该服务，首先需要安装`acpid`服务，并设置开机自启动：

```bash
yum install -y acpid
systemctl enable acpid
```

为了方便调试排错，虚拟机需要打开boot日志功能，并指定console，这样nova console-log才能获取虚拟机启动时的日志。修改配置文件`/etc/default/grub`，设置`GRUB_CMDLINE_LINUX`为：

```
GRUB_CMDLINE_LINUX="crashkernel=auto console=tty0 console=ttyS0,115200n8"
```

Openstack动态修改root密码以及密钥，需要虚拟机内部安装agent程序，agent会创建一个虚拟串行字符设备，用于和外部qemu通信，qemu通过这个虚拟字符设备向agent发送事件指令，agent接收事件并执行相应的指令完成用户功能，更多关于qemu-guest-agent请参考[官方文档](http://wiki.qemu.org/Features/QAPI/GuestAgent)。ISO镜像中默认没有预安装agent，我们需要手动安装qemu-guest-agent：

```bash
yum install -y qemu-guest-agent
```

配置`qemu-ga`，修改`/etc/sysconfig/qemu-ga`，配置内容为:

```
TRANSPORT_METHOD="virtio-serial"
DEVPATH="/dev/virtio-ports/org.qemu.guest_agent.0"
LOGFILE="/var/log/qemu-ga/qemu-ga.log"
PIDFILE="/var/run/qemu-ga.pid"
BLACKLIST_RPC=""
FSFREEZE_HOOK_ENABLE=0
```

虚拟机需要从metadata服务中获取元数据，比如启动时的主机名、初始化密码等，为了使虚拟机能够和外部的metadata service通信，需要禁用默认的zeroconf route：

```
echo "NOZEROCONF=yes" >> /etc/sysconfig/network
```

最后安装cloud-init，cloud-init是虚拟机第一次启动时执行的脚本，主要负责从metadata服务中拉取配置信息，完成虚拟机的初始化工作，比如设置主机名、初始化密码以及注入密钥等。我们通常会实现自己的cloud-init，用来完成虚拟机的一些定制化初始化工作，如果没有自己的cloud-init，直接从官方源下载即可。

```bash
# yum install -y cloud-init-0.7.6-bzr1.el7.centos.noarch.rpm
yum install -y cloud-init
```

虚拟机制作镜像时指定了根分区大小（比如我们设置为10GB），为了使虚拟机能够自动调整为flavor disk指定的根磁盘大小，即自动扩容, 我们需要安装glowpart(老版本叫growroot)并完成以下配置：

```bash
yum update -y
yum install -y epel-release
yum install -y cloud-utils-growpart.x86.64
rpm -qa kernel | sed 's/^kernel-//'  | xargs -I {} dracut -f /boot/initramfs-{}.img {}
```

自此，镜像基本制作完成了，最后执行关机操作。

```bash
/sbin/shutdown -h now
```

## 5.清理工作

在宿主机上运行以下命名，移除宿主机信息，比如mac地址等。

```bash
virt-sysprep -d centos # cleanup tasks such as removing the MAC address references
```

最后，删除虚拟机，因为镜像已经制作完成，可以上传到glance了。

```bash
virsh undefine centos # 删除虚拟机
```

## 6.上传镜像

镜像制作完成，上传`centos.qcow2`到`glance`服务中，如果使用ceph作为存储后端，为了提高上传速度（使用glance上传走的http方式，必然很慢），我们需要另辟蹊径，我们只使用glance创建实例记录，并不使用glance上传镜像，而是借用ceph rbd的import操作实现镜像上传，包括以下几个步骤：

* 使用`qemu-img`转换qcow2格式为raw格式。

```bash
qemu-img convert -f qcow2 -O raw centos.qcow2 centos.raw
```

* 使用glance create创建一条镜像记录并记录ID（不需要指定文件路径以及其他属性，只是占个坑）

```
glance image-create
```

* 使用ceph import镜像并设置快照(glance实现）

```bash
rbd --pool=glance_images import  centos.raw  --image=$IMAGE_ID --new-format --order 24
rbd --pool=glance_images --image=$IMAGE_ID --snap=snap snap create
rbd --pool=glance_images --image=$IMAGE_ID --snap=snap snap protect
```

* 使用glance命令设置镜像的location url:

```
FS_ROOT=`ceph -s | grep cluster | awk '{print $2}'`
glance location-add --url rbd://$FS_ROOT/glance_images/$IMAGE_ID/snap $IMAGE_ID
```

* 完善镜像信息，比如name等其他属性：

```bash
glance image-update --name="centos-7.2-64bit" --disk-format=raw --container-format=bare

# 配置qemu-ga
glance image-update --property hw_qemu_guest_agent=yes $IMAGE_ID

# ... 其他属性配置
```

务必设置property的`hw_qemu_guest_agent=yes`,否则libvert启动虚拟机时不会生成qemu-ga配置项，导致虚拟机内部的qemu-ga由于找不到对应的虚拟串行字符设备而启动失败，提示找不到channel。

## 7.验证

首先使用创建的镜像启动一台新云主机（终于叫云主机，不叫虚拟机了==)，如果使用nova CLI工具，需要传递`--admin-pass`参数并指定密码,并指定`flavor`，要求`disk`大小为20GB。如果使用Openstack dashborad创建，需要简单配置下dashborad使其支持配置云主机密码面板，如图：

![设置密码面板](/img/posts/手动制作Openstack镜像/set_password.png)
 
创建成功后进入控制台，使用root账号以及设置的新密码，如果使用创建时设置的密码登录成功，说明注入密码成功。

接下来运行以下命令检查磁盘是否自动调整大小：

```bash
lsblk
df -h
```
如图：

![查看磁盘信息](/img/posts/手动制作Openstack镜像/disk.png)
镜像原始根分区大小为10GB，如果`lsblk`显示`vda`大小为`20GB`，说明文件系统自动识别了磁盘大小。如果df显示`/dev/sda1`size为20GB，说明根分区自动完成了扩容操作。

接下来测试动态修改密码，由于默认`dashboard`页面没有实现修改密码面板功能，我们需要在后台操作。

首先使用`nova list`获取云主机ID，然后调用`nova set-password`命令修改密码:

```bash
nova set-password $ID
```

重复输入两次新的密码，如果执行成功，不会有任何输出。

回到终端，退出之前的登录，然后使用新的密码重新登录，如果登录成功，则说明动态修改密码成功！

若以上其中一个步骤失败，则说明镜像制作失败，请检查以上步骤是否疏漏。
