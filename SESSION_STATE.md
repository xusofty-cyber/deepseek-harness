# Session: 2026-11-19

**Started:** 2026-11-19 (Asia/Shanghai)
**Last Updated:** 2026-11-19 10:30 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 阶段 4.4：版本化安全攻击套件、审计链路与日志脱敏（离线部分）

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。阶段 1/2/3、4.1、4.2、4.3 已提交；最新提交 `b3f2b6ed92` 为 G4-3 压测 harness。

本会话完成 WBS 4.4 的离线实现：新增 `4.4.1` 版本化攻击语料（32 个用例）、BFF 拒绝审计、Tool 安全失败审计、SQL 守卫拒绝审计、统一日志脱敏纯函数，并把 service 测试脚手架提取为共享 harness。G4-4 现场证据门仍开放：生产日志审查、KMS/AES-GCM 存储验证、`nilm_security_audit` 落库与无 Critical/High 的安全结论均未执行。

---

## What WORKED (with evidence)

- **版本化攻击套件** — `packages/nilm/service/tests/security-pentest.spec.ts` 声明 `PENTEST_SUITE_VERSION = '4.4.1'` 与 32 个攻击用例，末项用例断言清单内每个 id 都被真实执行；命令为 `pnpm test:security:pentest`。confirmed by: 34 通过（32 攻击 + 1 授权基线 + 1 完整性，2026-11-19 10:23 CST）。
- **四层覆盖** — BFF 信封/重放/伪造租户/双租户读取与列表隔离 17 例；SQL 守卫写语句、多语句、注释、字面量、非白名单表、锁读、SLEEP 8 例；Tool 注入 `tenant_id`/`target_tenant_id`/`allowed_scope` 被闭集 Schema 以 `INVALID_ARGS` 拒绝并审计、缺失上下文、越权 Scope 共 5 例；`CallContext` 冻结与重绑定 2 例。
- **拒绝审计** — BFF 认证失败写 `auth.rejected`（不记录未认证 Header）；其余拒绝写 `request.rejected`，仅在身份校验已通过时携带租户；Tool 安全失败写 `tool.rejected`；SQL 守卫拒绝写 `sql.rejected`。`packages/nilm/service/src/http.ts` 用 `WeakSet` 避免同一错误重复审计。
- **脱敏纯函数** — `packages/nilm/core/src/redact.ts` 提供 `redactText`/`redactValue`：手机号掩码为 `138****8000`，OpenID、Bearer/Authorization、API Key、`x-nilm-signature` 与裸 `v1=` 签名替换为 `<redacted>`。confirmed by: `packages/nilm/core/tests/redact.spec.ts` 5 通过。
- **日志接入** — service、scheduler、sentinel、notify 的 logger 消息经 `redactText`；service 审计序列化经 `redactValue`；source 与 tools 的审计事件只含事件类型、来源/工具名与稳定错误码。
- **service 测试** — confirmed by: 5 个文件，83 通过、1 跳过（`perf-load` loopback 因沙箱 `EPERM` 跳过）。
- **全部 NILM 离线用例** — confirmed by: 44 个文件、364 通过、1 跳过（2026-11-19 10:23 CST）。4.3 基线为 42 文件 / 325 通过；本阶段新增 2 文件 / 39 通过。
- **同分片恢复用例** — confirmed by: `recovery.spec.ts` 1 通过、1 跳过；跳过项仍需要本机未安装的原生 `flock` addon。
- **类型检查** — confirmed by: 临时 `noEmit` 配置覆盖全部 `packages/nilm/*/src`，零错误；覆盖 service 测试时仅剩既有 `recovery.spec.ts` 对 `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts` 的路径解析错误（环境缺工作区依赖），新增/改动文件无错误。
- **文档门禁** — confirmed by: translation pairing 1 对一致；limitations 398 个通过；model experience 398 个通过；doc refs 5268 个可解析；doc budgets 7 个在预算内；md links 2648 个通过。
- **`git diff --check`** — confirmed by: 空白与行尾检查通过。

---

## What Did NOT Work (and why)

- **G4-4 现场证据门** — 未执行：没有真实双租户安全测试环境、生产日志汇、KMS/AES-GCM 数据库与 `nilm_security_audit` 落库。离线套件不能替代安全负责人签署的无 Critical/High 结论。
- **生产日志脱敏验证** — 未执行：只验证了进程内纯函数与 logger 包装；未采集生产日志样本证明无手机号/OpenID/Token 明文。
- **`nilm_security_audit` 持久化** — 未实现：审计仍写插件 logger；表 DDL 已存在，但 BFF 尚未接入审计存储。
- **模型供应商侧隐私** — 未验证：报告摘要是否只含脱敏指标需在真实模型调用链复核；Session 按“模型可见⟺已记录”保留原始提问，不能用“删除原始提问”满足 G4-4。
- **`pnpm` 命令** — 未执行：本机 `pnpm` 直接段错误。测试使用 pnpm store 中的 vitest 直接运行；文档门禁用 `node --experimental-transform-types`。
- **覆盖率门禁** — 未执行：临时环境缺 `@vitest/coverage-v8`；新增逻辑有行为用例，但未计入 per-file 100% 覆盖率统计。
- **`git commit`** — 未执行：按用户要求由用户管理提交；4.4 改动仍在工作树。

---

## Key File Status

