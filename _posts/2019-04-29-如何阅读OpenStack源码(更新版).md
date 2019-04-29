---
layout: post
title: 如何阅读OpenStack源码(更新版)
catalog: true
tags: [OpenStack]
---

## 1 OpenStack介绍

OpenStack是一个开源的IaaS实现方案，企业构建私有云的主流选择之一。截至到2019年4月，OpenStack已经有9年的发展历史了，最新发布的版本为第19个版本，代号为Stein，下一个版本[Train](https://releases.openstack.org/train/index.html)目前已经处于开发阶段，预计今年10月发布。

最初OpenStack只有两个子项目，分别为Nova和Swift，其中Nova不仅提供计算服务，还包含了网络服务、块存储服务、镜像服务以及裸机管理服务。

之后随着项目的不断发展，从Nova中根据功能拆分为多个独立的项目，如nova-volume拆分为Cinder项目提供块存储服务，nova-image拆分为Glance项目，提供镜像存储服务，nova-network则是neutron的前身，裸机管理也从Nova中分离出来为Ironic项目。

最开始容器服务也是由Nova提供支持的，作为Nova的Hypervisor driver实现，而后容器部分功能迁移到Heat，容器部署在虚拟机中。现在容器管理功能已经独立为一个单独的项目Magnum，提供容器编排服务，容器服务则由Zun项目负责。

目前OpenStack几个核心基础组件如下:

* Keystone：认证服务。
* Glance：镜像服务。
* Nova：计算服务。
* Cinder：块存储服务。
* Neutorn：网络服务。
* Swift：对象存储服务。

E版之后，在这些核心服务之上，OpenStack社区又不断出现新的服务，如面板服务Horizon、编排服务Heat、数据库服务Trove、文件共享服务Manila、大数据服务Sahara、工作流服务Mistral以及前面提到的容器编排服务Magnum等，这些服务几乎都依赖于以上基础服务。比如Sahara大数据服务会调用Heat模板服务创建基础资源，Heat会调用Nova创建虚拟机，调用Glance获取镜像，调用Cinder创建数据卷，调用Neutron创建网络等。

OpenStack项目越来越多，功能越来越全面，同时服务也越来越复杂，覆盖的技术生态越来越庞大，初次接触OpenStack感觉面临一个庞然大物，总会有种如"盲人摸象"的感觉。

不过不必先过于绝望，好在OpenStack项目具有非常良好的设计理念，虽然OpenStack项目众多，组件繁杂，但几乎所有的服务骨架脉络基本是一样的，熟悉了其中一个项目的架构，深入阅读了其中一个项目源码，再去学其他OpenStack项目自然会轻松很多。

本文接下来以Nova项目为例，一步一步剖析源码结构，阅读完之后，你再去看Cinder项目，发现会有一种轻车熟路的感觉。

## 2 工欲善其事必先利其器

要阅读源代码首先需要安装科学的代码阅读工具，图形界面使用pycharm没有问题，不过通常在虚拟机或者测试服务器是没有图形界面的，因此首推vim，需要简单的配置使其支持代码跳转和代码搜索，可以参考我的dotfiles：[GitHub - int32bit/dotfiles: A set of vim, zsh, git, and tmux configuration files.](https://github.com/int32bit/dotfiles)。如图：

![vim demo](/img/posts/如何阅读OpenStack源码/vim.png)

## 3 OpenStack开发与测试基础

### 3.1 OpenStack项目源码入口导航

OpenStack所有项目都是基于Python语言开发，遵循Python标准Distutils，使用setuptools工具管理项目。

想知道一个项目有哪些服务组成，入口函数（main函数）在哪里，最直接的方式就是查看项目根目录下的`setup.cfg`文件，其中`console_scripts`就是所有服务组件的入口，它就像一个十字路口导航，告诉你目的地的入口在哪里，哪条路通向哪里。

比如Nova的`setup.cfg`的`console_scripts`如下:

```ini
[entry_points]
...
console_scripts =
    console_scripts =
    nova-api = nova.cmd.api:main
    nova-api-metadata = nova.cmd.api_metadata:main
    nova-compute = nova.cmd.compute:main
    nova-conductor = nova.cmd.conductor:main
    nova-placement-api = nova.api.openstack.placement.wsgi:init_application
    ...
```

数了下目前最新的Nova大概有22个`main`函数入口，由此可知Nova项目安装后会包含22个可执行程序，其中`nova-compute`服务的入口函数为`nova/cmd/compute.py`(`.` -> `/`)模块的`main`函数:

```python
def main():
    config.parse_args(sys.argv)
    logging.setup(CONF, 'nova')
    priv_context.init(root_helper=shlex.split(utils.get_root_helper()))
    objects.register_all()
    gmr_opts.set_defaults(CONF)
    # Ensure os-vif objects are registered and plugins loaded
    os_vif.initialize()

    gmr.TextGuruMeditation.setup_autorun(version, conf=CONF)

    cmd_common.block_db_access('nova-compute')
    objects_base.NovaObject.indirection_api = conductor_rpcapi.ConductorAPI()
    objects.Service.enable_min_version_cache()
    server = service.Service.create(binary='nova-compute',
                                    topic=compute_rpcapi.RPC_TOPIC)
    service.serve(server)
    service.wait()
    service.wait()
```

其它服务依次类推。

## 3.2 OpenStack开发测试环境准备

由于OpenStack使用Python语言开发，而Python是动态类型语言，参数类型只能在运行时确定，不容易从代码中看出，因此必须部署一个allinone的OpenStack开发测试环境，建议使用RDO部署：[Packstack quickstart](https://www.rdoproject.org/install/quickstart/)，当然乐于折腾使用DevStack、Kolla也是没有问题的。

## 3.3 OpenStack代码调试

要想深入研究源码，最有效的方式就是一步一步跟踪代码执行，因此会使用debugger工具是关键技能之一。Python的debugger工具有很多，为了简便起见，pdb工具就够了。

使用方法也非常简单，只要在你想设置断点的地方，嵌入以下代码：

```python
import pdb; pdb.set_trace()
```

然后在命令行（不能通过systemd执行）直接运行服务即可。比如想跟踪Nova创建虚拟机的过程，只需要在`nova/api/openstack/compute/servers.py`模块的`create`方法打上断点，如下：

```python
def create(self, req, body):
    """Creates a new server for a given user."""
    import pdb; pdb.set_trace()
    context = req.environ['nova.context']
    server_dict = body['server']
    password = self._get_server_admin_password(server_dict)
    name = common.normalize_name(server_dict['name'])
    description = name
    ...
```

然后注意需要通过命令行直接在终端运行`nova-api`服务，而不能通过systemd在后台启动:

```
su -c 'nova-api' nova
```

此时在另一个终端创建一个新的虚拟机，调用创建虚拟机API，nova-api进程就会马上弹出pdb shell，此时你可以通过`s`或者`n`命令一步一步执行了。更多关于OpenStack调试技巧可参考我的另一篇文章[《OpenStack断点调试方法总结》](http://int32bit.me/2019/04/25/OpenStack%E6%96%AD%E7%82%B9%E8%B0%83%E8%AF%95%E6%96%B9%E6%B3%95/)。

## 4 OpenStack项目代码框架

阅读源码的首要问题就是就要对代码的结构了然于胸，**需要强调的是，OpenStack项目的目录结构并不是根据组件严格划分，而是根据功能划分**，以Nova为例，`nova/compute`目录并不是一定在nova-compute节点上运行，而主要是和compute相关(虚拟机操作相关）的功能实现，同样的，scheduler目录代码并不全在scheduler服务节点运行，但主要是和调度相关的代码。不过目录结构遵循一定的规律。

通常一个OpenStack项目的代码目录都会包含`api.py`、`rpcapi.py`、`manager.py`，这三个是最重要的模块。

* `api.py`： 通常是供其它组件调用的封装库。换句话说，该模块通常并不会由本模块调用。比如compute目录的api.py，通常由nova-api服务的controller调用。可以简单认为是供其他服务调用的sdk。
* `rpcapi.py`：这个是RPC请求的封装，或者说是RPC封装的client端，该模块封装了RPC请求调用。
* `manager.py`： 这个才是真正服务的功能实现，也是RPC的server端，即处理RPC请求的入口，实现的方法通常和rpcapi实现的方法一一对应。

比如对一个虚拟机执行关机操作：

```
API节点
nova-api接收用户请求 -> nova-api调用compute/api.py -> compute/api调用compute/rpcapi.py -> rpcapi.py向目标计算节点发起stop_instance()RPC请求

计算节点
收到stop_instance()请求 -> 调用compute/manager.py的callback方法stop_instance() -> 调用libvirt关机虚拟机

```

前面提到OpenStack项目的目录结构是按照功能划分的，而不是服务组件，因此并不是所有的目录都能有对应的组件。仍以Nova为例:

* `nova/cmd`：这是服务的启动脚本，即所有服务的main函数。看服务怎么初始化，就从这里开始。
* `nova/db`: 封装数据库访问，目前支持的driver为sqlalchemy。
* `nova/conf`：Nova所有配置项声明都放在这个目录。
* `nova/locale`: 本地化处理。
* `nova/image`: 封装Glance接口。
* `nova/network`: 封装Neutron接口。
* `nova/volume`: 封装Cinder接口。
* `nova/virt`: 这是支持的所有虚拟化驱动实现，即compute driver实现，主流的如`libvirt`、`hyperv`、`ironic`、`vmwareapi`等。
* `nova/objects`: 对象模型，封装了所有Nova对象的CURD操作，相对以前直接调用db的model更安全，并且支持版本控制。
* `nova/policies`： API policy集合。
* `nova/tests`: 测试代码，如单元测试、功能测试。
* `nova/hacking`: Nova代码规范定义的一些规则。

以上同样适用于其它服务，比如Cinder等。

另外需要了解的是，所有的API入口都是从xxx-api开始的，RESTFul API是OpenStack服务的唯一入口，也就是说，阅读源码就从api开始。

而api组件也是根据实体划分的，不同的实体对应不同的controller，比如servers、flavors、keypairs等，`controller`的`index`方法对应`list`操作、`show`方法对应`get`操作、`create`对应创建操作、`delete`对应删除操作、`update`对应更新操作等。

根据进程阅读源码并不是什么好的实践，因为光理解服务如何初始化、如何通信、如何发送心跳等就很不容易，各种高级封装太复杂了。我认为比较好的阅读源码方式是追踪一个任务的执行过程，比如跟踪启动虚拟机的整个流程，因此接下来本文将以创建一台虚拟机为例，一步步分析其过程。

## 5 实践案例：Nova创建虚拟机过程分析

这里以创建虚拟机过程为例，根据前面的理论基础，一步步跟踪其执行过程。需要注意的是，Nova支持同时创建多台虚拟机，因此在调度时需要同时选择调度多个宿主机。

### 5.1 nova-api

根据前面的理论，创建虚拟机的入口为`nova/api/openstack/compute/servers.py`的`create`方法，该方法检查了一堆参数以及policy后，调用`compute_api`的`create()`方法。

```python
def create(self, req, body):
    """Creates a new server for a given user."""
    # ... 省略部分代码
    try:
        inst_type = flavors.get_flavor_by_flavor_id(
                flavor_id, ctxt=context, read_deleted="no")

        supports_multiattach = common.supports_multiattach_volume(req)
        supports_port_resource_request = \
            common.supports_port_resource_request(req)
        (instances, resv_id) = self.compute_api.create(context,
            inst_type,
            image_uuid,
            display_name=name,
            display_description=description,
            availability_zone=availability_zone,
            forced_host=host, forced_node=node,
            metadata=server_dict.get('metadata', {}),
            admin_password=password,
            check_server_group_quota=True,
            supports_multiattach=supports_multiattach,
            supports_port_resource_request=supports_port_resource_request,
                **create_kwargs)
    except (exception.QuotaError,
            exception.PortLimitExceeded) as error:
            # ...
```

这里的`compute_api`即前面说的`nova/compute/api.py`模块，找到该模块的`create`方法，该方法会创建数据库记录、检查参数等，然后调用`compute_task_api`的`schedule_and_build_instances`方法:

```python
@hooks.add_hook("create_instance")
def create(...):
    """Provision instances, sending instance information to the
    scheduler.  The scheduler will determine where the instance(s)
    go and will handle creating the DB entries.

    Returns a tuple of (instances, reservation_id)
    """
    # ...
    self.compute_task_api.schedule_and_build_instances(
        context,
        build_requests=build_requests,
        request_spec=request_specs,
        image=boot_meta,
        admin_password=admin_password,
        injected_files=injected_files,
        requested_networks=requested_networks,
        block_device_mapping=block_device_mapping,
        tags=tags)
```

`compute_task_api`即conductor的`api.py`。conductor的api并没有执行什么操作，直接调用了`conductor_compute_rpcapi`的`schedule_and_build_instances`方法:

```python
def schedule_and_build_instances(self, context, build_requests,
                                 request_spec, image,
                                 admin_password, injected_files,
                                 requested_networks, block_device_mapping,
                                 tags=None):
    self.conductor_compute_rpcapi.schedule_and_build_instances(
        context, build_requests, request_spec, image,
        admin_password, injected_files, requested_networks,
        block_device_mapping, tags)
```

该方法即conductor RPC调用api，即`nova/conductor/rpcapi.py`模块，该方法除了一堆的版本检查，剩下的就是对RPC调用的封装，代码只有两行:

```python
def schedule_and_build_instances(...):
    cctxt = self.client.prepare(version=version)
    cctxt.cast(context, 'schedule_and_build_instances', **kw)
```

其中`cast`表示异步调用，`schedule_and_build_instances`是RPC调用的方法，`kw`是传递的参数。参数是字典类型，没有复杂对象结构，因此不需要特别的序列化操作。

截至到现在，虽然目录由`api->compute->conductor`，但仍在nova-api进程中运行，直到cast方法执行，该方法由于是异步调用，会立即返回，不会等待RPC返回，因此nova-api任务完成，此时会响应用户请求，虚拟机状态为`building`。

### 5.2 nova-conductor

由于是向nova-conductor发起的RPC调用，而前面说了接收端肯定是`manager.py`，因此进程跳到`nova-conductor`服务，入口为`nova/conductor/manager.py`的`schedule_and_build_instances`方法。

该方法首先调用了`_schedule_instances`方法，该方法首先调用了`scheduler_client`的`select_destinations`方法:

```python
def schedule_and_build_instances(...):
    # Add all the UUIDs for the instances
    instance_uuids = [spec.instance_uuid for spec in request_specs]
    try:
        host_lists = self._schedule_instances(context, request_specs[0],
                instance_uuids, return_alternates=True)
    except Exception as exc:
        ...
        
def _schedule_instances(self, context, request_spec,
                        instance_uuids=None, return_alternates=False):
    scheduler_utils.setup_instance_group(context, request_spec)
    with timeutils.StopWatch() as timer:
        host_lists = self.query_client.select_destinations(
            context, request_spec, instance_uuids, return_objects=True,
            return_alternates=return_alternates)
    LOG.debug('Took %0.2f seconds to select destinations for %s '
              'instance(s).', timer.elapsed(), len(instance_uuids))
    return host_lists
```

`scheduler_client`和`compute_api`以及`compute_task_api`都是一样对服务的client封装调用，不过scheduler没有`api.py`模块，而是有个单独的client目录，实现在`nova/scheduler/client`目录的`query.py`模块，`select_destinations`方法又很直接的调用了`scheduler_rpcapi`的`select_destinations`方法，终于又到了RPC调用环节。

```python
def select_destinations(...):
    return self.scheduler_rpcapi.select_destinations(context, ...)
```

毫无疑问，RPC封装同样是在`nova/scheduler`的`rpcapi.py`中实现。该方法RPC调用代码如下:

```python
def select_destinations(self, ...):
    # Modify the parameters if an older version is requested
    # ...
    cctxt = self.client.prepare(
        version=version,
        call_monitor_timeout=CONF.rpc_response_timeout,
        timeout=CONF.long_rpc_timeout)
    return cctxt.call(ctxt, 'select_destinations', **msg_args)
```

注意这里调用的是`call`方法，说明这是同步RPC调用，此时`nova-conductor`并不会退出，而是等待直到`nova-scheduler`返回。因此当前nova-conductor为堵塞状态，等待`nova-scheduler`返回，此时`nova-scheduler`接管任务。

### 5.3 nova-scheduler

同理找到scheduler的manager.py模块的`select_destinations`方法，该方法会调用driver方法:

```python
@messaging.expected_exceptions(exception.NoValidHost)
def select_destinations(self, ctxt, ...):
    # ...
    selections = self.driver.select_destinations(ctxt, spec_obj,...)
    return selections

```

这里的`driver`其实就是调度驱动，在配置文件中`scheduler`配置组指定，默认为`filter_scheduler`，对应`nova/scheduler/filter_scheduler.py`模块，该算法根据指定的filters过滤掉不满足条件的计算节点，然后通过`weigh`方法计算权值，最后选择权值高的作为候选计算节点返回。调度算法实现这里不展开，感兴趣的可以阅读。

最后nova-scheduler返回调度的`hosts`集合，任务结束。由于nova-conductor通过同步方法调用的该方法，因此nova-scheduler会把结果返回给nova-conductor服务。

### 5.4 nova-condutor

nova-conductor等待nova-scheduler返回后，拿到调度的计算节点列表，回到`scheduler/manager.py`的`schedule_and_build_instances`方法。

因为可能同时启动多个虚拟机，因此循环调用了`compute_rpcapi`的`build_and_run_instance`方法：

```python
for (build_request, request_spec, host_list, instance) in zipped:
    # ...
    with obj_target_cell(instance, cell) as cctxt:
        # ...
        with obj_target_cell(instance, cell) as cctxt:
            self.compute_rpcapi.build_and_run_instance(
                    cctxt, ..., host_list=host_list)
```

看到xxxrpc立即想到对应的代码位置，位于`nova/compute/rpcapi`模块，该方法向nova-compute发起RPC请求:

```python
def build_and_run_instance(self, ctxt, ...):
    # ...
    client = self.router.client(ctxt)
    version = '5.0'
    cctxt = client.prepare(server=host, version=version)
    cctxt.cast(ctxt, 'build_and_run_instance', **kwargs)
```

由于是`cast`调用，因此发起的是异步RPC，因此nova-conductor任务结束，紧接着终于轮到nova-compute服务登场了。

### 5.5 nova-compute

终于等到nova-compute服务，服务入口为`nova/compute/manager.py`，找到`build_and_run_instance`方法，该方法调用关系如下：

```
build_and_run_instance()
  -> _locked_do_build_and_run_instance()
  -> _do_build_and_run_instance()
  -> _build_and_run_instance()
  -> driver.spawn()
```

这里的`driver`就是compute driver，通过`compute`配置组的`compute_driver`指定，这里为`libvirt.LibvirtDriver`，代码位于`nova/virt/libvirt/driver.py`，找到`spawn()`方法，该方法调用Libvirt创建虚拟机，并等待虚拟机状态为`Active`,nova-compute服务结束,整个创建虚拟机流程也到此结束。

## 6 总结

以上是创建虚拟机的各个服务的交互过程以及调用关系，需要注意的是，所有的数据库操作，比如`instance.save（）`以及`update`操作，如果配置`use_local`为`false`，则会向`nova-conductor`发起RPC调用，由`nova-conductor`代理完成数据库更新，而不是由`nova-compute`直接访问数据库，这里的RPC调用过程在以上的分析中省略了。

如果你对OpenStack的其它服务以及操作流程感兴趣，可以参考我的[openstack-workflow](https://github.com/int32bit/openstack-workflow)项目。
