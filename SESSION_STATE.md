# Session: 2026-11-23

**Last Updated:** 2026-11-24 14:33 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Branch:** `feat/nilm-ai-agent-architecture`
**Base:** `origin/master` at merge-base `39163dd30f703a79079e2d2446545cff3c453738`
**Topic:** NILM 全量审查修复、回归验证与独立复审（已提交 `aaf8554472`，未推送）

## Current State

阶段 0-4 的开发已在分支上完成。第三次独立复审（1 Critical、1 Important、2 Minor）已全部修复；第四次独立复审 `REJECT`（2 Critical、1 Important、3 Minor）的修复已落在工作区：`TABLE`/`VALUES` 查询表达式、生产 SQL 字面量、危险函数/变量、`VALUES()` 弃用、`record_id` 字节序与 `scan_offset` 上限。16:33 CST 重建临时测试配置后，完整 NILM 套件（49 文件、467 用例，含 `recovery.spec.ts`）、tsc 与文档门禁全部通过，测试规格计数已按 Vitest JSON 统一。第五次独立只读复审 `APPROVE`（0 Critical、1 Important、5 Minor）；其中 Important I-1 已在 16:45 CST 修复，完整套件 49 文件、469 用例通过（1 跳过）。第六次独立复审 `REJECT`（0 Critical、2 Important、5 Minor），两条 Important 与 Minor 3/6/7 已在 17:53 CST 修复，完整套件 49 文件、485 用例通过（1 跳过），待第七次复审。上述改动已提交为 `b3ed5205f6`（68 文件，未推送）。第七次独立复审 `REJECT`：C-1 `sql-guard.ts` 允许 `FROM ((SELECT ...) s, secret_table)` 括号表引用列表绕过白名单；m-3 `nilm_sentinel_watermark.record_time` 为 `DATETIME`，毫秒写入会进位越过同秒记录。2026-11-24 08:58 CST 已在工作区修复（括号深度 >1 一律拒绝；`record_time` 改 `DATETIME(3)`），各补 1 条回归；Vitest 49 文件、487 用例，486 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格计数已同步（总数 487、阶段 0 为 129、G0-1 106、G0-2 74）。第八次独立复审 `REJECT`（1 Critical、2 Important、2 Minor）：C-1 以 `INTERSECT`/`EXCEPT`/`WINDOW` 作别名后接逗号绕过逗号连接检测；I-1 `processUnsafeRow` 稳定抛错卡住 Sentinel 水位；I-2（原 m-5）`failJob` 抛错中断后续租户。2026-11-24 10:08 CST 已在工作区修复：三词仅在运算符形态结束 FROM（+6 用例）；单行处理失败先保存已处理前缀水位，同一 record 连续失败 3 次后死信跳过（+2 用例）；`failJob` 单独 try/catch（+1 用例）。Vitest 49 文件、496 用例，495 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格计数已同步（总数 496、阶段 0 135、阶段 3 84、阶段 4 128、G0-1 112、G0-2 80、G3-1 34）。第九次独立复审 `REJECT`（1 Critical、0 Important、6 Minor）：C-1 派生表别名 `intersect`/`except` 后接列清单 `(c)` 时被误判为集合运算符，`FROM (SELECT ...) intersect (c), secret` 绕过逗号连接检测；Minor 5 `scanOnce` catch 内 `saveWatermark` 抛错会覆盖原始处理错误。2026-11-24 11:21 CST 已在工作区修复：`INTERSECT`/`EXCEPT` 后的 `(` 仅当紧跟 `SELECT`/`WITH`/`(` 时视为运算符，前一词为 `AS` 时三词一律视为别名（+4 拒绝用例、+2 合法放行断言）；前缀水位保存单独 try/catch，记 warn 后仍抛原始错误（+1 用例）。Vitest 49 文件、501 用例，500 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格计数已同步（总数 501、阶段 0 139、阶段 3 85、G0-1 116、G0-2 84、G3-1 35、sql-guard 57、scanner 22）；`git diff --check` 通过。第十次复审（当前会话自审，非独立；子代理连续截断未能启动）`REJECT`（0 Critical、1 Important、3 Minor）：I-1 死信不区分错误类型，本地库连续约 15 秒不可用即丢安全告警；Minor 守卫放行若干依赖 MySQL 语法报错的畸形语句（`FROM t intersect (secret)`、`WINDOW w AS (...), secret`、`procedure, secret` 等）、`unsafeRowFailures` 满额整体清空、失败计数重启丢失。2026-11-24 13:47 CST 已在工作区修复：仅 `NilmError(INVALID_ARGUMENT)`/`TypeError`/`RangeError`/`SyntaxError` 计入死信，其余错误保留前缀水位后重抛、永不跳行（+1 用例）；`unsafeRowFailures` 改为淘汰最旧项；计数仅存内存已在代码注释写明；非派生表后接列清单拒绝、`WINDOW` 逗号后须为窗口定义、`PROCEDURE` 列入禁用子句（+4 拒绝用例、+1 合法放行）。Vitest 49 文件、507 用例，506 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格计数已同步（总数 507、阶段 0 144、阶段 3 86、G0-1 121、G0-2 89、G3-1 36、sql-guard 62、scanner 23）。修复（含第十次复审 Minor-1/2/3，基线 519 用例）已提交为 `aaf8554472`（10 文件，**未推送**），待第十一次独立复审（须在仓库外启动，避免 `AGENTS.md` 注入截断任务）。

