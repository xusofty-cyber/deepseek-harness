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
} from '../src/index.ts'

interface JobRow {
  jobRunId: string
  jobType: JobType
  tenantId: string
  status: 'running' | 'completed' | 'failed'
  attempt: number
  startedAtMs: number
  finishedAtMs?: number
}

interface ReportRow extends StoredReport {
  tenantId: string
  draft: ReportDraft
}

export class MemorySchedulerRepository implements SchedulerRepository {
  readonly tenants: TenantSchedule[] = []
  readonly jobs = new Map<string, JobRow>()
  readonly reports: ReportRow[] = []
  readonly outbox: ReportOutboxDraft[] = []
  readonly audits: QualityAuditDraft[] = []
  readonly thresholds = new Map<string, number>()
  readonly counts = new Map<string, AlertCounts>()

  async listTenants(): Promise<TenantSchedule[]> {
    return this.tenants
  }

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
    const key = `${input.jobType}\n${input.idempotencyKey}`
    const existing = this.jobs.get(key)
    if (existing === undefined) {
      const row: JobRow = {
        jobRunId: input.newJobRunId(),
        jobType: input.jobType,
        tenantId: input.tenantId,
        status: 'running',
        attempt: 1,
        startedAtMs: input.nowMs,
      }
      this.jobs.set(key, row)
      return { status: 'claimed', jobRunId: row.jobRunId, attempt: 1 }
    }
    if (existing.status === 'completed') return { status: 'completed', jobRunId: existing.jobRunId }
    if (existing.status === 'running' && input.nowMs - existing.startedAtMs < input.leaseMs) {
      return { status: 'in-progress', jobRunId: existing.jobRunId }
    }
    if (existing.status === 'failed' && (existing.finishedAtMs ?? 0) + input.retryDelayMs > input.nowMs) {
      return { status: 'in-progress', jobRunId: existing.jobRunId, retryAtMs: (existing.finishedAtMs ?? 0) + input.retryDelayMs }
    }
    existing.status = 'running'
    existing.startedAtMs = input.nowMs
    delete existing.finishedAtMs
    existing.attempt += 1
    return { status: 'claimed', jobRunId: existing.jobRunId, attempt: existing.attempt }
  }

  async completeJob(jobRunId: string, attempt: number, finishedAtMs: number): Promise<boolean> {
    for (const row of this.jobs.values()) {
      if (row.jobRunId === jobRunId && row.attempt === attempt && row.status === 'running') {
        row.status = 'completed'
        row.finishedAtMs = finishedAtMs
        return true
      }
    }
    return false
  }

  async failJob(jobRunId: string, attempt: number, _errorCode: string, finishedAtMs: number): Promise<boolean> {
    for (const row of this.jobs.values()) {
      if (row.jobRunId === jobRunId && row.attempt === attempt && row.status === 'running') {
        row.status = 'failed'
        row.finishedAtMs = finishedAtMs
        return true
      }
    }
    return false
  }

  async saveReport(report: ReportDraft): Promise<SavedReport> {
    const existing = this.reports.find(row =>
      row.tenantId === report.tenantId && row.reportType === report.reportType && row.reportDate === report.reportDate)
    if (existing !== undefined) return { reportId: existing.reportId, inserted: false }
    const payload: unknown = JSON.parse(report.payloadJson)
    this.reports.push({
      reportId: report.reportId,
      reportType: report.reportType,
      reportDate: report.reportDate,
      payload,
      summaryText: report.summaryText,
      tenantId: report.tenantId,
      draft: report,
    })
    return { reportId: report.reportId, inserted: true }
  }

  async enqueueReport(draft: ReportOutboxDraft): Promise<void> {
    const exists = this.outbox.some(row =>
      row.tenantId === draft.tenantId
      && row.dedupeKey === draft.dedupeKey
      && row.userRef === draft.userRef
      && row.channel === draft.channel)
    if (!exists) this.outbox.push(draft)
  }

  async alertCounts(tenantId: string, _startMs: number, _endMs: number): Promise<AlertCounts> {
    return this.counts.get(tenantId) ?? { critical: 0, warning: 0, info: 0, unresolved: 0 }
  }

  async powerFactorThreshold(tenantId: string, _businessDate: string): Promise<number | undefined> {
    return this.thresholds.get(tenantId)
  }

  async latestReport(tenantId: string, reportType: ReportType, onOrBeforeDate: string): Promise<StoredReport | undefined> {
    return this.reports
      .filter(row => row.tenantId === tenantId && row.reportType === reportType && row.reportDate <= onOrBeforeDate)
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate))[0]
  }

  async writeQualityAudit(draft: QualityAuditDraft): Promise<void> {
    this.audits.push(draft)
  }
}
