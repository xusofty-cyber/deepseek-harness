# `@deepseek-ai/dsh-nilm-sentinel`

English | [中文](README.zh.md)

Runs active inspection without a model: an incremental reader over upstream `nilm_unsafe_record`, tenant-rule evaluation, alert lifecycle writes, and transactional Outbox enqueue. The scanner never asks a model whether to alert, and never writes upstream data.

## Configuration

`pollIntervalMs` (default 5 s) drives the incremental safety scan; `energyIntervalMs` (default 60 s) drives energy rules; `bucketMinutes` (default 5) sets the de-duplication and escalation window; `batchSize` bounds each upstream read; `escalateAfterWindows` (default 3) requires consecutive rising buckets before a warning escalates; `maxAttempts` is copied into every Outbox row; `templates` maps `wx_subscribe`, `wx_template`, `wecom_webhook`, and `sms` to provider template ids; `nominalVoltageV` supplies the R-05 fallback; `workerId` labels the scanner in writes and logs.

Tenant thresholds live in `nilm_alert_rule.threshold_json` with `nilm_tenant_config.notification_policy_json`. No threshold, baseline, or recipient is compiled into the package.

## Extension points

`SentinelDependencies` replaces the store, upstream reader, signal provider, recipient policy, clock, and id generators for tests. Rule functions (`evaluateR01a`, `evaluateR01b`, `evaluateR02`, `evaluateR03`, `evaluateR04`, `evaluateR05`) are pure and return deterministic findings. `nilm/alert/created` is emitted only after the alert and Outbox transaction commits, and listeners must not block or roll it back.

`nilmSentinel.alerts(caller)` and `nilmSentinel.acknowledge(caller, eventId)` expose the caller-scoped list and acknowledgement used by the BFF. Acknowledgement writes `nilm_alert_transition`; it never controls a device.

## Known Limitations and Deferred Work

- R-01a/R-01b/R-02/R-03/R-04/R-05 are implemented. R-06 power-factor risk, R-07 morning report, and R-08 data-quality inspection are implemented in `nilm-scheduler`; this package does not own scheduled reports.
- `SELECT ... FOR UPDATE SKIP LOCKED` Outbox claiming and the 30-second detection-to-delivery SLO are verified offline only; they still require a live MySQL and gateway rehearsal before an SLO claim.
- Energy rules depend on hot-store power and appliance-state availability. A missing signal produces no alert rather than a guessed baseline.
- R-01b compares against the tenant-configured `baseline_kw`; automatic four-week, same-weekday, same-time median calculation is deferred.
- R-03 currently fires from upstream `nilm_unsafe_record` classifications only. The realtime power-over-capacity path is not implemented.
- R-04 remains disabled until upstream exposes per-phase current columns; the scanner logs the missing signal once per tenant and rule instead of estimating imbalance.
- Safety classifications bypass the silence window. Unknown upstream `unsafe_type` values are ignored instead of being mapped to a severity.
- The upstream incremental query assumes the watermark index `(asset_id, record_time, record_id)` or an equivalent index is available; the DBA assessment is still open.
