# `@deepseek-ai/dsh-nilm-service`

[English](README.md) | 中文

独立 NILM Agent 的后端 BFF。它校验调用方信封，维护会话与本轮记录，通过 `ctx.agents` 驱动已挂载的 Agent，并向调用方应用或小程序后端提供 REST 与 SSE 值。它不提供登录、注册、角色、菜单、微信绑定、管理后台或面向客户的 Web UI；调用方自行认证用户并注入不可变 `CallContext`。

## 配置

所有部署值来自 profile patch 或 `NILM_*` 环境变量：监听地址与端口、会话工作目录、可选的 PVC 会话根目录、分片序号与分片数、模型 provider 与 id、按租户的 HMAC 密钥、时钟偏差、nonce TTL、本轮超时、心跳间隔与请求体上限。包内不编译任何数据库地址、密钥或模型 id。

## 端点

| 方法 | 路径 | 行为 |
| :--- | :--- | :--- |
| `POST` | `/v1/conversations` | 创建服务端签发的 `conversationId` |
| `GET` | `/v1/conversations` | 按更新时间倒序列出调用方会话 |
| `GET` | `/v1/conversations/{id}/messages` | 返回调用方可见的用户与助手历史 |
| `POST` | `/v1/turns` | 受理一条消息并返回 `202` 与 `turnId`、`sessionId`、`conversationId`、`streamUrl`；重复 `clientMessageId` 返回同一轮 |
| `GET` | `/v1/turns/{id}/stream` | SSE 流，带单调 id、`Last-Event-ID` 重放与 `ping` 心跳 |
| `POST` | `/v1/turns/{id}/cancel` | 取消当前生成并返回 `204` |
| `GET` | `/v1/alerts` | 挂载 Sentinel 时列出调用方可见告警；否则报告 `available: false` |
| `POST` | `/v1/alerts/{id}/ack` | 确认调用方可见告警并写审计；未挂载 Sentinel 时返回 `DATA_UNAVAILABLE` |
| `GET` | `/healthz`、`/readyz` | 存活与依赖就绪检查 |

## 调用方信封

阶段 1 接受 HMAC-SHA256 信封：`X-Nilm-Tenant-Id`、`X-Nilm-User-Ref`、`X-Nilm-Request-Id`、`X-Nilm-Timestamp`、`X-Nilm-Nonce`、可选的 `X-Nilm-Allowed-Scope` 与 `X-Nilm-Signature`。规范串覆盖方法、路径、请求体摘要与全部上下文头。端点不接受查询参数，带查询参数的请求会被拒绝，避免只签名部分输入。JSON 请求体中的 `tenant_id` 被忽略并审计；Tool 永远拿不到它。

## SSE 重放

`POST /v1/turns` 不直接返回事件流。调用方连接 `streamUrl`，因此断线重连、取消、幂等与审计都锚定稳定的 `turnId`。每轮事件缓冲保存在进程内存；`Last-Event-ID` 重放比客户端检查点更新的事件，`ping` 帧维持空闲连接。

## PVC 状态与分片归属

设置 `sessionsRoot` 后，租户的每个新 Session 以 `<sessionsRoot>/<编码后的租户>` 为工作目录，会话索引位于 `<sessionsRoot>/<编码后的租户>/.nilm/conversations/`。同一 PVC 上的替换 Pod 会重新加载索引、恢复 JSONL Session 并返回持久化历史；JSONL 后端读取时忽略撕裂崩溃尾部，并在首次追加前截断它。`shardIndex` 与 `shardCount` 会在触碰任何会话状态之前，以 `403 SCOPE_FORBIDDEN` 拒绝属于其他分片的已认证租户，因此边缘路由错误不会把租户写到错误的卷上。

## 已知限制与延期工作

- 阶段 1 未实现 mTLS，只接受 HMAC 信封。生产接入仍需补齐概要设计要求的 mTLS 路径。
- nonce 缓存、幂等映射与本轮缓冲仍为进程内状态。重启会丢失进行中的 SSE 缓冲与 `clientMessageId` 去重；同一租户由多个副本同时服务前，仍需 Redis nonce 与共享幂等记录。
- 只有配置 `sessionsRoot` 时会话元数据才持久化；未配置时 BFF 保留阶段 1 的进程内索引。MySQL `nilm_conversation` 表尚未接入，PVC 索引是当前的重启路径。
- 分片数变更与租户迁移属于部署操作。BFF 会拒绝非归属分片上的租户，但从不迁移 Session 文件，也不承诺跨分片漂移恢复。
- 离线测试覆盖租户目录布局、会话重载、撕裂尾部读取与 Session 写入互斥。真实 StatefulSet SIGKILL 与 PVC 重挂仍需集群演练。
- 每轮缓冲与幂等记录在进程生命周期内保留；阶段 1 尚未实现淘汰或归档策略。
- 安全审计当前以结构化文本写入插件日志；`nilm_security_audit` 持久化随审计存储集成交付。
- 告警列表与确认委托给 `nilmSentinel`；该插件未挂载时按设计保持不可用。在签名请求契约接受查询参数前，不提供分页。