## Independent Re-review（2026-11-23 14:58 CST）

- **Critical（已修复）**：`packages/nilm/source/src/sql-guard.ts` 原 `TABLE_REFERENCE` 正则不识别 `STRAIGHT_JOIN`，`SELECT * FROM nilm_tenant_config STRAIGHT_JOIN secret_table` 可绕过表白名单；修复见下方 Review Remediation。
- **Important（已修复）**：`packages/nilm/sentinel/src/index.ts:237,302-324` 的 `scanOffset` 原仅存进程内存；毒前缀超过单轮处理量时，频繁滚动重启会反复从头扫描并延迟后续有效记录，与重启续扫承诺不一致。
- **Minor（已修复）**：`docs/nilm-ai-agent-test-specifications.md:677` 的 G3-1 计数过期；`scanner.spec.ts` 新增重启续扫用例后实际为 `19 + 13 = 32`，已同步。
- **Minor（已修复）**：`packages/nilm/sentinel/tests/store.spec.ts` 原只断言 SQL 文本片段；现以内存表按 MySQL 左到右赋值语义执行真实 upsert 语句，4 个用例覆盖回退拒绝、同水位偏移只增、前进归零、旧进程偏移不回写；交换赋值顺序的变异会使测试失败。

## Review Remediation

- **毒记录扫描偏移持久化（第三次复审 Important）**：`nilm_sentinel_watermark` 新增 `scan_offset INT UNSIGNED NOT NULL DEFAULT 0`；`Watermark.scanOffset` 可选字段；`loadWatermark()` 读回并把非法值归零；`saveWatermark()` 在同一条 `ON DUPLICATE KEY UPDATE` 中先判定 `scan_offset` 再移动 `(record_time, record_id)`：水位前进时采用新偏移，水位相同时只增不减，旧进程不能回退。`scanOnce()` 每走完一个全毒批次即持久化偏移，有效行推进水位后归零；`ensureWatermark()` 重启时恢复偏移。新增 `scanner.spec.ts` 回归：24 条毒行 + 1 条有效行、批 2 条，首轮停在 offset 20，新实例共享 store 只读剩余 5 行并交付告警。架构/HLD/Sentinel 双语 README 已同步。
- **SQL 表因子绕过（第三次复审 Critical）**：探针确认正则提取另有三类漏洞：`JOIN (secret_table)` / `JOIN ((secret_table))` 括号表名、`` `a`.`b` `` 只取前段、子查询内 `FROM a, secret_table` 逗号连接。`assertReadOnlySql()` 改为轻量词法切分：`FROM`/`JOIN`/`STRAIGHT_JOIN` 后按 `ident(.ident)*` 读完整限定名；括号表源仅允许 `(SELECT ...)` 派生表（其内表照常校验）；每层括号独立检测逗号连接（覆盖子查询与 `UNION` 分支）；拒绝双引号（ANSI_QUOTES 标识符）、未闭合/转义反引号、括号不配对；标识符字符集含 `$` 与非 ASCII。`sql-guard.spec.ts` 由 10 增至 21 个用例，含 `information_schema.tables` 实际查询放行。
- **SQL 逗号 JOIN 绕过（Critical）**：`assertReadOnlySql()` 改为在 FROM 子句内按顶层括号深度检测逗号，允许 `IN (?, ?)`、函数参数与 `GROUP BY a, b`；新增 `ON ... , secret_table` 精确回归用例。
- **Sentinel 租户映射**：`sourceTenantId` 改为必填并在 profile/K8s 暴露 `NILM_SOURCE_TENANT_ID`；映射缺失时在读取上游前失败且不推进水位，补齐映射后后续行可交付；双租户同 node 只交付映射租户。
- **Sentinel 毒记录与水位线**：移除 512 条 dead-letter 上限导致的永久停扫；时间解析失败行记录日志并由扫描偏移有界推进，只有有效行推进水位；新增 513 条毒行后有效行仍交付的回归。
- **Sentinel 多副本重复扫描**：`start()` 与 `scanOnce()` 均只允许 shard 0；K8s 仍以 `NILM_SHARD_INDEX` 派生分片；未实现 Redis/Lease 选主，已在架构与 Sentinel README 中明确。
- **SQL 守卫与驱动泄露**：逗号 JOIN 现在按 FROM 子句结构拒绝；MySQL `SOURCE_UNAVAILABLE` 对外只返回稳定 `source query failed`，原始驱动错误仅作为 `cause`。
- **Scheduler claim 隔离**：单租户 `claimJob()` 失败记为失败结果，不再中断整轮；新增 tenant-a 抛错、tenant-b 继续的回归用例。
- **Turn/Session/缓存回收**：完成 Turn 按 TTL、条数与字节上限淘汰；只有存在 complete 幂等项的 Turn 才保留 receipt，并为 receipt 增加 TTL 清理；失败发送淘汰后重放会重新处理而非伪造成功回执；空闲 Session 在 TTL 后 `runtime.release()`，维护定时器兜底清扫；对话缓存 LRU 淘汰但不隐藏 PVC 持久记录；按用户分钟窗口与租户并发上限返回 `429` + `Retry-After`，分片拒绝先于限流计数。
- **Sentinel 水位单调性**：MySQL `saveWatermark()` 使用 `(record_time, record_id)` 条件更新，旧扫描进程不能覆盖更新水位；新增存储级回归。
- **响应边界**：新增共享 `assertHttpEndpoint()` 与有界流式读取；notify、cold proxy、TDengine 均拒绝超限响应与非 HTTP(S)/带凭证 endpoint，并禁止重定向。
- **结构化截断**：`NilmDataQuality.truncated` 由 timeseries 各采样上限写入；`nilm_energy_query` 不再匹配英文文案。
- **CI 门禁**：删除全部新增 `as unknown`，未扩展 baseline；空 `catch` 已命名并说明原因。
- **文档与 DDL**：测试规格更新为 48 文件/416 用例、19 张表、符号级锚点；修正 core/fetch-body 标题归属与 DDL 18→19；service/sentinel/bundle/K8s 双语 README、高层设计、架构与开发计划同步限流、nonce、shard 0 与必填租户映射事实。

