# `@deepseek-ai/dsh-nilm-analytics`

English | [中文](README.zh.md)

Deterministic calculations over already authorized, already fetched NILM values: energy and time-of-use cost, debounced running and idle time, period comparison, energy-weighted power quality, and CUSUM step features with coverage caveats. The package performs no IO, never calls a model, and does not decide tenant access.

## Configuration

None. Every input value, threshold, and window is supplied by the caller; deployment-varying thresholds belong to tenant configuration read by an upper layer.

## Extension points

`ctx.nilmAnalytics` exposes `calculateEnergyCosts`, `calculateRunningAndIdleTime`, `calculateCompareTrends`, `analyzePowerQuality`, and `detectTimeSeriesFeatures`; the same operations are exported as pure functions. `energyWeightedPowerFactor`, `phaseUnbalancePct`, `detectPowerEdges`, `pairCycles`, and `diagnoseMicroHazards` are also exported for focused composition.

Energy buckets are prorated uniformly when a tariff slice boundary falls inside a bucket, so a coarse interval never silently applies one price to mixed bands. Energy outside every slice remains unpriced and makes `precise` false. Running and idle states are debounced by `minDwellMs`; unknown gaps stay unknown and reduce `validRatio` rather than counting as idle. Comparison marks `precise` when both periods reach 95% coverage and `comparable` when coverage differs by no more than two percentage points. Power quality integrates adjacent active and reactive samples, never treats upstream `power_factor` as the billing value, and reports harmonic content only for orders with a positive fundamental. CUSUM collapses repeated detections from one moving-average transition, pairs symmetric start-stop steps, and diagnoses frequent cycling, startup lag, phase unbalance, and harmonic resonance.

## Known Limitations and Deferred Work

- Database-backed query entry points stay in `nilm-timeseries`; this package owns only pure calculation. It performs no IO and cannot fetch phase currents or harmonic columns that upstream does not expose.
- Power quality does not compute a complete THD, and CUSUM assumes second-level power samples; coarse samples must be rejected by the caller or analyzed with a coarser threshold.
- Uniform proration assumes energy is evenly distributed across a bucket; callers that need interval-exact allocation must fetch buckets at or finer than tariff-band boundaries.
