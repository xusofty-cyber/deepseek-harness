# Session: 2026-11-18

**Started:** 2026-11-18 (Asia/Shanghai)
**Last Updated:** 2026-11-18 17:25 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 阶段 4.1：`nilm-scheduler` 晨报、力调预测与 R-08 数据质量巡检

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务，为微信小程序 / App 调用方提供对话、能效分析、安全隐患检索与主动告警。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。

阶段 1/2 已完成拓扑、时序、电价、分析、电能质量、CUSUM、安全、提示词、六个 `nilm_*` 工具与 BFF。阶段 3 已完成 `nilm-sentinel` 巡检规则、告警状态机、抑制升级、事务化 Outbox，以及 `nilm-notify` 可靠投递、四渠道网关契约和 8 秒异步研判。本会话进入阶段 4，完成 WBS 4.1 的 `nilm-scheduler` 离线实现；4.2 StatefulSet 恢复、4.3 百家工厂压测、4.4 安全渗透与全量验收尚未开始。

---

## What WORKED (with evidence)

- **阶段 4.1 调度器离线测试** — confirmed by: `packages/nilm/scheduler/tests` 8 个文件、41 个用例全部通过（2026-11-18 17:32 CST）。覆盖上海业务时间、PF 预测、质量检查、报告载荷、任务幂等、MySQL 仓储映射、默认数据采集器、配置校验与 20 租户 G4-1 演练。
- **报告投递闭环** — confirmed by: `packages/nilm/notify/tests/store.spec.ts` 验证 Outbox 领取映射 `report_id`，并在供应商成功后回填 `nilm_report.delivered_at`；告警行与报告行互不干扰。
- **G4-1 离线演练** — confirmed by: `packages/nilm/scheduler/tests/morning-report.spec.ts` 的 `twenty tenants` 用例通过；20 租户 30 天日数据、5 个计量点、单租户 p95 预算与重复触发不重复报告/投递均有断言。
- **全部 NILM 测试** — confirmed by: 39 个测试文件、279 个用例全部通过（2026-11-18 17:32 CST），包含阶段 3 的 234 个基线用例与新增调度器/Notify 用例。
- **调度器类型检查** — confirmed by: 临时 `noEmit` 配置下 `packages/nilm/scheduler/src` 与 `tests` 除本机无法解析 `vitest` 外零错误；根仓库既有 `zod` 缺失错误不在本包范围。
- **文档门禁** — confirmed by: README limitations 397 个通过；model experience 397 个通过；doc refs 5252 个可解析；doc budgets 7 个在预算内。
- **翻译配对（本包范围）** — confirmed by: `packages/nilm/README.md`、`packages/nilm/sentinel/README.md`、`packages/nilm/scheduler/README.md`、`packages/nilm/notify/README.md` 四个命名配对一致；对应 `README.i18n.yaml` 已重算。

---

## What Did NOT Work (and why)

- **全仓翻译配对门禁** — failed because: 已存在的 `docs/nilm-ai-agent-detailed-design-phase0.md` 至 `phase3.md` 缺少双语配对；这些文件不属于本阶段改动，未擅自生成翻译。本阶段改动的三个 README 配对已单独验证通过。
- **根级 `pnpm` 命令** — not executed because: 本机 `pnpm` 直接段错误；测试与类型检查改用 store 中的 `vitest.mjs` / `tsc` 可执行文件。
- **`vitest --coverage`** — not executed because: 临时环境缺少 `@vitest/coverage-v8`，无法取得覆盖率数字。新增 `store.ts`、`data-source.ts`、`summary-agent.ts` 中，前两者已有直接用例，`summary-agent.ts` 的 Cordis 适配仍未覆盖。
- **真实 MySQL 并发领取、08:35 送达率、渠道回执、真实模型摘要** — 未执行，因为没有测试库、真实接收方与供应商凭证；不能声称 G4-1 现场证据已通过。
- **git 提交** — 未执行：当前环境 `.git` 只读；阶段 3 与本阶段改动仍未提交。

