---
description: "以分片 StatefulSet 部署 nilm-agent，创建 Secret、核对 PVC 拓扑并演练同分片 Session 恢复。G4-2 现场证据门尚未在真实集群演练。"
---

# NILM agent Kubernetes 部署

[English](README.md) | 中文

这些清单让每个租户分片运行一个 `nilm-agent` Pod。每个 Pod 独占一个挂载到 `/data` 的 ReadWriteOnce PVC，边缘网关把租户路由到其 PVC 持有该租户 Session 日志的 Pod。BFF 在验签后拒绝错误分片的租户，因此路由缺陷不会把租户写入他人的 PVC。

## 文件

| 文件 | 用途 |
| --- | --- |
| `namespace.yaml` | 创建 `nilm` 命名空间。 |
| `secret.example.yaml` | 签名密钥、模型密钥与数据源凭证的占位 Secret；禁止原样应用。 |
| `configmap.yaml` | 非敏感配置，包含 `NILM_SHARD_COUNT`。 |
| `headless-service.yaml` | 每个 Pod 的 DNS `nilm-agent-<i>.nilm-agent-headless`。 |
| `edge-service.yaml` | 平台边缘网关使用的无选择器端点载体。 |
| `statefulset.yaml` | 四个分片、`OrderedReady`、一个 PVC 模板。 |
| `pdb.yaml` | 可用率 75% 的 PodDisruptionBudget。 |
| `networkpolicy.yaml` | 默认拒绝，另放行 DNS、边缘入站与数据源出站。 |
| `ingress.yaml` | TLS 与 `/v1` 到边缘网关的路由。 |

## 部署顺序

```sh
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f /path/to/private/nilm-secrets.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/headless-service.yaml -f deploy/k8s/edge-service.yaml
kubectl apply -f deploy/k8s/statefulset.yaml
kubectl apply -f deploy/k8s/pdb.yaml -f deploy/k8s/networkpolicy.yaml
kubectl apply -f deploy/k8s/ingress.yaml
```

在仓库外复制 `secret.example.yaml` 并替换每个占位符来构造私有 Secret；应用该私有文件，且不得提交它。`NILM_SIGNING_SECRETS` 是以租户 id 为键的 JSON 对象，每个值至少 16 个字符。

应用前必须替换镜像标签、Ingress 主机与 TLS Secret 名称，以及 `networkpolicy.yaml` 中的 `REPLACE_WITH_*_CIDR` 占位符。Pod 通过 TCP 443 访问模型供应商，并通过列出的端口访问数据源；其余流量保持拒绝。

平台网关运行在 `nilm` 命名空间之外时，需要把该命名空间的选择器同时加入 `allow-edge-ingress` 与 `nilm-agent` 入站规则。单独的 `podSelector` 只匹配策略所在命名空间；否则即使 Endpoints 已绑定到 `nilm-edge`，默认拒绝策略仍会阻断网关。

## 数据库账号

每个 MySQL 端点使用单独的账号，只授予代码需要的权限。应用层守卫会在只读路径上拒绝非 SELECT 语句，但账号权限才是守卫被绕过时仍然有效的边界。

- 上游业务 MySQL（`NILM_UPSTREAM_MYSQL_*`）：只授予 `nilm_unsafe_record` 与 `appliance_category` 两张表的 `SELECT`。不授予写入、DDL 或整库权限。
- 项目 MySQL（`NILM_LOCAL_MYSQL_*`）：授予项目库的 `SELECT`、`INSERT`、`UPDATE`、`DELETE`。写事务会更新告警、通知、水位、作业、报告和审计表。不授予 `CREATE`、`ALTER`、`DROP`、`GRANT OPTION` 或全局权限；`packages/nilm/source/sql/init-nilm-system.sql` 用单独的迁移账号执行。
- `information_schema.tables` 不需要授权；MySQL 只返回该账号可访问的表，连通性探测正是据此检查。
- TDengine 用户（`NILM_UPSTREAM_TDENGINE_USER`）同样应只有热数据库和统计数据库的读权限。

```sql
-- Upstream business database: read two tables only.
CREATE USER 'nilm_upstream_ro'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT ON upstream_db.nilm_unsafe_record TO 'nilm_upstream_ro'@'10.0.0.%';
GRANT SELECT ON upstream_db.appliance_category TO 'nilm_upstream_ro'@'10.0.0.%';

-- Project database: data reads and writes, no DDL.
CREATE USER 'nilm_app'@'10.0.0.%' IDENTIFIED BY '<password>';
GRANT SELECT, INSERT, UPDATE, DELETE ON nilm_db.* TO 'nilm_app'@'10.0.0.%';
```

替换 `upstream_db`、`nilm_db`、主机模式（Pod 出站 CIDR）和密码。把凭据写入私有 Secret 前，先用 `SHOW GRANTS FOR 'nilm_upstream_ro'@'10.0.0.%';` 核对结果。

