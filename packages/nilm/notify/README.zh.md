# `@deepseek-ai/dsh-nilm-notify`

[English](README.md) | 中文

通过 MySQL Outbox 投递已确认告警，并异步补充研判。投递不依赖模型：诊断缓慢或失败都不会延迟或回滚通知。

## Configuration

`pollIntervalMs`、`batchSize`、`leaseMs`、`channelTimeoutMs`、`retentionDays` 与 `workerId` 控制调度器。`wxSubscribeUrl`、`wxTemplateUrl`、`wecomWebhookUrl` 与 `smsUrl` 为各渠道选择服务商网关；对应的 `*Token` 字段附加 Bearer 令牌。未配置 URL 的渠道挂载为 `UnconfiguredChannelTransport`，直接进入死信而不重试。

`enrichProvider`、`enrichModel`、`enrichPromptVersion`、`enrichTimeoutMs`（默认 8 秒）、`enrichConcurrency` 与 `enrichCwd` 控制诊断。`enrichModel` 留空时关闭富化，但投递继续工作。

## Extension points

`NotifyDependencies` 可替换 Outbox 存储、渠道传输、诊断 Agent、fetch 实现与时钟。`ChannelTransport` 是唯一必需的适配接缝：新供应商实现 `send(task, signal)`，返回供应商消息 ID，或抛出带重试分类的 `DeliveryFailureError`。`DiagnosisAgent` 把 Cordis 短生命周期会话与队列行为分开。

网关请求只包含加密接收方材料、掩码提示、确定性模板参数与 `notificationId`，不包含明文接收方或供应商凭证。

## Known Limitations and Deferred Work

- 网关契约已固定，但尚未接入真实微信、企微或短信供应商；短信供应商仍待 D-12 决策。
- 离线测试已证明重试、死信、富化超时与去重行为。真实 `SKIP LOCKED` 竞争、网关时延与端到端 30 秒 SLO 仍需分阶段演练。
- 投递语义为至少一次。供应商已接收但 `markSent` 前崩溃可能重复发送；客户端按 `notificationId` 去重。
- 仅当 `agent_diagnosis` 仍为空且告警未终结时才写入富化结果，迟到的模型结果会被丢弃。
- 诊断超时保留确定性摘要；本阶段不安排富化重试。
