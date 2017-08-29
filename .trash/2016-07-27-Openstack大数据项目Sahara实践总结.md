---
layout: post
title: Openstack大数据Sahara项目实践总结
catalog: true
tags:
     - Openstack
     - Sahara
     - 大数据
---

## 1. Sahara 简介

### 1.1 概述

Apache Hadoop是目前广泛使用的分布式大数据处理计算框架，而Openstack Sahara项目的目标是使用户能够在Openstack平台上一键式创建和管理Hadoop集群，实现类似AWS的EMR（Amazon Elastic MapReduce service）功能。用户只需要提供简单的配置参数和模板，如版本信息(如CDH版本）、集群拓扑（几个Slave，几个datanode）、节点配置信息（CPU、内存）等，Sahara服务就能够在几分钟时间内根据提供的模板快速部署Hadoop、Spark以及Storm集群。Sahara目支持节点的动态扩展（scalable），几乎所有插件支持扩容操作，部分插件还支持缩容，能够方便地按需增加或者减少节点数量，实现弹性大数据计算服务，适合开发人员或者QA在Openstack平台上快速部署大数据处理平台。

### 1.2 Sahara功能特性

* Openstack的标准组件之一，因此能够和Openstack其他服务无缝集成；
* 支持通过REST API和Dashboard UI界面管理集群；
* 支持多种大数据计算框架，包括但不限于：
* 多种Hadoop厂商发行版，比如CDH、HDP、MapR等；
* 支持Apache Spark和Storm；
* 可插除的Hadoop安装引擎，L版之后默认使用Heat引擎；
* 集成厂商的管理工具，如Apache Ambari 和Cloudera Manager。
* 可集成其他外部监控工具，比如Nagios、Zabbix，支持同时监控多个hadoop集群
* 支持json/yaml配置模板。
* 支持外部监控工具，比如Nagios，Zabbix等。
* 支持节点动态扩展。

### 1.3 Sahara支持的外部数据源

* HDFS，支持所有的任务类型
* Swift，除了Hive，其他都支持
* Manila，除了Pig，其他都支持
* Trove，尚未实现
* S3，尚未实现
* RGW，社区尚未合并


当前L版支持的Hadoop生态圈组件，以CDH 5.4为例:

* Hue
* HDFS
* YARN
* Hbase
* Hive
* oozie
* Impara
* Zookeeper
* Flume
* KMS
* Solr
* Spark
* Sqoop (v2)


**注：HDP还支持kafka服务。**

### 1.4 hadoop版本

L版官方支持的版本信息统计如下:

* Vanilla Apache Hadoop最新支持版本2.7.1，2.6.0废弃
* Spark最新支持1.3.1，可以修改源码支持1.6.0
* CDH最新支持5.4
* HDP 2.3
* MapR 5.0
* Storm 0.9.2

### 1.5 Sahara组件介绍

当前L版Sahara主要包括两个服务，分别为sahara-api服务和sahara-engine服务，后期可能单独从中分离出sahara-conductor服务。

* sahara-api：和其他组件api服务功能类似，这是sahara服务的唯一入口，提供REST API服务。
* sahara-engine： api完成一些参数检查后会把工作交给engine，engine接管工作，包括集群检查、资源分配以及配置管理等

如图:

![sahara架构图](/img/posts/Openstack大数据Sahara项目实践/sahara-arch.png)


其他依赖的组件还包括：
 
* 数据库服务，比如mysql。sahara需要RDBS保存集群信息。
* 消息队列服务，比如rabbitmq，用于实现sahara-api和sahara-engine通信。
* Openstack必须依赖的基础服务：

	* Keystone
	* Glance
	* Nova
	* Neutron。
* 其它Openstack服务：
	* Cinder
	* Heat服务，L版之后必须部署Heat服务，direct方式已经被废弃。

与其它服务的交互图如下:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/sahara.png)
	
## 2. Sahara服务部署

Sahara服务主要包括api节点的部署和engine节点的部署。

### 2.1 API服务

