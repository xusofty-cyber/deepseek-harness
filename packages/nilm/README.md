---
description: "The NILM factory-energy domain group: stable types, caller-context binding, and read-only source adapters for the standalone agent service."
kind: "package-group"
---

# NILM domain packages

English | [中文](README.zh.md)

This group holds the NILM factory-energy service that runs on the harness. It is not a general-purpose harness capability group: the packages implement one deployment's domain boundary, and the production composition lives in [`bundle/nilm-app`](../bundle/nilm-app/README.md).

## Packages

| Package | ctx key | Role |
|---|---|---|
| [`core`](core/README.md) | — | Branded identifiers, scope and metering structures, data-quality metadata, `ChartSpec`, `AlertCard`, and stable error codes |
| [`context`](context/README.md) | `nilmContext` | Process-memory binding from an Agent to the BFF-verified caller context |
| [`source`](source/README.md) | `nilmSource` | Guarded read-only adapters for project MySQL, upstream MySQL, TDengine hot/statistics endpoints, and the cold proxy |
| [`assets`](assets/README.md) | `nilmAssets` | Authorized five-level topology resolution and non-overlapping meter-set selection |
| [`timeseries`](timeseries/README.md) | `nilmTimeseries` | Hot, pre-aggregated, cold, appliance-state, and raw-analysis routing with bounded results and quality metadata |
| [`tariff`](tariff/README.md) | `nilmTariff` | Pure tariff-plan validation, effective-plan selection, and time-of-use slicing |
| [`analytics`](analytics/README.md) | `nilmAnalytics` | Pure energy-cost, running/idle, appliance-usage, period-comparison, power-quality, and CUSUM feature calculations |
| [`safety`](safety/README.md) | `nilmSafety` | Authorized unsafe-record retrieval and deterministic hazard projection |
| [`sentinel`](sentinel/README.md) | `nilmSentinel` | Incremental safety scan, tenant rules, alert lifecycle, and transactional Outbox enqueue |
| [`notify`](notify/README.md) | `nilmNotify` | Outbox dispatcher, channel gateways, retry policy, and asynchronous diagnosis |
| [`scheduler`](scheduler/README.md) | `nilmScheduler` | Idempotent morning reports, monthly power-factor projection, and R-08 data-quality inspection |
| [`sharding`](sharding/README.md) | — | Deterministic `tenant_id -> shard` routing and StatefulSet ordinal naming |
| [`prompt`](prompt/README.md) | — | Stable tenant-neutral system-prompt policy |
| [`tools`](tools/README.md) | — | The six model-facing `nilm_*` tools with bounded structured facts |
| [`service`](service/README.md) | — | Backend BFF: caller verification, conversation and turn state, REST endpoints, and SSE replay |

`charts` remains future work. `nilm-service` owns the HTTP/SSE BFF; no package in this group implements user permissions, an admin console, or a customer-facing Web application.

## Known Limitations and Deferred Work

- Stages 1 and 2 ship topology, timeseries, tariff, analytics, power-quality and CUSUM analysis, safety, prompt, the six model-facing tools, and the `nilm-service` BFF. Stage 3 adds sentinel rules and the Outbox notifier. Stage 4 adds scheduled reports, tenant sharding, and a PVC-backed conversation index. Nonces, idempotency, and turn buffers remain process-local; multi-writer service per tenant still needs shared nonce and idempotency storage.
- Phase-current imbalance and a complete THD value remain unavailable until upstream exposes the corresponding columns; the tools return `null` or per-order availability instead of estimating them.
