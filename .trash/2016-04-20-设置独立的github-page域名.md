---
layout: post
title: 设置独立的github page域名
catalog: true
tags: [Linux]
---

## 1.申请域名

想好自己的域名后向提供商购买域名，国外比较著名的比如[godaddy](http://godaddy.com)以及[iwantmyname](https://iwantmyname.com)，国内的[万网](https://wanwang.aliyun.com/)和[新网](http://www.xinnet.com/)，我选择了国内的万网，因为比较了下，比较便宜！另外一直想申请`xxx.sh`的域名，可是好像只有iwantmname.com提供，并且非常贵！

## 2.设置仓库CNAME

在github page博客的仓库根目录创建`CNAME`文件，文件内容写入申请的域名，比如我的域名：

```
int32bit.me
```

## 3.设置域名解析

根据域名的类型，设置方法不同：

* 顶级域名：比如int32bit.me
* www二级域名：比如www.int32bit.me
* 自定义二级域名：比如abc.int32bit.me

以上三种具体设置方法，可参考[官方文档](https://help.github.com/articles/quick-start-setting-up-a-custom-domain/)。本文只详细介绍第一种，即顶级域名设置。

进入万网域名解析，界面如图：

![万网域名解析](/img/posts/github-page主页设置自己的域名/wanwang.png)

图中我已经设置好，简单介绍下如何操作，点击添加解析按钮：

**注意：如果配置顶级域名，比如`int32bit.me`,记录类型必须选择`ALIAS`、 `ANAME`、`A记录`三者其中一个**，官方推荐选择`ALIAS`或者`ANAME`,因为这容易配置且更新快，而A记录指向的IP变化时，需要较长的时间更新。由于万网不支持前二者，因此我们使用`A记录`类型，创建两条解析，分别指向以下两个IP，主机记录选择`@`，表示顶级域名：

```
192.30.252.153
192.30.252.154
```

添加完成后，可能需要一段时间更新，可以使用`dig`命令验证：

```
fgp@int32bit:~$ dig int32bit.me +nostats +nocomments +nocmd

; <<>> DiG 9.9.5-3ubuntu0.8-Ubuntu <<>> int32bit.me +nostats +nocomments +nocmd
;; global options: +cmd
;int32bit.me.                   IN      A
int32bit.me.            1       IN      A       192.30.252.154
int32bit.me.            1       IN      A       192.30.252.153
```

以上表示解析成功！

## 参考

* Github官方文档：https://help.github.com/articles/setting-up-an-apex-domain/
* https://en.wikipedia.org/wiki/CNAME_record
* https://en.wikipedia.org/wiki/List_of_DNS_record_types
