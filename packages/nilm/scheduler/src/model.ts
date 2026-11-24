/**
 * Scheduled-job and report persistence vocabulary. Jobs are idempotent per
 * tenant and business date; reports are immutable and delivered through the
 * shared notification Outbox.
 * @module @deepseek-ai/dsh-nilm-scheduler/model
 */

import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'

/** Scheduled job families owned by this package. */
export type JobType = 'morning_report' | 'pf_forecast' | 'data_quality'

/** Persisted job-run state. */
export type JobStatus = 'pending' | 'running' | 'completed' | 'failed'

/** Report families persisted in `nilm_report`. */
export type ReportType = 'morning_report' | 'pf_forecast'

/** Tenant settings needed to generate and deliver scheduled reports. */
export interface TenantSchedule {
  /** Tenant boundary. */
  tenantId: string
  /** Display name used in summaries. */
  tenantName: string
  /** Raw notification policy; recipients are resolved without plaintext storage. */
  notificationPolicy: unknown
}

/** One idempotency-keyed job claim. */
export type JobClaim =
  | { readonly status: 'claimed'; readonly jobRunId: string; readonly attempt: number }
  | { readonly status: 'completed'; readonly jobRunId: string }
  | { readonly status: 'in-progress'; readonly jobRunId: string; readonly retryAtMs?: number }

/** One report row ready for insert. */
export interface ReportDraft {
  /** Stable public report identifier. */
  reportId: string
  /** Tenant boundary. */
  tenantId: string
  /** Report family. */
  reportType: ReportType
  /** Business date the report describes. */
  reportDate: string
  /** Structured deterministic facts. */
  payloadJson: string
  /** Optional `ChartSpec v1` JSON. */
  chartJson?: string
  /** Initial summary text; a model may replace only this field. */
  summaryText: string
  /** Generation instant. */
  generatedAtMs: number
}

/** Outcome of an idempotent report insert. */
export interface SavedReport {
  /** Inserted or previously existing report id. */
  reportId: string
  /** Whether this call created the row. */
  inserted: boolean
}

/** One report already persisted for a tenant. */
export interface StoredReport {
  /** Public report identifier. */
  reportId: string
  /** Report family. */
  reportType: ReportType
  /** Business date. */
  reportDate: string
  /** Structured facts decoded from JSON. */
  payload: unknown
  /** Stored summary text. */
  summaryText: string | null
}

/** One report delivery row inserted into the shared Outbox. */
export interface ReportOutboxDraft {
  /** Public notification identifier; the client de-duplicates by this value. */
  notificationId: string
  /** Tenant boundary. */
  tenantId: string
  /** Receiving caller-side user reference. */
  userRef: string
  /** Report being delivered. */
  reportId: string
  /** Delivery channel. */
  channel: NotificationChannel
  /** Provider template identifier when configured. */
  templateId?: string
  /** Encrypted recipient material. */
  recipientCiphertext?: Uint8Array
  /** Masked recipient hint for troubleshooting. */
  recipientMasked?: string
  /** Deterministic template parameters. */
  payloadJson: string
  /** Per-channel idempotency key. */
  dedupeKey: string
  /** Attempt ceiling. */
  maxAttempts: number
  /** First eligible delivery instant. */
  nextRetryAtMs: number
}

/** One operational audit row for R-08 findings. */
export interface QualityAuditDraft {
  /** Stable audit identifier. */
  auditId: string
  /** Tenant boundary. */
  tenantId: string
  /** Finding family. */
  kind: string
  /** Affected scope or meter. */
  scope: string
  /** Deterministic finding text. */
  message: string
  /** Observed value that crossed the threshold. */
  observed: number
  /** Configured threshold. */
  threshold: number
  /** Finding instant. */
  atMs: number
}

/** Alert counts used by the morning report. */
export interface AlertCounts {
  /** Critical events detected in the report window. */
  critical: number
  /** Warning events detected in the report window. */
  warning: number
  /** Informational events detected in the report window. */
  info: number
  /** Events in the report window that are neither resolved nor false positives. */
  unresolved: number
}

/** Persistence seam consumed by the scheduler. */
export interface SchedulerRepository {
  /** @returns enabled tenants and their delivery policy. */
  listTenants(): Promise<TenantSchedule[]>
  /**
   * Claim one job idempotency key, or report an existing outcome.
   * @param input - job family, tenant, business date, and idempotency key.
   * @returns the claim outcome.
   */
  claimJob(input: {
    jobType: JobType
    tenantId: string
    scheduledAtMs: number
    idempotencyKey: string
    nowMs: number
    leaseMs: number
    retryDelayMs: number
    newJobRunId: () => string
  }): Promise<JobClaim>
  /**
   * Mark the claimed attempt completed; a stale attempt whose lease was reclaimed changes nothing.
   * @param jobRunId - claimed run. @param attempt - attempt fence from the claim. @param finishedAtMs - completion instant.
   * @returns whether this attempt still held the claim.
   */
  completeJob(jobRunId: string, attempt: number, finishedAtMs: number): Promise<boolean>
  /**
   * Mark the claimed attempt failed; a stale attempt whose lease was reclaimed changes nothing.
   * @param jobRunId - claimed run. @param attempt - attempt fence from the claim. @param errorCode - stable failure code. @param finishedAtMs - failure instant.
   * @returns whether this attempt still held the claim.
   */
  failJob(jobRunId: string, attempt: number, errorCode: string, finishedAtMs: number): Promise<boolean>
  /** @param report - deterministic report row. @returns the stored report id and whether it was inserted. */
  saveReport(report: ReportDraft): Promise<SavedReport>
  /** @param draft - report delivery row. */
  enqueueReport(draft: ReportOutboxDraft): Promise<void>
  /** @param tenantId - tenant boundary. @param startMs - inclusive window start. @param endMs - exclusive window end. @returns alert counts. */
  alertCounts(tenantId: string, startMs: number, endMs: number): Promise<AlertCounts>
  /**
   * Read the effective power-factor assessment threshold.
   * @param tenantId - tenant boundary.
   * @param businessDate - business date in `YYYY-MM-DD`.
   * @returns the configured threshold, or undefined when no policy is effective.
   */
  powerFactorThreshold(tenantId: string, businessDate: string): Promise<number | undefined>
  /**
   * Read the latest report of one family on or before a business date.
   * @param tenantId - tenant boundary.
   * @param reportType - report family.
   * @param onOrBeforeDate - inclusive business date.
   * @returns the report, or undefined when none exists.
   */
  latestReport(tenantId: string, reportType: ReportType, onOrBeforeDate: string): Promise<StoredReport | undefined>
  /** @param draft - R-08 operational audit row. */
  writeQualityAudit(draft: QualityAuditDraft): Promise<void>
}
