# Session: 2026-11-18

**Started:** 2026-11-18 (Asia/Shanghai)
**Last Updated:** 2026-11-18 16:38 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 独立 AI Agent 阶段 3：主动巡检、告警生命周期与可靠通知 Outbox

---

## What We Are Building

本仓库是 dsh harness。当前项目是在其上构建一个独立的 NILM（非侵入式负荷监测）工厂能源 AI Agent 服务，作为服务提供商为微信小程序 / App 的调用方客户提供对话、能效分析、安全隐患检索和主动告警能力。

本项目不实现登录、角色、权限后台或客户前端展示；调用方平台完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`。BFF 只验签并绑定不可变调用上下文。

阶段 1/2 已完成电力拓扑、时序、电价、分析、电能质量、CUSUM、安全、提示词、六个 `nilm_*` 工具与 BFF。本次会话完成阶段 3：`nilm-sentinel` 巡检规则、告警状态机、抑制与升级、事务化 Outbox，以及 `nilm-notify` 可靠投递、四渠道网关契约和 8 秒异步研判。阶段 4（调度报告、R-06/R-07/R-08、现场证据门）尚未开始。

---

## What WORKED (with evidence)

- **阶段 3 全部离线测试** — confirmed by: `30` 个测试文件、`234` 个用例全部通过（2026-11-18 16:30 CST）。覆盖 sentinel 状态机/规则/抑制/扫描器、notify 退避/并发领取/租约回收/渠道契约/富化超时、BFF 告警端点、DDL 18 表、bundle 组合。
- **Sentinel 增量扫描与规则** — confirmed by: `packages/nilm/sentinel/tests/*.spec.ts`；水位线持久化、R-01a/R-01b/R-02/R-03/R-05、`silence_key` 抑制、连续 3 窗口升级穿透均有测试。
- **Notify Outbox 调度** — confirmed by: 5 个 worker 并发领取 100 条无重复无丢失、过期租约可重领、永久失败立即 `dead`、退避表 `[1m,5m,15m,1h]`、第 5 次失败 `dead`。
- **渠道网关契约** — confirmed by: HTTP 200/429/5xx/4xx 分类、载荷只含加密接收方与掩码、不含明文手机号。
- **异步富化** — confirmed by: Agent 10 秒延迟注入、8 秒硬超时、迟到结果不写入、已确认告警不覆盖。
- **BFF 告警端点** — confirmed by: `GET /v1/alerts` 挂载时返回 `available: true`，未挂载返回 `available: false`；`POST /v1/alerts/{id}/ack` 返回 `acknowledged` 并写审计事件；跨用户返回 `SCOPE_NOT_FOUND`。
- **DDL 与包组合** — confirmed by: DDL 精确 18 表、`NILM_LOCAL_TABLES` 集合一致、`nilm-app` 测试断言 sentinel/notify 行存在且依赖齐全。
- **文档门禁** — confirmed by: translation pairing `1312` 对一致；README limitations `396` 个通过；model experience `396` 个通过；doc refs `5232` 个可解析；doc budgets `7` 个在预算内。
- **类型检查（NILM 范围）** — confirmed by: 临时 `noEmit` 配置下 `packages/nilm` 与 `packages/bundle/nilm-app` 零错误。

---

## What Did NOT Work (and why)

- **`pnpm install --offline --lockfile-only`** — failed because: 本机 `pnpm` 直接段错误（`Segmentation fault`），沙箱内外都无法执行。`pnpm-lock.yaml` 已按 workspace 依赖手工补齐，并用 Python YAML 解析与 package.json 依赖对比校验通过；下次应在正常环境运行一次 `pnpm install` 让 pnpm 自己重写 lockfile。
- **沙箱内 `git add` / `git commit`** — not executed because: 当前环境 `.git` 只读；沙箱外审批因外部 API 余额不足（402）无法完成。阶段 3 仍未提交。
- **根级 `pnpm run typecheck`** — failed because: 仓库既有的 `zod` 模块缺失与 `vendor/cordis` 类型错误；这些错误在本会话前已存在，且 NILM 包零错误。
- **真实 30 秒 SLO、真实 MySQL `SKIP LOCKED`、微信/企微/短信联调** — 未执行，因为没有测试库、真实渠道账号和网关凭证；不能声称 G3-1/G3-3/G3-4 已通过。
- **`vitest --coverage`** — failed because: 临时配置缺少 `@vitest/coverage-v8` 依赖；未获得覆盖率数字。

---

## What Has NOT Been Tried Yet

- 阶段 4：`nilm-scheduler`、每日 08:30 晨报、月度 20/25 日力调预测、R-06/R-07/R-08。
- 交付 `test:slo:alert` 脚本并进行真实端到端 SLO 演练。
- 真实 MySQL 多进程 Outbox 抢占测试与死锁观察。
- 微信订阅消息、公众号模板、企微机器人、短信供应商沙箱联调；短信供应商仍待 D-12 决策。
- 自适应基线：按同租户、同车间、同星期几、同时间段计算过去 4 周中位数，替换当前 `baseline_kw`。
- R-03 的实时功率过载路径；R-04 需要上游分相电流列。
- BFF 告警分页：当前签名层拒绝 query string，需先调整签名契约。

---

## Current State of Files

| File | Status | Notes |
| --- | --- | --- |
| `packages/nilm/sentinel/` | PASS: Complete (offline) | 巡检服务、规则、抑制、MySQL store、扫描器、测试与双语 README |
| `packages/nilm/notify/` | PASS: Complete (offline) | Outbox store/dispatcher、四渠道、富化、诊断 Agent、测试与双语 README |
| `packages/nilm/source/src/transaction.ts` | PASS: Complete | `SqlTransaction` / `MysqlTransactionRunner`，BEGIN/COMMIT/ROLLBACK 与连接池释放 |
| `packages/nilm/source/src/index.ts` | PASS: Complete | `localTransactions` 依赖与 `transaction()` 接缝；关闭时释放事务池 |
| `packages/nilm/source/src/sql-guard.ts` | PASS: Complete | `NILM_LOCAL_TABLES` 加入 `nilm_sentinel_watermark` |
| `packages/nilm/source/sql/init-nilm-system.sql` | PASS: Complete | 18 表；`silence_key`、索引、`nilm_sentinel_watermark` |
| `packages/nilm/service/src/http.ts` | PASS: Complete | `AlertApi` 接缝；列表/确认已接入；未挂载保留降级 |
| `packages/nilm/service/src/index.ts` | PASS: Complete | `inject` 增加 `nilmSentinel`；告警页 JSON 投影 |
| `packages/bundle/nilm-app/cordis.patch.yml` | PASS: Complete | 挂载 sentinel/notify，全部 `NILM_*` 配置 |
| `packages/bundle/nilm-app/package.json` | PASS: Complete | 新增两个 workspace 依赖 |
| `pnpm-lock.yaml` | PASS: Manually updated | 已手工加入 4 个 importer 依赖；需正常环境重跑 pnpm 验证 |
| `docs/nilm-ai-agent-architecture.md` | PASS: Complete | §8 水位线、silence_key、Outbox 字段、富化回填已更新 |
| `docs/nilm-ai-agent-high-level-design.md` | PASS: Complete | 18 表、DDL、API 契约、阶段 3 状态与边界 |
| `docs/nilm-ai-agent-development-plan.md` | PASS: Complete | 17→18 表；§5.4 当前实现状态与证据门 |
| `packages/nilm/README.md` / `README.zh.md` | PASS: Complete | 包组新增 sentinel/notify |
| `packages/nilm/source|service|bundle/nilm-app` README 双语 | PASS: Complete | 新接缝、告警端点、阶段 3 边界已同步 |
| `scripts/verify-package-readme-model-experience.ts` | PASS: Complete | 两个新包加入无 Model Experience 段白名单 |
| `tsconfig.base.json` / `tsconfig.host.json` | PASS: Complete | 新包 alias 与项目引用 |
| `SESSION_STATE.md` | PASS: New | 本文件 |

未跟踪文件：`packages/nilm/sentinel/`、`packages/nilm/notify/`、`packages/nilm/source/src/transaction.ts`、`SESSION_STATE.md`。

---

## Decisions Made

- **告警判定不用模型** — reason: Sentinel 只做确定性规则；Agent 只做异步解释，绝不修改级别、不关闭告警、不阻塞投递。
- **抑制键与去重键分离** — reason: `silence_key = tenant+rule+scope+metric` 跨窗口生效；`dedupe_key` 追加 `bucket_start` 保证每窗口幂等落库。抑制事件仍写事件表（`status=suppressed`），不写 Outbox。
- **升级只穿透一次** — reason: 升级事件以 critical 落库后，下一窗口历史中已有 critical，`escalationFor` 返回 `undefined`，随后由静默窗口抑制，避免每 5 分钟重复升级风暴。
- **安全规则不静默** — reason: R-03/R-04/R-05 的 critical 结果 `bypassSilence=true`。
- **Outbox 至少一次** — reason: 客户端按 `notification_id` 去重；接受 provider 已接收但 `markSent` 前崩溃导致重复。
- **告警列表不暴露分页** — reason: 当前签名契约不接受 query string；先固定返回最近 50 条，待契约调整后再加分页。
- **确认接口先查可见性再锁定事件行** — reason: 避免 `FOR UPDATE` 与外层 `EXISTS` 子查询组合造成 MySQL 锁范围异常。
- **不继承 `dsh-base`** — reason: 生产树只挂载 NILM 所需插件，禁止 shell、文件系统、Web、MCP、终端、sandbox、subagent 工具；`nilm-app` 启动守卫会验证工具面。

---

## Blockers & Open Questions

- 阶段 3 尚未提交 git；`.git` 在当前沙箱只读，需用户在正常终端执行提交。
- 真实环境证据门未签署：30 秒 SLO、MySQL `SKIP LOCKED`、渠道供应商联调。
- 上游 `nilm_unsafe_record` 是否有 `(asset_id, record_time, record_id)` 可用索引仍待 DBA 评估。
- `pnpm` 段错误原因未知；正常环境需重跑 `pnpm install` 验证 lockfile。
- R-01b 自适应基线、R-03 实时过载、R-04 分相电流均为已知延期项，不要误报为已完成。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交阶段 3：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add docs packages/nilm packages/bundle/nilm-app scripts tsconfig.base.json tsconfig.host.json pnpm-lock.yaml SESSION_STATE.md
git commit -m "feat(nilm): implement Phase 3 sentinel rules, alert lifecycle, and reliable notification outbox"
```

2. 新开对话后先读本文件与 `docs/nilm-ai-agent-development-plan.md` §5.4，再进入阶段 4：先实现 `nilm-scheduler` 与 `nilm_job_run` 幂等，再补 R-06/R-07/R-08。
3. 如要先补阶段 3 证据门，优先做真实 MySQL 多进程 Outbox 演练，再做 30 秒 SLO，再做渠道沙箱。

---

## Environment & Setup Notes

- 测试（临时配置可能仍在 `/tmp/vitest.nilm.config.mjs`）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
```

若临时配置丢失，需重建 alias：`@deepseek-ai/dsh-nilm-*` 指向 `packages/nilm/*/src`，并加入 `packages/util/{brand,values}`、`packages/core/{tools,scope,system-prompt}`、`vendor/{cordis,schemastery,cosmokit,include,loader,timer}`；`include` 同时覆盖 `packages/nilm/*/tests/**/*.spec.ts` 与 `packages/bundle/nilm-app/tests/**/*.spec.ts`。

- TypeScript 单包检查可直接用本机 store 的 `tsc`，不要依赖根 `pnpm`：

```sh
D=$(ls -d ~/.local/share/pnpm/store/v11/links/@/typescript/5.9.3/*/node_modules/typescript/bin/tsc | head -1)
node "$D" -p <临时 noEmit 配置>
```

- 文档门禁：

```sh
node --experimental-transform-types scripts/verify-translation-pairing.ts
node --experimental-transform-types scripts/verify-package-readme-limitations.ts
node --experimental-transform-types scripts/verify-package-readme-model-experience.ts
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
```

- 当前环境 `pnpm` 会段错误；不要反复重试。`git` 写操作需在正常终端执行。
