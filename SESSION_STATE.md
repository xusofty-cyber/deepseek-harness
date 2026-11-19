# Session: 2026-11-19

**Started:** 2026-11-19 (Asia/Shanghai)
**Last Updated:** 2026-11-19 11:00 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 阶段 4.4 补强：BFF 安全审计写入 `nilm_security_audit`（离线部分）

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。阶段 1/2/3、4.1、4.2、4.3、4.4 已提交；基线提交为 `29eacd914b`。

本轮补齐 G4-4 的离线审计落库缺口：BFF 审计事件不再只写 logger，还经有界异步队列批量写入 `nilm_security_audit`。G4-4 现场门仍开放：真实 MySQL/KMS 验证、生产日志汇留存、一年保留证据与安全负责人签署均未执行。

---

## What WORKED (with evidence)

- **参数化批量仓储** — `packages/nilm/service/src/audit.ts` 的 `SqlSecurityAuditStore` 在一个 source 事务内写入多行，绑定 `audit_id`、`tenant_id`、`user_ref`、`session_id`、`event_type`、`tool`、`error_code`，不拼接事件值。
- **有界异步队列** — `BufferedSecurityAuditSink` 保持事件顺序，按批写入；队列满丢弃最新事件并计数，事务失败记录批量后继续排空，关闭时等待最终批次。默认容量 `1024`、批量 `64`，可由配置与 `NILM_AUDIT_QUEUE_SIZE` / `NILM_AUDIT_BATCH_SIZE` 调整。
- **认证失败语义** — 未验签事件使用 `tenant_id = __unverified__`；不写入调用方伪造的 Header 值。其余 BFF 事件在身份验证后携带租户、用户与会话。
- **审计字段补强** — `tool.rejected` 事件新增 `sessionId` 与 `tool`；`conversation.persist-failed` 新增 `sessionId`，使落库行可关联到会话与工具。
- **离线用例** — `packages/nilm/service/tests/audit.spec.ts` 5 个用例覆盖参数绑定、队列上界、写入失败续写、关闭后拒绝与配置默认值。confirmed by: 聚焦套件 53 通过（audit 5 + http 14 + pentest 34，2026-11-19 10:55 CST）。
- **全量 NILM** — confirmed by: 45 个文件、369 通过、1 跳过（`perf-load` loopback 因沙箱 `EPERM` 跳过，2026-11-19 10:59 CST）。
- **类型检查** — confirmed by: 临时 `noEmit` 配置覆盖全部 `packages/nilm/*/src`，NILM 路径零错误；覆盖 service 测试时仅剩既有 `recovery.spec.ts` 的工作区路径解析错误。
- **文档门禁** — confirmed by: translation pairing 1 对一致；limitations 398 个通过；model experience 398 个通过；doc refs 5270 个可解析；doc budgets 7 个在预算内；md links 2648 个通过；双语配对哈希已重算。
- **`git diff --check`** — confirmed by: 空白与行尾检查通过。

---

## What Did NOT Work (and why)

- **真实 MySQL 落库** — 未执行：没有可用 `nilm_system` 数据库。离线测试只验证 SQL 形状、参数绑定与队列语义，不证明真实表写入、锁等待或死锁行为。
- **G4-4 现场门** — 未通过：真实双租户安全环境复验、生产日志汇留存、KMS/AES-GCM 密文验证、`nilm_security_audit` 一年保留与安全负责人签署均未完成。
- **审计可靠性边界** — 当前是尽力写入：队列溢出丢弃最新事件，事务失败丢弃该批，事件不重试，也没有 Outbox 或保留任务。失败会记录稳定错误码与丢弃数量；脱敏结构化日志仍是兜底证据。
- **Tool/SQL 守卫原始事件** — `nilm-tools` 的 `tool.rejected` 与 `nilm-source` 的 `sql.rejected` 仍只写结构化日志。BFF 收到的安全 Tool 失败会落库为 `tool.rejected`，但 SQL 守卫自身事件尚未接入共享审计存储。
- **`pnpm` 命令** — 未执行：本机 `pnpm` 直接段错误。测试使用 pnpm store 中的 vitest 直跑；文档门禁用 `node --experimental-transform-types`。
- **覆盖率门禁** — 未执行：临时环境缺 `@vitest/coverage-v8`；新增逻辑有行为用例，但未计入 per-file 100% 覆盖率统计。
- **`verify-empty-catch`** — 未完成：沙箱内脚本 `spawnSync git` 返回 `EPERM`；申请沙箱外审批时自动审批服务返回 402，未能执行。当前改动没有空 `catch`。
- **`verify-cordis-config`** — 未完成：本机缺 `@deepseek-ai/cordis-plugin-include` workspace 解析，脚本无法启动。
- **`verify-export-jsdoc`** — 仓库级扫描报 19 个既有违规，均位于本轮未修改的文件；新增 `audit.ts` 与 `index.ts` 导出未出现在违规列表。
- **`git commit`** — 未执行：按用户要求由用户管理提交。

---

## Key File Status