#### 2.1.1 创建sahara数据库

```sql
CREATE DATABASE sahara;
GRANT ALL PRIVILEGES ON sahara.* TO 'sahara'@'localhost' \
  IDENTIFIED BY 'SAHARA_DBPASS';
GRANT ALL PRIVILEGES ON sahara.* TO 'nova'@'%' \
  IDENTIFIED BY 'SAHARA_DBPASS';
```
 
#### 2.1.2 新建sahara endpoint

```bash
openstack user create --domain default --password SAHARA_PASS sahara # 注意替换密码
openstack role add --project services --user sahara admin
openstack service create --name sahara --description "Sahara Data Processing"  data-processing
openstack endpoint create --region RegionOne data-processing public http://lb.103.hatest.int32bit.in:8386/v1.1/%\(tenant_id\)s # 注意替换地址
openstack endpoint create --region RegionOne data-processing internal http://lb.103.hatest.int32bit.in:8386/v1.1/%\(tenant_id\)s # 注意替换地址
openstack endpoint create --region RegionOne data-processing admin http://lb.103.hatest.int32bit.in:8386/v1.1/%\(tenant_id\)s # 注意替换地址
```

#### 2.1.3 安装sahara包

```bash
yum install openstack-sahara.noarch
```

#### 2.1.4 Sahara配置

修改配置文件`/etc/sahara/sahara.conf`，内容如下：

```
[DEFAULT]
debug=true # 仅测试时设置为true，生产时为false
verbose = true # 建议设置为true，便于问题排查
log_dir = /var/log/sahara
use_syslog = false
use_stderr = true
#notification_topics = notifications # 若部署了ceilometer，需要指定ceilometer消息topic
rpc_backend = rabbit
use_floating_ips= False # 不需要设置公有ip，设置为false
use_neutron = true # 使用neutron，必须设置为true
use_namespaces = true # neutron使用namespace，设置为true
use_rootwrap = true # 必须设置为true，否则ssh到虚拟机创建子进程将失败
rootwrap_command="sudo sahara-rootwrap /etc/sahara/rootwrap.conf"
#api_workers = 0 # sahara-api线程数，可根据实际情况调整，设置为0表示自动根据cpu核数创建线程数
enable_notifications = false # 部署了ceilometer，设置为true
rabbit_hosts=RABBIT_HOST:5672 # 多个mq地址，使用逗号分隔，如果使用haproxy，修改为LB地址。
rabbit_userid=RABBIT_USERNAME # mq用户名
rabbit_password=RABBIT_PASSWORD # mq密码
plugins = vanilla,hdp,spark,cdh,ambari,mapr,storm # 开启的插件infrastructure_engine = direct # 使用heat时设置为heat，没有部署heat使用direct，建议使用heat，direct将在L版本之后废弃
# proxy_command='ip netns exec ns_for_{network_id} nc {host} {port}'
[database]
backend = sqlalchemy
connection=mysql://sahara:SAHARA_DBPASS@MYSQL_HOST/sahara?charset=utf8 # 设置数据库地址
idle_timeout = 3600
min_pool_size = 1
max_pool_size = 10
max_retries = 10
retry_interval = 10
max_overflow = 20
[keystone_authtoken]
auth_url = http://KEYSTONE_HOST:35357 # 设置auth url，注意端口为35357
auth_uri=http://KEYSTONE_HOST:5000 # 设置auth uri，注意端口为5000
identity_uri=http://KEYSTONE_HOST:35357/ # 和auth_url一样
admin_user = sahara # 设置sahara使用的用户名
admin_password = SAHARA_PASS # 设置sahara用户密码
admin_tenant_name = services # 设置sahara用户的租户名
  
[oslo_messaging_rabbit]
amqp_durable_queues=true # 设置为true
kombu_reconnect_delay=1.0
rabbit_hosts=RABBIT_HOST:5672 # 设置rabbit地址，多个地址使用逗号隔开
rabbit_use_ssl=False
rabbit_userid=RABBIT_USERNAME # rabbit用户名
rabbit_password=RABBIT_PASSWORD # rabbit密码
rabbit_virtual_host=/
# rabbit_ha_queues=false
heartbeat_timeout_threshold=0
heartbeat_rate=2
```