| File | Status | Summary |
| :--- | :--- | :--- |
| `packages/nilm/service/tests/security-pentest.spec.ts` | Added | `4.4.1` 版本化 32 用例攻击语料与完整性断言 |
| `packages/nilm/service/tests/support/harness.ts` | Added | Fake 请求/响应/会话/运行时、签名调用与审计捕获 |
| `packages/nilm/service/tests/http.spec.ts` | Modified | 改用共享 harness，删除重复脚手架 |
| `packages/nilm/core/src/redact.ts` | Added | `redactText`/`redactValue` 手机号、OpenID、Token、签名脱敏 |
| `packages/nilm/core/tests/redact.spec.ts` | Added | 5 个脱敏与结构保持用例 |
| `packages/nilm/service/src/http.ts` | Modified | `auth.rejected`/`request.rejected`/`tool.rejected` 审计；拒绝去重；`TurnRecord.requestId` |
| `packages/nilm/service/src/runtime.ts` | Modified | Tool 失败事件透传稳定错误码 |
| `packages/nilm/service/src/index.ts` | Modified | 审计与错误日志经脱敏 |
| `packages/nilm/tools/src/index.ts` | Modified | Tool 安全失败审计包装；`apply` 显式装配 host |
| `packages/nilm/source/src/index.ts` | Modified | SQL 守卫拒绝审计 `sql.rejected` |
| `packages/nilm/scheduler|sentinel|notify/src/index.ts` | Modified | logger 消息经 `redactText` |
| `package.json` | Modified | 新增 `test:security:pentest` |
| `pnpm-lock.yaml` | Modified | 同步 service devDeps 与 tools 的 `dsh-error` 依赖 |
| `packages/nilm/service/README.md/.zh.md/.i18n.yaml` | Modified | Security testing 章节、证据边界与限制，配对已重算 |
| `docs/nilm-ai-agent-development-plan.md` | Modified | G4-4 方法与状态改为“离线已交付，现场未执行” |
| `docs/nilm-ai-agent-detailed-design-phase4.md` | Modified | §7.2 脱敏实现、§7.3 攻击套件与审计证据、§8 G4-4 行 |

---

## Architecture Decisions

- **攻击语料与测试同源** — 版本号、用例清单与执行断言在同一 spec 中，避免文档清单与代码漂移；末项用例强制检查 100% 执行。
- **BFF 认证失败不记录未认证租户** — `AuthError` 只写稳定 `code`；防止攻击者伪造 Header 污染审计。其余拒绝在身份校验已通过时才写租户与用户引用。
- **Tool 审计在包装层做** — 闭集 Schema 未声明的参数在 Tool 体内执行前以 `INVALID_ARGS` 拒绝；只记录工具名与稳定错误码，不记录模型参数或结果摘要；SQL 审计只记录来源与拒绝码，不记录原始 SQL。
- **脱敏放在 core 纯函数** — service/scheduler/sentinel/notify/source/tools 共用，不修改 vendored Cordis logger；`redactValue` 保留 JSON 结构。
- **Session 原始提问保留** — 遵守“模型可见⟺已记录”；G4-4 的生产证据改为访问控制、加密与审计留存评审，而不是删除 Session 内容。
- **共享 harness** — service 测试的 Fake 组件集中到 `tests/support/harness.ts`，新攻击套件与既有 HTTP 用例复用同一签名/路由行为。

---

## Blockers & Open Questions

- G4-4 现场门未通过：需真实双租户环境复验 32 个攻击用例，并采集生产日志、审计存储与数据库密文证据。
- `nilm_security_audit` 持久化未接入；当前审计只在插件 logger 中可见，进程重启后不保留。
- 生产日志汇的保留、轮转、访问控制与脱敏验证由运维/安全团队完成；仓库不能提供该证据。
- KMS/Secret 注入与 AES-GCM 密文存储需部署环境验证；仓库只有接收方密文字段与 DDL。
- 报告摘要上送模型的字段范围需在真实调用链复核，避免工厂名称、精确位置等进入提示词。
- `nilm-edge` 网关仍归平台团队；仓库只提供端点载体与路由契约。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交 4.4：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add package.json pnpm-lock.yaml packages/nilm/core packages/nilm/service packages/nilm/tools packages/nilm/source packages/nilm/scheduler packages/nilm/sentinel packages/nilm/notify docs/nilm-ai-agent-development-plan.md docs/nilm-ai-agent-detailed-design-phase4.md SESSION_STATE.md
git commit -m "feat(nilm): add G4-4 security pentest and log redaction"
```

2. 本地复跑离线证据：

```sh
pnpm test:security:pentest
pnpm run test
```

3. 在真实双租户安全环境复验攻击套件，并归档命令、时间戳、日志样本与审计表查询结果；任何用例未拦截或未写审计都不得声称 G4-4 通过。

4. 完成生产日志审查、KMS/AES-GCM 验证与 `nilm_security_audit` 落库后，由安全负责人签署无 Critical/High 结论；随后再进入阶段 4 全量交付验收。

---

## Environment & Setup Notes

- NILM 全量测试（临时配置 `/tmp/vitest.nilm.config.mjs`，排除需要原生 `flock` 的 recovery 用例）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/service/tests
node "$V" run --config /tmp/vitest.recovery.config.mjs
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

- 当前环境 `pnpm` 段错误；`tsx` 与工作区依赖不完整，CLI 无法在本机直接启动。不要反复重试提权；回环监听被沙箱拒绝是已知限制。
