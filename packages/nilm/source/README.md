# `@deepseek-ai/dsh-nilm-source`

English | [中文](README.zh.md)

Read-only adapters for the project MySQL database, the upstream business MySQL database, the TDengine hot and statistics endpoints, and the cold-warehouse proxy. The application layer enforces SELECT-only templates, table whitelists, parameter binding, single-statement SQL, and a fixed cold-query timeout.

## Configuration

`Config` requires `localMysql` and `upstreamMysql` endpoint objects plus `tdengineHotUrl`, `tdengineStatsUrl`, and `coldProxyUrl`. Credentials are endpoint fields. The bundle maps them from these environment variables: `NILM_LOCAL_MYSQL_*`, `NILM_UPSTREAM_MYSQL_*`, `NILM_UPSTREAM_TDENGINE_HOT_URL`, `NILM_UPSTREAM_TDENGINE_STATS_URL`, `NILM_UPSTREAM_TDENGINE_USER`, `NILM_UPSTREAM_TDENGINE_PASSWORD`, and `NILM_COLD_PROXY_URL`.

Defaults: 3306 for both MySQL ports, 10 connections per pool, 3 seconds for a TDengine request, 5 seconds for a cold-proxy request, and 1000 milliseconds for the complete connectivity probe.

## Extension points

`SourceDependencies` injects each executor or transport so tests and alternate deployment drivers can replace a live endpoint. `ctx.nilmSource` exposes guarded MySQL reads (`queryLocalReadOnly`, `queryUpstreamReadOnly`, `listLocalTables`), internally generated TDengine reads (`queryHot`, `queryStats`), the fixed-template cold query (`queryCold`), `probe`, and `close`. The TDengine methods are for domain adapters such as `nilm-timeseries`; model-facing tools never receive SQL text.

`mysql2` is an optional peer so the core package can be installed without a native/driver resolution during composition; the deployment image must provide `mysql2@^3.11.0` before the MySQL probe or a production query runs.

Run `pnpm --filter @deepseek-ai/dsh-nilm-source test:connectivity` with the `NILM_*` environment variables set. The probe reports each endpoint separately and fails when a required table is absent or the total budget exceeds `probeTimeoutMs`. Every check receives the aggregate cancellation signal; a driver that ignores cancellation is still bounded by the probe.

## Known Limitations and Deferred Work

- Stage 0 exposes only the upstream MySQL tables `nilm_unsafe_record` and `appliance_category`; stage 1 adds the asset and timeseries adapters through separate services rather than widening this package's table whitelist.
- `mysql2` has no cancellable query handle. A cancelled MySQL request stops waiting and discards its rows, but the pool may finish the statement in the background.
