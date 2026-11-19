# Session: 2026-11-19

**Started:** 2026-11-19 (Asia/Shanghai)
**Last Updated:** 2026-11-19 11:25 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM WBS 4.4 补强：共享安全审计 seam、Tool 拒绝落库与调用方标识上界

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。阶段 1/2/3 与 4.1/4.2/4.3/4.4 已落地；本轮基线提交为 `e83e7860c4`（BFF 审计写入 `nilm_security_audit`）。

本轮在基线上补齐 G4-4 的离线审计链路：

- `nilm-core` 新增共享 `SecurityAuditEvent` / `SecurityAuditSink` seam，并声明可选 `Context.nilmAudit`；
- `nilm-service` 提供 `nilmAudit` sink，BFF 与 Tool 拒绝写入同一有界异步队列；
- `nilm-tools` 的安全拒绝从已绑定 `CallContext` 读取租户、用户、请求与会话，不伪造身份；
- 验签链增加租户/用户 64 字符与请求 id 128 字符上限，避免超长值导致整批审计失败或日志膨胀。

G4-4 现场门仍未通过：真实 MySQL 落库、真实双租户复验、生产日志留存、KMS/AES-GCM、审计一年保留与安全负责人签署均未执行。

---

## What WORKED (with evidence)

- **共享审计 seam** — `packages/nilm/core/src/audit.ts` 定义不含请求体/提示词/凭证的事件与 sink；`packages/nilm/tools/src/index.ts` 通过 `ctx.get('nilmAudit')?.record(event)` 复用 BFF sink。`Context.nilmAudit` 为可选属性，未挂载 BFF 的单元组合保持静默。
- **Tool 拒绝携带绑定身份** — `NilmContextService.current(agentId)` 以非抛错方式读取绑定；`audited()` 在安全失败时补充 `tenantId`、`userRef`、`requestId`、`sessionId`，随后重新抛出原始错误。无绑定时仍记录事件但不带租户，不把审计失败伪装成工具失败。
- **SQL 守卫边界** — source 适配器的原始 `sql.rejected` 仍只写结构化日志，因为没有已验证调用方身份；穿过 Tool 边界的 SQL 拒绝由 `tool.rejected` 携带租户落库。
- **调用方标识上界** — `packages/nilm/service/src/auth.ts` 在 HMAC 校验前拒绝超过 64 字符的租户/用户头（`401`）与超过 128 字符的请求 id（`400`），与 `nilm_conversation` / `nilm_security_audit` 字段宽度对齐。confirmed by: `auth.spec.ts` 9 个用例通过，含超长标识拒绝。
- **BFF 审计持久化（基线已提交）** — `SqlSecurityAuditStore` 参数化批量写入；`BufferedSecurityAuditSink` 保持顺序、队列满丢最新、事务失败丢弃该批后继续；关闭时排空。未认证事件使用 `__unverified__`，配置拒绝同名真实租户。
- **全量 NILM** — confirmed by: 45 个测试文件、370 通过、1 跳过（`perf-load` loopback 因沙箱 `EPERM` 跳过，2026-11-19 11:22 CST）。
- **类型检查** — confirmed by: 临时 `noEmit` 配置覆盖全部 `packages/nilm/*/src`，NILM 路径零错误；整体退出码 2 来自仓库其他包缺失 `zod` 等既有依赖。覆盖测试时仅剩既有 `recovery.spec.ts` 的工作区路径解析错误。
- **文档门禁** — confirmed by: translation pairing 1 对一致；limitations 398 个通过；model experience 398 个通过；doc refs 5271 个可解析；doc budgets 7 个在预算内；md links 2648 个通过。
- **`git diff --check`** — confirmed by: 空白与行尾检查通过。

---

## What Did NOT Work (and why)

- **真实 MySQL 落库** — 未执行：没有可用 `nilm_system` 数据库。离线测试只验证 SQL 形状、参数绑定与队列语义，不证明真实表写入、锁等待或死锁行为。
- **G4-4 现场门** — 未通过：真实双租户安全环境复验、生产日志汇留存、KMS/AES-GCM 密文验证、`nilm_security_audit` 一年保留与安全负责人签署均未完成。
- **审计可靠性边界** — 当前是尽力写入：队列溢出丢弃最新事件，事务失败丢弃该批，事件不重试，也没有 Outbox 或保留任务。失败会记录稳定错误码与丢弃数量；脱敏结构化日志仍是兜底证据。
- **SQL 守卫原始事件** — `nilm-source` 的 `sql.rejected` 仍只写结构化日志；单表完整链路只覆盖 BFF 与 Tool 边界事件。
- **`pnpm` 命令** — 未执行：本机 `pnpm` 直接段错误。测试使用 pnpm store 中的 vitest 直跑；文档门禁用 `node --experimental-transform-types`。
- **覆盖率门禁** — 未执行：临时环境缺 `@vitest/coverage-v8`；新增逻辑有行为用例，但未计入 per-file 100% 覆盖率统计。
- **`verify-empty-catch`** — 未完成：沙箱内脚本 `spawnSync git` 返回 `EPERM`；申请沙箱外审批时自动审批服务返回 402。当前改动没有空 `catch`。
- **`verify-cordis-config`** — 未完成：本机缺 `@deepseek-ai/cordis-plugin-include` workspace 解析，脚本无法启动。
- **`verify-export-jsdoc`** — 仓库级扫描报 19 个既有违规，均位于本轮未修改的文件；新增导出未出现在违规列表。
- **`git commit`** — 未执行：按用户要求由用户管理提交。

---

## Key File Status

