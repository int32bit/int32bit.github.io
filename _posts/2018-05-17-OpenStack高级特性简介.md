---
layout: post
title: OpenStack高级特性简介
tags: [OpenStack]
catalog: true
---

在[OpenStack中那些很少见但很有用的操作](https://zhuanlan.zhihu.com/p/29760981)中介绍了一些很少提及但很有用的功能，本文在此基础上介绍几个OpenStack的几个高级特性。这里所谓的高级特性，是指那些非人人都需要的OpenStack通用默认配置，而是专门针对一些特定场景需求设定的。

## 1 虚拟机软删除

通常情况下，当用户删除虚拟机时，虚拟机会立即从hypervisor底层删除，不可撤回。为了防止人为误操作，Nova支持开启软删除(soft delete)功能，或者称为延迟删除，延迟删除时间通过Nova配置项`/etc/nova/nova.conf`的`reclaim_instance_interval`项指定，如下:

```ini
[DEFAULT]
...
reclaim_instance_interval = 120
```

此时虚拟机执行普通删除操作时，nova不会立即删除虚拟机，而是会等待两分钟的时间，在此时间间隔内，管理员可以随时恢复虚拟机，只有在超过120秒后虚拟机才会真正执行删除操作，不可恢复。

为了演示该功能，我们删除一台虚拟机`int32bit-test-2`:

```
# nova list
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
| ID                                   | Name            | Status | Task State | Power State | Networks          |
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
| 8f082394-ffd2-47db-9837-a8cbd1e011a1 | int32bit-test-1 | ACTIVE | -          | Running     | private=10.0.0.6  |
| 9ef2eea4-77dc-4994-a2d3-a7bc59400d22 | int32bit-test-2 | ACTIVE | -          | Running     | private=10.0.0.13 |
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
# nova delete 9ef2eea4-77dc-4994-a2d3-a7bc59400d22
Request to delete server 9ef2eea4-77dc-4994-a2d3-a7bc59400d22 has been accepted.
```

通过`nova list`命令并指定`--deleted`选项可以列出已删除的所有虚拟机实例:

```
# nova list --deleted | grep -i soft_delete
| 9ef2eea4-77dc-4994-a2d3-a7bc59400d22 | int32bit-test-2 | SOFT_DELETED | -          | Shutdown    | private=10.0.0.13 |
```

通过`nova restore`命令可以恢复虚拟机：

```
# nova restore 9ef2eea4-77dc-4994-a2d3-a7bc59400d22
# nova list
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
| ID                                   | Name            | Status | Task State | Power State | Networks          |
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
| 8f082394-ffd2-47db-9837-a8cbd1e011a1 | int32bit-test-1 | ACTIVE | -          | Running     | private=10.0.0.6  |
| 9ef2eea4-77dc-4994-a2d3-a7bc59400d22 | int32bit-test-2 | ACTIVE | -          | Running     | private=10.0.0.13 |
+--------------------------------------+-----------------+--------+------------+-------------+-------------------+
```

可见，刚刚删除的虚拟机已经恢复了。

注意如果管理员通过`nova force-delete`命令强制删除虚拟机，虚拟机会立即从底层删除而无视延迟时间。

需要注意的是，由于这个功能早期设计的缺陷，开启虚拟机软删除功能必须保证所有计算节点和API节点配置一样并且时间同步，并且所有节点的延迟时间不可动态修改，这非常不灵活。我在我们内部私有云二次开发中改善了该功能，延时时间不再通过配置文件指定，而是通过虚拟机的admin metadata指定，这样就不再依赖于各个节点的配置项的同步与更新，并且可随时调整延时时间。

## 2 CPU拓扑以及核绑定

### 2.1 概述

OpenStack K版本引入了许多CPU高级特性功能，不仅支持自定义CPU拓扑功能，支持设置虚拟机CPU的socket、core、threads等，还支持CPU pinning功能，即CPU核绑定，甚至能够配置虚拟机独占物理CPU，虚拟机的vCPU能够固定绑定到宿主机的指定pCPU上，在整个运行期间，不会发生CPU浮动，减少CPU切换开销，提高虚拟机的计算性能。除此之外，OpenStack还支持设置threads policy，能够利用宿主机的SMT特性进一步优化虚拟机的性能。

接下来简单介绍下如何配置OpenStack的CPU高级特性。


### 2.2 规划CPU和内存

在配置之前，首先需要规划计算节点的CPU和内存，哪些CPU分配给虚拟机，哪些CPU给宿主机本身的进程预留，预留多少内存等。为了性能的最优化，还需要考虑宿主机CPU的NUMA架构。

在Linux环境下可以通过以下命令查看CPU信息:

```
$ lscpu
Architecture:          x86_64
CPU op-mode(s):        32-bit, 64-bit
Byte Order:            Little Endian
CPU(s):                40
On-line CPU(s) list:   0-39
Thread(s) per core:    2
Core(s) per socket:    10
Socket(s):             2
NUMA node(s):          2
Vendor ID:             GenuineIntel
CPU family:            6
Model:                 63
Model name:            Intel(R) Xeon(R) CPU E5-2650 v3 @ 2.30GHz
Stepping:              2
CPU MHz:               1201.480
BogoMIPS:              4603.87
Virtualization:        VT-x
L1d cache:             32K
L1i cache:             32K
L2 cache:              256K
L3 cache:              25600K
NUMA node0 CPU(s):     0,2,4,6,8,10,12,14,16,18,20,22,24,26,28,30,32,34,36,38
NUMA node1 CPU(s):     1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39
```

由以上信息可知，该宿主机一共两个CPU（socket)，每个CPU 10核(core)，每个核可以开启两个超线程(thread)，即一共有40个逻辑CPU，包含两个NUMA node，其中node0包括0，2，4，...,38，node1包括1,3,5,...,39。

