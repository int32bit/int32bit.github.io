---
layout: post
title: OpenStack容器服务Zun初探与原理分析
catalog: true
tags: [OpenStack, Docker, Kuryr]
---

## 1 Zun服务简介

Zun是OpenStack的容器服务（Containers as Service），类似于AWS的ECS服务，但实现原理不太一样，ECS是把容器启动在EC2虚拟机实例上，而Zun会把容器直接运行在compute节点上。

和OpenStack另一个容器相关的Magnum项目不一样的是：Magnum提供的是容器编排服务，能够提供弹性Kubernetes、Swarm、Mesos等容器基础设施服务，管理的单元是Kubernetes、Swarm、Mesos集群，而Zun提供的是原生容器服务，支持不同的runtime如Docker、Clear Container等，管理的单元是container。

Zun服务的架构如图：

![OpenStack zun image](/img/posts/OpenStack容器服务Zun初探与原理分析/OpenStack-zun-image.jpg)

Zun服务和Nova服务的功能和结构非常相似，只是前者提供容器服务，后者提供虚拟机服务，二者都是主流的计算服务交付模式。功能类似体现在如下几点：

* 通过Neutron提供网络服务。
* 通过Cinder实现数据的持久化存储。
* 都支持使用Glance存储镜像。
* 其他如quota、安全组等功能。

组件结构结构相似则表现在:

* 二者都是由API、调度、计算三大组件模块构成，Nova由nova-api、nova-scheduler、nova-compute三大核心组件构成，而Zun由zun-api、zun-compute两大核心组件构成，之所以没有zun-scheduler是因为scheduler集成到zun-api中了。
* nova-compute调用compute driver创建虚拟机，如Libvirt。zun-compute调用container driver创建容器，如Docker。
* Nova通过一系列的proxy代理实现VNC（nova-novncproxy)、Splice(nova-spiceproxy)等虚拟终端访问，Zun也是通过proxy代理容器的websocket实现远程attach容器功能。

## 2 Zun服务部署

Zun服务部署和Nova、Cinder部署模式类似，控制节点创建数据库、Keystone创建service以及注册endpoints等，最后安装相关包以及初始化配置。计算节点除了安装zun-compute服务，还需要安装要使用的容器，比如Docker。详细的安装过程可以参考官方文档，如果仅仅是想进行POC测试，可以通过DevStack自动化快速部署一个AllInOne环境，供参考的local.conf配置文件如下:

```ini
[[local|localrc]]
ADMIN_PASSWORD='********'
DATABASE_PASSWORD='********'
RABBIT_PASSWORD='********'
SERVICE_PASSWORD=$ADMIN_PASSWORD
enable_plugin zun https://git.openstack.org/openstack/zun
enable_plugin zun-ui https://git.openstack.org/openstack/zun-ui
enable_plugin devstack-plugin-container https://git.openstack.org/openstack/devstack-plugin-container
LIBS_FROM_GIT="python-zunclient"
KURYR_CAPABILITY_SCOPE=global
KURYR_PROCESS_EXTERNAL_CONNECTIVITY=False
enable_plugin kuryr-libnetwork https://github.com/openstack/kuryr-libnetwork
```

如上配置会自动通过DevStack安装Zun相关组件、Kuryr组件以及Docker。

## 3 Zun服务入门

### 3.1 Dashboard

安装Zun服务之后，可以通过zun命令行以及Dashboard创建和管理容器。

有一个非常赞的功能是如果安装了Zun，Dashboard能够支持Cloud Shell，用户能够在DashBoard中进行交互式输入OpenStack命令行。

![OpenStack Cloud Shell](/img/posts/OpenStack容器服务Zun初探与原理分析/webshell.png)

原理的话就是通过Zun启动了一个`gbraad/openstack-client:alpine`容器。

通过Dashboard创建容器和创建虚拟机的过程非常相似，都是通过panel依次选择镜像(image)、选择规格(Spec)、选择或者创建卷(volume)、选择网络(network/port)、选择安全组(SecuiryGroup)以及scheduler hint，如图：

![Dashboard Create Container](/img/posts/OpenStack容器服务Zun初探与原理分析/dashboard_create_container.png)

其中Miscellaneous杂项中则为针对容器的特殊配置，比如设置环境变量（Environment）、工作目录(Working Directory)等。

### 3.2 命令行操作

