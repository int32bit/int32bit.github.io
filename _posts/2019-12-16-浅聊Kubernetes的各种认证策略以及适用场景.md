---
layout: post
title: 浅聊Kubernetes的各种认证策略以及适用场景
catalog: true
tags: [Kubernetes, OpenStack, Keycloak]
---

## 1 Kubernetes认证背景

## 1.1 为什么Kubernetes没有用户以及用户组？

Kubernetes的RBAC模型授权对象(Subject)是用户(User)或者用户组(Group)，即使ServiceAccount也会当作为一个虚拟User。

但是很令人疑惑的是通过Kubernetes找不到真正的用户以及用户组信息，甚至连对应的User Resource以及Group Resource都没有，所以有时候在写rolebingding的时候会觉得很奇怪，Subjects需要填`User`或者`Group`，可是Kubernetes却没有办法列出可信任的User列表以及Group列表。

换句话说Kubernetes并没有提供用户管理和身份认证功能，除了Service Account外，所有的用户信息都依赖外部的用户管理系统来存储，因此通过api-serever根本无法列出User和Group。

这其实挺符合UNIX设计哲学的，即[Do One Thing and Do It Well](https://en.wikipedia.org/wiki/Unix_philosophy#Do_One_Thing_and_Do_It_Well)。

![](Ken_Thompson_and_Dennis_Ritchie--1973.jpg)

Kubernetes只专注于做应用编排，其他的功能则提供接口集成，除了认证和授权，我们发现网络、存储也都如此。

这样做的好处也显而易见，用户账户信息与Kubernetes集群松耦合，便于集成企业已有的身份认证系统，如AD、LADP、Keycloak等。

## 1.2 关于kubeconfig文件

kubectl是通过读取kubeconfig获取集群信息的，默认路径为`$HOME/.kube/config`，可以通过`KUBECONFIG`环境变量指定多个config文件。

kubeconfig文件主要包含如下三个部分:

* cluster: 存储api-server的CA根证书、api-server地址、集群名称等。
* user: 真正配置用户认证时的凭证信息，**使用不同的认证策略，包含不同的字段**。
* context: 把cluster和user关联起来组成一个集群环境信息，声明通过哪个user连哪个cluster。

手动编辑config文件非常麻烦，kubectl config子命令提供了大部分的参数自动填充kubeconfig文件，分别对应set-cluster、set-credentials、set-context，相对应的有get-clusters、get-contexts以及delete-cluster、delete-context，目前没有对应credential get和delete操作,只能手动编辑kubeconfig文件。

通过use-context切换集群上下文。

## 1.3 关于Kubernetes认证策略

Kubernetes虽然没有直接实现普通用户的身份认证功能，但是很好的支持集成各种已有的身份认证策略，并且支持同时使用多种认证策略，只要有其中一种认证策略校验通过就算认证通过。

可以说Kubernetes的认证方式五花八门，这些认证方式都有哪些优缺点，适合什么样的场景，这就是本文需要研究的两个问题。

本文接下来主要研究Kubernetes提供的几种认证策略，结合自己在使用过程以及阅读了大量的文献基础上，总结不同策略的优缺点以及适用场景。

## 1.4 Role以及Rolebingding配置

不仅Kubernetes的身份认证是通过外部系统集成，Kubernetes的授权其实也支持各种插件，本文不会详细讨论关于Kubernetes的授权机制，仅为了验证身份认证，假定授权使用的是RBAC插件。

预先创建了role和rolebingding如下:

* role:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: int32bit-role
  namespace: default
rules:
- apiGroups:
  - ""
  resources:
  - pods
  - pods/exec
  verbs:
  - get
  - list
  - watch
  - create
```

* rolebingding:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: int32bit-rolebinding
  namespace: default
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: int32bit-role
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: int32bit
- kind: ServiceAccount
  name: test-sa
```

## 2 静态密码认证

静态密码是最简单的认证方式，只需要在api-server启动时指定使用的密码本路径即可:

```bash
kube-apiserver --advertise-address=192.168.193.172 \
  # ...省略其他参数... \
  --basic-auth-file=/etc/static_secret/passwd
```

其中密码本格式为csv:

```
password,user,uid,"group1,group2,group3"
```

demo如下:

```
NoMoreSecret,int32bit-1,1000,"int32bit"
```

此时定义了一个用户`int32bit-1`，静态密码为`NoMoreSecret`，所属Group为`intt32bit`。

此时可生成凭证config文件:

```
kubectl config set-credentials int32bit-1 --username=int32bit-1 --password=NoMoreSecret
```

使用该config文件如下:

![test static password](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-static-password.gif)

int32bit-1由于所属`int32it`group，因此可以读取pod列表，但是无法删除pod。

通过静态密码的唯一优势是简单，其缺点也是非常明显:

* 静态密码是明文，非常不安全，还有可能被暴力破解。
* 非常不灵活，增加或者删除用户，必须手动修改静态密码文件并重启所有的api-server服务。

这种方式在实际场景中很少被使用，不建议生产环境使用。

## 3 x509证书认证

x509认证是默认开启的认证方式，api-server启动时会指定ca证书以及ca私钥，只要是通过ca签发的客户端x509证书，则可认为是可信的客户端。

使用kubeadm部署后的cluster-admin默认就是通过x509证书认证的，node节点和API server通信也是通过证书认证的。

这里需要注意的是，在kubectl config中会有两个证书，分别为`certificate-authority`证书和`client-certificate`证书。`client-certificate`用于客户端认证，这显而易见。

但`certificate-authority`用于做什么呢？答案是为了避免与api server通信时遭受中间人攻击，api server默认使用了https协议，但我们使用kubeadm部署Kubernetes集群时默认使用的是自签证书，为了让客户端信任api server的根证书，需要配置server端的证书。当然直接添加到OS的可信任根证书列表中也是可以的。如果使用权威机构颁发的证书则不需要配置。

综上，kubectl客户端与Kubernetes api-server认证时采用的是双向认证，这里不限于x509认证模式，所有的认证模式都应该配置为双向认证，因此后面将介绍的Token认证模式同样需要server端的根证书。

在使用client-certificate客户端证书认证时，CN(commom Name)对应Kubernetes的User，O(organization)对应Kubernetes的Group。

签发客户端证书有两种方式，一种是基于CA根证书签发证书，另一个种是发起CSR(Certificate Signing Requests)请求。

### 3.1 使用CA根证书签发客户端证书

使用CA根证书需要CA的私钥，假设要创建一个int32bit用户，所属的组为int32bit，使用openssl签发证书:

```bash
openssl genrsa -out int32bit.key 2048 # 生成私钥
openssl req -new -key int32bit.key -out int32bit.csr -subj "/CN=int32bit/O=int32bit" # 发起CSR请求
openssl x509 -req -in int32bit.csr \
  -CA $CA_LOCATION/ca.crt \
  -CAkey $CA_LOCATION/ca.key \
  -CAcreateserial -out int32bit.crt -days 365 # 基于CSR文件签发x509证书
```

其中`CA_LOCATION`为api server的CA证书路径，使用kubeadm部署一般为`/etc/kubernetes/pki/`。

最后生成config文件:

```bash
kubectl config set-credentials int32bit \
  --client-certificate=int32bit.crt \
  --client-key=int32bit.key \
  --embed-certs=true \
  --kubeconfig="int32bit@int32bit-kubernetes.config.config"
```

注意使用`--embed-certs`参数，这样才会把证书内容填充到kubeconfig文件，否则仅填充证书路径。

![test x509](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-x509.gif)

### 3.2 通过CSR签发证书

前面通过CA签发证书需要有CA的私钥，其实Kubernetes可以直接发起CSR请求。

首先创建一个CSR请求，CN为`test-csr`，O为`int32bit`，即User为`test-csr`，Group为`int32bbit`。

```bash
openssl req -new -newkey rsa:4096 \
  -nodes -keyout test-csr.key \
  -out test-csr.csr -subj "/CN=test-csr/O=int32bit"
```

声明一个CSR Resource:

```yaml
apiVersion: certificates.k8s.io/v1beta1
kind: CertificateSigningRequest
metadata:
  name: test-csr
spec:
  groups:
  - int32bit
  request: ... # 这里填test-csr.csr内容并转化为base64
  usages:
  - client auth
```

创建该资源:

```bash
# kubectl apply -f test-csr.yaml
certificatesigningrequest.certificates.k8s.io/test-csr created
# kubectl get csr
NAME       AGE   REQUESTOR          CONDITION
test-csr   4s    kubernetes-admin   Pending
```

此时CSR的状态为`Pending`，通过`kubectl certificate approve`命令签发证书:

```bash
# kubectl certificate approve test-csr
certificatesigningrequest.certificates.k8s.io/test-csr approved
# kubectl get csr
NAME       AGE   REQUESTOR          CONDITION
test-csr   2m    kubernetes-admin   Approved,Issued
```

此时CSR显示已经完成签发，可以读取证书内容:

```
# kubectl get csr test-csr -o jsonpath='{.status.certificate}' | base64 -d
-----BEGIN CERTIFICATE-----
MIIEDTCCAvWgAwIBAgIUB9dVsj34xnQ8m5KUQwpdblWapNcwDQYJKoZIhvcNAQEL
...
yvfz8hcwrhQc6APpmZcBnil7iyzia3tnztQjoyaZ0cjC
-----END CERTIFICATE-----
```

查看证书部分摘要信息:

```bash
# kubectl get csr test-csr -o jsonpath='{.status.certificate}' \
  | base64 -d \
  | openssl x509  -noout  \
  -subject  -issuer
subject=O = int32bit, CN = test-csr
issuer=CN = kubernetes
```

配置kubeconfig使用证书认证的方式和前面的一样，这里不再赘述。

## 3.3 使用x509证书认证的问题

使用x509证书相对静态密码来说显然会更安全，只要证书不泄露，可以认为是无懈可击的。但是虽然颁发证书容易，目前却没有很好的方案注销证书。想想如果某个管理员离职，该如何回收他的权限和证书。有人说，证书轮转不就解决了吗？但这也意味着需要重新颁发其他所有证书，非常麻烦。

所以使用x509证书认证适用于Kubernetes内部组件之间认证，普通用户认证并不推荐通过证书的形式进行认证，参考[Kubernetes – Don’t Use Certificates for Authentication](https://www.tremolosecurity.com/kubernetes-dont-use-certificates-for-authentication/)。

## 4 Bearer Token认证

### 4.1 静态token认证

静态token认证和静态密码原理几乎完全一样，唯一不同的是静态token通过token-auth-file指定token文件，认证时头部格式为`Authorization: Bearer ${Token}`，而静态密码通过basic-auth-file指定密码文件，认证头部为`Basic base64encode(${username}:${password})`，本质都是一样的。

因此其优点和缺点也和静态密码完全一样，这里不再赘述。

### 4.2 Bootstrap Token认证

前面提到的静态token在运行时是固定不变的，并且不会在Kubernetes集群中存储，意味着除非修改静态文件并重启服务，token不会改变。

而bootstrap token则是由Kubernetes动态生成的，通过**Secret形式存储**，并且具有**一定的生命周期**，一旦过期就会失效。

为了简便我们使用kubeadm生成一个token:

```bash
# kubeadm token list
TOKEN                     TTL       EXPIRES                USAGES                   DESCRIPTION   EXTRA GROUPS
bpjp71.6ckt2g3o3hso3gn4   23h       2019-12-15T11:58:13Z   authentication,signing   <none>        system:bootstrappers:kubeadm:default-node-token
```

Token有两个部分组成，由`.`分割，前面部分为Token ID `bpjp71`，后面部分为Token Secret `6ckt2g3o3hso3gn4`。Token默认TTL为一天，对应的group为`system:bootstrappers:kubeadm:default-node-token`，对应User为`system:bootstrap:${Token ID}`。

kubeadm创建一个Token会对应在Kubernetes的kube-system namespace创建一个secret，secret名为`bootstrap-token-${TOKEN_ID}`，这里为`bootstrap-token-bpjp71`。

```yaml
# kubectl get secret bootstrap-token-bpjp71 -n kube-system -o yaml --export
apiVersion: v1
data:
  auth-extra-groups: c3lzdGVtOmJvb3RzdHJhcHBlcnM6a3ViZWFkbTpkZWZhdWx0LW5vZGUtdG9rZW4=
  expiration: MjAxOS0xMi0xNVQxMTo1ODoxM1o=
  token-id: YnBqcDcx
  token-secret: NmNrdDJnM28zaHNvM2duNA==
  usage-bootstrap-authentication: dHJ1ZQ==
  usage-bootstrap-signing: dHJ1ZQ==
kind: Secret
metadata:
  name: bootstrap-token-bpjp71
type: bootstrap.kubernetes.io/token
```

此时可以通过如下命令生成config:

```bash
kubectl config set-credentials bootstrap \
  --user bootstrap \
  --token bpjp71.6ckt2g3o3hso3gn4
```

为了验证boostrap token，我们把用户添加到`int32bit-role`中，注意对应的虚拟User名。

```
# kubectl  describe  rolebindings int32bit-rolebinding
Name:         int32bit-rolebinding
Labels:       <none>
Annotations:  <none>
Role:
  Kind:  Role
  Name:  int32bit-role
Subjects:
  Kind   Name                     Namespace
  ----   ----                     ---------
  Group  int32bit
  User   system:bootstrap:bpjp71
```

![test bootstrap](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-bootstrap.gif)

这种token主要用于**临时授权使用**，比如kubeadm初始化集群时会生成一个bootstrap token，这个token具有创建certificatesigningrequests权限，从而新Node能够发起CSR请求，请求客户端证书。

### 4.3 service account token认证

service account是Kubernetes唯一由自己管理的账号实体，意味着service account可以通过Kubernetes创建，不过这里的service account并不是直接和User关联的，service account是namespace作用域，而User是全cluster唯一。service account会对应一个虚拟User，User名为`system:serviceaccount:${namespace}:${sa_name}`，比如在default namespace的test service account，则对应的虚拟User为`system:serviceaccount:default:test`。

和前面的bootstrap一样，service account也是使用Bearer Token认证的，不过和前面的Token不一样的是service account是基于JWT(JSON Web Token)认证机制，JWT原理和x509证书认证其实有点类似，都是通过CA根证书进行签名和校验，只是格式不一样而已，JWT由三个部分组成，每个部分由`.`分割，三个部分依次如下:

* Header（头部）: Token的元数据，如alg表示签名算法，typ表示令牌类型，一般为`JWT`，kid表示Token ID等。
* Payload（负载): 实际存放的用户凭证数据，如iss表示签发人，sub签发对象，exp过期时间等。
* Signature（签名）：基于alg指定的算法生成的数字签名，为了避免被篡改和伪造。

为了便于HTTP传输，JWT Token在传递过程中会转成Base64URL编码，其中Base64URL相对我们常用的Base64编码不同的是`=`被省略、`+`替换成`-`，`/`替换成`_`，这么做的原因是因为这些字符在URL里面有特殊含义，更多关于JWT的介绍可参考阮一峰的[JSON Web Token 入门教程](https://www.ruanyifeng.com/blog/2018/07/json_web_token-tutorial.html)。

我写了如下脚本实现Kubernetes Service Account的Token解码:

```bash
#!/bin/bash

# base64url解码
decode_base64_url() {
  LEN=$((${#1} % 4))
  RESULT="$1"
  if [ $LEN -eq 2 ]; then
    RESULT+='=='
  elif [ $LEN -eq 3 ]; then
    RESULT+='='
  fi
  echo "$RESULT" | tr '_-' '/+' | base64 -d
}

# 解码JWT
decode_jwt()
{
  JWT_RAW=$1
  for line in $(echo "$JWT_RAW" | awk -F '.' '{print $1,$2}'); do
    RESULT=$(decode_base64_url "$line")
    echo "$RESULT" | python -m json.tool
  done
}

# 获取k8s sa token
get_k8s_sa_token()
{
  NAME=$1
  TOKEN_NAME=$(kubectl get sa "$NAME" -o jsonpath='{.secrets[0].name}')
  kubectl get secret "${TOKEN_NAME}" -o jsonpath='{.data.token}' | base64 -d
}

main()
{
  NAME=$1
  if [[ -z $NAME ]]; then
    echo "Usage: $0 <secret_name>"
    exit 1
  fi
  TOKEN=$(get_k8s_sa_token "$NAME")
  decode_jwt "$TOKEN"
}

main "$@"
```

![decode_k8s_sa_token.gif](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/decode_k8s_sa_token.gif)

从解码的数据可见，JWT Token的颁发机构为`kubernetes/serviceaccount`,颁发对象为SA对应的虚拟用户`system:serviceaccount:default:test`，除此之外还存储着其他的SA信息，如SA name、namespace、uuid等。这里需要注意的是我们发现JWT Token中没有exp字段，即意味着只要这个SA存在，这个Token就是永久有效的。

通过如下方式配置kubeconfig:

```bash
TOKEN_NAME=$(kubectl get serviceaccounts ${SA_NAME} -o jsonpath={.secrets[0].name})
TOKEN=$(kubectl get secret "${TOKEN_NAME}" -o jsonpath={.data.token} | base64 -d)
kubectl config set-credentials "${USERNAME}" --token="$TOKEN"
```

为了验证test-sa，在刚刚创建的`int32bit-rolebinding`的subjects增加了ServiceAccount `test-sa`。

验证test-sa是否可以读取pod列表以及删除pod:

![test-sa.gif](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-sa.gif)

和预期一样，test-sa能够读取pod列表但没有删除pod权限。

service account除了可以用于集群外认证外，其还有一个最大的特点是可以通过`Pod.spec.serviceAccountName`把token attach到Pod中，这类似于AWS IAM把Role attach关联到EC2实例上。

此时Kubernetes会自动把SA的Token通过volume的形式挂载到`/run/secrets/kubernetes.io/serviceaccount`目录上，从而Pod可以读取token调用Kubernetes API.

![cat pod token](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/cat_pod_token.gif)

针对一些需要和Kubernetes API交互的应用非常有用，比如coredns就需要监控endpoints、services的变化，因此关联了coredns SA，coredns又关联了`system:coredns` clusterrole。flannel需要监控pods以及nodes变化同样关联了flannel SA。

到这里为止，service account可能是Kubernetes目前最完美的认证方案了，既能支持集群外的客户端认证，又支持集群内的Pod关联授权。

但事实上，service account并不是设计用来给普通user认证的，而是给集群内部服务使用的。目前虽然token是永久有效的，但未来会改成使用动态token的方式，参考官方设计设计文档[Bound Service Account Tokens](https://github.com/kubernetes/community/blob/master/contributors/design-proposals/auth/bound-service-account-tokens.md)，此时如果kubectl客户端认证则需要频繁更新token。

除此之外，SA虽然能够对应一个虚拟User，但不支持自定义Group，在授权体系中不够灵活。另外也不支持客户端高级认证功能，比如MFA、SSO等。

## 5 集成外部认证系统

前面已经介绍过Kubernetes集成简单的静态用户文件以及x509证书认证，Kubernetes最强大的功能是支持集成第三方Id Provider（IdP），主流的如AD、LADP以及OpenStack Keystone等，毕竟专业的人做专业的事。

本文接下来主要介绍集成OpenID Connect以及通过webhook集成Keystone。

### 5.1 通过OpenID Connect集成keycloak认证系统

当前支持OpenID Connect的产品有很多，如:

* [Keycloak](https://www.keycloak.org/)
* [UAA](https://docs.cloudfoundry.org/concepts/architecture/uaa.html)
* [Dex](https://github.com/dexidp/dex/blob/master/Documentation/kubernetes.md)
* [OpenUnison](https://www.tremolosecurity.com/orchestra-k8s/)

这里以Keycloak为例，这里仅为了实现测试，因此部署standalone模式，安装非常简单，可参考官方文档[Getting Started Guide](https://www.keycloak.org/docs/latest/getting_started/index.html)，这里不再赘述。

#### 5.1.1 keycloak配置

由于Kubernetes要求必须是https，测试环境需要签发自己的CA，参考[为Kubernetes 搭建支持 OpenId Connect 的身份认证系统](https://www.ibm.com/developerworks/cn/cloud/library/cl-lo-openid-connect-kubernetes-authentication/index.html):

```
#!/bin/bash
mkdir -p ssl
cat << EOF > ssl/ca.cnf
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[ v3_req ]
basicConstraints = CA:TRUE
EOF
cat << EOF > ssl/req.cnf
[req]
req_extensions = v3_req
distinguished_name = req_distinguished_name

[req_distinguished_name]

[ v3_req ]
basicConstraints = CA:FALSE
keyUsage = nonRepudiation, digitalSignature, keyEncipherment
subjectAltName = @alt_names

[alt_names]
IP.1 = 192.168.193.172
EOF

openssl genrsa -out ssl/ca-key.pem 2048
openssl req -x509 -new -nodes -key ssl/ca-key.pem -days 365 -out ssl/ca.pem -subj "/CN=keycloak-ca" -extensions v3_req -config ssl/ca.cnf

openssl genrsa -out ssl/keycloak.pem 2048
openssl req -new -key ssl/keycloak.pem -out ssl/keycloak-csr.pem -subj "/CN=keycloak" -config ssl/req.cnf
openssl x509 -req -in ssl/keycloak-csr.pem -CA ssl/ca.pem -CAkey ssl/ca-key.pem -CAcreateserial -out ssl/keycloak.crt -days 365 -extensions v3_req -extfile ssl/req.cnf

# 生成 keystore 并导入 keypair
openssl pkcs12 -export -out ssl/keycloak.p12 -inkey ssl/keycloak.pem -in ssl/keycloak.crt -certfile ssl/ca.pem
keytool -importkeystore -deststorepass 'noMoreSecret' -destkeystore ssl/keycloak.jks -srckeystore ssl/keycloak.p12 -srcstoretype PKCS12
```

由于没有配置固定域名，因此添加了`alt_names`并指定IP。

最后复制`ssl/keycloak.p12`到如下两个路径:

```bash
cp ssl/keycloak.p12 keycloak-8.0.1/standalone/configuration/keycloak.jks
cp ssl/keycloak.p12 /etc/kubernetes/pki/
```

#### 5.1.2 keycloak认证信息配置

登录keycloak管理页面创建一个realm以及client，名称都为`int32bit-kubernetes`。其中realm类似namespace概念，实现了多租户模型，client对应一个认证主体，所有使用keycloak认证的都需要创建一个对应的client。

![keycloak](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/keycloak-realm.png)

每个client会对应有一个secret，这二者关系就是access key和access secret关系:

![keycloak client secret](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/keycloak-client-secret.png)

接下来通过Web管理页面执行如下操作：

* 在Roles中创建两个role分别为`int32bit-kubernetes-cluster-admin`、`int32bit-kubernetes-readonly`。
* 在Users中创建两个用户`k8s-admin`、`k8s-readonlly`。
* `k8s-admin`关联`int32bit-kubernetes-cluster-admin` role，`k8s-readonlly`关联`int32bit-kubernetes-readonly` role。

![keycloak role mapping](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/keycloak-role-mapping.png)

注: 管理员可以在User的Credentials面板中设置用户密码。

通过curl检查是否可认证获取token:

```bash
curl -sSLk \
  -d "client_id=int32bit-kubernetes" \
  -d "client_secret=700eeab2-2f85-45a1-9904-297a0be4d4fd" \
  -d "response_type=code token" \
  -d "grant_type=password" \
  -d "username=k8s-admin" \
  -d "password=noMoreSecret" \
  -d "scope=openid" \
  https://192.168.193.172:8443/auth/realms/int32bit-kubernetes/protocol/openid-connect/token
```

![get odic token](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/get-odic-token.png)

其中返回的`id_token`，在后面Kubernetes对接中非常重要，它也是一个JWT Token，解码后的内容如下:

```json
{
  "alg": "RS256",
  "typ": "JWT",
  "kid": "95WIuxaLj99XHhmytuQm4POZztFxYCaw3Pd-KyBGVVQ"
}
{
  "jti": "39b94185-045a-4cee-b025-d0e0909d6bfd",
  "exp": 1576466962,
  "nbf": 0,
  "iat": 1576466662,
  "iss": "https://192.168.193.172:8443/auth/realms/int32bit-kubernetes",
  "aud": "int32bit-kubernetes",
  "sub": "95374c54-c47f-42a5-9bb2-2e0e417a9ff2",
  "typ": "ID",
  "azp": "int32bit-kubernetes",
  "auth_time": 0,
  "session_state": "0eafa8ba-6536-4f6a-989f-177e19e4882a",
  "acr": "1",
  "email_verified": false,
  "preferred_username": "k8s-admin"
}
```

我们发现`id_token`默认没有groups信息，为了支持Kubernetes的Group认证，需要在client中添加mappers字段groups。

![keycloak add groups](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/keycloak-add-groups.png)

这里之所以映射`User Realm Role`，而不是`Group MemberShip`，是因为Group会在id_token中添加前缀`/`，如`/test-group1,/test-group2`，这个暂时没想到怎么处理，或许有更好的办法。

再次生成token_id就会有groups信息了:

```json
{
  "jti": "39b94185-045a-4cee-b025-d0e0909d6bfd",
  "exp": 1576466962,
  "nbf": 0,
  "iat": 1576466662,
  "iss": "https://192.168.193.172:8443/auth/realms/int32bit-kubernetes",
  "aud": "int32bit-kubernetes",
  "sub": "95374c54-c47f-42a5-9bb2-2e0e417a9ff2",
  "typ": "ID",
  "azp": "int32bit-kubernetes",
  "auth_time": 0,
  "session_state": "0eafa8ba-6536-4f6a-989f-177e19e4882a",
  "acr": "1",
  "email_verified": false,
  "groups": [
    "int32bit-kubernetes-cluster-admin"
  ],
  "preferred_username": "k8s-admin"
}
```

#### 5.1.3 Kubernetes集成keycloak认证

在api-server中增加如下命令行启动参数:

```
 - --oidc-issuer-url=https://192.168.193.172:8443/auth/realms/int32bit-kubernetes
    - --oidc-client-id=int32bit-kubernetes
    - --oidc-username-claim=preferred_username
    - --oidc-username-prefix=-
    - --oidc-groups-claim=groups
    - --oidc-ca-file=/etc/kubernetes/pki/keycloak.crt
```

* `--oidc-issuer-url`路径需要具体到realm，这里为`int32bit-kubernetes`；
* `--oidc-client-id`对应client id，前面我们已经创建。
* `--oidc-username-claim`、`--oidc-groups-claim`告诉Kubernetes如何从`id_token`中读取username和groups，根据前面解码后的`id_token`，我们不难选择。
* `--oidc-username-prefix`告诉Kubernetes针对这个odic的用户需要添加什么前缀，如果集群同时有多个认证系统，建议添加个前缀加以区分，如指定前缀为`odic:`，则Kubernetes对应的User为`odic: preferred_username`。
* `--oidc-ca-file`指定keycloak的根证书，因为不是权威证书，不指定则不会信任该证书。

前面创建了两个用户，与Role的关联关系如下:

* k8s-admin: **int32bit-kubernetes-cluster-admin**
* k8s-readonly: **int32bit-kubernetes-readonly**

相对应的在Kubernetes创建两个clusterrolebinging:

cluster-admin:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  annotations:
    rbac.authorization.kubernetes.io/autoupdate: "true"
  labels:
    kubernetes.io/bootstrapping: rbac-defaults
  name: cluster-admin
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: cluster-admin
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: system:masters
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: int32bit-kubernetes-cluster-admin
```

cluster-readonly:

```
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  annotations:
    rbac.authorization.kubernetes.io/autoupdate: "true"
  labels:
    kubernetes.io/bootstrapping: rbac-defaults
  name: cluster-readonly
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: view
subjects:
- apiGroup: rbac.authorization.k8s.io
  kind: Group
  name: int32bit-kubernetes-readonly
```

#### 5.1.4 使用OpenId Connect认证

生成config文件:

```bash
kubectl config set-credentials oidc \
   --auth-provider=oidc \
   --auth-provider-arg=idp-issuer-url=https://192.168.193.172:8443/auth/realms/int32bit-kubernetes \
   --auth-provider-arg=client-id=int32bit-kubernetes \
   --auth-provider-arg=client-secret=700eeab2-2f85-45a1-9904-297a0be4d4fd
```

为了便于登录，下载[kube-login插件](https://github.com/int128/kubelogin):

```bash
kubectl krew install oidc-login
```

此时可以直接通过如下命令进行登录:

```
kubectl oidc-login --username username --password passwor
```

如果是图形界面，不指定参数直接使用kubectl oidc-login可自动打开浏览器进行登录校验。

![test oidc](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-oidc.gif)

可见使用k8s-admin具有所有权限，而k8s-readonly只有list的权限。

### 5.2 通过webhook集成OpenStack Keystone

webhook和odic一样也是集成外部认证系统的一种方式，当client发起api-server请求时会触发webhook服务TokenReview调用，webhook会检查用户的凭证信息，如果是合法则返回`authenticated": true`等信息。api-server会等待webhook服务返回，如果返回的`authenticated`结果为true，则表明认证成功，否则拒绝访问。

#### 5.2.1 OpenStack Keystone配置

为了后续测试，我们在Keystone创建如下资源:

```bash
#!/bin/bash
openstack project create int32bit-kubernetes
USERS_AND_ROLES=(k8s-admin k8s-viewer)
for i in "${USERS_AND_ROLES[@]}"; do
  openstack user create --project int32bit-kubernetes --password noMoreSecret "$i"
  openstack role create "$i"
  openstack role add --user "$i" --project int32bit-kubernetes "$i"
done
```

其中k8s-admin user关联k8s-admin role，k8s-viewer user关联k8s-viewer role，我们根据不同role角色设置不同的权限：

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: k8s-auth-policy
  namespace: kube-system
data:
  policies: |
    [
      {
        "resource": {
          "verbs": ["get", "list", "watch"],
          "resources": ["*"],
          "version": "*",
          "namespace": "default"
        },
        "match": [
          {
            "type": "role",
            "values": ["k8s-viewer", "k8s-admin"]
          },
          {
            "type": "project",
            "values": ["int32bit-kubernetes"]
          }
        ]
      },
      {
        "resource": {
          "verbs": ["create", "update", "delete"],
          "resources": ["*"],
          "version": "*",
          "namespace": "default"
        },
        "match": [
          {
            "type": "role",
            "values": ["k8s-admin"]
          },
          {
            "type": "project",
            "values": ["int32bit-kubernetes"]
          }
        ]
      }
    ]
```

如上policy配置中，k8s-viewer只允许读namesapce default的资源，而k8s-admin允许create、update以及delete等所有权限。

创建如上configmap:

```
kubectl apply -f keystone-auth.yaml
```

#### 5.2.2 配置k8s-keystone-auth webhook插件

安装和配置k8s-keystone-auth可参考官方文档[k8s-keystone-auth](https://github.com/kubernetes/cloud-provider-openstack/blob/master/docs/using-keystone-webhook-authenticator-and-authorizer.md)

安装完后验证webhook认证结果:

```bash
#!/bin/bash
keystone_auth_service_addr=$(kubectl get svc keystone-auth -o jsonpath={.spec.clusterIP})
token=$(openstack token issue -f shell | awk -F '=' '/^id=.*/{print $2}' | tr -d '"')
cat <<EOF | curl -ks -XPOST -d @- https://${keystone_auth_service_addr}:8443/webhook | python -mjson.tool
{
  "apiVersion": "authentication.k8s.io/v1beta1",
  "kind": "TokenReview",
  "metadata": {
    "creationTimestamp": null
  },
  "spec": {
    "token": "$token"
  }
}
EOF
```

输出如果`authenticated": true`则说明认证成功。

当然也可以验证webhook的授权，如验证k8s-viewer是否具有list pods权限:

```
keystone_auth_service_addr=$(kubectl get svc keystone-auth -o jsonpath={.spec.clusterIP})
cat <<EOF | curl -ks -XPOST -d @- https://${keystone_auth_service_addr}:8443/webhook | python -mjson.tool
{
  "apiVersion": "authorization.k8s.io/v1beta1",
  "kind": "SubjectAccessReview",
  "spec": {
    "resourceAttributes": {
      "namespace": "default",
      "verb": "list",
      "group": "",
      "resource": "pods"
    },
    "user": "k8s-viewer",
    "group": ["423d41d3a02f4b77b4a9bbfbc3a1b3c6"],
    "extra": {
        "alpha.kubernetes.io/identity/project/id": ["7c266ba4f14d4a64bda0b6b562f2cd60"],
        "alpha.kubernetes.io/identity/project/name": ["int32bit-kubernetes"],
        "alpha.kubernetes.io/identity/roles": ["k8s-viewer"]
    }
  }
}
EOF
```

如果输出`"allowed": true`，则说明具有list pods权限。

#### 5.2.3 配置Kubernetes使用keystone webhook

按照官方文档，创建webhook conf文件:

```yaml
keystone_auth_service_addr=$(kubectl get svc keystone-auth -o jsonpath={.spec.clusterIP})
cat <<EOF > /etc/kubernetes/pki/webhookconfig.yaml
---
apiVersion: v1
kind: Config
preferences: {}
clusters:
  - cluster:
      insecure-skip-tls-verify: true
      server: https://${keystone_auth_service_addr}:8443/webhook
    name: webhook
users:
  - name: webhook
contexts:
  - context:
      cluster: webhook
      user: webhook
    name: webhook
current-context: webhook
EOF
```

修改api-server配置文件:

```
sed -i '/image:/ i \ \ \ \ - --authentication-token-webhook-config-file=/etc/kubernetes/pki/webhookconfig.yaml' /etc/kubernetes/manifests/kube-apiserver.yaml
sed -i '/image:/ i \ \ \ \ - --authorization-webhook-config-file=/etc/kubernetes/pki/webhookconfig.yaml' /etc/kubernetes/manifests/kube-apiserver.yaml
sed -i "/authorization-mode/c \ \ \ \ - --authorization-mode=Node,Webhook,RBAC" /etc/kubernetes/manifests/kube-apiserver.yaml
```

如上开启了基于Webhook授权功能，如果仅使用Keystone认证而不使用Keystone授权，可以不开启。

#### 5.2.4 使用Keystone认证

下载webhook插件，用于请求认证时获取keystone token：

```sh
curl -sSL https://api.nz-por-1.catalystcloud.io:8443/v1/AUTH_b23a5e41d1af4c20974bf58b4dff8e5a/lingxian-public/client-keystone-auth -o ~/keystone/client-keystone-auth
chmod +x ~/keystone/client-keystone-auth
```

通过如下脚本生成kubeconfig文件:

```bash
#!/bin/bash
kubectl config set-cluster "int32bit-kubernetes" \
  --certificate-authority="/etc/kubernetes/pki/ca.crt" \
  --server https://192.168.193.172:6443 \
  --embed-certs=true \
  --kubeconfig=keystone@int32bit-kubernetes.config

kubectl config set-credentials keystone \
  --kubeconfig keystone@int32bit-kubernetes.config
sed -i '/user: {}/ d' keystone@int32bit-kubernetes.config
cat <<EOF >> keystone@int32bit-kubernetes.config
  user:
    exec:
      command: "/root/keystone/client-keystone-auth"
      apiVersion: "client.authentication.k8s.io/v1beta1"
EOF
kubectl config set-context \
  --cluster=int32bit-kubernetes \
  --user=keystone keystone@int32bit-kubernetes \
  --namespace=default --kubeconfig keystone@int32bit-kubernetes.config
cp keystone@int32bit-kubernetes.config \
  ~/users-credentials/credentials/
```

配置完后就可以通过Keystone实现认证了。

```bash
# cat k8s_viewere_openrc
export OS_DOMAIN_NAME=Default
export OS_USERNAME=k8s-viewer
export OS_PASSWORD=noMoreSecret
export OS_PROJECT_NAME=int32bit-kubernetes
export OS_USER_DOMAIN_NAME=Default
export OS_PROJECT_DOMAIN_NAME=Default
export OS_AUTH_URL=http://192.168.193.77:5000/v3
export OS_IDENTITY_API_VERSION=3
# source k8s_viewere_openrc
# kubectl get pod nginx-7cfc94d94-w8tpl
NAME                    READY   STATUS    RESTARTS   AGE
nginx-7cfc94d94-w8tpl   1/1     Running   0          13d
# kubectl delete pod nginx-7cfc94d94-w8tpl
Error from server (Forbidden): pods "nginx-7cfc94d94-w8tpl" is forbidden: User "k8s-viewer" cannot delete resource "pods" in API group "" in the namespace "default"
```

可见k8s-viewer用户可以查看pod但没有删除pod的权限。

```bash
# cat k8s_admin_openrc
export OS_DOMAIN_NAME=Default
export OS_USERNAME=k8s-admin
export OS_PASSWORD=noMoreSecret
export OS_PROJECT_NAME=int32bit-kubernetes
export OS_USER_DOMAIN_NAME=Default
export OS_PROJECT_DOMAIN_NAME=Default
export OS_AUTH_URL=http://192.168.193.77:5000/v3
export OS_IDENTITY_API_VERSION=3
# source  k8s_admin_openrc
# kubectl get pod nginx-7cfc94d94-w8tpl
NAME                    READY   STATUS    RESTARTS   AGE
nginx-7cfc94d94-w8tpl   1/1     Running   0          13d
# kubectl delete pod nginx-7cfc94d94-w8tpl
pod "nginx-7cfc94d94-w8tpl" deleted
```

k8s-admin用户既可以查看pod，也可以删除pod。

我们可以通过kubectl-access_matrix插件查看权限矩阵:

![test keystone](/img/posts/浅聊Kubernetes的各种认证策略以及适用场景/test-keystone.gif)

进一步说明k8s-admin用户具有default namespace的所有权限，而k8s-viewer只具有可读权限。

如果企业已经部署OpenStack，Kubernetes运行在OpenStack平台之上，或者通过Magnum部署，集成Keystone实现Kubernetes认证和授权非常方便，很好地把Kubernetes的认证和授权与OpenStack的认证授权统一管理整合在一块。

### 5.3 使用外部认证系统的优势

对比前面的认证方式，使用OpenID Connect认证以及基于Webhook的认证方式优势显而易见:

* 安全。基于JWT Token交换认证，JWT具有数字签名，可避免伪造。并且相对Service Account JWT，OpenID Connect认证的JWT具有有效期。
* 灵活。身份认证和集群本身是松耦合的，通过IDP配置账户信息不需要Kubernetes干预。
* 认证功能丰富。可使用企业身份系统的MFA、SSO等功能实现更完善更安全的认证策略。

## 6 总结

本文介绍了Kubernetes认证的几种策略，其中：

* 静态密码和静态token认证策略的优点是非常简单，缺点是非常不安全和不灵活，不推荐使用。
* x509证书认证本身的安全性保障没有问题，最大的问题是不支持证书回收，意味着一旦证书颁发出去就很难在回收过来。这种认证策略适合集群内部组件之间的认证通信。
* bootstrap token适合需要临时授权的场景，如集群初始化。
* service account基于JWT认证，JWT包含的字段比较简单，没有有效期和aud字段，存在安全隐患，不适用于普通用户认证，适用于集群内的Pod向api-server认证，如kube-proxy和flannel需要调用api-server监控service和pod的状态变化。
* OpenID Connect(oidc)以及webhook可集成企业已有的身份认证系统，如AD、LDAP，其特点是安全、灵活、功能全面，并且身份认证与Kubernetes集群解耦合，非常适用于普通用户的认证，推荐使用。

## 参考

* https://stackoverflow.com/questions/36919323/how-to-revoke-signed-certificate-in-kubernetes-cluster
* https://www.tremolosecurity.com/kubernetes-dont-use-certificates-for-authentication/
* [Support client certificate revocation](https://github.com/kubernetes/kubernetes/issues/60917)
* [applying-best-practice-security-controls-to-a-kubernetes-cluster](https://blog.giantswarm.io/applying-best-practice-security-controls-to-a-kubernetes-cluster/).
* https://www.openlogic.com/blog/granting-user-access-your-kubernetes-cluster
* https://thenewstack.io/no-more-forever-tokens-changes-in-identity-management-for-kubernetes/
