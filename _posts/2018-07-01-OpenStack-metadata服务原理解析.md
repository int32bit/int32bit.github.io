---
layout:  post
title: OpenStack虚拟机如何获取metadata
catalog: true
tag: [OpenStack]
---

## 1. 关于OpenStack metadata服务

我们知道OpenStack虚拟机是通过cloud-init完成初始化配置，比如网卡配置、hostname、初始化密码以及密钥配置等。cloud-init是运行在虚拟机内部的一个进程，它通过datasource获取虚拟机的配置信息(即metadata)。cloud-init实现了很多不同的datasource，不同的datasource实现原理不一样。比较常用的datasource主要有以下两种：

* ConfigDriver: Nova把所有配置信息写入到本地的一个raw文件中，然后通过cdrom形式挂载到虚拟机中。此时在虚拟机内部可以看到类似`/dev/sr0`（注：sr代表 scsi + rom)的虚拟设备。cloud-init只需要读取`/dev/sr0`文件信息即可获取虚拟机配置信息。
* Metadata: Nova在本地启动一个HTTP metadata服务，虚拟机只需要通过HTTP访问该metadata服务获取相关的虚拟机配置信息。

ConfigDriver的实现原理比较简单，本文不再介绍。这里重点介绍Metadata，主要解决以下两个问题：

1. Nova Metadata服务启动在宿主机上（nova-api所在的控制节点），虚拟机内部租户网络和宿主机的物理网络是不通的，虚拟机如何访问Nova的Metadata服务。
2. 假设问题1已经解决，那么Nova Metadata服务如何知道是哪个虚拟机发起的请求。

## 2. Metadata服务配置

### 2.1 Nova配置

Nova的metadata服务名称为nova-api-metadata，不过通常会把服务与nova-api服务合并:

```ini
[DEFAULT]
enabled_apis = osapi_compute,metadata
```

另外虚拟机访问Nova的Metadata服务需要Neutron转发，原因后面讲，这里只需要注意在`nova.conf`配置:

```ini
[neutron]
service_metadata_proxy = true
```

### 2.2 Neutron配置

前面提到虚拟机访问Nova的Metadata服务需要Neutron转发，可以通过l3-agent转发，也可以通过dhcp-agent转发，如何选择需要根据实际情况：

* 通过l3-agent转发，则虚拟机所在的网络必须关联了router。
* 通过dhcp-agent转发，则虚拟机所在的网络必须开启dhcp功能。

Metadata默认是通过l3-agent转发的，不过由于在实际情况下，虚拟机的网络通常都会开启dhcp功能，但不一定需要router，因此我更倾向于选择通过dhcp-agent转发，配置如下:

```ini
# /etc/neutron/dhcp_agent.ini
[DEFAULT]
force_metadata = true

# /etc/neuron/l3_agent.ini
[DEFAULT]
enable_metadata_proxy = false
```

本文接下来的所有内容均基于以上配置环境。

## 3 OpenStack虚拟机如何访问Nova Metadata服务

### 3.1 从虚拟机访问Metadata服务说起