| Path | Status | Summary |
| :--- | :--- | :--- |
| `packages/nilm/core/src/audit.ts` | New | 共享 `SecurityAuditEvent`、`SecurityAuditSink` 与可选 `Context.nilmAudit` 声明 |
| `packages/nilm/core/src/index.ts` | Modified | 导出共享审计类型 |
| `packages/nilm/context/src/index.ts` | Modified | 新增非抛错 `current(agentId)` |
| `packages/nilm/tools/src/index.ts` | Modified | Tool 审计携带绑定 `CallContext`，写入 logger 与 `nilmAudit` |
| `packages/nilm/service/src/audit.ts` | Modified | 审计事件类型改为共享 seam；持久化与队列逻辑不变 |
| `packages/nilm/service/src/index.ts` | Modified | 构造并 `ctx.provide('nilmAudit', auditSink)`；BFF 审计写入同一 sink |
| `packages/nilm/service/src/http.ts` | Modified | `AuditEvent` 复用共享类型；Tool/会话事件补齐 `sessionId`、`tool` |
| `packages/nilm/service/src/auth.ts` | Modified | 租户/用户 64、请求 id 128 字符上界 |
| `packages/nilm/service/tests/auth.spec.ts` | Modified | 超长标识拒绝用例 |
| `packages/nilm/service/tests/security-pentest.spec.ts` | Modified | Tool 拒绝断言绑定租户、用户、请求与会话 |
| `packages/nilm/context/tests/context.spec.ts` | Modified | `current()` 绑定与撤销语义 |
| `packages/nilm/tools/tests/tools.spec.ts` | Modified | 测试 host 补 `current` |
| `packages/nilm/service/README.md/.zh.md/.i18n.yaml` | Modified | 共享 sink、SQL logger-only 边界与标识上界 |
| `docs/nilm-ai-agent-detailed-design-phase4.md` | Modified | §7.3 共享审计、SQL 边界与调用方标识上界 |
| `docs/nilm-ai-agent-development-plan.md` | Modified | G4-4 证据补充 Tool sink 与 auth 上限 |
| `docs/nilm-ai-agent-high-level-design.md` | Modified | 审计状态更新为 BFF/Tool 共享尽力写入 |

---

## Architecture Decisions

- **共享 seam 放在 core，持久化放在 service** — 领域插件只产生脱敏事件，不依赖 MySQL 或 BFF 实现；service 通过 `nilmSource.transaction` 批量落库。
- **`ctx.provide('nilmAudit', sink)`** — 让 BFF 与 Tool 共享同一队列与关闭语义；未挂载 BFF 时可选属性缺失，Tool 审计退化为 logger-only。
- **`current()` 不抛错** — 审计是失败路径的旁路，不能用新的 `TENANT_CONTEXT_UNAVAILABLE` 覆盖原始安全拒绝。
- **SQL 原始事件保持 logger-only** — source 适配器无法证明调用方身份；只有穿过 Tool 边界、已有 `CallContext` 的拒绝才写入租户审计行。
- **验签前约束标识长度** — 超长值在进入审计队列前被拒绝；避免单个签名请求使最多 64 行审计因字段溢出整批丢失。
- **请求路径不等待数据库** — `record` 只入队；后台串行排空。HTTP、SSE 与取消不被审计写入延迟阻塞。
- **有界队列显式丢弃** — 队列满丢弃最新事件并计数，避免攻击流量导致进程内存无界增长；失败不重试，因为日志仍是同事件的兜底副本。
- **未认证事件使用合成租户** — 验签失败写入 `__unverified__`，不写调用方 Header；`resolveConfig` 拒绝配置同名真实租户。

---

## Blockers & Open Questions

- G4-4 现场门未通过：需真实双租户环境复验 32 个攻击用例，并采集生产日志、审计表行、保留与密文证据。
- 审计写入是尽力语义；生产是否需要 Outbox/重试、丢弃告警阈值与告警路由仍需安全/运维确认。
- `nilm_security_audit` 没有自动保留/归档任务，DDL 注释的“至少一年”仍需数据库运维实现并出示证据。
- 部署前需确认现有 `signingSecrets` 的租户 id 均不超过 64 字符，且上游 `user_ref` 遵守同一上限；否则请求会被 `401` 拒绝。这是本轮新增的输入约束。
- Tool/SQL 守卫原始审计事件仍为 logger-only；如需单表完整链路，source 适配器需要可验证的调用方身份或显式无租户事件类型。
- G4-1/G4-2/G4-3 现场演练仍未闭环。

---

## Exact Next Step

1. 审阅本轮差异并在可写 `.git` 的正常终端提交（提交信息可按团队规范调整）：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add SESSION_STATE.md \
  docs/nilm-ai-agent-detailed-design-phase4.md \
  docs/nilm-ai-agent-development-plan.md \
  docs/nilm-ai-agent-high-level-design.md \
  packages/nilm/context \
  packages/nilm/core \
  packages/nilm/service/README.md \
  packages/nilm/service/README.zh.md \
  packages/nilm/service/README.i18n.yaml \
  packages/nilm/service/src/audit.ts \
  packages/nilm/service/src/auth.ts \
  packages/nilm/service/src/http.ts \
  packages/nilm/service/src/index.ts \
  packages/nilm/service/tests/auth.spec.ts \
  packages/nilm/service/tests/security-pentest.spec.ts \
  packages/nilm/tools
git commit -m "feat(nilm): unify security audit across tools"
```

2. 在真实 MySQL 执行一次离线写入验证：启动 source、触发 BFF 认证失败、跨租户拒绝与 Tool 参数拒绝，查询 `nilm_security_audit`，确认租户、事件、工具、会话与错误码正确且无请求体/提示词。

3. 继续现场证据闭环：先做 G4-2 的 K8s SIGKILL/PVC 演练，再做 G4-3 的 100 x 5 x 30 分钟压测，最后完成 G4-4 安全评审签署。

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
