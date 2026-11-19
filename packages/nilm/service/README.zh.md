# `@deepseek-ai/dsh-nilm-service`

[English](README.md) | 中文

独立 NILM Agent 的后端 BFF。它校验调用方信封，维护会话与本轮记录，通过 `ctx.agents` 驱动已挂载的 Agent，并向调用方应用或小程序后端提供 REST 与 SSE 值。它不提供登录、注册、角色、菜单、微信绑定、管理后台或面向客户的 Web UI；调用方自行认证用户并注入不可变 `CallContext`。

## 配置

所有部署值来自 profile patch 或 `NILM_*` 环境变量：监听地址与端口、会话工作目录、可选的 PVC 会话根目录、分片序号与分片数、模型 provider 与 id、按租户的 HMAC 密钥、时钟偏差、nonce TTL、本轮超时、心跳间隔、请求体上限，以及安全审计队列与批量大小。包内不编译任何数据库地址、密钥或模型 id。

## 端点

| 方法 | 路径 | 行为 |
| :--- | :--- | :--- |
| `POST` | `/v1/conversations` | 创建服务端签发的 `conversationId` |
| `GET` | `/v1/conversations` | 按更新时间倒序列出调用方会话 |
| `GET` | `/v1/conversations/{id}/messages` | 返回调用方可见的用户与助手历史 |
| `POST` | `/v1/turns` | 受理一条消息并返回 `202` 与 `turnId`、`sessionId`、`conversationId`、`streamUrl`；完成后重复提交返回同一轮，处理中的并发重复提交返回 `429 RATE_LIMITED` |
| `GET` | `/v1/turns/{id}/stream` | SSE 流，带单调 id、`Last-Event-ID` 重放与 `ping` 心跳 |
| `POST` | `/v1/turns/{id}/cancel` | 取消当前生成并返回 `204` |
| `GET` | `/v1/alerts` | 挂载 Sentinel 时列出调用方可见告警；否则报告 `available: false` |
| `POST` | `/v1/alerts/{id}/ack` | 确认调用方可见告警并写审计；未挂载 Sentinel 时返回 `DATA_UNAVAILABLE` |
| `GET` | `/healthz`、`/readyz` | 存活与依赖就绪检查 |

## 调用方信封

阶段 1 接受 HMAC-SHA256 信封：`X-Nilm-Tenant-Id`、`X-Nilm-User-Ref`、`X-Nilm-Request-Id`、`X-Nilm-Timestamp`、`X-Nilm-Nonce`、可选的 `X-Nilm-Allowed-Scope` 与 `X-Nilm-Signature`。规范串覆盖方法、路径、请求体摘要与全部上下文头。端点不接受查询参数，带查询参数的请求会被拒绝，避免只签名部分输入。JSON 请求体中的 `tenant_id` 被忽略并审计；Tool 永远拿不到它。

租户与用户头限制为 64 个字符，与会话和审计表字段宽度一致；请求 id 限制为 128 个字符，以约束审计事件与结构化日志体积。超长值会在导致审计整批失败之前被拒绝。

## SSE 重放

`POST /v1/turns` 不直接返回事件流。调用方连接 `streamUrl`，因此断线重连、取消、幂等与审计都锚定稳定的 `turnId`。每轮事件缓冲保存在进程内存；`Last-Event-ID` 重放比客户端检查点更新的事件，`ping` 帧维持空闲连接。

## PVC 状态与分片归属

设置 `sessionsRoot` 后，租户的每个新 Session 以 `<sessionsRoot>/<编码后的租户>` 为工作目录，会话索引位于 `<sessionsRoot>/<编码后的租户>/.nilm/conversations/`。同一 PVC 上的替换 Pod 会重新加载索引、恢复 JSONL Session 并返回持久化历史；JSONL 后端读取时忽略撕裂崩溃尾部，并在首次追加前截断它。`shardIndex` 与 `shardCount` 会在触碰任何会话状态之前，以 `403 SCOPE_FORBIDDEN` 拒绝属于其他分片的已认证租户，因此边缘路由错误不会把租户写到错误的卷上。

## 压测