---

## What Has NOT Been Tried Yet

- BFF / Tool 的“查询昨日晨报”读取能力；当前报告只写 `nilm_report`，模型不可见。
- R-08 冷热库一致性检查；当前只写 warning，等待冷电量路由。
- 默认部署的月度 `E_p`/`E_q` 预聚合；当前无配置时 `pf_forecast` 以 `DATA_UNAVAILABLE` 失败。
- WBS 4.2 StatefulSet/PVC 同分片恢复演练。
- WBS 4.3 `test:perf:load` 百家工厂 30 分钟压测。
- WBS 4.4 安全渗透、脱敏审计与全量验收。
- 阶段 3 遗留的真实 30 秒 SLO、MySQL `SKIP LOCKED` 多进程 Outbox、微信/企微/短信沙箱联调。
- R-01b 自适应 4 周基线、R-03 实时功率过载、R-04 分相电流列。

---

## Current State of Files

| File | Status | Notes |
| --- | --- | --- |
| `packages/nilm/scheduler/` | PASS: Complete (offline) | 时间、PF、质量、报告、MySQL 仓储、默认采集器、摘要适配、Cordis 服务与测试 |
| `packages/nilm/scheduler/tests/store.spec.ts` | PASS: New | MySQL 仓储领取状态、报告去重、告警统计、PF 阈值、审计截断 |
| `packages/nilm/scheduler/tests/data-source.spec.ts` | PASS: New | 默认采集器的可恢复缺口、致命失败、月度预聚合与 R-08 观测 |
| `packages/nilm/notify/src/model.ts` / `store.ts` | PASS: Complete | Outbox 任务携带 `report_id`；成功投递回填 `nilm_report.delivered_at` |
| `packages/nilm/notify/tests/store.spec.ts` | PASS: New | 报告领取映射、送达回填、告警/报告隔离与租约丢失 |
| `packages/nilm/notify/README.md` / `README.zh.md` / `.i18n.yaml` | PASS: Complete | 报告 Outbox 与 `delivered_at` 回填说明；双语哈希已重算 |
| `packages/nilm/scheduler/README.md` / `README.zh.md` / `.i18n.yaml` | PASS: Complete | 双语配对哈希已重算 |
| `packages/bundle/nilm-app/cordis.patch.yml` | PASS: Complete | 挂载 `nilm-scheduler`；`enrichConcurrency/enrichCwd` 保留在 notify |
| `packages/bundle/nilm-app/tests/bundle.spec.ts` | PASS: Complete | 生产行清单包含 scheduler |
| `docs/nilm-ai-agent-development-plan.md` | PASS: Complete | 新增 §6.4 当前实现状态与证据门 |
| `docs/nilm-ai-agent-high-level-design.md` | PASS: Complete | §7.6/7.7 实现边界与延期项已更新 |
| `docs/nilm-ai-agent-architecture.md` | PASS: Complete | §8.6、部署边界、定时任务模式已更新 |
| `packages/nilm/README.md` / `README.zh.md` | PASS: Complete | 包表新增 scheduler |
| `packages/nilm/sentinel/README.md` / `README.zh.md` | PASS: Complete | R-06/R-07/R-08 归属改为 scheduler |
| `SESSION_STATE.md` | PASS: New | 本文件 |

未跟踪文件：`packages/nilm/scheduler/`。已修改未提交：阶段 3 的 sentinel/notify/source 等文件、本阶段的 docs、bundle、根配置、lockfile 与会话状态。

---

## Decisions Made

