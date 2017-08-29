---
layout: post
title: 聊聊Nova Compute Driver的那些趣事
catalog: true
tags: [OpenStack]
---

## OpenStack设计准则

OpenStack是一个开源云计算平台项目，旨在为公共及私有云的建设与管理提供软件的开源实现。可扩展性和弹性是OpenStack设计的准则之一，即OpenStack的各个组件以及组件内部的模块都应该是可插拔的，并且可以随意的增加插件而不需要修改已有的接口。Driver机制就是其中的一个很好的例子，Nova通过不同的driver支持不同的hypervisor，Cinder通过不同的driver支持不同的存储后端，Neutron通过各种agent支持不同的网络类型，Sahara通过各种plugin支持不同的Hadoop发行版等等，在OpenStack几乎处处存在这样的影子。所有的driver都是可配置的，通过配置不同的driver，各个组件就能注册不同的驱动，从而支持不同的资源类型。

## 何谓Compute Driver

说到Nova，相信大家都会想到它的功能就是管虚拟机的，甚至无意识地和Libvirt、QEMU、KVM等概念自动关联起来。我基本每次面试都会问及Nova的实现原理，大多数面试者都能回答说：Nova的原理嘛，就是调用Libvirt的API管理QEMU/KVM虚拟机。是的，我们部署OpenStack时大都会使用libvirt driver，以至于很多人都误以为**Nova只是Libvirt的封装，Nova只能管理虚拟机**。可事实上，Nova的功能远非如此，我特别需要强调的是：

* Libvirt只是众多compute driver的其中一种。
* Nova可管的不仅仅是虚拟机。

要理解以上两点，我们首先需要理解Compute Driver究竟是什么？驱动的概念相信大家都明白，我们买了一个新的相机或者U盘需要接入笔记本，完成的第一件事就是要安装驱动。许多驱动是通用的，比如U盘，插入USB接口后就能用，这是因为内核内置了该类型存储设备的驱动程序。有些设备的驱动不是通用的，通常这种情况下，你购买设备时会顺便配备一个小光盘，里面放的就是驱动程序，需要安装到你的电脑上才能使用该设备。因此，这里的驱动可以认为是设备与操作系统的交互接口，或者说代理。虽然硬件设备多种多样，但操作系统定义的接口通常是固定的，比如open()、read()、write()、ioctl()、close()等，驱动程序只要实现了这些接口，就能被操作系统识别、管理。同理，Nova相当于操作系统，而各种形形色色的hypervisor相当于各种设备，而Compute Driver就相当于驱动程序。Compute Driver定义了将近120个接口，所有接口都在`nova/virt/driver.py`上定义和描述，如:

* spawn: 创建一个实例。
* destroy: 删除一个实例。
* start: 对应虚拟机，就是开机操作。
* stop： 对应虚拟机，就是关机操作。
* reboot: 对应虚拟机，就是重启操作。
* ...

这些接口通常是固定不变的，也是所有具体实现必须遵循的规范，其描述了所有接口的作用、参数、返回类型等信息，比如spawn接口:

```python
    def spawn(self, context, instance, image_meta, injected_files,
              admin_password, network_info=None, block_device_info=None):
        """Create a new instance/VM/domain on the virtualization platform.

        Once this successfully completes, the instance should be
        running (power_state.RUNNING).

        If this fails, any partial instance should be completely
        cleaned up, and the virtualization platform should be in the state
        that it was before this call began.

        :param context: security context
        :param instance: nova.objects.instance.Instance
                         This function should use the data there to guide
                         the creation of the new instance.
        :param nova.objects.ImageMeta image_meta:
            The metadata of the image of the instance.
        :param injected_files: User files to inject into instance.
        :param admin_password: Administrator password to set in instance.
        :param network_info: instance network information
        :param block_device_info: Information about block devices to be
                                  attached to the instance.
        """
        ...

```

注意：定义的接口并不要求全部实现，根据具体的后端实现，可以只实现其中的一部分接口，其它未实现的接口只需要简单地抛出NotImplementedError异常即可。

`LibvirtDriver`是其中的一个实现，它位于`nova/virt/libvirt/driver.py`，其中`spawn()`方法相当于调用了libvirt的`define()`和`start()`方法。destroy()则相当于调用了libvirt的`destroy()`方法和`undefine`方法，其它方法也都能找到对应的调用关系。

理解了什么是Compute Driver，在回过头来思考之前的两个问题: 

**Libvirt只是众多compute driver的其中一种。**相信只要深入了解过Nova并阅读过Nova源码，不会有什么疑问，当前最新版本的Nova项目中原生支持的Compute Driver包括:

* libvirt
* hyperv
* xenapi
* vmwareapi
* ironic

