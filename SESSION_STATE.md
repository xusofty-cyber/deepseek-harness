# Session: 2026-11-19

**Started:** 2026-11-19 (Asia/Shanghai)
**Last Updated:** 2026-11-19 16:10 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 测试规约重写与验证矩阵校准（46 套件 / 381 断言）

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。
阶段 0 至阶段 4 全量功能开发及审查修复（commit `bba0b64c16`）均已完成并推送至 GitHub 私有仓库 `git@github.com:xusofty-cyber/dsh-nilm.git`。

本轮完成了对全系统测试规约的校准式重写：
- 重写 `docs/nilm-ai-agent-test-specifications.md`：按实际 Vitest 输出记录 46 个测试文件、381 个断言；用例标题直接来自当前 `it()`，安全套件按 32 个 `PENTEST_CASES` 声明 ID 展示；证据门改为 21 项并区分离线与现场。
- 保留 `scripts/translation-pairing.manifest.json` 中的非双语排除项；该文档仍无英文配对，属于预期。
- 生成对话 Artifact：`nilm-ai-agent-test-specifications`。
- 文档门禁（doc refs, doc budgets, md-links）全部退出 0；translation pairing 仍按 manifest 排除。

---

## Review Remediation (uncommitted worktree)

本轮按上一轮代码审查修复了以下问题，基线为已提交的 `f183def525`：

- **跨租户电价** — `nilm_tariff_period` 增加 `tenant_id` 并使用租户化唯一键；`SourceTariffRepository` 查询时段时绑定租户，新增回归断言。
- **同渠道多接收人丢告警/报告** — Outbox 与投递记录唯一键纳入 `user_ref`；投递记录写入 `user_ref`；调度器与哨兵均新增同渠道双接收人用例。
- **`clientMessageId` 并发与失败毒化** — BFF 幂等状态拆为 pending/complete，首个异步操作前占用 pending；并发重试返回可重试的 `429`；失败在 `finally` 释放；同一会话在 `runtime.open` 期间禁止并发建轮。
- **复审 P2：发送失败后的 turn 泄漏** — `agent.send()` 同步抛错时记录 `INTERNAL_ERROR`、完成 turn 收尾并释放会话；新增发送失败后同键重试成功的用例。
- **复审 P3：pending 幂等语义** — 处理中的并发重复提交改为可重试的 `429 RATE_LIMITED`；中英文 README、高层设计与错误码表同步说明。
- **复审 P3：测试缩进** — 并发幂等用例恢复 6 空格层级，符合 `.oxlintrc.json` 的 2 空格缩进规则；最终复审判定 PASS。
- **电量截断误导** — 聚合电量与日统计查询超采样上限时产生告警；`nilm_energy_query` 在摘要中明确“仅部分窗口”。
- **appliance 无 terminal 祖先** — 改为抛 `DATA_UNAVAILABLE`，不再把 `undefined` 断言成 `TerminalId`。
- **vendor 依赖声明** — 六个 NILM 包的 `@deepseek-ai/schemastery` 统一为 `workspace:~`，`pnpm-lock.yaml` 对应六处 importer 已同步。
- **文档门禁** — 阶段设计文档加入 translation-pairing 排除清单；文档内 `file://` 绝对链接改为相对链接；高层设计与架构文档同步租户化 DDL。

验证证据（2026-11-19 14:38 CST）：

- **全量 NILM** — `45` 个测试文件、`378` 通过、`1` 跳过（沙箱回环限制），零失败。
- **NILM 源码类型检查** — 临时 `noEmit` 配置下 `packages/nilm/*/src` 零错误；整体退出码 2 仍来自仓库其他包缺失 `zod` 等既有依赖。
- **NILM 测试类型检查** — 仅剩既有 `recovery.spec.ts` 无法解析 `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts`。
- **锁文件断言** — 六个包 manifest 与 lockfile importer 的 `schemastery` 声明均为 `workspace:~`，无不一致项。
- **文档门禁** — translation pairing、limitations、model experience、doc refs、doc budgets、md links 六项全部退出 0。
- **`git diff --check`** — 通过。
- **依赖策略门禁** — 未能启动：当前安装缺 `@jridgewell/gen-mapping`（脚本在导入阶段退出），不是检测到的违规。
- **`oxlint`** — 未执行：当前安装缺 `node_modules/oxlint`；缩进规则已按配置静态核对，不能声称 lint 已运行。

