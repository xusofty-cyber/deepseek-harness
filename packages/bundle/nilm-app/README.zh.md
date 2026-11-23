# `@deepseek-ai/dsh-nilm-app`

[English](README.md) | 中文

独立 NILM 生产 profile。`cordis.patch.yml` 是完整的 Cordis 配置树，而不是 `dsh-base` 上的覆盖层。它挂载模型、会话、工具注册表、Agent Loop、NILM context/source/assets/timeseries/tariff/analytics/safety 服务、巡检规则引擎、通知 Outbox、NILM 提示词策略、6 个面向模型的 `nilm_*` 工具、`nilm-service` HTTP/SSE BFF 与启动时的工具面守卫。Shell、文件系统、Web、MCP、终端、sandbox、subagent、附件、凭据与插件管理行均不存在。

## 配置

所有端点与凭据来自 `NILM_*` 环境变量或部署方拥有的 profile patch。仓库不内嵌数据库地址、账号或密码。`NILM_DEEPSEEK_API_KEY` 选择模型凭据；数据源服务独立读取五个端点族。

该 profile 是 `@deepseek-ai/dsh-official-bundles` 中的随附模板，因此 `dsh --profile nilm` 会从 `@deepseek-ai/dsh-nilm-app` 初始化它。阶段 3 还读取 `NILM_SENTINEL_*`、`NILM_ALERT_TEMPLATES`、`NILM_SOURCE_TENANT_ID` 与 `NILM_NOTIFY_*`；渠道网关 URL 与令牌在供应商签约前保持为空，此时渠道挂载为未配置并直接进入死信而不重试。

## 阶段 1 启动

生产树挂载 BFF，而不是 stdio JSON-RPC 载体。必需部署值包括 `NILM_*` 数据源端点、`NILM_SOURCE_TENANT_ID`、`NILM_DEEPSEEK_API_KEY` 与 `NILM_SIGNING_SECRETS`（租户 id 到 HMAC 密钥的 JSON 对象）。BFF 监听 `NILM_SERVICE_HOST:NILM_SERVICE_PORT`，暴露 `/healthz` 与 `/readyz`；调用方流量使用 [`nilm-service`](../../nilm/service/README.zh.md) 文档定义的签名 REST/SSE 协议。

## 已知限制与延期工作

- BFF 的 nonce 缓存、幂等映射与本轮缓冲保存在进程内存；重启会丢失进行中的 SSE 缓冲与 `clientMessageId` 去重。
- 配置 `NILM_SESSIONS_ROOT` 后，会话索引与 Session JSONL 位于分片 PVC，`NILM_SHARD_COUNT` 必须与 StatefulSet 副本数一致。同一租户由多个在线副本服务前，仍需 Redis nonce 与共享幂等记录；详见 service 的已知限制。
- mTLS 与 `nilm_security_audit` 持久化尚未包含在阶段 1 BFF 中。
- `mysql2` 是 `@deepseek-ai/dsh-nilm-source` 的可选 peer；部署镜像必须在 MySQL 探活或生产查询运行前安装兼容版本。
- Sentinel 与 notify 已挂载，但 30 秒 SLO、真实 `SKIP LOCKED` 竞争与微信/企微/短信供应商联调仍需使用真实端点分阶段演练。
