---
layout: post
title: 手动部署docker swarm集群
catalog: true
tags:
    - Docker
    - Swarm
---

## 前言

Docker Swarm是一个Dockerized化的分布式应用程序的本地集群，支持用户创建可运行Docker Daemon的主机资源池，然后在资源池中运行Docker容器。它是官方的Docker集群管理工具，提供和docker基本一致的api，把多个主机虚拟化成一个独立的主机，相对于[marathon](https://mesosphere.github.io/marathon/)/[mesos](https://mesos.apache.org/)以及[k8s](http://kubernetes.io/)，它更易于部署，并且由于和docker api一致，更容易上手。接下来本文将基于[官方文档](https://docs.docker.com/swarm/install-manual/),搭建一个docker swarm测试环境。

## 系统环境

本文测试时使用两台虚拟机A、B，配置如下：

* 操作系统：`ubuntu 14.04`
* docker server/client版本: `1.11.1`
* docker API版本: `1.23`
* 网卡信息: A: `192.168.56.4` B: `192.168.56.5`
* docker配置: `/etc/default/docker`，内容如下:

```
DOCKER_OPTS="--registry-mirror=http://houchaohann.m.alauda.cn -H tcp://0.0.0.0:2375 -H unix:///var/run/docker.sock"
```

**注意:**如果先在其中一个虚拟机中部署Docker并配置好，然后通过克隆的方法复制第二个节点，会造成docker节点ID相同，此时需要手动删除`/etc/docker/key.json`文件，再重启docker服务即可。务必在此之前检查docker节点的ID是否存在冲突:

```
root@ubuntu-5:/etc/docker# docker info | grep ID
ID: L2SK:T2RD:RQH2:YC2O:NJKA:EQH2:Q35Z:C26T:J75Y:RPDK:M5OX:FW6S
```
以上所有节点的ID不能出现重复！

## 安装服务发现组件

docker swarm依赖于服务发现组件，支持的后端包括`etcd`、`zookeeper`、`consul`等，本文将使用`consul`作为服务发现后端:

为了简化部署，本文不考虑服务发现组件的高可用，因此只有单节点，部署在A机器上:

```bash
#!/bin/bash
NAME=consul
docker rm -f $NAME 2>/dev/null
docker run -d --restart=always -p 8500:8500 --name=$NAME --hostname $NAME progrium/consul -server -bootstrap
```

## 配置Swarm集群

首先我们需要部署swarm manager节点，为了避免单点故障，我们部署两个swarm master节点来保证高可用，在A机器中执行:

```bash
#!/bin/bash
MY_IP=192.168.56.4
CONSUL_IP=192.168.56.4
NAME=swarm-master-1
docker rm -f $NAME &>/dev/null
docker run -d -p 4000:4000 --restart=always --name $NAME --hostname $NAME swarm manage -H :4000 --replication --advertise $MY_IP:4000 consul://$CONSUL_IP:8500
```

在B机器上执行：

```bash
#!/bin/bash
MY_IP=192.168.56.5
CONSUL_IP=192.168.56.4
NAME=swarm-master-2
docker rm -f $NAME &>/dev/null
docker run -d -p 4000:4000 --name $NAME --hostname $NAME --restart=always swarm manage -H :4000 --replication --advertise $MY_IP:4000 consul://$CONSUL_IP:8500
```

部署好swarm manager节点后，就可以增加我们的计算节点了，由于我们的节点有限，计算节点同样部署在A、B机器上:

在A节点运行:

```bash
#!/bin/bash
CONSUL_IP=192.168.56.4
MY_IP=192.168.56.4
NAME=swarm-node-1
docker rm -f $NAME &>/dev/null
docker run -d --name $NAME --hostname $NAME --restart=always  swarm join --advertise=$MY_IP:2375 consul://$CONSUL_IP:8500
```

在B节点上运行:

```bash
#!/bin/bash
CONSUL_IP=192.168.56.4
MY_IP=192.168.56.5
NAME=swarm-node-2
docker rm -f $NAME &>/dev/null
docker run -d --name $NAME --hostname $NAME --restart=always  swarm join --advertise=$MY_IP:2375 consul://$CONSUL_IP:8500
```

## 检查集群

以上工作均完成以后，就可以手动测试是否工作了:

```bash
docker -H :4000 info
```
输出:

```
Containers: 6
 Running: 5
 Paused: 0
 Stopped: 1
Images: 8
Server Version: swarm/1.2.2
Role: primary
Strategy: spread
Filters: health, port, containerslots, dependency, affinity, constraint
Nodes: 2
 ubuntu-4: 172.16.1.24:2375
  └ ID: N2NA:VXFI:KKUR:FEJL:NG72:B5YN:HEP3:WENB:V6AZ:EGGK:RAC3:KXKH
  └ Status: Healthy
  └ Containers: 4
  └ Reserved CPUs: 0 / 1
  └ Reserved Memory: 0 B / 1.018 GiB
  └ Labels: executiondriver=, kernelversion=4.2.0-36-generic, operatingsystem=Ubuntu 14.04.4 LTS, storagedriver=aufs
  └ Error: (none)
  └ UpdatedAt: 2016-05-10T17:13:30Z
  └ ServerVersion: 1.11.1
 ubuntu-5: 172.16.1.178:2375
  └ ID: L2SK:T2RD:RQH2:YC2O:NJKA:EQH2:Q35Z:C26T:J75Y:RPDK:M5OX:FW6S
  └ Status: Healthy
  └ Containers: 2
  └ Reserved CPUs: 0 / 1
  └ Reserved Memory: 0 B / 1.018 GiB
  └ Labels: executiondriver=, kernelversion=4.2.0-36-generic, operatingsystem=Ubuntu 14.04.4 LTS, storagedriver=aufs
  └ Error: (none)
  └ UpdatedAt: 2016-05-10T17:13:31Z
  └ ServerVersion: 1.11.1
Plugins:
 Volume:
 Network:
Kernel Version: 4.2.0-36-generic
Operating System: linux
Architecture: amd64
CPUs: 2
Total Memory: 2.036 GiB
Name: swarm-master
Docker Root Dir:
Debug mode (client): false
Debug mode (server): false
```

从结果中我们发现，我们一共有两个节点，务必检查每个节点的`Status`为`Healthy`。

