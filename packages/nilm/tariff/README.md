# `@deepseek-ai/dsh-nilm-tariff`

English | [中文](README.zh.md)

Validates tenant-authored time-of-use tariff plans, selects the one plan effective at an instant, and splits an authorized range into priced slices and explicit gaps. The package performs no IO, reads no clock, and does not convert business time zones; callers supply epoch-millisecond ranges and projected calendar days.

## Configuration

None in this package. `SourceTariffRepository` reads `nilm_tariff_plan`, `nilm_tariff_period`, and `nilm_calendar_day` through `ctx.nilmSource`; `NilmTariffDependencies.repository` replaces that read seam. Prices and seasons remain tenant data rather than deployment constants.

## Extension points

`ctx.nilmTariff` exposes `effectivePlan(callContext, atMs, signal?)` and `splitByTariff(callContext, range, planId?, signal?)`, which load the tenant's effective plan and projected calendar before delegating to the pure functions. The exports `parseClockMinutes`, `validateTariffPlan`, `selectEffectivePlan`, `splitRangeByTariff`, and `tariffPeriodRank` remain usable without a Cordis context.

Plans use half-open epoch ranges. Periods are authored as `HH:mm` and may not wrap past midnight; a band spanning midnight is split into two periods. Overlapping periods, multiple effective plans, negative prices, and unsorted or overlapping calendar days fail with `NilmError` code `INVALID_ARGUMENT`. Uncovered intervals are returned as gaps with `outside_plan`, `missing_day`, or `no_period`; adjacent slices with identical band, price, and plan merge.

## Known Limitations and Deferred Work

- Power-factor policy loading and reward/penalty formulas arrive in stage 2. The deployment must confirm the DATE/TIME column semantics and populate `nilm_calendar_day.season`; this package does not infer seasons from month ranges.
