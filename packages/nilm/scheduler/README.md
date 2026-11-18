# `@deepseek-ai/dsh-nilm-scheduler`

English | [中文](README.zh.md)

Runs the scheduled NILM job set without model-owned numbers: the R-07 08:30 morning report, the R-06 monthly billing power-factor projection on the 20th and 25th, and the R-08 daily data-quality inspection. The morning report includes alert severity totals and the unresolved count. Every run is keyed by `(job_type, tenant_id, business_date)` through `nilm_job_run`; a completed key is never recalculated or re-delivered for the same day.

## Configuration

`tickIntervalMs` (default 60 s) drives due-job checks. `morningHour`/`morningMinute` default to 08:30 in `Asia/Shanghai`; `qualityHour`/`qualityMinute` default to the 03:30 low-peak window. `reportChannels` and `reportTemplates` select delivery channels and provider templates. `maxAttempts`, `jobLeaseMs`, and `jobRetryDelayMs` bound Outbox attempts and recovery of crashed or failed jobs. `summaryModel` is optional: when absent, the deterministic template remains; when present, a one-shot agent writes summary prose only. R-08 thresholds are deployment values, not embedded engineering constants.

## Extension points

`SchedulerDependencies` replaces the repository, data collector, recipient policy, summary writer, clock, and identifier generator. `SchedulerDataSource` supplies morning, monthly, and quality facts; `MonthlyEnergySource` is the explicit seam for monthly active/reactive preaggregation. `ReportSummaryWriter` separates model authorship from report content. Reports are written to `nilm_report` and delivery rows to `nilm_notification_outbox` with `report_id`; the shared notifier owns channel retry and marks `delivered_at` only after a successful provider response. R-08 findings go to operational audit and never to a customer channel.

## Known Limitations and Deferred Work

- R-07 morning energy, tariff shares, workshop ranking, alert counts, and R-08 coverage/parent-child checks are implemented against the authorized services. Hot-cold consistency stays disabled until a cold energy route is configured for R-08.
- R-06 projection is deterministic, but the default deployment has no monthly active/reactive preaggregation: until upstream exposes `E_p`/`E_q` or a trusted rollup is configured, the job fails with `DATA_UNAVAILABLE` instead of estimating from point power factors.
- Power-factor penalty and reward amounts are not calculated. `nilm_pf_policy` risk and threshold are reported; executable regional formulas remain a deployment decision.
- Model-authored summaries depend on a configured provider and model. A late or failed summary preserves the deterministic template and never changes report numbers or delivery.
- The G4-1 rehearsal script verifies twenty-tenant report recomputation and idempotency offline. Real 08:35 delivery completion and channel receipts still require live MySQL, recipient configuration, and provider sandboxes.
- No model-facing tool reads a stored report yet. The BFF report-query path remains deferred; the scheduler persists reports without exposing them to conversation turns.
