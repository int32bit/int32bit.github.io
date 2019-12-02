---
layout: post
title: 如何读取Kubernetes存储在etcd上的数据
catalog: true
tags: [etcd, Kubernetes]
---

etcd是一个分布式KV存储系统，在分布式系统中被广泛使用，Kubernetes就是使用了etcd存储持久化数据，包括创建的所有Pod、Deployment、Service等资源。

接下来我们看下如何读取Kubernetes存的数据。

首先如果使用kubeadm部署Kubernetes，默认会把CA根证书和签发的Server证书放在`/etc/kubernetes/pki/etcd`目录下，并且etcd Pod使用的是host网络:

因此可以直接在Master节点使用etcdctl命令:

```bash
alias etcdctl='etcdctl \
	--key=/etc/kubernetes/pki/etcd/server.key \
	--cert=/etc/kubernetes/pki/etcd/server.crt  \
	--cacert=/etc/kubernetes/pki/etcd/ca.crt \
	--endpoints https://127.0.0.1:2379'

# etcdctl endpoint status
https://127.0.0.1:2379, 17057a8cf6d6cbb3, 3.3.15, 10 MB, true, 4, 523191
```

由于新版本Kubernetes默认使用了etcd v3 API，v3版本的数据存储没有目录层级关系了，而是采用平展（flat)模式，换句话说`/a`与`/a/b`并没有嵌套关系，而只是key的名称差别而已，这个和AWS S3以及OpenStack Swift对象存储一样，没有目录的概念，但是key名称支持`/`字符，从而实现看起来像目录的伪目录，但是存储结构上不存在层级关系。

也就是说etcdctl无法使用类似v2的`ls`命令。但是我还是习惯使用v2版本的`etcdctl ls`查看etcdctl存储的内容，于是写了个性能不怎么好但是可以用的shell脚本`etcd_ls.sh`:

```bash
#!/bin/bash
KEY_FILE=/etc/kubernetes/pki/etcd/server.key
CERT_FILE=/etc/kubernetes/pki/etcd/server.crt
CA_FILE=/etc/kubernetes/pki/etcd/ca.crt
ENDPOINTS=https://127.0.0.1:2379
PREFIX=${1:-/}
ORIG_PREFIX="$PREFIX"

LAST_CHAR=${PREFIX:${#PREFIX}-1:1}
if [[ $LAST_CHAR != '/' ]]; then
    PREFIX="$PREFIX/" # Append  '/' at the end if not exist
fi

for ITEM in $(etcdctl --key="$KEY_FILE" \
                      --cert="$CERT_FILE" \
                      --cacert="$CA_FILE" \
                      --endpoints "$ENDPOINTS" \
                      get "$PREFIX" --prefix=true --keys-only | grep "$PREFIX"); do
    PREFIX_LEN=${#PREFIX}
    CONTENT=${ITEM:$PREFIX_LEN}
    POS=$(expr index "$CONTENT" '/')
    if [[ $POS -le 0 ]]; then
	    POS=${#CONTENT} # No '/', it's not dir, get whole str
    fi
    CONTENT=${CONTENT:0:$POS}
    LAST_CHAR=${CONTENT:${#CONTENT}-1:1}
    if [[ $LAST_CHAR == '/' ]]; then
        CONTENT=${CONTENT:0:-1}
    fi
    echo "${PREFIX}${CONTENT}"
done | sort | uniq

etcdctl --key="$KEY_FILE" \
        --cert="$CERT_FILE"  \
        --cacert="$CA_FILE" \
        --endpoints "$ENDPOINTS" get "$ORIG_PREFIX"
```

由于Kubernetes的所有数据都以`/registry`为前缀，因此首先查看`/registry`:

```
# ./etcd_ls.sh /registry
/registry/apiregistration.k8s.io
/registry/clusterrolebindings
/registry/clusterroles
/registry/configmaps
/registry/controllerrevisions
/registry/daemonsets
/registry/deployments
/registry/events
/registry/leases
/registry/masterleases
/registry/minions
/registry/namespaces
/registry/persistentvolumeclaims
/registry/persistentvolumes
/registry/pods
/registry/podsecuritypolicy
/registry/priorityclasses
/registry/ranges
/registry/replicasets
/registry/rolebindings
/registry/roles
/registry/secrets
/registry/serviceaccounts
/registry/services
/registry/statefulsets
/registry/storageclasses
```

我们发现除了`minions`、`range`等大多数资源都可以通过`kubectl get xxx`获取，组织格式为`/registry/{resource_name}/{namespace}/{resource_instance}`，而`minions`其实就是node信息，Kubernetes之前节点叫`minion`，应该还没有改过来，因此还是使用的`/registry/minions`。

`range`对应Service网段以及NodePort端口范围:

```sh
# ./etcd_ls.sh /registry/ranges
/registry/ranges/serviceips
/registry/ranges/servicenodeports
# ./etcd_ls.sh /registry/ranges/servicenodeports | strings
/registry/ranges/servicenodeports
RangeAllocation
30000-32767
# ./etcd_ls.sh /registry/ranges/serviceips | strings
/registry/ranges/serviceips
RangeAllocation
10.96.0.0/12
```

如上为什么需要使用`strings`命令，那是因为除了`/registry/apiregistration.k8s.io`是直接存储JSON格式的，其他资源默认都不是使用JSON格式直接存储，而是通过protobuf格式存储，当然这么做的原因是为了性能，除非手动配置`--storage-media-type=application/json`，参考[etcdctl v3: k8s changes its internal format to proto, and the etcdctl result is unreadable](https://github.com/kubernetes/kubernetes/issues/44670)。

如果我们直接读会得到部分乱码:

![etcd_ls_pods](/img/posts/如何读取Kubernetes存储在etcd上的数据/etcd_ls_pods.png)

使用proto提高了性能，但也导致有时排查问题时不方便直接使用etcdctl读取内容，可幸的是openshift项目已经开发了一个强大的辅助工具[etcdhelper](https://github.com/openshift/origin/tree/master/tools/etcdhelper)可以读取etcd内容并解码proto。

不过编译有坑，需要做如下修改:

![color_diff](/img/posts/如何读取Kubernetes存储在etcd上的数据/color_diff.png)

通过如下命令进行编译安装:

```bash
go build .
cp etcdhelper /usr/local/bin
alias etcdhelper='etcdhelper -cacert /etc/kubernetes/pki/etcd/ca.crt \
                             -key /etc/kubernetes/pki/etcd/server.key \
                             -cert /etc/kubernetes/pki/etcd/server.crt'
```

编译完后就可以读取etcd解码内容了，比如读取namespace default信息:

```json
# etcdhelper get /registry/namespaces/default && echo
/v1, Kind=Namespace
{
  "kind": "Namespace",
  "apiVersion": "v1",
  "metadata": {
    "name": "default",
    "uid": "6ee8cecc-37f3-4df5-a415-27d1e5023266",
    "creationTimestamp": "2019-11-28T09:00:35Z"
  },
  "spec": {
    "finalizers": [
      "kubernetes"
    ]
  },
  "status": {
    "phase": "Active"
  }
}
```

值得注意的是存储在etcd的secret默认仅仅使用了base64编码而并没有加密:

![get secret](/img/posts/如何读取Kubernetes存储在etcd上的数据/etcdhelper_get_secret.png)

可见`kubectl get secret`一样，secret是base64编码的，secret保存着私钥证书、Docker登录信息、密码等敏感数据，因此需要严格控制etcd的访问权限，避免其他人读取。

当然更安全起见，建议配置etcd数据存储加密，参考[https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/).