## 分片数与 PVC 拓扑

`configmap.yaml` 的 `NILM_SHARD_COUNT` 必须等于 `statefulset.yaml` 的 `spec.replicas`。bundle 从 `NILM_POD_NAME` 末尾序号推导 `NILM_SHARD_INDEX`；两者不一致会让部分租户无法路由，或被路由到以 `403 SCOPE_FORBIDDEN` 拒绝它们的 Pod。应用 ConfigMap 前必须把 `NILM_SOURCE_TENANT_ID` 替换为在 `nilm_source_tenant_map` 中有映射的上游租户键；缺少映射时 Sentinel 拒绝扫描。

每个 Pod 把自己的 `data` 卷挂载到 `/data`，JSONL 后端写入 `/data/sessions/<编码后的租户>`。会话索引位于 `/data/sessions/<编码后的租户>/.nilm/conversations`。卷是 ReadWriteOnce，重新调度的 Pod 必须等卷从旧节点卸载后才能启动。

容器以只读根文件系统运行，且 `dsh` 每次启动都会重写 profile 根，因此 `DSH_HOME` 与 `HOME` 指向 `/data`。镜像必须包含 `dsh` 安装与 `@deepseek-ai/dsh-nilm-app` bundle；首次启动的 profile 初始化不得依赖软件包下载。

检查集群默认 StorageClass 是否使用 `WaitForFirstConsumer`：

```sh
kubectl get storageclass -o custom-columns=NAME:.metadata.name,DEFAULT:.metadata.annotations.storageclass\\.kubernetes\\.io/is-default-class,BINDING:.volumeBindingMode
```

`Immediate` 类可能在 Pod 调度前把 PVC 绑定到其他可用区，使重新调度的 Pod 一直 Pending。请显式指定 `WaitForFirstConsumer` 类，或把 Pod 固定到卷所在节点；该检查通过前不得依赖恢复能力。

## 租户迁移与排空

路由函数是对分片数取模的 MurmurHash3 x86-32，不是一致性哈希环。修改 `NILM_SHARD_COUNT` 或 `replicas` 会重映射一部分租户，因此变更分片数属于迁移，不是普通滚动重启。

1. 离线用 `shardForTenant` 计算每个租户的旧分片与新分片。
2. 停止索引变化租户的边缘流量；让进行中的轮次完成，或在截止时间前取消。
3. 旧 Pod 停止后在 PVC 之间复制租户目录；同一个租户不得有两个写入者。
4. 校验复制后的 JSONL 可读，且最后已持久化的轮次仍在。
5. 滚动新的分片数，然后恢复边缘流量。

系统不提供在线双写，也不提供跨分片漂移恢复。落到没有该租户 Session 的 PVC 上时，租户会被拒绝，而不是静默开始一个空会话。

## G4-2 恢复演练

演练在对话生成中途终止 Pod，检查 StatefulSet 在同一 PVC 上重建同一序号、JSONL 尾部被安全处理、下一轮能延续会话。该演练尚未在真实集群执行；`packages/nilm/service/tests/recovery.spec.ts` 的离线用例只是部分证据。

```sh
TENANT=REPLACE_TENANT
COUNT=$(kubectl -n nilm get statefulset nilm-agent -o jsonpath='{.spec.replicas}')
SHARD=$(node -e "import('./packages/nilm/sharding/src/index.ts').then(m => console.log(m.shardForTenant(process.argv[1], Number(process.argv[2]))))" "$TENANT" "$COUNT")
POD=nilm-agent-$SHARD
kubectl -n nilm get pod "$POD" -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl -n nilm get pvc "data-$POD-0" -o jsonpath='{.spec.volumeName}{"\n"}'
kubectl -n nilm delete pod "$POD" --grace-period=0 --force
kubectl -n nilm wait --for=condition=Ready "pod/$POD" --timeout=300s
kubectl -n nilm get pod "$POD" -o jsonpath='{.spec.nodeName}{"\n"}'
kubectl -n nilm get pvc "data-$POD-0" -o jsonpath='{.spec.volumeName}{"\n"}'
```

在仓库根目录用 Node 24 或更高版本运行分片计算；类型剥离直接导入源码函数。记录终止前后的 Pod 节点与 PVC 卷名。卷名必须保持一致；本地卷或区域卷还必须保持同一节点。随后通过 BFF 读取会话历史并发送下一轮；历史必须包含终止前已完成的事件，新一轮必须持久化。JSONL 最后一行若为撕裂行会在读取时丢弃，因此尚未提交事件的轮次预期缺失。还要在生成过程中强制终止，而不只在空闲时演练。

## 证据状态

清单、分片函数、租户路径编码、会话索引与撕裂尾部读取均有离线测试。真实 SIGKILL、PVC 重挂、边缘路由与节点亲和尚未在此演练。在目标集群用上述命令取得节点、卷与历史输出之前，不得声称 G4-2 通过。