## Verification Evidence

### 2026-11-23 16:33 CST（第四次复审修复后，重建临时配置）

临时配置从 `/tmp/nilm-tmp-harness/` 复制回仓库根目录（`.vitest.nilm.tmp.config.mjs`、`.tsconfig.nilm.tmp.json`），可解析子路径导出，`recovery.spec.ts` 正常加载。

```sh
node node_modules/vitest/vitest.mjs run --config .vitest.nilm.tmp.config.mjs --reporter=json --outputFile=/tmp/nilm-results-r5.json
node node_modules/typescript/bin/tsc -p .tsconfig.nilm.tmp.json
```

- Vitest：`49` 个测试文件、`467` 个用例；`466` 通过、`0` 失败、`1` 跳过（`recovery.spec.ts` 原生 flock）；退出码 `0`。
- 相对 14:55 的 48/416 口径：新增 `production-sql.spec.ts`（25，扫描 24 条生产只读 SQL 逐条过 `assertReadOnlySql`）；`sql-guard.spec.ts` 10→30；`sentinel/tests/store.spec.ts` 新增 6；`scanner.spec.ts` 17→19。15:19 的 46 文件口径源于 `/tmp/nilm-vitest.config.mjs` 不支持子路径导出，已弃用。
- tsc：`^packages/nilm` 错误 `0`；退出码 `2` 仅来自 `vendor/cordis`（58）、`vendor/cosmokit`（6）、`vendor/schemastery`（4）既有错误。
- 文档门禁全部退出 `0`：doc refs 5275 文件、doc budgets 7 份、md links 2649 文件；empty catch 无新增（132 条既有）；no-unknown-casts 无新增（1214 条既有）；4 组双语 README 配对一致；`git diff --check` 通过。
- 测试规格 `docs/nilm-ai-agent-test-specifications.md` 统一更新：第 16 行与基线表合计 49/467（日常 48/465 + recovery 2）、阶段 0 为 14/109、阶段 3 为 10/82；第 81 行 sql-guard 30 断言及用例清单；新增 production-sql 条目；sentinel store 6 断言；G0-1 `source/tests` 86；G0-2 `sql-guard 30 + production-sql 25 = 55`；G3-1 `19 + 13 = 32`。每个文件条目计数与 JSON 逐一 diff 一致，阶段行求和 = 合计。

