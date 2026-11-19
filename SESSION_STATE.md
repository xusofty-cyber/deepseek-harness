# Session: 2026-11-19

**Started:** 2026-11-19 (Asia/Shanghai)
**Last Updated:** 2026-11-19 09:32 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 阶段 4.3：G4-3 百家工厂压测 harness（离线部分）

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。阶段 1/2/3、4.1 与 4.2 已提交；最新提交 `9efc0e0265` 包含租户分片、PVC 会话索引与 K8s 清单。

本会话完成 WBS 4.3 的离线实现：新增 `test:perf:load` 压测 harness、G4-3 指标聚合与门禁、签名 HTTP/SSE 客户端、虚拟会话调度、跨租户隔离探测、数据集 manifest 预检，以及真实 BFF + 合成 Agent 的 loopback 自检目标。真实 100 租户 x 5 会话 x 30 分钟压测尚未执行，G4-3 现场证据门仍开放；4.4 安全渗透尚未开始。

---

## What WORKED (with evidence)

- **压测 harness 已落地** — `packages/nilm/service/scripts/perf-load.ts` 提供 `--self-check` 与真实 `--target` 两种运行；`scripts/perf/{metrics,http,runner,loopback}.ts` 分别负责门禁聚合、签名 HTTP/SSE、负载调度与 loopback 目标。根 `package.json` 已声明 `test:perf:load`。
- **压测单测** — confirmed by: `packages/nilm/service/tests/perf-load.spec.ts` 15 个用例，14 通过、1 跳过（2026-11-19 09:31 CST）。覆盖最近秩百分位与 20 万样本聚合、manifest 覆盖率预检、门禁通过与失败、场景覆盖、SSE 跨块/注释/心跳解析、签名信封被真实 `verifyRequest` 接受、注入 transport 的调度/工具分类/隔离探测；loopback 用例因沙箱拒绝绑定回环端口以 `EPERM` 跳过。
- **service 包** — confirmed by: 4 个测试文件，49 通过、1 跳过。4.2 基线的 auth 8、conversations 13、http 14 未回归。
- **全部 NILM 离线用例** — confirmed by: 42 个测试文件、325 通过、1 跳过（2026-11-19 09:31 CST）。4.2 基线为 41 文件 / 311 通过，本阶段新增 1 文件 / 14 通过。
- **同分片恢复用例** — confirmed by: `recovery.spec.ts` 1 通过、1 跳过；跳过项仍需要本机未安装的原生 `flock` addon。
- **类型检查** — confirmed by: 临时 `noEmit` 配置覆盖 `packages/nilm/service/src`、`scripts`（含新压测代码），零错误。临时环境仍缺 `zod`、`vitest` 与 vendor 类型，仓库既有错误不在本包范围；测试文件的 `context` 类型需在正常 `pnpm install` 环境复核。
- **README 与文档门禁** — confirmed by: translation pairing 1 对一致；limitations 398 个通过；model experience 398 个通过；doc refs 5264 个可解析；doc budgets 7 个在预算内；md links 2648 个通过。
- **`git diff --check`** — confirmed by: 空白与行尾检查通过；新增文件均以单个换行结尾。

---

## What Did NOT Work (and why)

- **真实 G4-3 压测** — 未执行：无目标集群、100 租户签名密钥、90 天分钟级 + 7 天秒级数据集与 30 分钟测量窗口。不得把离线用例或 self-check 当作 G4-3 通过。
- **CLI `--self-check`** — 未执行：当前沙箱禁止监听回环端口（`EPERM`），且本机缺少可用的 `tsx`/工作区依赖解析。对应 loopback 集成用例被显式跳过；不是产品失败。
- **`pnpm` 命令** — 未执行：本机 `pnpm` 直接段错误。测试使用 pnpm store 中的 vitest 直接运行；文档门禁用 `node --experimental-transform-types`。
- **覆盖率门禁** — 未执行：临时环境缺 `@vitest/coverage-v8`。新增强制门禁逻辑有行为用例，但未计入 per-file 100% 覆盖率统计。
- **`verify-md-wrap`** — 仍报告既有硬换行段落，集中在 phase2/3/4 与 requirements 的既有行；本阶段新增段落未被命中，未擅自修改无关文档。
- **git 提交** — 未执行：按用户要求由用户管理提交；4.3 改动仍在工作树。

---

## Key File Status

| File | Status | Summary |
| :--- | :--- | :--- |
| `packages/nilm/service/scripts/perf/metrics.ts` | Added | 最近秩百分位、延迟汇总、manifest 预检、G4-3 门禁 |
| `packages/nilm/service/scripts/perf/http.ts` | Added | 签名 HTTP、增量 SSE 解析、`LoadClient` transport 接口 |
| `packages/nilm/service/scripts/perf/runner.ts` | Added | 三类提示调度、轮次采样、工具调用计数、隔离探测、报告 |
| `packages/nilm/service/scripts/perf/loopback.ts` | Added | 真实 BFF + 内存会话索引 + 合成 Agent 自检目标 |
| `packages/nilm/service/scripts/perf-load.ts` | Added | CLI 参数、目标/自检运行、报告输出 |
| `packages/nilm/service/tests/perf-load.spec.ts` | Added | 15 个离线用例；loopback 在沙箱 EPERM 时跳过 |
| `package.json` / `tsconfig.host.json` | Modified | 新增 `test:perf:load`；scripts 纳入 host 类型检查 |
| `packages/nilm/service/README.md` / `.zh.md` / `.i18n.yaml` | Modified | 压测命令、manifest、门禁口径、证据边界；配对已重算 |
| `docs/nilm-ai-agent-development-plan.md` | Modified | G4-3 行改为“harness 已交付，现场未执行” |
| `docs/nilm-ai-agent-detailed-design-phase4.md` | Modified | 新增 §6.3 压测执行契约与证据边界 |
| `SESSION_STATE.md` | Rewritten | 本文件 |

