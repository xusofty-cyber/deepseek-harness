# Session: 2026-11-18

**Started:** 2026-11-18 (Asia/Shanghai)
**Last Updated:** 2026-11-18 18:47 CST
**Project:** `/home/picohood/projects/opensource/deepseek-harness`
**Topic:** NILM 阶段 4.2：租户分片 StatefulSet、PVC 会话索引与同分片恢复（离线部分）

---

## What We Are Building

在 dsh harness 上构建独立 NILM 工厂能源 AI Agent 服务，为微信小程序 / App 调用方提供对话、能效分析、安全隐患检索与主动告警。调用方完成用户认证后，用签名信封向 BFF 传入 `tenant_id`、`user_ref`、`allowed_scope`、`request_id`；BFF 只验签并绑定不可变调用上下文。

阶段 1/2/3 与 4.1 已提交。本会话完成 WBS 4.2 的离线实现：`packages/nilm/sharding` 路由契约、`nilm-service` 的租户目录/会话索引/分片拒绝、`deploy/k8s/` 全套清单，以及真实 JSONL 后端的撕裂尾部读取与跨实例重载用例。4.2 的现场证据门（G4-2）仍需真实集群演练；4.3 百家工厂压测、4.4 安全渗透尚未开始。

---

## What WORKED (with evidence)

- **分片路由契约** — confirmed by: `packages/nilm/sharding/tests/sharding.spec.ts` 15 个用例通过（2026-11-18 18:45 CST），覆盖 MurmurHash3 固定向量、UTF-8 字节口径、同租户稳定性、全分片覆盖与非法输入。
- **BFF 租户目录与会话索引** — confirmed by: `packages/nilm/service/tests/conversations.spec.ts` 13 个用例；`packages/nilm/service/tests/http.spec.ts` 14 个用例；`package/nilm/service/tests/auth.spec.ts` 8 个用例，共 35 个通过。覆盖路径穿越编码、原子落盘、损坏记录失败、跨实例重载、分片 `403 SCOPE_FORBIDDEN`、探针可寻址、重启后历史读取。
- **同分片恢复离线证据** — confirmed by: `packages/nilm/service/tests/recovery.spec.ts` 1 个通过、1 个跳过。通过用例用真实 `session-persistence-jsonl` 后端写入完成事件加撕裂尾部，验证读取忽略残行且原文件保留；跳过用例需要本机未安装的原生 `flock` addon。
- **全部 NILM 测试** — confirmed by: 41 个测试文件、311 个用例全部通过（2026-11-18 18:45 CST），包含阶段 3 的 234 基线、4.1 的调度器用例与本阶段新增用例。
- **类型检查** — confirmed by: 临时 `noEmit` 配置下 `packages/nilm/sharding` 与 `packages/nilm/service` 零错误；仓库既有 `zod` 缺失与 vendor 类型错误不在本包范围。
- **tsconfig 别名** — confirmed by: `gen-tsconfig-paths.ts --check` 报告别名已是最新，手工新增的 `@deepseek-ai/dsh-nilm-sharding` 与生成结果一致。
- **部署清单** — confirmed by: `deploy/k8s/` 9 个 YAML 经 `js-yaml` 解析，资源为 Namespace、ConfigMap、Secret 模板、两个 Service、Ingress、StatefulSet、PDB 和 4 个 NetworkPolicy。
- **文档门禁** — confirmed by: README limitations 398 个通过；model experience 398 个通过；doc refs 5258 个可解析；doc budgets 7 个在预算内；md links 2648 个通过；5 个命名翻译配对一致，`README.i18n.yaml` 已重算。
- **`git diff --check`** — confirmed by: 空白与行尾检查通过；新增文件均以单个换行结尾。

---

## What Did NOT Work (and why)

