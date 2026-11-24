# NILM 工厂端 AI Agent 测试规约与验证矩阵

## 0. 文档说明

- **业务需求基线**：[docs/nilm-ai-agent-requirements.md](nilm-ai-agent-requirements.md)
- **系统架构方案**：[docs/nilm-ai-agent-architecture.md](nilm-ai-agent-architecture.md)
- **概要设计规范**：[docs/nilm-ai-agent-high-level-design.md](nilm-ai-agent-high-level-design.md)
- **开发任务书与证据门**：[docs/nilm-ai-agent-development-plan.md](nilm-ai-agent-development-plan.md)
- **分阶段详细设计**：
  - [阶段 0：基础设施与沙箱初始化](nilm-ai-agent-detailed-design-phase0.md)
  - [阶段 1：问答核心链路与确定性计算](nilm-ai-agent-detailed-design-phase1.md)
  - [阶段 2：电能质量、时序边沿检测与算法协同](nilm-ai-agent-detailed-design-phase2.md)
  - [阶段 3：主动巡检引擎与可靠通知投递](nilm-ai-agent-detailed-design-phase3.md)
  - [阶段 4：报告调度、租户分片、压测与安全验收](nilm-ai-agent-detailed-design-phase4.md)

本文档是当前可执行测试的清单与证据门映射，不替代开发计划中的现场验收。计数来自 2026-11-24 的 Vitest JSON：**49 个测试文件、528 个断言**；日常套件 48 个文件、526 个断言全部通过；`recovery.spec.ts` 的 2 个断言中 1 个通过、1 个因缺少原生 flock 跳过。

阅读约定：用例标题直接复制当前 `it()` 标题；文件级“覆盖”是摘要，逐条断言语义以标题和测试代码为准；“现场待验”表示离线用例不能替代的环境证据。

## 1. 测试规模基线

| 阶段 | 文件数 | 断言数 | 说明 |
| :--- | ---: | ---: | :--- |
| 阶段 0 | 14 | 156 | 核心类型、有界 HTTP 读取、上下文、数据源、存储驱动、Bundle/守卫 |
| 阶段 1 | 9 | 122 | 资产、时序、安全记录、提示词、Tool、BFF、电价/分析 |
| 阶段 2 | 2 | 33 | 电能质量与 CUSUM |
| 阶段 3 | 10 | 86 | Sentinel 与 Notify |
| 阶段 4 | 14 | 131 | 调度、分片、恢复、压测与安全审计 |
| **合计** | **49** | **528** | 日常 526 + recovery 2（1 skip） |

## 2. 阶段 0：基础设施、数据源与生产沙箱

本阶段验证核心类型、调用上下文、只读数据访问、存储驱动与生产 Bundle 边界。

### 2.1 核心类型与统一脱敏

**`packages/nilm/core/tests/core.spec.ts`** — 3 个断言（3 通过）。覆盖：品牌标识在运行期仍是字符串；错误名称与错误码稳定；ChartSpec v1 拒绝 ECharts marks。

- `keeps branded identifiers at runtime strings`
- `exposes stable error names and codes`
- `accepts the versioned chart contract without ECharts marks`

**`packages/nilm/core/tests/fetch-body.spec.ts`** — 5 个断言（5 通过）。覆盖：只接受无凭证的绝对 HTTP(S) endpoint；低于上限的正文可读；声明的 `content-length` 超限在读体前拒绝；流式正文超限时取消读取；畸形 `content-length` 拒绝。

- `accepts only absolute credential-free http endpoint URLs`
- `reads a body below the byte ceiling`
- `rejects a declared content length above the ceiling before reading`
- `rejects a streamed body that exceeds the ceiling`
- `rejects a malformed content length`

**`packages/nilm/core/tests/redact.spec.ts`** — 5 个断言（5 通过）。覆盖：手机号保留前后缀掩码；OpenID、Bearer/Authorization/API Key/NILM 签名脱敏；普通业务文本与嵌套 JSON 结构保留。

- `masks mainland mobile numbers while keeping the operator-friendly prefix and suffix`
- `masks labeled and raw OpenID values`
- `masks bearer tokens, authorization headers, API keys, and NILM signatures`
- `preserves ordinary business text and numbers`
- `masks sensitive JSON fields without changing the surrounding structure`

### 2.2 调用上下文隔离

**`packages/nilm/context/tests/context.spec.ts`** — 3 个断言（3 通过）。覆盖：绑定上下文只读；绑定前与撤销后查找失败；替换绑定时旧 disposer 不能撤销新绑定。

- `binds and requires an immutable caller context`
- `rejects lookups before binding and after revoke`
- `does not let a stale disposer revoke a replacement binding`

### 2.3 数据源配置、DDL 与 SQL 守卫

**`packages/nilm/source/tests/config.spec.ts`** — 4 个断言（4 通过）。覆盖：从环境变量加载端点；缺必填项与非法端口（`INVALID_SOURCE_CONFIG`）拒绝；可选 TDengine 凭据仅在成对提供时保留。

- `loads every endpoint from the environment`
- `rejects a missing required endpoint`
- `rejects an invalid port`
- `keeps optional TDengine credentials when both are supplied`

**`packages/nilm/source/tests/ddl.spec.ts`** — 3 个断言（3 通过）。覆盖：解析初始化 SQL，验证 19 张设计表、上游租户映射唯一键与租户查询索引，以及 Sentinel 水位 `record_time` 为 `DATETIME(3)` 毫秒精度。

- `creates exactly the nineteen design tables`
- `keeps tenant-scoped lookup indexes on the conversational tables`
- `stores the sentinel watermark time with millisecond precision`