### 2026-11-23 15:19 CST（STRAIGHT_JOIN 修复后）

```sh
node node_modules/vitest/vitest.mjs run --config /tmp/nilm-vitest.config.mjs packages/nilm/source
node node_modules/vitest/vitest.mjs run --config /tmp/nilm-vitest.config.mjs --reporter=json --outputFile=/tmp/nilm-results-sqlfix.json
```

- `packages/nilm/source`：7 文件、52 用例全部通过；`sql-guard.spec.ts` 21/21。
- 全量 NILM：`418` 用例通过、`0` 失败；`recovery.spec.ts` 加载失败（临时配置无法解析子路径导出 `@deepseek-ai/dsh-compaction-image-offload/projection`，与本次改动无关），本次未计入。
- `verify-empty-catch`、`verify-no-unknown-casts` 退出 `0`；`git diff --check -- packages/nilm/source` 通过。
- **口径未对齐**：临时配置统计 46 个测试文件（含加载失败的 recovery），与先前 48 文件/416 用例不一致；原临时配置已不存在，差异来源未核实。因此测试规格文档中的 416、G0-2「9 断言」、第 81 行「10 个断言」均未改。

### 2026-11-23 14:55 CST（第二轮修复后，先前记录）

命令均在本机工作区实际执行：

```sh
node node_modules/vitest/vitest.mjs run --config .vitest.nilm.tmp.config.mjs --reporter=json --outputFile=/tmp/nilm-results-fixed2.json
```

- `48` 个测试文件、`416` 个用例；`415` 通过、`0` 失败、`1` 跳过（`recovery.spec.ts` 缺少原生 flock）；退出码 `0`。
- 新增用例覆盖：SQL `ON ... , secret_table` 拒绝、子句内逗号放行、必填租户映射、映射缺失水位不变、513 条毒行后有效行交付、watermark 回退防护、失败发送淘汰后幂等回执不泄漏、错误分片不消耗限流额度。

