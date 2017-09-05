---
layout: post
title: OpenStack工作流服务Mistral项目简介
catalog: true
tags: [OpenStack]
---

## 1 Mistral背景

Mistral是一个OpenStack生态圈中比较新的项目，该项目的目标是：

>The project is to provide capability to define, execute and manage tasks and workflows without writing code.

截至到目前开发还不到2年，最初是由Mirantis公司贡献给Openstack社区的工作流组件，提供Workflow As a Service服务，类似AWS的SWS(Simple Workflow Serivce)，Hadoop生态圈中的oozie服务。它虽然没有Nova、Cinder等核心组件那么流行，部署率也不是很高，社区Pike版本的统计还没有出来，Ocata统计中Mistral的成熟度为1/7，部署率为5%，参考[OpenStack Mistral](https://www.openstack.org/software/releases/ocata/components/mistral)，但还是得到很多开发者和用户关注，项目活跃度还是比较高的。

注意它和OpenStack资源编排服务Heat不同，二者功能可能会有重叠，但Heat注重基础资源的编排，而Mistral则主要是用于任务编排。Heat的主要应用场景是创建租户基础资源模板，管理员可以创建一个资源模板，基于这个模板用户一次请求就可以完成虚拟机创建及配置、挂载数据卷、创建网络和路由、设置安全组等。而Mistral的典型应用场景包括执行计划任务Cloud Cron，调度任务Task Scheduling，执行复杂的运行时间长的业务流程等。我们目前使用的场景是基于Cloud Cron创建定时任务，比如定时创建虚拟机快照、定时创建数据库备份等。

## 2 Mistral的几个概念

要研究Mistral，首先需要了解Mistral包含哪些实体，了解这些实体的关系以及转化过程。其中我总结了几个核心实体关系图如下：

![Mistral ER](/img/posts/OpenStack工作流服务Mistral项目简介/Mistral-ER.png)

* action：action是最小执行单元，可以理解为一条命令或者一个OpenSack API请求。
* workflow：Mistral的核心，Mistral主要围绕着workflow工作的，其由DSL语言定义，由各种action以及执行逻辑组成。
* cron-trigger: 定时任务，通过crontab设定workflow执行周期。
* execution：workflow进入运行状态即为execution，它是runtime态的，因此有执行状态，如running、error、success等。
* task：一个execution由一个或者多个task构成，task也有运行时状态，如running、error、sucess等。
* action-execution：task由多个action-execution构成，action进入运行时状态即为action-execution。

如果说workflow等同于程序，则execution相当于一个进程，task则类似于线程，action为一个函数或者一个计算机指令。
 
另外一个比较特别的实体member，这个主要用于分享资源给其它租户，和Glance的member功能是一样的。

接下来我们对以上涉及的几个实体概念进行详细介绍。

### 2.1 action

action是Mistral中最小执行单元（执行指令），对应一个命令或者一次API请求。内置OpenStack相关的actions实际上封装了所有OpenStack组件的pythonclient接口，比如`nova.servers_start`对应python-novaclient项目的`novaclient/v2/servers.py`模块的`start()`方法。目前nova包含227个action，cinder包含128个action，glance包含20个action，几乎涵盖了所有虚拟机管理、volume管理等。以cinder backup为例，包含的actions列表如下:

```sh
int32bit $ mistral action-list | awk '/\scinder.backup/{print $4,$8}' | tr -d ',' | sed 's/ / -> /'
cinder.backups_create -> volume_id
cinder.backups_delete -> backup
cinder.backups_export_record -> backup_id
cinder.backups_find -> action_region=""
cinder.backups_findall -> action_region=""
cinder.backups_get -> backup_id
cinder.backups_import_record -> backup_service
cinder.backups_list -> detailed=true
cinder.backups_reset_state -> backup
```

其中前面的字段是action名字，后面的是参数。用户可以通过`action-get`子命令查看action更详细的信息：

```
mistral action-get cinder.backups_create
+-------------+--------------------------------------------------------------------------------------------------------------------------+
| Field       | Value                                                                                                                    |
+-------------+--------------------------------------------------------------------------------------------------------------------------+
| Name        | cinder.backups_create                                                                                                    |
| Is system   | True                                                                                                                     |
| Input       | volume_id, container=null, name=null, description=null, incremental=false, force=false, snapshot_id=null, backup_id=null |
| Description | Creates a volume backup.                                                                                                 |
|             |                                                                                                                          |
|             | :param volume_id: The ID of the volume to backup.                                                                        |
|             | :param container: The name of the backup service container.                                                              |
|             | :param name: The name of the backup.                                                                                     |
|             | :param description: The description of the backup.                                                                       |
|             | :param incremental: Incremental backup.                                                                                  |
|             | :param force: If True, allows an in-use volume to be backed up.                                                          |
|             | :rtype: :class:`VolumeBackup`                                                                                            |
| Tags        | <none>                                                                                                                   |
| Created at  | 2017-04-11 08:19:52                                                                                                      |
| Updated at  | None                                                                                                                     |
+-------------+--------------------------------------------------------------------------------------------------------------------------+
```

除了OpenStack相关的action以外，Mistral还包含如下内置actions：

```
std.async_noop
std.echo
std.email
std.fail
std.http
std.javascript
std.mistral_http
std.noop
std.ssh
std.ssh_proxied
std.wait_ssh
```

需要注意的是，Mistral目前尚不支持动态增删action，如果需要添加自定义action必须手写代码，修改`setup.cfg`配置文件并重新安装部署Mistral服务，参考官方文档[Creating custom action](https://docs.openstack.org/developer/mistral/developer/creating_custom_action.html)，本人写了一个脚本实现了自动发现和注册自定义action的功能，参考[mistral-actions](https://github.com/int32bit/mistral-actions)。不过Mistral支持创建Ad-hoc actions，即封装已有的action为新的action，类似于编程语言的继承关系或者模板。比如std.email需要传递很多参数，如果某些参数固定并且可以重复使用的话，我们可以创建一个action继承自std.email，创建一个新文件`error_email.yaml`内容如下：

```yaml
---
version: '2.0'
error_email:
  input:
    - execution_id
  base: std.email
  base-input:
    to_addrs: ['admin@mywebsite.org']
    subject: 'Something went wrong with your Mistral workflow :('
    body: |
        Please take a look at Mistral Dashboard to find out what's wrong
        with your workflow execution <% $.execution_id %>.
        Everything's going to be alright!
        -- Sincerely, Mistral Team.
    from_addr: 'mistral@openstack.org'
    smtp_server: 'smtp.google.com'
    smtp_password: 'SECRET'
```

**注意：**本文中action以及workflow定义均使用yaml格式，Mistral同样支持json格式，二者可以相互转化。

以上为`to_addrs`、`subject`、`body`等设置了默认参数值，我们基于该yaml文件创建新的action:

```bash
mistral action-create error_email.yaml
```

以后就可以复用这个action，只需要传递`execution_id`，而不需要重复`to_addrs`、`subject`等参数了:

```yaml
my_workflow:
  tasks:
    ...
    send_error_email:
      action: error_email execution_id=<% execution().id %>
```

### 2.2 task

task用来描述Workflow中包含的工作步骤，用来定义执行一个action之后，执行成功做什么，执行失败做什么等等，整个workflow就是由task构成的网络DAG图，具体使用方法查看workflow小节。

### 2.3 workflow

我们知道Mistral的目标就是提供workflow as service服务，因此workflow是Mistral的主体部分，一个workflow由至少一个task组成，task描述了具体的执行步骤和行为，workflow则描述了task之间的执行顺序、依赖关系、方式以及输入、输出等。

概念不多说，先上个官方例子（这个例子有问题，不能直接运行，仅作为demo使用）：

```yaml
---
version: '2.0'
 
create_vm:
  description: Simple workflow example
  type: direct
 
  input:
    - vm_name
    - image_ref
    - flavor_ref
  output:
    vm_id: <% $.vm_id %>
 
  tasks:
    create_server:
      action: nova.servers_create name=<% $.vm_name %> image=<% $.image_ref %> flavor=<% $.flavor_ref %>
      publish:
        vm_id: <% task(create_server).result.id %>
      on-success:
        - wait_for_instance
 
    wait_for_instance:
      action: nova.servers_find id=<% $.vm_id %> status='ACTIVE'
      retry:
        delay: 5
        count: 15
```
 
具体的含义先不用过多纠结。只需要知道上面的例子定义了一个名称为`create_vm`的workflow，输入包含了三个必要参数，分别为`vm_name`、`image_ref`、`flavor_ref`，输出虚拟机的id`vm_id`。整个workflow包含了两个task，第一个task是`create_server`，它调用OpenStack的`nova.servers_create`创建虚机，`on-success`指定task执行成功的操作，这里是执行`wait_for_instance`，如果第一个task执行失败则第二个task不会执行。通过`retry`设定轮询间隔和轮询次数，只有当新创建的虚拟机状态为`ACTIVE`才算整个workflow执行成功。

 
workflow包含以下两种类型：
 
* Direct Workflow
* Reverse Workflow


#### 2.3.1 direct workflow 

我们前面的例子就属于Direct Workflow，这种workflow可以简单理解为正向流程，即后一个task执行需要依赖前一个task执行结果，如图：

![direct workflow](/img/posts/OpenStack工作流服务Mistral项目简介/direct-workflow.png)

该类型的task主要通过以下三个指令控制下一个task的执行：

* on-success:此任务执行成功后需要执行的任务列表。
* on-error:此任务执行出错后需要执行的任务列表。
* on-complete:此任务执行结束后（不管成功还是失败）需要执行的任务列表

注意理解以上三个指令的语义，尤其是`on-error`指令，它类似于编程语言的异常，默认情况下如果没有on-error指令，则不会执行后面的task，并把当前workfow执行结果execution标识为`ERROR`。我们看一个例子:

```yaml
---
version: "2.0"
start_server:
  type: direct
  input:
    - server_id
  description: Start the specified server.
  tasks:
    start_server:
      description: Start the specified server.
      action: nova.servers_start server=<% $.server_id %>
      on-error:
        - noop
      on-complete:
        - wait_for_server_to_active
    wait_for_server_to_active:
      action: int32bit.nova.servers.assert_power_status server_id=<% $.server_id %> status='running'
      retry:
        delay: 5
        count: 5
      on-complete:
        - wait_for_all_tasks
    wait_for_all_tasks:
      join: all
      action: std.noop
      publish:
        error_task: <% tasks(execution().id, false, 'ERROR') %>
```

以上是一个很简单workfow用于实现虚拟机的关机，我们期望的结果是只需要保证虚拟机最终状态是`running`即可。我们看`start_server`这个task的`on-error`为`noop`，即什么都不要做，但这不是多余的，如果没有该指令，`start_server`执行失败(比如虚拟机本来就是`running`状态)，则会立即退出整个execution执行，并且execution状态为`ERROR`，这并不是我们期望的结果。

三个指令的关系可以用编程语言理解:

```python
try:
    do_action
    do_on_success
except:
    do_on_error
finally:
    do_complete
```

workflow也支持并行，即同时执行多个task，类似于一个进程同时跑多个线程，这种行为称为fork，使用`join`指令等待所有的task执行结束，比如:

```yaml
tasks:
  A:
    action: action.x
    on-success:
      C
  
  B:
    action: action.y
    on-success:
      C
  
  C:
    join: all
    action: action.z
    publish:
      ret
```

`join`后面的`all`表示等待所有task完成，你也可以设置为`1`或者`one`，这样只要其中任意一个task执行结束就好了，类型于Java并发编程的`invokeAll`和`invokeAny`的关系。

#### 2.3.2 Reverse Workflow

在这个类型的Wrokflow中，任务的关系是反向依赖的，即执行A，如果A中声明了依赖的任务B，则需要先执行B，如图：

![reverse workflow](/img/posts/OpenStack工作流服务Mistral项目简介/reverse-workflow.png)

其中一个task的依赖使用`requires`指令定义。比如：

```yaml
tasks:
   A:
     action: action.x
 
   B:
     action: action.y
 
   C:
     action: action.z
       requires: [A，B]
```

需要注意的是，reverse workflow不能使用`on-success`、`on-error`以及`on-complete`指令。

#### 2.4 DSL语言简介

我们前面定义ad-hoc actions以及workflow都使用的是yaml或者json，我们称为schema（模式)，schema不仅可以使用yaml、json定义，也可以使用xml等其它任何表示语言，它和数据库的schema是类似的，它包括两个方面约束：

* 包括哪些字段。
* 字段的值类型是什么。

对schema进行定义的一套规则语法，我们称为DSL(Domain Specific Language)，Mistral的DSL参考：[Mistral DSL v2](https://docs.openstack.org/developer/mistral/dsl/dsl_v2.html#introduction)。

Mistral的DSL schema语法校验是通过JSON Schema完成，下面是一个非常简单的例子:

```json
{
    "title": "Person",
    "type": "object",
    "properties": {
        "firstName": {
            "type": "string"
        },
        "lastName": {
            "type": "string"
        },
        "age": {
            "description": "Age in years",
            "type": "integer",
            "minimum": 0
        }
    },
    "required": ["firstName", "lastName"]
}
```

以上定义了一个Person schema，其中包括两个必需参数`firstName`和`lastName`以及一个可选参数`age`，前二者的类型为`string`，`age`的值类型为`integer`，并且最小值限制为0。更多关于json schema可参考[json schema官方文档](http://json-schema.org/)，作者还写了本非常不错的电子书[《Understanding JSON Schema》](https://spacetelescope.github.io/understanding-json-schema/index.html)。

Mistral解析json schema使用的python库是[jsonschema](https://github.com/Julian/jsonschema)，其使用方法也非常简单:

```python
>>> from jsonschema import validate
 
>>> # A sample schema, like what we'd get from json.load()
>>> schema = {
...     "type" : "object",
...     "properties" : {
...         "price" : {"type" : "number"},
...         "name" : {"type" : "string"},
...     },
... }
 
>>> # If no exception is raised by validate(), the instance is valid.
>>> validate({"name" : "Eggs", "price" : 34.99}, schema)
 
>>> validate(
...     {"name" : "Eggs", "price" : "Invalid"}, schema
... )                                   # doctest: +IGNORE_EXCEPTION_DETAIL
Traceback (most recent call last):
    ...
ValidationError: 'Invalid' is not of type 'number'
```

你也可以直接通过jsonschema CLI进行校验:

```sh
$ jsonschema -i sample.json sample.schema
```

## 3 Mistral实践

### 3.1 Mistral部署

Mistral相对其它OpenStack服务比较简单，也不需要像Trove那样调整网络。

Mistral主要包含以下三个服务：

* mistral-api
* mistral-engine
* mistral-executor

以上三个服务的功能不详细介绍，配置可参考官方文档[Mistral Configuration Guide](https://docs.openstack.org/mistral/latest/configuration/index.html)。这里需要指出的是，Mistral的所有服务都是支持水平扩展的，即可以同时运行多个服务实例。

另外，Mistral服务的心跳和状态监控和Nova、Cinder等不一样，Mistral不是通过不断刷数据库实现心跳的，而是通过tooz coordinator的member管理实现的，当进程启动时，会自动注册member，进程挂了或者退出时，会从member中移除，由此判断该服务是否运行。因此，如果需要使用服务状态功能，需要配置coordinator，coordinator的backend可以是zookeeper、redis、memcached等，这里以memcached为例，配置如下：

```ini
[coordination]
# From mistral.config
backend_url = memcached://localhost:11211
heartbeat_interval = 5.0
```

配置了coordinator后，就可以使用`mistral service-list`查看服务列表了：

```
$ mistral service-list
+----------------+----------------+
| Name           | Type           |
+----------------+----------------+
| controller_77391 | engine_group   |
| controller_80355 | api_group      |
| controller_77494 | executor_group |
+----------------+----------------+
```

以上controller是hostname，77391是服务的pid，type包含api、engine、executor三类。

原理也很简单，Mistral服务会每隔`heartbeat_interval`调用`heartbeat`方法发送心跳，如果backend是memcached，则会设置一个key-value，key为group id，value为"It's alive!"，ttl为30s，实现代码如下：

```python
@_translate_failures
   def heartbeat(self):
       self.client.set(self._encode_member_id(self._member_id),
                       self.STILL_ALIVE,
                       expire=self.membership_timeout)
       # Reset the acquired locks
       for lock in self._acquired_locks:
           lock.heartbeat()
       return min(self.membership_timeout,
                  self.leader_timeout,
                  self.lock_timeout)
```

可以查看memcached值:

```sh
$ telnet localhost 11211
Trying 127.0.0.1...
Connected to localhost.
Escape character is '^]'.
stats cachedump 2 0
ITEM _TOOZ_MEMBER_controller_77494 [11 b; 1502183642 s]
ITEM _TOOZ_MEMBER_controller_80355 [11 b; 1502183640 s]
ITEM _TOOZ_MEMBER_controller_77391 [11 b; 1502183640 s]
END
get _TOOZ_MEMBER_controller_77391
VALUE _TOOZ_MEMBER_controller_77391 1 11
It's alive!
END
```

### 3.2 开始使用Mistral

#### 3.2.1 创建workflow

以一个官方的简单workflow为例，yaml文件为`my_workflow.yaml`，

```yaml
---
version: "2.0"

my_workflow:
  type: direct

  input:
    - names

  tasks:
    task1:
      with-items: name in <% $.names %>
      action: std.echo output=<% $.name %>
      on-success: task2

    task2:
      action: std.echo output="Done"
```

注意以上`names`参数是一个数组，`with-times`也是workflow的一个指令，它会遍历数组的所有元素，action为`std.echo`，即打印`name`参数，执行成功后执行task2，输出`"Done"`。

使用`mistral workflow-create`子命令创建workflow:

```sh
$ mistral workflow-create my_workflow.yaml
+------------------------------------+-------------+--------+---------+---------------------+------------+
|ID                                  | Name        | Tags   | Input   | Created at          | Updated at |
+------------------------------------+-------------+--------+---------+---------------------+------------+
|9b719d62-2ced-47d3-b500-73261bb0b2ad| my_workflow | <none> | names   | 2017-04-13 08:44:49 | None       |
+------------------------------------+-------------+--------+---------+---------------------+------------+
```

#### 3.2.2 执行workflow

创建workflow相当于创建了一个任务模板，并没有实际执行，我们需要通过`execution-create`子命令触发执行，执行时需要传递参数，参数以json格式传递:

```sh
$ mistral execution-create my_workflow '{"names": ["John", "Mistral", "Ivan", "Crystal"]}'
+-------------------+--------------------------------------+
| Field             | Value                                |
+-------------------+--------------------------------------+
| ID                | 49213eb5-196c-421f-b436-775849b55040 |
| Workflow ID       | 9b719d62-2ced-47d3-b500-73261bb0b2ad |
| Workflow name     | my_workflow                          |
| Description       |                                      |
| Task Execution ID | <none>                               |
| State             | RUNNING                              |
| State info        | None                                 |
| Created at        | 2017-03-06 11:24:10                  |
| Updated at        | 2017-03-06 11:24:10                  |
+-------------------+--------------------------------------+
```

执行后，可以通过`execution-list`查看执行状态。

#### 3.2.3 查看task执行状态

除了使用`execution-list`查看整个workflow执行的结果，还可以通过`task-list`查看其所有的task执行状态:

```sh
$ mistral task-list 49213eb5-196c-421f-b436-775849b55040
+--------------------------------------+-------+---------------+--------------------------------------+---------+------------+---------------------+---------------------+
| ID                                   | Name  | Workflow name | Execution ID                         | State   | State info | Created at          | Updated at          |
+--------------------------------------+-------+---------------+--------------------------------------+---------+------------+---------------------+---------------------+
| f639e7a9-9609-468e-aa08-7650e1472efe | task1 | my_workflow   | 49213eb5-196c-421f-b436-775849b55040 | SUCCESS | None       | 2017-03-06 11:24:11 | 2017-03-06 11:24:17 |
| d565c5a0-f46f-4ebe-8655-9eb6796307a3 | task2 | my_workflow   | 49213eb5-196c-421f-b436-775849b55040 | SUCCESS | None       | 2017-03-06 11:24:17 | 2017-03-06 11:24:18 |
+--------------------------------------+-------+---------------+--------------------------------------+---------+------------+---------------------+---------------------+
```

通过`task-get-result`查看task的输出，即`std.echo`结果：

```
$ mistral task-get-result f639e7a9-9609-468e-aa08-7650e1472efe
[
    "John",
    "Mistral",
    "Ivan",
    "Crystal"
]
```

#### 3.2.4 查看action执行状态

以上通过task已经获取了执行结果，可以进一步获取每个action的执行情况：

```sh
$ mistral action-execution-list f639e7a9-9609-468e-aa08-7650e1472efe
+--------------------------------------+----------+---------------+-----------+--------------------------------------+---------+----------+---------------------+---------------------+
| ID                                   | Name     | Workflow name | Task name | Task ID                              | State   | Accepted | Created at          | Updated at          |
+--------------------------------------+----------+---------------+-----------+--------------------------------------+---------+----------+---------------------+---------------------+
| 4e0a60be-04df-42d7-aa59-5107e599d079 | std.echo | my_workflow   | task1     | f639e7a9-9609-468e-aa08-7650e1472efe | SUCCESS | True     | 2017-03-06 11:24:12 | 2017-03-06 11:24:16 |
| 5bd95da4-9b29-4a79-bcb1-298abd659bd6 | std.echo | my_workflow   | task1     | f639e7a9-9609-468e-aa08-7650e1472efe | SUCCESS | True     | 2017-03-06 11:24:12 | 2017-03-06 11:24:16 |
| 6ae6c19e-b51b-4910-9e0e-96c788093715 | std.echo | my_workflow   | task1     | f639e7a9-9609-468e-aa08-7650e1472efe | SUCCESS | True     | 2017-03-06 11:24:12 | 2017-03-06 11:24:16 |
| bed5a6a2-c1d8-460f-a2a5-b36f72f85e19 | std.echo | my_workflow   | task1     | f639e7a9-9609-468e-aa08-7650e1472efe | SUCCESS | True     | 2017-03-06 11:24:12 | 2017-03-06 11:24:17 |
+--------------------------------------+----------+---------------+-----------+--------------------------------------+---------+----------+---------------------+---------------------+
```
以上由于task1使用了with-items循环，因此会对应多个actions，你也可以获取其中一个action的结果:

```sh
$ mistral action-execution-get-output 4e0a60be-04df-42d7-aa59-5107e599d079
{
    "result": "John"
}
```

## 4 定时任务

### 4.1 cron介绍

cron是一个在类Unix操作系统上的任务计划程序。它可以让用户在指定时间段周期性地运行命令或者shell脚本，通常被用在系统的自动化维护或者管理。

crontab 的基本格式是：

```
 ┌───────────── minute (0 - 59)
 │ ┌───────────── hour (0 - 23)
 │ │ ┌───────────── day of month (1 - 31)
 │ │ │ ┌───────────── month (1 - 12)
 │ │ │ │ ┌───────────── day of week (0 - 6) (Sunday to Saturday;
 │ │ │ │ │                                       7 is also Sunday)
 │ │ │ │ │
 │ │ │ │ │
 * * * * *  command to execute
```

更详细的cron语法介绍可以参考[维基百科--Cron](https://en.wikipedia.org/wiki/Cron)。

Mistral使用了Python的crontiner库解析crontab，这个库封装得特别好，我们只需要会用两个方法即可，一个是构造方法`__init__`，另一个是获取下一次执行时间方法`get_next()`。构造方法签名如下:

```python
def __init__(self, cron_format, start_time=time.time(), day_or=True)
```

其中`cron_format`就是标准的cron格式，`start_time`是开始执行时间，默认从当前时间开始，`day_or`是处理`day`和`week`冲突情况下的处理办法，`day_or`默认为true，day和week满足其中一个条件就会执行，比如`* * 1 * 1`,则每个月的1号或者周一都会执行。

`get_next`方法签名如下：

```python
def get_next(self, ret_type=float)
```

其中`ret_type`指定返回类型，默认为浮点数，可以指定为datetime类型。

```python
>>> from croniter import croniter
>>> from datetime import datetime
>>> base = datetime(2010, 1, 25, 4, 46)
>>> iter = croniter('*/5 * * * *', base)  # every 5 minutes
>>> print iter.get_next(datetime)   # 2010-01-25 04:50:00
>>> print iter.get_next(datetime)   # 2010-01-25 04:55:00
>>> print iter.get_next(datetime)   # 2010-01-25 05:00:00
>>>
>>> iter = croniter('2 4 * * mon,fri', base)  # 04:02 on every Monday and Friday
>>> print iter.get_next(datetime)   # 2010-01-26 04:02:00
>>> print iter.get_next(datetime)   # 2010-01-30 04:02:00
>>> print iter.get_next(datetime)   # 2010-02-02 04:02:00
>>>
>>> iter = croniter('2 4 1 * wed', base)  # 04:02 on every Wednesday OR on 1st day of month
>>> print iter.get_next(datetime)   # 2010-01-27 04:02:00
>>> print iter.get_next(datetime)   # 2010-02-01 04:02:00
>>> print iter.get_next(datetime)   # 2010-02-03 04:02:00
>>>
>>> iter = croniter('2 4 1 * wed', base, day_or=False)  # 04:02 on every 1st day of the month if it is a Wednesday
>>> print iter.get_next(datetime)   # 2010-09-01 04:02:00
>>> print iter.get_next(datetime)   # 2010-12-01 04:02:00
>>> print iter.get_next(datetime)   # 2011-06-01 04:02:00
```

当然，还有一个`get_prev`方法，获取上一次执行的时间，用法和`get_next()`一样。

### 4.2 创建定时任务

Mistral支持cloud cron功能，即创建定时任务，其定义语法和linux crontab基本一致，前面已经介绍过。

mistral还支持定义开始执行时间、执行次数等：

```
int32bit $ mistral cron-trigger-create --pattern '* * * * *' --count 5 test-hello-world hello-world
+----------------------+--------------------------------------+
| Field                | Value                                |
+----------------------+--------------------------------------+
| ID                   | a3a0ed3f-a5ef-4416-af9f-33cef498bbb6 |
| Name                 | test-hello-world                     |
| Workflow             | hello-world                          |
| Params               | {}                                   |
| Pattern              | * * * * *                            |
| Next execution time  | 2017-08-28 02:36:00                  |
| Remaining executions | 1                                    |
| Status               | READY                                |
| Created at           | 2017-08-28 02:35:08                  |
| Updated at           | None                                 |
+----------------------+--------------------------------------+
```
以上任务会每分钟执行一次，执行5次后结束。

查看cron任务列表:

```
int32bit $ mistral cron-trigger-list
+--------------------------------------+------------------+-------------+--------+-------------+---------------------+----------------------+-----------+---------------------+---------------------+
| ID                                   | Name             | Workflow    | Params | Pattern     | Next execution time | Remaining executions | Status    | Created at          | Updated at          |
+--------------------------------------+------------------+-------------+--------+-------------+---------------------+----------------------+-----------+---------------------+---------------------+
| 88fd87ba-2429-4995-abba-54bfff91ba13 | int32bit-test-1  | hello-world | {}     | */1 * * * * | 2017-08-17 08:47:00 |                    0 | COMPLETED | 2017-08-17 08:41:49 | 2017-08-17 08:46:58 |
| a3a0ed3f-a5ef-4416-af9f-33cef498bbb6 | test-hello-world | hello-world | {}     | * * * * *   | 2017-08-28 02:36:00 |                    4 | READY     | 2017-08-28 02:35:08 | None                |
+--------------------------------------+------------------+-------------+--------+-------------+---------------------+----------------------+-----------+---------------------+---------------------+
```

通过`execution-list`查看执行结果，其中cron id为关联的cron任务:

```
int32bit $ mistral execution-list
+--------------------------------------+--------------------------------------+---------------+--------------------------------------+-------------------+---------+------------+---------------------+---------------------+
| ID                                   | Workflow ID                          | Workflow name | Cron ID                              | Task Execution ID | State   | State info | Created at          | Updated at          |
+--------------------------------------+--------------------------------------+---------------+--------------------------------------+-------------------+---------+------------+---------------------+---------------------+
| fe8d752e-8a96-45d3-a13c-0fdca58951cc | 86c581b9-e08d-46a0-ad0d-cf3f1d30bf4d | hello-world   | None                                 | <none>            | SUCCESS | None       | 2017-08-28 02:32:23 | 2017-08-28 02:32:24 |
| 039af1e2-177e-4905-9c29-ccfbcdfedbff | 86c581b9-e08d-46a0-ad0d-cf3f1d30bf4d | hello-world   | a3a0ed3f-a5ef-4416-af9f-33cef498bbb6 | <none>            | SUCCESS | None       | 2017-08-28 02:35:58 | 2017-08-28 02:35:59 |
+--------------------------------------+--------------------------------------+---------------+--------------------------------------+-------------------+---------+---------
```

注意:

* 社区版本定时任务没有State字段，执行完后会自动删除，因此不会记录已经完成的定时任务。
* 社区版本的execution没有cron id关联。

## 5 社区最新进展

OpenStack在8月30日发布了最新版本Pike，其中比较重要的几个新特性如下：

* action支持多region了，用户可以通过`action_region`参数指定region。
* workflow可以指定namespace，不同的namespace可以使用相同的名字。
* 支持使用` <% execution().created_at %>`获取workflow的执行时间。
* mistral-engine可以配置为`local`模式，action直接在本地执行而不需要通过RPC发给executor执行。

## 参考文档

* https://docs.openstack.org/developer/mistral/ 
* https://en.wikipedia.org/wiki/Cron