预留CPU个数和内存需要根据实际情况调整，比如若计算节点和存储节点融合，则需要预留更多的CPU来保证存储服务的性能。

本例子仅作为测试使用，测试环境预留了4个逻辑CPU(1-3)和4GB物理内存给宿主机，剩下的资源全部分配给虚拟机使用。

配置虚拟机使用的CPU集合(cpuset)是通过计算节点的`vcpu_pin_set`配置项指定，目前支持以下三种语法格式:

* 1,2,3 # 指定CPU号，逗号隔开。
* 2-15, 18-31 # 使用-表示连续CPU序列，使用逗号分隔。
* ^0,^1,^2,^3 # 使用`^`表示排除的CPU号，剩下的全部作为虚拟机使用。

以上三种语法格式可以组合使用。

compute节点Nova参考配置如下:

```ini
# /etc/nova/nova.conf
[DEFAULT]
...
vcpu_pin_set = ^0,^1,^2,^3
reserved_host_memory_mb = 4096
...
```

如果需要配置虚拟机CPU独占，则还需要配置内核参数`isolcpu`来限制其他进程使用指定的CPU。比如我们需要把CPU 2,3,6,7作为CPU pinning给虚拟机独占，设置如下:

```bash
grubby --update-kernel=ALL --args="isolcpus=2,3,6,7"
```

重新安装grub:

```bash
grub2-install /dev/sda
```

重启宿主机:

```bash
reboot
```

下次系统启动时会默认添加如下内核参数：

```
linux /vmlinuz-xxx root=xxx ... isolcpus=2,3,6,7
```

在nova-scheduler节点上，需要配置默认filter，filters中必须包含`AggregateInstanceExtraSpecFilter`和`NUMATopologyFilter`这两个filter：

```ini
# /etc/nova/nova.conf
[DEFAULT]
scheduler_default_filters=NUMATopologyFilter,AggregateInstanceExtraSpecsFilter,...
```

配置完重启所有的nova-scheduler服务:

```bash
systemctl restart openstack-nova-scheduler
```


### 2.3 创建主机集合