**`packages/nilm/source/tests/sql-guard.spec.ts`** — 74 个断言（74 通过）。覆盖：CTE 名仅在其作用域内（后续 CTE 体、主查询及其子查询）解析为 CTE，每个 CTE 体仍查白名单，`FROM (WITH ...)`、`INTERSECT (WITH ...)`、`WHERE ... IN (SELECT ... FROM cte)` 与 `GROUP BY ... WITH ROLLUP` 放行；CTE 体内引用自身/后续同名、大小写不同、库名限定、CTE 后接逗号连接、`WITH RECURSIVE`、CTE 体非裸 SELECT 均拒绝；`SELECT STRAIGHT_JOIN` 修饰符放行而真 `STRAIGHT_JOIN` 仍查白名单；非派生表后接列清单（`FROM t intersect (secret)`、`AS except (secret)`）拒绝；`WINDOW` 子句逗号后须为 `name AS (` 窗口定义，否则拒绝；`PROCEDURE` 子句拒绝；多窗口定义合法放行；单条参数化 SELECT、子句内逗号、`(SELECT ...)` 派生表与 `information_schema.tables` 限定名放行；写语句、多语句、注释、字面量、非白名单表、空查询拒绝；FROM 与子查询/`UNION` 分支内顶层逗号连接、`STRAIGHT_JOIN`、括号表名与 `((SELECT ...) s, t)` 括号表引用列表、`` `a`.`b` `` 限定名后段、双引号标识符、未闭合反引号与括号不配对均拒绝；MySQL 8.0.19+ `TABLE t` / `VALUES ROW(...)` 查询表达式拒绝；`LOAD_FILE`、`GET_LOCK`/`RELEASE_LOCK`、`INTO @var`、`@var` 与 `@@sysvar` 拒绝；反引号包裹的危险函数名（`` `SLEEP`( ``、`` `BENCHMARK`( ``、`` `GET_LOCK`( ``、`` `load_file`( ``）、函数名与括号间换行、`FOR SHARE`、`NOWAIT`、`SKIP LOCKED`、`INTO OUTFILE`、`SOURCE_POS_WAIT`/`MASTER_POS_WAIT`/`WAIT_FOR_EXECUTED_GTID_SET` 拒绝；关键字只检查裸词，反引号列名/别名 `` `values` ``、`` `table` `` 放行；无表探活豁免收紧为整句 `SELECT 1` / `SELECT ?`，`SELECT 1, USER(), ...` 等拒绝；以 `INTERSECT`/`EXCEPT`/`WINDOW` 作表别名后接逗号（含 `AS` 与子查询变体）拒绝，派生表别名后接列清单（`intersect (c), t`、`AS except (c), t`、`except(c),t`、`AS window (c), t`）同样拒绝；三者仅在运算符形态（后跟 `SELECT`/`ALL`/`DISTINCT`/`(SELECT`/`(WITH`/`((`，或 `WINDOW w AS (`）且前一词不是 `AS` 时结束 FROM，`INTERSECT (SELECT ...)`、`EXCEPT ((SELECT ...))` 放行。

- `accepts one parameterized SELECT over whitelisted tables`
- `rejects write statement INSERT INTO nilm_tenant_config VALUES (?)`
- `rejects write statement UPDATE nilm_tenant_config SET status = ?`
- `rejects write statement DELETE FROM nilm_tenant_config WHERE tenant_id = ?`
- `rejects write statement DROP TABLE nilm_tenant_config`
- `rejects write statement TRUNCATE nilm_tenant_config`
- `rejects write statement ALTER TABLE nilm_tenant_config ADD COLUMN x INT`
- `rejects multiple statements, comments, literals, and non-whitelisted tables`
- `allows commas inside parenthesized expressions and clause-local lists`
- `rejects empty SQL and queries without a table reference`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config STRAIGHT_JOIN secret_table`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config straight_join secret_table`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config JOIN (secret_table)`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config JOIN ((nilm_asset_snapshot, secret_table))`
- `rejects table-source bypass SELECT * FROM ((SELECT tenant_id FROM nilm_tenant_config) s, secret_table)`
- `rejects table-source bypass SELECT * FROM `nilm_tenant_config`.`secret_table``
- `rejects table-source bypass SELECT * FROM nilm_tenant_config WHERE tenant_id IN (SELECT tenant_id FROM nilm_asset_snapshot, secret_table)`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config UNION SELECT * FROM nilm_asset_snapshot, secret_table`
- `rejects table-source bypass SELECT * FROM nilm_tenant_configé`
- `rejects table-source bypass SELECT * FROM "secret_table"`
- `rejects table-source bypass SELECT * FROM nilm_tenant_config WHERE (tenant_id = ?`
- `rejects table-source bypass SELECT * FROM nilm_unsafe_record UNION TABLE secret_table`
- `rejects table-source bypass SELECT * FROM nilm_unsafe_record WHERE EXISTS (TABLE secret_table)`
- `rejects table-source bypass SELECT * FROM nilm_unsafe_record UNION VALUES ROW(?)`
- `accepts derived-table subqueries and the qualified metadata table`
- `rejects dangerous function or variable use SELECT LOAD_FILE(?) FROM nilm_unsafe_record`
- `rejects dangerous function or variable use SELECT * FROM nilm_unsafe_record WHERE GET_LOCK(?, 10)`
- `rejects dangerous function or variable use SELECT * FROM nilm_unsafe_record WHERE RELEASE_LOCK(?)`
- `rejects dangerous function or variable use SELECT record_id FROM nilm_unsafe_record INTO @x`
- `rejects dangerous function or variable use SELECT * FROM nilm_unsafe_record WHERE record_id = @@version`
- `rejects dangerous function or variable use SELECT * FROM nilm_unsafe_record WHERE record_id = @x`

**`packages/nilm/source/tests/production-sql.spec.ts`** — 27 个断言（27 通过）。覆盖：宽松匹配 `packages/nilm/*/src` 中所有 `queryLocalReadOnly` / `queryUpstreamReadOnly` 调用点（排除方法声明），首个参数须为内联字符串字面量（反引号、单引号或双引号），否则判失败，防止变量、拼接或 helper 形式被静默跳过；按运行期形态展开插值后逐条通过 `assertReadOnlySql` 与对应白名单；另有断言保证扫描到至少 25 条。

- `finds the production query templates to check`
- `passes the read-only guard: assets/src/index.ts:103`
- `passes the read-only guard: assets/src/index.ts:142`
- `passes the read-only guard: safety/src/index.ts:155`
- `passes the read-only guard: scheduler/src/data-source.ts:195`
- `passes the read-only guard: scheduler/src/data-source.ts:258`
- `passes the read-only guard: scheduler/src/store.ts:50`
- `passes the read-only guard: scheduler/src/store.ts:191`
- `passes the read-only guard: scheduler/src/store.ts:212`
- `passes the read-only guard: scheduler/src/store.ts:224`
- `passes the read-only guard: sentinel/src/source.ts:33`
- `passes the read-only guard: sentinel/src/source.ts:58`
- `passes the read-only guard: sentinel/src/store.ts:318`
- `passes the read-only guard: sentinel/src/store.ts:364`
- `passes the read-only guard: sentinel/src/store.ts:393`
- `passes the read-only guard: sentinel/src/store.ts:436`
- `passes the read-only guard: sentinel/src/store.ts:457`
- `passes the read-only guard: sentinel/src/store.ts:484`
- `passes the read-only guard: sentinel/src/store.ts:510`
- `passes the read-only guard: sentinel/src/store.ts:582`
- `passes the read-only guard: sentinel/src/store.ts:606`
- `passes the read-only guard: tariff/src/index.ts:163`
- `passes the read-only guard: tariff/src/index.ts:182`
- `passes the read-only guard: tariff/src/index.ts:201`
- `passes the read-only guard: tariff/src/index.ts:227`

### 2.4 存储驱动与源服务

**`packages/nilm/source/tests/mysql.spec.ts`** — 7 个断言（7 通过）。覆盖：懒加载连接池、取消/中止、驱动缺失与失败映射，不泄露连接细节。

- `resolves the optional driver or reports its absence`
- `creates one lazily configured pool and reuses it`
- `returns no rows when the driver result is not an array`
- `does not open a pool for an already cancelled query`
- `rejects a pending query when the caller aborts`
- `propagates a driver import or query failure for the caller to map`
- `maps an untyped driver failure without exposing connection details`

**`packages/nilm/source/tests/tdengine.spec.ts`** — 6 个断言（6 通过）。覆盖：列元数据映射、Basic Auth、HTTP/服务码/传输/超时/取消错误映射、超大响应拒绝、禁止重定向、非法 endpoint 归为 `INVALID_SOURCE_CONFIG`。

- `maps column metadata and data rows to named records`
- `lists tables and sends basic authorization when configured`
- `maps HTTP and server-code failures to SOURCE_UNAVAILABLE`
- `maps transport failures, timeouts, and caller cancellation`

**`packages/nilm/source/tests/cold-proxy.spec.ts`** — 6 个断言（6 通过）。覆盖：固定模板与绑定参数、超时映射、类型化代理失败、调用方取消、超大响应拒绝、非法 base URL 归为 `INVALID_SOURCE_CONFIG`。

- `sends the fixed template and bound parameters`
- `maps a timeout to COLD_LINK_UNAVAILABLE`
- `preserves a typed proxy failure`
- `maps caller cancellation before the fixed timeout`

**`packages/nilm/source/tests/source.spec.ts`** — 6 个断言（6 通过）。覆盖：读写前守卫、本地表清单、聚合预算与 deadline、缺表可见、关闭后拒绝。

- `guards both local and upstream reads before touching a driver`
- `lists local tables through a parameterized metadata query`
- `passes every connectivity check within the aggregate budget`
- `stops a non-cooperative check at the aggregate deadline`
- `reports every missing table and keeps a failing check visible`
- `rejects work after close`

### 2.5 生产 Bundle 与工具白名单

**`packages/bundle/nilm-app/tests/bundle.spec.ts`** — 5 个断言（5 通过）。覆盖：单棵白名单依赖树；排除 stdio/keyless provider、3 个扩展包和 shell/fs/web/MCP/terminal/sandbox/subagent 行；配置中无数据库地址或连接串。

- `declares one standalone allowlisted tree with every row dependency`
- `keeps the stdio transport and keyless provider out of production`
- `does not include the forbidden DeepSeek extension packages`
- `does not mount shell, filesystem, web, MCP, terminal, sandbox, or subagent rows`
- `does not embed database addresses or connection strings`

**`packages/bundle/nilm-app/tests/guard.spec.ts`** — 2 个断言（2 通过）。覆盖：仅 `nilm_` 命名空间工具放行；其他工具一律拒绝。

- `accepts the NILM namespace`
- `rejects any tool outside the NILM namespace`

## 3. 阶段 1：拓扑、时序、确定性计算与 BFF 问答

本阶段验证资产展开、多源时序、业务 Tool、BFF 认证/会话/SSE 与确定性计算。

### 3.1 工业资产拓扑

**`packages/nilm/assets/tests/assets.spec.ts`** — 11 个断言（11 通过）。覆盖：车间/终端/通道解析；总表与分路不重叠；重名歧义、越权范围、缺少 terminal 祖先与重复总表均拒绝；设备映射到父通道并标记估算；channel_type 回退；绑定按请求时刻生效。

- `resolves a named workshop and selects non-overlapping total meters`
- `reports duplicate names as ambiguous instead of picking one`
- `rejects a target outside the caller allowed scope`
- `falls back to channel_type when no binding is effective`
- `selects only leaf branches when a terminal has no total inlet`
- `maps an appliance to its parent channel and marks it as an estimate`
- `rejects an appliance whose channel has no terminal ancestor`
- `returns workshop channels and validates missing or ambiguous identifiers`
- `rejects a missing allowed scope instead of widening access`
- `rejects duplicate total inlets for one terminal`
- `resolves measurement bindings effective at the requested instant`

### 3.2 时序多源路由与降采样

**`packages/nilm/timeseries/tests/timeseries.spec.ts`** — 16 个断言（16 通过）。覆盖：热/统计/冷路由；覆盖率与缺口；电表翻转不产生负电量；2,000 原始点上限；LTTB 降采样；表名白名单；中文路径；设备状态；空结果与非法范围；采样上限写入结构化 `dataQuality.truncated`，完整结果不置位；跨热窗口范围拆分冷/热两段合并（`source: mixed`），冷链路不可用时只返回热段并标注 `cold_unavailable` 缺口。

- `prefers summarized realtime rows and reports coverage gaps`
- `rejects unsupported metrics and malformed ranges`
- `computes raw energy deltas and never counts a meter reset as negative energy`
- `warns when energy rows exceed the sample cap instead of reporting a complete total`
- `leaves the structured truncation flag off when every row is returned`
- `uses the statistics endpoint for day aggregates with a projected path`
- `routes ranges older than the hot window to the cold proxy`
- `escapes a projected path instead of rejecting non-ASCII names`
- `downsamples points and buckets deterministically`
- `rejects unsafe table identifiers at composition time`
- `queries appliance states by authorized terminal and keeps upstream nulls`
- `returns no appliance rows without querying when the meter set is empty`
- `queries raw analysis columns with an explicit limit and sorts samples across meters`
- `returns an empty raw analysis result with zero coverage when no rows match`
- `splits a range crossing the hot window into cold and hot segments`
- `returns the hot segment with a gap when the cold link is unavailable`

### 3.3 安全记录与系统提示词

**`packages/nilm/safety/tests/safety.spec.ts`** — 8 个断言（8 通过）。覆盖：上游字段投影并保留 null；租户过滤；限幅与空结果；非法范围；severity 过滤；不可解析时间抛类型化错误；与 Sentinel 共用分类器（overload 为 critical），按严重度再按时间倒序排序；severity 过滤在行数上限之后执行并给出告警。

- `projects upstream fields and preserves missing values as null`
- `passes tenant filters to SQL and keeps unknown severity explicit`
- `clamps limits and reports an empty result instead of fabricating rows`
- `rejects malformed ranges and unsafe filters before the repository runs`
- `filters severity after row projection`
- `throws a typed error for unparseable upstream times`
- `classifies like Sentinel and sorts by severity, then newest first`
- `warns that a severity filter ran after the row limit`

**`packages/nilm/prompt/tests/prompt.spec.ts`** — 1 个断言（1 通过）。覆盖：注册一个稳定策略段。

- `registers one stable policy section`

### 3.4 业务 Tool 闭集

**`packages/nilm/tools/tests/tools.spec.ts`** — 14 个断言（14 通过）。覆盖：6 个闭集工具；事实截断；缺失数据不补零；结构化截断标志驱动部分电量摘要；图表与澄清候选放入 presentation；PQ 加权与谐波图不下送模型；秒级窗口不超过 4 小时；设备/残差；安全 SQL 限定授权终端与通道；绑定按查询范围最后时刻生效。

- `registers six closed-schema tools`
- `caps scope facts and reports truncation`
- `never turns missing energy into zero`
- `exposes clarification candidates in presentation metadata for ambiguous scopes`
- `keeps chart data out of model content and in presentation metadata`
- `calculates energy-weighted power quality and keeps harmonic charts out of model content`
- `does not invent power-quality values when no sample is available`
- `analyzes a short second-level window and emits bounded chart annotations`
- `hides hazards in disaggregation-only mode and rejects windows longer than four hours`
- `summarizes appliances and residual against terminal energy`
- `restricts safety SQL to the resolved terminals and channels`
- `caps safety facts and reports the truncation`
- `resolves bindings effective at the last instant of the query range`
- `labels a capped energy result as partial from the structured quality flag`

### 3.5 BFF 认证、会话与 SSE

**`packages/nilm/service/tests/auth.spec.ts`** — 9 个断言（9 通过）。覆盖：合法信封与 scope 解码；体篡改、时间窗、nonce、未知租户、错误密钥、非法 scope JSON 与超长标识符拒绝。

- `accepts a valid envelope and absent allowed scope`
- `decodes a valid allowed scope`
- `rejects a body modified after signing`
- `rejects a timestamp outside the accepted window`
- `rejects a replayed nonce`
- `rejects an unknown tenant without revealing whether the tenant exists`
- `rejects a signature produced with another secret`
- `rejects malformed allowed scope JSON`
- `rejects caller identifiers that exceed audit column widths`

**`packages/nilm/service/tests/http.spec.ts`** — 26 个断言（26 通过）。覆盖：健康/就绪；query string 拒绝；turn 与 SSE/Last-Event-ID；跨租户；clientMessageId 幂等与并发；每用户限流 429 与 `Retry-After`；租户并发槽释放；Turn 淘汰后的幂等 receipt；失败发送不遗留 receipt；会话缓存上限不隐藏持久记录；空闲 Session 释放与维护清扫；失败释放；告警列表/ack；分片错误先于限流；重启后会话列表/历史；同步 send 失败收尾。

- `serves health and readiness without caller envelopes`
- `rejects query strings before routing or verification`
- `runs one turn and replays buffered SSE events including Last-Event-ID`
- `rejects cross-tenant turn streams and conversation reads without revealing existence`
- `returns the same turn for a repeated clientMessageId and cancels the active turn`
- `reserves a clientMessageId before awaits so concurrent retries cannot start twice`
- `releases a clientMessageId reservation when turn creation fails`
- `finalizes a turn and releases its conversation when send fails synchronously`
- `does not retain an idempotency receipt for a failed send after eviction`
- `keeps the explicit unavailable skeleton when no Sentinel is mounted`
- `projects caller-visible alerts from the mounted Sentinel`
- `acknowledges an alert and audits the outcome`
- `does not reveal an alert owned by another caller`
- `returns DATA_UNAVAILABLE when acknowledgement is requested without a mount`
- `serves a tenant only on the shard selected by MurmurHash3`
- `rejects a wrong shard before consuming the user rate window`
- `keeps the health and readiness probes shard-addressable without a caller envelope`
- `lists and continues a conversation created before the previous Pod stopped`
- `reads persisted history after a restart instead of returning an empty transcript`
- `returns 429 with Retry-After when one user exceeds the request window`
- `limits concurrent turns per tenant and releases the slot on turn end`
- `evicts an old replay buffer but keeps its idempotency receipt`
- `bounds the conversation cache without hiding persisted conversations or breaking continuation`
- `releases an idle live session after the configured TTL`
- `sweeps an idle live session on maintenance before its per-conversation timer fires`
- `enforces the 64-character clientMessageId bound`

### 3.6 分时电价与确定性计算

**`packages/nilm/tariff/tests/tariff.spec.ts`** — 16 个断言（16 通过）。覆盖：HH:mm 解析；费率计划/日历投影；切片覆盖与边界；缺失日期；租户过滤。

- `parses HH:mm and rejects malformed clock values`
- `rejects overlapping, wrapping, empty, and negative-price plans`
- `ranks bands from sharp to valley`
- `selects the sole plan inside its effective interval`
- `rejects an absent or overlapping effective plan`
- `splits a full day into ordered priced slices without gaps`
- `clips slices to the requested range and preserves exact boundaries`
- `reports every uncovered interval exactly once`
- `marks days absent from the projection as missing rather than unpriced periods`
- `clips the range to the plan effective interval and reports the rest`
- `warns when no calendar days are supplied and rejects unordered days`
- `merges adjacent slices only when band, price, and plan all match`
- `warns when a day lacks a period set for its season and day type`
- `loads the effective plan and calendar days from the repository`
- `uses an explicit plan id and rejects a missing plan or foreign time zone`
- `filters tariff periods by tenant as well as plan id`

**`packages/nilm/analytics/tests/analytics.spec.ts`** — 21 个断言（21 通过）。覆盖：分时电费切片与未定价区间；工况状态机；环比/同比；运行积分；设备分组；PQ/CUSUM 委托。

- `prices a bucket that exactly spans two slices and fills per-band totals`
- `prorates a bucket uniformly across a slice boundary`
- `keeps energy outside every slice unpriced and marks the result imprecise`
- `marks an empty slice set as imprecise`
- `rejects malformed buckets and overlapping or invalid slices`
- `uses the last pre-window transition as the initial state`
- `stays unknown until the first in-window transition when no prior state exists`
- `absorbs a short state flip into the preceding state`
- `absorbs a short first segment into the next state`
- `keeps unknown gaps even when they are short`
- `merges adjacent equal states and ignores transitions outside the window`
- `rejects malformed windows, dwell, and contradictory states`
- `returns signed deltas and percentages for comparable, precise periods`
- `omits ratios for a zero baseline and omits cost when either side lacks it`
- `marks low coverage imprecise and a wide coverage gap incomparable`
- `rejects malformed metrics`
- `accepts integral buckets without extra fields`
- `integrates only credited running intervals and leaves long gaps unknown`
- `keeps terminals and appliance numbers as separate groups`
- `warns for a lone sample and rejects malformed input`
- `delegates power-quality and CUSUM operations to the pure functions`

## 4. 阶段 2：电能质量与 CUSUM 微观隐患

本阶段验证电能质量算法与秒级边沿/隐患检测。

### 4.1 电能质量

**`packages/nilm/analytics/tests/power-quality.spec.ts`** — 15 个断言（15 通过）。覆盖：能量加权 PF；零有功返回 undefined；三相不平衡；谐波阶次；电压偏差；阈值、缺口与非法参数。

- `derives the billing power factor from active and reactive energy`
- `returns undefined when active energy is not positive`
- `rejects non-finite energy`
- `uses the maximum deviation from the three-phase mean`
- `returns undefined when a phase is missing or all phases are zero`
- `rejects negative phase current`
- `integrates adjacent samples into active and reactive energy`
- `applies the configured threshold and treats the warning band as inclusive`
- `returns only the harmonic orders upstream supplied and never claims complete THD`
- `leaves gaps longer than the integration limit uncovered`
- `reports the worst voltage deviation only when a nominal voltage is configured`
- `reports the worst three-phase unbalance from supplied phase currents`
- `returns an unknown risk and no power factor when active energy is not positive`
- `skips intervals outside the window and intervals missing active or reactive power`
- `rejects an invalid threshold, nominal voltage, gap, or window`

### 4.2 CUSUM 边沿检测与四类隐患

**`packages/nilm/analytics/tests/cusum.spec.ts`** — 18 个断言（18 通过）。覆盖：白噪声边沿检测（召回率 ≥98%）；4 小时秒级 p95 <2.5s 与事实 <4KB；周期配对；频繁启停、重载启动、不平衡、谐波+PF 四类隐患；稀疏、截断与非法参数。

- `recovers motor, heater, and fan steps from industrial white noise with bounded output`
- `collapses repeated detections during one transition into one event`
- `processes four hours of second-level samples within the analysis budget`
- `pairs a symmetric up and down step into one cycle`
- `flags more than five starts in ten minutes as frequent cycling`
- `flags an inrush that stays above steady current for more than eight seconds`
- `flags phase unbalance above fifteen percent after a step`
- `flags a harmonic jump together with a power-factor swing`
- `returns an empty bounded result for no samples`
- `warns when sparse samples cover less than ninety-five percent of the window`
- `caps returned edges and reports the truncation`
- `ignores a step below the configured minimum delta`
- `handles power-only samples and a missing power sample without inventing current`
- `supports an odd steady-state window`
- `returns no inrush settling time when current never reaches the steady band inside the limit`
- `skips an up step while looking for a down partner and deduplicates identical hazards`
- `rejects malformed windows and tunables`
- `keeps cycle pairing tolerant of a request for no tolerance`

## 5. 阶段 3：Sentinel 巡检与 Outbox 通知

本阶段验证告警模型/规则/抑制/扫描，以及 Outbox 投递、渠道与异步研判。

### 5.1 Sentinel 告警模型、规则与抑制

**`packages/nilm/sentinel/tests/model.spec.ts`** — 8 个断言（8 通过）。覆盖：稳定跨窗键与 bucket 去重键；bucket 对齐；超长键拒绝；升级键命名空间；合法/升级复活路径；终态禁止复活；最严重值保留。

- `builds a stable cross-window key and a bucketed de-duplication key`
- `aligns a bucket down to its start`
- `rejects a key beyond the indexed storage width`
- `namespaces escalation keys`
- `allows the designed path`
- `allows suppression to be revived by escalation`
- `rejects resurrection of a final state`
- `keeps the most urgent value`

**`packages/nilm/sentinel/tests/scanner.spec.ts`** — 23 个断言（23 通过）。覆盖：仅确定性错误（`INVALID_ARGUMENT`/`TypeError` 等）计入死信，本地库持续不可用时不跳行、水位不越过；水位线 bootstrap 的无效 head 防护；事件与 Outbox 单次写入；按接收人入队；bucket 去重；静默抑制；安全告警绕过静默；未知类型不猜测；必填来源租户映射与映射缺失不推进水位；双租户同 node 的映射交付；毒时间戳隔离与偏移推进；重启后从持久化偏移续扫毒记录前缀；全无效批次不推进水位且不永久阻塞；单行处理持续抛错时保留已处理前缀水位、重试 3 次后死信跳过，瞬时失败重试不丢行；保存前缀水位失败时仍抛出原始处理错误；非零分片不扫描；分片配置校验；告警列表/ack。

- `bootstraps the watermark at the current head without replaying history`
- `writes the alert event and Outbox in one store call and emits the enrich payload`
- `enqueues one alert row per recipient on the same channel`
- `keeps every bucket row but collapses a duplicate de-duplication key`
- `suppresses a repeated warning inside the silence window while retaining the bucket event`
- `delivers a safety alert that bypasses the silence window`
- `ignores an unconfirmed upstream type instead of guessing a rule`
- `lists only alerts visible to the receiving user and acknowledges them once`
- `requires a configured source tenant`
- `delivers a dual-owned node only to the tenant mapped from the upstream source tenant`
- `refuses upstream rows when the configured source tenant has no mapping`
- `does not bootstrap a NaN watermark from a poisoned head row`
- `skips a poison timestamp and still processes later rows`
- `keeps an all-invalid batch from corrupting the watermark`
- `dead-letters an all-invalid batch so later valid rows still process`
- `advances past more than the former dead-letter bound`
- `does not scan upstream on a non-zero shard`
- `rejects a shard index outside the configured shard count`

**`packages/nilm/sentinel/tests/store.spec.ts`** — 6 个断言（6 通过）。覆盖：按 MySQL 左到右赋值语义执行真实 `ON DUPLICATE KEY UPDATE` 语句：更早的 `(record_time, record_id)` 不能覆盖水位；同一水位下 `scan_offset` 只增不减；水位前进时采用新偏移，旧进程不能把较大偏移写回当前水位之后；`record_id` 按 `utf8mb4_bin` 字节序比较；写入偏移钳制到 INT UNSIGNED 范围；读回偏移并把非法值归零。

- `rejects watermark writes that would move backwards`
- `only grows the scan offset while the watermark stays put`
- `takes the new offset when the watermark advances and ignores stale offsets`
- `compares record ids in byte order, matching the utf8mb4_bin column`
- `clamps the written scan offset to the INT UNSIGNED column range`
- `loads the persisted scan offset and clamps invalid values to zero`

**`packages/nilm/sentinel/tests/rules.spec.ts`** — 13 个断言（13 通过）。覆盖：规则载荷解析；缺失/负阈值拒绝；持续窗口、孤立尖峰、额定比例与最差相位偏差。

- `parses each supported rule payload`
- `fails loud on a missing or negative threshold`
- `fires when consecutive samples exceed baseline plus step and the increment is material`
- `does not fire on an isolated spike or a small increment`
- `fires only after the sustained window`
- `fires for a running appliance below idle power for the configured window`
- `ignores a stopped appliance and a short interval`
- `is critical above the rated ratio`
- `computes the worst deviation from the mean`
- `requires the sustained window and finite non-negative values`
- `fires on the worst phase deviation`
- `promotes to critical at the configured percentage`
- `accepts a complete violated window and rejects gaps or partial coverage`

**`packages/nilm/sentinel/tests/suppression.spec.ts`** — 6 个断言（6 通过）。覆盖：首次通知；静默窗后再次通知；连续上升窗升级；幅度缩小不升级；连续 bucket；安全告警不静默。

- `notifies the first finding and suppresses repeats inside the window`
- `delivers again after the silence window`
- `promotes a warning after three consecutive rising windows and bypasses silence`
- `does not escalate when the magnitude shrinks`
- `requires continuous buckets`
- `never silences a safety finding flagged by the rule engine`

### 5.2 Notify Outbox、渠道与异步研判

**`packages/nilm/notify/tests/store.spec.ts`** — 4 个断言（4 通过）。覆盖：报告投递 claim/送达；租约丢失不更新；诊断只应用一次并清理记录。

- `claims report deliveries and maps their report identifier`
- `marks a report delivered after the provider succeeds`
- `does not update a report for alert-only delivery or a lost lease`
- `applies a diagnosis once and purges notification records`

**`packages/nilm/notify/tests/dispatcher.spec.ts`** — 8 个断言（8 通过）。覆盖：发送并推进事件；瞬态失败延迟重试；永久失败 dead；并发 worker 单行只 claim 一次；过期租约回收；无 transport dead；错误分类。

- `marks a delivered alert sent, records it, and advances the event`
- `schedules a transient failure at the table delay`
- `dead-letters a permanent failure immediately`
- `claims each row once across concurrent workers`
- `reclaims a row whose lease expired`
- `dead-letters a channel with no configured transport`
- `keeps typed gateway failures`
- `treats timeouts and unknown failures as transient`

**`packages/nilm/notify/tests/channels.spec.ts`** — 10 个断言（10 通过）。覆盖：模板参数确定；只传加密收件材料；429/500/503 可重试，400/403 不可重试；损坏 payload 不调用网关；无 endpoint 时的 transport 构建；超大响应忽略；禁止重定向；配置与直接构造均拒绝带凭证或非 HTTP(S) endpoint。

- `posts deterministic template parameters and only encrypted recipient material`
- `classifies HTTP 429 as retryable=true`
- `classifies HTTP 500 as retryable=true`
- `classifies HTTP 503 as retryable=true`
- `classifies HTTP 400 as retryable=false`
- `classifies HTTP 403 as retryable=false`
- `rejects a corrupt stored payload without calling the gateway`
- `builds unconfigured transports for channels without an endpoint`

**`packages/nilm/notify/tests/retry.spec.ts`** — 3 个断言（3 通过）。覆盖：固定指数退避表；非法 attempt 拒绝；永久失败或达到上限 dead。

- `uses the fixed exponential backoff table`
- `rejects an invalid attempt number`
- `dead-letters on a permanent failure or at the attempt ceiling`

**`packages/nilm/notify/tests/enrich.spec.ts`** — 5 个断言（5 通过）。覆盖：8 秒硬超时内应用诊断；晚到结果丢弃；已 ack 不覆盖；失败不抛出；队列去重并排空。

- `applies a diagnosis inside the hard timeout`
- `times out and drops a late model result`
- `does not overwrite an acknowledged alert`
- `reports a failed agent without throwing`
- `de-duplicates queued alerts and drains the queue`

## 6. 阶段 4：调度、分片、压测与安全审计

本阶段验证定时任务/晨报、租户分片/PVC、压测 Harness 与版本化安全套件。

### 6.1 定时任务、晨报与数据质量

**`packages/nilm/scheduler/tests/time.spec.ts`** — 4 个断言（4 通过）。覆盖：上海业务日边界；月边界；到期时间与月度预测日；非法日期拒绝。

- `formats and bounds the Shanghai business day`
- `resolves month boundaries in business time`
- `recognizes due times and monthly forecast days`
- `rejects impossible calendar dates`

**`packages/nilm/scheduler/tests/store.spec.ts`** — 9 个断言（9 通过）。覆盖：租户/告警严重度、PF 阈值、任务 claim 状态、无持久行拒绝、完成/失败错误码、报告身份、Outbox 审计截断、最新报告解码；完成/失败带 attempt 栅栏，租约被回收的过期 attempt 被报告。

- `lists tenants and maps alert severities`
- `rejects absent or out-of-range power-factor thresholds`
- `claims a new job and reports completed, in-progress, and retry states`
- `rejects a claim that inserted no durable job row`
- `completes and fails running jobs with bounded error codes and an attempt fence`
- `returns inserted and duplicate report identities`
- `enqueues outbox rows and truncates operational audit text`
- `reads the latest report and decodes stored JSON`
- `reports a stale attempt whose lease was reclaimed`

**`packages/nilm/scheduler/tests/scheduler.spec.ts`** — 14 个断言（14 通过）。覆盖：配置加载校验；幂等晨报与逐接收人 Outbox；R-08/R-07 合并扫描；时间窗/预测日；失败不臆造策略；模型失败/空白/超时回退确定性摘要；无接收人成功；失败延迟重试；单租户 claim 抛错或 `failJob` 抛错均不中断后续租户；过期 attempt 不覆盖已被重新 claim 的任务。

- `rejects unknown report channels and templates at configuration load`
- `generates and delivers an idempotent morning report`
- `delivers one outbox row per recipient on the same channel`
- `runs R-08 and R-07 in one sweep without customer delivery for quality findings`
- `does not run the morning report before its configured time`
- `runs the monthly projection on the configured forecast day`
- `fails the projection instead of inventing a policy or monthly energy`
- `keeps the deterministic summary when model authorship fails`
- `keeps the deterministic summary for blank or timed-out model text`
- `reports success without delivery when no recipient is configured`
- `retries a failed job only after the configured delay`
- `continues other tenants when one tenant claim throws`
- `does not let a stale attempt overwrite a reclaimed job`
- `continues other tenants when recording a failed job throws`

**`packages/nilm/scheduler/tests/report.spec.ts`** — 3 个断言（3 通过）。覆盖：确定性晨报载荷/图表/份额；无电价计划时份额为 null；强制月度预测报告。

- `builds deterministic morning payload, chart, and shares`
- `keeps period shares null when no tariff plan is available`
- `builds a mandatory monthly forecast report`

**`packages/nilm/scheduler/tests/data-source.spec.ts`** — 6 个断言（6 通过）。覆盖：工厂/车间能耗与电费；租户缺口告警但致命错误上抛；月度预聚合；终端父子能耗校验；可恢复终端缺口上抛；只汇总叶子分路，嵌套分路不双算。

- `collects factory energy, tariff costs, and workshop energy`
- `keeps recoverable tenant gaps as warnings but rethrows fatal failures`
- `collects configured monthly energy and reports an empty preaggregation`
- `checks parent and child energy per terminal and skips incomplete bindings`
- `keeps a recoverable terminal query gap and rethrows fatal quality failures`
- `sums only leaf branches so nested branch levels are not double counted`

**`packages/nilm/scheduler/tests/morning-report.spec.ts`** — 1 个断言（1 通过）。覆盖：20 租户在延迟预算内重算且幂等。

- `recomputes twenty tenants within the latency budget and remains idempotent`

**`packages/nilm/scheduler/tests/pf.spec.ts`** — 6 个断言（6 通过）。覆盖：实际值 + 同星期中位数；不利投影阈值风险；观察带内分类；缺失星期回退近期全天中位数；无电量不臆造；重复/负数/非法阈值拒绝。

- `projects from actual energy and same-weekday medians`
- `classifies an adverse projection as a threshold risk`
- `classifies a projection inside the watch band`
- `falls back to the recent all-day median for missing weekdays`
- `does not invent a factor when no energy exists`
- `rejects duplicate, negative, and invalid-threshold inputs`

**`packages/nilm/scheduler/tests/quality.spec.ts`** — 4 个断言（4 通过）。覆盖：覆盖率、父子偏差与冷热不一致违规；阈值内静默；零总量视为零偏差；非法比例/观测拒绝。

- `reports coverage, parent-child, and hot-cold violations`
- `stays silent when observations are within the configured thresholds`
- `treats zero totals as zero deviation`
- `rejects malformed ratios and observations`

### 6.2 租户分片、PVC 会话与恢复

**`packages/nilm/sharding/tests/sharding.spec.ts`** — 15 个断言（15 通过）。覆盖：MurmurHash3 x86-32 向量/无符号/UTF-8/尾字节区分；种子与租户校验；单分片默认；显式成员与越界拒绝；全分片覆盖；StatefulSet ordinal 命名。

- `matches the reference x86-32 vectors`
- `returns an unsigned 32-bit result for every seed`
- `distinguishes tenant ids that differ only in trailing bytes`
- `hashes UTF-8 bytes rather than UTF-16 code units`
- `rejects seeds outside the unsigned range`
- `is stable for one tenant and one shard count`
- `always returns an index inside the configured shard count`
- `uses every shard for a multi-tenant set`
- `maps every tenant to shard zero when one shard is configured`
- `rejects blank tenants and non-positive counts`
- `defaults to the single-shard deployment`
- `keeps an explicit membership`
- `rejects an index outside the count`
- `follows the StatefulSet ordinal naming contract`
- `rejects a blank prefix or negative ordinal`

**`packages/nilm/service/tests/conversations.spec.ts`** — 13 个断言（13 通过）。覆盖：安全 ID/转义/超长摘要；租户根目录；默认单分片与显式成员；不可能成员配置失败；租户/调用方过滤与按 ID 替换；跨实例隔离；原子覆盖无临时文件；缺失目录空结果；损坏记录与非法 ID 拒绝。

- `keeps safe ids readable and escapes everything else`
- `never returns a traversal component or an empty segment`
- `bounds overlong ids with an escaped digest`
- `places every tenant under the configured root`
- `defaults to one shard and process-local conversation metadata`
- `resolves an absolute sessions root and an explicit shard membership`
- `fails loud when the shard membership is impossible`
- `filters by tenant and caller and replaces records by id`
- `survives a store instance replacement and isolates tenants`
- `overwrites one record atomically and leaves no temporary file`
- `returns no records for an absent tenant directory`
- `refuses a corrupt record instead of silently dropping it`
- `refuses malformed ids before touching the filesystem`

**`packages/nilm/service/tests/recovery.spec.ts`** — 2 个断言（1 通过；1 个用例在缺少原生 flock 时跳过）。覆盖：PVC 目录存储与撕裂尾部读取；第二写者拒绝/截断续写（缺少原生 flock 时跳过）。

- `stores a tenant Session under its PVC directory and ignores a torn tail on read`
- `refuses a second writer, then truncates the fragment and continues`

### 6.3 百家工厂压测 Harness

**`packages/nilm/service/tests/perf-load.spec.ts`** — 15 个断言（15 通过）。覆盖：最近秩百分位；manifest 预检；SSE 分块/注释/keepalive；真实 verifier 签名；场景调度；TTFB；隔离探测；门禁判定；loopback 自检标记。

- `uses nearest-rank percentiles for every sample count`
- `keeps the input array and ignores non-finite samples`
- `summarizes a long soak without spreading the sample array`
- `rejects a percentile outside the allowed range`
- `accepts the G4-3 coverage and declared tenant ids`
- `refuses a short or malformed declaration`
- `passes every gate at the G4-3 shape and thresholds`
- `fails a gate when the sample or threshold is not met`
- `reports insufficient samples and a short window instead of passing`
- `requires two isolation probes for every declared tenant`
- `handles frames split across chunks, comments, and keepalives`
- `flushes a trailing frame without a blank line`
- `produces an envelope the real verifier accepts`
- `schedules sessions, classifies observed tool use, and probes every tenant`
- `drives signed turns through the real BFF and blocks cross-tenant reads`

### 6.4 版本化安全对抗与审计

**`packages/nilm/service/tests/security-pentest.spec.ts`** — 34 个断言（34 通过）。覆盖：32 个版本化攻击用例 + 2 个辅助断言（授权工具调用、完整性校验）。

| ID | 攻击面 |
| :--- | :--- |
| `BFF-01` | 缺少调用方信封头 |
| `BFF-02` | 空白租户头 |
| `BFF-03` | 签名后替换租户头 |
| `BFF-04` | 使用其他租户密钥生成签名 |
| `BFF-05` | 过期时间戳 |
| `BFF-06` | 重放 nonce |
| `BFF-07` | 重复的调用方自定义头 |
| `BFF-08` | 签名校验后提交非法 allowed_scope 载荷 |
| `BFF-09` | query string 走私 |
| `BFF-10` | 租户 B 读取租户 A 会话 |
| `BFF-11` | 租户 B 订阅租户 A 轮次流 |
| `BFF-12` | 租户 B 在租户 A 会话上开启轮次 |
| `BFF-13` | 租户 B 列出租户 A 会话 |
| `BFF-14` | 请求体伪造 tenant_id |
| `BFF-15` | 请求到达错误分片 |
| `BFF-16` | 探测未知认证路由 |
| `BFF-17` | 模型请求跨租户 Tool 结果 |
| `SQL-01` | 通过只读适配器执行 INSERT |
| `SQL-02` | 堆叠 SELECT 与 DROP |
| `SQL-03` | SQL 注释终止符 |
| `SQL-04` | 引号字面量注入 |
| `SQL-05` | 非白名单表 |
| `SQL-06` | 锁定读 |
| `SQL-07` | 基于时间的函数探测 |
| `SQL-08` | 通过只读适配器执行 UPDATE |
| `TOOL-01` | Tool 参数注入 tenant_id |
| `TOOL-02` | Tool 参数注入 target_tenant_id |
| `TOOL-03` | Tool 参数注入未知 authority 字段 |
| `TOOL-04` | 缺少已绑定 CallContext 的 Tool 调用 |
| `TOOL-05` | Tool 范围超出 allowed_scope |
| `CTX-01` | 篡改已绑定调用上下文 |
| `CTX-02` | 复用 Agent 绑定到其他租户 |

辅助断言：

- `keeps authorized tool calls bound to the signed tenant`
- `executes every case declared by suite 4.4.1`

**`packages/nilm/service/tests/audit.spec.ts`** — 5 个断言（5 通过）。覆盖：参数化多行插入；不复制请求内容并按序 flush；有界队列丢最新；失败后继续与关闭拒绝；默认队列配置。

- `writes one parameterized multi-row insert inside one transaction`
- `maps events without copying request content and flushes them in order`
- `drops the newest event when the bounded queue is full`
- `reports a failed batch, keeps draining, and rejects records after close`
- `uses the configured queue defaults`

## 7. 接口与运行契约基线

以下事实以当前代码和测试为准：

| 项目 | 当前事实 | 证据 |
| :--- | :--- | :--- |
| 创建轮次 | `POST /v1/turns`，`conversationId` 在请求体中；不存在 `POST /v1/conversations/:id/turns` | `packages/nilm/service/src/http.ts#createTurn` |
| SSE 类型 | 类型联合 10 个：`status`、`text.delta`、`text.done`、`tool.start`、`tool.result`、`chart`、`alert`、`clarify`、`error`、`done`；当前实际下发 9 个，`alert` 未使用 | `packages/nilm/service/src/events.ts#TurnEventBuffer`、`packages/nilm/service/src/http.ts#streamTurn` |
| 图表与澄清 | 分别使用 `chart`、`clarify` 事件，不使用单独的 `presentation` 事件 | `packages/nilm/service/tests/http.spec.ts:145-153` |
| 删除会话 | BFF 没有 `DELETE /v1/conversations/:id` 路由 | `packages/nilm/service/src/http.ts#handle` 的会话路由分支 |
| TTFB | 只在压测 Harness 中测量，不在 `http.spec.ts` 中断言 | `packages/nilm/service/tests/perf-load.spec.ts` |
| 上下文重绑定 | `bind()` 替换已有绑定；没有 `TENANT_CONTEXT_ALREADY_BOUND` 错误码 | `packages/nilm/context/src/index.ts:45-75`、`packages/nilm/context/tests/context.spec.ts:53` |
| 配置错误码 | 非法端口抛 `INVALID_SOURCE_CONFIG`，不是 `CONFIGURATION_ERROR` | `packages/nilm/source/src/config.ts:118` |
| 黄金问答快照 | `snapshots/session/nilm-golden-qa-p1/` 当前不存在，G1-4 仍需录制 | `docs/nilm-ai-agent-development-plan.md:152` |

## 8. 证据门矩阵（G0-1 ~ G4-4，共 21 项）

| 证据门 | 要求 | 离线证据 | 状态 | 命令 |
| :--- | :--- | :--- | :--- | :--- |
| **G0-1** | 真实 MySQL/TDengine 连接与超表可读 | `source/tests` 133 断言（mock） | 离线 mock 通过；真实网络握手待验 | `pnpm exec vitest run packages/nilm/source/tests` |
| **G0-2** | 只读账号 + SELECT 白名单，写操作 0 成功 | `sql-guard.spec.ts` 74 + `production-sql.spec.ts` 27 = 101 断言 | 离线拦截通过；上游只读账号待验 | `pnpm exec vitest run packages/nilm/source/tests/sql-guard.spec.ts packages/nilm/source/tests/production-sql.spec.ts` |
| **G0-3** | 生产 Profile 无危险工具，移除 3 个扩展包 | `bundle.spec.ts` 5 + `guard.spec.ts` 2 | 离线通过 | `pnpm exec vitest run packages/bundle/nilm-app/tests` |
| **G0-4** | 假模型进程启动、最小 SDK 调用、SIGTERM 干净退出 | 无自动化用例；`bundle.spec.ts` 不启动进程 | **现场待验** | 按 `pnpm dsh --profile nilm` 执行并留存日志（见开发计划 G0-4） |
| **G1-1** | 电量/电费/工况纯函数覆盖 | `analytics.spec.ts` 21 + `tariff.spec.ts` 16 = 37 | 离线通过 | `pnpm exec vitest run packages/nilm/analytics/tests/analytics.spec.ts packages/nilm/tariff/tests/tariff.spec.ts` |
| **G1-2** | 真实资产树展开无双算/漏算 | `assets.spec.ts` 11 | 离线通过 | `pnpm exec vitest run packages/nilm/assets/tests` |
| **G1-3** | 双租户越权与签名篡改 100% 拦截 | `auth.spec.ts` 9 + `http.spec.ts` 26（含跨租户） | BFF 离线通过；真实数据库零跨租户 SQL 待验 | `pnpm exec vitest run packages/nilm/service/tests/auth.spec.ts packages/nilm/service/tests/http.spec.ts` |
| **G1-4** | 黄金问答集 Session 回放无事实/数值幻觉 | 快照目录未录制，0 断言 | **现场待验** | `pnpm test:snapshot -t nilm-golden-qa-p1`（先录制快照） |
| **G2-1** | CUSUM 边沿检测召回率 ≥98% | `cusum.spec.ts` 18（合成工业白噪声） | 离线通过；真实基准波形集待验 | `pnpm exec vitest run packages/nilm/analytics/tests/cusum.spec.ts` |
| **G2-2** | 4 小时秒级分析 p95 <2.5s，事实 <4KB | `cusum.spec.ts` 性能用例 | 离线通过 | `pnpm test:perf:timeseries` |
| **G2-3** | 四类微观隐患识别 | `cusum.spec.ts` 4 个隐患用例 | 算法离线通过；现场准确率待验 | `pnpm exec vitest run packages/nilm/analytics/tests/cusum.spec.ts -t "diagnoseMicroHazards"` |
| **G2-4** | ChartSpec v1 波形/标注契约 | `tools.spec.ts` 图表标注用例 | 离线通过 | `pnpm exec vitest run packages/nilm/tools/tests/tools.spec.ts -t "chart annotations"` |
| **G3-1** | 30 秒安全告警全链路 SLO（5 秒扫描 + R-01~R-05） | `scanner.spec.ts` 23 + `rules.spec.ts` 13 = 36 | 规则离线通过；端到端 SLO 待验 | `pnpm exec vitest run packages/nilm/sentinel/tests/scanner.spec.ts packages/nilm/sentinel/tests/rules.spec.ts` |
| **G3-2** | 去重抑制与多周期升级 | `model.spec.ts` 8 + `suppression.spec.ts` 6 = 14 | 离线通过 | `pnpm exec vitest run packages/nilm/sentinel/tests/model.spec.ts packages/nilm/sentinel/tests/suppression.spec.ts` |
| **G3-3** | Outbox SKIP LOCKED 并发防重 | `store.spec.ts` 4 + `dispatcher.spec.ts` 8 = 12 | 内存模型通过；真实 MySQL 多进程待验 | `pnpm exec vitest run packages/nilm/notify/tests/store.spec.ts packages/nilm/notify/tests/dispatcher.spec.ts` |
| **G3-4** | 四渠道格式化与指数退避 | `channels.spec.ts` 10 + `retry.spec.ts` 3 = 13 | 离线通过 | `pnpm exec vitest run packages/nilm/notify/tests/channels.spec.ts packages/nilm/notify/tests/retry.spec.ts` |
| **G3-5** | 8 秒异步研判降级不影响告警触达 | `enrich.spec.ts` 5 | 8s 降级离线通过；30 秒 SLO 待验 | `pnpm exec vitest run packages/nilm/notify/tests/enrich.spec.ts` |
| **G4-1** | 20 租户晨报 p95 <500ms，送达率 >99% | `morning-report.spec.ts` 1（20 租户） | 重算/幂等离线通过；送达率待验 | `pnpm test:scheduler:morning-report` |
| **G4-2** | StatefulSet 同分片恢复，撕裂尾部截断 | `sharding` 15 + `conversations` 13 + `recovery` 2（1 skip） | 离线 29 通过/1 skip；K8s SIGKILL/PVC 待验 | `pnpm exec vitest run packages/nilm/sharding/tests packages/nilm/service/tests/conversations.spec.ts packages/nilm/service/tests/recovery.spec.ts` |
| **G4-3** | 100 租户 × 5 会话 × 30 分钟压测 | `perf-load.spec.ts` 15 | Harness 通过；真实压测待验 | `pnpm test:perf:load --target <url> --manifest <file>` |
| **G4-4** | 32 个攻击用例 100% 拦截并写审计，日志无明文 | `security-pentest` 34 + `audit` 5 + `redact` 5 = 44 | 离线单元通过；真实日志/KMS/留存待验 | `pnpm test:security:pentest`，再跑 `pnpm exec vitest run packages/nilm/service/tests/audit.spec.ts packages/nilm/core/tests/redact.spec.ts` |

## 9. 执行命令与复现方式

以下命令使用仓库标准入口。若本机 `pnpm` 不可用，可用等价的 Vitest 直跑命令，但断言集合必须保持不变；不得用 `/tmp` 下的临时配置替代仓库配置。

```bash
# 全部 NILM 测试（recovery 在无原生 flock 时自动跳过写互斥用例）
pnpm exec vitest run packages/nilm

# 版本化安全套件（G4-4）
pnpm test:security:pentest

# 20 租户晨报演练（G4-1）
pnpm test:scheduler:morning-report

# 4 小时秒级分析性能（G2-2）
pnpm test:perf:timeseries

# 百家工厂压测 Harness（G4-3；需要真实 URL 与 manifest）
pnpm test:perf:load --target <url> --manifest <file>

# 黄金问答集回放（G1-4；快照当前不存在，需先录制）
pnpm test:snapshot -t nilm-golden-qa-p1

# 文档门禁
node --experimental-transform-types scripts/verify-md-links.ts
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
```

## 10. 维护规则

- 新增或改名 `it()` 后，重新生成第 2 至 6 节的标题清单与计数；不要手工改写标题。
- 证据门状态只允许三档：`离线通过`、`离线部分通过`、`现场待验`；离线用例不能写成现场门通过。
- 现场证据必须给出环境、命令、时间窗、租户清单与原始日志位置；失败或跳过必须保留。
- 接口契约变化时同步第 6 节；`SESSION_STATE.md` 只记录断点，不复制测试清单。
