---
layout: post
title: 分享几个Kubernetes实用插件和工具
catalog: true
tags: [Kubernetes]
---

前两周分享了两篇文章[Kubernetes与IaaS资源融合实践](https://int32bit.me/2019/11/24/Kubernetes%E4%B8%8EIaaS%E8%B5%84%E6%BA%90%E8%9E%8D%E5%90%88%E5%AE%9E%E8%B7%B5/)、[IPVS从入门到精通kube-proxy实现原理](https://int32bit.me/2019/11/28/IPVS%E4%BB%8E%E5%85%A5%E9%97%A8%E5%88%B0%E7%B2%BE%E9%80%9Akube-proxy%E5%AE%9E%E7%8E%B0%E5%8E%9F%E7%90%86/)，这两篇都和网络有关，只要和网络有关就离不开要分析各种iptables、路由规则、策略路由，非常烧脑，如果不搞个真实环境演练下，真的很难搞清楚。

这篇文章走的是休闲路线，主要分享几个个人认为比较有用的工具，不用费脑，仅供参考 :)

## Kubectl插件

### 关于kubectl插件

kubectl插件其实就是以`kubectl-`为前缀的任意可执行文件，比如执行:

```bash
ln -s /bin/echo /usr/local/bin/kubectl-echo
```

此时就相当于安装了个`echo`的kubectl插件，kubectl插件可以通过`kubectl` + `插件名`执行，`kubectl xxx`其实就是相当于运行`kubectl-xxx`。

比如要运行我们的`echo`插件，只需执行如下命令:

```sh
# kubectl echo "HelloWorld!"
HelloWorld!
```

通过`kubectl plugin list`可列出当前PATH目录下所有插件:

```sh
# kubectl plugin list
The following compatible plugins are available:

/root/.krew/bin/kubectl-grep
/root/.krew/bin/kubectl-krew
/root/.krew/bin/kubectl-ns
/root/.krew/bin/kubectl-ssh_jump
/root/.krew/bin/kubectl-whoami
/usr/local/bin/kubectl-echo
```

所以要实现自己的插件，只需要把最终的可执行文件命名为`kubectl-xxxx`，然后放到PATH包含任意目录即可，但注意无法覆盖kubectl已有的子命令，如果与kubectl现有的子命令相同，则会优先执行内置子命令，因此插件不会被执行。

### krew

首先要介绍的就是krew，krew是一个Kubernetes的包管理工具，它的功能就是提供简单的方法下载、检索、管理其他插件，类似操作系统的apt、yum、brew等工具，其命名也似乎模仿的brew工具。

安装krew的官方脚本如下：

```bash
(
  set -x; cd "$(mktemp -d)" &&
  curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/download/v0.3.2/krew.{tar.gz,yaml}" &&
  tar zxvf krew.tar.gz &&
  ./krew-"$(uname | tr '[:upper:]' '[:lower:]')_amd64" install \
    --manifest=krew.yaml --archive=krew.tar.gz
)
```

安装完后就可以使用krew搜索、安装其他插件了，本文接下来介绍的大多数插件都可以使用krew直接安装。

```
# kubectl krew search whoami
NAME    DESCRIPTION                                         INSTALLED
whoami  Show the subject that's currently authenticated...  yes
# kubectl krew install ns
```

