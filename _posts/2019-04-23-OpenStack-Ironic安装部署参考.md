---
layout: post
title: OpenStack Ironic安装部署参考
catalog: true
tags: [OpenStack]
---

**注：本篇文章会涉及很多配置、脚本等流水账内容，基本无技术含量，建议有选择地参考性阅读，不建议从头到尾阅读。**

上次发布了[基于Ironic实现X86裸机自动化装机实践与优化](https://zhuanlan.zhihu.com/p/59639444)，很多人问关于Ironic安装部署的问题，其实Ironic的安装参考[官方文档](https://docs.opens    tack.org/ironic/latest/install/index.html)就够了。

如果把整个安装配置过程都写下来会特别零乱，因此本文接下来主要介绍如下几个相对问题比较多的配置，其他配置参考官方文档即可。

## 1 PXE/UEFI TFTP配置

### 1.1 TFTP服务配置

从PXE或者UEFI启动裸机需要在ironic-conductor节点配置TFTP服务器。
不同的操作系统配置不同，这里以CentOS 7.5为例，配置过程如下：

首先创建根目录，注意ironic需要有写权限：

```bash
sudo mkdir -p /tftpboot
sudo chown -R ironic /tftpboot
```

安装tftp-server以及xinetd服务：

```
sudo yum install tftp-server syslinux-tftpboot xinetd
```

修改 /etc/xinetd.d/tftp配置，指定根目录为/tftpboot：

```
service tftp
{
  protocol        = udp
  port            = 69
  socket_type     = dgram
  wait            = yes
  user            = root
  server          = /usr/sbin/in.tftpd
  server_args     = -v -v -v -v -v --map-file /tftpboot/map-file /tftpboot
  disable         = no
  # This is a workaround for Fedora, where TFTP will listen only on
  # IPv6 endpoint, if IPv4 flag is not used.
  flags           = IPv4
}
```

最后重启xinetd服务：

```
sudo systemctl restart xinetd
```

### 1.2 PXE配置

拷贝syslinux启动镜像：

```
sudo cp /usr/lib/syslinux/pxelinux.0 /tftpboot
```

如果使用whole disk镜像，则需拷贝chain.c32文件：

```
sudo cp /usr/share/syslinux/chain.c32 /tftpboot/
```

创建map-file：

```
echo 're ^(/tftpboot/) /tftpboot/\2' > /tftpboot/map-file
echo 're ^/tftpboot/ /tftpboot/' >> /tftpboot/map-file
echo 're ^(^/) /tftpboot/\1' >> /tftpboot/map-file
echo 're ^([^/]) /tftpboot/\1' >> /tftpboot/map-file
```

### 1.3 PXE UEFI配置

安装grub efi扩展包以及shim：

```
sudo yum install grub2-efi shim
```

拷贝bootloader：

```
sudo cp /boot/efi/EFI/centos/shim.efi /tftpboot/bootx64.efi
sudo cp /boot/efi/EFI/centos/grubx64.efi /tftpboot/grubx64.efi
```

创建grub配置模板：

```
GRUB_DIR=/tftpboot/EFI/centos
sudo mkdir -p $GRUB_DIR
cat >$GRUB_DIR/grub.cfg <<EOF
set default=master
set timeout=5
set hidden_timeout_quiet=false
 
menuentry "master"  {
configfile /tftpboot/$net_default_mac.conf
}
EOF
sudo chmod 644 $GRUB_DIR/grub.cfg
```

## 1.4 验证

```
su -c 'cd /tmp && tftp 197.1.50.190 -c get pxelinux.0' ironic
```

如果成功下载`pxelinux.0`到`/tmp`目录下，则tftp服务配置成功。

## 2 网络配置

其实OpenStack Ironic部署最麻烦的就是网络接入问题，整理的部分网络需求如下：

1. Conductor管理平面与Provision网络平面需要打通。
2. Conductor管理平面与裸机的IPMI带外需要打通。
3. Provision平面需要与Swift Public平面打通。
4. 如果使用Vlan网络，网络节点的出口网络（业务网口）必须是Trunk接入，裸机节点可以是Access接入。

控制节点(网络节点）两个接入的网卡名称分别为`ens1f1`、`ens4f1`，管理网卡为`ens1f1`，租户网卡为`ens4f1`，租户使用的网络模型为flat，网络类型为VLAN。

在neutron中配置provision网络和tenant网络：

```
# /etc/neutron/plugins/ml2/ml2_conf.ini
[ml2_type_flat]
flat_networks=default
```

OVS映射关系如下：

```ini
[ovs]
bridge_mappings=default:br-eth0
```

创建对应的OVS网桥：

```bash
ovs-vsctl add-br br-eth0
ovs-vsctl add-port br-eth0 ens1f1
```

安装networking-baremetal包：

```
pip install networking-baremetal
```

修改`/etc/neutron/plugins/ml2/ml2_conf.ini`配置文件，`mechanism_drivers`添加`baremetal`驱动：

```ini
[ml2]
mechanism_drivers = openvswitch,baremetal
```

创建或者修改`/etc/neutron/plugins/ml2/ironic_neutron_agent.ini`文件，添加ironic相关配置：
 
```ini
[ironic]
project_domain_name=Default
project_name=services
user_domain_name=Default
username=ironic
password=secret
auth_url=http://controller:35357
auth_plugin = password
auth_type = password
```

创建ironic-neutron-agent的systemd service文件：

```ini
[Unit]
Description=OpenStack Ironic Neutron Agent
After=syslog.target network.target network.service
PartOf=network.service
 
[Service]
Type=simple
User=neutron
PermissionsStartOnly=true
ExecStart=/usr/bin/ironic-neutron-agent --config-dir /etc/neutron --config-file /etc/neutron/plugins/ml2/ironic_neutron_agent.ini --log-file /var/log/neutron/ironic_neutron_agent.log
PrivateTmp=true
KillMode=process
Restart=on-failure
 
[Install]
WantedBy=multi-user.target
```

启动ironic-neutron-agent服务：

```
systemctl daemon-reload
systemctl enable ironic-neutron-agent
systemctl start ironic-neutron-agent
```

查看agent状态：

```
neutron agent-list | grep "Baremetal Node"
```

**注意**：只有当Ironic录入了服务器信息后才会有agent，一个Node对应一个agent进程。

## 3 Ironic Deploy相关

### 3.1 Ironic Deploy镜像准备

Ironic Deploy镜像建议直接从OpenStack官网下载，基本符合装机需求：

* [CoreOS deploy kernel](https://tarballs.openstack.org/ironic-python-agent/coreos/files/coreos_production_pxe.vmlinuz)
* [CoreOS deploy ramdisk](https://tarballs.openstack.org/ironic-python-agent/coreos/files/coreos_production_pxe_image-oem.cpio.gz)

下载完后上传到Glance，注意disk-format应选择`aki`，`container-format`参数选择`aki`而不是`bare`。

```bash
glance image-create \
--name deploy-vmlinuz \
--visibility public \
--disk-format aki \
--container-format aki < coreos_production_pxe.vmlinuz

glance image-create \
--name deploy-initrd \
--visibility public \
--disk-format ari \
--container-format ari < coreos_production_pxe_image-oem.cpio.gz
```

### 3.2 Ironic配置

部署时管理员（注意不是用户）可能需要登录initramfs查看日志、排查错误、重启IPA(ironic python agent)等，下载的CoreOS镜像没有提供默认密码，也没有安装cloud-init，一旦有问题，需要通过SSH或者PXE Console登录。方法如下：

* ssh登录：注入ssh key，修改ironic配置文件，`pxe_append_params`追加`sshkey="ssh-rsa AAAA..."`参数。注意只需要拷贝公钥，不需要拷贝后面的主机名信息`xxx@hostname`，比如`~/.ssh/id_rsa.pub`文件内容如果是这样：

```
ssh-rsa AAAAB3Nza...Ui5 root@localhost
```

则拷贝的内容应该是：

```
ssh-rsa AAAAB3Nza...Ui5
```

去掉后面`root@localhost`。

* console登录：如果网络不通，则必须通过PXE console登录，由于不知道登录密码，无法登录。可以通过配置`autologin`参数跳过登录页面实现自动登录，只需要在`pxe_append_params`追加`"coreos.autologin"`。

另外为了便于调试，可以打开IPA的`DEDUG`功能，在`pxe_append_params`追加`"ipa-debug=1"`。

综合如上配置，配置样例如下:

```ini
# /etc/ironic/ironic.conf
[pxe]
pxe_append_params = nofb nomodeset vga=normal coreos.autologin ipa-debug=1 sshkey="ssh-dss AAAA..."
```

### 3.3 Deploy操作系统调试

如果装机进入了Deploy操作系统但不是很顺利，node状态堵塞在`deploy wait`，则很可能是IPA有问题，或者网络不通，需要进入CoreOS系统查看IPA日志：

```bash
journalctl -xeu ironic-python-agent
```

查看ironic-python-agent代码:

```bash
cd /opt/ironic-python-agent/usr/local/lib/python2.7/disk-packages/ironic_python_agent
```

手动启动IPA服务，系统默认没有安装python，需要chroot到`/opt/ironic-python-agent`：

```bash
/usr/bin/chroot /opt/ironic-python-agent env PATH=/sbin:/usr/sbin:/bin:/usr/bin:$PATH /usr/local/bin/ironic-python-agent
```

重启IPA服务：

```bash
systemctl restart ironic-python-agent
```

另外ironic-python-agent配置通过`cmdline`传递，可查看参数：

```bash
cat /proc/cmdline
```

另外如果使用虚拟机镜像转化为裸机镜像，由于没有安装UEFI驱动，因此只支持Legacy BIOS启动方式，需要在BIOS里提前配置，否则可能出现装机完后系统起不来。

## 4 裸机console配置

配置之前先确保带外IPMI的`Serial On Lan`开启并且`Serial Command Line Interface Speed`为`115200`，并且镜像开启了`tty console`，如果使用DIB制作镜像，必须包含`enable-serial-console` element，已有镜像可根据如下脚本修改：

```bash
#!/bin/bash
set -eu
set -o pipefail
INIT_SYSTEM="systemd"  
cat >./serial-console-udev.rules <<EOF
SUBSYSTEM=="tty", ACTION=="add", TAG+="systemd", ENV{SYSTEMD_WANTS}+="getty@\$name.service", ATTRS{type}=="4"' ./serial-console-udev.rules
EOF
 
install -D -g root -o root -m 0644 ./serial-console-udev.rules /etc/udev/rules.d/99-serial-console.rules
  
if [ -f $BOOTDIR/grub/grub.conf ] ; then
    sed -i -e "/^splashimage/d;s/ rhgb\( \|$\)/\1/g;s/ quiet\( \|$\)/\1/g;/^serial/d;/^terminal/d;/^hiddenmenu/d" $BOOTDIR/grub/grub.conf
    sed -i "/^default/aserial --unit=0 --speed=9600 --word=8 --parity=no --stop=1\nterminal --timeout=5 serial console" $BOOTDIR/grub/grub.conf
fi
```

安装openstack-nova-serialproxy：

```bash
yum install openstack-nova-serial
```

修改`/etc/nova/nova.conf`，添加serial-console配置：

```ini
[serial_console]
serialproxy_host = 0.0.0.0
serialproxy_port = 6083
enabled = True
base_url = ws://197.1.50.190:6083/
proxyclient_address = 197.1.50.190 # 填计算节点的IP，端口不用填，因为端口是动态分配的。
port_range = 10000:20000
```

ironic添加pxe参数：

```ini
[DEFAULT]
enabled_console_interfaces = ipmitool-socat,no-console
...
[pxe]
pxe_append_params = nofb nomodeset vga=normal coreos.autologin ipa-debug=1 console=ttyS0,115200n8 ...
...
```

启动nova-serialproxy服务:

```bash
systemctl start openstack-nova-serialproxy
```

配置node console信息:

```bash
ironic node-update $NODE_UUID add \
    driver_info/ipmi_terminal_port=15900 # 分配一个没有使用的端口
ironic node-set-console-mode #NODE_UUID 1
```

查看console信息：

```bash
# ironic node-get-console node-1
+-----------------+----------------------------------------------------------+
| Property        | Value                                                    |
+-----------------+----------------------------------------------------------+
| console_enabled | True                                                     |
| console_info    | {u'url': u'tcp://197.1.50.190:15900', u'type': u'socat'} |
+-----------------+----------------------------------------------------------+

```

## 5 Ironic ConfigDrive配置以及Bond支持

### 5.1 镜像配置

由于ironic无法篡改nova创建的metadata，因此bond相关配置必须通过configdrive传递。

首先cloud-init必须配置datasource支持ConfigDrive，如果使用DIB制作镜像，则需要配置`DIB_CLOUD_INIT_DATASOURCES="ConfigDrive, OpenStack"`，参考deploy镜像配置。

```
DIB_CLOUD_INIT_DATASOURCES="ConfigDrive, OpenStack" disk-image-create -o fedora-cloud-image fedora baremetal
```

### 5.2 ConfigDrive配置

裸机和虚拟机不一样，configdrive不能通过raw设备挂载，因此我们必须安装Swift对象存储，ironic会把ConfigDrive的网络配置信息上传到Swift，在provision阶段IPA会自动从Swift下载这些数据，并刻到根磁盘的第一个分区（比如/dev/sda1），并命名该分区的label为config-2，在裸机起来后可以手动挂载config drive：

```
mount /dev/disk/by-label/config-2 /mnt
```

ironic配置使用Config Drive之前请保证Swift已经配置好，并且provision网络可以访问Swift。

修改`/etc/ironic/ironic.conf`配置文件，在deploy配置组添加如下配置：

```ini
[deploy]
...
configdrive_use_object_store = True
[conductor]
...
configdrive_use_swift=True
```

添加swift配置：

```ini
[swift]
auth_url=http://controller:35357
auth_plugin = password
username=admin
user_domain_name=Default
password = secret
project_name = admin
project_domain_name = Default
service_name = swift
service_type = object-store
```

重启openstack-ironic-api和openstack-ironic-conductor服务。

```
systemctl restart openstack-ironic-api
systemctl restart openstack-ironic-conductor
```

使用nova启动裸机时，添加 `--config-drive true`：

```
nova boot --config-drive true --image $IMAGE --flavor $FLAVOR --nic net-id=$NETWORK --key-name=$KEY_NAME int32bit-test-$COUNT
```

### 5.3 Bond配置

```
#!/bin/bash
PORT_GROUP_NAME=bond0 # bond名称
NODE_UUID=fcac663c-ac07-4dd0-b61b-5efd86642ad0 # node uuid
MAC1=14:02:ec:72:8c:18 # 第一个网卡MAC
MAC2=14:02:ec:72:74:68 # 第二个网卡MAC
openstack baremetal port group create \
--node $NODE_UUID \
--name $PORT_GROUP_NAME \
--address $MAC1 --support-standalone-ports # MAC地址使用其中一个网卡地址
GROUP_UUID=$(openstack baremetal port group list | grep "$PORT_GROUP_NAME" | awk -F '[| ]' '{print $3}')
ironic node-set-maintenance --reason "Set port group" $NODE_UUID true # 置维护
for port in $(ironic port-list | grep -P "($MAC1|$MAC2)" | awk -F '[| ]' '{print $3}'); do
    echo ironic port-update $port replace portgroup_uuid=$GROUP_UUID
    ironic port-update $port replace portgroup_uuid=$GROUP_UUID
done
ironic node-set-maintenance $NODE_UUID false
```

## 参考文献

* [0] [Dynamic-login DIB element](https://github.com/openstack/diskimage-builder/tree/master/elements/dynamic-login).
* [1] [DevUser DIB element](https://github.com/openstack/diskimage-builder/tree/master/elements/devuser).
* [2] [Add User to CoreOS](https://coreos.com/os/docs/latest/adding-users.html).
* [3] [IPA image build reference](https://github.com/openstack/ironic-python-agent/tree/master/imagebuild/coreos/README.rst)
* [4] [Booting CoreOS via PXE](https://coreos.com/os/docs/latest/booting-with-pxe.html).
* [5] [Install docker engine](https://docs.docker.com/engine/installation/).