#### 2.1.5 初始化数据库

完成以上配置后，初始化sahara数据库表:

```bash
sahara-db-manage --config-file /etc/sahara/sahara.conf upgrade head
```

#### 2.1.6 启动服务

启动sahara-api服务：

```bash
systemctl enable openstack-sahara-api
systemctl start  openstack-sahara-api
```

### 2.2 engine节点

我们使用了网络namespace方式，因此`sahara-engine`需要通过管理ip访问虚拟机进行配置管理，因此sahara-engine必须安装在网络节点上，通过ssh ProxyCommand以及namespace访问虚拟机，其他访问方式参考https://specs.openstack.org/openstack/sahara-specs/specs/kilo/indirect-vm-access.html。如果使用floating ip访问虚拟机，则不是必须部署到网络节点上。

#### 2.2.1 安装sahara engine

```bash
yum install -y openstack-sahara-engine-3.0.0-5.cc218ddgit.el7.noarch
```

#### 2.2.2 sahara engine配置

配置文件和api节点一样，直接拷贝过来即可。

注意某些发行版可能安装sahara服务并不会自动生成rootwrap脚本，需要手动添加：

```
if [ ! -f /etc/sudoers.d/sahara ]; then
cat  > /etc/sudoers.d/sahara << EOF
Defaults:sahara !requiretty
  
sahara ALL = (root) NOPASSWD: /usr/bin/sahara-rootwrap /etc/sahara/rootwrap.conf *
EOF
fi
```

#### 2.2.3 启动服务

启动sahara-engine服务：

```bash
systemctl enable openstack-sahara-engine
systemctl start  openstack-sahara-engine
```


## 3.Sahara高可用

Sahara主要由sahara-api和sahara-engine服务组成，因此sahara服务的高可用，主要是保证这两个服务无单点故障。

### 3.1 Sahara API服务高可用

sahara-api服务和其他Openstack API服务类似，属于典型的无状态服务，因此可以通过负载均衡服务实现高可用，当部分服务出现故障时，负载均衡服务能够自动屏蔽故障，不仅如此，还能分摊负载，提高吞吐量。

haproxy配置参考如下:

```cfg
listen sahara-api
  bind 0.0.0.0:8386
  option httpchk
  option httplog
  option httpclose
  timeout server 600s
  server sahara-api SAHARA_API_NODE-1:8386 check inter 10s fastinter 2s downinter 3s rise 3 fall 2
  server sahara-api SAHARA_API_NODE-2:8386 check inter 10s fastinter 2s downinter 3s rise 3 fall 2
  server sahara-api SAHARA_API_NODE-3:8386 check inter 10s fastinter 2s downinter 3s rise 3 fall 2
```

### 3.2 Sahara Engine服务高可用

sahara-engine属于典型的无状态RPC服务，和nova-scheduler类似，所有服务连接到消息队列服务，并通过RPC接口对外提供服务。AMQP协议的特点使得相关的服务实现高可用非常简单，因为AMQP协议自带负载均衡的功能。同一个主题的消息队列，如果有多个消费者，那么AMQP服务器就会按照轮训的方式将消息分发给各个消费者。因此，RPC服务只需要启动多个实例，监听相同的主题就可以实现高可用，不需要LB，sahara-engine服务会自动通过消息队列协调服务。

但是官方称虽然sahara-engine支持冗余实例，即分布式模式，但并不是真正的高可用，这是由于sahara任务都是分stage的，比如创建一个Hadoop集群，包括集群验证、创建虚拟机、分配ip、创建volume、配置虚拟机、启动hadoop服务等，这些所有stage必须由一个engine全过程负责，不允许任何中断，当负责创建任务的engine挂掉时，其他engine不能接管当前任务，即使重启原来的engine，也会丢失原来的stage，目前也没有很好的回滚策略，整个hadoop集群将永久堵塞在中间状态。如果是创建集群还好，删掉瘫痪的集群重新创建一个新的即可。关键是如果在扩容操作时，engine突然挂掉，则整个集群将处于半扩容状态，可能导致整个Hadoop集群实例不可用，目前社区版本尚不支持扩容回滚。