```sh
node node_modules/typescript/bin/tsc -p .tsconfig.nilm.tmp.json
```

- `packages/nilm/**/src` 零错误；退出码 `2` 仅来自 `vendor/cordis` 在临时 source-plane 配置下的既有类型错误，未出现在任何 NILM 文件。

```sh
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
node --experimental-transform-types scripts/verify-md-links.ts
node --experimental-transform-types scripts/verify-empty-catch.ts
node --experimental-transform-types scripts/verify-no-unknown-casts.ts
node --experimental-transform-types scripts/verify-translation-pairing.ts packages/nilm/service/README.md packages/nilm/sentinel/README.md packages/bundle/nilm-app/README.md deploy/k8s/README.md
```

- 以上门禁全部退出 `0`：doc refs 5274 文件、doc budgets 7 份、md links 2649 文件；empty catch 无新增；no-unknown-casts 无新增；四组双语 README 配对一致；`git diff --check` 通过。

## Open Field Gates

- G0-1/G0-4、G1-4、G3-1、G3-3/G3-4、G4-1/G4-2/G4-3/G4-4 的现场证据仍未完成：真实 MySQL/TDengine、K8s SIGKILL/PVC、30 秒 SLO、100 租户压测、双租户安全复验、生产日志/KMS/保留期。
- G4-4 仍需安全负责人签署无 Critical/High 结论。
- 真实 MySQL 上的 `nilm_source_tenant_map` 填充与运维流程尚未演练；部署必须先设置 `NILM_SOURCE_TENANT_ID` 并写入映射再启用 Sentinel。

## Environment Notes

- 本机 `pnpm` 仍不可用（段错误）；测试使用 pnpm store 的 `vitest.mjs` 直跑。
- 为运行完整套件，临时在 `node_modules` 建立 `vite`、`@js-temporal/polyfill`、`rrule`、`p-limit`、`zod`、`@standard-schema/spec` 的软链接；这些均未写入仓库。
- `.vitest.nilm.tmp.config.mjs`、`.gen-vitest-nilm.tmp.mjs`、`.tsconfig.nilm.tmp.json` 是本地临时文件，不属于交付；15:18 CST 核查时 `.vitest.nilm.tmp.config.mjs` 与 `.tsconfig.nilm.tmp.json` 已不在仓库根目录。
- 仓库 `vitest.config.ts` 因缺 `vite-tsconfig-paths` 无法加载；当前替代为 `/tmp/nilm-vitest.config.mjs`（把 `packages/`、`vendor/` 下包名别名到各自 `src/index.ts`），不支持子路径导出，不属于交付。
- 覆盖率门禁未执行：临时安装缺 `@vitest/coverage-v8`；不得声称 per-file 100% 覆盖率已通过。

## Key Files

- `packages/nilm/core/src/fetch-body.ts`（新增）：endpoint 校验与有界响应读取。
- `packages/nilm/sentinel/src/index.ts`、`store.ts`、`source.ts`：必填租户映射、偏移扫描、shard 0、单调 watermark。
- `packages/nilm/source/sql/init-nilm-system.sql`：新增 `nilm_source_tenant_map`。
- `packages/nilm/service/src/http.ts`、`runtime.ts`：限流顺序、并发槽、Turn receipt TTL、缓存淘汰、Session release。
- `packages/nilm/source/src/{sql-guard,mysql,tdengine,cold-proxy}.ts`：SQL 白名单（词法表因子解析）、稳定错误与响应边界。
- `docs/nilm-ai-agent-test-specifications.md`：49 文件/467 用例清单与证据门矩阵（16:33 CST 按 Vitest JSON 同步，含 sql-guard 30、production-sql 25、sentinel store 6）。
- `packages/nilm/source/tests/production-sql.spec.ts`（新增）：所有生产只读 SQL 经 `assertReadOnlySql` 的静态回归。

