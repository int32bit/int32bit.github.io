---
layout: post
title: 使用Docker一键部署Ceph测试环境
catalog: true
tags: [Ceph, Docker]
---

Ceph是开源统一分布式存储系统，最初是Sage Weil在UCSC的PhD研究内容，目前由Inktank公司掌控Ceph的开发。Ceph同时支持块存储、对象存储以及文件系统存储，并且具有高扩展性、高可靠性、高性能的优点。Ceph目前最广泛的使用场景之一是作为Openstack的存储后端，为Openstack提供统一共享分布式存储服务。Openstack组件中Nova、Glance、Cinder都支持对接Ceph RBD. Ceph的多节点部署可参考[Ubuntu环境部署多节点Ceph集群](http://int32bit.me/2016/04/15/%E4%BD%BF%E7%94%A8ubuntu%E5%BF%AB%E9%80%9F%E9%83%A8%E7%BD%B2ceph%E9%9B%86%E7%BE%A4/)。

如果要学习Ceph，而手头又没有Ceph开发测试环境，最好的办法是手动部署个单节点Ceph环境，使用虚拟机相对要麻烦些，好在官方提供了Ceph单节点的Docker镜像[ceph-demo](https://hub.docker.com/r/ceph/demo/)。

本文在官方镜像的基础上，写了一个快速生成Ceph容器实例的脚本，使用该脚本不需要任何配置即可一键部署Ceph单节点实例：

```bash
#!/bin/bash
#!/bin/bash
# start_ceph.sh
# author: int32bit
# date: 2016-04-22

MY_IP=$(docker run -t -i --network=host --rm alpine ip route get 8.8.8.8 | awk '{print $7}')
CIDR=$(docker run -t -i --rm --network=host alpine ip a | grep $MY_IP | awk '{print $2}')
NETWORK_ADDR=$(docker run -t -i --rm alpine ipcalc $CIDR -n | cut -d '=' -f 2 | tr -d '\r' )
PREFIX=$(docker run -t -i --rm alpine ipcalc $CIDR -p | cut -d '=' -f 2 | tr -d '\r')
IMAGE=ceph/demo
NAME=ceph
docker rm -f $NAME &>/dev/null # remove if exists.
docker run -d --net=host -e MON_IP=$MY_IP -e CEPH_PUBLIC_NETWORK=${NETWORK_ADDR}/$PREFIX --name $NAME $IMAGE
```

当需要快速生成Ceph测试环境时只需要在运行了Docker的环境下执行以上脚本即可：

```
./start_ceph.sh
```

为了方便在本地使用Ceph CLI，设置如下别名:

```bash
alias ceph='docker exec -t -i ceph ceph'
alias rados='docker exec -t -i ceph rados'
alias rbd='docker exec -t -i ceph rbd'
```

执行`ceph -s`验证是否部署成功:

```
ceph -s | grep health
```

如果以上输出`HEALTH_OK`则表明Ceph测试环境部署完成。