## 4. Sahara使用文档

## 4.1 上传镜像

镜像可以自己手动制作，也可以下载官方推荐的镜像，地址：http://sahara-files.mirantis.com/images/upstream/

以M版本的sahara-mitaka-spark-1.6.0-ubuntu为例:

下载镜像到本地:

```bash
axel -n 20 http://sahara-files.mirantis.com/images/upstream/mitaka/sahara-mitaka-spark-1.6.0-ubuntu.qcow2
axel -n 20 http://sahara-files.mirantis.com/images/upstream/mitaka/sahara-mitaka-spark-1.6.0-ubuntu.qcow2.md5
md5sum -c sahara-mitaka-spark-1.6.0-ubuntu.qcow2.md5
```

上传镜像到glance:

```bash
glance image-create --file sahara-mitaka-spark-1.6.0-ubuntu.qcow2 \
	--disk-format qcow2 \
	--container-format bare \
	----visibility public \
	--progress \
	--name sahara-mitaka-spark-1.6.0-ubuntu
```

上传镜像后，还需要手动注册镜像，指定插件版本和用户名，插件版本号和用户名参考:http://docs.openstack.org/developer/sahara/userdoc/vanilla_plugin.html，通常镜像的用户名为：


|     OS     | UserName |
|------------|----------|
|Ubuntu 14.04|  ubuntu  |
| Fedora 20  |  fedora  |
| CentOS 6.6 |cloud-user|
|  CenOS 7   |  cento   |

进入Dashboard->Data Processing->Image Registry面板，点击Register Image按钮，选择插件类型及版本，如图：

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/0.png)

输入镜像用户名和插件标签，插件标签一定要有Haddop发行版和版本号，如图：

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/1.png)

镜像注册后，会在镜像中增加相应的property值，如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/10.png)

### 4.2 创建Node Group Templates

Node Group节点的角色，每个角色可以配置不同的资源以及启动不同的服务，比如我们可以定义master角色，该角色分配8个vCPU和16GB内存，启动namenode、spark master服务。而Slave角色分配16vCPU以及32GB内存，并挂载Cinder Volume ssd硬盘，启动datanode和Spark Worker进程等。

Node Group Template就是定义角色的模板，该模板包括:

* Flavor
* Availability Zone
* Cinder Volume Size & Volume Type
* Floating IP Pool，指定使用的浮动IP池
* Node Group Processes，比如namenode，datanode，spark-master,spark-slave,hue等
* Security Group，可以自定义安全组，也可以选择由插件自动创建
* Hadoop配置参数，比如hdfs_client_java_heapsize,hadoop_job_history_dir等。

以Spark 1.6.0为例，创建spark-master节点模板,首先需要指定插件名称和版本，如图:


![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/2.png)

选择Flavor、Availability Zone等，如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/3.png)

master节点需要开启namenode和spark-master服务，如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/4.png)

安全组和配置参数默认即可。

以此类似，创建Spark-worker节点，最后Node Group模板如下：

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/5.png)

### 4.3 创建Cluster Template

Cluster Template，即集群模板，用来定义集群的拓扑，决定集群规模大小，包含几个Master几点，几个node节点，这些服务如何分布等。注意集群模板必须保证是合法的，非法的集群模板将导致最后创建集群实例失败，比如namenode进程实例大于1，或者没有配置datanode等，都是非法的集群拓扑。

创建集群模板和创建Node group模板类似，首先需要选择插件名称和版本，设定模板名称，最后该集群包含的各个角色的规模，我们的Spark 1.6只需要一个Master节点和3个Worker节点，定义如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/6.png)

### 4.4 创建集群

