---
layout: post
title: OpenStack断点调试方法
catalog: true
tag: [OpenStack, Python]
header-img: "img/posts/OpenStack断点调试方法/bg.jpg"
---

## 1 关于断点调试

断点是调试应用程序最主要的方式之一，通过设置断点，可以实现单步执行代码，检查变量的值以及跟踪调用栈，甚至修改进程的内存变量值或者运行代码，从而观察修改后的程序行为。

大多数的调试器都是通过`ptrace`系统调用控制和监视进程状态，通过`INT 3`软件中断实现断点。当我们在代码中插入一个断点时，其实就是调试器找到指令位置（编译成机器码后的位置）嵌入一个`INT 3`指令，进程运行时遇到`INT 3`指令时，操作系统就会将该进程暂停，并发送一个`SIGTRAP`信号，此时调试器接收到进程的停止信号，通过`ptrace`查看进程状态，并通过标准输入输出与用户交互，更多关于断点和调试信息实现原理可以参考国外的一篇文章[How debuggers work](https://eli.thegreenplace.net/tag/debuggers)，这里只需要注意调试器是通过标准输入输出(stdin、stdout)与用户交互的。

目前主流的调试工具如C语言的gdb、java语言的jdb以及Python语言的pdb等。本文接下来主要介绍的是针对OpenStack的一些调试方法，这些方法不仅仅适用于OpenStack，其他Python程序其实同样适用。

## 2 Python调试工具介绍

Python主要使用pdb工具进行调试，用法也很简单，只要在需要打断点的位置嵌入`pdb.set_trace()`代码即可。

比如如下Python代码：

```python
class User(object):

    def __init__(self, name):
        self.name = name

    def whoami(self):
        return self.name

    def say(self, msg):
        import pdb; pdb.set_trace()
        print("%s: %s" % (self.whoami(), msg))


if __name__ == "__main__":
    User("Jim").say("What's your name ?")
    User("Mary").say("I'm Mary !")
```

该代码相当于在`say()`函数第一行嵌入了一个断点，当代码执行到该函数时，会立即停止，此时可以通过pdb执行各种指令，比如查看代码、查看变量值以及调用栈等，如下：

```python
> test_pdb.py(11)say()
-> print("%s: %s" % (self.whoami(), msg))
(Pdb) l
  6         def whoami(self):
  7             return self.name
  8
  9         def say(self, msg):
 10             import pdb; pdb.set_trace()
 11  ->         print("%s: %s" % (self.whoami(), msg))
 12
 13
 14     if __name__ == "__main__":
 15         User("Jim").say("What's your name ?")
 16         User("Mary").say("I'm Mary !")
(Pdb) p self.name
'Jim'
(Pdb) p msg
"What's your name ?"
(Pdb) bt
  test_pdb.py(15)<module>()
-> User("Jim").say("What's your name ?")
> /Users/fuguangping/test_pdb.py(11)say()
-> print("%s: %s" % (self.whoami(), msg))
```

当然你也可以使用ipdb替换pdb，界面更友好，支持语法高亮以及命令自动补全，使用体验类似于ipython,如图2-1：

![ipdb](/img/posts/OpenStack断点调试方法/ipdb.png)

<center>图 2-1 ipdb界面</center>

或者也可以使用更强大的ptpdb工具，支持多屏以及更强大的命令补全，如图2-2：

![ptpdb](/img/posts/OpenStack断点调试方法/ptpdb.png)

<center>图 2-2 ptpdb界面</center>

最上面为pdb指令输入框，左下为代码执行位置，右下为当前调用栈。

以上三个工具的pdb指令都是一样的，基本都是pdb工具的包装，详细的使用方法可以查看[官方文档](https://docs.python.org/2.7/library/pdb.html)或者Google相关资料，这里不对pdb命令进行过多介绍。

## 3 OpenStack常规调试方法

OpenStack断点调试是学习OpenStack工作流程的最佳方式之一，关于OpenStack源码结构可以参考我之前的一篇文章[《如何阅读OpenStack源码》](https://zhuanlan.zhihu.com/p/28959724)。我们知道OpenStack是基于Python语言开发的，因此自然可以使用如上介绍的pdb工具进行断点调试。

比如，我想了解OpenStack Nova是如何调用Libvirt Driver创建虚拟机的，只需要在`nova/virt/libvirt/driver.py`模块的`spawn()`方法打上断点：

![nova libvirt pdb](/img/posts/OpenStack断点调试方法/nova_libvirt_pdb.png)

然后停止nova-compute服务，使用命令行手动运行nova-compute:

```bash
systemctl stop openstack-nova-compute
su -c 'nova-compute' nova
```

在另外一个终端使用`nova boot`命令启动虚拟机，如果有多个计算节点，为了保证能够调度到打了断点的节点，建议把其他计算节点`disable`掉。

此时nova-compute会在`spawn()`方法处停止运行，此时可以通过pdb工具查看变量、单步执行等。如图3-1：

对于一些支持多线程多进程的OpenStack服务，为了方便调试，我一般会把`verbose`选项以及`debug`设置为`False`，避免打印太多的干扰信息，并把服务的`workers`数调成1，防止多个线程断点同时进入导致调试错乱。

比如调试`nova-api`服务，我会把`osapi_compute_workers`配置项临时设置为`1`。

通过如上调试方法，基本可以完成大多数的OpenStack服务调试，但并不能覆盖全部服务，某些OpenStack服务不能直接使用pdb进行调试，比如Keystone、Swift等某些组件，此部分内容将在下一节中进行详细介绍。

## 4 OpenStack不能直接使用pdb调试的情况

我们前面提到能够调试的前提是终端能够与进程的stdin、stdout直接交互，对于某些不能交互的情况，则必然不能直接通过pdb进行调试。主要包括如下几种情况：

### 4.1 进程关闭了stdin/stdout

cloud-init就是最经典的案例，在`cloudinit/cmd/main.py`的入口函数`main_init()`调用了`close_stdin()`方法关闭stdin，如下：

![close stdin](/img/posts/OpenStack断点调试方法/close_stdin.png)

`close_stdin()`方法实现如下：

```python
def close_stdin():
    if is_true(os.environ.get("_CLOUD_INIT_SAVE_STDIN")):
        return
    with open(os.devnull) as fp:
        os.dup2(fp.fileno(), sys.stdin.fileno())

```

相当于把`stdin`重定向到`/dev/null`了。因此当我们在cloud-init打上断点时，并不会弹出pdb调试页面，而是直接抛出异常。

比如制作镜像时经常出现cloud-init修改密码失败，于是需要断点调试，我们在`cloudinit/config/cc_set_passwords.py`模块的`handle()`方法打上断点，结果pdb直接异常退出，从`/var/log/cloud-init.log`中可以看到如下错误信息：

```python
2019-04-26 01:26:19,920 - util.py[DEBUG]: Running module 
set-passwords (<module 'cloudinit.config.cc_set_passwords' 
from 'cloudinit/config/cc_set_passwords.py'>) failed
Traceback (most recent call last):
  File "/usr/lib/python2.7/site-packages/cloudinit/stages.py", line 793, in _run_modules
    freq=freq)
  File "/usr/lib/python2.7/site-packages/cloudinit/cloud.py", line 54, in run
    return self._runners.run(name, functor, args, freq, clear_on_fail)
  File "/usr/lib/python2.7/site-packages/cloudinit/helpers.py", line 187, in run
    results = functor(*args)
  File "/usr/lib/python2.7/site-packages/cloudinit/config/cc_set_passwords.py", line 83, in handle
    if len(args) != 0:
  File "/usr/lib/python2.7/site-packages/cloudinit/config/cc_set_passwords.py", line 83, in handle
    if len(args) != 0:
  File "/usr/lib64/python2.7/bdb.py", line 49, in trace_dispatch
    return self.dispatch_line(frame)
  File "/usr/lib64/python2.7/bdb.py", line 68, in dispatch_line
    if self.quitting: raise BdbQuit
BdbQuit
```

我们从`close_stdin()`以及`redirect_output`方法可以发现，我们可以通过设置`_CLOUD_INIT_SAVE_STDIN`以及`_CLOUD_INIT_SAVE_STDOUT`环境变量开放stdin/stdout，从而允许我们进入调试:

```bash
export _CLOUD_INIT_SAVE_STDIN=1
export _CLOUD_INIT_SAVE_STDOUT=1
cloudinit init # 此时可以进入pdb
```

除了cloud-init，OpenStack Swift也类似，可以查看`swift/common/utils.py`模块的`capture_stdio()`方法，

```python
# collect stdio file desc not in use for logging
stdio_files = [sys.stdin, sys.stdout, sys.stderr]
console_fds = [h.stream.fileno() for _junk, h in getattr(
    get_logger, 'console_handler4logger', {}).items()]
stdio_files = [f for f in stdio_files if f.fileno() not in console_fds]

with open(os.devnull, 'r+b') as nullfile:
    # close stdio (excludes fds open for logging)
    for f in stdio_files:
        # some platforms throw an error when attempting an stdin flush
        try:
            f.flush()
        except IOError:
            pass

        try:
            os.dup2(nullfile.fileno(), f.fileno())
        except OSError:
            pass
```

因此`account-server`、`container-server`以及`object-server`均无法直接使用pdb调试。

### 4.2 Fork多进程

如果一个进程Fork了子进程，则子进程的stdin、stdout不能直接与终端交互。

最经典的场景就是OpenStack组件使用了`cotyledon`库而不是`oslo_service`库实现daemon。我们知道`oslo_service`使用`eventlet`库通过多线程实现并发，而`cotyledon`则使用了`multiprocess`库通过多进程实现并发，更多关于`cotyledon`的介绍可以参考[官方文档](https://cotyledon.readthedocs.io/en/latest/index.html)。

因此使用`cotyledon`实现的daemon服务不能通过pdb直接进行调试，比如Ceilometer的`polling-agent`以及Kuryr的`kuryr-daemon`服务等。

文章[使用pdb调试ceilometer代码](https://blog.csdn.net/mengalong/article/details/81125585)提出通过实现一个新的类`ForkedPdb`重定向`stdin`的方法实现子进程调试，这种方法我本人没有尝试过，不知道是否可行。

### 4.3 运行在Web服务器

最经典的如Keystone服务以及Horizon服务，我们通常会把该服务运行在Apache服务器上，显然这种情况终端没法直接和Keystone的stdin、stdout进行交互，因此不能通过pdb直接调试。

## 5 如何解决不能使用pdb调试的问题

我们前面总结了几种不能使用pdb直接调试的情况，其根本原因就是终端无法和进程的stdin/stdout交互，因此我们解决的思路就是让终端与进程的stdin/stdout打通。

我们知道stdin以及stdout都是文件流，有没有其他的流呢？显然socket也是一种流。因此我们可以通过把stdin、stdout重定向到一个socket流中，从而实现远程调试。

定义如下方法，把stdin、stdout重定向到本地的一个TCP socket中，监听地址端口为`1234`:

```python
import sys
import socket

def pre_pdb(addr='127.0.0.1', port=1234):
    old_stdout = sys.stdout
    old_stdin = sys.stdin
    handle_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    handle_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, True)
    handle_socket.bind((addr, port))
    handle_socket.listen(1)
    print("pdb is running on %s:%d" % (addr, port))
    (client, address) = handle_socket.accept()
    handle = client.makefile('rw')
    sys.stdout = sys.stdin = handle
    return handle
```

当然我们也需要把pdb的stdin、stdout也重定向到该socket中，这样才能与pdb交互，用法如下：

```python
import pdb
a = 1
b = 2
handle = pre_pdb() # 重定向stdin、stdout
pdb.Pdb(stdin=handle, stdout=handle).set_trace()
c = a + b
```

运行该程序后，使用另一个终端通过`nc`或者`telnet`连接`1234`端口即可进行调试，如图5-1：

![my rpdb](/img/posts/OpenStack断点调试方法/my_rpdb.png)

可见，通过这种方式可以实现远程调试，不过我们不用每次都写那么长一段代码，社区已经有实现了，只需要使用`rpdb`替换`pdb`即可进行远程调试，默认监听的端口为`4444`。

比如调试Keystone的`list_projects()`方法:

![list projects](/img/posts/OpenStack断点调试方法/list_projects.png)

然后重启`httpd`服务，重启完毕调用`project list` API:

```bash
systemctl restart httpd
openstack project list
```

如上`openstack project list`命令会hang住，此时通过`nc`或者`telnet`连接本地`4444`端口进行调试：

![](/img/posts/OpenStack断点调试方法/keystone_pdb.jpg)

可见成功attach了pdb，此时可以像普通pdb一样进行单步调试了。
