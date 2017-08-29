---
layout: post
title: 利用OpenStack核绑定优化云主机计算性能
catalog: true
tags: [OpenStack]
---


## 0. 定义

* vCPU: 虚拟CPU,指虚拟机的CPU
* pCPU: 物理CPU，指宿主机的CPU
* NUMA: Non-Uniform Memory Access, 参考[NUMA维基百科](https://en.wikipedia.org/wiki/Non-uniform_memory_access) 。
* CPU pinning: CPU绑定
* SMT: Simultaneous Multithreading-based, 同步多线程技术，一种在一个CPU 的时钟周期内能够执行来自多个线程的指令的硬件多线程技术。本质上，同步多线程是一种将线程级并行处理(多CPU)转化为指令级并行处理(同一CPU)的方法。

## 1. 概述

OpenStack从K版本开始不仅支持了自定义CPU拓扑功能，比如设置socket、core、threads等，还支持CPU pinning功能，即CPU核绑定，甚至能够使虚拟机独占物理CPU，虚拟机的vCPU能够固定绑定到宿主机的指定pCPU上，在整个运行期间，不会发生CPU浮动，减少CPU切换开销，提高虚拟机的计算性能。OpenStack并不允许用户显式的将一个vCPU绑定到某一pCPU上，这是由于这么做会暴露用户物理CPU拓扑信息，这有悖于IaaS的设计原则。除此之外，OpenStack还支持设置threads policy，能够利用宿主机的SMT特性进一步优化宿主机的性能。

接下来本文将详细介绍如何实现OpenStack虚拟机的CPU核绑定。

## 2. 前期工作

### 2.1 规划CPU和内存

在配置之前，首先需要规划计算节点的CPU，哪些CPU分配给虚拟机，哪些CPU为宿主机进程预留，为了性能进一步优化，还可能需要考虑宿主机CPU的NUMA架构。

在Linux环境下可以通过以下命令查看物理CPU信息:

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

由以上信息可知，该宿主机一共两个CPU，每个CPU 10核，每个核可以开启两个超线程，即一共有40个逻辑CPU，其中包括两个NUMA node，node0包括0，2，4，...,38，node1包括1,3,5,...,39。

预留CPU个数和内存需要根据实际情况调整，比如若计算节点和存储节点融合，需要预留更多的CPU来保证存储服务的性能。本文测试环境预留了4个逻辑CPU(1-3)和512MB物理内存给宿主机，剩下的资源分配给虚拟机使用。

分配cpuset给虚拟机需要调整计算节点的`vcpu_pin_set`配置项，支持以下三种语法格式:

* 1,2,3 # 指定CPU号，逗号隔开。
* 2-15, 18-31 # 使用-表示连续CPU序列，使用逗号分隔。
* ^0,^1,^2,^3 # 使用`^`表示排除的CPU号，剩下的全部作为虚拟机使用。

以上三种语法格式可以组合使用。

在compute节点nova参考配置如下:

```
# /etc/nova/nova.conf
[DEFAULT]
vcpu_pin_set=^0,^1,^2,^3
reserved_host_memory_mb=512
...
```

配置更新需要重启nova-compute服务:

```bash
systemctl restart openstack-nova-compute
```

### 2.2 调度配置

在nova-scheduler节点上，需要配置默认filter，必须包含`AggregateInstanceExtraSpecFilter`和`NUMATopologyFilter`：

```
# /etc/nova/nova.conf
[DEFAULT]
scheduler_default_filters=NUMATopologyFilter,AggregateInstanceExtraSpecsFilter,...
```

配置完需要重启所有的nova-scheduler服务:

```bash
systemctl restart openstack-nova-scheduler
```

## 3. 创建host aggregate

### 3.1 什么是host aggregate?

Host aggregate是compute host的集合，同一个主机集合的所有计算节点通常具有一组相同的特性，这些特性通过关联metadata来描述，比如高速网卡、GPU、SSD存储、Qos等。nova-scheduler能够过滤不满足某些特性的主机，从而只选择只具备某些特性的主机，比如只选择配置ssd的主机或者只选择具有GPU加速的主机等，这和[YARN的Label based scheduling算法](http://doc.mapr.com/display/MapR/Label-based+Scheduling+for+YARN+Applications)原理是一样的，差别仅仅是一个称为metadata，一个称为label。通过基于label的调度算法，充分考虑了异构的资源分布，能够提高资源利用率和最大吞吐量。

OpenStack需要首先创建主机集合，然后通过主机集合的metadata描述该集合的主机具有的特性，nova创建主机集合语法为：

```bash
nova aggregate-create int32bit-hz int32bit-az
```

其中`int32bit-az`是主机集合名称，`int32bit-az`是Availability zones，可以为空。Availability zones和host aggregates都是region和cell基础上的进一步划分。，其中Availability zones用户可见，用户创建云主机时可以指定Availability zones，而Host aggregates对于用户是不可见的，用户不能直接指定Host aggregates，而只能通过选择具有某种特性的flavor，从而间接选择具有该特性的Host aggregates。Availability zones和Host aggregates均是将计算集群划分为多个逻辑组，而与OpenStack实际部署情况无关，管理员可以通过nova API管理Host aggregates。

*注意：* nova API不支持创建和删除za，但可以通过创建Host aggregates指定Availability zones的方式间接创建Availability zones。

总结Host aggregates和Availability zones的区别：

* Availability zone通过逻辑划分提供某种形式上的物理隔离，保证不同Availability zones之间具有某些特性上的冗余性，比如供电、网络设备等。（另外region是真正物理上的划分）
* Host aggregate则指一组拥有关联metadata的计算节点，metadata中描述了该组计算节点所拥有的特性，比如高速网卡、GPU、SSD存储、属于特定租户、Qos等。
* 一个Availability zones可以包含多个host aggregates，一个host aggregates只能属于一个Availability zones，一个host可以属于多个host aggregates，但只能属于一个Availability zones。
Availability zones对于用户可见，而Host aggregate对于用户并不可见；用户通过选择具有某种特性的flavor，从而间接选择具有该特性的host aggregate。

查看Availability zones列表:

```
$ nova availability-zone-list
+-----------------------+----------------------------------------+
| Name                  | Status                                 |
+-----------------------+----------------------------------------+
| internal              | available                              |
| |- server-42          |                                        |
| | |- nova-conductor   | enabled :-) 2016-07-24T06:56:56.000000 |
| | |- nova-scheduler   | enabled :-) 2016-07-24T06:56:55.000000 |
| | |- nova-consoleauth | enabled :-) 2016-07-24T06:56:58.000000 |
| | |- nova-cert        | enabled :-) 2016-07-24T06:56:58.000000 |
| zone1                 | available                              |
| |- server-68          |                                        |
| | |- nova-compute     | enabled :-) 2016-07-24T06:56:57.000000 |
| |- server-69          |                                        |
| | |- nova-compute     | enabled :-) 2016-07-24T06:56:53.000000 |
+-----------------------+----------------------------------------+
```

把某个计算节点加入到指定的主机集合中:

```bash
nova aggregate-add-host int32bit-hz server-68
```

查看主机集合包含的计算节点：

```
[root@server-32.103.hatest.int32bit.in ~ ]$ nova aggregate-details int32bit-hz
+----+---------------+-------------------+--------------------------+---------------------------+
| Id | Name          | Availability Zone | Hosts                    | Metadata                  |
+----+---------------+-------------------+--------------------------+---------------------------+
| 26 | int32bit-hz   | zone1             | 'server-68', 'server-69' | 'availability_zone=zone1' |
+----+---------------+-------------------+--------------------------+---------------------------+
```

设置主机集合metadata(即label):

```
[root@server-32.103.hatest.int32bit.in ~ ]$ nova aggregate-set-metadata int32bit-hz pinning_cpu=true ssd=true
Metadata has been successfully updated for aggregate 26.
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
| Id | Name          | Availability Zone | Hosts                    | Metadata                                                  |
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
| 26 | int32bit-hz   | zone1             | 'server-68', 'server-69' | 'availability_zone=zone1', 'pinning_cpu=true', 'ssd=true' |
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
```

**注意：** 删除metadata只需要设置key为空即可，比如删除ssd特性:

```bash
nova aggregate-set-metadata int32bit-test ssd
```



查看主机集合的主机列表以及metadata:

```
[root@server-32.103.hatest.int32bit.in ~ ]$ nova aggregate-details int32bit-hz
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
| Id | Name          | Availability Zone | Hosts                    | Metadata                                                  |
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
| 26 | int32bit-hz   | zone1             | 'server-68', 'server-69' | 'availability_zone=zone1', 'pinning_cpu=true', 'ssd=true' |
+----+---------------+-------------------+--------------------------+-----------------------------------------------------------+
```

### 3.2 创建核绑定主机集合

为了区分哪些计算节点开启核绑定功能，哪些不开启，我们通过主机集合区分。

首先创建pinned-cpu主机集合:

```bash
nova aggregate-create pinned-cpu
```

增加metadata区分pinned:

```bash
nova aggregate-set-metadata pinned-cpu pinned=true
```

增加计算节点，我们两个计算节点都开启了核绑定功能，因此把这两个计算节点都加入该主机集合中:

```bash
 nova aggregate-add-host pinned-cpu server-68
 nova aggregate-add-host pinned-cpu server-69
```

## 4. 创建Flavor

### 4.1 Flavor Extra Specs

目前Nova并不支持启动时直接指定主机集合metadata（hint只支持指定server group等），必须通过Flavor间接指定，调度时会读取Flavor的extra specs，并与主机集合的metadata匹配，不匹配的将被过滤掉，不会被最终选择作为候选主机。

Flavor内置支持很多extra specs，通过extra specs，可以指定虚拟机的CPU拓扑、QoS限制、CPU pinning策略、NUMA拓扑，甚至设置PCI passthrough，详细介绍参考[官方文档](http://docs.openstack.org/admin-guide/compute-flavors.html)。比如设置CPU topology，可以设置CPU的socket数量、core数量以及超线程数量等：

```
$ nova flavor-key FLAVOR-NAME set \
    hw:cpu_sockets=FLAVOR-SOCKETS \
    hw:cpu_cores=FLAVOR-CORES \
    hw:cpu_threads=FLAVOR-THREADS \
    hw:cpu_max_sockets=FLAVOR-SOCKETS \
    hw:cpu_max_cores=FLAVOR-CORES \
    hw:cpu_max_threads=FLAVOR-THREADS
```
**以上值不需要全部设置，只需要设置其中一个或者几个，剩余的值会自动计算。**

和本文的CPU pinning相关的extra specs为:

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

### 4.2 创建新的Flavor

创建flavor一个新的flavor，并配置资源量:

```bash
nova flavor-create m1.xlarge.pinned 100 2048 20 8
```

添加pinned extra specs：

```bash
nova flavor-key m1.xlarge.pinned set hw:cpu_policy=dedicated
```

添加extra specs用于匹配主机集合metadata，保证调度时只选择开启核绑定的宿主机:

```bash
nova flavor-key m1.xlarge.pinned set aggregate_instance_extra_specs:pinned=true
```

查看flavor的信息:

```
➜  ~ nova flavor-show m1.xlarge.pinned
+----------------------------+---------------------------------------------------------------------------------+
| Property                   | Value                                                                           |
+----------------------------+---------------------------------------------------------------------------------+
| OS-FLV-DISABLED:disabled   | False                                                                           |
| OS-FLV-EXT-DATA:ephemeral  | 0                                                                               |
| disk                       | 20                                                                              |
| extra_specs                | {"aggregate_instance_extra_specs:pinned": "true", "hw:cpu_policy": "dedicated"} |
| id                         | 100                                                                             |
| name                       | m1.xlarge.pinned                                                                 |
| os-flavor-access:is_public | True                                                                            |
| ram                        | 2048                                                                            |
| rxtx_factor                | 1.0                                                                             |
| swap                       |                                                                                 |
| vcpus                      | 2                                                                               |
+----------------------------+---------------------------------------------------------------------------------+
```


## 5.功能验证

使用新创建的Flavor启动虚拟机:

```bash
nova boot  int32bit-test-pinning \
	--flavor m1.xlarge.pinned  \
	--image 16b79884-77f2-44f5-a6d7-6fcc30651283\
	--nic net-id=ed88dc5a-61d8-4f99-9532-8c68e5ec5b9e
```
使用nova-show命令查看虚拟机的宿主机，在宿主机上查看虚拟机的xml文件:

```bash
virsh dumpxml 306abd22-28c5-4f91-a5ce-0dad03a35f49
```

其中`306abd22-28c5-4f91-a5ce-0dad03a35f4`为虚拟机的uuid。

在xml文件中找到以下字段:

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

从xml文件中可以看出vCPU与pCPU的绑定关系。

在虚拟机上执行高密度计算，python脚本为:

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
Linux 3.10.0-229.20.1.el7.x86_64 (8409a4dcbe1d11af)     07/23/2016      _x86_64_        (40 CPU)

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

从CPU使用情况看宿主机的pCPU 4-5，8-9，24-25，28-29使用率100%，并且整个过程中没有浮动，说明CPU绑定成功！

## 6. 其它测试

## 6.1 rebuild测试

对核绑定的虚拟机执行rebuild操作，测试通过，CPU核绑定关系可能变化，也可能不变。

## 6.2 resize测试

同上

## 6.3 migrate测试

同上
## 6.4 evacuate

同上

## 7. 其他配置

目前CPU核绑定没有问题，新创建的虚拟机能够保证不会抢占其他虚拟机的CPU，但是宿主机的进程还是可能会占用CPU，因此CPU还不是由虚拟机独占的，为了进一步提供性能，可以设置阻止其他宿主机进程使用指定的CPU。

我们需要设置内核参数`isolcpu`来限制进程只使用固定的cpuset。比如我们需要把CPU 2,3,6,7作为CPU pinning给虚拟机独占，设置如下:

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

此时下次启动系统时会默认加入内核参数，如下：

```
linux16 /vmlinuz-3.10.0-229.1.2.el7.x86_64 root=/dev/mapper/rhel-root ro rd.lvm.lv=rhel/root crashkernel=auto  rd.lvm.lv=rhel/swap vconsole.font=latarcyrheb-sun16 vconsole.keymap=us rhgb quiet LANG=en_US.UTF-8 isolcpus=2,3,6,7
```

## 8. 总结

本文详细介绍了CPU绑定功能，通过核绑定功能能够提供虚拟机的计算性能。

## 9. 参考文献

1. [维基百科NUMA](https://en.wikipedia.org/wiki/Non-uniform_memory_access)
2. [NUMA架构的CPU -- 你真的用好了么？](http://cenalulu.github.io/linux/numa/)
3. [OpenStack官方文档--Flavor](http://docs.openstack.org/admin-guide/compute-flavors.html)
4. [CPU pinning and numa topology awareness in OpenStack compute](http://redhatstackblog.redhat.com/2015/05/05/cpu-pinning-and-numa-topology-awareness-in-openstack-compute/)
5. [Simultaneous multithreading - Wikipedia](https://en.wikipedia.org/wiki/Simultaneous_multithreading)
6. [isolcpus、numactl and taskset](https://codywu2010.wordpress.com/2015/09/27/isolcpus-numactl-and-taskset/)
