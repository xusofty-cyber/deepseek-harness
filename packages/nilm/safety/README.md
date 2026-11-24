# `@deepseek-ai/dsh-nilm-safety`

English | [中文](README.zh.md)

Retrieves upstream `nilm_unsafe_record` rows for one verified tenant and projects them into deterministic safety facts. Missing upstream fields remain `null`; the service never substitutes zero or guesses a threshold.

## Configuration

None. `SourceSafetyRepository` reads through `ctx.nilmSource` with parameterized time and asset filters, excludes upstream `unsafe_type='10'`, and caps results at 500 rows. `NilmSafetyDependencies.repository` replaces the read seam for tests.

## Extension points

`ctx.nilmSafety.queryUnsafeRecords(callContext, input)` accepts a half-open `TimeRangeSpec`, optional terminal/channel filters, optional severity, and a positive limit. Terminal and channel filters are applied in SQL; severity filtering happens after deterministic projection and therefore after the SQL row limit, and a limit-hit warning says so when a severity filter is present. Severity comes from the shared `classifyUnsafeHazard` in `@deepseek-ai/dsh-nilm-core`, the same classifier Sentinel uses: transient and overload types (R-01a, R-03) are `critical`, unbalance and voltage types (R-04, R-05) are `warning`, and every unconfirmed upstream type stays `unknown` and is reported as such. Records are sorted by severity (`critical`, `warning`, `info`, `unknown`), then newest first.

## Known Limitations and Deferred Work

- The confirmed upstream columns do not expose `asset_path`, `phase`, `threshold`, or `duration`; those fields are returned as `null` with the row rather than inferred from descriptions.
- Microscopic hazard evaluation over second-level events arrives in stage 2; this package currently projects stored unsafe records only.
