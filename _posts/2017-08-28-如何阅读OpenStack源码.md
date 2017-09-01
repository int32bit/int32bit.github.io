---
layout: post
title: 如何阅读OpenStack源码
catalog: true
tags: [OpenStack]
---

## 1 OpenStack基础

### 1.1 OpenStack组件介绍

OpenStack是一个IaaS层的云计算平台开源实现，其对标产品为AWS。最开始OpenStack只有两个组件，分别为提供计算服务的Nova以及提供对象存储服务的Swift，其中Nova不仅提供计算服务，还包含了网络服务、块存储服务、镜像服务以及裸机管理服务。之后随着项目的不断发展，从Nova中根据功能拆分为多个独立的项目，如nova-volume拆分为Cinder项目提供块存储服务，nova-image拆分为Glance项目，提供镜像存储服务，nova-network则是neutron的前身，裸机管理也从Nova中分离出来为Ironic项目。最开始容器服务也是由Nova提供支持的，作为Nova的driver之一来实现，而后迁移到Heat，到现在已经独立为一个单独的项目Magnum，后来Magnum的愿景调整为主要提供容器编排服务，单纯的容器服务则由Zun项目接管。最开始OpenStack并没有认证功能，从E版开始才加入认证服务Keystone。

目前OpenStack基础服务组件如下:

* Keystone：认证服务。
* Glance：镜像服务。
* Nova：计算服务。
* Cinder：块存储服务。
* Neutorn：网络服务。
* Swift：对象存储服务。

E版之后，在这些核心服务之上，又不断涌现新的服务，如面板服务Horizon、编排服务Heat、数据库服务Trove、文件共享服务Manila、大数据服务Sahara、工作流服务Mistral以及前面提到的容器编排服务Magnum等，这些服务几乎都依赖于以上的基础服务。比如Sahara大数据服务会先调用Heat模板服务，Heat又会调用Nova创建虚拟机，调用Glance获取镜像，调用Cinder创建数据卷，调用Neutron创建网络等。

截至现在（2016年11月27日），OpenStack已经走过了6年半的岁月，最新发布的版本为第14个版本，代号为Newton，Ocata版已经处在快速开发中。

OpenStack服务越来越多、越来越复杂，覆盖的技术生态越来越庞大，宛如一个庞然大物，刚接触如此庞大的分布式系统，都或多或少感觉有点如"盲人摸象"的感觉。不过不必先过于绝望，好在OpenStack项目具有非常良好的设计，虽然OpenStack项目众多，组件繁杂，但几乎所有的服务骨架脉络基本是一样的，熟悉了其中一个项目的架构，深入读了其中一个项目源码，再去看其它项目可谓轻车熟路。

本文档会以Nova项目为例，一步一步剖析源码结构，阅读完之后，你再去看Cinder项目，发现非常轻松。

### 1.2 工欲善其事必先利其器

