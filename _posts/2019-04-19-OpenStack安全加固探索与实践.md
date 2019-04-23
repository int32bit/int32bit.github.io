---
layout: post
title: OpenStack安全加固探索与实践
catalog: true
header-img: "img/posts/OpenStack安全加固探索与实践/bg.jpg"
---

**本文转发自<strong>民生运维</strong>微信公众号,关注该公众号阅读更多云计算相关技术分享， 如需转发到其他公众号，请联系本人开通白名单。**

## 1 前言

在构建企业私有云时，除了平台的功能性和稳定性，安全性也是非常重要的因素，尤其对于银行业，数据中心以及监管部门对平台的安全性要求更高。

OpenStack是IaaS的开源实现，经过几年的发展，OpenStack的功能越来越完善，运行也越来越稳定，目前已经成为企业构建私有IaaS云的主流选择之一。

我们从2016年就开始研究和使用OpenStack了，不仅积累了大量的OpenStack云平台开发和运维经验，还针对OpenStack平台的安全性进行了探索与研究，对社区OpenStack进行了大量的安全加固优化，本文接下来将详细分享我们针对开源OpenStack的安全加固优化方案。

## 2 配置文件明文密码加密

### 2.1 为什么明文密码需要加密

密码是非常重要的敏感数据，一旦密码被泄露，系统就有可能被非授权人员利用导致信息泄露、篡改，因此密码的安全性保障是企业的重中之重工作。避免在服务器上保存文本明文密码是防止密码泄露的有效手段之一，对于银行业来说，也是监管部门的硬性要求之一。