在实际环境中肯定不是所有的计算节点都开启这些高级功能，并且CPU特性也有差别，我们可以通过主机集合（host aggregate)把所有相同的CPU配置放到一个集合中，通过主机集合(host aggregate)区分哪些计算节点开启CPU核绑定功能，哪些不开启。

首先创建pinned-cpu主机集合:

```bash
nova aggregate-create pinned-cpu
```

增加metadata区分pinned:

```bash
nova aggregate-set-metadata pinned-cpu pinned=true
```

把配置开启了CPU核绑定功能的两个host加到该主机集合中:

```bash
 nova aggregate-add-host pinned-cpu server-1
 nova aggregate-add-host pinned-cpu server-2
```

此时nova scheduler只要接收到包含`pinned=true`元数据的请求就会自动从包含`pinned=true`元数据的主机中调度。

### 2.4 创建flavor

目前Nova并不支持启动时直接指定主机集合的metadata（hint只支持指定server group），需要通过flavor的extra specs配置，并与主机集合的metadata匹配，不匹配的主机将被过滤掉，不会被选择作为候选主机。

flavor支持很多内置的extra specs，通过内置extra specs，可以配置虚拟机的CPU拓扑、QoS、CPU pinning策略、NUMA拓扑以及PCI passthrough等，更详细的介绍可参考[官方文档](http://docs.openstack.org/admin-guide/compute-flavors.html)。这里我们只关心CPU拓扑和核绑定功能。

如下是设置CPU topology的语法，自定义CPU的socket数量、core数量以及超线程数量：

```
$ nova flavor-key FLAVOR-NAME set \
    hw:cpu_sockets=FLAVOR-SOCKETS \
    hw:cpu_cores=FLAVOR-CORES \
    hw:cpu_threads=FLAVOR-THREADS \
    hw:cpu_max_sockets=FLAVOR-SOCKETS \
    hw:cpu_max_cores=FLAVOR-CORES \
    hw:cpu_max_threads=FLAVOR-THREADS
```

**注意以上配置项不需要全部设置，只需要设置其中一个或者几个，剩余的值会自动计算。**

CPU核绑定配置语法如下:

```
$ nova flavor-key set FLAVOR-NAME \
    hw:cpu_policy=CPU-POLICY \
    hw:cpu_thread_policy=CPU-THREAD-POLICY
```

其中`CPU-POLICY`合法值为`shared`、`dedicated`，默认为`shared`，即不进行CPU核绑定，我们需要把这个值设置为`dedicated`。
`CPU-THREAD-POLICY`和SMT有关，合法值为:

* prefer: 宿主机不一定需要符合SMT架构，如果宿主机具备SMT架构，将优先分配thread siblings。
* isolate: 宿主机SMT架构不是必须的，如果宿主机不具备SMT架构，每个vCPU将绑定不同的pCPU，如果宿主机是SMT架构的，每个vCPU绑定不同的物理核。
* require: 宿主机必须满足SMT架构，每个vCPU在不同的thread siblins上分配，如果宿主机不具备SMT架构或者core的空闲thread siblings不满足请求的vCPU数量，将导致调度失败。

通常设置成默认值`prefer`或者`isolate`即可。

接下来开始创建flavor，设置为8个CPU、2GB内存以及20GB磁盘空间：

```bash
nova flavor-create m1.xlarge.pinned 100 2048 20 8
```

设置CPU Policy：

```bash
nova flavor-key m1.xlarge.pinned set hw:cpu_policy=dedicated
```

添加pinned相关的extra specs用于匹配主机集合metadata，保证调度时只选择开启了核绑定的宿主机:

```bash
nova flavor-key m1.xlarge.pinned set aggregate_instance_extra_specs:pinned=true
```

配置CPU拓扑为2 sockets * 2 cores * 2 threads:

```sh
nova flavor-key m1.xlarge.pinned set \
    hw:cpu_sockets=2 \
    hw:cpu_cores=2 \
    hw:cpu_threads=2
```


查看flavor的extra specs信息:

```json
# nova flavor-show m1.xlarge.pinned  | awk -F '|' '/extra_specs/{print $3}' | python -m json.tool
{
    "aggregate_instance_extra_specs:pinned": "true",
    "hw:cpu_cores": "2",
    "hw:cpu_policy": "dedicated",
    "hw:cpu_sockets": "2",
    "hw:cpu_threads": "2"
}
```


### 2.5 功能验证

使用新创建的Flavor创建虚拟机:

```sh
nova boot  int32bit-test-pinning \
	--flavor m1.xlarge.pinned  \
	--image 16b79884-77f2-44f5-a6d7-6fcc30651283\
	--nic net-id=ed88dc5a-61d8-4f99-9532-8c68e5ec5b9e
```

使用nova-show命令查看虚拟机所在的宿主机，在该宿主机上查看虚拟机的xml文件:

```bash
virsh dumpxml 306abd22-28c5-4f91-a5ce-0dad03a35f49
```

其中`306abd22-28c5-4f91-a5ce-0dad03a35f4`为虚拟机的uuid。

在xml文件中可以看到如下内容:

```xml
<vcpu placement='static'>8</vcpu>
<cputune>
<vcpupin vcpu='0' cpuset='25'/>
<vcpupin vcpu='1' cpuset='5'/>
<vcpupin vcpu='2' cpuset='8'/>
<vcpupin vcpu='3' cpuset='28'/>
<vcpupin vcpu='4' cpuset='9'/>
<vcpupin vcpu='5' cpuset='29'/>
<vcpupin vcpu='6' cpuset='24'/>
<vcpupin vcpu='7' cpuset='4'/>
<emulatorpin cpuset='4-5,8-9,24-25,28-29'/>
</cputune>
```

即vCPU与pCPU的绑定关系。

进入虚拟机中查看CPU信息结果如下:

```
# lscpu
Architecture:          x86_64
CPU op-mode(s):        32-bit, 64-bit
Byte Order:            Little Endian
CPU(s):                2
On-line CPU(s) list:   0,1
Thread(s) per core:    2
Core(s) per socket:    2
Socket(s):             2
NUMA node(s):          1
Vendor ID:             GenuineIntel
...
```

和我们配置的结果一样(2 sockets * 2 cores * 2 threads)。

在虚拟机上执行高密度计算，测试的Python脚本如下:

```python
# test_compute.py
k = 0
for i in xrange(1, 100000):
	for j in xrange(1, 100000):
		k = k + i * j
		
```

使用shell脚本同时跑50个进程，保证CPU满载运行:

```bash
for i in `seq 1 50`; do
	python test_compute.py &
done
```

使用sar命令查看宿主机CPU使用情况:

```bash
sar -P ALL 1 100
```

结果如下:

```
Linux 3.10.0-229.20.1.el7.x86_64 (8409a4dcbe1d11af)     05/10/2018      _x86_64_        (40 CPU)

10:20:14 PM     CPU     %user     %nice   %system   %iowait    %steal     %idle
10:20:15 PM     all     20.48      0.00      0.15      0.03      0.00     79.34
10:20:15 PM       0      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM       1      0.99      0.00      0.00      0.00      0.00     99.01
10:20:15 PM       2      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM       3      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM       4    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM       5    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM       6      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM       7      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM       8    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM       9    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM      10      1.01      0.00      0.00      0.00      0.00     98.99
10:20:15 PM      11      1.00      0.00      0.00      0.00      0.00     99.00
10:20:15 PM      12      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      13      0.00      0.00      0.99      0.00      0.00     99.01
10:20:15 PM      14      0.99      0.00      0.99      0.00      0.00     98.02
10:20:15 PM      15      1.00      0.00      0.00      0.00      0.00     99.00
10:20:15 PM      16      0.99      0.00      0.99      0.00      0.00     98.02
10:20:15 PM      17      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      18      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      19      3.96      0.00      0.99      0.00      0.00     95.05
10:20:15 PM      20      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      21      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      22      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      23      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      24    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM      25    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM      26      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      27      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      28    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM      29    100.00      0.00      0.00      0.00      0.00      0.00
10:20:15 PM      30      2.00      0.00      0.00      0.00      0.00     98.00
10:20:15 PM      31      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      32      2.97      0.00      0.99      0.00      0.00     96.04
10:20:15 PM      33      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      34      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      35      1.00      0.00      0.00      0.00      0.00     99.00
10:20:15 PM      36      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      37      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      38      0.00      0.00      0.00      0.00      0.00    100.00
10:20:15 PM      39      0.00      0.00      0.00      0.00      0.00    100.00
```

从CPU使用情况看宿主机的pCPU 4-5，8-9，24-25，28-29使用率100%，并且整个过程中没有浮动，符合我们的预期结果，说明CPU核绑定成功。

## 3 虚拟化嵌套

### 3.1 开启虚拟化嵌套

默认情况下我们创建的KVM虚拟机的CPU特性中没有包含vmx，这意味着不能在虚拟机中再创建开启KVM硬件加速的虚拟机，即不支持虚拟化嵌套。值得庆幸的是，目前除了VirtualBox(题外话：VirtualBox在9年前就有人提出要支持嵌套，只是一直没有实现，参考ticket [#4032](https://www.virtualbox.org/ticket/4032))，主流的hypervisor比如VMware、KVM、Xen都支持已经虚拟化嵌套。也就是说，我们可以实现在支持KVM的宿主机创建同样支持KVM的虚拟机。

这里以KVM为例，首先查看系统是否开启了KVM嵌套功能:

```sh
cat /sys/module/kvm_intel/parameters/nested 
```

如果输出为`N`则表明没有开启KVM嵌套功能，可以通过修改`/etc/modprobe.d/kvm-intel.conf
`配置文件开启该功能：

```
options kvm-intel nested=1
```

重新加载kvm-intel内核模块:

```
rmmod kvm_intel
modprobe kvm_intel
```

### 3.2 配置计算节点

OpenStack支持虚拟化嵌套，修改计算节点的nova配置文件`/etc/nova/nova.conf`，设置`cpu_mode = host-passthrough`，然后重启nova-compute服务即可。

需要注意的是，使用`host-passthrough`的虚拟机迁移功能受限，只能迁移到相同配置的宿主机。

## 4 使用virtio-scsi驱动

### 4.1 virtio-blk VS virtio-scsi

虚拟机的虚拟硬盘默认使用半虚拟化驱动virt-blk，此时硬盘在虚拟机的设备名称形如`/dev/vda`、`/dev/vdb`等。

事实上，`virt-blk`有点老了，其本身也存在许多问题，比如:

* `virt-blk`的存储设备和PCI设备一一对应，而我们知道系统中至多可以有32个PCI总线，这说明虚拟机最多可以挂32个虚拟硬盘。
* `virt-blk`的设备名称为`vd[a-z]`，而现代的物理机通常都会使用SCSI控制器，设备名称为`sd[a-z]`，这意味着物理机迁移到虚拟机中可能存在问题，比如fstab中使用的设备名挂载而不是uuid，系统就会起不来。
* 如[WIKI](https://wiki.qemu.org/images/c/c2/Virtio-scsi.pdf)所言，virt-blk实现的指令不是标准的，并且可扩展差，实现一个新的指令，必须更新所有的guest。
* 云计算架构模式下，为了节省存储空间，用户更倾向于使用精简置备(thin provision)，`virtio-blk`不支持`discard`特性，关于`discard`特性后面讲。

因此，建议使用`virtio-scsi`半虚拟化驱动代替`virtio-blk`，这是因为:

* 实现的是标准的SCSI指令接口，不需要额外实现指令，在虚拟机里看到的设备名称和物理机一样(`sd[a-z]`)，解决了前面提到的物理机和虚拟机设备名不一样的问题。
* 一个SCSI控制器可以接256个targets，而一个target可以接16384个LUNs，也就是说一个controller理论上可以挂载`256 * 16384 == 4194304`个虚拟机硬盘，这100%足够了。
* virtio-scsi支持直通模式(passthrough)，也就是说可以把物理机的硬盘直接映射给虚拟机。
* virtio-scsi支持前面提到的`discard`特性。

### 4.2 块设备的discard功能

前面提到块设备的`discard`特性，这个主要和精简置备有关，就拿Ceph RBD说，我们知道当我们分配一个20GB的image时，Ceph并不会真正分配20GB的存储空间，而是根据需要逐块分配，这和Linux的sparse稀疏文件的原理是一样的，这个特性节省了物理存储空间，实现了硬盘的超售。然而，Ceph只知道上层文件系统需要空间时就分配，而并不知道上层文件系统如何使用存储资源的（实际上也不关心）。而实际上，我们的文件系统肯定是频繁创建文件、删除文件的，删除文件后按理说是可以释放物理存储资源的，然而Ceph并不知道，所以不会回收，占据的存储空间会越来越多，直到空间达到真实的分配空间大小(20GB)，而文件系统层可能并没有真正使用那么多空间，这就造成了存储空间利用率下降的问题。比如，我们创建了一个5GB的文件，Ceph底层会分配5GB的空间，此时我们把这个5GB的文件删除，分配的这5GB空间并不会释放。好在Linux支持`fstrim`，如果块设备支持`discard`特性，文件系统会发送flush通知给底层块设备(RBD)，块设备会回收空闲资源。Sébastien Han写了一篇博客关于ceph discard的，参考[ceph and krbd discard](http://www.sebastien-han.fr/blog/2015/01/26/ceph-and-krbd-discard/)。

正如前面所言，`virt-blk`是不支持`discard`的，而`virt-scsi`支持，所以如果关心底层存储的空间利用率，建议使用`virt-scsi`，并在挂载设备中指定`discard`参数(或者写到`fstab`中):

```
mount -o discard /dev/rbd0 /mnt/
```

但是需要注意的是，任何事物都具有两面性，既有优点，也存在缺点:

* `virio-scsi`相对`virtio-blk` IO路径会更复杂，性能可能会有所下降，参考[virtio-blk vs virtio-scsi](https://mpolednik.github.io/2017/01/23/virtio-blk-vs-virtio-scsi/)。
* 通过`mount`命令挂载虚拟硬盘时开启`discard`特性会降低文件系统的读写性能。

### 4.3 OpenStack使用virtio-scsi驱动

前面讲了那么多关于`virio-blk`以及`virtio-scsi`，那怎么在OpenStack中使用`virtio-scsi`呢？很简单，只需要设置Glance镜像的`property`就可以了:

```sh
glance image-update \
    --property hw_scsi_model=virtio-scsi \
    --property hw_disk_bus=scsi \
    ${IMAGE_UUID}
```

通过这个配置不仅使根磁盘会使用`virtio-scsi`驱动，挂载新的Cinder volume也会默认使用`virtio-scsi`驱动。

需要注意的是，制作OpenStack镜像时一定要保证initrd中包含virtio-scsi驱动，否则操作系统会由于在初始化时不识别SCSI块设备导致启动失败:

```
zcat /boot/initrd-3.0.101-63-default | cpio -it | grep virtio-scsi
```

如果镜像的initrd没有virtio驱动，可以编辑`/etc/sysconfig/kernel`文件，配置`INITRD_MODULES`参数：

```
INITRD_MODULES = ... virtio,virtio_net,virtio_blk,virtio_pci,virtio_scsi ...
```

然后重新生成initrd文件:

```
mkinitrd
```

启动虚拟机后，如果根硬盘的设备名称为`/dev/sda`，则说明使用的是`virtio-scsi`驱动。

## 5 使用qemu-guest-agent

### 5.1 qemu-guest-agent简介

我们都知道OpenStack虚拟机启动时是通过cloud-init完成初始化配置的，比如网卡配置、主机名配置、注入用户密码等。而虚拟机启动之后处于运行状态时，外部如何与虚拟机通信呢，这就是qemu-guest-agent要完成的事，这其实在[如何构建OpenStack镜像](http://int32bit.me/2016/05/28/%E5%A6%82%E4%BD%95%E6%9E%84%E5%BB%BAOpenStack%E9%95%9C%E5%83%8F/)一文中已经介绍过，这里直接搬过来。

qemu-guest-agent是运行在虚拟机的一个daemon服务，libvirt会在宿主机本地创建一个unix socket，并模拟为虚拟机内部的一个串口设备，从而实现了宿主机与虚拟机通信，这种方式不依赖于TCP/IP网络。

如下是开启qemu-guest-agent的虚拟机xml配置信息：

```xml
<channel type='unix'>
      <source mode='bind' path='/var/lib/libvirt/qemu/org.qemu.guest_agent.0.instance-00003c2c.sock'/>
      <target type='virtio' name='org.qemu.guest_agent.0'/>
      <address type='virtio-serial' controller='0' bus='0' port='1'/>
</channel>
```

以上宿主机的socket文件为`org.qemu.guest_agent.0.instance-00003c2c.sock`，在虚拟机内部映射为`/dev/virtio-ports/org.qemu.guest_agent.0`。

通过这种方式，宿主机只要发送指令到该socket文件中就会在虚拟机对应的串口设备中收到，虚拟机内部的qemu-guest-agent会轮询查看这个串行设备是否有指令，一旦接收到指令就可以执行对应的脚本，从而实现了宿主机控制虚拟机执行命令的功能，其中最常用的指令就是通过libvirt修改虚拟机密码。更多关于qemu-guest-agent请参考[官方文档](http://wiki.qemu.org/Features/QAPI/GuestAgent)。

### 5.2 在OpenStack中应用

首先在制作镜像时需要安装qemu-guest-agent服务:

```sh
yum install -y qemu-guest-agent
systemctl enable qemu-guest-agent
```

在glance镜像中添加`hw_qemu_guest_agent` property:

```sh
glance image-update --property hw_qemu_guest_agent=yes ${IMAGE_ID}
```

可以通过Nova的`nova set-password <server>`子命令验证修改虚拟机的密码功能。

需要注意的是，Nova默认修改的是管理员用户的密码，Linux系统为`root`，Windows系统为`Administrator`，因此上传镜像时需要指明镜像是什么操作系统类型:

```
glance image-update --property os_type=linux/windows ${IMAGE_ID}
```

当然你也可以通过`os_admin_user`属性配置修改其他用户的密码，比如配置修改密码时指定用户不是root，而是ubuntu用户：

```sh
glance image-update --property os_admin_user=ubuntu ${IMAGE_ID}
```

## 6 网卡多队列

默认情况下网卡中断由单个CPU处理，当有大量网络包时单个CPU处理网络中断就可能会出现瓶颈。通过网卡多队列技术可以把网卡的中断分摊到多个CPU中。[阿里云官方文档](https://help.aliyun.com/document_detail/52559.html)测试表明在网络PPS和网络带宽的测试中，与1个队列相比，2个队列最多可提升50%到1倍，4个队列的性能提升更大。

OpenStack支持配置网卡多队列(要求内核版本大于3.0)，配置方法如下：

```
glance image-update --property hw_vif_multiqueue_enabled=true ${IMAGE_ID}
```

队列长度固定为虚拟机的核数。

创建虚拟机查看网卡信息:

```sh
# ethtool -l eth0
Channel parameters for eth0:
Pre-set maximums:
RX:		0
TX:		0
Other:		0
Combined:	2
Current hardware settings:
RX:		0
TX:		0
Other:		0
Combined:	1
```

网卡信息表明支持的最大队列(Combined)为2，目前设置为1，可以通过`ethtool`工具修改配置：

```sh
ethtool -L eth0 combined 2
```

为了保证中断自动均衡到所有的CPU，建议开启`irqbalance`服务：

```
systemctl enable irqbalance
systemctl start irqbalance
```

## 7 watchdog

在一些分布式集群中，我们可能期望虚拟机crash时自动关机，防止出现集群脑裂。或者当负载过高时自动执行重启，使服务恢复正常。

OpenStack支持配置虚拟watchdog，首先制作镜像时需要安装并开启watchdog服务:

```sh
yum install watchdog
systemctl enable watchdog
```

配置如下glance image属性：

```sh
glance image-update --property hw_watchdog_action=${ACTION} ${IMAGE_ID}
```

其中支持的action列表如下:

* `reset`: 强制重启。
* `shutdown`: 安全关机。
* `poweroff`: 强制关机。
* `pause`: 停止虚拟机。
* 'none': 不执行任何操作。
* 'dump': 导出dump core。

参考[官方文档](https://wiki.openstack.org/wiki/LibvirtWatchdog)可以查看更详细的配置。

## 8 GPU虚拟化

OpenStack从Q版本开始支持GPU虚拟化，由于测试环境中没有GPU，因此本文仅参考[官方文档](https://docs.openstack.org/nova/queens/admin/virtual-gpu.html)描述配置过程。

首先在安装有GPU（假设为nvidia-35）的计算节点中修改nova配置文件:

```ini
[devices]
enabled_vgpu_types = nvidia-35
```

重启nova-compute服务:

```
systemctl restart openstack-nova-compute
```

创建一个flavor，通过`resources:VGPU=1`extra specs指定虚拟GPU个数:

```sh
nova flavor-key gpu_test set resources:VGPU=1
```

使用该flavor创建的虚拟机就会分配一个虚拟GPU。

需要注意的是，如果使用libvirt driver，对于分配了vGPU的虚拟机：
 
 * 	不能执行挂起(suspend)操作，这是因为libvirt不支持vGPU的热插拔功能。
 * 冷迁移（migrate）、拯救（rescue）或者通过resize指定另一个设置了GPU的flavor，虚拟机都将不会再分配GPU，可以通过再执行一次rebuild操作恢复。

## 9. 参考文献

1. [维基百科NUMA](https://en.wikipedia.org/wiki/Non-uniform_memory_access).
2. [NUMA架构的CPU -- 你真的用好了么？](http://cenalulu.github.io/linux/numa/).
3. [OpenStack官方文档--Flavor](http://docs.openstack.org/admin-guide/compute-flavors.html).
4. [CPU pinning and numa topology awareness in OpenStack compute](http://redhatstackblog.redhat.com/2015/05/05/cpu-pinning-and-numa-topology-awareness-in-openstack-compute/).
5. [Simultaneous multithreading - Wikipedia](https://en.wikipedia.org/wiki/Simultaneous_multithreading).
6. [isolcpus、numactl and taskset](https://codywu2010.wordpress.com/2015/09/27/isolcpus-numactl-and-taskset/).
7. [Virtio-scsi](https://wiki.qemu.org/images/c/c2/Virtio-scsi.pdf).
8. [ceph and krbd discard](http://www.sebastien-han.fr/blog/2015/01/26/ceph-and-krbd-discard/).
9. [virio-blk vs virio-scsi](https://mpolednik.github.io/2017/01/23/virtio-blk-vs-virtio-scsi/).
10. [virtual gpu](https://docs.openstack.org/nova/queens/admin/virtual-gpu.html).
11. [libvirt watchdog](https://wiki.openstack.org/wiki/LibvirtWatchdog).
12. [enable netsted virtualization kv centos 7](https://www.linuxtechi.com/enable-nested-virtualization-kvm-centos-7-rhel-7/).
13. [inception how usable are nested kvm guests](https://www.redhat.com/en/blog/inception-how-usable-are-nested-kvm-guests).
14. [more recommandations ceph openstack](https://www.hastexo.com/resources/hints-and-kinks/more-recommendations-ceph-openstack/).
15. [阿里云网卡多队列文档](https://help.aliyun.com/document_detail/52559.html).



