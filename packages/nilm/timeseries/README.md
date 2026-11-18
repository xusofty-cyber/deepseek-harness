# `@deepseek-ai/dsh-nilm-timeseries`

English | [中文](README.zh.md)

Routes authorized NILM queries across the hot TDengine endpoint, the day/month statistics endpoint, and the cold proxy, including raw realtime rows for deterministic power-quality and CUSUM analysis. Realtime and energy results are bounded, deduplicated, and returned with coverage, gaps, provenance, and a provisional flag.

## Configuration

`TimeseriesConfig` names the five upstream tables, sets `rawPointLimit` (default 2000), `chartPointLimit` (default 500), `analysisPointLimit` (default 20,000 total analysis rows, split evenly by meter), `hotDays` (default 90), and the cold template id (default `daily_energy`). Every field is visible through the Cordis `Config` schema so a deployment can match its actual DDL. Table and cold-template names must be bare identifiers; projected asset paths are escaped as SQL string values.

## Extension points

`ctx.nilmTimeseries` exposes `queryRealtimePoints`, `queryAggregatedEnergy`, `queryApplianceStates`, and `queryAnalysisSamples`. The pure exports `downsamplePoints` and `downsampleBuckets` enforce chart bounds. `NilmTimeseriesDependencies.source` replaces the source adapter, and `now` makes route-age tests deterministic.

Realtime queries read both the summarized and raw realtime tables, prefer the summarized row for duplicate `(metric, timestamp)` pairs, and reject metrics outside `REALTIME_METRICS`. Energy queries use the statistics table for day/month ranges with a projected path, raw cumulative-energy deltas for newer finer ranges, and the cold proxy once the range start exceeds `hotDays`. Negative cumulative deltas are reported as meter resets and contribute zero energy. `queryAnalysisSamples` keeps raw rows without downsampling, selects only the power-quality columns, splits `analysisPointLimit` evenly across meters, applies one extra row per meter to detect cap hits, drops rows whose projected metrics are all null, and returns samples sorted across meters. Coverage compares unique observed timestamps or bucket starts with the expected count; gaps are emitted in `Asia/Shanghai` business time.

## Known Limitations and Deferred Work

- The table and column names default to the reference upstream contract; a deployment must confirm them against the actual DDL and pass overrides when they differ.
- Statistics routing currently requires a projected channel path and handles day/month buckets; workshop-path prefix aggregation and the cold template response schema remain deployment integration work.
- Summarized realtime and energy rows take precedence over duplicate raw rows; a mixed single-phase/three-phase installation must verify that this preference matches its wiring semantics.
- `queryAnalysisSamples` splits one total row budget across meters, so a wide scope gets fewer samples per meter; callers must narrow the scope or window for full resolution.
- The analysis projection has no per-phase current columns; phase unbalance remains unavailable until upstream exposes them.