目前我们已基于开源OpenStack构建了多套IaaS云平台，社区OpenStack配置文件使用的都是明文密码存储，存在巨大的安全隐患，社区针对这个问题也有讨论，参考[社区邮件列表](http://lists.openstack.org/pipermail/openstack-dev/2016-April/)。不过至今社区还没有现成的配置文件密码加密方案，但已经在尝试使用Secrets Management管理密码，如Castellan，详细文档可参考社区关于[secrets-management: passwords-in-config-files](https://docs.openstack.org/security-guide/secrets-management/secrets-management-use-cases.html#passwords-in-config-files)的讨论[2]，不过该方案离完全实现可能还需要一段时间。

然而由于我们线上系统的安全要求，我们对配置文件密码加密具有更迫切的需求，不得不在社区方案实现前完成OpenStack密码安全加固，对明文密码进行整改，对配置文件包含的所有敏感数据进行加密处理。

### 2.2 OpenStack明文加密思路

对OpenStack配置文件进行加密的工具很多，但要OpenStack支持密文，修改源码不可避免。为了降低代码变更造成的风险，我们确立的三大原则是：

* 尽量少的修改原有代码；
* 对原有系统尽量少的侵入；
* 避免交叉模块代码修改。

好在OpenStack具有良好的松耦合设计理念，虽然线上OpenStack环境涉及Keystone、Glance、Nova、Cinder、Neutron、Heat等多个项目，不同的项目关联不同的配置文件以及不同的配置项，但所有的配置文件读取都是通过`Oslo.config`模块读取的。

关于Oslo库，OpenStack不同项目中存在很多相同的功能，比如连接数据库、连接消息队列、线程池管理、配置读取等，因此早期OpenStack开发者经常从一个项目的代码拷贝到另一个项目去，导致OpenStack项目存在大量的重复代码。为了解决这个问题，OpenStack社区从Bexar版本开始决定剥离这些公共功能组件形成共享公共库，不过进展一直很缓慢，直到Grizzly版本指派PTL专门负责公共库项目，并正式采用Oslo这个项目名称，从此吸引大量的开发者加入Oslo项目的开发以及OpenStack项目代码Oslo化改造，Oslo成为了承载OpenStack核心组件的基石，更多关于OpenStack Oslo可参考[官方文档](https://docs.openstack.org/project-team-guide/oslo.html)[3]。

而`Oslo.config`就是Oslo中负责OpenStack配置管理的子模块，包括配置项的声明、校验、解析等，因此只要我们解决了`Oslo.config`读取密文问题，也就解决了OpenStack所有项目的配置加密问题，完全不需要涉及OpenStack其他项目的代码修改，从而大大减少了代码的侵入面。

### 2.3 哪些配置项需要加密

接下来我们需要解决的问题是要区分哪些配置项是敏感数据。我们分析了OpenStack的配置文件，发现虽然OpenStack的项目众多，配置文件分散，但涉及的敏感数据基本可以分为如下三类：

* Keystone认证密码。主要用于OpenStack各个组件内部认证使用的账号密码，如`keystone_authtoken`配置组的`admin_password`配置项。
* 数据库密码。OpenStack组件连接数据的密码，如`database`配置组的`connection`配置项。
* 消息队列连接密码。OpenStack组件连接消息队列RabbitMQ的密码，如`rabbit_password`或者`transport_url`配置项。

这些配置项虽然分散在各个项目的不同配置文件，但所有敏感配置项都是相同并且所有敏感配置项可枚举，因此我们可以建立一个敏感配置项字典集，把所有敏感的配置项放在这个字典集中。读取配置时，如果配置项在这个字典中，则先解密再返回，否则无需解密直接返回。未来如果有新的敏感配置项引入，只需要修改字典文件即可，无需再修改代码，符合软件工程中的开放封闭设计原则。

Oslo.config读取配置项的模块为`oslo_config.cfg.ConfigOpts`的`_get()`方法，因此我们只需要修改该方法，嵌入加密配置项解密代码即可：

```python
def _get(self, name, group=None, namespace=None):
    # ...省略其它代码
    try:
        if namespace is not None:
            raise KeyError

        return self.__cache[key] # 配置项没有缓存
    except KeyError:
        value = self._do_get(name, group, namespace)
        if key in self._encrypted_opts:
            value = self.decrypt_value(value) # 解密
        self.__cache[key] = value # 加入缓存
        return value
```

### 2.4 如何加密

解决了在哪里加密以及哪些配置项需要加密的问题，最后需要解决的问题就是如何加密，即加密算法的选择。我们选择了AES加密算法，该算法是对称密钥加密中最流行的算法之一，AES加密在当前计算机计算能力下暴力破解的可能几乎为0，符合加密强度要求。

由于AES加密后是一串二进制，为了能够以文本字符的形式保存到配置文件，我们把密文编码为base64。

OpenStack在解密时需要读取加密时的密钥，密钥如何安全保存又是一个问题，一旦密钥泄露，密码还是可能被攻破。解决这个问题的最根本的办法是压根不保存密钥。我们在加密和OpenStack解密过程中只需要使用一套相同的自定义规则生成密钥，密钥不需要保存在本地，OpenStack组件启动时动态自动生成即可。

综上，我们实现的加密过程如下：

1. 基于自定义规则生成密钥K；
2. 输入明文T；
3. 对输入的T以及生成的K进行AES加密，生成密文D；
4. 对密文D转化为base64编码B；
5. 输出B。

如上过程通过外部脚本执行。

OpenStack组件启动时读取配置解密过程如下：

1. 基于自定义规则生成密钥K；
2. 读取配置项C；如果配置项C的key是敏感配置项，执行3，否则跳到5；
3. 对配置项的value进行base64解码，转化为密文D；
4. 使用生成的K，对密文D进行解密，生成明文T，value = T；
5. 输出明文value。

我们使用了Python的PyCrypto库实现AES加解密，其中解密的部分代码实现如下：

```python
def decrypt_value(self, enc):
    enc = base64.b64decode(enc) # 解码base64
    iv = enc[:AES.block_size] # 使用密文前缀作为随机初始化向量
    cipher = AES.new(self.key, AES.MODE_CBC, iv)
    dec = cipher.decrypt(enc[AES.block_size:])
    return self._unpad(dec).decode('utf-8')

@staticmethod
def _unpad(s):
    return s[:-ord(s[len(s)-1:])]
```

代码补丁开发完毕后，我们在测试环境下对补丁进行了充分验证后完成上线，目前平台已经顺利完成明文密码整改并稳定运行。

## 3 计算节点VNC加密

### 3.1 OpenStack虚拟机VNC简介

虚拟机的VNC是非常重要的功能，类似于物理服务器的带外console，能够不依赖于虚拟机操作系统的网络进行远程访问与控制。当虚拟机操作系统出现故障或者网络不通时，往往需要通过VNC进行远程连接修复。

OpenStack原生支持Web VNC功能，用户可通过Nova API获取虚拟机的VNC链接，VNC链接会带上一个授权的临时Token。用户访问Web VNC时其实访问的是Nova的`nova-novncproxy`服务，nova-novncproxy会首先检查Token是否有效，如果有效则会转发到对应虚拟机所在计算节点监听的VNC地址，否则连接将会被强制阻断。

因此，用户通过OpenStack平台访问虚拟机VNC是安全的，能够有效阻止非授权人员通过端口扫描非法访问VNC。

然而，原生OpenStack的Libvirt Driver目前还没有实现VNC连接密码认证功能，意味着非法人员可以不需要任何认证直接连接计算节点绕过OpenStack访问虚拟机VNC，利用VNC可发送电源指令或者`Ctrl+Alt+Delete`指令重启虚拟机并进入单用户模式，绕过操作系统root认证直接登录虚拟机，这显然存在巨大的安全隐患。

社区针对这个问题也有讨论，但一直没有实现，参考社区bug[#1450294](https://bugs.launchpad.net/nova/+bug/1450294)。

### 3.2 VNC加密优化

针对如上OpenStack虚拟机没有配置VNC密码问题，我们对OpenStack进行了二次开发，增加了`password`参数配置VNC密码，核心代码如下：

```python
@staticmethod
def _guest_add_video_device(guest):
    # ...
    if CONF.vnc.enabled and guest.virt_type not in ('lxc', 'uml'):
        graphics = vconfig.LibvirtConfigGuestGraphics()
        graphics.type = "vnc"
        if CONF.vnc.keymap:
            graphics.keymap = CONF.vnc.keymap
        if CONF.vnc.vnc_password:
            graphics.password = CONF.vnc.vnc_password
        graphics.listen = CONF.vnc.server_listen
        guest.add_device(graphics)
        add_video_driver = True
   # ...
    return add_video_driver
```

如上实现了新创建虚拟机添加VNC密码功能，但是对正在运行的虚拟机并无影响，如果要使VNC密码生效必须重启虚拟机。但由于我们线上环境已经有业务在运行，重启虚拟机意味着必须中断业务，这显然不能接受。虚拟机不重启如何让其重刷配置呢？我们自然想到了虚拟机热迁移办法，虚拟机从一个宿主机热迁移到另一个宿主机，理论上会重新生成虚拟机配置，而又几乎对业务无影响。

然而当我们在测试环境上验证时发现虚拟机在线迁移并不会更新配置，于是我们又分析了虚拟机在线迁移的流程，发现在源端更新xml配置文件时没有添加VNC密码，该功能代码位于`nova/virt/libvirt/migration.py`的`_update_graphics_xml()`方法：

```python
def _update_graphics_xml(xml_doc, migrate_data):
    listen_addrs = graphics_listen_addrs(migrate_data)

    # change over listen addresses
    for dev in xml_doc.findall('./devices/graphics'):
        gr_type = dev.get('type')
        listen_tag = dev.find('listen')
        if gr_type in ('vnc', 'spice'):
            if listen_tag is not None:
                listen_tag.set('address', listen_addrs[gr_type])
            if dev.get('listen') is not None:
                dev.set('listen', listen_addrs[gr_type])
    return xml_doc
```

我们修改了该方法实现，增加了VNC密码的更新，经过验证，所有虚拟机通过在线迁移方法增加了VNC密码认证功能。

### 3.3 用户VNC连接

前面提到用户是通过Nova的`novncproxy`代理访问虚拟机VNC的，`novncproxy`北向接收用户请求，南向连接计算节点的VNC server，由于我们的VNC server增加了密码认证功能，因此novncproxy就无法直接连接VNC server了。

由于VNC使用了RFB（Remote Frame Buffer）协议进行数据传输，我们对RFB协议进行了研究，通过重写(overwrite)(`nova/console/websocketproxy.py`的`do_proxy()`方法，实现VNC密码的代填功能，从而实现用户能够沿用原有的方式通过OpenStack标准API访问虚拟机VNC，该部分实现准备在下一篇文章中进行详细介绍。

## 4 OpenStack平台加固措施

### 4.1 服务访问策略控制

OpenStack依赖很多公共组件服务，如数据库、消息队列、缓存服务等，这些服务是OpenStack的内部服务，通常不允许外部直接访问，安全访问控制非常重要，否则可能被非法访问导致信息泄露，甚至通过webshell进行主机攻击。

以Memcached服务为例，OpenStack利用Memcached存储了Keystone认证Token、VNC链接等缓存的敏感数据。

由于Memcached未对安全做更多设计，导致客户端连接Memcached服务后无需任何认证即可读取、修改服务器缓存内容。

```bash
# 导出Memcached数据，192.168.0.0/24为OpenStack管理网平面
memcached-tool 192.168.0.4:11211 dump 
```

同时，由于Memcached中数据和正常用户访问变量一样会被后端代码处理，当处理代码存在缺陷时，将可能导致不同类型的安全问题，比如SQL注入。

为了规避如上安全风险，我们通过iptables对访问来源进行严格限制，只允许OpenStack控制节点访问，其他源一律阻断访问。

```python
iptables -A INPUT -s 192.168.0.1 -p tcp --dport 11211 -j ACCEPT
iptables -A INPUT -s 192.168.0.2 -p tcp --dport 11211 -j ACCEPT
iptables -A INPUT -s 192.168.0.3 -p tcp --dport 11211 -j ACCEPT
# ... 其他控制节点
iptables -A INPUT -p tcp --dport 11211 -j DROP
```

其他服务如mysql、rabbitmq等，也做了类似的操作，尽可能缩小服务开放范围，最小权限控制。

### 4.2 源码和配置文件安全

为了确保密码的安全性，除了对配置文件的密码加密，还需要对配置文件的权限进行严格控制，禁止非授权用户读取，我们线上的所有配置文件均设置了仅root用户可读权限。

另外由于OpenStack是基于Python解释性语言编写的，源码的安全性也非常重要，需要对代码的读写权限进行严格地安全管控，避免非法人员通过断点注入方式截取密码等数据，因此我们线上的源码也同样设置了仅root可读写权限。

### 4.3 API SSL加密

OpenStack提供了`internal`、`admin`、`public`三种类型的endpoint，通常OpenStack内部组件间通信会使用`internal endpoint`，比如Nova向Glance获取镜像信息，向Neutron获取网络信息等，内部`endpoint`通常不对外开放。用户访问OpenStack API时通常使用`public endpoint`，因此`public endpoint`通常是对外开放的，必须对其进行严格安全防控。

我们对`public endpoint`进行了SSL加密，只允许通过`https`协议访问OpenStack API，保证数据传输的安全性。

## 5 总结

本文首先介绍了我们私有云的构建情况，引入私有云安全的重要性，然后详细介绍了我们针对开源OpenStack的安全加固优化措施，包括配置文件信息加密、VNC密码认证等，最后介绍了我们针对OpenStack平台的安全加固方案，如对OpenStack内部服务访问进行严格控制以及配置文件和源码的读写权限设置等。

### 参考资料

* [OpenStack社区讨论明文密码加密的邮件列表](http://lists.openstack.org/pipermail/openstack-dev/2016-April/093358.html).
* [secrets-management: passwords-in-config-files](https://docs.openstack.org/security-guide/secrets-management/secrets-management-use-cases.html).
* [Oslo官方文档](https://docs.openstack.org/project-team-guide/oslo.html).
* [OpenStack社区vnc无密码认证问题讨论](https://bugs.launchpad.net/nova/+bug/145029).
