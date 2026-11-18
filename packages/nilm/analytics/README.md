# `@deepseek-ai/dsh-nilm-analytics`

English | [中文](README.zh.md)

Deterministic calculations over already authorized, already fetched NILM values: energy and time-of-use cost, debounced running and idle time, and period comparison with coverage caveats. The package performs no IO, never calls a model, and does not decide tenant access.

## Configuration

None. Every input value, threshold, and window is supplied by the caller; deployment-varying thresholds belong to tenant configuration read by an upper layer.

## Extension points

`ctx.nilmAnalytics` exposes `calculateEnergyCosts`, `calculateRunningAndIdleTime`, and `calculateCompareTrends`; the same operations are exported as pure functions.

Energy buckets are prorated uniformly when a tariff slice boundary falls inside a bucket, so a coarse interval never silently applies one price to mixed bands. Energy outside every slice remains unpriced and makes `precise` false. Running and idle states are debounced by `minDwellMs`; unknown gaps stay unknown and reduce `validRatio` rather than counting as idle. Comparison marks `precise` when both periods reach 95% coverage and `comparable` when coverage differs by no more than two percentage points.

## Known Limitations and Deferred Work

- Database-backed `queryEnergy`, `queryAppliances`, `queryPowerQuality`, and `analyzeTimeseries` entry points, plus power-factor and CUSUM feature extraction, arrive with later stage-1/2 work; this package currently owns only the pure calculation core.
- Uniform proration assumes energy is evenly distributed across a bucket; callers that need interval-exact allocation must fetch buckets at or finer than tariff-band boundaries.
