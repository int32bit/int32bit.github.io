---
layout: post
title: Serverless函数计算简介以及典型场景实践
catalog: true
tags: [AWS, OpenStack, Serverless]
---

## 1 Serverless简介

### 1.1 比微服务拆分服务还要细

serverless是最近几年继微服务之后兴起的又一种非常流行的新型计算模式，它相对微服务来说是更加细粒度的服务架构模式，把用户所要执行的每个API操作进一步拆分。

换句话说，微服务包含了对某个资源的所有CURD操作，而Serverless则把针对资源的创建、读取、删除、更新等操作进一步拆分，每一个操作抽象为一个函数，Serverless是通过直接把这些函数暴露的形式进行发布，因此Serverless通常又称为函数计算服务(Function as Service, FaaS)。

### 1.2 Serverless可能是目前资源抽象级别最高的

从资源抽象上看，从最早的物理服务器开始，我们都在不断地抽象或者虚拟化服务器，而Serverless则更是抽象到了极致，它彻底屏蔽了底层硬件、操作系统甚至底层平台等技术细节

![](/img/posts/Serverless函数计算简介以及典型场景实践/server-growth.jpg)

<dev style='color:gray;'>注：图片来源https://www.phodal.com/blog/serverless-architecture-what-is-serverless-architecture/。</dev>

总而言之，毫不夸张地说Serverless比我们熟知的服务器、KVM、OpenStack、Kubernetes、微服务等提供了更高级的资源抽象能力。Serverless平台就像一个无限容量的超级计算机，只要把代码提交上去就能运行，不需要关心到底是运行在物理机、虚拟机还是容器。

当然Serverless并不意味着底层真的不需要服务器运行，而是平台屏蔽了后端基础资源和基础架构的维护，从实现上它依然可能运行在虚拟机、容器或者Kubernetes平台之上，只是用户不需要关心罢了，真正运行在哪个虚拟机上或者哪个Kubernetes集群其实都无所谓了。

### 1.3 从用户的视角看

而从用户的视角，用户只需要把代码写好打包提交上去即可运行，不需要自己准备运行的服务器、安装运行环境，所以可以近似认为Serverless提供了一个代码可运行的平台。

使用Serverless用户甚至都不需要关心运行所需要多少CPU、内存等计算资源，因为Serverless平台就提供了近似无限的计算能力，这也是和PaaS的主要区别，即大部分PaaS平台，用户依然需要手动维护运行的容量，需要手动扩容或者缩放平台规模。

>而对于FaaS应用，这种问题完全是透明的。AWS云架构战略副总裁Adrian Cockcroft曾经针对两者的界定给出了一个简单的方法：“如果你的PaaS能够有效地在20毫秒内启动实例并运行半秒,那么就可以称之为Serverless”。--摘抄自《从IaaS到FaaS—— Serverless架构的前世今生》

### 1.4 云计算层面分析

而从云计算角度，Serverless能够最大化利用计算资源，减少资源闲置和碎片。从云运营角度上看，Serverless能精确到代码调用次数和运行时间的粒度实现计量计费，实现调用一次计费一次，不调用不计费，这相对启动一个虚拟机运行代码来说，除非你的应用能够一直保证满载运行，否则只要资源空闲则意味着资源浪费。

## 2 那到底什么是Serverless？

前面讲了那么多，似乎都是概念和理论，那到底Serverless长什么样，怎么用呢？

### 2.1 写一个Serverless函数

接下来我们就以AWS的Serverless函数计算Lambda服务为例，介绍一个Serverless HelloWorld函数怎么运行的。

首先我们创建一个函数:

![](/img/posts/Serverless函数计算简介以及典型场景实践/aws_create_lambda.png)

创建一个函数只需要两个最基本的参数，一个是函数名称，另一个是运行环境，这里我们选择Python 3.8。我们发现根本不需要告诉它需要运行在虚拟机还是容器，也不需要告诉它运行到底需要多少CPU、多少内存，因为这一切都是透明的，用多少分多少。

但需要注意，这里说的理论上是不需要提前分配CPU和内存，但事实上仍需要对其使用的资源进行限制，否则你的应用如果存在内存泄露或者fork炸弹，则会导致资源浪费。因此AWS Lambda都会配置默认的内存限制128MB以及超时时间3秒，用户可以手动调节这些参数。

接下来我们就可以上传或者在线写代码了，这里我们的HelloWorld函数很简单，仅打印`HelloWorld!`以及返回`"hello"`字符串。

