---
layout: post
title: OpenStack数据库版本控制工具简介
subtitle: 介绍sqlalchemy migrate以及alemebic
catalog: true
tags: [OpenStack, Python]
---

## 写在前面的话

自今年3月份以来就没有写过博客了，主要是由于工作的原因，加上拖延症，中断了大约半年时间。今天重新捡起来,准备好好总结反省这5个月时间的所得多学，记录下来防止以后又忘了。

本文冠以OpenStack打头，但其实本文的内容主要还是介绍Python数据库的两大主流Migrate工具，而OpenStack只是拿来作为例子讲罢了，所以其实题目改成"Python数据库版本控制工具简介"或者“sqlalchemy migrate和alemebic对比”或许更恰当，想想还是以OpenStack打头吧，顺便蹭蹭OpenStack的热点 :)。

废话不多说，开始正文。

## 1 为何需要数据库版本控制

我们知道代码通常会使用诸如git、svn等版本控制工具管理起来，其好处众所周知，一个是代码多版本管理，另一个是多人协作开发。在项目的持续进展中，数据库的模式(Schema)通常也经常需要更新，比如增加一个表、增加一个列或者创建一个索引等。当新版本升级发布时，在部署阶段，我们需要一个工具能够记录数据库变更版本，能够随时checkout到指定的数据库版本，随时upgrade以及downgrade。另一个角度，我们连接数据库的driver通常称为引擎（engine），这些引擎是抽象接口，其驱动实现可以是mysql、sqlite等数据库，实际部署时通过配置的connection协议区分。换句话说，我们的工具应该不依赖于某个具体数据库，而应该是一个通用的工具，不管你使用的是哪个数据库。

在Python中，最有名的ORM框架可能就是SQLAlchemy了，它提供了SQL工具包及对象关系映射（ORM）工具，使用MIT许可证发行。OpenStack几乎所有的项目都使用了SQLAlchemy（Swift项目除外，因为它不需要外部数据库）。而支持SQLAlchemy数据库model变更的工具我们称为Migrate，所有的变更脚本都放到称为migrate repository目录中。目前主流的Migrate工具为SQLAlchemy Migrate以及Alembic，接下来我们将详细介绍这个两个工具库。

## 2 SQLAlchemy Migrate介绍

### 2.1 SQLAlchemy Migrate背景