## Independent Re-review #6（2026-11-23 17:42 CST）— REJECT（已处理，待第七次复审）

- 结论：C1（`TABLE`/`VALUES` 查询表达式）与 C2（生产 SQL 字面量）确认已修复；新发现 2 Important、5 Minor。
- I-1（已修复）：反引号包裹的危险函数名（`` `SLEEP`(…) ``、`` `GET_LOCK`(…) `` 等）绕过正则黑名单。守卫改为分词后逐 token 检查：裸词或反引号名在 `FORBIDDEN_FUNCTIONS` 中且下一个 token 为 `(` 即拒绝。
- I-2（已修复）：`FOR SHARE`、`NOWAIT`、`SKIP LOCKED`、`SOURCE_POS_WAIT`/`MASTER_POS_WAIT`/`WAIT_FOR_EXECUTED_GTID_SET`/`WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS` 放行。`FOR`、`NOWAIT`、`LOCKED`、`INTO`、`OUTFILE`、`DUMPFILE` 作为裸词禁止，等待类函数加入禁用集合。
- Minor 3（已修复）：关键字检查只作用于裸词，反引号列名/别名 `` `values` ``、`` `table` `` 放行。
- Minor 6（已修复）：测试规格 G1-3 的 `http.spec.ts` 计数 24→26。
- Minor 7（已修复）：无表豁免收紧为整句 `^SELECT\s+(?:1|\?)$`，`SELECT 1, USER(), …` 拒绝。
- 未处理（已知风险）：`production-sql.spec.ts` 不识别别名/解构调用且 `' AND 1 = 0'` 分支未校验；`notify/src/store.ts:282-286` 仍用已弃用的 `VALUES()`。
- `sql-guard.spec.ts` 30→46（+16）。17:53 CST 复跑：Vitest 49 文件、485 用例，484 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格已同步（总数 485、阶段 0 为 127、G0-1 104、G0-2 73、G1-3 35）；`git diff --check` 通过。

## Independent Re-review #5（2026-11-23 16:43 CST）— APPROVE

- I-1（已修复）：`production-sql.spec.ts` 原正则只识别反引号模板，漏掉 `source/src/index.ts:189` 的单引号 SQL。改为宽松匹配全部调用点（排除方法声明），首参支持三种引号，非内联字面量的调用点判失败；阈值提到 25。变异验证：把该 SQL 改为变量 `LIST_SQL` 后测试失败（2 条），恢复后 `git diff` 无残留。
- 未处理的 Minor（记为已知风险）：M-1 插值展开为固定代表值，三元两支未分别测；M-2 守卫未拦 `USER()`/`VERSION()` 等信息函数；M-3 store upsert 语义仅用模拟求值器验证，需真实 MySQL 8.0.20+ 集成用例；M-4（18:05 CST 已处理）部署文档补“数据库账号”一节；M-5 未加引号的 `table`/`values` 列名或别名会被误拒。
- 18:05 CST M-4：`deploy/k8s/README.md` 与 `README.zh.md` 新增“Database accounts / 数据库账号”一节：上游库只授两张白名单表的 `SELECT`，项目库授 `SELECT/INSERT/UPDATE/DELETE` 不含 DDL，迁移脚本用单独账号，附 `GRANT` 示例与 `SHOW GRANTS` 核对；`README.i18n.yaml` 已重新记录，`verify-translation-pairing` 通过。
- 16:45 CST 复跑：Vitest 49 文件、469 用例，468 通过、0 失败、1 跳过；tsc `^packages/nilm` 错误 0；测试规格已同步（总数 469、阶段 0 为 111、production-sql 27、G0-1 88、G0-2 57）；`git diff --check` 通过。

## Independent Re-review #4（2026-11-23 16:11 CST）— REJECT（已全部处理，待第五次复审）