有了集群模板后就可以创建集群实例了，在Cluster面板中选择Launch Cluster，设定插件名称和版本后，配置集群实例名称，Base镜像以及使用的密钥和网络等，如图：

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/7.png)

创建实例成功后，可以点击集群名称，点击Cluster Event Tab，能够查看进度以及各个阶段的时间开销，如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/8.png)

数分钟后，集群即可创建完成，集群状态为Active，如图:

![sahara交互图](/img/posts/Openstack大数据Sahara项目实践/9.png)

此时只需要通过密钥ssh登录到Master节点即可运行Spark Shell或者提交Spark Job。当然用户也可以直接在dashboard上创建JoB，然后提交Job到指定的集群实例中。

## 5. Sahara已知问题

### 5.1 sahara engine访问虚拟机方式

目前sahara engine访问虚拟机的方式都存在不可规避的问题：

* flat private network
	* 安全隐患
	* 不支持neutron网络
* floating IPs
	* 所有的虚拟机必须分配公有IP
	* 公有IP资源是有限的
	* datanode暴露在外网，存在数据安全隐患
* net_ns

* sahara-engine必须配置在网络节点上
* 不支持HA模式（分布式模式),sahara-engine访问虚拟机时是通过集群所在网络的router namespace访问的，ssh proxy_command：

```bash
ip netns exec ns_for_{network_id} nc {host} {port}
```
但是目前sahara-engine尚不支持自动发现router所在的网络节点位置。比如sahara网络节点的router在64节点，但sahara-engine起在65节点，显然sahara-engine访问不了虚拟机。

* tenant-specific proxy node (https://review.openstack.org/#/c/131142/)
	* 配置为整个系统的代理，不支持针对某个集群实例设置代理。
	* 代理节点必须手动创建和配置。

	
社区未来可能引入agent模式，这个和trove的agent类似，需要在虚拟机内部安装agent程序，agent通过外部消息队列通信方式进行配置管理，当然采取这种方式同样存在几个问题：

* 相当于直接暴露了Openstack的消息队列给内部虚拟机，存在严重的安全隐患。
* agent需要单独维护，升级特别麻烦。

其实如果构建自己的私有云，可以创建一个独立的浮动IP子网，然后打通外部节点网络。但如果是公有云，这个方法存在巨大的安全隐患，一旦虚拟机被攻击，将直接侵入到物理机中。

### 5.2 集群配置

集群实例不支持动态更新配置，一旦集群创建完成，不能再修改node group配置，当然如果使用CDH插件的情况下，可以通过Cloudera Manager实现配置管理。

### 5.3 Hadoop版本

Sahara Hadoop版本和社区版本存在较大的版本差，比如目前Spark 2.0 preview已经发布，但Sahara官方L版目前支持最新版本为1.3.1，落后了几个发行版，即使最新的M版本和N版本也只能支持最新到Spark 1.6.1。目前没有很好的方案解决Hadoop版本过低的问题，可以尝试的方案为：

* 自己制作镜像http://docs.openstack.org/developer/sahara/userdoc/plugins.html，并实现该版本的plugin，这种方式开发量较大。
* 使用高版本Openstack Sahara镜像并backport代码，这种方式开发量较少，但不保证所有的发行版能用。
* 更新镜像，把版本过低的组件替换掉，比如CDH的Spark只有1.3.1，我们可以手动下载1.6的版本替换掉老版本，前提新版本的组件必须和老版本组件配置兼容。

## 6. Sahara下一版本新性

### 6.1 动态插件管理

目前最新版本sahara还不支持动态管理插件，只能在配置文件中静态配置，作用于整个Openstack环境，不能针对某个租户进行管理。在N版本将支持动态配置管理功能，BP地址https://blueprints.launchpad.net/sahara/+spec/plugin-management-api。


### 6.2 支持新版本Hadoop插件

目前Sahara官方支持的hadoop版本和hadoop实际版本存在较大的差距，预期到N版本CDH将更新到5.7，另外在Vanilla中将集成Spark，而原生的Spark将支持1.6.0版本。