`pnpm test:perf:load` 驱动 G4-3 负载。目标运行按租户签署每个请求，在 60 秒预热后以 100 个租户、每租户 5 个并发会话持续 30 分钟。默认值是目标运行契约，不是冒烟测试：`--duration 30m`、`--warmup 60s`、`--tenants 100`、`--sessions 5`、均分为单 Tool 查询与多 Tool 分析的 30% Tool 提示占比，以及 30 秒本轮截止时间；`--help` 列出全部覆盖参数。

目标运行缺少 `--target`、`--manifest`、`--output`，或 `NILM_LOAD_SIGNING_SECRETS` 未指向按租户 id 映射签名密钥的 JSON 文件时拒绝启动。脚本也接受内联 JSON 对象。密钥必须与部署一致，且不得进入仓库或报告。

```sh
NILM_LOAD_SIGNING_SECRETS=/secure/load-secrets.json \
pnpm test:perf:load \
  --target https://nilm.example.com \
  --manifest load-dataset.json \
  --tenants-file tenants.json \
  --output g4-3-report.json
```

manifest 声明本次运行允许使用的数据集。覆盖不足或格式错误的声明会在产生流量前被拒绝：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-19T00:00:00.000Z",
  "tenants": 100,
  "minuteDays": 90,
  "secondDays": 7,
  "meteringPointsPerTenant": 5,
  "tenantIds": ["tenant-000", "tenant-001"]
}
```

`tenants` 必须覆盖请求的租户数，`minuteDays` 至少 90，`secondDays` 至少 7，`meteringPointsPerTenant` 至少 5。`--tenants-file` 提供实际租户 id 时，`tenantIds` 必须声明其中每一个；校验后的 manifest 会写入报告。请把报告与 manifest、租户清单、准确命令和时间戳一起归档，因为报告是唯一持久化输出。

报告测量以下观测：

| 观测项 | 通过条件 |
| :--- | :--- |
| 首流事件 p95 | 从 `POST /v1/turns` 发起到首个非 `ping` SSE 帧 `< 300 ms`；包含建轮开销 |
| 无 Tool 首字 p95 | 无观测 Tool 的完成轮次，从本轮开始到首个 `text.delta` 或 `text.done` `< 1.5 s` |
| 含 Tool 端到端 p95 / p99 | 观测到 `tool.start` 的轮次，从本轮开始到 `done` `< 8 s` / `< 12 s` |
| HTTP 5xx 错误率 | 压测 harness 发出的全部请求 `< 0.5%` |
| 轮次错误率 | 已测量轮次 `< 0.5%`；完成轮次以 `done` 结束且无错误帧 |
| 传输失败 | `0` |
| 租户隔离 | `0` 泄漏；每个声明租户都执行消息读取与会话列表探测 |
| 负载形状与窗口 | 至少 100 租户 x 5 会话，且至少 30 个实测分钟 |
| 提示场景覆盖 | 无 Tool、单 Tool 与多 Tool 提示各至少 20 个实测轮次 |

Tool 轮次只按观测到的 `tool.start` 分类；提示要求分析但未产生 Tool 调用的轮次不计入 Tool 样本。报告同时统计观测到的 Tool 调用数，使运维人员能区分“Tool 提示没有触发调用”和“目标从未被要求使用 Tool”。每个延迟与场景门禁至少需要 20 个样本；样本不足报告 `insufficient` 或 `fail`，绝不算通过。仅当全部门禁通过时进程退出 `0`，门禁失败退出 `1`，用法或配置错误退出 `2`。

隔离阶段在测量窗口之后运行。另一租户读取每个受害会话并列出自己的会话；读取必须返回 `401`、`403` 或 `404`，列表不得包含受害会话 id。

`pnpm test:perf:load --self-check --output /tmp/perf-self-check.json` 在内存会话存储与合成 Agent 上启动真实 BFF，覆盖签名、HTTP、SSE、轮次调度与隔离探测，不接触模型、数据库或集群。其报告标记为 `self-check`，不包含 G4-3 门禁，且 `evidence` 字段声明它不是 G4-3 证据。自检不能替代目标报告。

## 安全测试

`pnpm test:security:pentest` 执行版本化 `4.4.1` 攻击语料。32 个用例覆盖四层：伪造或重放的 BFF 信封与跨租户读取、SELECT-only SQL 守卫、模型提供的 Tool 参数（未声明的权限字段以 `INVALID_ARGS` 拒绝），以及不可变 `CallContext`。

认证失败写 `auth.rejected`；其余拒绝写 `request.rejected`，仅在身份校验已通过时携带已认证租户。携带 `INVALID_ARGS`、`SCOPE_FORBIDDEN` 或租户上下文不可用的 Tool 失败写 `tool.rejected`；SQL 守卫在驱动接触语句前写 `sql.rejected`。审计记录不包含请求体、模型提示词、手机号、OpenID、签名或 Token。插件日志消息经过 `redactText`，结构化审计值经过 `redactValue`，将中国大陆手机号掩码为 `138****0000`，并掩码带标签或裸 OpenID、Bearer 凭证、API Key 与 `v1=` 签名。套件断言每个声明用例都已执行，删除或改名用例会使测试失败。

Tool 边界拒绝携带已绑定的 `CallContext` 租户、用户、请求与会话，并使用与 BFF 相同的共享 `nilmAudit` sink。SQL 守卫自身的 `sql.rejected` 事件仍只写结构化日志，因为 source 适配器没有已验证的调用方身份；当 SQL 拒绝穿过 Tool 边界时，会以该 Tool 的 `tool.rejected` 行落库。

在 NILM app profile 中，每个 BFF 审计事件还会进入 `nilm_security_audit` 写入队列。`NILM_AUDIT_QUEUE_SIZE`（默认 `1024`）限制队列长度，`NILM_AUDIT_BATCH_SIZE`（默认 `64`）设置单事务行数。队列满时丢弃最新事件；事务失败时记录批量大小后丢弃该批。事件不重试，因此脱敏后的结构化日志仍是兜底证据。认证失败使用 `tenant_id = __unverified__`，因为彼时没有已验证租户；未认证的 Header 值不会写入；`__unverified__` 为保留值，`signingSecrets` 中会被拒绝。

离线证据止于拦截、审计事件产生与进程内持久化假实现。它不证明生产日志留存、KMS 数据库加密、审计保留一年的承诺或模型供应商侧处理。Session 按设计保留模型可见的用户问题，因此不能用“原始问题不存在”满足 G4-4；生产评审必须展示 Session 访问控制与加密、受审计的日志汇，以及持久化的 `nilm_security_audit` 存储。G4-4 仍需完成该评审并确认无 Critical/High 遗留。

## 已知限制与延期工作

- 阶段 1 未实现 mTLS，只接受 HMAC 信封。生产接入仍需补齐概要设计要求的 mTLS 路径。
- nonce 缓存、幂等映射与本轮缓冲仍为进程内状态。重启会丢失进行中的 SSE 缓冲与 `clientMessageId` 去重；同一租户由多个副本同时服务前，仍需 Redis nonce 与共享幂等记录。
- 只有配置 `sessionsRoot` 时会话元数据才持久化；未配置时 BFF 保留阶段 1 的进程内索引。MySQL `nilm_conversation` 表尚未接入，PVC 索引是当前的重启路径。
- 分片数变更与租户迁移属于部署操作。BFF 会拒绝非归属分片上的租户，但从不迁移 Session 文件，也不承诺跨分片漂移恢复。
- 离线测试覆盖租户目录布局、会话重载、撕裂尾部读取与 Session 写入互斥。真实 StatefulSet SIGKILL 与 PVC 重挂仍需集群演练。
- 每轮缓冲与幂等记录在进程生命周期内保留；阶段 1 尚未实现淘汰或归档策略。
- 审计记录经进程内脱敏后写入插件日志，并通过有界尽力队列写入 `nilm_security_audit`。BFF 与已绑定租户的 Tool 拒绝共享该 sink；SQL 守卫事件仍只写日志。队列溢出与数据库失败会在记录数量后丢弃事件；尚无重试、Outbox 或保留策略。生产日志汇留存与 KMS 加密证据仍待补齐。
- 告警列表与确认委托给 `nilmSentinel`；该插件未挂载时按设计保持不可用。在签名请求契约接受查询参数前，不提供分页。
- G4-3 harness 仅有离线测试。尚未产出 100 租户 x 5 会话、30 分钟的目标报告；自检验证的是 harness，不是服务容量。
- G4-4 攻击语料仅在离线运行。生产日志审查、KMS/AES-GCM 验证、审计存储留存与无 Critical/High 的安全结论仍待完成。