| Path | Status | Summary |
| :--- | :--- | :--- |
| `packages/nilm/service/src/audit.ts` | New | `SqlSecurityAuditStore`、`BufferedSecurityAuditSink`、行映射、默认值与未认证租户标记 |
| `packages/nilm/service/tests/audit.spec.ts` | New | 参数绑定、批量、溢出、失败、关闭、配置测试 |
| `packages/nilm/service/src/config.ts` | Modified | `auditQueueSize`、`auditBatchSize` 及默认值 |
| `packages/nilm/service/src/index.ts` | Modified | 构造审计队列、日志与落库并行、关闭时排空、稳定失败标签 |
| `packages/nilm/service/src/http.ts` | Modified | `AuditEvent` 新增 `sessionId`/`tool`；Tool 与会话失败事件填充字段 |
| `packages/nilm/service/tests/security-pentest.spec.ts` | Modified | BFF-17 断言 Tool 拒绝审计携带会话与工具 |
| `packages/bundle/nilm-app/cordis.patch.yml` | Modified | 暴露 `NILM_AUDIT_QUEUE_SIZE` 与 `NILM_AUDIT_BATCH_SIZE` |
| `deploy/k8s/configmap.yaml` | Modified | 写入默认审计队列与批量值 |
| `packages/nilm/service/README.md/.zh.md/.i18n.yaml` | Modified | 审计持久化、失败语义、证据边界与限制 |
| `docs/nilm-ai-agent-high-level-design.md` | Modified | 审计状态从“未落库”改为“尽力写入” |
| `docs/nilm-ai-agent-development-plan.md` | Modified | G4-4 证据与现场剩余项 |
| `docs/nilm-ai-agent-detailed-design-phase4.md` | Modified | §7.3 审计持久化、§8 G4-4 行 |

---

## Architecture Decisions

- **写路径放在 service，事务复用 source** — `SqlSecurityAuditStore` 只依赖结构化的 `AuditTransactionRunner`，由 `ctx.nilmSource` 提供事务；BFF 不直接依赖 MySQL 驱动。
- **请求路径不等待数据库** — `record` 只入队；后台串行排空。HTTP 处理、SSE 与取消不被审计写入延迟阻塞。
- **有界队列显式丢弃** — 队列满丢弃最新事件并计数，避免攻击流量导致进程内存无界增长；失败不重试，因为日志仍是同事件的兜底副本。
- **未认证事件使用合成租户** — 验签失败没有可信租户，写入 `__unverified__` 而不是调用方 Header；避免污染真实租户审计并按事件类型集中检索。`resolveConfig` 拒绝配置同名租户，防止合成值与真实租户冲突。
- **错误日志只写稳定标签** — 数据库失败只记录 `NilmError.code` 或 `Error.name`，不回显驱动错误消息，避免错误文本携带绑定值或凭证。
- **批量参数化 SQL** — 行数决定占位符数量，所有值走参数绑定；`audit_id` 使用服务端 `randomUUID`。

---

## Blockers & Open Questions

- G4-4 现场门未通过：需真实双租户环境复验 32 个攻击用例，并采集生产日志、审计表行、保留与密文证据。
- 审计写入是尽力语义；生产是否需要 Outbox/重试、丢弃告警阈值与告警路由仍需安全/运维确认。
- `nilm_security_audit` 没有自动保留/归档任务，DDL 注释的“至少一年”仍需数据库运维实现并出示证据。
- `user_ref` 等 Header 长度尚未按表字段上限校验；超长值会使该批审计插入失败。生产前应统一约束或采用稳定摘要。
- Tool/SQL 守卫原始审计事件仍为 logger-only；如需单表完整链路，需要共享审计服务或让领域插件接入同一存储。
- G4-1/G4-2/G4-3 现场演练仍未闭环。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交本轮改动：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add deploy/k8s/configmap.yaml docs/nilm-ai-agent-detailed-design-phase4.md docs/nilm-ai-agent-development-plan.md docs/nilm-ai-agent-high-level-design.md packages/bundle/nilm-app/cordis.patch.yml packages/nilm/service/README.md packages/nilm/service/README.zh.md packages/nilm/service/README.i18n.yaml packages/nilm/service/src/audit.ts packages/nilm/service/src/config.ts packages/nilm/service/src/http.ts packages/nilm/service/src/index.ts packages/nilm/service/tests/audit.spec.ts packages/nilm/service/tests/security-pentest.spec.ts SESSION_STATE.md
git commit -m "feat(nilm): persist BFF security audit rows"
```

2. 在真实 MySQL 执行一次离线写入验证：启动 source、触发跨租户拒绝、查询 `nilm_security_audit`，确认租户、事件、工具、会话与错误码正确且无请求体/提示词。

3. 决定是否把 Tool/SQL 守卫事件接入同一审计存储；若需要单表完整链路，新增共享审计 seam，而不是从领域插件直接访问 MySQL。

4. 继续现场证据闭环：先做 G4-2 的 K8s SIGKILL/PVC 演练，再做 G4-3 的 100 x 5 x 30 分钟压测，最后完成 G4-4 安全评审签署。

---

## Environment & Setup Notes

- NILM 全量测试（临时配置 `/tmp/vitest.nilm.config.mjs`，排除需要原生 `flock` 的 recovery 用例）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
```

- 类型检查（临时配置 `/tmp/tsconfig.nilm-44-src.json` 覆盖全部 NILM src）：

```sh
D=$(ls -d ~/.local/share/pnpm/store/v11/links/@/typescript/5.9.3/*/node_modules/typescript/bin/tsc | head -1)
node "$D" -p /tmp/tsconfig.nilm-44-src.json 2>&1 | grep -E "packages/nilm/"
```

- 文档门禁：

```sh
node --experimental-transform-types scripts/verify-translation-pairing.ts packages/nilm/service/README.md
node --experimental-transform-types scripts/verify-package-readme-limitations.ts
node --experimental-transform-types scripts/verify-package-readme-model-experience.ts
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
node --experimental-transform-types scripts/verify-md-links.ts
```

- 当前环境 `pnpm` 段错误；`tsx` 与工作区依赖不完整。不要反复重试提权；回环监听被沙箱拒绝是已知限制。
