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
| [`timeseries`](timeseries/README.md) | `nilmTimeseries` | Hot, pre-aggregated, cold, and appliance-state routing with bounded results and quality metadata |
| [`tariff`](tariff/README.md) | `nilmTariff` | Pure tariff-plan validation, effective-plan selection, and time-of-use slicing |
| [`analytics`](analytics/README.md) | `nilmAnalytics` | Pure energy-cost, running/idle, appliance-usage, and period-comparison calculations |
| [`safety`](safety/README.md) | `nilmSafety` | Authorized unsafe-record retrieval and deterministic hazard projection |
| [`prompt`](prompt/README.md) | — | Stable tenant-neutral system-prompt policy |
| [`tools`](tools/README.md) | — | The four model-facing `nilm_*` tools with bounded structured facts |
| [`service`](service/README.md) | — | Backend BFF: caller verification, conversation and turn state, REST endpoints, and SSE replay |

Later stages add `charts`, `sentinel`, `scheduler`, and `notify` in the same group. `nilm-service` owns the HTTP/SSE BFF; no package in this group implements user permissions, an admin console, or a customer-facing Web application.

## Known Limitations and Deferred Work

- Stage 1 ships topology, timeseries, tariff, analytics, safety, prompt, the four model-facing tools, and the `nilm-service` BFF. The BFF keeps nonces, conversation metadata, and turn buffers in process memory; multi-replica deployment still needs Redis nonces and `nilm_conversation` persistence.