SQLAlchemy Migrate最开始叫Migrate，它最初是从Evan Rosson参加的[Google’s Summer of Code](http://code.google.com/soc)项目中剥离出来。据作者所言Migrate主要是受Ruby on Rails’ migrations脚本启发。

不过由于作者没有时间维护，因此后来主要交由一些开源志愿者维护，目前托管在Google Code中，并命名为SQLAlchemy Migrate。

### 2.2 SQLAlchemy Migrate用法

SQLALchemy Migrate的CLI工具为`migrate`，其用法如下：

```
int32bit $ migrate -h
Usage: migrate COMMAND ...

    Available commands:
        compare_model_to_db          - compare MetaData against the current database state
        create                       - create an empty repository at the specified path
        create_model                 - dump the current database as a Python model to stdout
        db_version                   - show the current version of the repository under version control
        downgrade                    - downgrade a database to an earlier version
        drop_version_control         - removes version control from a database
        help                         - displays help on a given command
        make_update_script_for_model - create a script changing the old MetaData to the new (current) MetaData
        manage                       - creates a Python script that runs Migrate with a set of default values
        script                       - create an empty change Python script
        script_sql                   - create empty change SQL scripts for given database
        source                       - display the Python code for a particular version in this repository
        test                         - performs the upgrade and downgrade command on the given database
        update_db_from_model         - modify the database to match the structure of the current MetaData
        upgrade                      - upgrade a database to a later version
        version                      - display the latest version available in a repository
        version_control              - mark a database as under this repository's version control

    Enter "migrate help COMMAND" for information on a particular command.


Options:
  -h, --help            show this help message and exit
  -d, --debug           Shortcut to turn on DEBUG mode for logging
  -q, --disable_logging
                        Use this option to disable logging configuration
```

首先我们为我们的项目创建一个repo，命名为int32bit，路径为`/tmp/int32bit`:

```
$ migrate create /tmp/int32bit int32bit
```

此时会创建/tmp/int32bit目录，目录结构如下：

```
find int32bit/ | grep -v ".*\.pyc"
int32bit/
int32bit/README
int32bit/migrate.cfg
int32bit/__init__.py
int32bit/manage.py
int32bit/versions
int32bit/versions/__init__.py
```
创建repo后，需要指定数据库保存repo信息，我们以mysql数据库为例：

```
python manage.py version_control 'mysql://int32bit:int32bit@localhost/int32bit?charset=utf8' /tmp/int32bit
```

注意mysql连接的协议格式为`mysql://${username}:${password}@${host}/${database}?var1=xx`。

此时查看int32bit数据库：

```
MariaDB [int32bit]> show tables;
+--------------------+
| Tables_in_int32bit |
+--------------------+
| migrate_version    |
+--------------------+
1 row in set (0.00 sec)

MariaDB [int32bit]> select * from migrate_version;
+---------------+-----------------+---------+
| repository_id | repository_path | version |
+---------------+-----------------+---------+
| int32bit      | /tmp/int32bit   |       0 |
+---------------+-----------------+---------+
1 row in set (0.00 sec)
```

可见migrate创建了一个migrate_version表，记录着repo id、repo路径以及当前版本。

查看当前版本：

```
python /tmp/int32bit/manage.py db_version --url='mysql://int32bit:int32bit@localhost/int32bit?charset=utf8' /tmp/int32bit
```

每次都要输入数据库连接信息以及repo路径非常麻烦，我们可以写到初始化脚本中：

```
migrate manage manage.py --repository=/tmp/int32bit --url='mysql://int32bit:int32bit@localhost/int32bit?charset=utf8'
```

此时查看manager.py代码，已经把数据库信息和repo路径写到初始化参数中。

```python
#!/usr/bin/env python
from migrate.versioning.shell import main

if __name__ == '__main__':
    main(url='mysql://int32bit:int32bit@localhost/int32bit?charset=utf8', debug='False', repository='/tmp/int32bit')
```

**注意:**我们这里只是作为测试用途，实际生产环境不建议把数据库信息写到代码中。

此时只需要执行manage.py即可:

```
int32bit $ chmod +x manage.py
int32bit $ ./manage.py db_version
0
```

完成了migrate repo的初始化，接下来我们来看看它是如何管理数据库版本的。

刚刚我们运行`db_version`时输出当前版本为0，版本0就称为base，通常是个空数据库，没有任何表。现在假设我们要创建一个account表:

```sql
account = Table(
    'account', meta,
    Column('id', Integer, primary_key=True),
    Column('login', String(40)),
    Column('passwd', String(40)),
)
```

我们通过`script`创建一次变更记录并自动完成初始化:

```
./manage.py script "Add account table"
```
此时在`versions`目录会自动创建一个`001_Add_account_table.py`文件：

```
int32bit $ ls
001_Add_account_table.py  __init__.py  __init__.pyc
```

文件内容为:

```python
from sqlalchemy import *
from migrate import *


def upgrade(migrate_engine):
    # Upgrade operations go here. Don't create your own engine; bind
    # migrate_engine to your metadata
    pass


def downgrade(migrate_engine):
    # Operations to reverse the above upgrade go here.
    pass
```

由此可见，我们需要实现upgrade和downgrade方法，你可以直接使用vim编辑这个文件，内容如下:

```
from sqlalchemy import Table, Column, Integer, String, MetaData

meta = MetaData()

account = Table(
    'account', meta,
    Column('id', Integer, primary_key=True),
    Column('login', String(40)),
    Column('passwd', String(40)),
)


def upgrade(migrate_engine):
    meta.bind = migrate_engine
    account.create()


def downgrade(migrate_engine):
    meta.bind = migrate_engine
    account.drop()
```

**注意**

1. 自动生成的代码中会把`sqlalchemy`以及`migrate`包中所有的模块都导入(`import *`)，实际中不建议这么使用。
2. 通常会同时实现`upgrade`和`downgrade`方法，这样才能同时支持数据库的升级和降级，如果你不想支持降级，你只需要在`downgrade`中抛出`NotImplementedError`异常即可。实际上，目前OpenStack的大多数项目都已经不支持`downgrade`了。
3. sqlalchemy封装了大多数SQL DDL语言，比如`create table`、`alter table`、`drop`等，具体可参考[官方文档](http://sqlalchemy-migrate.readthedocs.io/en/latest/changeset.html#changeset-system)。

代码编辑完后我们test下是否有问题：

```
$ ./manage.py test
Upgrading...
done
Downgrading...
done
Success
```

**注意：`test`会真正执行变更脚本，切勿在生产环境下运行和实验。**

测试OK后，我们可以执行变更执行数据库0->1了:

```
int32bit $ ./manage.py upgrade
0 -> 1...
done
```

测试查看当前版本:

```
int32bit $ ./manage.py db_version
1
```

检查我们的accout表是否创建：

```
MariaDB [int32bit]> show tables;
+--------------------+
| Tables_in_int32bit |
+--------------------+
| account            |
| migrate_version    |
+--------------------+
2 rows in set (0.00 sec)

MariaDB [int32bit]> desc account;
+--------+-------------+------+-----+---------+----------------+
| Field  | Type        | Null | Key | Default | Extra          |
+--------+-------------+------+-----+---------+----------------+
| id     | int(11)     | NO   | PRI | NULL    | auto_increment |
| login  | varchar(40) | YES  |     | NULL    |                |
| passwd | varchar(40) | YES  |     | NULL    |                |
+--------+-------------+------+-----+---------+----------------+
3 rows in set (0.00 sec)

MariaDB [int32bit]>
```

从结果看，`account`表已经创建好了。

现在我们在`account`表中增加一个`email`列:

```
./manage.py script "Add email column"
```

编辑`versions/002_Add_email_column.py`:

```python
from sqlalchemy import Table, MetaData, String, Column


def upgrade(migrate_engine):
    meta = MetaData(bind=migrate_engine)
    account = Table('account', meta, autoload=True)
    emailc = Column('email', String(128))
    emailc.create(account)


def downgrade(migrate_engine):
    meta = MetaData(bind=migrate_engine)
    account = Table('account', meta, autoload=True)
    account.c.email.drop()
```

执行变更升级到版本2:

```
int32bit $ ./manage.py upgrade
1 -> 2...
done
int32bit $ ./manage.py db_version
2
```

此时查看`account`表：

```
MariaDB [int32bit]> desc account;
+--------+--------------+------+-----+---------+----------------+
| Field  | Type         | Null | Key | Default | Extra          |
+--------+--------------+------+-----+---------+----------------+
| id     | int(11)      | NO   | PRI | NULL    | auto_increment |
| login  | varchar(40)  | YES  |     | NULL    |                |
| passwd | varchar(40)  | YES  |     | NULL    |                |
| email  | varchar(128) | YES  |     | NULL    |                |
+--------+--------------+------+-----+---------+----------------+
4 rows in set (0.00 sec)
```

`email`列已经增加到`account`表中。

假设我们项目升级失败了，需要回滚到版本1，数据库当然也需要回滚，执行以下命令降级数据库版本到1:

```
int32bit $ ./manage.py  downgrade 1
2 -> 1...
done
int32bit $ ./manage.py db_version
1
```

查看`account`表：

```
MariaDB [int32bit]> desc account;
+--------+-------------+------+-----+---------+----------------+
| Field  | Type        | Null | Key | Default | Extra          |
+--------+-------------+------+-----+---------+----------------+
| id     | int(11)     | NO   | PRI | NULL    | auto_increment |
| login  | varchar(40) | YES  |     | NULL    |                |
| passwd | varchar(40) | YES  |     | NULL    |                |
+--------+-------------+------+-----+---------+----------------+
3 rows in set (0.00 sec)
```

`email`列已经移除了，恢复到版本1。

以上我们参考官方文档[1]简单介绍了SQLAlchemy Migrate的用法，总体上看，使用还是比较简单的，OpenStack的Nova和Cinder项目都使用了该方案，nova的repo路径为`nova/db/sqlalchemy/migrate_repo`，使用了`nova-manager`命令对`migrate`工具进行封装。

我们查看最近的10次数据库变更:

```
$ ls /usr/lib/python2.7/site-packages/nova/db/sqlalchemy/migrate_repo/versions/  | sort | grep -v '__init__' | grep -v '.*\.py[co]' | tail -n 10
310_placeholder.py
311_placeholder.py
312_placeholder.py
313_add_parent_id_column.py
314_add_resource_provider_tables.py
315_add_migration_progresss_detail.py
316_add_disk_ratio_for_compute_nodes.py
317_add_aggregate_uuid.py
318_resource_provider_name_aggregates.py
319_add_instances_deleted_created_at_index.py
```

你可以使用`nova-manager db sync`执行数据库升级（不支持降级)，`nova-manager db version`查看当前数据库版本。

```
$ nova-manage db version 2>/dev/null
319
```

### 2.3 SQLAlchemy Migrate存在的问题

我们前面介绍了SQLAlchemy Migrate的用法，我们知道该方案是通过版本号数值大小区分版本高低的，版本号必须是独一无二的，第一个版本为001_xxx，第二个版本为002_xxx，即版本序列是线性的，这在多人协作中非常不方便。比如A开发者在它的分支创建了002_xxx_1，B开发者创建了002_xxx_2，它们在自己的分支部署测试都没有问题，代码合并也没有问题，但数据库版本却冲突了，同时有两个002版本，这种错误git还检测不了，只能人工去发现。另一个问题是backport，比如我们当前同时维护了两个项目版本，分别是1.0.1和2.0.1，假设1.0.1的数据库版本为50，而2.0.1的数据库版本为80，现在我们在2.0.1的bugfix想backport到1.0.1中，这个patch对应的数据库变更是81，此时由于1.0.1版本中没有51-80之间的变更记录，这种情况如何处理。OpenStack Nova是通过手动增加placeholder来填充缺失的版本序列来解决这个问题的，paceholder啥都不做，只是一个版本占位标记。

查看nova migrate repo的placeholder：

```
$ ls | grep -Pw '[0-9]{3}_placeholder.py' | tail -n 5
308_placeholder.py
309_placeholder.py
310_placeholder.py
311_placeholder.py
312_placeholder.py
```

你会发现nova中有大量的placeholder，这些就是由于backport的遗留问题。

nova使用SQLALchemy Migrate主要是历史遗留问题，除了nova项目，cinder也同样使用了该方案，后来的新项目基本都不再使用SQLALchemy Migrate，neutron目前使用的就是alembic。nova从icehouse版本开始就计划使用alembic替代SQLAlchemy Migrate，参考社区讨论[Obsolete:Alembic](https://wiki.openstack.org/wiki/Obsolete:Alembic)，不过nova core Michael Still不建议急于切换到Alembic：[Comparing alembic with sqlalchemy migrate](http://www.stillhq.com/openstack/icehouse/)。

另外，SQLALchemy Migrate项目活跃度已经非常低了，基本没有人再维护和更新了，说不定就要被淘汰了，另一个项目alembic即将取代。alembic有什么优势呢，为什么能够取代历史悠久的SQLALchemy Migrate，我们在下一节中将详细介绍。


## 3 Alembic介绍

### 3.1 Alembic背景

alembic是由sqlalchemy作者[Mike Bayer](http://techspot.zzzeek.org/)开发的，质量以及和sqlalchemy兼容性不用多说。其代码托管在[Bitbucket](http://bitbucket.org/)，官方主页为https://bitbucket.org/zzzeek/alembic。不过目前仍然处于beta阶段，但其实已经在很多项目中使用了，OpenStack的neutron、mistral、ironic都使用的alembic。有关alemtic的bug和问题可以到Google Group [sqlalchemy-alembic](https://groups.google.com/group/sqlalchemy-alembic)讨论。

接下来我们首先看看alembic的简单用法，注意观察和SQLALchemy Migrate的不同之处。

### 3.2 Alembic用法

和migrate一样，首先需要创建一个repo:

```
$ alembic init int32bit
  Creating directory /tmp/int32bit ... done
  Creating directory /tmp/int32bit/versions ... done
  Generating /tmp/int32bit/env.py ... done
  Generating /tmp/int32bit/env.pyc ... done
  Generating /tmp/alembic.ini ... done
  Generating /tmp/int32bit/script.py.mako ... done
  Generating /tmp/int32bit/env.pyo ... done
  Generating /tmp/int32bit/README ... done
  Please edit configuration/connection/logging settings in '/tmp/alembic.ini' before proceeding.
```

alembic支持多种模板，以上我们没有指定模板，因此使用的是默认模板，可以使用`alembic list_templates`查看支持的模板。

创建完repo后，需要修改`alembic.ini`配置文件，配置数据库连接信息，修改`sqlalchemy.url`为mysql连接信息:

```
[alembic]
...
sqlalchemy.url = mysql://int32bit:int32bit@lb.0.example.polex.io/int32bit?charset=utf8
...
```

我们创建一个account表:

```
$ alembic revision -m "create account table"
  Generating /tmp/int32bit/versions/30aaeaf5a3d7_create_account_table.py ... done
```

和migrate一样，自动生成了变更脚本`30aaeaf5a3d7_create_account_table.py`，不过并不是通过数字版本区分的。

你可以直接编辑`/tmp/int32bit/versions/30aaeaf5a3d7_create_account_table.py`文件，也可以使用`alembic edit head`编辑文件，它会调用环境变量`EDITOR`指定的编辑器打开文件。文件内容如下:

```
"""create account table

Revision ID: 30aaeaf5a3d7
Revises:
Create Date: 2017-08-25 16:02:56.227018

"""

# revision identifiers, used by Alembic.
revision = '30aaeaf5a3d7'
down_revision = None
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade():
    pass


def downgrade():
    pass
```

该文件包含一些头部信息，如当前版本id(revision，不再是数字)、上一个版本id(down_revision)等。

我们实现`upgrade`和`downgrade`方法:

```
def upgrade():
    op.create_table(
        'account',
        sa.Column('id', sa.Integer, primary_key=True),
        sa.Column('name', sa.String(50), nullable=False),
        sa.Column('description', sa.Unicode(200)),
    )

def downgrade():
    op.drop_table('account')
```

执行变更，升级到当前版本:

```
$ alembic upgrade head
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade  -> 30aaeaf5a3d7, create account table
```

你可以随时查看当前版本:

```
$ alembic current -v
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
Current revision(s) for mysql://int32bit:XXXXX@lb.0.example.polex.io/int32bit?charset=utf8:
Rev: 30aaeaf5a3d7 (head)
Parent: <base>
Path: /tmp/int32bit/versions/30aaeaf5a3d7_create_account_table.py

    create account table

    Revision ID: 30aaeaf5a3d7
    Revises:
    Create Date: 2017-08-25 16:02:56.227018
```

我们增加一个列：

```
$ alembic revision -m "Add a email column to account table"
  Generating /tmp/int32bit/versions/52a265aec608_add_a_email_column_to_account_table.py ... done
```

实现`upgrade`和`downgrade`方法如下:

```
def upgrade():
    op.add_column('account', sa.Column('email', sa.String(20)))

def downgrade():
    op.drop_column('account', 'email')
```

升级数据库版本:

```
$ alembic upgrade head
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade 30aaeaf5a3d7 -> 52a265aec608, Add a email column to account table
```

我们发现alemic的版本是通过一串hash区分的，而migrate是通过数字区分，这类似于svn和git的区别。你可以使用简写，比如版本hash为`52a265aec608`，你可以简写为`52a`。另外还有几个特殊的版本：

* base: 表示最初的版本（相当于migrate的版本0)。
* head: 表示当前最新版本。
* current: 表示当前数据库的最新版本，没有升级前可能落后于head版本。

alembic还支持相对版本，比如`head-1`,表示上一个版本。

你可以使用`history`命令查看版本历史:

```
$ alembic history
30aaeaf5a3d7 -> 52a265aec608 (head), Add a email column to account table
<base> -> 30aaeaf5a3d7, create account table
```

可以通过`-r`参数指定查看的区间:

```
$ alembic history -r-1:current
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
30aaeaf5a3d7 -> 52a265aec608 (head), Add a email column to account table
<base> -> 30aaeaf5a3d7, create account table
```

现在我们要回滚到上一个版本:

```
$ alembic downgrade -1
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
INFO  [alembic.runtime.migration] Running downgrade 52a265aec608 -> 30aaeaf5a3d7, Add a email column to account table
```

现在我们假设合并了两个分支的代码，导致有两个变更引用的`down_revision`是一样的:

```sh
$ grep down_revision *.py
30aaeaf5a3d7_create_account_table.py:down_revision = None
52a265aec608_add_a_email_column_to_account_table.py:down_revision = '30aaeaf5a3d7'
98fd632fd10_add_a_password_column_to_account_table.py:down_revision = '30aaeaf5a3d7'
```

我们发现`30aaeaf5a3d7`引用了两次，我们使用`branches`子命令也可以查看到这个结果:

```
$ alembic branches -v
Rev: 30aaeaf5a3d7 (branchpoint)
Parent: <base>
Branches into: 98fd632fd10, 52a265aec608
Path: /tmp/int32bit/versions/30aaeaf5a3d7_create_account_table.py

    create account table

    Revision ID: 30aaeaf5a3d7
    Revises:
    Create Date: 2017-08-25 16:02:56.227018

             -> 98fd632fd10 (head), Add a password column to account table
             -> 52a265aec608 (head), Add a email column to account table
```

或者使用`history`命令:

```
$ alembic history
30aaeaf5a3d7 -> 52a265aec608 (head), Add a email column to account table
30aaeaf5a3d7 -> 98fd632fd10 (head), Add a password column to account table
<base> -> 30aaeaf5a3d7 (branchpoint), create account table
```

也就是说当前`head`版本同时有两个变更:

```
$ alembic heads
52a265aec608 (head)
98fd632fd10 (head)
```

我们执行`upgrade`：

```
$ alembic upgrade head
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
ERROR [alembic.util.messaging] Multiple head revisions are present for given argument 'head'; please specify a specific target revision, '<branchname>@head' to narrow to a specific head, or 'heads' for all heads
  FAILED: Multiple head revisions are present for given argument 'head'; please specify a specific target revision, '<branchname>@head' to narrow to a specific head, or 'heads' for all heads
```

结果失败了，因为同时存在多个`head`。

我们可以通过`merge`命令合并分支，如下：

```
                            -- 52a265aec608 -->
                           /                   \
<base> --> 30aaeaf5a3d7 -->                      --> mergepoint
                           \                   /
                            -- 98fd632fd10 -->
```

执行`merge`命令:

```
$ alembic merge -m "merge 52a and 98f" 52a 98f

  Generating /tmp/int32bit/versions/2be18dbd38c3_merge_52a_and_98f.py ... done
```

此时我们的`head`只有一个了:

```
$ alembic heads
2be18dbd38c3 (head)
```

我们再次执行`upgrade`：

```
$ alembic upgrade head
INFO  [alembic.runtime.migration] Context impl MySQLImpl.
INFO  [alembic.runtime.migration] Will assume non-transactional DDL.
INFO  [alembic.runtime.migration] Running upgrade 30aaeaf5a3d7 -> 98fd632fd10, Add a password column to account table
INFO  [alembic.runtime.migration] Running upgrade 30aaeaf5a3d7 -> 52a265aec608, Add a email column to account table
INFO  [alembic.runtime.migration] Running upgrade 52a265aec608, 98fd632fd10 -> 2be18dbd38c3, merge 52a and 98f
```

当然你也可以在变更脚本中指定`branch_labels`，这样就能通过`branch_labels`区分版本了。

```
alembic upgrade branch_1@head
alembic upgrade branch_2@head
```

alembic支持非常丰富的分支管理，具体参考[官方文档](http://alembic.zzzcomputing.com/en/latest/branches.html)。

### 3.3 Alembic与SQLAlchemy Migrate比较

相对migrate方案，

* alembic版本管理更灵活，支持相对版本。
* migrate只支持线性版本，版本通过数字区分，alembic支持多分支，版本通过一串hash区分。
* alembic使用起来更方便，功能也相对强大。
* alembic项目较新，开发活跃度高，migrate很久不更新了。

## 4 OpenStack使用的方案统计

| 项目 | migrate方案 | 
|----|:--:|
| Keystone  | SQLAlchemy Migrate  |
| Glance  |  SQLAlchemy Migrate |
| Nova  |  SQLAlchemy Migrate |
| Cinder  |  SQLAlchemy Migrate |
| Neutron  |  Alembic |
| Heat  |  SQLAlchemy Migrate |
| Trove  |  SQLAlchemy Migrate |
| Sahara  |  Alembic |
| Mistral  |  Alembic |
| Manila  | Alembic |
| Ironic  | Alembic |

## 5 总结

本文首先介绍了使用数据库migrate工具的原因，然后介绍了当前两大主流migrate工具的用法，并对比了二者的区别和优势。最后总结了OpenStack项目的使用情况。

## 参考文献

1. [SQLAlchemy Migrate官方文档](http://sqlalchemy-migrate.readthedocs.io/en/latest/).
2. [Using SQLAlchemy-Migrate with Elixir model in Pylons](http://www.karoltomala.com/blog/?p=633).
3. StackOver关于sqlalchemy migrate的讨论：[Is it worth using sqlalchemy-migrate ?](https://stackoverflow.com/questions/4209705/is-it-worth-using-sqlalchemy-migrate).
4. OpenStack Nova Core的博客：[Comparing alembic with sqlalchemy migrate](http://www.stillhq.com/openstack/icehouse/).
5. OpenStack 社区关于使用Alembic代替SQLalchemy Migrate的Wiki：[Obsolete:Alembic](https://wiki.openstack.org/wiki/Obsolete:Alembic).
6. [Schema migrations with Alembic, Python and PostgreSQL](https://www.compose.com/articles/schema-migrations-with-alembic-python-and-postgresql/).
7. [alembic官方文档](http://alembic.zzzcomputing.com/en/latest/tutorial.html).
8. [alembic分支官方介绍](http://alembic.zzzcomputing.com/en/latest/branches.html).