处理结果（16:33 CST 验证）：C1 `FORBIDDEN_KEYWORDS` 加 `TABLE`/`VALUES` 并补 3 条回归；C2 生产 SQL 字面量 `'10'` 等改 `?` 绑定，新增 `production-sql.spec.ts` 静态扫描全部生产只读 SQL 经守卫校验；I1 禁 `LOAD_FILE`、`GET_LOCK` 系列、`INTO`、`@`/`@@`，补 6 条回归，架构文档 1659 行已规定上游只读账号不授 `FILE`/`PROCESS`；M1 upsert 改为全绑定参数，不再使用 `VALUES()`；M2 `record_id` 列 `COLLATE utf8mb4_bin`，补字节序用例；M3 写入前钳制到 INT UNSIGNED 上限，补用例。


第三次复审 4 项中 scanOffset 持久化、G3-1/测试规格计数、store.spec 语义测试已核实修复；sql-guard 原绕过已封住，但发现新问题：

- **Critical C1**：`packages/nilm/source/src/sql-guard.ts`：MySQL 8.0.19+ `TABLE t` 语句绕过白名单，`... UNION TABLE mysql.user`、`WHERE EXISTS (TABLE mysql.user)` 被放行。建议 `FORBIDDEN_KEYWORDS` 加 `TABLE`、`VALUES` 并补回归。
- **Critical C2**：守卫拒绝单引号字面量，但 `packages/nilm/sentinel/src/source.ts:36,64` 的生产 SQL 含 `unsafe_type <> '10'`，`head()`/`readAfter()` 运行时必被拒，scanOffset 路径在生产不可达。疑似同类：`safety/src/index.ts:161`、`scheduler/src/data-source.ts:261`、`sentinel/src/store.ts:510`。HEAD 已存在（非本轮引入）。建议改为 `?` 绑定参数，并新增测试让所有生产只读 SQL 经过 `assertReadOnlySql`。
- **Important I1**：守卫未禁 `LOAD_FILE`、`GET_LOCK`/`RELEASE_LOCK`、`INTO @`、`@@`；部署文档需写明上游账号不授 FILE 权限。
- **Minor M1**：`store.ts` `VALUES()` 在 MySQL 8.0.20+ 弃用，可改 `INSERT ... AS new`。
- **Minor M2**：`store.spec.ts` 求值器按二进制比较 `record_id`，与列 collation 不一致；补大小写用例或列加 `COLLATE utf8mb4_bin`。
- **Minor M3**：`scan_offset` 写入前未限 INT UNSIGNED 上限。
- 复审员 tsc 输出被截断，另见 `vendor/cosmokit`、`vendor/schemastery` 错误；本地 grep `^packages/nilm` 为 0。

## 第十次独立复审（2026-11-24 14:20–14:33 CST，主会话直接执行）

