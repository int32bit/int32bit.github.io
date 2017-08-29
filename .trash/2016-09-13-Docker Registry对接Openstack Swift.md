---
layout: post
title: Docker Registry对接OpenStack Swift
catalog: false
tags: [Docker, OpenStack]
---

Docker Registry默认使用本地文件系统存储镜像文件，路径为`/var/lib/registry`。事实上Docker Registry支持多种存储后端，参考[官方文档](https://docs.docker.com/registry/configuration/)，支持的存储后端列表如下:

* filesystem：本地文件系统
* inmemory： 直接保存在内存，不能持久化
* azure
* gcs：Google存储系统
* S3
* OpenStack Swift
* oss

**注意Docker Registry同时只能支持一个存储后端，不能同时配置多个，否则出错。**

下面以对接`OpenStack Swift`为例，配置文件为:

```yaml
version: 0.1
log:
  fields:
    service: registry
storage:
  swift:
    tenant: admin
    username: admin
    password: 5c8d15f732104053
    authurl: http://10.0.10.216:5000/v2.0
    container: docker_registry
http:
  addr: :5000
  headers:
    X-Content-Type-Options: [nosniff]
health:
  storagedriver:
    enabled: true
    interval: 10s
    threshold: 3   
```

其中`container`参数指定使用的Swift容器，**启动registry服务前必须先创建**:

```bash
docker post docker_registry
```

registry的配置文件默认读取`/etc/docker/registry/config.yml`，我们挂载到容器中.最后启动registry服务的脚本为:

```
#!/bin/bash
NAME=registry
IMAGE=registry:2
docker rm -f $NAME 2>/dev/null
docker run -d \
-p 15000:5000 \
--restart=always \
-v `pwd`/data/registry:/var/lib/registry \
-v `pwd`/resitry_config.yml:/etc/docker/registry/config.yml \
--name $NAME $IMAGE
```

由于`5000`端口被keystone占用，因此我选用了`15000`端口，以上`registry_config.yml`为registry的配置文件，配置内容见上面内容。

接下来验证下是否成功对接，首先tag镜像为我们的仓库:

```bash
docker tag busybox localhost:15000/busybox:latest
```

上传镜像到我们的仓库中:

```bash
docker push localhost:15000/busybox
```

上传成功后查看swift是否存在镜像文件:

```
[root@server-216 docker(keystone_admin)]# swift list docker_registry
files/docker/registry/v2/blobs/sha256/13/1359608115b94599e5641638bac5aef1ddfaa79bb96057ebf41ebc8d33acf8a7/data
files/docker/registry/v2/blobs/sha256/2b/2b8fd9751c4c0f5dd266fcae00707e67a2545ef34f9a29354585f93dac906749/data
files/docker/registry/v2/blobs/sha256/8d/8ddc19f16526912237dd8af81971d5e4dd0587907234be2b83e249518d5b673f/data
files/docker/registry/v2/repositories/busybox/_layers/sha256/2b8fd9751c4c0f5dd266fcae00707e67a2545ef34f9a29354585f93dac906749/link
files/docker/registry/v2/repositories/busybox/_layers/sha256/8ddc19f16526912237dd8af81971d5e4dd0587907234be2b83e249518d5b673f/link
files/docker/registry/v2/repositories/busybox/_manifests/revisions/sha256/1359608115b94599e5641638bac5aef1ddfaa79bb96057ebf41ebc8d33acf8a7/link
files/docker/registry/v2/repositories/busybox/_manifests/tags/latest/current/link
files/docker/registry/v2/repositories/busybox/_manifests/tags/latest/index/sha256/1359608115b94599e5641638bac5aef1ddfaa79bb96057ebf41ebc8d33acf8a7/link
segments/2f6/46f636b65722f72656769737472792f76322f7265706f7369746f726965732f62757379626f782f5f75706c6f6164732f38613632643561662d363238622d346437302d383631352d3363613364343931303837632f64617461cf437c04fbdefc097c5950984261db23b345be8f4ddaeafb00b0e85498740177da39a3ee5e6b4b0d3255bfef95601890afd80709/0000000000000001
segments/2f6/46f636b65722f72656769737472792f76322f7265706f7369746f726965732f62757379626f782f5f75706c6f6164732f39396466333866612d653166312d343432662d393939342d6637346336363034623830322f64617461f2f622a0bf17bef3f2fae2745f7cec6f2d736a2384ea2ad0f56286fa76ff114dda39a3ee5e6b4b0d3255bfef95601890afd80709/0000000000000001
```

如果存在以上内容，说明对接成功。
