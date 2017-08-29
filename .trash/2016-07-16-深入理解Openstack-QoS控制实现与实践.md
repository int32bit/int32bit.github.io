---
layout: post
title: 深入理解Openstack QoS控制实现与实践
catalog: true
tags:
     - Openstack
---

## 0.什么是QoS

From Wikipedia:

>Quality of service (QoS) is the overall performance of a telephony or computer network, particularly the performance seen by the users of the network.
To quantitatively measure quality of service, several related aspects of the network service are often considered, such as error rates, bit rate, throughput, transmission delay, availability, jitter, etc.
>

简单来说，QoS是一种控制机制，提供针对不同用户或者不同数据流采用相应不同的优先级，或者根据应用程序的要求，保证数据流的性能达到一定的水准。QoS的保证对于容量有限的网络来说是十分重要的，特别是对于流媒体应用，例如VoIP和IPTV等，因为这些应用常常需要固定的传输率，对延时也比较敏感。

QoS通常指网络上的数据流控制，本文讨论的QoS则更广泛些，不仅包含了传统的网络数据流控制（即网络IO控制），还包括了本地磁盘的读写控制，比如IOPS等。其中包括两种类型：

* 质量控制：通过提供不同性能的硬件设备来满足不同应用的性能需求，比如存储设备有SATA、SSD、RAID等。
* 量化控制：针对应用，对其流量进行严格控制，比如IOPS、网络带宽等。

Openstack同时支持以上两种QoS控制，这些组件包括但不限于计算服务Nova、网络服务Neutron、块存储服务Cinder、对象存储Swift等，Ceph虽然不是Openstack的组件之一，但通常作为Openstack的存储后端，因此本文也会对其进行简单的介绍。

本文旨在归纳总结Openstack如何在应用层实现QoS控制，读者如果对底层实现原理感兴趣，可以查阅相关资料。

## 1.Ceph

Ceph是近年来非常火热的开源统一分布式存储系统，最初是Sage Weil在University of California, Santa Cruz（UCSC）的PhD研究内容，目前由Inktank公司掌控Ceph的开发。Ceph同时支持块存储（LVM、裸硬盘)、对象存储（S3、Swift）、文件系统存储（HDFS、GFS），并且具有高扩展性、高可靠性、高性能的优点。

Ceph其中最广泛的应用之一是作为Openstack的存储后端，为Openstack提供统一分布式存储服务。Openstack组件中Nova、Glance、Cinder都支持直接对接Ceph，云主机的在线迁移、故障转移、镜像存储等功能都依赖于Ceph提供的统一分布式存储服务。

实际在部署时不同的机房或者机架可能配置不同的存储设备，比如SSD固态存储设备、SATA普通硬盘等，rbd image实例使用不同的存储后端，显然能够提供不同的性能。

我们知道ceph是通过crush算法和crush map决定对象如何分布存储的，cursh map描述了存储设备的层级拓扑（可以是物理拓扑，比如机架、机房、区域等，也可以是逻辑拓扑，比如故障域、性能等），整个map图是一个树状结构，如图：

```
                        ssd
                    /    |     \
                   /     |      \
                rack1  rack2   rack3
               /    \   ...    /    \
            host-1  host-2 host-m  host-n
            /     \   ...   ...    /    \
          osd1   osd2            osd-m  osd-n
```					
其中中间节点由自定义的bucket type实例构成，通常和物理拓扑名称一致，比如room、rack、host等，叶子节点是真正的存储设备，对应一块硬盘或者分区。根据树的结构，每个存储设备（叶子）有唯一一条路径到root节点，该路径定义为crush location，比如：

```
root=ssd rack=rack1 host=host-1
```
crush map rule能够制定某个pool的数据放置策略，rule的格式如下：

```
rule <rulename> {

        ruleset <ruleset>
        type [ replicated | erasure ]
        min_size <min-size>
        max_size <max-size>
        step take <bucket-name>
        step [choose|chooseleaf] [firstn|indep] <N> <bucket-type>
        step emit
}
```
其中ruleset为rule的id，type用于区分是存储驱动设备(replicated)还是RAID。min_size为最小副本数，如果副本数小于这个数，crush将不会选这个rule，同理max_size为最大副本数。step take开始选择root（注意图上我们只画了一棵树，但crush map可以有多棵树，因此存在多个root type），choose表示从子树种选择对应的bucket type，其中N表示选择的数量:

* `N == 0`, 表示设置为pool副本数量；
* `N > 0 && N < replicas`,表示真实的数量；
* `N < 0`,表示副本数减去该数的绝对值。


比如:

```
step choose firstn 1 type rack 
```
表示从当前位置向下迭代遍历随机选择一个rack类型。

该step必须位于take或者choose之下。

chooseleaf和choose类似，唯一不同的是在选择的每个bucket中再从中选择一个叶子节点。

以官方例子说明：

```
rule ssd-primary {
              ruleset 5
              type replicated
              min_size 5
              max_size 10
              step take ssd
              step chooseleaf firstn 1 type host
              step emit
              step take sata
              step chooseleaf firstn -1 type host
              step emit
      }
```
假设冗余副本数为3，则以上规则会首先从ssd中选择其中一个host，然后在host中选择其中一个osd作为主节点，然后从sata中选择3-1=2个host，分别从当中选择一个osd节点，一共两个osd节点作为副本节点。

注：

* 主节点负责实际和client通信的节点，而副本节点不会直接和client通信，但会和主节点保持数据同步，当主节点挂了，其中一个副本节点会接管主节点。
* 在写入数据时，主节点会同步到副本节点，只有当所有的副本节点都写完后，主节点才算写成功，因此ceph采取的是强一致性模型（而Swift是最终一致性模型）
* 可以通过primary-affinity值设置选择为主节点的概率，值为0表示不会被选择为主节点，值为1表示表示选择为主节点的概率极大（考虑到有多个节点都为1的情况）。