- **真实 K8s G4-2 演练** — 未执行：无目标集群、镜像与真实租户流量。清单中的 SIGKILL、PVC 重挂、节点迁移与边缘路由命令尚未运行；不能声称 G4-2 通过。
- **根级 `pnpm` 命令** — 未执行：本机 `pnpm` 直接段错误。`pnpm-lock.yaml` 为手工增量修改（service → sharding link 与 `packages/nilm/sharding: {}`），需在正常环境用 `pnpm install --lockfile-only` 复核。
- **覆盖率门禁** — 未执行：临时环境缺 `@vitest/coverage-v8`。新增 `runtime.history` 的 Cordis 适配没有独立用例，只有 HTTP 层 fake 与真实 JSONL 读取用例。
- **`verify-cordis-config`** — failed because: 当前环境无法解析 `@deepseek-ai/cordis-plugin-include`；这是既有环境问题，不是本次 manifest 改动引入。
- **`verify-md-wrap`** — failed because: `docs/nilm-ai-agent-detailed-design-phase2/3/4` 与 `docs/nilm-ai-agent-requirements.md` 存在既有硬换行段落（phase4 命中行均非本次改动）；`deploy/k8s/README*.md` 无命中。未擅自修改无关文档。
- **`verify-package-readme-summaries`** — failed because: 全部 17 个 `packages/nilm/**/README.md`（含既有的 16 个与新增 sharding）都没有 `## Summary`；这是该私有包组既有约定与门禁的冲突，不是 4.2 引入。若要清零，需整组补 Summary，不应只改 sharding。
- **`verify-package-paths`** — failed because: 既有断链集中在 `docs/nilm-ai-agent-high-level-design.md` 与一条 archived/proposed Agent Note；本次未改动这些引用。
- **全仓翻译配对** — 仍被既有未配对详细设计文档阻塞；本阶段新增与修改的配对已单独验证。
- **git 提交** — 未执行：按用户授权边界，4.2 改动留在工作树。

---

## What Has NOT Been Tried Yet

- WBS 4.3 `test:perf:load` 百家工厂 30 分钟压测。
- WBS 4.4 安全渗透、脱敏审计与全量验收。
- MySQL `nilm_conversation` 表接入；当前恢复路径是 PVC 索引。
- 同一租户由多个在线副本服务（需要 Redis nonce 与共享幂等记录）。
- 边缘网关 `nilm-edge` 的真实实现与 100 租户路由演练。
- 存储类为 `Immediate` 时的节点固定或卷亲和方案。
- R-01b 自适应 4 周基线、R-03 实时功率过载、R-04 分相电流列。

---

## Current State of Files

| File | Status | Notes |
| --- | --- | --- |
| `packages/nilm/sharding/` | PASS: New | `murmur3x86_32`、`shardForTenant`、`resolveShardAssignment`、`shardPodName`、双语 README 与 15 个用例 |
| `packages/nilm/service/src/paths.ts` | PASS: New | 租户路径段转义与 `<sessionsRoot>/<tenant>` 解析 |
| `packages/nilm/service/src/conversations.ts` | PASS: New | `ConversationStore`、内存与 PVC 实现、临时文件 + fsync + rename |
| `packages/nilm/service/src/config.ts` | PASS: Modified | `sessionsRoot`、`shardIndex`、`shardCount` 与解析后 `shard` |
| `packages/nilm/service/src/runtime.ts` | PASS: Modified | 租户 cwd、跨租户 resume 拒绝、`history()` 读取持久化历史 |
| `packages/nilm/service/src/http.ts` | PASS: Modified | 租户索引装载、轮次结束落盘、`close()` 排空写入、验签后分片守卫、`/readyz` 分片信息 |
| `packages/nilm/service/src/index.ts` | PASS: Modified | 按 `sessionsRoot` 选择存储、注入分片与后台失败上报 |
| `packages/nilm/service/tests/` | PASS: New/Modified | 35 个用例；恢复用例另跑 |
| `deploy/k8s/` | PASS: New | 9 个清单 + 双语 README + i18n 记录；G4-2 演练步骤已写入 |
| `packages/bundle/nilm-app/cordis.patch.yml` | PASS: Modified | `NILM_SESSIONS_ROOT`、`NILM_SHARD_INDEX`（从 Pod 序号推导）、`NILM_SHARD_COUNT` |
| `packages/bundle/nilm-app/README*.md` | PASS: Modified | 进程内状态与 PVC 恢复边界已同步 |
| `docs/nilm-ai-agent-detailed-design-phase4.md` | PASS: Modified | §5.1 图示改为 MurmurHash3 取模；§5.2/5.3 记录真实布局与证据边界 |
| `docs/nilm-ai-agent-architecture.md` | PASS: Modified | 分片路由、会话归属与 projection 说明 |
| `docs/nilm-ai-agent-high-level-design.md` / `development-plan.md` | PASS: Modified | 会话元数据状态与 G4-2 行已更新 |
| `pnpm-lock.yaml` / `tsconfig.base.json` / `scripts/verify-package-readme-model-experience.ts` | PASS: Modified | 手工 lockfile、路径别名与 README 豁免 |
| `SESSION_STATE.md` | PASS: Rewritten | 本文件 |

工作树仍有 4.2 的未跟踪目录与修改文件；上一轮 4.1 已在 `6b8acd3470` 提交。

---

## Decisions Made

