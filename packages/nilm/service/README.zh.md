# `@deepseek-ai/dsh-nilm-service`

[English](README.md) | 中文

独立 NILM Agent 的后端 BFF。它校验调用方信封，维护会话与本轮记录，通过 `ctx.agents` 驱动已挂载的 Agent，并向调用方应用或小程序后端提供 REST 与 SSE 值。它不提供登录、注册、角色、菜单、微信绑定、管理后台或面向客户的 Web UI；调用方自行认证用户并注入不可变 `CallContext`。

## 配置

所有部署值来自 profile patch 或 `NILM_*` 环境变量：监听地址与端口、会话工作目录、模型 provider 与 id、按租户的 HMAC 密钥、时钟偏差、nonce TTL、本轮超时、心跳间隔与请求体上限。包内不编译任何数据库地址、密钥或模型 id。

## 端点

| 方法 | 路径 | 行为 |
| :--- | :--- | :--- |
| `POST` | `/v1/conversations` | 创建服务端签发的 `conversationId` |
| `GET` | `/v1/conversations` | 按更新时间倒序列出调用方会话 |
| `GET` | `/v1/conversations/{id}/messages` | 返回调用方可见的用户与助手历史 |
| `POST` | `/v1/turns` | 受理一条消息并返回 `202` 与 `turnId`、`sessionId`、`conversationId`、`streamUrl`；重复 `clientMessageId` 返回同一轮 |
| `GET` | `/v1/turns/{id}/stream` | SSE 流，带单调 id、`Last-Event-ID` 重放与 `ping` 心跳 |
| `POST` | `/v1/turns/{id}/cancel` | 取消当前生成并返回 `204` |
| `GET` | `/v1/alerts` | 阶段 1 骨架，报告空且不可用的存储 |
| `POST` | `/v1/alerts/{id}/ack` | 在 Sentinel 存储就绪前返回 `DATA_UNAVAILABLE` |
| `GET` | `/healthz`、`/readyz` | 存活与依赖就绪检查 |

## 调用方信封

阶段 1 接受 HMAC-SHA256 信封：`X-Nilm-Tenant-Id`、`X-Nilm-User-Ref`、`X-Nilm-Request-Id`、`X-Nilm-Timestamp`、`X-Nilm-Nonce`、可选的 `X-Nilm-Allowed-Scope` 与 `X-Nilm-Signature`。规范串覆盖方法、路径、请求体摘要与全部上下文头。端点不接受查询参数，带查询参数的请求会被拒绝，避免只签名部分输入。JSON 请求体中的 `tenant_id` 被忽略并审计；Tool 永远拿不到它。

## SSE 重放

`POST /v1/turns` 不直接返回事件流。调用方连接 `streamUrl`，因此断线重连、取消、幂等与审计都锚定稳定的 `turnId`。每轮事件缓冲保存在进程内存；`Last-Event-ID` 重放比客户端检查点更新的事件，`ping` 帧维持空闲连接。

## 已知限制与延期工作

- 阶段 1 未实现 mTLS，只接受 HMAC 信封。生产接入仍需补齐概要设计要求的 mTLS 路径。
- nonce 缓存、会话元数据、幂等映射与本轮缓冲均为进程内状态。重启会丢失会话列表与归属映射，第二个副本无法重放或去重另一副本的工作。多副本部署前需要 Redis nonce 与 `nilm_conversation` 持久化。
- 每轮缓冲与幂等记录在进程生命周期内保留；阶段 1 尚未实现淘汰或归档策略。
- 安全审计当前以结构化文本写入插件日志；`nilm_security_audit` 持久化随审计存储集成交付。
- 告警路由是只读骨架。真实告警列表与确认等待阶段 3 的 Sentinel 存储。