要阅读源代码首先需要安装科学的代码阅读工具，图形界面使用pycharm没有问题，不过通常在虚拟机中是没有图形界面的，首选vim，需要简单的配置使其支持代码跳转和代码搜索，可以参考[GitHub - int32bit/dotfiles: A set of vim, zsh, git, and tmux configuration files.](https://github.com/int32bit/dotfiles)。如图：

![vim demo](/img/posts/如何阅读OpenStack源码/vim.png)

OpenStack所有项目都是基于Python开发，都是标准的Python项目，通过setuptools工具管理项目，负责Python包的安装和分发。想知道一个项目有哪些服务组成，入口函数（main函数）在哪里，最直接的方式就是查看项目根目录下的`setup.cfg`文件，其中`console_scripts`就是所有服务组件的入口，比如nova的`setup.cfg`的`console_scripts`如下:

```
[entry_points]
...
console_scripts =
    nova-all = nova.cmd.all:main
    nova-api = nova.cmd.api:main
    nova-api-metadata = nova.cmd.api_metadata:main
    nova-api-os-compute = nova.cmd.api_os_compute:main
    nova-cells = nova.cmd.cells:main
    nova-cert = nova.cmd.cert:main
    nova-compute = nova.cmd.compute:main
    nova-conductor = nova.cmd.conductor:main
    nova-console = nova.cmd.console:main
    nova-consoleauth = nova.cmd.consoleauth:main
    nova-dhcpbridge = nova.cmd.dhcpbridge:main
    nova-idmapshift = nova.cmd.idmapshift:main
    nova-manage = nova.cmd.manage:main
    nova-network = nova.cmd.network:main
    nova-novncproxy = nova.cmd.novncproxy:main
    nova-rootwrap = oslo_rootwrap.cmd:main
    nova-rootwrap-daemon = oslo_rootwrap.cmd:daemon
    nova-scheduler = nova.cmd.scheduler:main
    nova-serialproxy = nova.cmd.serialproxy:main
    nova-spicehtml5proxy = nova.cmd.spicehtml5proxy:main
    nova-xvpvncproxy = nova.cmd.xvpvncproxy:main
...
```

由此可知nova项目安装后会包含21个可执行程序，其中nova-compute服务的入口函数为`nova/cmd/compute.py`(. -> /)模块的`main`函数:

```python
def main():
    config.parse_args(sys.argv)
    logging.setup(CONF, 'nova')
    utils.monkey_patch()
    objects.register_all()

    gmr.TextGuruMeditation.setup_autorun(version)

    if not CONF.conductor.use_local:
        block_db_access()
        objects_base.NovaObject.indirection_api = \
            conductor_rpcapi.ConductorAPI()
    else:
        LOG.warning(_LW('Conductor local mode is deprecated and will '
                        'be removed in a subsequent release'))

    server = service.Service.create(binary='nova-compute',
                                    topic=CONF.compute_topic,
                                    db_allowed=CONF.conductor.use_local)
    service.serve(server)
    service.wait()
```

其它服务依次类推。

由于OpenStack使用Python语言开发，而Python是动态类型语言，参数类型不容易从代码中看出，因此必须部署一个allinone的OpenStack开发测试环境，建议使用RDO部署：[Packstack quickstart](https://www.rdoproject.org/install/quickstart/)，当然乐于折腾使用DevStack也是没有问题的。

要想深入研究源码，最有效的方式就是一步一步跟踪代码执行，因此会使用debug工具是关键技能之一。Python的debug工具有很多，为了简便起见，pdb工具就够了。使用方法也非常简单，只要在你想设置断点的地方，嵌入以下代码：

```
import pdb; pdb.set_trace()
```

然后在命令行（不能通过systemd执行）直接运行服务即可。假如想跟踪nova创建虚拟机的过程，首先在`nova/api/openstack/compute/servers.py`模块的`create`方法打上断点，如下：

```python
def create(self, req, body):
    """Creates a new server for a given user."""

    import pdb; pdb.set_trace() # 设置断点
    context = req.environ['nova.context']
    server_dict = body['server']
    password = self._get_server_admin_password(server_dict)
    name = common.normalize_name(server_dict['name'])

    if api_version_request.is_supported(req, min_version='2.19'):
        if 'description' in server_dict:
            # This is allowed to be None
            description = server_dict['description']
        else:
            # No default description
            description = None
    else:
        description = name
    ...
```

然后注意需要通过命令行直接运行，而不能通过systemd启动:

```
su -c 'nova-api' nova
```

此时调用创建虚拟机API，nova-api进程就会马上弹出pdb shell，此时你可以通过`s`或者`n`命令一步一步执行了。

### 1.3 OpenStack项目通用骨骼脉络

阅读源码的首要问题就是就要对代码的结构了然于胸，**需要强调的是，OpenStack项目的目录结构并不是根据组件严格划分，而是根据功能划分**，以Nova为例，compute目录并不是一定在nova-compute节点上运行，而主要是和compute相关(虚拟机操作相关）的功能实现，同样的，scheduler目录代码并不全在scheduler服务节点运行，但主要是和调度相关的代码。不过目录结构并不是完全没有规律，它遵循一定的套路。

通常一个服务的目录都会包含`api.py`、`rpcapi.py`、`manager.py`，这个三个是最重要的模块。

* `api.py`： 通常是供其它组件调用的封装库。换句话说，该模块通常并不会由本模块调用。比如compute目录的api.py，通常由nova-api服务的controller调用。
* rpcapi.py：这个是RPC请求的封装，或者说是RPC封装的client端，该模块封装了RPC请求调用。
* manager.py： 这个才是真正服务的功能实现，也是RPC的服务端，即处理RPC请求的入口，实现的方法通常和rpcapi实现的方法一一对应。

比如对一个虚拟机执行关机操作：

```
API节点
nova-api接收用户请求 -> nova-api调用compute/api.py -> compute/api调用compute/rpcapi.py -> rpcapi.py向目标计算节点发起stop_instance()RPC请求

计算节点
收到stop_instance()请求 -> 调用compute/manager.py的callback方法stop_instance() -> 调用libvirt关机虚拟机

```

前面提到OpenStack项目的目录结构是按照功能划分的，而不是服务组件，因此并不是所有的目录都能有对应的组件。仍以Nova为例:

* cmd：这是服务的启动脚本，即所有服务的main函数。看服务怎么初始化，就从这里开始。
* db: 封装数据库访问，目前支持的driver为sqlalchemy。
* conf：Nova的配置项声明都在这里。
* locale: 本地化处理。
* image: 封装Glance调用接口。
* network: 封装网络服务接口，根据配置不同，可能调用nova-network或者neutron。
* volume: 封装数据卷访问接口，通常是Cinder的client封装。
* virt: 这是所有支持的hypervisor驱动，主流的如libvirt、xen等。
* objects: 对象模型，封装了所有实体对象的CURD操作，相对以前直接调用db的model更安全，并且支持版本控制。
* policies： policy校验实现。
* tests: 单元测试和功能测试代码。

以上同样适用于其它服务，比如Cinder等。

另外需要了解的是，所有的API入口都是从xxx-api开始的，RESTFul API是OpenStack服务的唯一入口，也就是说，阅读源码就从api开始。而api组件也是根据实体划分的，不同的实体对应不同的controller，比如servers、flavors、keypairs等，controller的index方法对应list操作、show方法对应get操作、create创建、delete删除、update更新等。

根据进程阅读源码并不是什么好的实践，因为光理解服务如何初始化、如何通信、如何发送心跳等就不容易，各种高级封装太复杂了。我认为比较好的阅读源码方式是追踪一个任务的执行过程，比如看启动虚拟机的整个流程，因此接下来本文将以创建一台虚拟机为例，一步步分析其过程。

## 2 创建虚拟机过程分析

这里以创建虚拟机过程为例，根据前面的总体套路，一步步跟踪其执行过程。需要注意的是，Nova支持同时创建多台虚拟机，因此在调度时需要选择多个宿主机。

### S1 nova-api

入口为nova/api/openstack/compute/servers.py的create方法，该方法检查了一堆参数以及policy后，调用`compute_api`的create方法。

```python
def create(self, req, body):
    """Creates a new server for a given user."""

    context = req.environ['nova.context']
    server_dict = body['server']
    password = self._get_server_admin_password(server_dict)
    name = common.normalize_name(server_dict['name'])

    ...

    flavor_id = self._flavor_id_from_req_data(body)
    try:
        inst_type = flavors.get_flavor_by_flavor_id(
                flavor_id, ctxt=context, read_deleted="no")

        (instances, resv_id) = self.compute_api.create(context,
                        inst_type,
                        image_uuid,
                        display_name=name,
                        display_description=description,
                        availability_zone=availability_zone,
                        forced_host=host, forced_node=node,
                        metadata=server_dict.get('metadata', {}),
                        admin_password=password,
                        requested_networks=requested_networks,
                        check_server_group_quota=True,
                        **create_kwargs)
    except (exception.QuotaError,
            exception.PortLimitExceeded) as error:
        raise exc.HTTPForbidden(
            explanation=error.format_message())
```

这里的`compute_api`即前面说的`nova/compute/api.py`模块，找到该模块的create方法，该方法会创建数据库记录、检查参数等，然后调用`compute_task_api`的`build_instances`方法:

```python
self.compute_task_api.schedule_and_build_instances(
    context,
    build_requests=build_requests,
    request_spec=request_specs,
    image=boot_meta,
    admin_password=admin_password,
    injected_files=injected_files,
    requested_networks=requested_networks,
    block_device_mapping=block_device_mapping)
```

`compute_task_api`即conductor的api.py。conductor的api并没有执行什么操作，直接调用了`conductor_compute_rpcapi`的`build_instances`方法:

```python
def schedule_and_build_instances(self, context, build_requests,
                                 request_spec, image,
                                 admin_password, injected_files,
                                 requested_networks, block_device_mapping):
    self.conductor_compute_rpcapi.schedule_and_build_instances(
        context, build_requests, request_spec, image,
        admin_password, injected_files, requested_networks,
        block_device_mapping)
```

该方法即时conductor RPC调用api，即`nova/conductor/rpcapi.py`模块，该方法除了一堆的版本检查，剩下的就是对RPC调用的封装，代码只有两行:

```
cctxt = self.client.prepare(version=version)
cctxt.cast(context, 'build_instances', **kw)
```

其中cast表示异步调用，`build_instances`是远程调用的方法，`kw`是传递的参数。参数是字典类型，没有复杂对象结构，因此不需要特别的序列化操作。

截至到现在，虽然目录由`api->compute->conductor`，但仍在nova-api进程中运行，直到cast方法执行，该方法由于是异步调用，因此nova-api任务完成，此时会响应用户请求，虚拟机状态为`building`。

### S2 nova-conductor

由于是向nova-conductor发起的RPC调用，而前面说了接收端肯定是`manager.py`，因此进程跳到`nova-conductor`服务，入口为`nova/conductor/manager.py`的`build_instances`方法，该方法首先调用了`_schedule_instances`方法，该方法调用了`scheduler_client`的`select_destinations`方法:

```python
def _schedule_instances(self, context, request_spec, filter_properties):
    scheduler_utils.setup_instance_group(context, request_spec,
                                         filter_properties)
    # TODO(sbauza): Hydrate here the object until we modify the
    # scheduler.utils methods to directly use the RequestSpec object
    spec_obj = objects.RequestSpec.from_primitives(
        context, request_spec, filter_properties)
    hosts = self.scheduler_client.select_destinations(context, spec_obj)
    return hosts
```

`scheduler_client`和`compute_api`以及`compute_task_api`都是一样对服务的client调用，不过scheduler没有`api.py`，而是有个单独的client目录，实现在client目录的`__init__.py`，这里仅仅是调用query.py下的SchedulerQueryClient的`select_destinations`实现，然后又很直接的调用了`scheduler_rpcapi`的`select_destinations`方法，终于又到了RPC调用环节。

```python
def select_destinations(self, context, spec_obj):
    """Returns destinations(s) best suited for this request_spec and
    filter_properties.

    The result should be a list of dicts with 'host', 'nodename' and
    'limits' as keys.
    """
    return self.scheduler_rpcapi.select_destinations(context, spec_obj)
```

毫无疑问，RPC封装同样是在scheduler的rpcapi中实现。该方法RPC调用代码如下:

```
return cctxt.call(ctxt, 'select_destinations', **msg_args)
```

注意这里调用的call方法，即同步RPC调用，此时nova-conductor并不会退出，而是堵塞等待直到nova-scheduler返回。因此当前状态为nova-conductor为blocked状态，等待nova-scheduler返回，nova-scheduler接管任务。

### S3 nova-scheduler

同理找到scheduler的manager.py模块的`select_destinations`方法，该方法会调用driver方法，这里的driver其实就是调度算法实现，通常用的比较多的就是`filter_scheduler`的，对应`filter_scheduler.py`模块，该模块首先通过`host_manager`拿到所有的计算节点信息，然后通过filters过滤掉不满足条件的计算节点，剩下的节点通过weigh方法计算权值，最后选择权值高的作为候选计算节点返回。最后nova-scheduler返回调度结果的hosts集合，任务结束，返回到nova-conductor服务。

### S4 nova-condutor

回到`scheduler/manager.py`的`build_instances`方法，nova-conductor等待nova-scheduler返回后，拿到调度的计算节点列表。因为可能同时启动多个虚拟机，因此循环调用了`compute_rpcapi`的`build_and_run_instance`方法。

```python
for (instance, host) in six.moves.zip(instances, hosts):
    instance.availability_zone = (
        availability_zones.get_host_availability_zone(context,
                                                      host['host']))
    try:
        # NOTE(danms): This saves the az change above, refreshes our
        # instance, and tells us if it has been deleted underneath us
        instance.save()
    except (exception.InstanceNotFound,
            exception.InstanceInfoCacheNotFound):
        LOG.debug('Instance deleted during build', instance=instance)
        continue
    ...
    self.compute_rpcapi.build_and_run_instance(context,
            instance=instance, host=host['host'], image=image,
            request_spec=request_spec,
            filter_properties=local_filter_props,
            admin_password=admin_password,
            injected_files=injected_files,
            requested_networks=requested_networks,
            security_groups=security_groups,
            block_device_mapping=bdms, node=host['nodename'],
            limits=host['limits'])
```

看到xxxrpc立即想到对应的代码位置，位于`compute/rpcapi`模块，该方法向nova-compute发起RPC请求:

```
cctxt.cast(ctxt, 'build_and_run_instance', ...)
```

由于是cast调用，因此发起的是异步RPC，因此nova-conductor任务结束，紧接着终于轮到nova-compute登场了。

### S5 nova-compute

到了nova-compute服务，入口为compute/manager.py，找到`build_and_run_instance`方法，该方法调用了driver的spawn方法，这里的driver就是各种hypervisor的实现，所有实现的driver都在virt目录下，入口为`driver.py`，比如libvirt driver实现对应为`virt/libvirt/driver.py`，找到spawn方法，该方法拉取镜像创建根磁盘、生成xml文件、define domain，启动domain等。最后虚拟机完成创建。nova-compute服务结束。

## 3 一张图总结

以上是创建虚拟机的各个服务的交互过程以及调用关系，需要注意的是，所有的数据库操作，比如`instance.save（）`以及`update`操作，如果配置`use_local`为`false`，则会向`nova-conductor`发起RPC调用，由`nova-conductor`代理完成数据库更新，而不是由`nova-compute`直接访问数据库，这里的RPC调用过程在以上的分析中省略了。

整个流程用一张图表示为:

![create](/img/posts/如何阅读OpenStack源码/create.png)

如果你对OpenStack的其它服务以及操作流程感兴趣，可以参考我的[openstack-workflow](https://github.com/int32bit/openstack-workflow)项目, 这个项目是我本人在学习过程中记录，绘制成序列图，上图就是其中一个实例。项目地址为: https://github.com/int32bit/openstack-workflow，目前完成了Nova的大多数操作。