关于crush map 和rule参考[官方文档](http://docs.ceph.com/docs/master/rados/operations/crush-map/)。

ceph中不同的pool可以定义不同的crush以及ruleset，从而可以实现不同的pool，选择不同的osd，比如固定某个pool选择ssd，另一个pool选择sata，其中官方也有个例子：

```
device 0 osd.0
device 1 osd.1
device 2 osd.2
device 3 osd.3
device 4 osd.4
device 5 osd.5
device 6 osd.6
device 7 osd.7

      host ssd-server-1 {
              id -1
              alg straw
              hash 0
              item osd.0 weight 1.00
              item osd.1 weight 1.00
      }

      host ssd-server-2 {
              id -2
              alg straw
              hash 0
              item osd.2 weight 1.00
              item osd.3 weight 1.00
      }

      host sata-server-1 {
              id -3
              alg straw
              hash 0
              item osd.4 weight 1.00
              item osd.5 weight 1.00
      }

      host sata-server-2 {
              id -4
              alg straw
              hash 0
              item osd.6 weight 1.00
              item osd.7 weight 1.00
      }

      root sata {
              id -5
              alg straw
              hash 0
              item sata-server-1 weight 2.00
              item sata-server-2 weight 2.00
      }

      root ssd {
              id -6
              alg straw
              hash 0
              item ssd-server-1 weight 2.00
              item ssd-server-2 weight 2.00
      }

   
     
      rule sata {
              ruleset 1
              type replicated
              min_size 0
              max_size 10
              step take platter
              step chooseleaf firstn 0 type host
              step emit
      }

      rule ssd {
              ruleset 2
              type replicated
              min_size 0
              max_size 4
              step take ssd
              step chooseleaf firstn 0 type host
              step emit
      }

```
拓扑图如下:

```
            ssd             |             sata
         /        \         |          /        \
        /          \        |         /          \
       /            \       |        /            \
ssd-server-1   ssd-server-2 | sata-server-1  sata-server-2
   /     \       /      \   |   /     \        /     \
  /       \     /        \  |  /       \      /       \
osd0     osd1 osd2     osd3 | osd4     osd5   osd6     osd7
```
我们定义两个rule，假设冗余副本数为3，一个是ssd，它会从ssd中（即左边的树中）中选择osd，另一个是sata，从sata中（即右边的树种）选择osd。

我们创建两个pool，并关联ruleset：

```bash
ceph osd pool set sata crush_ruleset 1
ceph osd pool set ssd crush_ruleset 2
```

通过以上方式我们实现了不同性能的ceph pool，实现QoS质量控制。

那ceph是否支持量化控制呢，rbd目前好像并不支持控制，但可以通过qemu、kvm等控制读写速率。

## 2.Cinder

介绍完Ceph，接下来终于进入Openstack正题，首先从Cinder谈起。Cinder是Openstack的基础组件之一，提供块存储服务，类似AWS的EBS服务。但是Cinder本身并不提供块服务，而只是一个管理工具，由具体后端实现，后端包括比如LVM、Ceph RBD等，Cinder通过调用对应的驱动来完成volume的生命周期管理。

下面以Ceph RBD作为存储后端为例，首先介绍如何实现volume的QoS质量控制。Cinder支持多后端存储，不同的后端通过不同的配置组区别开，如：

```
[sata-ceph]
volume_backend_name=sata
rbd_pool=sata
volume_driver=cinder.volume.drivers.rbd.RBDDriver
rbd_ceph_conf=/etc/ceph/ceph.conf
...

[ssd-ceph]
volume_backend_name=ssd
rbd_pool=ssd
volume_driver=cinder.volume.drivers.rbd.RBDDriver
rbd_ceph_conf=/etc/ceph/ceph.conf
...
```

以上有两个配置组，分别为sata-ceph和ssd-ceph，这里我们都使用了ceph rbd作为存储后端，实际部署时可以是完全不同的存储后端，比如混合rbd和LVM。以上我们指定了不同pool以及不同的后端名称，后端名称是为了方便后续创建volume type引用。我们由上面关于Ceph中介绍可知，不同的pool可以定义不同的rule从而选择不同特性的硬件，如果能够绑定Ceph pool和volume问题就解决了，值得庆幸的是，Cinder就是这么实现的。

Cinder自定义volume type，分别创建ssd和sata两个volume type:

```bash
cinder type-create ssd
cinder type-create sata
```
创建完后type后绑定volume_backend_name从而实现与ceph pool关联起来:

```
cinder type-key sata set volume_backend_name=sata
cinder type-key ssd set volume_backend_name=ssd
```

查看`extra-specs`：

```
[root@server-39.0.lg.ustack.in ~ ]$ cinder extra-specs-list
+--------------------------------------+------+-----------------------------------+
|                  ID                  | Name |            extra_specs            |
+--------------------------------------+------+-----------------------------------+
| 1a0cb988-58a6-43bf-b4ea-199e0e02239b | sata | {u'volume_backend_name': u'sata'} |
| 38344c5c-b61b-4677-9a48-e70d723b8620 | ssd  |  {u'volume_backend_name': u'ssd'} |
+--------------------------------------+------+-----------------------------------+
```

此时只需要在创建时指定volume type就可以实现创建不同QoS性能的数据卷，比如：

```
cinder create --volume-type ssd --display-name int32bit-test-ssd 1
```

以上我们通过自定义volume type并绑定不同的后端实现了对volume访问的QoS质量控制，接下来我们介绍如何通过制定volume type实现不同的QoS量化控制。和前面的步骤类似，首先创建一个high-iops-type volume type:

```
cinder type-create high-iops-type
```

cinder通过qos实例对volume进行量化控制，我们需要创建high-iops，设置读最大iops为2000，写最大iopos为1000:

```bash
cinder qos-create high-iops consumer="front-end" read_iops_sec=2000 write_iops_sec=1000
```

查看qos列表:

```
$ cinder qos-list
+--------------------------------------+-----------+-----------+---------------------------------------------------------+
|                  ID                  |    Name   |  Consumer |                          specs                          |
+--------------------------------------+-----------+-----------+---------------------------------------------------------+
| 4ba70d30-eb36-4267-8ee5-5c9cc2f8af32 | high-iops | front-end | {u'write_iops_sec': u'1000', u'read_iops_sec': u'2000'} |
+--------------------------------------+-----------+-----------+---------------------------------------------------------+
```

其中consumer的合法值为front-end、back-end、both。front-end表示使用前端控制（hypervisor控制，会在libvirt xml文件中定义）, 而back-end表示使用后端控制（cinder drivers,需要driver支持），both表示前后端同时进行QoS控制。

最后绑定qos实例和volume type实例:

```bash
QOS_SPEC_ID=4ba70d30-eb36-4267-8ee5-5c9cc2f8af32
VOLUME_TYPE_ID=26e33f06-e011-4cf7-a397-91a00ef0a233
cinder qos-associate $QOS_SPEC_ID $VOLUME_TYPE_ID
```

查看绑定情况:

```
$ cinder qos-get-association 4ba70d30-eb36-4267-8ee5-5c9cc2f8af32
+------------------+----------------+--------------------------------------+
| Association_Type |      Name      |                  ID                  |
+------------------+----------------+--------------------------------------+
|   volume_type    | high-iops-type | 26e33f06-e011-4cf7-a397-91a00ef0a233 |
+------------------+----------------+--------------------------------------+
```

下面我们创建一个volume验证其功能，我们创建时指定volume type为high-iops-type，并挂载到虚拟机中：

```bash
cinder create --volume-type high-iops-type --display-name high-iops-test 1
SERVER_ID=1ea33417-b577-45cb-83a0-fc412e421811
VOLUME_ID=bb2ccbfb-654a-473e-9f35-ae548c8e59e1
nova volume-attach $SERVER_ID $VOLUME_ID
```
查看libvirt xml文件，截取部分disk信息如下:

```xml
<disk type='network' device='disk'>
      <driver name='qemu' type='raw' cache='writeback'/>
      <auth username='admin'>
        <secret type='ceph' uuid='bdf77f5d-bf0b-1053-5f56-cd76b32520dc'/>
      </auth>
      <source protocol='rbd' name='openstack-00/volume-bb2ccbfb-654a-473e-9f35-ae548c8e59e1'>
        <host name='10.0.103.61' port='6789'/>
        <host name='10.0.103.62' port='6789'/>
        <host name='10.0.103.63' port='6789'/>
      </source>
      <backingStore/>
      <target dev='vdc' bus='virtio'/>
      <iotune>
        <read_iops_sec>2000</read_iops_sec>
        <write_iops_sec>1000</write_iops_sec>
      </iotune>
      <serial>bb2ccbfb-654a-473e-9f35-ae548c8e59e1</serial>
      <alias name='virtio-disk2'/>
      <address type='pci' domain='0x0000' bus='0x00' slot='0x08' function='0x0'/>
    </disk>
```

由xml文件可见在iotune中对读写IOPS的控制。

以上总结了Openstack Cinder的QoS的控制，接下来将介绍Nova实现机制。

## 3.Nova

Nova是Openstack最核心的服务，提供计算服务，其功能类似AWS EC2。官方描述为:

>Nova is an OpenStack project designed to provide power massively scalable, on demand, self service access to compute resources.
>

Nova虽然没有直接方式对QoS质量进行控制，但我们可以通过主机集合(Host Aggregate)实现，比如我们有两个计算节点node-1，node-2，配置SSD磁盘，我们创建对应的主机集合并把两个节点加入到该主机集合中:

```
nova aggregate-create ssd nova
nova aggregate-set-metadata ssd ssd=true
nova aggregate-add-host ssd node-1
nova aggregate-add-host ssd node-2
```

创建一个新的flavor并设置key指定绑定的key-value:

```
nova flavor-create ssd.large 6 8192 80 4
nova flavor-key set_key --name=ssd.large --key=ssd --value=true
```

查看flavor:

```
$ nova flavor-show ssd.large
+----------------------------+-------------------+
| Property                   | Value             |
+----------------------------+-------------------+
| OS-FLV-DISABLED:disabled   | False             |
| OS-FLV-EXT-DATA:ephemeral  | 0                 |
| disk                       | 80                |
| extra_specs                | {u'ssd': u'true'} |
| id                         | 6                 |
| name                       | ssd.large         |
| os-flavor-access:is_public | True              |
| ram                        | 8192              |
| rxtx_factor                | 1.0               |
| swap                       |                   |
| vcpus                      | 4                 |
+----------------------------+-------------------+
```

此时当用户指定ssd.large flavor时，调度器将筛选具有ssd=true标签的计算节点，其余不满足条件的主机将被过滤掉, 最后在node-1和node-2中选取作为虚拟机的宿主机。

同样地，Nova可通过flavor的Extra Specs实现QoS量化控制,以下内容直接参考官方文档-[compute flavors](http://docs.openstack.org/admin-guide/compute-flavors.html)：

比如限制IO最大读写速率为10MB/s:

```bash
openstack flavor set FLAVOR-NAME \
    --property quota:read_bytes_sec=10240000 \
    --property quota:write_bytes_sec=10240000
```

除了IO控制，还支持CPU以及内存限制：

CPU

```
openstack flavor set FLAVOR-NAME \
    --property quota:cpu_quota=10000 \
    --property quota:cpu_period=20000
```

内存

```
openstack flavor set FLAVOR-NAME \
    --property quota:memory_shares_level=custom \
    --property quota:memory_shares_share=15
```

设置虚拟机最大的disk写入数据为10MB/s：

```
openstack flavor set FLAVOR-NAME \
    --property quota:disk_write_bytes_sec=10485760
```

另外，除了QoS控制，Flavor的强大之处远不止这些，还支持用户自定义CPU拓扑:

```bash
openstack flavor set FLAVOR-NAME \
    --property hw:cpu_sockets=FLAVOR-SOCKETS \
    --property hw:cpu_cores=FLAVOR-CORES \
    --property hw:cpu_threads=FLAVOR-THREADS \
    --property hw:cpu_max_sockets=FLAVOR-SOCKETS \
    --property hw:cpu_max_cores=FLAVOR-CORES \
    --property hw:cpu_max_threads=FLAVOR-THREADS
```

以及NUMA 拓扑:

```bash
openstack flavor set FLAVOR-NAME \
    --property hw:numa_nodes=FLAVOR-NODES \
    --property hw:numa_cpus.N=FLAVOR-CORES \
    --property hw:numa_mem.N=FLAVOR-MEMORY
```

## 4.Swift

Openstack Swift提供对象存储服务，功能类似AWS S3以及Ceph RGW，Swift可以通过配置不同的Storage Policies来实现不同性能的后端存储。具体可参看官方文档[Stroage Policie](http://docs.openstack.org/developer/swift/overview_policies.html#configure-policy).

## 5.Neutron

Neutron是OpenStack项目中负责提供网络服务的组件，它基于软件定义网络（SDN）的思想，实现了网络虚拟化的资源管理。Neutron支持对虚拟网卡进行带宽流量限制，主要通过QoS Policy实现，需要在neutron server端配置项service_plugins中开启qos插件，参考[Neutron QoS](http://docs.openstack.org/mitaka/networking-guide/adv-config-qos.html)。

以下内容主要参考官方文档实例。首先创建一个Qos Policy:

```bash
neutron qos-policy-create bw-limiter
```

设置带宽：

```bash
neutron qos-bandwidth-limit-rule-create bw-limiter --max-kbps 3000 \
  --max-burst-kbps 300
```

通过neutron port-list找到需要限制带宽的端口（虚拟网卡):

```bash
$ neutron port-list

+--------------------------------------+----------------------------------+
| id                                   | fixed_ips                        |
+--------------------------------------+----------------------------------+
| 0271d1d9-1b16-4410-bd74-82cdf6dcb5b3 | { ... , "ip_address": "10.0.0.1"}|
| 88101e57-76fa-4d12-b0e0-4fc7634b874a | { ... , "ip_address": "10.0.0.3"}|
| e04aab6a-5c6c-4bd9-a600-33333551a668 | { ... , "ip_address": "10.0.0.2"}|
+--------------------------------------+----------------------------------+
```

关联port和QoS Policy:

```
neutron port-update 88101e57-76fa-4d12-b0e0-4fc7634b874a --qos-policy bw-limiter
```

移除port和Qos Policy的关联:

```
neutron port-update 88101e57-76fa-4d12-b0e0-4fc7634b874a --no-qos-policy
```

创建port时可以指定QoS Policy:

```bash
neutron port-create private --qos-policy-id bw-limiter
```

## 总结

本文详细介绍了Openstack基础服务的QoS控制，包括质量控制和量化控制，涉及的内容包括:

1. Ceph通过crush map和ruleset选取不同性能的后端存储设备
2. Cinder支持多后端存储，Volume type绑定具体的后端从而实现不同性能的后端选择，并且可以自定义QoS实现数据卷的IO读写限制。
3. Nova可以通过Host Aggregate的Metadata以及Flavor Extra Specs控制调度器选取符合某些特性的（比如SSD）计算节点，通过Flavor Extra Specs实现虚拟机的IO读写限制。
4. Swift 支持多Policy，通过Storage Policies可以实现不同性能的后端存储设备。
5. Neutron通过Qos Policy完成对虚拟网卡的带宽限制。

由此可见，Openstack同时支持计算、存储和网络的QoS控制，通过QoS控制可以满足不同应用对不同资源的异构需求。

## 参考文献

1. [Wikipedia QoS词条](https://en.wikipedia.org/wiki/Quality_of_service)
2. [Ceph简介](http://www.ssdfans.com/?p=274)
3. [Ceph架构剖析](https://www.ustack.com/blog/ceph_infra/)
4. [Openstack Swift Stroage Policie](http://docs.openstack.org/developer/swift/overview_policies.html#configure-policy)
5. [Openstack compute flavors specs](http://docs.openstack.org/admin-guide/compute-flavors.html)
6. [Openstack Neutron QoS](http://docs.openstack.org/mitaka/networking-guide/adv-config-qos.html)