工作树仍有上述 4.3 改动；4.2 已在 `9efc0e0265` 提交。

---

## Decisions Made

- **门禁阈值固定** — 首流 p95 < 300ms；无 Tool 首字 p95 < 1500ms；含 Tool 端到端 p95 < 8000ms、p99 < 12000ms；HTTP 5xx 与轮次错误率 < 0.5%。
- **首流口径从 `POST /v1/turns` 发起计时** — reason: 包含建轮开销，比纯 SSE TTFB 更保守；`ping` 心跳不计入首流。
- **Tool 分类只认观测到的 `tool.start`** — reason: 不信任提示词意图；同时报告请求的 Tool 提示数与实际 `tool.start` 次数，区分“模型未调用”与“未要求调用”。
- **三类场景必须覆盖** — reason: 任务书要求无 Tool、单 Tool、多 Tool 三类；默认 30% Tool 提示均分到两小类，每类至少 20 个实测轮次。
- **样本不足 20 视为 `insufficient`** — reason: 不允许用小样本宣称百分位达标；`insufficient` 永远不算通过。
- **测量窗口按实际耗时判定** — reason: 防止配置 30 分钟但会话提前全部失败时仍通过窗口门禁。
- **隔离探测每个声明租户至少 2 次** — reason: 攻击租户读取受害会话必须返回 401/403/404，列表不得包含受害会话 id；探测覆盖不足即失败。
- **数据集不足直接拒绝运行** — manifest 必须声明 ≥100 租户、90 天分钟级、7 天秒级、每租户 5 个计量点；`--tenants-file` 时 `tenantIds` 必须覆盖全部实际 id。
- **签名客户端复用 `src/auth.ts`** — reason: 不另造协议；`canonicalRequest` 与 `createSignature` 和 BFF 验签同源。
- **self-check 明确不是 G4-3 证据** — 报告标记 `self-check`、不生成门禁，`evidence` 字段声明仅验证 harness。

---

## Blockers & Open Questions

- G4-3 现场证据门未通过：真实 100 x 5 x 30 分钟压测、QPS/p50/p95/p99、错误率与隔离探测均未在目标环境采集。
- 现场运行前必须先完成 `deploy/k8s/README.md` 的 G4-2 恢复演练；G4-2 本身仍未在真实集群演练。
- 数据集与 100 个租户密钥由现场提供；仓库不生成、不保存任何真实密钥。
- `--self-check` 在禁止监听回环端口的沙箱中无法运行；需在允许本地端口绑定的主机执行。
- 多 Tool 提示只保证“被请求”，不保证目标模型实际产生 ≥2 次 `tool.start`；现场报告需结合 `toolCalls` 与 `toolObservedTurns` 判读模型行为。
- `nilm-edge` 网关仍归平台团队；仓库只提供端点载体与路由契约。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交 4.3：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add package.json tsconfig.host.json packages/nilm/service/scripts packages/nilm/service/tests/perf-load.spec.ts packages/nilm/service/README.md packages/nilm/service/README.zh.md packages/nilm/service/README.i18n.yaml docs/nilm-ai-agent-development-plan.md docs/nilm-ai-agent-detailed-design-phase4.md SESSION_STATE.md
git commit -m "feat(nilm): add G4-3 load-test harness"
```

2. 现场执行 G4-3（必须在 G4-2 演练之后）：

```sh
NILM_LOAD_SIGNING_SECRETS=/secure/load-secrets.json \
pnpm test:perf:load \
  --target https://nilm.example.com \
  --manifest load-dataset.json \
  --tenants-file tenants.json \
  --output g4-3-report.json
```

保存报告、manifest、租户清单、准确命令与时间戳。报告 `ok: true` 且所有 gate 为 `pass` 才可声称 G4-3 通过。

3. 本地可运行自检的主机上补 `pnpm test:perf:load --self-check --output /tmp/perf-self-check.json`；它只能证明 harness 链路，不是 G4-3 证据。

4. 然后进入 WBS 4.4 安全渗透与脱敏审计；不得用 4.3 离线结果替代 G4-3 现场门，也不得用模型拒答充当隔离证据。

---

## Environment & Setup Notes

- NILM 全量测试（临时配置 `/tmp/vitest.nilm.config.mjs`，排除需要原生 `flock` 的 recovery 用例）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/service/tests
node "$V" run --config /tmp/vitest.recovery.config.mjs
```

- 类型检查（临时配置 `/tmp/tsconfig.nilm-load.json` 覆盖 service src/scripts）：

```sh
D=$(ls -d ~/.local/share/pnpm/store/v11/links/@/typescript/5.9.3/*/node_modules/typescript/bin/tsc | head -1)
node "$D" -p /tmp/tsconfig.nilm-load.json 2>&1 | grep -E "packages/nilm/service/(src|scripts)"
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
