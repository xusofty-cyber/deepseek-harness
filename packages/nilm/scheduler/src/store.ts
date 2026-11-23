/**
 * MySQL persistence for scheduled jobs, reports, report delivery rows, and R-08
 * operational audit records. Claims rely on the unique job idempotency key and
 * a bounded lease; successful jobs are never recalculated for the same key.
 * @module @deepseek-ai/dsh-nilm-scheduler/store
 */

import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import type {
  AlertCounts,
  JobClaim,
  JobType,
  QualityAuditDraft,
  ReportDraft,
  ReportOutboxDraft,
  ReportType,
  SavedReport,
  SchedulerRepository,
  StoredReport,
  TenantSchedule,
} from './model.ts'

/** `DATE_FORMAT` pattern, bound as a parameter because the read-only guard rejects SQL literals. */
const SQL_DATE_FORMAT = '%Y-%m-%d'

/** Project database surface used by the scheduler. */
export interface SchedulerDatabase {
  /**
   * @param sql - guarded SELECT over project tables.
   * @param params - bound values.
   * @returns result rows.
   */
  queryLocalReadOnly<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /**
   * @param body - statements to run inside one transaction.
   * @returns the callback result after commit.
   */
  transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T>
}

/** MySQL-backed scheduler repository. */
export class MysqlSchedulerRepository implements SchedulerRepository {
  /**
   * @param database - lazily resolved project database service.
   */
  constructor(private readonly database: () => SchedulerDatabase) {}

  /** @returns enabled tenants. */
  async listTenants(): Promise<TenantSchedule[]> {
    const rows = await this.database().queryLocalReadOnly<{
      tenantId: string
      tenantName: string
      notificationPolicy: unknown
    }>(
      `SELECT tenant_id AS tenantId, tenant_name AS tenantName,
              notification_policy_json AS notificationPolicy
         FROM nilm_tenant_config
        WHERE status = 1
        ORDER BY tenant_id`,
    )
    return rows.map(row => ({
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      notificationPolicy: row.notificationPolicy,
    }))
  }

  /** @param input - claim parameters. @returns the claim outcome. */
  async claimJob(input: {
    jobType: JobType
    tenantId: string
    scheduledAtMs: number
    idempotencyKey: string
    nowMs: number
    leaseMs: number
    retryDelayMs: number
    newJobRunId: () => string
  }): Promise<JobClaim> {
    return this.database().transaction(async tx => {
      const jobRunId = input.newJobRunId()
      const inserted = await tx.affected(
        `INSERT IGNORE INTO nilm_job_run
          (job_run_id, job_type, tenant_id, scheduled_at, started_at, status, idempotency_key, attempt)
         VALUES (?, ?, ?, ?, ?, 'running', ?, 1)`,
        [jobRunId, input.jobType, input.tenantId, new Date(input.scheduledAtMs), new Date(input.nowMs), input.idempotencyKey],
      )
      const rows = await tx.query<{
        jobRunId: string
        status: string
        attempt: number
        startedAt: string | Date | null
        finishedAt: string | Date | null
      }>(
        `SELECT job_run_id AS jobRunId, status, attempt, started_at AS startedAt, finished_at AS finishedAt
           FROM nilm_job_run
          WHERE job_type = ? AND idempotency_key = ?
          FOR UPDATE`,
        [input.jobType, input.idempotencyKey],
      )
      const row = rows[0]
      if (row === undefined) throw new Error('job claim inserted no row')
      if (inserted === 1) return { status: 'claimed', jobRunId, attempt: 1 }
      if (row.status === 'completed') return { status: 'completed', jobRunId: row.jobRunId }
      if (row.status === 'running') {
        const startedAt = dateMs(row.startedAt)
        if (input.nowMs - startedAt < input.leaseMs) return { status: 'in-progress', jobRunId: row.jobRunId }
      } else if (row.status === 'failed' || row.status === 'pending') {
        const retryAtMs = dateMs(row.finishedAt ?? row.startedAt) + input.retryDelayMs
        if (retryAtMs > input.nowMs) return { status: 'in-progress', jobRunId: row.jobRunId, retryAtMs }
      }
      const attempt = Number(row.attempt) + 1
      await tx.affected(
        `UPDATE nilm_job_run
            SET status = 'running', started_at = ?, finished_at = NULL, attempt = ?, error_code = NULL
          WHERE job_run_id = ?`,
        [new Date(input.nowMs), attempt, row.jobRunId],
      )
      return { status: 'claimed', jobRunId: row.jobRunId, attempt }
    })
  }