krew在[krew index](https://github.com/kubernetes-sigs/krew-index)项目中维护支持的插件列表以及下载路径，目前所有插件都是在github中发布下载，但由于众所周知的原因，国内从github下载速度非常慢😑。

为了提高下载速度，写了个脚本使用axel下载替换原来的下载方式，提速至少10倍以上👿：

![](/img/posts/分享几个Kubernetes实用插件和工具/fast-krew.gif)

脚本可以在我的github中下载[fast-krew](https://github.com/int32bit/fast-krew)。

### kubectx / kubens

kubectx用于快速切换Kubernetes context，而kubens则用于快速切换namespace，我认为二者强大之处在于可以结合[fzf](https://github.com/junegunn/fzf)使用。任何工具只要和fzf结合，都会很强大😁。

如切换到`kube-system` namespace:

```
kubectl ns kube-system
```

如果不指定namespace，则调用fzf交互式选择:

![ns](/img/posts/分享几个Kubernetes实用插件和工具/ns.gif)

如上黄色的namespace表示当前namespace，通过方向键移动箭头选择需要切换的目标namespace，切换context也一样，由于测试环境只有一个admin，因此只有一个选项。

### debug

我们知道容器的最佳实践是只运行单个应用进程，因此为了精简镜像，我们通常在构建镜像时只包含进程运行所需要包和程序，但这样其实也给排查故障带来问题，尤其是网络问题，想抓个包实在太麻烦。

我们常规的做法是先手动进入Pod所在的Node节点，然后找到对应的网络namespace，参考我之前的文章[浅聊几种主流Docker网络的实现原理](https://int32bit.me/2019/09/02/%E8%81%8A%E8%81%8A%E5%87%A0%E7%A7%8D%E4%B8%BB%E6%B5%81Docker%E7%BD%91%E7%BB%9C%E7%9A%84%E5%AE%9E%E7%8E%B0%E5%8E%9F%E7%90%86/)，最后切换到容器的网络namespace中进行抓包，特别麻烦。

为了解决这个问题，社区中也提供了许多插件方案，

[kubectl-debug](https://github.com/verb/kubectl-debug)通过EphemeralContainers的方式在运行的Pod中增加一个debugger的容器，然后通过kubectl exec进入该容器进行调试。

[ksniff](https://github.com/eldadru/ksniff)工具主要用于容器抓包，其实现方式是把本地静态的tcpdump工具拷贝到容器的/tmp目录，然后就可以通过kubectl exec进入容器运行tcpdump工具了。

但我觉得最好用的还是国内PingCAP公司开源的[debug工具](https://github.com/aylei/kubectl-debug/)，其实现原理是在目标Node节点上创建一个新的`Debug Agent`Pod,这个agent会在Node节点创建一个新的容器，这个容器会加入目标Pod的各个Namespace中，于是就可以进入容器进行调试了，目前这个新容器使用的默认镜像是`nicolaka/netshoot`，这个镜像里面包含netstat、ip、tcpdump等各种网络调试工具，真是太方便了。

更多关于debug设计和用法可参考作者的文章[简化Pod故障诊断: kubectl-debug 介绍](https://aleiwu.com/post/kubectl-debug-intro/)。

如下是我的一个演示动画：

![kube-debug](/img/posts/分享几个Kubernetes实用插件和工具/debug.gif)

### grep

基于name搜索资源，资源包括DaemonSets、Pods、Deployments、Nodes等，如搜索名字中带`web`的所有Pods:

```
# kubectl grep pod web
NAMESPACE   NAME    READY   STATUS    RESTART   AGE
default     web-0   1/1     Running   0         37h
default     web-1   1/1     Running   0         37h
default     web-2   1/1     Running   0         37h
```

在所有的namespaces搜索名字带`virt`的Deployments:

```
# kubectl grep deployment virt  --all-namespaces
NAMESPACE   NAME              DESIRED   CURRENT   UP-TO-DATE   AVAILABLE   AGE
kubevirt    virt-api          2         2         2            2           5h32m
kubevirt    virt-controller   2         2         2            2           5h32m
kubevirt    virt-operator     2         2         2            2           5h49m
```

### iexec

exec命令的功能增强版本，我们知道exec必须指定Pod的名称，如果一个Pod有多个容器，则还需要指定容器名称，而使用exec则可以通过Pod模糊查询然后交互式选择，如果Pod中包含多个容器，也可以通过交互式选择。

比如我创建的Deployment有如下5个nginx Pod:

```
[root@ip-192-168-193-172 ~ (⎈ |kubernetes-# kubectl get pod
NAME                     READY   STATUS    RESTARTS   AGE
nginx-6984d55cb6-b7zgp   2/2     Running   0          5m23s
nginx-6984d55cb6-bd8nf   2/2     Running   0          5m23s
nginx-6984d55cb6-dljzx   2/2     Running   0          5m23s
nginx-6984d55cb6-gn94v   2/2     Running   0          5m23s
nginx-6984d55cb6-kcj62   2/2     Running   0          5m23s
```

使用iexec可以直接运行如下命令:

```sh
kubectl iexec nginx
```

结果如下:

![iexec](/img/posts/分享几个Kubernetes实用插件和工具/iexec.png)

我们知道通过Deployment创建的Pod，Pod的命名格式为Deployment名字+加上Deployment的一段hash + Replica的一段hash，我们通常只记得Deployment的名字，而不知道Pod的名字，通过iexe只需要输入Deployment名字即可，通过交互式选择Pod，非常方便。

![iexec](/img/posts/分享几个Kubernetes实用插件和工具/iexec.gif)

### doctor

和brew doctor类似的工具，用于检查Kubernetes的健康状况以及扫描Kubernetes集群中的异常资源，比如etcd member状态、Node状态、孤儿endppoint等。

```sh
# kubectl doctor
---
 TriageReport:
- Resource: Endpoints
  AnomalyType: Found orphaned endpoints!
  Anomalies:
  - kube-controller-manager
  - kube-scheduler
  - virt-controller
  - virt-operator
```

### access-matrix

查看权限矩阵，比如查看针对Pod的API操作权限：

![access matrix](/img/posts/分享几个Kubernetes实用插件和工具/access-matrix.png)

### df-pv

kubectl目前只能获取pv的空间大小，而无法显示pv的真实使用情况，但其实kubelet summary API从1.8版本开始就已经有这些数据了，但官方kubectl工具还无法直接显示这些数据。

df-pv插件通过读取的summay API获取pv的使用量:

![df pv](/img/posts/分享几个Kubernetes实用插件和工具/df-pv.png)

### resource-capacity/view-allocations

查看Node节点的CPU和内存使用情况:

![resource capacity](/img/posts/分享几个Kubernetes实用插件和工具/resource-capacity.png)

如果要查看更详细，细粒度到每个Pod，则可以使用view-allocations插件:

![view-allocations](/img/posts/分享几个Kubernetes实用插件和工具/view-allocations.png)

### tail

我们知道kubectl的logs命令查看日志需要指定pod名称，如果一个pod还有多个容器，还需要指定容器名称，而[tail插件](https://github.com/boz/kail)支持同时查看多个pod的日志，支持通过Deployment、ReplicaSet等资源类型过滤日志。

![tail](/img/posts/分享几个Kubernetes实用插件和工具/tail.png)

## Kubernetes实用命令行工具

### kube-ps1 / kube-tmux

kube-ps1脚本即修改PS1环境变量，实现把Kubernetes的context信息如cluster名称、namespace等显示在bash/zsh的命令提示符中：

![ps1](/img/posts/分享几个Kubernetes实用插件和工具/ps1.png)

而kube-tmux则把信息显示在tmux:

![kube tmux](/img/posts/分享几个Kubernetes实用插件和工具/kube-tmux.png)

### kube-shell / kube-prompt

kube-shell和kube-prompt都是基于kubectl实现的交互式shell，支持命令自动补全、关键字高亮等功能。

其中kube-shell基于Python实现，使用起来和ipython差不多。

![kube shell](/img/posts/分享几个Kubernetes实用插件和工具/kube-shell.png)

不过实测kube-shell命令补全功能不是很全，比如`--all-namespaces`这个参数就补全不了，并且也不支持资源的自动补全。注：图中的灰色`--all-namespaces`参数不是自动补全，而是类似fish的历史命令提示。

因此更推荐使用`kube-prompt`，kube-prompt支持资源的自动补全:

![kube-prompt](/img/posts/分享几个Kubernetes实用插件和工具/kube-prompt.gif)

不过个人认为kubectl自带的命令自动补全功能已经够用了:

```sh
source <(kubectl completion bash)
```

如果需要频繁切换kubectl shell和OS shell，个人觉得使用OS shell + kubectl自动补全反而效率更高。

### 终极工具k9s

最后介绍一个终极Kubernetes命令行工具k9s，看它的logo就很形象，就是用来管理k8s资源的：

![k9s logo](/img/posts/分享几个Kubernetes实用插件和工具/k9s.png)

[k9s](https://github.com/derailed/k9s)是基于curses实现的终端UI交互式Kubernetes资源管理工具，操作有点类似vim，支持命令模式，支持alias、插件、自定义主题等功能，通过k9s能够交互式进行资源的增删改查、查看pod日志、exec等:

![k9s](/img/posts/分享几个Kubernetes实用插件和工具/k9s.gif)

如上通过命令模式输入`:deploy`进入Deployment页面，然后按快捷键`s`修改Replicas数量，回车进入该Deployment Pod列表，可以通过j、k键移动光标选择Pod，快捷键`l`查看Pod日志，`s`通过exec进入Pod shell，非常方便。
