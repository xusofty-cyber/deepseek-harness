# `@deepseek-ai/dsh-nilm-tools`

English | [中文](README.zh.md)

Registers the model-facing NILM tools: `nilm_scope_resolve`, `nilm_energy_query`, `nilm_appliance_query`, and `nilm_safety_query`. Every tool derives the tenant and allowed scope from the immutable caller context bound by the BFF; no tool accepts a tenant identifier, SQL, table name, tariff, or threshold.

## Configuration

None. The plugin consumes `ctx.tools`, `ctx.nilmContext`, `ctx.nilmAssets`, `ctx.nilmTimeseries`, `ctx.nilmTariff`, `ctx.nilmAnalytics`, and `ctx.nilmSafety`.

## Extension points

`nilm_scope_resolve` returns at most five candidates and a non-overlapping meter set capped at 200 meters. Ambiguous matches return a clarification action instead of choosing one. `nilm_energy_query` prices energy only when the tenant tariff plan resolves; otherwise it returns energy with an explicit warning. `nilm_appliance_query` summarizes upstream `appliance_state` as running or stopped and never invents idle time. `nilm_safety_query` restricts SQL by the resolved terminal and channel identifiers, so a tenant-level session cannot read another workshop's events.

Every successful result carries deterministic `summaryText`, structured `facts`, `dataQuality`, and `warnings`. Model facts cap energy series at 200 buckets, appliance rows at 20, and safety records at 20; truncation is reported instead of silently dropping rows. Missing energy, appliance, or safety data is returned as an explicit empty result with `dataAvailable: false` or `totalMatched: 0`; it is never replaced with zero.

## Model Experience

### NILM tool surface

#### What the model sees

Four `nilm_*` tool declarations with strict object parameters. Tool results are compact JSON: `summaryText`, `facts`, `dataQuality`, `warnings`, and an optional `chart` using `ChartSpec v1`. Identifiers and records are bounded to keep one result under 20 KB.

#### Token effect

Each schema is a fixed per-request cost. Results add deterministic JSON after the cached prefix; the bounded series and record caps keep one tool result near 20 KB or less.

#### KV Cache effect

The tool list and descriptions are static while the plugin is loaded, so they keep a stable request prefix. Results append after that prefix. Loading or unloading the plugin changes every conversation's tool list and invalidates its cached prefix.

## Known Limitations and Deferred Work

- `nilm_appliance_query` reports running and stopped time, not electrical idle time; the upstream state column has no idle value.
- Appliance energy integrates `realtime_power` over credited intervals and is explicitly an estimate.
- Appliance cost shares the aggregate tariff cost by estimated energy, not by each device's own tariff-time slice.
- Power-quality and second-level feature tools arrive in stage 2.
