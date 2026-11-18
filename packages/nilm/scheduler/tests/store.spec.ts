import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import { describe, expect, it } from 'vitest'
import { MysqlSchedulerRepository, type SchedulerDatabase } from '../src/store.ts'

interface Statement {
  sql: string
  params: readonly unknown[] | undefined
}

class FakeDatabase implements SchedulerDatabase, SqlTransaction {
  readonly statements: Statement[] = []
  readonly reads: object[][] = []
  readonly queries: object[][] = []
  readonly affectedCounts: number[] = []

  async queryLocalReadOnly<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    this.statements.push({ sql, params })
    return (this.reads.shift() ?? []) as T[]
  }

  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return body(this)
  }

  async query<T>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    this.statements.push({ sql, params })
    return (this.queries.shift() ?? []) as T[]
  }

  async affected(sql: string, params?: readonly unknown[]): Promise<number> {
    this.statements.push({ sql, params })
    return this.affectedCounts.shift() ?? 0
  }
}

function repository(database: FakeDatabase): MysqlSchedulerRepository {
  return new MysqlSchedulerRepository(() => database)
}

describe('MySQL scheduler repository', () => {
  it('lists tenants and maps alert severities', async () => {
    const db = new FakeDatabase()
    db.reads.push(
      [{ tenantId: 'tenant-a', tenantName: '工厂A', notificationPolicy: { recipients: [] } }],
      [
        { severity: 'critical', total: 2, unresolved: 1 },
        { severity: 'warning', total: '3', unresolved: '2' },
        { severity: 'info', total: 4, unresolved: 3 },
        { severity: 'resolved', total: 9, unresolved: 0 },
      ],
      [{ threshold: '0.9' }],
    )
    const repo = repository(db)

    await expect(repo.listTenants()).resolves.toEqual([
      { tenantId: 'tenant-a', tenantName: '工厂A', notificationPolicy: { recipients: [] } },
    ])
    await expect(repo.alertCounts('tenant-a', 1, 2)).resolves.toEqual({
      critical: 2, warning: 3, info: 4, unresolved: 6,
    })
    await expect(repo.powerFactorThreshold('tenant-a', '2026-11-18')).resolves.toBe(0.9)
  })

  it('rejects absent or out-of-range power-factor thresholds', async () => {
    const db = new FakeDatabase()
    db.reads.push([], [{ threshold: 0 }], [{ threshold: 1 }], [{ threshold: 'not-a-number' }])
    const repo = repository(db)

    await expect(repo.powerFactorThreshold('tenant-a', '2026-11-18')).resolves.toBeUndefined()
    await expect(repo.powerFactorThreshold('tenant-a', '2026-11-18')).resolves.toBeUndefined()
    await expect(repo.powerFactorThreshold('tenant-a', '2026-11-18')).resolves.toBeUndefined()
    await expect(repo.powerFactorThreshold('tenant-a', '2026-11-18')).resolves.toBeUndefined()
  })

  it('claims a new job and reports completed, in-progress, and retry states', async () => {
    const db = new FakeDatabase()
    const repo = repository(db)
    const input = {
      jobType: 'morning_report' as const,
      tenantId: 'tenant-a',
      scheduledAtMs: Date.parse('2026-11-18T08:30:00+08:00'),
      idempotencyKey: 'tenant-a:morning_report:2026-11-17',
      nowMs: Date.parse('2026-11-18T08:31:00+08:00'),
      leaseMs: 300_000,
      retryDelayMs: 300_000,
      newJobRunId: () => 'job_1',
    }

    db.affectedCounts.push(1)
    db.queries.push([{ jobRunId: 'job_1', status: 'running', attempt: 1, startedAt: null, finishedAt: null }])
    await expect(repo.claimJob(input)).resolves.toEqual({ status: 'claimed', jobRunId: 'job_1', attempt: 1 })

    db.affectedCounts.push(0)
    db.queries.push([{ jobRunId: 'job_1', status: 'completed', attempt: 1, startedAt: null, finishedAt: null }])
    await expect(repo.claimJob(input)).resolves.toEqual({ status: 'completed', jobRunId: 'job_1' })

    db.affectedCounts.push(0)
    db.queries.push([{
      jobRunId: 'job_1', status: 'running', attempt: 1,
      startedAt: new Date(input.nowMs - 1_000), finishedAt: null,
    }])
    await expect(repo.claimJob(input)).resolves.toEqual({ status: 'in-progress', jobRunId: 'job_1' })

    db.affectedCounts.push(0)
    db.queries.push([{
      jobRunId: 'job_1', status: 'failed', attempt: 1,
      startedAt: new Date(input.nowMs - 1_000), finishedAt: new Date(input.nowMs - 1_000),
    }])
    await expect(repo.claimJob(input)).resolves.toEqual({
      status: 'in-progress', jobRunId: 'job_1', retryAtMs: input.nowMs + 299_000,
    })

    db.affectedCounts.push(0, 1)
    db.queries.push([{
      jobRunId: 'job_1', status: 'running', attempt: 2,
      startedAt: new Date(input.nowMs - 600_000), finishedAt: null,
    }])
    await expect(repo.claimJob(input)).resolves.toEqual({ status: 'claimed', jobRunId: 'job_1', attempt: 3 })
  })

  it('rejects a claim that inserted no durable job row', async () => {
    const db = new FakeDatabase()
    db.affectedCounts.push(0)
    db.queries.push([])
    await expect(repository(db).claimJob({
      jobType: 'data_quality', tenantId: 'tenant-a', scheduledAtMs: 1, idempotencyKey: 'key',
      nowMs: 2, leaseMs: 10, retryDelayMs: 10, newJobRunId: () => 'job_1',
    })).rejects.toThrow('job claim inserted no row')
  })

  it('completes and fails running jobs with bounded error codes', async () => {
    const db = new FakeDatabase()
    const repo = repository(db)
    db.affectedCounts.push(1, 1)
    await repo.completeJob('job_1', 10)
    await repo.failJob('job_1', 'X'.repeat(80), 20)

    expect(db.statements[1]!.params).toEqual([new Date(20), 'X'.repeat(64), 'job_1'])
  })

  it('returns inserted and duplicate report identities', async () => {
    const db = new FakeDatabase()
    const repo = repository(db)
    const draft = {
      reportId: 'report_1', tenantId: 'tenant-a', reportType: 'morning_report' as const,
      reportDate: '2026-11-17', payloadJson: '{}', summaryText: 'summary', generatedAtMs: 10,
    }

    db.affectedCounts.push(1)
    await expect(repo.saveReport(draft)).resolves.toEqual({ reportId: 'report_1', inserted: true })

    db.affectedCounts.push(0)
    db.queries.push([{ reportId: 'report_existing' }])
    await expect(repo.saveReport({ ...draft, reportId: 'report_2' })).resolves.toEqual({
      reportId: 'report_existing', inserted: false,
    })

    db.affectedCounts.push(0)
    db.queries.push([])
    await expect(repo.saveReport({ ...draft, reportId: 'report_3' })).resolves.toEqual({
      reportId: 'report_3', inserted: false,
    })
  })

  it('enqueues outbox rows and truncates operational audit text', async () => {
    const db = new FakeDatabase()
    const repo = repository(db)
    await repo.enqueueReport({
      notificationId: 'report_1', tenantId: 'tenant-a', userRef: 'user-1', reportId: 'report_1',
      channel: 'wx_subscribe', payloadJson: '{}', dedupeKey: 'tenant-a:morning_report:2026-11-17',
      maxAttempts: 5, nextRetryAtMs: 10,
    })
    await repo.writeQualityAudit({
      auditId: 'audit_1', tenantId: 'tenant-a', kind: 'coverage', scope: 'terminal-1',
      message: 'M'.repeat(600), observed: 0.9, threshold: 0.95, atMs: 20,
    })

    expect(db.statements[0]!.sql).toContain('nilm_notification_outbox')
    expect(db.statements[1]!.params?.[2]).toHaveLength(512)
    expect(db.statements[1]!.params?.[3]).toBe('coverage')
  })

  it('reads the latest report and decodes stored JSON', async () => {
    const db = new FakeDatabase()
    const repo = repository(db)
    db.reads.push(
      [],
      [{
        reportId: 'report_1', reportType: 'morning_report', reportDate: '2026-11-17',
        payloadJson: '{"kind":"morning_report"}', summaryText: null,
      }],
      [{
        reportId: 'report_2', reportType: 'pf_forecast', reportDate: new Date('2026-11-16T00:00:00Z'),
        payloadJson: { kind: 'pf_forecast' }, summaryText: 'summary',
      }],
    )

    await expect(repo.latestReport('tenant-a', 'morning_report', '2026-11-17')).resolves.toBeUndefined()
    await expect(repo.latestReport('tenant-a', 'morning_report', '2026-11-17')).resolves.toEqual({
      reportId: 'report_1', reportType: 'morning_report', reportDate: '2026-11-17',
      payload: { kind: 'morning_report' }, summaryText: null,
    })
    await expect(repo.latestReport('tenant-a', 'pf_forecast', '2026-11-17')).resolves.toEqual({
      reportId: 'report_2', reportType: 'pf_forecast', reportDate: '2026-11-16',
      payload: { kind: 'pf_forecast' }, summaryText: 'summary',
    })

    db.reads.push([{ reportId: 'bad', reportType: 'morning_report', reportDate: '2026-11-17', payloadJson: '{', summaryText: '' }])
    await expect(repo.latestReport('tenant-a', 'morning_report', '2026-11-17')).rejects.toThrow('not valid JSON')
  })
})