通过命令行创建容器也非常类似，使用过nova以及docker命令行的基本不会有困难，下面以创建一个mysql容器为例:

```bash
zun run -n int32bit-mysql-1 --hostname int32bit-mysql-1 \
    --cpu 2 -m 1024 \
    -e MYSQL_ROOT_PASSWORD='mysql1234' \
    --net network=ff981105-c56d-42a9-933e-13ba0695c064 \
    --mount size=10,destination=/var/lib/mysql \
    --security-group Default \
    --restart on-failure:3 \
    mysql:8
```

* 如上通过`--mount`参数指定了volume大小，由于没有指定`volume_id`，因此Zun会新创建一个volume。**需要注意的是，Zun创建的volume在容器删除后，volume也会自动删除(auto remove)**，如果需要持久化volume卷，则应该先通过Cinder创建一个volume，然后通过`source`选项指定`volume_id`，此时当容器删除时不会删除已有的volume卷。
* 和虚拟机不一样，虚拟机通过flavor配置规格，容器则直接指定cpu、memory、disk。
* 如上没有指定`--image-driver`参数，则默认从dockerhub下载镜像，如果指定glance，则会往glance下载镜像。

另外mysql容器初始化时数据卷必须为空目录，挂载的volume新卷格式化时会自动创建`lost+found`目录，因此需要手动删除，否则mysql容器会初始化失败:

```sh
NAME=int32bit-mysql-1
UUID=$(zun list --name "$NAME" | grep "$NAME" | awk -F '|' '{print $2}' | tr -d ' ')
CONTAINER_NAME=zun-${UUID}
HOST_PATH=$(docker inspect \
    --format '{{ range .Mounts }}{{ if eq .Destination "/var/lib/mysql" }}{{ .Source }}{{ end }}{{ end }}' \
    $CONTAINER_NAME)
rm -rf -- $HOST_PATH/lost+found
```

创建完成后可以通过`zun list`命令查看容器列表:

```
root@DevStack:~# zun list
+--------------------------------------+--------------------+----------------+---------+------------+-----------------+---------------+
| uuid                                 | name               | image          | status  | task_state | addresses       | ports         |
+--------------------------------------+--------------------+----------------+---------+------------+-----------------+---------------+
| 546b8613-118d-4e4e-80a2-216616132684 | mysql-server-1     | mysql:8        | Running | None       | 192.168.233.11  | [3306, 33060] |
| 9344f411-d44e-4571-9604-58d49c2ccbef | int32bit-mysql-1   | mysql:8        | Running | None       | 192.168.233.80  | [3306, 33060] |
| f12699a1-bed3-456b-846d-34593b86bf58 | int32bit-busybox-1 | busybox:latest | Running | None       | 192.168.233.152 | []            |
+--------------------------------------+--------------------+----------------+---------+------------+-----------------+---------------+
```

可以看到mysql的容器fixed IP为192.168.233.80，和虚拟机一样，租户IP默认与外面不通，需要绑定一个浮动IP(floating ip)，

```bash
#!/bin/bash
NAME=int32bit-mysql-1
FLOATING_NETWORK=cdf8cd3c-5a46-4fdb-8e8a-c597b1d15244
CONTAINER_UUID=$(zun list --name "$NAME" \
    | grep "$NAME" | awk -F '|' '{print $2}' | tr -d ' ')
PORT_ID=$(neutron port-list -F id -f value -- --device_id=${CONTAINER_UUID})
FLOATING_PORT_ID=$(neutron floatingip-create $FLOATING_NETWORK \
    | awk -F '|' '/\sid\s/{print $3}' | tr -d ' ')
FLOATING_IP=$(neutron floatingip-list \
    -F floating_ip_address -f value -- --id=$FLOATING_PORT_ID)
neutron floatingip-associate $FLOATING_PORT_ID $PORT_ID
echo "Attach floatingip $FLOATING_IP to container '$NAME'"
```

zun命令行目前还无法查看floating ip，只能通过neutron命令查看，获取到floatingip并且安全组入访允许3306端口后就可以远程连接mysql服务了:

![connect mysql using floating ip](/img/posts/OpenStack容器服务Zun初探与原理分析/connect_mysql_using_floating_ip.png)

当然在同一租户的虚拟机也可以直接通过fixed ip访问mysql服务:

![connect mysql using fixed ip](/img/posts/OpenStack容器服务Zun初探与原理分析/connect_mysql_using_fixed_ip.png)