- **幂等键为 `(job_type, tenant_id, business_date)`** — reason: 同一租户同一业务日只计算一次；晨报业务日是昨日，力调与 R-08 使用执行日。
- **多副本依靠数据库幂等而非 Leader 选举** — reason: `nilm_job_run` 唯一键、事务领取与租约即可阻止同业务日重复计算；部署表更新为 1+ 副本。
- **R-06 只做能量加权 PF** — reason: 禁止逐点 PF 平均；当月已完成日实际值 + 最近 7 个同星期中位数，缺失星期回退最近 7 日中位数。
- **R-06 无政策或无月度 P/Q 必须失败** — reason: 不以估算或假数据通过；默认 `MonthlyEnergySource` 显式抛 `DATA_UNAVAILABLE`。
- **模型只写摘要文字** — reason: payload 数字、风险等级、接收方与投递均由确定性代码控制；摘要失败、空白或超时保留模板。
- **报告投递经共享 Outbox** — reason: `nilm_report` 按 `(tenant, report_type, report_date)` 去重；Outbox `notification_id = report_id`，渠道重试归 `nilm-notify`。
- **R-08 不向客户发送** — reason: 覆盖率、父子偏差与冷热一致性属于运维数据质量，只写 `nilm_security_audit` 与日志。
- **scheduler 默认不挂模型** — reason: 仅配置 `summaryModel` 时创建一次性 Cordis Agent；默认模板路径不产生 Session 或模型请求。

---

## Blockers & Open Questions

- 阶段 3 与阶段 4.1 尚未提交；`.git` 在当前沙箱只读，需在正常终端执行提交。
- 全仓 translation-pairing 被四个既有详细设计文档阻塞；需要单独补英文配对或调整其登记范围。
- 真实 G4-1 送达率 >99% 无在线渠道回执，不能签署。
- 默认部署必须提供月度 `E_p`/`E_q` 预聚合，否则 R-06 每天失败；需要上游接口或可信汇总表。
- BFF 查询晨报 Tool 未实现；设计文档已将其列为延期项。
- 覆盖率门禁未取得数字；若 CI 对 `packages/*/*/src` 执行 per-file 100%，需为 `summary-agent.ts` 补 Cordis 适配测试，并确认阶段 3 store 文件的既有缺口。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交阶段 3 与阶段 4.1：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add docs packages/nilm packages/bundle/nilm-app scripts tsconfig.base.json tsconfig.host.json pnpm-lock.yaml package.json SESSION_STATE.md
git commit -m "feat(nilm): add scheduled reports, monthly PF projection, and data-quality jobs"
```

2. 下一开发单元优先 WBS 4.2：新增 `deploy/k8s/` StatefulSet、Service、Ingress、NetworkPolicy 与同分片 PVC 恢复测试；不要声称跨分片漂移恢复。
3. 若先补产品闭环，再实现“查询昨日晨报”Tool：只读 `nilm_report`，按已验证 `tenant_id` 与 `user_ref` 绑定，不重算、不暴露跨租户报告。
4. 现场证据门顺序：真实 MySQL 幂等并发 → 渠道沙箱与 08:35 送达率 → 百家工厂压测 → 安全渗透。每项必须保存命令、输出与时间戳。

---

## Environment & Setup Notes

- NILM 全量测试（临时配置在 `/tmp/vitest.nilm.config.mjs`）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
```

- 调度器单项：

```sh
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/scheduler/tests
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/scheduler/tests/morning-report.spec.ts -t 'twenty tenants'
```

- 类型检查（临时 `noEmit` 配置在 `/tmp/tsconfig.scheduler.json`）：

```sh
D=$(ls -d ~/.local/share/pnpm/store/v11/links/@/typescript/5.9.3/*/node_modules/typescript/bin/tsc | head -1)
node "$D" -p /tmp/tsconfig.scheduler.json
```

- 文档门禁：

```sh
node --experimental-transform-types scripts/verify-package-readme-limitations.ts
node --experimental-transform-types scripts/verify-package-readme-model-experience.ts
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
node --experimental-transform-types scripts/verify-translation-pairing.ts packages/nilm/README.md packages/nilm/sentinel/README.md packages/nilm/scheduler/README.md packages/nilm/notify/README.md
```

- 当前环境 `pnpm` 会段错误；不要反复重试。`git` 写操作需在正常终端执行。
