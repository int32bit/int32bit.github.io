---
layout: post
title: 深入浅出OpenStack安全组实现原理
catalog: true
tags: [OpenStack]
---

众所周知，OpenStack安全组默认是通过Linux iptables实现的，不过发现目前还是很少有深入细节解析OpenStack安全组实现，于是在下班时间花了几个小时时间重新梳理了下，顺便记录下。

## 1 iptables简介

### 1.1 iptables概述

在介绍OpenStack安全组前先简单介绍下iptables，其实iptables只是一个用户空间的程序，真正干活的其实是Linux内核netfilter，通过iptables创建新规则，其实就是在netfilter中插入一个hook，从而实现修改数据包、控制数据包流向等，对iptables使用方法不熟悉的可以参考[图文并茂理解iptables](https://www.zsythink.net/archives/1199).

简单地说，iptables就是通过一系列规则条件匹配执行指定的动作，因此一条规则就是由条件+动作构成，条件比如源IP地址、四层协议、端口等，动作如拒绝、通过、丢弃、修改包等，动作通常通过`-j`参数指定。

比如拒绝192.168.1.2访问目标22端口，只需要添加如下iptables规则：

```sh
iptables -t filter -I INPUT -s 192.168.1.2 -p tcp --dport 22 -j DROP
```

如上：

* `-t`指定表(table)，如果把所有的规则混放在一起肯定会特别乱，因此iptables根据功能划分为不同的表，过滤包的放在filter表，做NAT的放nat表等，还有raw表、mangle表、security表，共5个表。如果不指定该参数，默认会选中filter表。
* `-I`表示insert操作，在最前面插入这条规则，相对应的还有`-A`参数，表示从末尾追加规则，`-I`、`-A`还可以在后面指定索引位置，将规则插入到指定的位置。
* `INPUT`表示链名称，链可以看做是一个链表，链表元素为规则。iptables一共可操纵5条链，分别为`PREROUTING`、`INPUT`、`FORWARD`、`OUTPUT`、`POSTROUTING`。需要注意的是，所有的表都是共享这5条链的，当然并不是所有的表都同时需要这5条链，比如filter表就没有`PREROUTING`、`POSTROUTING`。如果多个table都在如上链上插入了规则，则根据`raw -> mangle -> nat -> filter`的顺序执行。
* `-s`、`-p`、`--dport`都是条件，多个条件是`与`的关系，即只有满足指定的所有条件才能匹配该规则，如上`-s`指定了源地址IP为`192.168.1.2`，`-p`指定了协议为`TCP`，`--dport`指定了端口22，即只有源地址访问目标的22 TCP端口才能匹配这条规则。
* `-j`指定了行为，当然官方的叫法是目标(target)，这里`DROP`表示丢弃包。

### 1.2 iptables匹配条件

除了以上的`-s`、`-p`、`--dport`等参数作为匹配条件外，iptables还支持如`-d`匹配目标IP地址，`-i`、`-o`分别指定从哪个网卡进入的以及从哪个网卡出去的。当然这些匹配条件还不够，甚至都不支持匹配MAC地址。iptables为了满足不同的需求，通过扩展模块支持更多的匹配条件，主要分为如下两类：

* 功能加强型：比如前面的`--dport`参数只能匹配单个port或者连续的port，如果需要匹配多个不连续的port，则不得不通过添加多条规则实现。`mulport`扩展模块允许同时指定多个port，通过逗号分隔。再比如`ip-range`模块，支持指定ip地址段。
* 新功能：比如`mac`模块支持匹配源MAC地址。`time`模块支持通过时间段作为匹配条件，比如实现每天0点到8点不允许外部SSH。

不同的扩展模块支持不同的参数，比如`mac`模块，支持`--mac-source`参数。

使用扩展模块必须通过`-m`参数加载，之前我一直以为`-m`是`--module`的缩写，看iptables的man手册才发现其实是`--match`的缩写，不过我们只需要知道是加载扩展模块的功能就可以了。 

比如我们不允许MAC地址为`FA:16:3E:A0:59:BA `通过，通过如下规则配置：

```
iptables -A INPUT -m mac --mac-source FA:16:3E:A0:59:BA -j DROP
```

iptables的扩展模块非常多，具体可以通过`man iptables-extensions`命令查看，不过OpenStack安全组用到的并不多：

* `comment`：给规则添加注释。
* `tcp`/`udp`/`icmp`：没错，这些也属于扩展模块，iptables基本模块中甚至连指定端口的功能都没有。
* `set`: 匹配ipset，当ip在ipset集合中即满足条件。
* `mac`：前面说了，支持匹配MAC地址。
* `state`: 这个模块非常有用，举个简单的例子，假设服务器A(192.168.0.1)配置的iptables规则为入访全不通，即INPUT链全DROP，出访全通，即OUTPUT链全ACCEPT。另外一台服务器B（192.168.0.2）和A在同一个二层网络，则显然B ping不通A，问题是A能ping通B吗？有人肯定会说，A既然出访全是通的，那肯定能ping通B了。事实上，A根本ping不通B，因为A的包有去无回，即A的ICMP包确实能到B，但B的回包却被A的`INPUT` DROP了，因此A根本接收不到reply包。那怎么解决呢？把B加到A的白名单列表中显然破坏了我们原有的初衷。通过`state`模块可以完美解决这个问题，指定state为`ESTABLISHED`能够匹配已经建立连接的包，注意这里的已建立连接并不是说TCP连接，而是更广泛的连接含义，比如udp、icmp，简单理解就是匹配回包。因此解决如上问题只需要添加`-A INPUT -m state --state RELATED,ESTABLISHED -j ACCEPT`规则即可。
* `physdev`: 这个模块相对内置的`-i`、`-o`参数功能更强大。假如我们创建了一个linux bridge `br0`，`br0`上挂了很多虚拟网卡tap设备。我们通过`-i`指定`br0`则不管从哪个虚拟网卡进来的都会匹配，做不了精确匹配到底是从哪个虚拟网卡进来的。而`physdev`模块则非常强大，通过`physdev-in`参数指定从哪个接口进来的，通过`--physdev-out`参数指定从哪个接口出去的。

### 1.3 iptables执行动作

前面提到iptables通过`-j`指定执行的动作(target)，iptables常见的target如下:

* ACCEPT: 接收包，直接放行，不需要在匹配该链上的其他规则，注意是该链，其他链的还是需要匹配的，即只是说明通了一关，后面几关能不能通过还不好说。
* DROP: 直接丢弃包，包都丢了，当然也不需要在匹配其他任何规则了。
* REJECT: 拒绝包。这个和DROP有什么区别呢？DROP是直接丢弃包，不做任何响应，客户端会一直在傻傻地等直到超时。而REJECT会响应拒绝消息，客户端能收到拒绝包并作出反应，不需要一直盲等。
* LOG: 仅仅记录下日志。

当然还有实现NAT的SNAT、MASQUERADE、DNAT，因为安全组实现涉及不到，因此不做详细介绍，另外还有`RETURN`以及指向另一个链的动作，等后面介绍了子链再讨论。

动作通常都是短路的，也就是说一旦匹配规则并执行动作，就不会继续往后去匹配该链的其他规则了，当然这并不是绝对的，比如`LOG`动作就是例外，执行该动作后会继续匹配下一条规则。

### 1.4 iptables链
 
前面提到iptables一共有5条链，并且链可以认为是一个单向链表，问题来了，当接收到一个新包，到底是如何匹配规则的。这里我直接引用[图文并茂理解iptables](https://www.zsythink.net/archives/1199)的图:

![iptables ](/img/posts/深入浅出OpenStack安全组实现原理/iptables.png)

* (1) 数据包首先到达`PREROUTING`链，然后按照`raw`、`mangle`、`nat`的顺序匹配执行定义在`PREROUTING`的规则。
* (2) 接下来经过路由判断，如果包是发给自己的则流向`INPUT`链，然后由`INPUT`链发给用户空间进程处理。如果不是发给自己的包，则流向`FORWARD`表，同样按照`raw -> mangle -> nat -> filter`表依次匹配执行链上的规则。
* (3) 同理，`ONPUT`链、`POSTROUTING`链，包流向方向，直接看图，非常清晰，这里不再赘述。

前面提到每条链上都可以插入规则，需要注意的是这些规则是有顺序的，iptables每次匹配时都是从第一条规则开始匹配，依次匹配下一条，一旦匹配其中一条规则，则执行对应的动作。

肯定有人会疑问，如果这条链上的规则都不匹配该怎么办，答案是取决于该链的默认策略(policy)。如果该策略是DROP，则最后没有匹配的包都将丢弃，即该链时白名单列表。如果默认策略是ACCEPT，则最后没有匹配的包都会通过,即该链时黑名单列表。当然通常policy都设置为`ACCEPT`，因为配置为`DROP`太危险了，比如清空规则立马就相当于全不通了，如果你通过SSH连接的服务器，则立即中断连接了，不得不通过vnc或者带外console连接重置，所以不建议修改policy。

通过如下命令查看filter表各个链的默认策略:

```
# iptables -nL| grep 'policy'
Chain INPUT (policy ACCEPT)
Chain FORWARD (policy ACCEPT)
Chain OUTPUT (policy ACCEPT)
```

如果一条链规则特别多且复杂，管理起来非常麻烦，因此很有必要对链根据功能分组。iptables通过自定义链实现。用户可以通过`iptables -N name`创建一个新链，然后和内置链一样可以往新链中添加规则。但是需要注意的是，自定义链不能独立存在，必须挂在内置5条链下面，即必须是内置链的子链。

前面1.3节提了下`-j`可以指定一条新链，这里的新链即子链，即iptables是通过`-j`把子链挂到某个规则下面。比如创建一个允许SSH访问的白名单列表，可以创建一个新的子链，SSH相关的策略都放在这个新链中:

```
iptables -N SSH_Access_List
iptables -I INPUT -p tcp -m tcp --dport 22 -j SSH_Access_List
iptables -I SSH_Access_List -s 197.168.1.1 -j RETURN
iptables -I SSH_Access_List -s 197.168.1.2 -j RETURN
# ... 其他白名单
iptables -I SSH_Access_List -j DROP
```

以上第二条命令表示将所有访问本机端口22的包都放到`SSH_Access_List`这条子链上处理，然后这条子链上添加了许多白名单规则，由于进到这个子链的一定是目标22端口的，因此规则无需要在指定`--dport`参数，最后一个`DROP`表示不在白名单列表中的包直接丢掉。

需要注意的是白名单规则中的动作不是`ACCEPT`而是`RETURN`，这两者有什么区别呢？`ACCEPT`表示允许包直接通过INPUT，不需要再匹配INPUT的其他规则。而`RETURN`则表示只是不需要再匹配该子链下的后面规则，但需要返回到该子链的母链的规则或者子链继续匹配，能不能通过INPUT关卡取决于后面的规则。

另外需要注意的是，前面提到内置的5条链可以配置policy，当所有规则都不匹配时，使用policy对包进行处置。但是，自定义链是不支持policy的，更确切的说，不支持设置policy，因为自定义链的policy只能是`RETURN`，即如果子链的规则都不匹配，则一定会返回到母链中继续匹配。

### 1.5 iptables总结

本小节简单介绍了iptables的功能和用法，总结如下：

1. iptables通过规则匹配决定包的去向，规则由匹配条件+动作构成，规则通过`-I`、`-A`插入。
2. 五链五表，五链为`PREROUTING`、`INPUT`、`FORWARD`、`OUTPUT`、`POSTROUTING`，五表为`raw`、`mangle`、`nat`、`filter`、`security`。链、表、规则都是有顺序的。
3. 当链中的所有规则都不匹配时，iptables会根据链设置的默认策略policy处理包，通过policy设置为`ACCEPT`，不建议配置为`DROP`。
4. 可以创建子链挂在内置链中，子链的policy为`RETURN`，不支持配置。
5. 匹配条件包括基本匹配条件以及扩展模块提供的扩展匹配条件，扩展匹配条件通过`-m`参数加载，需要记住的扩展模块为`comment`、`tcp`、`udp`、`icmp`、`mac`、`state`、`physdev`、`set`。
6. 常见的iptables动作(target)为`ACCEPT`、`DROP`、`RETURN`、`LOG`以及跳转到子链。

## 2 OpenStack安全组简介

## 2.1 Neutron安全组 VS Nova安全组？

OpenStack安全组最开始是通过Nova管理及配置的，引入Neutron后，新OpenStack安全组则是通过Neutron管理，并且关联的对象也不是虚拟机，而是port。我们在页面上把虚拟机加到某个安全组，其实是把虚拟机的port关联到安全组中。

由于历史的原因，可能还有些版本的Nova依然保留着对安全组规则的操作API，不过不建议使用，建议通过Neutron进行安全组规则管理。

## 2.2 security group VS firewall

很多刚开始接触OpenStack的用户分不清楚安全组(security group)和防火墙(firewall)的区别，因为二者都是做网络访问控制的，并且社区都是基于iptables实现的。其实二者的区别还是比较大的，

* security group主要是做主机防护的，换句话说安全组是和虚拟机的port相关联，安全组是针对每一个port做网络访问控制，所以它更像是一个主机防火墙。而firewall是针对一个VPC网络的，它针对的是整个VPC的网络控制，通常是在路由做策略。因此security group在计算节点的tap设备上做，而firewall在网络节点的router上做。
* 相对于传统网络模型，security group其实就是类似于操作系统内部自己配置的防火墙，而firewall则是旁挂在路由器用于控制整个局域网网络流量的防火墙。
* security group定义的是允许通过的规则集合，即规则的动作就是ACCEPT。换句话说定义的是白名单规则，因此如果虚拟机关联的是一个空规则安全组，则虚拟机既出不去也进不来。并且由于都是白名单规则，因此安全组规则顺序是无所谓的，而且一个虚拟机port可以同时关联多个安全组，此时相当于规则集合的并集。而firewall规则是有动作的（allow,deny,reject），由于规则既可以是ACCEPT，也可以是DROP，因此先后顺序则非常重要，一个包的命运，不仅取决于规则，还取决于规则的优先级顺序。
* 前面说了security group针对的是虚拟机port，因为虚拟机的IP是已知条件，定义规则时不需要指定虚拟机IP，比如定义入访规则时，只需要定义源IP、目标端口、协议，不需要定义目标IP。而防火墙针对的是整个二层网络，一个二层网络肯定会有很多虚拟机，因此规则需要同时定义源IP、源端口、目标IP、目标端口、协议。之前有人问我一个问题，多个虚拟机关联到了一个安全组，想针对这几个虚拟机做网络访问控制，源IP是192.168.4.5，但我只想开通到两个虚拟机的80端口访问，问我怎么做？我说实现不了，因为关联在同一个安全组的虚拟机网络访问策略是必须是一样的，你没法指定目标IP，如果虚拟机有不同的访问需求，只能通过关联不同的安全组实现。
* security group通常用于实现东西向流量控制实现微分段策略，而firewall则通常用于实现南北向流量控制。


## 2.3 安全组用法介绍

前面介绍了安全组，安全组其实就是一个集合，需要把安全组规则放到这个集合才有意义。

Neutron通过`security-group-create`子命令创建安全组，参数只有一个`name`，即安全组名称:

```
neutron security-group-create int32bit-test-secgroup-1
```

不过Neutron创建的新安全组并不是一个空规则安全组，而是会自动添加两条默认规则:

```
int32bit # neutron security-group-rule-list  \
    -F security_group \
    -F ethertype \
    -F remote \
    -F port/protocol \
    -F direction \
    | grep int32bit-test-secgroup-1
| int32bit-test-secgroup-1 | egress| IPv6| any| any|
| int32bit-test-secgroup-1 | egress| IPv4| any| any|
```

即禁止所有的流量访问，允许所有的流量出去。

创建了安全组后，就可以往安全组里面加规则了。Neutron通过`security-group-rule-create`子命令创建，涉及的参数如下：

* `--direction`: 该规则是出访(egress)还是入访(ingress)。
* `--ethertype`: 以太网类型，ipv4或者ipv6。
* `--protocol`: 协议类型，tcp/udp/icmp等。不指定该参数则表示任意协议。
* `--port-range-min`、`--port-range-max`端口范围，如果只有一个端口，则两个参数填一样即可，端口范围为1~65535。
* `--remote-ip-prefix`，如果是入访则指的是源IP地址段，如果是出访则指的是目标IP段，通过CIDR格式定义，如果只指定一个IP，通过`x.x.x.x/32`指定，如果是任意IP，则通过`0.0.0.0/0`指定。
* `--remote-group-id`: 除了通过ip段指定规则，OpenStack还支持通过安全组作为匹配条件，比如允许关联了xyz安全组的所有虚拟机访问22端口。

创建一条安全组规则只允许192.168.4.5访问虚拟机SSH 22端口：

```bash
int32bit # neutron security-group-rule-create \
>     --direction ingress \
>     --ethertype ipv4 \
>     --protocol tcp \
>     --port-range-min 22 \
>     --port-range-max 22 \
>     --remote-ip-prefix 192.168.4.5/32 \
>     int32bit-test-secgroup-1
Created a new security_group_rule:
+-------------------+--------------------------------------+
| Field             | Value                                |
+-------------------+--------------------------------------+
| created_at        | 2019-06-01T02:42:41Z                 |
| description       |                                      |
| direction         | ingress                              |
| ethertype         | IPv4                                 |
| id                | de122da4-e230-4f59-949b-9e4bd18a96a8 |
| port_range_max    | 22                                   |
| port_range_min    | 22                                   |
| project_id        | b9539efbfe0342f7aef6375ef6586d70     |
| protocol          | tcp                                  |
| remote_group_id   |                                      |
| remote_ip_prefix  | 192.168.4.5/32                       |
| revision_number   | 0                                    |
| security_group_id | 7df7f951-a376-44aa-a582-c8bd96199f82 |
| tenant_id         | b9539efbfe0342f7aef6375ef6586d70     |
| updated_at        | 2019-06-01T02:42:41Z                 |
+-------------------+--------------------------------------+
```

需要注意的是创建安全组和安全组规则只是一个逻辑操作，并不会创建任何iptables规则，只有当安全组被关联到port时才会真正创建对应的iptables规则。

关联安全组通过Neutron的`port-update`命令，比如要把虚拟机uuid为`38147993-08f3-4798-a9ab-380805776a40`添加到该安全组:

```bash
VM_UUID=38147993-08f3-4798-a9ab-380805776a40
PORT_UUID=$(neutron port-list -F id -f value -- --device_id=${VM_UUID})
neutron port-update --security-group int32bit-test-secgroup-1 ${PORT_UUID}
```

安全组命令操作参数较多，相对复杂，可以通过Dashboard图形界面操作，如图：

![security group rule ](/img/posts/深入浅出OpenStack安全组实现原理/security-group-rule.png)

具体操作这里不多介绍。

## 3 安全组实现原理分析

### 3.1 虚拟机网络流向路径

Linux网络虚拟化支持linux bridge以及openvswitch（简称OVS），OpenStack Neutron ml2驱动二者都支持，目前大多数使用的是OVS。

不过早期的iptables不支持OVS bridge以及port，因此为了实现安全组，虚拟机的tap设备并不是直接连接到OVS bridge上，而是中间加了一个Linux bridge，通过veth pair连接Linux bridge以及OVS bridege，这样就可以在Linux bridge上添加iptables规则实现安全组功能了。

目前大多数的OpenStack环境还遵循如上规则，简化的虚拟机流量路径如下：

```
   vm1                  vm2              vm3
    |                    |                |
   tapX                tapY             tapZ
    |                    |                |
    |                    |                |
  qbrX                 qbrY             qbrZ
    |                    |                |
---------------------------------------------   
|                   br-int(OVS)              |
---------------------------------------------
                         |
-----------------------------------------------
|                  br-tun(OVS)                |
-----------------------------------------------
```

其中X、Y、Z为虚拟机port UUID前11位。

## 3.2 安全组规则挂在iptables哪条链？

根据前面的基础，不难猜出安全组的iptables规则肯定是在filter表实现的，filter表只涉及INPUT、FORWARD、OUTPUT三条链，iptables规则流向图可以简化为：

```             
               INPUT                          OUTPUT
                 ^                              | 
                 |                              | 
                 | Y                            |
                 |      N                       v
入口 ----> 路由判断是否发往自己的包 ----> FORWARD  -----> 出口
```


做过主机防火墙的可能第一直觉会认为安全组规则会挂在INPUT以及OUTPUT链上，但根据上面的流程图，当包不是发往自己的，根本到不了INPUT以及OUTPUT，因此显然在INPUT、OUTPUT根本实现不了安全组规则，因此安全组的iptables规则肯定是在FORWARD链上实现的，也就是说计算节点不处理虚拟机的包（发给自己的包除外），只负责转发包。

## 3.3 安全组规则定义

为了便于后面的测试，我提前创建了一台虚拟机`int32bit-server-1`，IP为192.168.100.10/24，port UUID为`3b90700f-1b33-4495-9d64-b41d7dceebd5`，并添加到了之前创建的`int32bit-test-secgroup-1`安全组。

我们先导出本计算节点的所有tap设备对应Neutron的port，该脚本在github[int32bit/OpenStack_Scripts](https://github.com/int32bit/OpenStack_Scripts)可以下载:

```sh
int32bit # ./dump_all_taps.sh
tap8ea41395-1e: 8ea41395-1e13-4b44-a185-0b0f6d75ba9e  192.168.100.254 fa:16:3e:c3:0e:a0 network:router_interface
tap6fee5e4d-56: 6fee5e4d-5655-4411-b85b-db8da2e8f69e  192.168.100.1 fa:16:3e:63:88:59 network:dhcp
tap3b90700f-1b: 3b90700f-1b33-4495-9d64-b41d7dceebd5  192.168.100.10 fa:16:3e:a0:59:ba compute:nova
```

根据前面的分析，虚拟机安全组是定义在filter表的FORWARD链上的，我们查看该链的规则:

```bash
int32bit # iptables -n --line-numbers -L FORWARD
Chain FORWARD (policy ACCEPT)
num  target     prot opt source               destination
1    neutron-filter-top  all  --  0.0.0.0/0            0.0.0.0/0
2    neutron-openvswi-FORWARD  all  --  0.0.0.0/0            0.0.0.0/0
```

FORWARD链先跳到`neutron-filter-top`子链上，`neutron-filter-top`链会又跳到`neutron-openvswi-local`，而`neutron-openvswi-local`链是空链，因此会返回到母链FORWARD上，因此这里第一条规则其实没啥用。

返回到FORWARD链后继续匹配第2条规则，跳转到了`neutron-openvswi-FORWARD`，我们查看该链的规则:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-FORWARD
Chain neutron-openvswi-FORWARD (1 references)
num  target     prot opt source               destination
1    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0  
          PHYSDEV match --physdev-out tap6fee5e4d-56 --physdev-is-bridged
2    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0 
          PHYSDEV match --physdev-out tap8ea41395-1e --physdev-is-bridged
3    neutron-openvswi-sg-chain  all  --  0.0.0.0/0            0.0.0.0/0  
          PHYSDEV match --physdev-out tap3b90700f-1b --physdev-is-bridged
4    neutron-openvswi-sg-chain  all  --  0.0.0.0/0            0.0.0.0/0
          PHYSDEV match --physdev-in tap3b90700f-1b --physdev-is-bridged
```

该链上一共有4条规则，第1、2台规则对应的tap设备分别为dhcp以及router_interface端口，即允许DHCP以及网关的port通过。

而`tap3b90700f-1b`显然是虚拟机port对应的tap设备（名称为tap+portUUID前11位)，第3、4规则表明无论是从这个tap设备进的还是出的包都进入子链`neutron-openvswi-sg-chain`处理。

我们继续查看`neutron-openvswi-sg-chain`查看链:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-sg-chain
Chain neutron-openvswi-sg-chain (4 references)
num  target     prot opt source               destination
1    neutron-openvswi-i3b90700f-1  all  --  0.0.0.0/0            0.0.0.0/0
            PHYSDEV match --physdev-out tap3b90700f-1b --physdev-is-bridged
2    neutron-openvswi-o3b90700f-1  all  --  0.0.0.0/0            0.0.0.0/0
            PHYSDEV match --physdev-in tap3b90700f-1b --physdev-is-bridged
3    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0
```

从规则我们可以看出：

* `--physdev-out`表示从tap3b90700f-1b出来发往虚拟机的包，通过子链`neutron-openvswi-i3b90700f-1`处理，即虚拟机入访流量。
* `--physdev-in`表示从虚拟机发出进入tap3b90700f-1b的包，通过子链`neutron-openvswi-o3b90700f-1`处理，即虚拟机出访流量。

显然`neutron-openvswi-i3b90700f-1`和`neutron-openvswi-o3b90700f-1`分别对应安全组的入访规则和出访规则，即虚拟机的入访规则链为`neutron-openvswi-i + port前缀`，虚拟机的出访规则链为`neutron-openvswi-i + port前缀`。

## 3.4 安全组入访规则

由3.3我们了解到，安全组入访规则链为`neutron-openvswi-i3b90700f-1`，我们查看该链规则:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-i3b90700f-1
Chain neutron-openvswi-i3b90700f-1 (1 references)
num  target     prot opt source               destination
1    RETURN     all  --  0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2    RETURN     udp  --  0.0.0.0/0            192.168.100.10       udp spt:67 dpt:68
3    RETURN     udp  --  0.0.0.0/0            255.255.255.255      udp spt:67 dpt:68
4    RETURN     tcp  --  192.168.4.5          0.0.0.0/0            tcp dpt:22
5    DROP       all  --  0.0.0.0/0            0.0.0.0/0            state INVALID
6    neutron-openvswi-sg-fallback  all  --  0.0.0.0/0            0.0.0.0/0            
```

一共有6条规则：

* 第1条规则我们在前面已经介绍过，应该很熟悉了，主要用于放行回包。
* 第2、3条规则主要用于放行dhcp广播包。
* 第4条即我们前面添加的安全组规则。
* 第5条规则丢弃无用包。
* 第6条用来处理所有规则都不匹配的包，跳转到`neutron-openvswi-sg-fallback`链，而该链其实只有一条规则，即DROP ALL。因此不匹配安全组规则的包都会直接丢弃。

安全组入访规则中第1、2、3、5、6都是固定的，当有新的安全组策略时就往第4条规则后面追加。

## 3.5 安全组出访规则

由3.3我们了解到，安全组入访规则链为`neutron-openvswi-o3b90700f-1`，我们查看该链规则:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-o3b90700f-1
Chain neutron-openvswi-o3b90700f-1 (2 references)
num  target     prot opt source               destination
1    RETURN     udp  --  0.0.0.0              255.255.255.255      udp spt:68 dpt:67
2    neutron-openvswi-s3b90700f-1  all  --  0.0.0.0/0            0.0.0.0/0
3    RETURN     udp  --  0.0.0.0/0            0.0.0.0/0            udp spt:68 dpt:67
4    DROP       udp  --  0.0.0.0/0            0.0.0.0/0            udp spt:67 dpt:68
5    RETURN     all  --  0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED 
6    RETURN     all  --  0.0.0.0/0            0.0.0.0/0
7    DROP       all  --  0.0.0.0/0            0.0.0.0/0            state INVALID 
8    neutron-openvswi-sg-fallback  all  --  0.0.0.0/0            0.0.0.0/0            
```

一共有8条规则:

* 第1、3条规则用于放行虚拟机DHCP client广播包。
* 第2条规则，放到第4章再介绍。
* 第4条规则用于阻止DHCP欺骗，避免用户在虚拟机内部自己启一个DHCP Server影响Neutron的DHCP Server。
* 第5条规则不再解释。
* 第6条规则是我们的安全组规则，因为我们的安全组出访是ANY，因此所有包都放行。
* 第7条规则丢弃无用包。
* 第8条规则用来处理所有规则都不匹配的包，跳转到`neutron-openvswi-sg-fallback`链，而该链其实只有一条规则，即DROP ALL。因此不匹配安全组规则的包都会直接丢弃。

## 3.6 安全组使用安全组作为匹配条件

前面2.3节提到，安全组不仅支持通过IP地址段作为源或者目标的匹配条件，还支持通过指定另一个安全组，这种情况怎么处理呢。

为了测试我把创建了一个新的安全组int32bit-test-secgroup-2以及新的虚拟机int32bit-server-2(192.168.100.7)，并且int32bit-server-2关联了安全组int32bit-test-secgroup-2。

同时在int32bit-test-secgroup-1上增加一条入访规则，允许关联int32bit-test-secgroup-2的虚拟机访问8080端口:

```bash
SECURITY_GROUP_UUID=$(neutron security-group-list \
    -F id -f value \
    --name=int32bit-test-secgroup-2
)
neutron security-group-rule-create \
    --direction ingress \
    --ethertype ipv4 \
    --protocol tcp \
    --port-range-min 8080 \
    --port-range-max 8080 \
    --remote-group-id ${SECURITY_GROUP_UUID} \
    int32bit-test-secgroup-1
```

我们查看虚拟机入访规则链`neutron-openvswi-i3b90700f-1`:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-i3b90700f-1
Chain neutron-openvswi-i3b90700f-1 (1 references)
num  target     prot opt source               destination
1    RETURN     all  --  0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
2    RETURN     udp  --  0.0.0.0/0            192.168.100.10       udp spt:67 dpt:68
3    RETURN     udp  --  0.0.0.0/0            255.255.255.255      udp spt:67 dpt:68
4    RETURN     tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:8080
 match-set NIPv4fc83d82a-5b5d-4c90-80b0- src
5    RETURN     tcp  --  192.168.4.5          0.0.0.0/0            tcp dpt:22
6    DROP       all  --  0.0.0.0/0            0.0.0.0/0            state INVALID 
7    neutron-openvswi-sg-fallback  all  --  0.0.0.0/0            0.0.0.0/0            
```

我们发现插入了一条新的规则，编号为4。该规则使用了`set`扩展模块，前面介绍过`set`是用来匹配ipset的，后面的参数`NIPv4fc83d82a-5b5d-4c90-80b0-`为ipset名，显然是由`NIPv4+安全组UUID前缀`组成。

我们查看该ipset：

```bash
int32bit # ipset list NIPv4fc83d82a-5b5d-4c90-80b0-
Name: NIPv4fc83d82a-5b5d-4c90-80b0-
Type: hash:net
Revision: 3
Header: family inet hashsize 1024 maxelem 65536
Size in memory: 16816
References: 1
Members:
192.168.100.7
```

可见192.168.100.7在ipset集合中。

因此OpenStack安全组使用安全组作为匹配条件时是通过ipset实现的，每个安全组会对应创建一个ipset集合，关联的虚拟机IP会放到这个集合中，iptables通过ipset匹配实现了安全组匹配功能。

## 4 安全组anti snoop功能

前面3.5节提到第2条规则，所有的包都会先进入`neutron-openvswi-s3b90700f-1`子链处理，这个链是干什么的呢？

我们首先查看下里面的规则:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-s3b90700f-1
Chain neutron-openvswi-s3b90700f-1 (1 references)
num  target     prot opt source               destination
1    RETURN     all  --  192.168.100.10       0.0.0.0/0            MAC FA:16:3E:A0:59:BA
2    DROP       all  --  0.0.0.0/0            0.0.0.0/0
```

这条链的处理逻辑很简单，只放行IP是192.168.100.10并且MAC地址是FA:16:3E:A0:59:BA的包通过。这其实是Neutron默认开启的反欺骗anti snoop功能，只有IP和MAC地址匹配Neutron port分配的才能通过。换句话说，你起了个虚拟机IP为192.168.3.1，然后自己手动把网卡的IP篡改为192.168.3.2，肯定是不允许通过的。

但是呢，我们业务又往往有virtual ip的需求，最常见的如haproxy、pacemaker的vip。OpenStack考虑了这种需求，支持用户添加白名单列表，通过port的allowed address pairs配置。

比如我有两个虚拟机，IP分别为192.168.0.10、192.168.0.11，申请了一个port 192.168.0.100作为这个两个虚拟机的vip，可以通过Neutron更新port信息实现:

```
neutron port-update --allowed-address-pair ip_address=192.168.0.100 ${port_id_1}
neutron port-update --allowed-address-pair ip_address=192.168.0.100 ${port_id_2}
```

添加后我们再查看下`neutron-openvswi-s3b90700f-1`链规则:

```
int32bit # iptables -n --line-numbers -L neutron-openvswi-s3b90700f-1
Chain neutron-openvswi-s3b90700f-1 (1 references)
num  target     prot opt source               destination
1    RETURN     all  --  192.168.0.100        0.0.0.0/0            MAC FA:16:3E:A0:59:BA 
2    RETURN     all  --  192.168.100.10       0.0.0.0/0            MAC FA:16:3E:A0:59:BA 
3    DROP       all  --  0.0.0.0/0            0.0.0.0/0            
```

可见在最前面添加了一条规则允许IP为192.168.0.100的包通过，此时在虚拟机192.168.0.10上把IP改为192.168.0.100也可以ping通了。

## 5 虚拟机访问宿主机怎么办？

我们已经知道，安全组是在filter表的FORWARD链上实现的，但如果虚拟机的包是去往宿主机时，由于内核判断目标地址就是自己，因此不会流到FORWARD链而是发往INPUT链，那这样岂不就是绕过安全组规则了吗？


```         
               INPUT                                       OUTPUT
                 ^                                           | 
                 |                                           |
                 | Y                                         |
                 |      N                                    v
入口 ----> 路由判断是否发往自己的包 --X--> FORWARD(安全组在这里)  -----> 出口
```

解决办法很简单，只需要把`neutron-openvswi-o3b90700f-1`再挂到INPUT链就可以了。

我们查看INPUT链规则:

```
int32bit # iptables -n --line-numbers -L INPUT
Chain INPUT (policy ACCEPT)
num  target     prot opt source               destination
1    neutron-openvswi-INPUT  all  --  0.0.0.0/0            0.0.0.0/0

int32bit # iptables -n --line-numbers -L neutron-openvswi-INPUT
Chain neutron-openvswi-INPUT (1 references)
num  target     prot opt source               destination
1    neutron-openvswi-o3b90700f-1  all  --  0.0.0.0/0  0.0.0.0/0
 PHYSDEV match --physdev-in tap3b90700f-1b --physdev-is-bridged
```

即:

```
INPUT -> neutron-openvswi-INPUT -> neutron-openvswi-o3b90700f-1
```

有人可能会问，那宿主机发往虚拟机的包会出现问题吗？需要在OUTPUT链上添加规则吗？答案是不需要，因为从OUTPUT直接出去，当作正常流程走就可以了。

## 6 总结

本文首先简单介绍了下iptables，然后介绍OpenStack安全组，最后详细分析了安全组的实现原理。

另外写了一个脚本可以快速导出虚拟机的iptables规则，需要在计算节点上运行:

```bash
#!/bin/bash
SERVER_UUID=$1

if [[ -z $SERVER_UUID ]]; then
    echo "Usage: $0 <server_uuid>"
    exit 1
fi
PORT_ID=$(neutron port-list -F id -f value -- --device_id=$SERVER_UUID)
if [[ -z $PORT_ID ]]; then
    echo "Port not found for server '$SERVER_UUID'."
    exit 1
fi
PORT_PREFIX=${PORT_ID:0:10}

echo "# Ingress rules: "
iptables-save | grep "^-A neutron-openvswi-i$PORT_PREFIX"

echo -e "\n# Egress rules: "
iptables-save | grep "^-A neutron-openvswi-o$PORT_PREFIX"

echo -e "\n# Security rules: "
iptables-save | grep "^-A neutron-openvswi-s$PORT_PREFIX"

echo -e "\n# Fallback rules: "
iptables-save | grep "^-A neutron-openvswi-sg-fallback"
```