可见，通过容器启动mysql服务和在虚拟机里面部署mysql服务，用户访问上没有什么区别，在同一个环境中，虚拟机和容器可共存，彼此可相互通信，在应用层上可以完全把虚拟机和容器透明化使用，底层通过应用场景选择虚拟机或者容器。

### 3.3 关于capsule

Zun除了管理容器container外，还引入了capsule的概念，capsule类似Kubernetes的pod，一个capsule可包含多个container，这些container共享network、ipc、pid namespace等。

通过capsule启动一个mysql服务，声明yaml文件如下:

```yaml
capsuleVersion: beta
kind: capsule
metadata:
  name: mysql-server
  labels:
    app: mysql
restartPolicy: Always
spec:
  containers:
  - image: mysql:8
    imagePullPolicy: ifnotpresent
    ports:
      - name: mysql-port
        containerPort: 3306
        hostPort: 3306
        protocol: TCP
    resources:
      requests:
        cpu: 1
        memory: 1024
    env:
      MYSQL_ROOT_PASSWORD: "mysql1234"
    volumeMounts:
    - name: mysql_data
      mountPath: /var/lib/mysql
  volumes:
  - name: mysql_data
    cinder:
      size: 5
      autoRemove: True
```

创建mysql capsule:

```
zun capsule-create -f  mysql.yaml
zun capsule-list
+--------------------------------------+--------------+---------+-----------------------------+
| uuid                                 | name         | status  | addresses                   |
+--------------------------------------+--------------+---------+-----------------------------+
| 2621c75b-3ae3-498b-8a5b-6a4f8b6015a2 | template     | Running | 172.24.4.7, 2001:db8::fb    |
| 4fd518ec-c4de-4d15-99d1-a12c4b4d87ef | mysql-server | Running | 172.24.4.252, 2001:db8::1f8 |
+--------------------------------------+--------------+---------+-----------------------------+
docker ps --format 'table {{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}'
CONTAINER ID        IMAGE                     STATUS              NAMES
08a163c21efb        mysql:8                   Up 10 minutes       zun-f09198a4-c1f2-4722-b7d5-0c0568351f11
0aa8b17605fc        kubernetes/pause:latest   Up 11 minutes       zun-4fd518ec-c4de-4d15-99d1-a12c4b4d87ef
```

可见capsule的init container用的就是kubernetes的pause镜像。

### 3.4 总结

OpenStack的容器服务本来是在Nova中实现的，实现了Nova ComputeDriver，因此Zun的其他的功能如容器生命周期管理、image管理、service管理、action管理等和Nova虚拟机非常类似，可以查看官方文档，这里不再赘述。

## 4 Zun实现原理

### 4.1 调用容器接口实现容器生命周期管理

前面提到过Zun主要由zun-api和zun-compute服务组成，zun-api主要负责接收用户请求、参数校验、资源准备等工作，而zun-compute则真正负责容器的管理，Nova的后端通过`compute_driver`配置，而Zun的后端则通过`container_driver`配置，目前只实现了`DockerDriver`。因此调用Zun创建容器，最终就是zun-compute调用docker创建容器。

下面以创建一个container为例，简述其过程。

#### 4.1.1 zun-api

首先入口为zun-api，主要代码实现在`zun/api/controllers/v1/containers.py`以及`zun/compute/api.py`，创建容器的方法入口为`post()`方法，其调用过程如下:

**zun/api/controllers/v1/containers.py**

1. policy enforce: 检查policy，验证用户是否具有创建container权限的API调用。
2. check security group: 检查安全组是否存在，根据传递的名称返回安全组的ID。
3. check container quotas: 检查quota配额。
4. build requested network: 检查网络配置，比如port是否存在、network id是否合法，最后构建内部的network对象模型字典。注意，这一步只检查并没有创建port。
5. create container object：根据传递的参数，构造container对象模型。
6. build requeted volumes: 检查volume配置，如果传递的是volume id，则检查该volume是否存在，如果没有传递volume id只指定了size，则调用Cinder API创建新的volume。

**zun/compute/api.py**