  /** @param jobRunId - claimed run. @param finishedAtMs - completion instant. */
  async completeJob(jobRunId: string, finishedAtMs: number): Promise<void> {
    await this.database().transaction(async tx => {
      await tx.affected(
        `UPDATE nilm_job_run
            SET status = 'completed', finished_at = ?, error_code = NULL
          WHERE job_run_id = ? AND status = 'running'`,
        [new Date(finishedAtMs), jobRunId],
      )
    })
  }

  /** @param jobRunId - claimed run. @param errorCode - stable failure code. @param finishedAtMs - failure instant. */
  async failJob(jobRunId: string, errorCode: string, finishedAtMs: number): Promise<void> {
    await this.database().transaction(async tx => {
      await tx.affected(
        `UPDATE nilm_job_run
            SET status = 'failed', finished_at = ?, error_code = ?
          WHERE job_run_id = ? AND status = 'running'`,
        [new Date(finishedAtMs), errorCode.slice(0, 64), jobRunId],
      )
    })
  }

  /** @param report - report row. @returns the stored id and whether it was inserted. */
  async saveReport(report: ReportDraft): Promise<SavedReport> {
    return this.database().transaction(async tx => {
      const inserted = await tx.affected(
        `INSERT INTO nilm_report
          (report_id, tenant_id, report_type, report_date, payload_json, chart_json, summary_text, status, generated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'generated', ?)
         ON DUPLICATE KEY UPDATE report_id = report_id`,
        [
          report.reportId, report.tenantId, report.reportType, report.reportDate,
          report.payloadJson, report.chartJson ?? null, report.summaryText, new Date(report.generatedAtMs),
        ],
      )
      if (inserted === 1) return { reportId: report.reportId, inserted: true }
      const rows = await tx.query<{ reportId: string }>(
        `SELECT report_id AS reportId FROM nilm_report
          WHERE tenant_id = ? AND report_type = ? AND report_date = ?`,
        [report.tenantId, report.reportType, report.reportDate],
      )
      return { reportId: rows[0]?.reportId ?? report.reportId, inserted: false }
    })
  }

  /** @param draft - report delivery row. */
  async enqueueReport(draft: ReportOutboxDraft): Promise<void> {
    await this.database().transaction(async tx => {
      await tx.query(
        `INSERT INTO nilm_notification_outbox
          (notification_id, tenant_id, user_ref, event_id, report_id, channel, template_id,
           recipient_ciphertext, recipient_masked, payload_json, dedupe_key, status,
           attempt_count, max_attempts, next_retry_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
         ON DUPLICATE KEY UPDATE notification_id = notification_id`,
        [
          draft.notificationId, draft.tenantId, draft.userRef, draft.reportId, draft.channel,
          draft.templateId ?? null, draft.recipientCiphertext ?? null, draft.recipientMasked ?? null,
          draft.payloadJson, draft.dedupeKey, draft.maxAttempts,
          new Date(draft.nextRetryAtMs),
        ],
      )
    })
  }