cloud-init访问metadata服务的URL地址是`http://169.254.169.254`，这个IP很特别，主要是效仿了AWS的Metadata服务地址，它的网段是`169.254.0.0/16`，这个IP段其实是保留的，即[IPv4 Link Local Address](https://en.m.wikipedia.org/wiki/Link-local_address)，它和私有IP(10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)类似，不能用于互联网路由，通常只用于直连网络。如果操作系统(Windows)获取IP失败，也有可能自动配置为`169.254.0.0/16`网段的一个IP。

那AWS为什么选择169.254.169.254这个IP呢，这是因为选择Link Local IP可以避免与用户的IP冲突，至于为什么选择169.254.169.254这个IP而不是169.254.0.0/24的其它IP，大概是为了好记吧。

另外AWS还有几个很有趣的地址：

* 169.254.169.253: DNS服务。
* 169.254.169.123: NTP服务。

更多关于169.254.169.254信息，可以参考[whats-special-about-169-254-169-254-ip-address-for-aws](https://stackoverflow.com/questions/42314029/whats-special-about-169-254-169-254-ip-address-for-aws)。

OpenStack虚拟机也是通过`http://169.254.169.254`获取虚拟机的初始化配置信息：

```json
$ curl -sL 169.254.169.254/openstack/latest/meta_data.json
{"uuid": "daf32a70-42c9-4d30-8ec5-3a5d97582cff", "availability_zone": "nova", "hostname": "int32bit-test-1.novalocal", "launch_index": 0, "devices": [], "project_id": "ca17d50f6ac049928cc2fb2217dab93b", "name": "int32bit-test-1"}
```

从以上输出可见从metadata服务中我们获取了虚拟机的uuid、name、project id、availability_zone、hostname等。

虚拟机怎么通过访问169.254.169.254这个地址就可以获取Metadata信息呢，我们首先查看下虚拟机的路由表:

```sh
# route  -n
Kernel IP routing table
Destination     Gateway         Genmask         Flags Metric Ref    Use Iface
0.0.0.0         10.0.0.126      0.0.0.0         UG    0      0        0 eth0
10.0.0.64       0.0.0.0         255.255.255.192 U     0      0        0 eth0
169.254.169.254 10.0.0.66       255.255.255.255 UGH   0      0        0 eth0
```

我们可以看到169.254.169.254的下一跳为10.0.0.66。10.0.0.66这个IP是什么呢？我们通过Neutron的port信息查看下:

```bash
# neutron port-list -c network_id -c device_owner -c mac_address -c fixed_ips  -f csv | grep 10.0.0.66
"2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a","network:dhcp","fa:16:3e:b3:e8:38","[{u'subnet_id': u'6f046aae-2158-4882-a818-c56d81bc8074', u'ip_address': u'10.0.0.66'}]"
```

可看到10.0.0.66正好是网络`2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a`的dhcp地址，可以进一步验证:

```sh
# ip netns exec qdhcp-2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a ifconfig
tap1332271e-0d: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1450
        inet 10.0.0.66  netmask 255.255.255.192  broadcast 10.0.0.127
        inet6 fe80::f816:3eff:feb3:e838  prefixlen 64  scopeid 0x20<link>
        ether fa:16:3e:b3:e8:38  txqueuelen 1000  (Ethernet)
        RX packets 662  bytes 58001 (56.6 KiB)
        RX errors 0  dropped 0  overruns 0  frame 0
        TX packets 410  bytes 55652 (54.3 KiB)
        TX errors 0  dropped 0 overruns 0  carrier 0  collisions 0
```

由此，我们可以得出结论，OpenStack虚拟机访问169.254.169.254会路由到虚拟机所在网络的DHCP地址，DHCP地址与虚拟机IP肯定是可以互通的，从而解决了虚拟机内部到宿主机外部的通信问题。那DHCP又如何转发到Nova Metadata服务呢，下一节将介绍如何解决这个问题。

### 3.2 Metadata请求第一次转发

前面介绍了虚拟机访问Metadata服务地址169.254.169.254，然后转发到DHCP地址。我们知道Neutron的DHCP port被放到了namespace中，我们不妨进入到虚拟机所在网络的namespace:

```sh
ip netns exec qdhcp-2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a bash
```

首先查看该namespace的路由:

```sh
# route -n
Kernel IP routing table
Destination     Gateway         Genmask         Flags Metric Ref    Use Iface
0.0.0.0         10.0.0.126      0.0.0.0         UG    0      0        0 tap1332271e-0d
10.0.0.64       0.0.0.0         255.255.255.192 U     0      0        0 tap1332271e-0d
169.254.0.0     0.0.0.0         255.255.0.0     U     0      0        0 tap1332271e-0d
```

从路由表中看出`169.254.0.0/16`是从网卡`tap1332271e-0d`发出去的，我们查看网卡地址信息:

```sh
# ip a
18: tap1332271e-0d: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1450 qdisc noqueue state UNKNOWN qlen 1000
    link/ether fa:16:3e:b3:e8:38 brd ff:ff:ff:ff:ff:ff
    inet 10.0.0.66/26 brd 10.0.0.127 scope global tap1332271e-0d
       valid_lft forever preferred_lft forever
    inet 169.254.169.254/16 brd 169.254.255.255 scope global tap1332271e-0d
       valid_lft forever preferred_lft forever
    inet6 fe80::f816:3eff:feb3:e838/64 scope link
       valid_lft forever preferred_lft forever
```

我们发现，169.254.169.254其实是配在网卡`tap1332271e-0d`的一个虚拟IP。虚拟机能够访问169.254.169.254这个地址也就不足为奇了。需要注意的是，本文的metadata转发配置是通过dhcp-agent实现的，如果是l3-agent，则169.254.169.254是通过iptables转发。

我们能够访问`curl http://169.254.169.254`，说明这个地址肯定开放了80端口:

```sh
# netstat -lnpt
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN      11334/haproxy
tcp        0      0 10.0.0.66:53            0.0.0.0:*               LISTEN      11331/dnsmasq
tcp        0      0 169.254.169.254:53      0.0.0.0:*               LISTEN      11331/dnsmasq
tcp6       0      0 fe80::f816:3eff:feb3:53 :::*                    LISTEN      11331/dnsmasq
```

从输出中看，所在的环境除了开启了DHCP服务(53端口)，确实监听了80端口，进程pid为`11334/haproxy`。

我们看到haproxy这个进程就可以猜测是负责请求的代理与转发，即OpenStack虚拟机首先会把请求转发到DHCP所在namespace的haproxy监听端口80。

问题又来了，DHCP所在的namespace网络仍然和Nova Metadata是不通的，那haproxy如何转发请求到Nova Metadata服务呢，我们下一节介绍。

### 3.3 Metadata请求第二次转发

前面我们介绍了OpenStack虚拟机访问`http://169.254.169.254`会被转发到DHCP所在namespace的haproxy监听的80端口中。但是，namespace中仍然无法访问Nova Metadata服务。

为了研究解决办法，我们首先看下这个haproxy进程信息:

```sh
cat /proc/11334/cmdline | tr '\0' ' '
haproxy -f /opt/stack/data/neutron/ns-metadata-proxy/2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a.conf
```

其中`2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a.conf`配置文件部分内容如下:

```
listen listener
    bind 0.0.0.0:80
    server metadata /opt/stack/data/neutron/metadata_proxy
    http-request add-header X-Neutron-Network-ID 2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a
```

我们发现haproxy绑定的端口为80，后端地址为一个文件`/opt/stack/data/neutron/metadata_proxy`。后端不是一个IP/TCP地址，那必然是一个UNIX Socket文件:

```sh
# ll /opt/stack/data/neutron/metadata_proxy
srw-r--r-- 1 stack stack 0 Jul  1 13:30 /opt/stack/data/neutron/metadata_proxy
```

因此我们得出结论，haproxy进程会把OpenStack虚拟机Metadata请求转发到本地的一个socket文件中。

UNIX Domain Socket是在socket架构上发展起来的用于同一台主机的进程间通讯（IPC），它不需要经过网络协议栈实现将应用层数据从一个进程拷贝到另一个进程，有点类似于Unix管道(pipeline)。

问题又来了:

* 我们从haproxy配置看，监听的地址是`0.0.0.0:80`，那如果有多个网络同时都监听80端口岂不是会出现端口冲突吗？
* socket只能用于同一主机的进程间通信，如果Nova Metadata服务与Neutron dhcp-agent不在同一个主机，则显然还是无法通信。


第一个问题其实前面已经解决了，haproxy是在虚拟机所在网络的DHCP namespace中启动的，我们可以验证:

```
# lsof -i :80
COMMAND   PID  USER   FD   TYPE   DEVICE SIZE/OFF NODE NAME
haproxy 11334 stack    4u  IPv4 65729753      0t0  TCP *:http (LISTEN)
# ip netns identify 11334
qdhcp-2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a
```

关于第二个问题，显然还需要一层转发，具体内容请看下一小节内容。


### 3.4 Metadata请求第三次转发

前面说到，haproxy会把Metadata请求转发到本地的一个socket文件中，那么，到底是哪个进程在监听`/opt/stack/data/neutron/metadata_proxy`socket文件呢？我们通过`lsof`查看下:

```
# lsof /opt/stack/data/neutron/metadata_proxy
COMMAND     PID  USER   FD   TYPE             DEVICE SIZE/OFF     NODE NAME
neutron-m 11085 stack    3u  unix 0xffff8801c8711c00      0t0 65723197 /opt/stack/data/neutron/metadata_proxy
neutron-m 11108 stack    3u  unix 0xffff8801c8711c00      0t0 65723197 /opt/stack/data/neutron/metadata_proxy
neutron-m 11109 stack    3u  unix 0xffff8801c8711c00      0t0 65723197 /opt/stack/data/neutron/metadata_proxy
# cat /proc/11085/cmdline  | tr '\0' ' '
/usr/bin/python /usr/bin/neutron-metadata-agent --config-file /etc/neutron/neutron.conf
```

可见neutron-metadata-agent监听了这个socket文件，相当于haproxy把Metadata服务通过socket文件转发给了neutron-metadata-agent服务。

neutron-metadata-agent初始化代码如下:

```
def run(self):
    server = agent_utils.UnixDomainWSGIServer('neutron-metadata-agent')
    server.start(MetadataProxyHandler(self.conf),
                 self.conf.metadata_proxy_socket,
                 workers=self.conf.metadata_workers,
                 backlog=self.conf.metadata_backlog,
                 mode=self._get_socket_mode())
    self._init_state_reporting()
    server.wait()
```

进一步验证了neutron-metadata-agent监听了`/opt/stack/data/neutron/metadata_proxy`socket文件。

由于neutron-metadata-agent是控制节点上的进程，因此和Nova Metadata服务肯定是通的, OpenStack虚拟机如何访问Nova Metadata服务问题基本就解决了。

```
curl 169.254.169.254 -> haproxy(80端口) -> UNIX Socket文件 -> neutron-metadata-agent -> nova-api-metadata
```

即一共需要三次转发。

但是Nova Metadata服务如何知道是哪个虚拟机发送过来的请求呢？换句话说，如何获取该虚拟机的uuid，我们将在下一章介绍。

## 4 Metadata服务如何获取虚拟机信息

前一章介绍了OpenStack虚拟机如何通过169.254.169.254到达Nova Metadata服务，那到达之后如何判断是哪个虚拟机发送过来的呢？

OpenStack是通过neutron-metadata-agent获取虚拟机的uuid的。我们知道，在同一个Neutron network中，即使有多个subnet，也不允许IP重复，即通过IP地址能够唯一确定Neutron的port信息。而neutron port会设置`device_id`标识消费者信息，对于虚拟机来说，即虚拟机的uuid。

因此neutron-metadata-agent通过network uuid以及虚拟机ip即可获取虚拟机的uuid。

不知道大家是否还记得在haproxy配置文件中存在一条配置项:

```
http-request add-header X-Neutron-Network-ID 2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a
```

即haproxy转发之前会把network id添加到请求头部中，而IP可以通过HTTP的头部`X-Forwarded-For`中获取。因此neutron-metadata-agent具备获取虚拟机的uuid以及project id(租户id)条件，我们可以查看neutron-metadata-agent获取虚拟机uuid以及project id实现，代码位于`neutron/agent/metadata/agent.py`:

```python
def _get_instance_and_tenant_id(self, req):
    remote_address = req.headers.get('X-Forwarded-For')
    network_id = req.headers.get('X-Neutron-Network-ID')
    router_id = req.headers.get('X-Neutron-Router-ID')

    ports = self._get_ports(remote_address, network_id, router_id)
    if len(ports) == 1:
        return ports[0]['device_id'], ports[0]['tenant_id']
    return None, None
```

如果谁都可以伪造Metadata请求获取任何虚拟机的metadata信息，显然是不安全的，因此在转发给Nova Metadata服务之前，还需要发一个secret:

```python
def _sign_instance_id(self, instance_id):
    secret = self.conf.metadata_proxy_shared_secret
    secret = encodeutils.to_utf8(secret)
    instance_id = encodeutils.to_utf8(instance_id)
    return hmac.new(secret, instance_id, hashlib.sha256).hexdigest()
```

`metadata_proxy_shared_secret`需要管理员配置，然后组合虚拟机的uuid生成一个随机的字符串作为key。

最终，neutron-metadata-agent会把虚拟机信息放到头部中，发送到Nova Metadata服务的头部信息如下：

```python
headers = {
    'X-Forwarded-For': req.headers.get('X-Forwarded-For'),
    'X-Instance-ID': instance_id,
    'X-Tenant-ID': tenant_id,
    'X-Instance-ID-Signature': self._sign_instance_id(instance_id)
}
```

此时Nova Metadata就可以通过虚拟机的uuid查询metadata信息了，代码位于`nova/api/metadata/base.py`:

```python
def get_metadata_by_instance_id(instance_id, address, ctxt=None):
    ctxt = ctxt or context.get_admin_context()
    attrs = ['ec2_ids', 'flavor', 'info_cache',
             'metadata', 'system_metadata',
             'security_groups', 'keypairs',
             'device_metadata']
    try:
        im = objects.InstanceMapping.get_by_instance_uuid(ctxt, instance_id)
    except exception.InstanceMappingNotFound:
        LOG.warning('Instance mapping for %(uuid)s not found; '
                    'cell setup is incomplete', {'uuid': instance_id})
        instance = objects.Instance.get_by_uuid(ctxt, instance_id,
                                                expected_attrs=attrs)
        return InstanceMetadata(instance, address)

    with context.target_cell(ctxt, im.cell_mapping) as cctxt:
        instance = objects.Instance.get_by_uuid(cctxt, instance_id,
                                                expected_attrs=attrs)
        return InstanceMetadata(instance, address)
```

## 5 在虚拟机外部如何获取虚拟机metadata

前面已经介绍了OpenStack虚拟机从Nova Metadata服务获取metadata的过程。有时候我们可能需要调试虚拟机的metadata信息，验证传递的数据是否正确，而又嫌麻烦不希望进入虚拟机内部去调试。有什么方法能够直接调用nova-api-metadata服务获取虚拟机信息呢。

根据前面介绍的原理，我写了两个脚本实现:

第一个Python脚本`sign_instance.py`用于生成secret:

```python
sign_instance.py

import six
import sys
import hmac
import hashlib

def sign_instance_id(instance_id, secret=''):
    if isinstance(secret, six.text_type):
        secret = secret.encode('utf-8')
    if isinstance(instance_id, six.text_type):
        instance_id = instance_id.encode('utf-8')
    return hmac.new(secret, instance_id, hashlib.sha256).hexdigest()
print(sign_instance_id(sys.argv[1]))
```

第二个bash脚本`get_metadata.py`实现获取虚拟机metadata:

```bash
#!/bin/bash
metadata_server=http://192.168.1.16:8775
metadata_url=$metadata_server/openstack/latest
instance_id=$1
data=$2
if [[ -z $instance_id ]]; then
    echo "Usage: $0 <instance_id>"
    exit 1
fi
tenant_id=$(nova show $instance_id | awk '/tenant_id/{print $4}')
sign_instance_id=$(python sign_instance.py $instance_id)
curl -sL -H "X-Instance-ID:$instance_id" -H "X-Instance-ID-Signature:$sign_instance_id" -H "X-Tenant-ID:$tenant_id"  $metadata_url/$data
```

其中`metadata_server`为Nova Metadata服务地址。

用法如下:

```
# ./get_metadata.sh daf32a70-42c9-4d30-8ec5-3a5d97582cff
meta_data.json
password
vendor_data.json
network_data.json
# ./get_metadata.sh daf32a70-42c9-4d30-8ec5-3a5d97582cff network_data.json | python -m json.tool
{
    "links": [
        {
            "ethernet_mac_address": "fa:16:3e:e8:81:9b",
            "id": "tap28468932-9e",
            "mtu": 1450,
            "type": "ovs",
            "vif_id": "28468932-9ea0-43d0-b699-ba19bf65cae3"
        }
    ],
    "networks": [
        {
            "id": "network0",
            "link": "tap28468932-9e",
            "network_id": "2c4b658c-f2a0-4a17-9ad2-c07e45e13a8a",
            "type": "ipv4_dhcp"
        }
    ],
    "services": []
}
```

## 5 总结

最后通过一张工作流图总结：


![OpenStack Metadata Workflow](/img/posts/OpenStack-Metadata服务原理解析/OpenStack-Metadata-Workflow.png)

源码:

```
title OpenStack Metadata WorkFlow

participant vm
participant haproxy
participant UNIX Socket
participant neutron-metadata-agent
participant nova-api-metadata

vm -> haproxy: curl 169.254.169.254(第一次转发） 
note over haproxy: Add header X-Neutron-Network-ID
haproxy -> UNIX Socket: 第二次转发
UNIX Socket -> neutron-metadata-agent: 第二次转发
note over neutron-metadata-agent: get_instance_and_tenant_id
note over neutron-metadata-agent: sign_instance_id
neutron-metadata-agent -> nova-api-metadata: 第三次转发 
note over nova-api-metadata: get_metadata_by_instance_id
nova-api-metadata -> neutron-metadata-agent: metadata
neutron-metadata-agent -> UNIX Socket: metadata
UNIX Socket -> haproxy: metadata
haproxy -> vm: metadata
```

更多关于OpenStack的工作流图可参考[int32bit/openstack-workflow](https://github.com/int32bit/openstack-workflow):`https://github.com/int32bit/openstack-workflow`。