### 测试规约重写验证（2026-11-19 15:27 CST）

- **Vitest 实测** — 日常套件 45 个文件、379 个断言全部通过；`recovery.spec.ts` 2 个断言中 1 个通过、1 个因缺少原生 flock 跳过；合计 46 个文件、381 个断言。
- **文档逐文件校验** — 46 个文件块全部存在；349 条普通用例标题与 32 条 pentest 声明表行相加为 381；与 Vitest JSON 逐文件比对零错误。
- **文档门禁** — `verify-md-links` 2649 文件、`verify-doc-refs` 5271 文件、`verify-doc-budgets` 7 个在预算内；`git diff --check` 通过。

---

## What WORKED (with evidence)

- **共享审计 seam** — `packages/nilm/core/src/audit.ts` 定义不含请求体/提示词/凭证的事件与 sink；`packages/nilm/tools/src/index.ts` 通过 `ctx.get('nilmAudit')?.record(event)` 复用 BFF sink。`Context.nilmAudit` 为可选属性，未挂载 BFF 的单元组合保持静默。
- **Tool 拒绝携带绑定身份** — `NilmContextService.current(agentId)` 以非抛错方式读取绑定；`audited()` 在安全失败时补充 `tenantId`、`userRef`、`requestId`、`sessionId`，随后重新抛出原始错误。无绑定时仍记录事件但不带租户，不把审计失败伪装成工具失败。
- **SQL 守卫边界** — source 适配器的原始 `sql.rejected` 仍只写结构化日志，因为没有已验证调用方身份；穿过 Tool 边界的 SQL 拒绝由 `tool.rejected` 携带租户落库。
- **调用方标识上界** — `packages/nilm/service/src/auth.ts` 在 HMAC 校验前拒绝超过 64 字符的租户/用户头（`401`）与超过 128 字符的请求 id（`400`），与 `nilm_conversation` / `nilm_security_audit` 字段宽度对齐。confirmed by: `auth.spec.ts` 9 个用例通过，含超长标识拒绝。
- **BFF 审计持久化（基线已提交）** — `SqlSecurityAuditStore` 参数化批量写入；`BufferedSecurityAuditSink` 保持顺序、队列满丢最新、事务失败丢弃该批后继续；关闭时排空。未认证事件使用 `__unverified__`，配置拒绝同名真实租户。
- **全量 NILM** — confirmed by: 45 个测试文件、379 通过（2026-11-19 15:27 CST）；`recovery.spec.ts` 另计 1 通过、1 跳过。
- **类型检查** — confirmed by: 临时 `noEmit` 配置覆盖全部 `packages/nilm/*/src`，NILM 路径零错误；整体退出码 2 来自仓库其他包缺失 `zod` 等既有依赖。覆盖测试时仅剩既有 `recovery.spec.ts` 的工作区路径解析错误。
- **文档门禁** — confirmed by: translation pairing 按 manifest 排除；limitations 398 个通过；model experience 398 个通过；doc refs 5271 个可解析；doc budgets 7 个在预算内；md links 2649 个通过。
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

1. 提交测试规约重写（推送需另行授权）：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add SESSION_STATE.md docs/nilm-ai-agent-test-specifications.md
git commit -m "docs(nilm): rewrite test specifications from executable tests"
```

2. 阶段 4 现场实测验证闭环：
   - G4-1: 真实调度器晨报全链路演练与产出留存；
   - G4-2: K8s 集群实测 Pod SIGKILL、PVC 挂载漂移与撕裂恢复；
   - G4-3: 100 家工厂真实压力测试与压测监控指标采集；
   - G4-4: 双租户真实攻击对抗演练并留存落库审计表记录。

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