  /** @param tenantId - tenant boundary. @param startMs - inclusive start. @param endMs - exclusive end. @returns alert counts. */
  async alertCounts(tenantId: string, startMs: number, endMs: number): Promise<AlertCounts> {
    const rows = await this.database().queryLocalReadOnly<{ severity: string; total: number; unresolved: number }>(
      `SELECT severity, COUNT(*) AS total,
              SUM(status <> ?) AS unresolved
         FROM nilm_alert_event
        WHERE tenant_id = ? AND detected_at >= ? AND detected_at < ?
          AND status <> ?
        GROUP BY severity`,
      ['resolved', tenantId, new Date(startMs), new Date(endMs), 'false_positive'],
    )
    const counts: AlertCounts = { critical: 0, warning: 0, info: 0, unresolved: 0 }
    for (const row of rows) {
      counts.unresolved += Number(row.unresolved)
      if (row.severity === 'critical') counts.critical = Number(row.total)
      else if (row.severity === 'warning') counts.warning = Number(row.total)
      else if (row.severity === 'info') counts.info = Number(row.total)
    }
    return counts
  }

  /** @param tenantId - tenant boundary. @param businessDate - business date. @returns the effective threshold. */
  async powerFactorThreshold(tenantId: string, businessDate: string): Promise<number | undefined> {
    const rows = await this.database().queryLocalReadOnly<{ threshold: number | string }>(
      `SELECT threshold FROM nilm_pf_policy
        WHERE tenant_id = ? AND effective_from <= ?
        ORDER BY effective_from DESC LIMIT 1`,
      [tenantId, businessDate],
    )
    const value = Number(rows[0]?.threshold)
    return Number.isFinite(value) && value > 0 && value < 1 ? value : undefined
  }

  /** @param tenantId - tenant boundary. @param reportType - report family. @param onOrBeforeDate - inclusive date. @returns the latest report. */
  async latestReport(tenantId: string, reportType: ReportType, onOrBeforeDate: string): Promise<StoredReport | undefined> {
    const rows = await this.database().queryLocalReadOnly<{
      reportId: string
      reportType: ReportType
      reportDate: string | Date
      payloadJson: unknown
      summaryText: string | null
    }>(
      `SELECT report_id AS reportId, report_type AS reportType,
              DATE_FORMAT(report_date, ?) AS reportDate,
              payload_json AS payloadJson, summary_text AS summaryText
         FROM nilm_report
        WHERE tenant_id = ? AND report_type = ? AND report_date <= ?
        ORDER BY report_date DESC LIMIT 1`,
      [SQL_DATE_FORMAT, tenantId, reportType, onOrBeforeDate],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      reportId: row.reportId,
      reportType: row.reportType,
      reportDate: dateKey(row.reportDate),
      payload: decodeJson(row.payloadJson),
      summaryText: row.summaryText,
    }
  }

  /** @param draft - R-08 audit row. */
  async writeQualityAudit(draft: QualityAuditDraft): Promise<void> {
    await this.database().transaction(async tx => {
      await tx.query(
        `INSERT INTO nilm_security_audit
          (audit_id, tenant_id, user_ref, session_id, event_type, tool, query_template,
           scope, time_range, row_count, latency_ms, error_code, created_at)
         VALUES (?, ?, 'system:scheduler', NULL, 'data_quality', 'r-08', 'r-08', ?, NULL, 1, 0, ?, ?)`,
        [
          draft.auditId, draft.tenantId,
          `${draft.scope}:${draft.message}`.slice(0, 512), draft.kind.slice(0, 64), new Date(draft.atMs),
        ],
      )
    })
  }
}

/**
 * Convert a database date or timestamp to epoch milliseconds.
 * @param value - driver value.
 * @returns epoch milliseconds.
 */
function dateMs(value: string | Date | null): number {
  if (value === null) return 0
  return value instanceof Date ? value.getTime() : Date.parse(value)
}

/**
 * Convert a driver date to a business date key.
 * @param value - date or timestamp value.
 * @returns `YYYY-MM-DD`.
 */
function dateKey(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10)
}

/**
 * Decode a MySQL JSON value.
 * @param value - decoded object, string, or null.
 * @returns decoded JSON, or null.
 */
function decodeJson(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') return value
  try {
    const decoded: unknown = JSON.parse(value)
    return decoded
  } catch (error) {
    throw new Error('stored report payload is not valid JSON', { cause: error })
  }
}