- **路由函数为 MurmurHash3 x86-32 取模，不是一致性哈希环** — reason: 固定分片数下稳定且可用固定向量验证；变更分片数属于迁移，必须排空旧 Pod 并搬运租户目录，不承诺在线双写。
- **分片守卫放在 HMAC 验签之后** — reason: 只有已认证调用方才暴露租户归属；`/healthz` 与 `/readyz` 保持无信封可探活。
- **租户目录承载 Session 与索引** — reason: 同一 PVC 上 JSONL 与 `.nilm/conversations` 同生命周期；未配置 `sessionsRoot` 时退回进程内索引。
- **恢复为惰性 resume，不在启动时全量扫描** — reason: 首次 list/continue/history 时按租户装载，避免启动放大；跨租户 resume 由存储 cwd 再校验一次。
- **StatefulSet `OrderedReady` + JSONL `flock` 双层保护** — reason: 旧 Pod 消失后才创建继任者，内核租约阻止在线双写；不承诺新旧 Pod 同节点。
- **边缘路由由平台网关承担** — reason: Ingress 无法计算 MurmurHash3，nginx `upstream-hash-by` 算法不同；BFF 守卫使误路由无害。
- **`DSH_HOME` 与 `HOME` 指向 PVC** — reason: 容器只读根文件系统，`dsh` 每次启动重写 profile 根；镜像必须内置 dsh 安装与 bundle，首启不依赖下载。
- **NetworkPolicy 为边缘网关补出口规则** — reason: 命名空间级 default-deny 同时阻断网关到分片 Pod，仅有入站规则不够。

---

## Blockers & Open Questions

- 4.2 改动尚未提交；需要在正常终端执行提交。
- G4-2 现场证据门未通过：真实 SIGKILL、PVC 重挂、节点一致性与历史续接均未演练。
- 默认 StorageClass 是否为 `WaitForFirstConsumer` 未知；`Immediate` 需要节点固定策略。
- `pnpm-lock.yaml` 手工修改需在 pnpm 可用环境复核。
- 镜像尚未定义：必须包含 `dsh`、Node ≥ 24.9 与 `@deepseek-ai/dsh-nilm-app` bundle。
- 同租户多在线副本仍被 nonce/幂等进程内存限制；不在 4.2 范围。
- `nilm-edge` 网关实现仍归平台团队，仓库只提供端点载体与路由契约。

---

## Exact Next Step

1. 在可写 `.git` 的正常终端提交 4.2：

```sh
cd /home/picohood/projects/opensource/deepseek-harness
git add deploy packages/nilm packages/bundle/nilm-app docs tsconfig.base.json pnpm-lock.yaml scripts/verify-package-readme-model-experience.ts SESSION_STATE.md
git commit -m "feat(nilm): add tenant sharding, PVC conversation index, and K8s deployment"
```

2. 进入 WBS 4.3：实现 `test:perf:load` 百家工厂 30 分钟压测脚本与 G4-3 指标采集，不重跑 4.2 离线用例。
3. 现场证据顺序：先在目标集群执行 `deploy/k8s/README.md` 的 G4-2 演练并保存节点/卷/历史输出，再做 4.3 压测，最后 4.4 渗透。
4. 部署前用 `kubectl get storageclass` 确认 `WaitForFirstConsumer`，并替换 `networkpolicy.yaml` 的 CIDR 占位符。

---

## Environment & Setup Notes

- NILM 全量测试（临时配置在 `/tmp/vitest.nilm.config.mjs`，已排除需要原生 flock 的 recovery 用例）：

```sh
V=$(find ~/.local/share/pnpm/store/v11/links/@/vitest -name vitest.mjs | head -1)
node "$V" run --config /tmp/vitest.nilm.config.mjs
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/sharding/tests
node "$V" run --config /tmp/vitest.nilm.config.mjs packages/nilm/service/tests
node "$V" run --config /tmp/vitest.recovery.config.mjs
```

- 类型检查（临时 `noEmit` 配置在 `/tmp/tsconfig.sharding.json`）：

```sh
D=$(ls -d ~/.local/share/pnpm/store/v11/links/@/typescript/5.9.3/*/node_modules/typescript/bin/tsc | head -1)
node "$D" -p /tmp/tsconfig.sharding.json 2>&1 | grep -E "packages/nilm/(sharding|service)"
```

- 文档门禁：

```sh
node --experimental-transform-types scripts/verify-package-readme-limitations.ts
node --experimental-transform-types scripts/verify-package-readme-model-experience.ts
node --experimental-transform-types scripts/verify-doc-refs.ts
node --experimental-transform-types scripts/verify-doc-budgets.ts
node --experimental-transform-types scripts/verify-md-links.ts
node --experimental-transform-types scripts/verify-translation-pairing.ts packages/nilm/README.md packages/nilm/service/README.md packages/nilm/sharding/README.md deploy/k8s/README.md packages/bundle/nilm-app/README.md
```

- 当前环境 `pnpm` 会段错误；不要反复重试。`git` 写操作需在正常终端执行。
