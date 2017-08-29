---
layout: post
title: 使用OpenStack Sahara快速部署Cloudera Hadoop集群
catalog: true
tags: [Hadoop, OpenStack] 
---

## 1.Cloudera 简介

Cloudera（英语：Cloudera, Inc.）是一家位于美国的软件公司，向企业客户提供基于Apache Hadoop的软件、支持、服务以及培训。对应OpenStack，类似Mirantis公司。

Cloudera的开源Apache Hadoop发行版，亦即（Cloudera Distribution including Apache Hadoop，CDH），面向Hadoop企业级部署。Cloudera称，其一半以上的工程产出捐赠给了各个基于Apache许可与Hadoop紧密相连的开源项目（Apache Hive、Apache Avro、Apache HBase等等）。Cloudera还是Apache软件基金会的赞助商。
Cloudera 提供一个可扩展、灵活、集成的平台，可用来方便地管理您的企业中快速增长的多种多样的数据。业界领先的 Cloudera 产品和解决方案使您能够部署并管理 Apache Hadoop 和相关项目、操作和分析您的数据以及保护数据的安全。
Cloudera 提供下列产品和工具：

* CDH — Cloudera 分发的 Apache Hadoop 和其他相关开放源代码项目，包括 Impala 和 Cloudera Search。CDH 还提供安全保护以及与许多硬件和软件解决方案的集成。
* Cloudera Manager — 一个复杂的应用程序，用于部署、管理、监控 CDH 并诊断问题。Cloudera Manager 提供 Admin Console，这是一种基于 Web 的用户界面，使您的企业数据管理简单而直接。它还包括 Cloudera Manager API，可用来获取群集运行状况信息和度量以及配置 Cloudera Manager。
* Cloudera Navigator — CDH 平台的端到端数据管理工具。Cloudera Navigator 使管理员、数据经理和分析师能够了解 Hadoop 中的大量数据。Cloudera Navigator 中强大的审核、数据管理、沿袭管理和生命周期管理使企业能够遵守严格的法规遵从性和法规要求。
* Cloudera Impala — 一种大规模并行处理 SQL 引擎，用于交互式分析和商业智能。其高度优化的体系结构使它非常适合用于具有联接、聚合和子查询的传统 BI 样式的查询。它可以查询来自各种源的 Hadoop 数据文件，包括由 MapReduce 作业生成的数据文件或加载到 Hive 表中的数据文件。YARN 和 Llama 资源管理组件让 Impala 能够共存于使用 Impala SQL 查询并发运行批处理工作负载的群集上。您可以通过 Cloudera Manager 用户界面管理 Impala 及其他 Hadoop 组件，并通过 Sentry 授权框架保护其数据。


## 2. Sahara CDH插件

Sahara支持多种Hadoop发行版插件和部署工具，其中对Cloudera-manager支持度相对比较好（但仍存在很多坑），并且目前已经支持绝大多数Hadoop生态圈的服务组件部署，如Spark、Hive、impara、Flume，N版本之后还将支持Kafka集群的部署。

CDH插件提供的功能完善，但也相对比较复杂。它的原理是首先利用Heat准备资源，比如虚拟机、volume卷、网络等。然后通过ssh协议对Cloudera-manager进行服务配置、服务启动和状态检查等。最后将通过调用Cloudera-manager RESTFul API进行Hadoop集群的部署和监控。正是由于Sahara-engine是通过Cloudera-manager RESTFul API进行交互的，因此部署Cloudera-Manager的节点必须能够和Sahara-engine节点通信以及访问外网，CDH插件不支持ProxyCommand模式，因此要求Cloudera集群的虚拟机能够自动绑定公有IP，公有IP还必须能够访问互联网。

目前L版（UOS3.0）支持的最新CDH版本为5.4，M版目前已经支持CDH 5.5，预计到N版本后将支持最新的CDH 5.6版本。

使用Sahara CDH插件部署Cloudera集群，务必保证sahara以下配置:

```
use_floating_ips= True
use_neutron = true
use_namespaces = true
plugins = vanilla,hdp,spark,cdh,ambari,fake,mapr,storm # 必须包含cdh
```

在部署cloudera集群除了以上配置，还需要准备如下工作：

* 上传并注册CDH 5.4版本镜像，参考使用Sahara创建Spark集群图文教程。
* Flavor配置，用于定义node group资源配置。
* Keypair，用于登录Cloudera节点，目前不支持注入密码功能。
* 管理网络(Fixed IP)以及路由，路由需要连接公有网，网络还可能需要设置DNS服务地址。
* Floating IP池，即公有IP，创建node group时必须指定浮动IP池。
* 满足最小资源要求：虚拟机：4 vCPU & 8GB RAM x 1，2 vCPU & 4GB RAM x 3， volume卷: 50GB x 4，Quota建议设置为无限（包括nova、cinder、neutron quota)。


## 3. 创建Cloudera集群

### 3.1 创建node group模板

为了简单起见，我们只定义两种角色，分别为master和slave，master部署管理相关的服务，比如cloudera-manager、namenode、ResourceManager等，而slave节点部署其它服务，比如datanode、nodemanager等。实际部署时，可以根据需求自定义node group，比如Cloudera-manager单独占一个节点或者部署单独的zookeeper集群等。另外，由于部署Hadoop实际上是通过Cloudera-manager API完成的，因此我们在最开始设置hadoop服务时，可以尽量选择少的服务，比如一开始我们可以先不部署Hbase，等Cloudera-manager部署成功后，再通过cldoudera-manager Web UI部署，这样能够减少遇到大坑的风险。