```python
def lambda_handler(event, context):
    print("HelloWorld!")
    return "hello"
```

我们点击`Test`按钮就可以运行我们的代码了:

![](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_test.png)

输出如预期那样打印了`HelloWorld!`并且函数返回了字符串`"hello"`。

所以Serverless就是这么简单，不是吗？

### 2.2 Serverless平台就是一个在线代码运行平台?

大多数人看到这里都可能会说，前面说了那么多，原来Serverless就是一个在线编程工具，这个网上这样的平台一大把，比如[codechef](https://www.codechef.com/ide)、[doocnn](https://www.dooccn.com/)、[repl.it](https://repl.it/)，随时随地有创意，随时随地写程序，支持C、C++、Python、Java、Php、Perl,Ruby、Bash、C#、Go、Lisp、Lua、Scala...，提交代码就能运行，这个AWS Lambda也没什么特别的嘛。

![](/img/posts/Serverless函数计算简介以及典型场景实践/repl.png)

确实如果需要手动去执行，这个与在线代码运行平台没什么区别，之前手头上没有现成的运行环境时懒得安装配置，我就是在AWS Lambda上测试代码的。

### 2.3 Serverless事件驱动

然而Serverless最强大的功能并不是能在线运行各种编程语言代码，而是其支持的各种触发器。细心的读者可能会发现Lambda的函数入口`lambda_handler(event, context)`有一个非常重要的参数`event`，这个event就是Lambda函数的灵魂、云平台的神经系统。

有了这个神经系统就相当于打通了整个云平台系统血脉，云平台上的任何一个服务都可以通过event传递到Lambda函数，Lambda函数接收到这个event后调用就相当于神经反射。

那什么是event呢？event翻译成中文就是事件，几乎所有的行为变化都可认为是一个事件，比如调用API创建一个虚拟机是一个事件，通过Web或者移动APP的一次HTTP调用也是一个事件，告警也是事件，定时器到点了也是事件，总之，你做的任何一件事都可以认为发生了一系列事件。

所以Serverless本质就是事件驱动的，有了事件，便有了灵魂，便和那些在线编程工具不再是同类。

当然事件那么多，但并不是所有的事件都是我们关心的，函数计算只处理已经注册的事件，AWS上叫添加触发器，这个和Linux的信号机制是完全一样的。

![aws_lambda_trigger](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_trigger.png)

为了验证event触发功能我们把代码改成如下：

```python
def lambda_handler(event, context):
   print(event)
   return event
```

如上代码我们并没有处理event，而是直接返回了event实例。

我们注册如下事件:

![](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_s3_trigger.png)

即注册了所有往S3 `int32bit-test`桶里创建对象的事件，可选参数`Prefix`、`Suffix`还可以进一步过滤事件，比如只处理上传以`.jpg`为文件扩展名的图片文件。

事件注册后手动向`int32bit-test`桶上传一个文件`repl.png`，在Cloudwatch中可以查看Lambda函数的执行记录：

![aws_lambda_log](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_log.png)

event输出如下:

```json
{
  "eventVersion": "2.1",
  "eventSource": "aws:s3",
  "awsRegion": "cn-northwest-1",
  "eventTime": "2020-02-23T06:54:43.275Z",
  "eventName": "ObjectCreated:Put",
  "userIdentity": {
    "principalId": "AWS:AROAV6RKRI6TEGNJUJUQD:fuguangping"
  },
  "requestParameters": {
    "sourceIPAddress": "111.194.86.126"
  },
  "responseElements": {
    "x-amz-request-id": "D640E2DBE1E1D1A1",
    "x-amz-id-2": "82UqZn/9xTMOGUwXNv/yiWgI4w9Hl8nLPwBz4WjHTzGWbamYafsxTGBcHtDwfrEM7MXZ/w+e6R0Sfk7/BABJsMmufIkKu79U"
  },
  "s3": {
    "s3SchemaVersion": "1.0",
    "configurationId": "a5b31053-e0f1-4175-88ac-8c98f7975d65",
    "bucket": {
      "name": "int32bit-test",
      "ownerIdentity": {
        "principalId": "409184847782"
      },
      "arn": "arn:aws-cn:s3:::int32bit-test"
    },
    "object": {
      "key": "repl.png",
      "size": 1143427,
      "eTag": "bb032f6285300f738d8c54a786e70114",
      "sequencer": "005E5221B6F630CEE5"
    }
  }
}
```

我们发现事件event中包含了如下信息:

* 事件名称eventName;
* 事件源eventSource;
* 事件发生时间eventTime；
* 事件触发者userIdentity以及源IP地址sourceIPAddress;
* 事件请求参数requestParameter;
* 事件响应中关联的资源对象信息，这里为bucket信息和object信息。

即清晰记录了什么人在什么地方以及在什么时候做了什么以及产生了什么。

### 2.4 Serverless能做什么

当然前面作为S3触发事件最简单的例子，我们并没有做什么。但只要我们实现Lambda函数，就可以实现无限可能的功能，比如:

* 上传图片时触发Lambda函数生成缩略图，用于做网站图片缓存。
* 上传视频时触发Lambda函数生成视频摘要信息，截取关键帧。
* 上传文件时触发lambda函数异步把文件同步到其他云平台上，比如AWS到阿里云，实现跨多云的容灾。
* ...

当然除了S3事件，Lambda还可以注册其他服务事件，比如:

* 创建虚拟机时触发Lambda函数检查参数是否合规；
* 创建安全组规则时触发Lambda函数检查是否开启高危端口；
* ...

### 2.6 Serverless总结

Serverless架构中主要由应用(代码)、运行环境(runtime)以及事件这三个重要因素构成，其中事件是Serverless的灵魂，打通了云平台服务的血脉，可以说Serverless的函数计算是云平台服务的黏合剂，把看起来不相关的服务很好的串起来，实现服务扩展。

当然除了前面介绍的AWS Lambda函数计算，还有很多的Serverless函数计算平台：

* 公有云：除了AWS，大多数公有云目前都支持函数计算服务，比如阿里云、华为云、腾讯云等。
* OpenStack：[Qinling项目](https://docs.openstack.org/qinling/latest/)是OpenStack平台的函数计算服务，它构建在Kubernetes/Swarm平台之上，通过容器提供运行环境，支持自动弹性伸缩，能够通过事件集成OpenStack其他服务或者通过Web或者移动APP直接调用。
* [Kubeless](https://kubeless.io/)：Kubernetes原生Serverless计算框架，实现在Kubernetes上构建基于FaaS的应用。

![kubeless](/img/posts/Serverless函数计算简介以及典型场景实践/kubeless.png)

## 3 基于Serverless实现云资源合规基线检查与配置

这个在之前的文章[云资源安全合规基线自动化检查与配置](https://int32bit.me/2020/01/14/%E4%BA%91%E8%B5%84%E6%BA%90%E5%AE%89%E5%85%A8%E5%90%88%E8%A7%84%E5%9F%BA%E7%BA%BF%E8%87%AA%E5%8A%A8%E5%8C%96%E6%A3%80%E6%9F%A5%E4%B8%8E%E9%85%8D%E7%BD%AE/)已经简单介绍过通过Lambda函数计算实现云资源的合规基线检查和配置。

其基本流程如下：

1. 用户通过console或者命令行创建云资源，比如虚拟机；
2. cloudtrail会对所有的API调用进行审计(auditing)；
3. cloudwatch会监控cloudtrail事件；
4. cloudwatch过滤事件类型，并调用Lambda函数；
5. Lambda函数执行，对资源进行合规性检查。

![aws_rules_base_check_workflow](/img/posts/Serverless函数计算简介以及典型场景实践/aws_rules_base_check_workflow.png)

当然如果我们针对每一个基线都需要自己写Lambda函数代码，则工作量还是挺大的，我们可借助一些规则引擎工具如CapitalOne开源的cloud custodian（简称c7n）自动生成Lambda函数代码。

以一个AWS上常见的问题为例，我们知道AWS的EC2、EBS等资源是不记录创建用户的，如果一个账户有多个用户，在EC2列表中根本查不到这个虚拟机到底是谁创建的，只能通过Cloudtrail在海量日志中慢慢去找了。

如果不使用Serverless，可以在AWS上启动一个EC2虚拟机，这个EC2虚拟机Attach读取Cloudtrail的权限，然后轮询这些事件，查询Runinstances事件，找到event是谁触发的，从而打上User标签。

而使用Serverless函数计算则可通过Cloudwatch监听Cloudtrail的RunInstances事件并触发Lambda函数调用，这个Lambda函数负责把event取出来，根据event的记录的用户名把标签CreatorName打到EC2实例上即可，这样的好处在于：

* 节省资源。前者即使没有创建虚拟机的事件虚拟机也要一直空转运行，而后者是事件触发的，没有事件则不会消耗计算资源。
* 节省开发工作量。托管的Cloudwatch目前已经支持事件过滤和触发Lambda，不需要再实现怎么从海量事件列表中过滤需要的事件。

cloud custodian规则如下：

```yaml
policies:
- name: ec2-auto-tag-user
  resource: ec2
  mode:
    type: cloudtrail
    role: arn:aws-cn:iam::***:role/***
    events:
    - RunInstances
  actions:
  - type: auto-tag-user
    tag: CreatorName
    principal_id_tag: CreatorId
```

如上规则代码会自动生成Lambda函数代码：

![c7n_lambda](/img/posts/Serverless函数计算简介以及典型场景实践/c7n_lambda.png)

触发器为CloudWatch Events，可以查看其配置如下:

![c7n_cloudwatch](/img/posts/Serverless函数计算简介以及典型场景实践/c7n_cloudwatch.png)

可见，利用Serverless函数计算和event实现Lambda、Cloudtrail、Cloudwatch的联动，共同完成了给虚拟机自动打上User标签的任务。

目前我们已经基于custodian实现了几十条基线规则，包括自动关联堡垒机安全组、检查安全组规则是否开放存在高危端口、根据VPC给资源打上PROD或者TEST环境标签等。

另外需要注意的是AWS的事件通常会有数分钟的延迟，因此Lambda函数触发也通常会有几分钟的实验。

## 4 基于Serverless架构的Web应用

### 4.1 传统Web应用部署架构

我们知道传统的Web应用部署过程通常包括如下步骤：

* 预估需要的资源量，需要多少CPU、多少内存、多少存储；
* 根据资源量采购服务器或者启动虚拟机；
* 在服务器或者虚拟机上安装操作系统、运行环境（如java、php、python)以及依赖组件（如数据库、缓存、消息队列等)；
* 安装Web容器，比如Nginx、Tomcat、Apache Httpd等；
* 代码打包部署，放到Web容器中运行；
* 配置负载均衡，如F5、Nginx、Haproxy等，实现高可用以及更高的处理请求能力。

这种方式的问题如下：

* 应用发布周期长，从资源准备到应用发布，需要一系列的工作。
* 不易于扩展，当请求过大时，需要重新准备新的服务器部署运行环境，配置负载均衡。
* 资源浪费，当没有请求时资源闲置。

目前基于Kubernetes平台服务发布则相对来说要敏捷得多，应用部署流程如下：

* 代码提交后由CI/CD工具自动化打包编译，生成容器镜像；
* 通过Deployment声明应用部署，根据声明创建Web中间件、数据库、PV存储卷等容器实例；
* 通过Service声明应用发布模式，实现四层负载。
* 通过Ingress实现七层负载；

只要Kubernetes部署好，应用基本实现了和底层资源的隔离，比如我们通过Ingress实现七层负载均衡，但这个负载均衡到底是基于Ngnix实现的还是F5实现，其实用户并不需要关心。

这种方式相对最传统的部署架构，具有如下优点：

* 传统方式需要准备应用所需要的所有运行环境以及依赖库，如果与其他应用部署在一起，还需要解决依赖冲突的问题。而后者应用运行环境与底层OS隔离，因为应用运行的环境以及依赖的库都已经打包到容器镜像中了，与OS是完全隔离的。
* 资源利用率高，因为相对传统部署架构，部署密度大幅度提高了，大大减少了资源闲置时间和资源碎片。
* 弹性扩展能力更强，增加或者减少一个Pod非常容易；
* ...

但是这种方式，仍然还是和平台耦合在一起的，虽然通过Horizontal Pod Autoscaler以及Cluster Autoscaler实现了Pod以及集群规模的自动水平扩展能力，依然无法在具体请求数量层面上进行自由缩放，继续引用AWS云架构战略副总裁Adrian Cockcroft的话：“如果你的PaaS能够有效地在20毫秒内启动实例并运行半秒,那么就可以称之为Serverless”。

### 4.2 Serverless架构

我们知道一个Web应用包括静态页面和动态代码构成，静态内容是不变的，比如HTML、JS、CSS、图片、视频等，而业务逻辑通过动态代码在后台读取数据库并渲染为静态页面呈现给用户，是业务系统的核心。

在目前流行的MVC架构以及微服务模式下，通常前端和后端是分离的，后端处理业务逻辑并暴露Restful API，而前端则通过Ajax异步调用后端的API请求数据并渲染成表格、列表等进行数据展示。

这种应用架构很容易进行Serverless改造：

* 静态页面直接放到对象存储中，前面再加上CDN做内容分发加速访问；
* 数据存储在托管的数据库中；
* 后端业务逻辑处理部分通过Serverless函数计算实现；
* 后端API通过api gateway发布；

以AWS为例：

![serverless_web_arch](/img/posts/Serverless函数计算简介以及典型场景实践/serverless_web_arch.png)

其处理流程如下：

1. 用户通过浏览器访问Cloudfront或者S3上的静态页面；
2. 静态页面中包含JS代码，JS代码通过Ajax向api gateway请求数据；
3. api gateway会通过请求路径以及请求方法找到注册的Lambda处理函数；
4. Lambda函数解析用户的请求参数，从数据库中读取数据，并返回JSON格式；
5. 数据通过api-gateway返回给用户浏览器，浏览器拿到数据通过JS渲染数据。

### 4.3 一个简单的例子

这个例子参考了[Building a Serverless Web App on AWS Services](https://www.pluralsight.com/guides/building-a-serverless-web-app-on-aws-services)，这个是个非常简单的web课程培训管理页面，用户可以通过该应用查看课程培训列表以及增加、删除、更新这些课程。

应用包含两个实体：

* Course: 课程实体，包含课程名称(title)、培训时长(length)、课程分类(catalog)以及培训讲师(author)。
* Author: 培训讲师实体，包括ID、firstname、lastname。

这些数据存储在AWS DynamoDB上，对应两个表：

![aws_dynamoDB](/img/posts/Serverless函数计算简介以及典型场景实践/aws_dynamoDB.png)

Lambda函数实现对Course的CURD操作以及Author读取:

![aws_lambda_courses](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_courses.png)

在api-gateway服务创建对应的Resource，注册请求方法以及对应的Lambda函数:

![aws_api_gateway_methods](/img/posts/Serverless函数计算简介以及典型场景实践/aws_api_gateway_methods.png)

注册的方法如下:

* `GET /authors`: 调用Lambda `get_authors`方法获取所有的培训讲师列表;
* `GET /courses`: 调用Lambda `get_courses`方法获取所有的课程列表;
* `POST /courses`: 调用Lambda `save_course`方法新增培训课程;
* `GET /courses/{id}`: 调用Lambda `get_course`方法获取ID为{id}的课程信息;
* `PUT /courses/{id}`: 调用Lambda `update_course`方法更新ID为{id}的课程信息;
* `DELETE /courses/{id}`: 调用Lambda `delete_course`方法删除ID为{id}的课程。

其中`POST /courses`的执行过程如下:

![lambda_api_gateway_method_detail](/img/posts/Serverless函数计算简介以及典型场景实践/lambda_api_gateway_method_detail.png)

S3上存储静态页面:

![aws_s3_static_web](/img/posts/Serverless函数计算简介以及典型场景实践/aws_s3_static_web.png)

静态页面的JS封装了对api-gateway的调用，由于该应用通过nodejs编译后代码不可读，因此展示编译前的代码样例如下:

![course_api](/img/posts/Serverless函数计算简介以及典型场景实践/course_api.png)

其中`SERVER_URL`就是api-gateway暴露的endpoint地址。

部署完成后就可以通过浏览器访问应用了:

![course_demo](/img/posts/Serverless函数计算简介以及典型场景实践/course_demo.png)

### 4.4 基于Serverless架构的Web应用的优势

相对传统的Web应用部署方式，基于Serverless架构的Web应用部署过程中我们发现不需要配置CPU和内存资源，也不需要指定运行的平台环境，甚至也不需要配置负载均衡，只要提交打包代码就能运行，按照请求方法选择调用的Lambda函数，没有请求则不需要调用任何函数，提供满足实时需求的最大限度计算能力即可，使我们更有效地利用计算资源，不存在资源浪费的问题。

对于用户来说，不需要维护运行环境，不需要维护集群，不需要维护负载均衡，降低了运营成本。

## 5 基于Serverless实现Webhook

前面介绍了基于Serverless架构实现的Web应用，当然我们也很容易通过api-gateway以及函数计算实现Webhook功能。

比如配置github webhook，一旦有代码更新便通过Serverless触发CI/CD。

我们忽略CI/CD的复杂流程，以一个最简单的基于webhook实现自动部署的例子作为Demo，假设有一个静态网站托管在AWS S3上，源代码托管在github，通过Webhook实现一旦代码更新便通知Serverless自动拉取最新代码同步到S3上，从而维持我们网站是最新版本。

![github_webhook](/img/posts/Serverless函数计算简介以及典型场景实践/github_webhook.png)

首先我们在github上创建一个test-web仓库:

![](/img/posts/Serverless函数计算简介以及典型场景实践/github_test_web.png)

index.html代码为:

```html
<html>
    <body>
        <h1 style='color:green'>
            HelloWorld!
        </h1>
    </body>
</html>
```

即显示一行绿色的`HelloWorld!`。

然后我们实现一个Lambda函数clone代码到本地并上传到S3桶中:

```python
import glob
import os
import boto3

GIT_REPO="https://github.com/int32bit/test-web.git"

def lambda_handler(event, context):
    os.system("rm -rf /tmp/test-web")
    os.system("git clone %s /tmp/test-web" % GIT_REPO)
    s3 = boto3.client('s3')
    for f in glob.glob('/tmp/test-web/*.html'):
        try:
            response = s3.upload_file(f, "int32bit-test-web", 
                                      os.path.basename(f),
                                      ExtraArgs={'ContentType': 'text/html'})
        except Exception as e:
            return {"Status": "Fail to upload '%s'" % f,
                    "Reason": str(e)}
    return {"Status": "OK"}
```

这里需要注意的Lambda运行环境中并不包含git工具，好在已经有人实现基于Lambda Layer封装了git工具[lambci/git-lambda-layer](https://github.com/lambci/git-lambda-layer)，我们可以直接引用这个Layer，不过由于国内Region无法引用国外AWS Region的资源，因此需要手动创建并上传Layer。

![](/img/posts/Serverless函数计算简介以及典型场景实践/aws_lambda_layer.png)

接着我们通过api-gateway实现Webhook，由于Webhook是通过POST方法请求，因此我们只需要实现POST方法，该方法调用test_webhook函数：

![](/img/posts/Serverless函数计算简介以及典型场景实践/aws_webhook.png)

最后再github上配置webhook，其中`Payload URL`填写api-gateway的endpoint。

![](/img/posts/Serverless函数计算简介以及典型场景实践/github_add_webhook.png)

此时我们只要更新int32ibt/test-web仓库的代码就会自动触发Lambda函数，更新代码到S3桶中。

```bash
sed  -i  's/green/red/g' index.html
git add index.html
git commit -m "Change font color to red"
git push
```

如上我们把字体颜色从green改成red并push代码到github仓库中，我们可以在github webhook记录中查看执行情况:

![](/img/posts/Serverless函数计算简介以及典型场景实践/github_webhook_status.png)

可见webhook调用成功，我们再次访问网站：

![](/img/posts/Serverless函数计算简介以及典型场景实践/web_demo.png)

可见网站HelloWorld字体更新为红色了。

需要注意的是，github webhook超时时间为10秒，这个无法配置。而github访问国内的AWS有时会很慢导致webhook触发超时。

## 5 总结

本文首先简单介绍了Serverless函数计算的特点，然后介绍了Serverless架构中的应用(代码)、运行环境(runtime)以及事件这三个重要因素以及Serverless如何打通云平台服务的系统血脉，最后介绍了基于Serverless实现的三个典型应用场景。

当然除了前面介绍的三个典型场景，还有很多其他适合Serverless架构的场景，比如：

* 物联网以及边缘计算；
* 微信公众平台；
* 微信小程序；
* ...

更多的案例以及开发指南可以参考[Serverless 应用开发指南](http://serverless.ink/)。

当前大多数公有云上的Serverless函数计算还不支持GPU，不过随着AI的流行，估计很快就能增加这个功能，目前开源项目[nuclio: High-Performance Serverless event and data processing platform](https://nuclio.io/)就实现了支持GPU的Serverless计算。

![nuclio_architecture](/img/posts/Serverless函数计算简介以及典型场景实践/nuclio_architecture.png)

nuclio支持在Kubernetes平台上快速部署，参考[Getting Started with Nuclio on Kubernetes](https://github.com/nuclio/nuclio/blob/master/docs/setup/k8s/getting-started-k8s.md)。
