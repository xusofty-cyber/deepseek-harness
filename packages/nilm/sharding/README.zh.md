# `@deepseek-ai/dsh-nilm-sharding`

[English](README.md) | 中文

把已认证的租户 id 映射到唯一的 NILM StatefulSet 分片。映射对租户 id 的 UTF-8 字节执行 MurmurHash3 x86-32，再按分片数取模。边缘网关与承载 Pod 使用同一个函数，因此 Pod 可以拒绝属于其他 PVC 的租户，而不是损坏 Session 日志。

## 路由契约

`shardForTenant(tenantId, shardCount)` 在同一租户、同一分片数下保持稳定。`resolveShardAssignment(index, count)` 校验单个 Pod 的分片成员关系，并默认单分片部署。`shardPodName(prefix, index)` 返回 StatefulSet 序号名称，例如 `nilm-agent-3`。

该函数是取模哈希而非一致性哈希环。增加或减少分片会重映射一部分租户，因此变更分片数必须安排排空、归档与租户迁移窗口；本包从不迁移 Session 数据，也从不允许同一租户出现两个写入者。

## 已知限制与延期项

- 本包只提供纯路由契约。它不运行 HTTP 代理、不监听 Kubernetes endpoints、不搬运 PVC 数据；部署清单与边缘网关负责这些步骤。
- 未迁移就修改分片数时，部分租户会被映射到不持有其 Session 的 Pod。`nilm-service` 会以 `SCOPE_FORBIDDEN` 拒绝该租户并写审计，不会回退到其他分片。
- 不承诺跨分片漂移恢复。租户必须在旧 Pod 排空后迁移；设计不承诺在线双写。