因此我们定义cdh-master node group 模板，运行的进程包括:

```
CLOUDERA_MANAGER
YARN_JOBHISTORY
OOZIE_SERVER
YARN_RESOURCEMANAGER
HDFS_SECONDARYNAMENODE
HDFS_NAMENODE
```

定义cdh-slavev node group 模板，运行的进程包括：

```
HDFS_DATANODE
YARN_NODEMANAGER
```

关于资源配置，master节点要求至少需要8GB RAM，否则后面cloudera-manager起不来，所有的slave节点配置一个volume，至少50GB，设置太小后面Cloudera-manager老是报警。

创建node group模板，建议直接使用dashborad，比较直观，创建流程，以cdh-master为例：

（1） 选择插件类型

![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/1.png)

如图，以上设置Plugin Name为Cloudera Plugin,Version为5.4.0。

（2） 资源配置

![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/2.png)
如图，我们选择了自己flavor，并且指定volume为50GB，注意务必设置Floating IP Pool。

（3）服务配置

勾上以下服务：

```
CLOUDERA_MANAGER
YARN_JOBHISTORY
OOZIE_SERVER
YARN_RESOURCEMANAGER
HDFS_SECONDARYNAMENODE
HDFS_NAMENODE
```

（4）Hadoop配置

可以根据需求进行自定义Hadoop的一些参数配置，通常默认即可。
根据相同的步骤，创建cdh-slave node group模板，服务配置包括：

```
HDFS_DATANODE
YARN_NODEMANAGER
```

另外需要注意`dfs_datanode_du_reserved`参数，这个参数表示预留给宿主机的磁盘空间，默认为10GB，即如果volume设置大小为50GB，在HDFS看到的应该是40GB。
创建完成后，结果如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/3.png)

### 3.2 创建集群模板

以上我们创建了两个node group模板，分别为cdh-master和cdh-slave，本次测试我们部署包含4个节点的Cloudera集群，包括1个master节点和3个slave节点，由以上可知，master节点部署了大多数的管理服务，而slave节点部署了datanode和nodemanager服务。

```
cdh-master x 1
cdh-slave x 3
```

在集群模板面板点击创建按钮，选择对应的插件名称和版本后，选择node group如下：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/4.png)
在`General Parameters`标签，如果没有部署Swift的话，去掉`Enable Swift`，因为如果开启会从互联网下载Swfit 库，比较耗时间。NTP服务地址建议也填上，XFS不需要。

### 3.3 启动集群

创建完集群模板，从模板启动集群，需要设置使用的镜像、网络、keypair等，如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/5.png)
此时在集群列表中可查看所有的集群实例，点击对应的集群名称，可以查看详情：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/6.png)
在Cluster Events中可查看创建集群的进度，如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/7.png)
大约需要数分钟即可创建完成，创建成功后集群的status为Active。

## 4. 使用Cloudera-manager管理集群

集群创建成功后，在Cluster Details面板的General Info中会有Cloudera-Manager的WebUI地址、用户名以及密码：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/8.png)
 进入Cloudera Manager Web UI，输入用户名`admin`以及密码`9e9c470c-5beb-4370-8361-0165b62286b9`登录，进入界面如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/9.png)
使用Cloudera Manager可以查看服务配置、资源监控等，具体请参考官方文档http://www.cloudera.com/。

## 5. 增加Hbase服务

以上我们仅仅部署了HDFS和YARN服务，以下我们将尝试使用Cloudera-Manager增加Hbase服务。由于Hbase服务需要Zookeeper服务，因此我们首先需要部署Zookeeper服务。

### 5.1 部署Zookeeper服务

添加服务的API地址为`"/cmf/clusters/1/add-service/index"`，其中`1`表示集群标号，比如Cloudera-Manager WebUI地址为10.0.103.127:7180，则添加服务的地址为:`http://10.0.103.127:7180/cmf/clusters/1/add-service/index`。
选择Zookeeper服务然后选择继续：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/10.png)
为了简便，我们只部署单节点Zookeeper服务，并且部署节点为master节点，实际部署时应该根据需求调整：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/11.png)
配置完毕后会进入服务部署界面：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/12.png)
若本地没有对应服务的parcels会自动从互联网下载到本地。
部署成功后，如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/13.png)

### 5.2 部署Hbase

和部署Zookeeper类似，进入服务列表后，选择Hbase服务，master节点部署Hbase Master，其他节点部署Hbase RegionServer，如图：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/14.png)
大约需要数分钟，Hbase部署完成。

### 5.3 重启集群

部署了新的服务或者更新了配置都需要重启集群才能生效，否则会警告：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/15.png)
点击重启集群：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/16.png)
重启集群可能需要几分钟，需要耐心等待。最后集群状态如图所示：
![](/img/posts/使用OpenStack Sahara快速部署Cloudera Hadoop集群/17.png)
可见我们成功地部署了Hbase和Zookeeper服务。若需要部署其它服务，与此类似。

## 6. 关于Hadoop版本问题

CDH版本直接绑定了Hadoop的服务的版本，包括HDFS版本、Hbase版本以及Spark版本等，而Sahara版本绑定了CDH版本，因此升级其中一个服务的版本相对比较服务，可以尝试手动升级，即进入虚拟机，下载新的服务版本替换原来的服务即可。