1. schedule container: 使用FilterScheduler调度container，返回宿主机的host对象。这个和nova-scheduler非常类似，只是Zun集成到zun-api中了。目前支持的filters如CPUFilter、RamFilter、LabelFilter、ComputeFilter、RuntimeFilter等。
2. image validation: 检查镜像是否存在，这里会远程调用zun-compute的`image_search`方法，其实就是调用`docker search`。这里主要为了实现快速失败，避免到了compute节点才发现image不合法。
3. record action: 和Nova的record action一样，记录container的操作日志。
4. rpc cast `container_create`: 远程异步调用zun-compute的`container_create()`方法，zun-api任务结束。

#### 4.1.2 zun-compute

zun-compute负责container创建，代码位于`zun/compute/manager.py`，过程如下:

1. wait for volumes avaiable: 等待volume创建完成，状态变为`avaiable`。
2. attach volumes：挂载volumes，挂载过程后面再介绍。
3. check_support_disk_quota: 如果使用本地盘，检查本地的quota配额。
4. pull or load image: 调用Docker拉取或者加载镜像。
5. 创建docker network、创建neutron port，这个步骤下面详细介绍。
6. create container: 调用Docker创建容器。
7. container start: 调用Docker启动容器。

以上调用Dokcer拉取镜像、创建容器、启动容器的代码位于`zun/container/docker/driver.py`，该模块基本就是对社区[Docker SDK for Python](https://docker-py.readthedocs.io/en/stable/)的封装。

![docker python sdk](/img/posts/OpenStack容器服务Zun初探与原理分析/docker_python_sdk.png)

Zun的其他操作比如start、stop、kill等实现原理也类似，这里不再赘述。

### 4.2 通过websocket实现远程容器访问

我们知道虚拟机可以通过VNC远程登录，物理服务器可以通过SOL(IPMI Serial Over LAN)实现远程访问，容器则可以通过websocket接口实现远程交互访问。

Docker原生支持websocket连接，参考API[Attach to a container via a websocket](https://docs.docker.com/engine/api/v1.39/#operation/ContainerAttachWebsocket)，websocket地址为`/containers/{id}/attach/ws`，不过只能在计算节点访问，那如何通过API访问呢？

和Nova、Ironic实现完全一样，也是通过proxy代理转发实现的，负责container的websocket转发的进程为zun-wsproxy。

当调用zun-compute的`container_attach()`方法时，zun-compute会把container的`websocket_url`以及`websocket_token`保存到数据库中

```python
@translate_exception
def container_attach(self, context, container):
    try:
        url = self.driver.get_websocket_url(context, container)
        token = uuidutils.generate_uuid()
        container.websocket_url = url
        container.websocket_token = token
        container.save(context)
        return token
    except Exception as e:
        raise
```

zun-wsproxy则可读取container的`websocket_url`作为目标端进行转发：


```python
def _new_websocket_client(self, container, token, uuid):
    if token != container.websocket_token:
        raise exception.InvalidWebsocketToken(token)

    access_url = '%s?token=%s&uuid=%s' % (CONF.websocket_proxy.base_url,
                                          token, uuid)

    self._verify_origin(access_url)

    if container.websocket_url:
        target_url = container.websocket_url
        escape = "~"
        close_wait = 0.5
        wscls = WebSocketClient(host_url=target_url, escape=escape,
                                close_wait=close_wait)
        wscls.connect()
        self.target = wscls
    else:
        raise exception.InvalidWebsocketUrl()

    # Start proxying
    try:
        self.do_websocket_proxy(self.target.ws)
    except Exception:
        if self.target.ws:
            self.target.ws.close()
            self.vmsg(_("Websocket client or target closed"))
        raise
```

通过Dashboard可以远程访问container的shell:

![attach container](/img/posts/OpenStack容器服务Zun初探与原理分析/attach_container.png)

当然通过命令行`zun attach`也可以attach container。

### 4.3 使用Cinder实现容器持久化存储

前面介绍过Zun通过Cinder实现container的持久化存储，之前我的另一篇文章介绍了[Docker使用OpenStack Cinder持久化volume原理分析及实践](http://int32bit.me/2017/10/04/Docker%E4%BD%BF%E7%94%A8OpenStack-Cinder%E6%8C%81%E4%B9%85%E5%8C%96volume%E5%8E%9F%E7%90%86%E5%88%86%E6%9E%90%E5%8F%8A%E5%AE%9E%E8%B7%B5/)，介绍了john griffith开发的docker-cinder-driver以及OpenStack Fuxi项目，这两个项目都实现了Cinder volume挂载到Docker容器中。另外cinderclient的扩展模块[python-brick-cinderclient-ext](https://specs.openstack.org/openstack/cinder-specs/specs/mitaka/use-cinder-without-nova.html)实现了Cinder volume的local attach，即把Cinder volume挂载到物理机中。

Zun没有复用以上的代码模块，而是重新实现了volume attach的功能，不过实现原理和上面的方法完全一样，主要包含如下过程：

1. connect volume: connect volume就是把volume attach（映射）到container所在的宿主机上，建立连接的的协议通过`initialize_connection`信息获取，如果是LVM类型则一般通过iscsi，如果是Ceph rbd则直接使用`rbd map`。
2. ensure mountpoit tree: 检查挂载点路径是否存在，如果不存在则调用`mkdir`创建目录。
3. make filesystem： 如果是新的volume，挂载时由于没有文件系统因此会失败，此时会创建文件系统。
4. do mount: 一切准备就绪，调用OS的`mount`接口挂载volume到指定的目录点上。

Cinder Driver的代码位于``zun/volume/driver.py`的`Cinder`类中，方法如下:

```python
@validate_volume_provider(supported_providers)
def attach(self, context, volmap):
    cinder = cinder_workflow.CinderWorkflow(context)
    devpath = cinder.attach_volume(volmap)
    try:
        self._mount_device(volmap, devpath)
    except Exception:
        # ...
```

其中`cinder.attach_volume()`实现如上的第1步，而`_mount_device()`实现了如上的2-4步。

### 4.4 集成Neutron网络实现容器网络多租户

#### 4.4.1 关于容器网络

前面我们通过Zun创建容器，使用的就是Neutron网络，意味着容器和虚拟机完全等同的共享Neutron网络服务，虚拟机网络具有的功能，容器也能实现，比如多租户隔离、floating ip、安全组、防火墙等。

Docker如何与Neutron网络集成呢？根据官方[Docker network plugin API](https://docs.docker.com/engine/extend/plugin_api/)介绍，插件位于如下目录:

* /run/docker/plugins
* /etc/docker/plugins
* /usr/lib/docker/plugins

```bash
$ find /usr/lib/docker/plugins /etc/docker/plugins /run/docker/plugins 2>/dev/null
/usr/lib/docker/plugins
/usr/lib/docker/plugins/kuryr
/usr/lib/docker/plugins/kuryr/kuryr.spec
/run/docker/plugins
$ cat /usr/lib/docker/plugins/kuryr/kuryr.spec
http://127.0.0.1:23750
```

由此可见Docker使用的是kuryr网络插件。

Kuryr也是OpenStack中一个较新的项目，其目标是“Bridge between container framework networking and storage models to OpenStack networking and storage abstractions.”,即实现容器与OpenStack的网络与存储集成，当然目前只实现了网络部分的集成。

而我们知道目前容器网络主要有两个主流实现模型：

* CNM： Docker公司提出，Docker原生使用的该方案，通过HTTP请求调用，模型设计可参考[The Container Network Model Design](https://github.com/docker/libnetwork/blob/master/docs/design.md)，network插件可实现两个Driver，其中一个为[IPAM Driver](https://github.com/docker/libnetwork/blob/master/docs/ipam.md)，用于实现IP地址管理，另一个为[Docker Remote Drivers](https://github.com/docker/libnetwork/blob/master/docs/remote.md)，实现网络相关的配置。
* CNI：CoreOS公司提出，Kubernetes选择了该方案，通过本地方法或者命令行调用。

因此Kuryr也分成两个子项目，kuryr-network实现CNM接口，主要为支持原生的Docker，而kury-kubernetes则实现的是CNI接口，主要为支持Kubernetes，Kubernetes service还集成了Neutron LBaaS，下次再单独介绍这个项目。

由于Zun使用的是原生的Docker，因此使用的是kuryr-network项目，实现的是CNM接口，通过remote driver的形式注册到Docker libnetwork中，Docker会自动向插件指定的socket地址发送HTTP请求进行网络操作，我们的环境是http://127.0.0.1:23750，即kuryr-libnetwork.service监听的地址，Remote API接口可以参考[Docker Remote Drivers](https://github.com/docker/libnetwork/blob/master/docs/remote.md)。



#### 4.4.2 kuryr实现原理

前面4.1节介绍到zun-compute会调用docker driver的`create()`方法创建容器，其实这个方法不仅仅是调用python docker sdk的`create_container()`方法，还做了很多工作，其中就包括网络相关的配置。

首先检查Docker的network是否存在，不存在就创建，network name为Neutron network的UUID，

```
$ docker network list
NETWORK ID          NAME                                   DRIVER              SCOPE
8d1f330e14fd        bridge                                 bridge              local
be97b0b067a3        cdf8cd3c-5a46-4fdb-8e8a-c597b1d15244   kuryr               global
9cd4232055d8        ff981105-c56d-42a9-933e-13ba0695c064   kuryr               global
49833d1de236        host                                   host                local
44dfe1c44816        none                                   null                local
```

然后会调用Neutron创建port，从这里可以得出结论，容器的port不是Docker libnetwork也不是Kuryr创建的，而是Zun创建的。

回到前面的Remote Driver，Docker libnetwork会首先POST调用kuryr的`/IpamDriver.RequestAddress`API请求分配IP，但显然前面Zun已经创建好了port，port已经分配好了IP，因此这个方法其实就是走走过场。如果直接调用docker命令指定kuryr网络创建容器，则会调用该方法从Neutron中创建一个port。

接下来会POST调用kuryr的`/NetworkDriver.CreateEndpoint`方法，这个方法最重要的步骤就是binding，即把port attach到宿主机中，binding操作单独分离出来为`kuryr.lib`库，这里我们使用的是veth driver，因此由`kuryr/lib/binding/drivers/veth.py`模块的`port_bind()`方法实现，该方法创建一个veth对，其中一个为`tap-xxxx`，xxxx为port ID前缀，放在宿主机的namespace，另一个为`t_cxxxx`放到容器的namespace，`t_cxxxx`会配置上IP，而`tap-xxxx`则调用shell脚本(脚本位于`/usr/local/libexec/kuryr/`）把tap设备添加到ovs br-int桥上，如果使用`HYBRID_PLUG`，即安全组通过Linux Bridge实现而不是OVS，则会创建qbr-xxx，并创建一个veth对关联到ovs br-int上。

从这里可以看出，Neutron port绑定到虚拟机和容器基本没有什么区别，如下所示:

```
    vm               Container        whatever
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

唯一不同的就是虚拟机是把tap设备直接映射到虚拟机的虚拟设备中，而容器则通过veth对，把另一个tap放到容器的namespace中。

有人会说，br-int的流表在哪里更新了？这其实是和虚拟机是完全一样的，当调用port update操作时，neutron server会发送RPC到L2 agent中（如neutron-openvswitch-agent），agent会根据port的状态更新对应的tap设备以及流表。

因此其实kuryr只干了一件事，那就是把Zun申请的port绑定到容器中。


## 5 总结

OpenStack Zun项目非常完美地实现了容器与Neutron、Cinder的集成，加上Ironic裸机服务，OpenStack实现了容器、虚拟机、裸机共享网络与存储。未来我觉得很长一段时间内裸机、虚拟机和容器将在数据中心混合存在，OpenStack实现了容器和虚拟机、裸机的完全平等、资源共享以及功能对齐，应用可以根据自己的需求选择容器、虚拟机或者裸机，使用上没有什么区别，用户只需要关心业务针对性能的需求以及对硬件的特殊访问，对负载（workload）是完全透明的。

## 参考文献

1. docker python sdk: https://docker-py.readthedocs.io/en/stable/
2. Zun’s documentation: https://docs.openstack.org/zun/latest/
3. attach to a container via websocket: https://docs.docker.com/engine/api/v1.39/#operation/ContainerAttachWebsocket
4. http://int32bit.me/2017/10/04/Docker使用OpenStack-Cinder持久化volume原理分析及实践/
5. https://specs.openstack.org/openstack/cinder-specs/specs/mitaka/use-cinder-without-nova.html
6. https://docs.docker.com/engine/extend/plugin_api/
7. https://github.com/docker/libnetwork/blob/master/docs/design.md
8. https://github.com/docker/libnetwork/blob/master/docs/ipam.md
9. https://github.com/docker/libnetwork/blob/master/docs/remote.md
10. https://docs.openstack.org/kuryr-libnetwork/latest/
11. https://docs.openstack.org/magnum/latest/user/
12. https://github.com/docker/libnetwork
13. https://www.nuagenetworks.net/blog/container-networking-standards/
14. http://blog.kubernetes.io/2016/01/why-Kubernetes-doesnt-use-libnetwork.html