- 子代理两次因 `AGENTS.md` 注入截断而未执行，改为主会话只读复审；报告 `/tmp/nilm-review10/REVIEW.md`，探针 `/tmp/nilm-review10-agent/probe.spec.ts`（48 条）。
- 结论 `APPROVE`（0 Critical / 0 Important / 3 Minor）。第九次 C-1（`intersect (c), secret`）与 Minor 5（前缀水位保存失败覆盖原始错误）均已核实修复。
- 审阅时发现基线漂移：13:47–13:49 另有修改落地（507 用例），本次以当前工作区为准。
- **Minor-1（已修复）**：`sql-guard.ts` `endsFromClause` 对 `INTERSECT/EXCEPT (` 只看首词，`(SELECT …) intersect ((c)), secret` 与 `intersect (select), secret` 被放行。现跳过全部开括号，要求 `SELECT/WITH` 后紧跟的不是 `)`/`,`；FROM 中多层括号列清单直接拒绝（`malformed set operator operand`）。新增 2 条拒绝用例。
- **Minor-2（已修复）**：`SELECT STRAIGHT_JOIN a FROM t` 误把修饰符当表源。现 `STRAIGHT_JOIN` 前一词为 `SELECT/ALL/DISTINCT/DISTINCTROW/HIGH_PRIORITY`（均为保留字，不能作未加引号的别名）时跳过；新增 1 个用例（含修饰符 + 真 STRAIGHT_JOIN 白名单拒绝）。
- **Minor-3（已修复，14:39 CST）**：`sql-guard.ts` 新增 `collectCteScopes`，CTE 名仅在其作用域（自身体之后到所在括号层/语句结束：后续 CTE 体、主查询及其子查询）解析为 CTE；每个 CTE 体照常查白名单；自身体或更早体内、大小写不同、库名限定（`other_db.s`）的同名引用仍按表查白名单；`WITH` 只在语句开头或 `(` 后视为 CTE（`WITH ROLLUP` 不受影响）；`WITH RECURSIVE` 与非裸 SELECT 的 CTE 体拒绝。新增 1 个放行用例（6 条断言）与 8 条拒绝用例。
- 实测（14:33 CST）：Vitest 49 文件 510 用例，509 通过、0 失败、1 跳过；`packages/nilm` tsc 0 错误；改动仍限于原 10 个文件。修改前备份 `/tmp/nilm-fix-minor1-backup/`。
- 实测（15:49 CST，Minor-3 修复后）：Vitest 49 文件 519 用例，518 通过、0 失败、1 跳过；`packages/nilm` tsc 0 错误（123 行均为 `vendor/*` 既有错误）；测试规格计数已同步（合计 519、日常 517、阶段 0 156、sql-guard 74、G0-1 133、G0-2 101）；`git diff --check` 通过；改动仍限于原 10 个文件，临时配置已移回 `/tmp/nilm-tmp-harness/`。文档修改前备份 `/tmp/nilm-fix-minor3-backup/`。

## Next Step

1. 第十一次独立复审待进行（须在仓库外目录启动子代理或新任务，避免 `AGENTS.md` 注入截断任务；任务书模板 `/tmp/nilm-review9-brief.md` 需按当前基线 519 更新）：复核第十次 I-1（死信按错误类型分类）与 Minor（列清单、WINDOW 逗号、PROCEDURE、Map 淘汰最旧）修复、第十次 Minor-1/2/3（`intersect ((c))`、`SELECT STRAIGHT_JOIN` 修饰符、CTE 作用域）修复，并补做第九次 C-1、Minor 5 的独立复核。第九次 M1/M2/M4 已于 13:47 CST 修复。仍为已知风险：M3 死信只写日志不落库；M6 多 ownership 部分写入后重试可能因 history 触发升级换 `dedupeKey` 多发一条通知（推断，整批重放时已存在）。第八次 Minor 未处理：m-1 `cordis.patch.yml:121,175` shardIndex 解析（空串得 0、非数字后缀得 NaN、`replicas == NILM_SHARD_COUNT` 运行时不校验）；m-2 store 测试替身不模拟 DATETIME 精度，需在文档写明上游 `record_time` 精度假设；已部署环境需另行 `ALTER` `record_time` 为 `DATETIME(3)`。
2. 第六次复审未处理的已知风险：`production-sql.spec.ts` 不识别别名/解构调用且 `' AND 1 = 0'` 分支未校验；`notify/src/store.ts:282-286` 仍用已弃用的 `VALUES()`。第五次复审 Minor M-1、M-2、M-3、M-5 仍未处理（M-4 已于 18:05 CST 处理）。
3. 临时文件 `.vitest.nilm.tmp.config.mjs`、`.tsconfig.nilm.tmp.json` 不在仓库内，副本在 `/tmp/nilm-tmp-harness/`；再跑测试需临时拷回，跑完再删除。
4. 仍待补：`recovery.spec.ts` 原生 flock 环境、覆盖率门禁（缺 `@vitest/coverage-v8`）、Open Field Gates 现场证据。
5. 推送由用户决定；不要自行 `git add .`。