**Nova可管的不仅仅是虚拟机。**这很有趣，甚至难以置信，但这却是事实。Nova管理的除了虚拟机之外的东西，有些可能只是一种尝试，有些早已成为了历史，也有些独立门户。带着好奇心，不妨好好盘点下Nova除了能管虚拟机，还能管理哪些有趣的玩意。

## OpenStack

有人看到这，开始质疑这里标题是不是错了，明明是谈Nova能管什么，怎么突然岔开话题谈OpenStack，Nova不是OpenStack其中一个组件么？难道Nova管理Nova？不管你信不信，这是真的。其实原理很简单，把Compute Driver的所有实现替换为对另一个Nova API调用即可。比如spawn()方法，转化为对另一个Nova API的`"POST /servers"`请求。我们把这种模式称作级联OpenStack。

这有什么用呢？我们知道，OpenStack目前越来越成熟稳定，但一直没能很好的支持大规模的扩展，当规模大到一定程度时，数据库、消息队列等都会成为性能瓶颈，限制了单一OpenStack规模的增长。社区为此也思考了一些方案，分Region、分Cell以及前面提到的级联OpenStack都是社区的一些尝试，这些尝试都是可行的，但又有其各自的问题。Region和Cell会在后续的文章中重点介绍，这里仅仅介绍下级联OpenStack，官方文档参考[OpenStack cascading solution](https://wiki.openstack.org/wiki/OpenStack_cascading_solution)。其原理如图:

![cascading openstack](/img/posts/聊聊Nova-compute-driver的那些趣事/cascading.png)

其实不仅Nova如此，其它所有组件都可以使用类似方法实现级联从而实现大规模扩展:

![cascading openstack 2](/img/posts/聊聊Nova-compute-driver的那些趣事/cascading2.png)

理论上，这种方法可以无限扩展OpenStack的节点，没有规模限制。事实上，部署和实现上还是存在不少挑战问题的，比如如何同步各个child集群的信息以及网络通信等。

目前社区已经把这一部分实现逻辑单独拿出来，并新开了两个相关项目[Tricircle]((https://wiki.openstack.org/wiki/Tricircle)以及[Trio2o](https://wiki.openstack.org/wiki/Trio2o)，二者基本都是由华为在主导，一个负责网络管理，另一个负责实现级联。目前这两个项目还不是特别成熟，但还是提供了一种支持大规模OpenStack集群的参考。

## Docker

Docker这几年非常火热，甚至有人说Docker会代替虚拟机，K8S会代替OpenStack，虽然这种描述过于夸张，也欠缺合理性，但这却足以证明Docker的热度。

![docker](/img/posts/聊聊Nova-compute-driver的那些趣事/docker.png)

也因此社区很早就开始尝试集成Docker。在K版本OpenStack中，Nova已经支持了Docker驱动，能够通过Nova来启动Docker容器。实现原理其实也不难，`spawn()`方法相当于调用Docker的`run`接口(其实是调用的`create()`和`start()`API)，而`destory()`方法则调用Docker的`rm`接口。其它接口与之类似。Nova的Docker驱动项目地址为[nova-docker](https://github.com/openstack/nova-docker)。

但是，Docker毕竟是容器，它与虚拟机还是有差别的，使用Nova集成Docker，难以支持Docker的一些高级特性，比如link、volume等。于是又有人提出与Heat集成，通过Heat能够充分利用Docker API，但缺乏调度机制。于是干脆单独一个新的项目来专门提供容器服务，支持多租户和资源调度，这个项目名称为magnum。再后来，magnum想专注于容器编排服务，集成K8S、Docker Swarm等容器编排服务，而单容器服务则又独立一个项目Zun。

## 裸机

Nova既然能管理虚拟机，那肯定会有人想，能不能管理我们的物理机呢？很好，Nova做到了。Nova很早就支持了裸机管理，原理就是原来对接Libvirt的接口，现在替换为调用IPMI接口，从而实现了裸机的管理。因此Nova的裸机驱动其实就相当于封装了`ipmitool`命令，事实上，也正是对`ipmitool`的shell调用。

最开始，裸机管理的代码实现是直接放在Nova源码中的，后来分离出单独的[Ironic项目](https://wiki.openstack.org/wiki/Ironic)，提供裸机管理服务。

![ironic](/img/posts/聊聊Nova-compute-driver的那些趣事/ironic.png)

原来的IPMI封装放在了ironic-conductor服务，所有的裸机操作必须通过ironic-api调用。因此原来的Nova裸机驱动实现由直接的IPMI封装，替换为了ironic-api的封装。

## 总结

除了以上提到的虚拟机、OpenStack本身、Docker容器以及物理机，Nova未来还有可能支持更多的东西，也许现在想不到，谁又说得准以后的事呢。
