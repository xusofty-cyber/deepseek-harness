import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import { describe, expect, it } from 'vitest'
import type { OutboxTask } from '../src/model.ts'
import { MysqlOutboxStore, type ProjectDatabase } from '../src/store.ts'

interface Statement {
  sql: string
  params: readonly unknown[] | undefined
}

class FakeDatabase implements ProjectDatabase, SqlTransaction {
  readonly statements: Statement[] = []
  readonly queries: object[][] = []
  readonly affectedCounts: number[] = []

  async queryLocalReadOnly<T>(): Promise<T[]> {
    return []
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

function task(overrides: Partial<OutboxTask> = {}): OutboxTask {
  return {
    id: 1,
    notificationId: 'report_1',
    tenantId: 'tenant-a',
    userRef: 'user-1',
    eventId: null,
    reportId: 'report_1',
    channel: 'wx_subscribe',
    templateId: 'tpl-1',
    recipientCiphertext: null,
    recipientMasked: '138****0000',
    payloadJson: '{"reportId":"report_1"}',
    dedupeKey: 'tenant-a:morning_report:2026-11-17',
    attemptCount: 1,
    maxAttempts: 5,
    claimedBy: 'worker-1',
    ...overrides,
  }
}

describe('MySQL outbox store', () => {
  it('claims report deliveries and maps their report identifier', async () => {
    const db = new FakeDatabase()
    const store = new MysqlOutboxStore(() => db)
    db.queries.push([{
      id: 7,
      notificationId: 'report_1',
      tenantId: 'tenant-a',
      userRef: 'user-1',
      eventId: null,
      reportId: 'report_1',
      channel: 'wx_subscribe',
      templateId: 'tpl-1',
      recipientCiphertext: null,
      recipientMasked: '138****0000',
      payloadJson: '{"reportId":"report_1"}',
      dedupeKey: 'tenant-a:morning_report:2026-11-17',
      attemptCount: 0,
      maxAttempts: 5,
      severity: null,
    }])
    db.affectedCounts.push(1)

    const [claimed] = await store.claim('worker-1', 1_000, 10, 60_000)
    expect(claimed).toMatchObject({
      id: 7, notificationId: 'report_1', reportId: 'report_1', attemptCount: 1, claimedBy: 'worker-1',
    })
    expect(db.statements[0]!.sql).toContain('o.report_id AS reportId')
  })

  it('marks a report delivered after the provider succeeds', async () => {
    const db = new FakeDatabase()
    const store = new MysqlOutboxStore(() => db)
    db.affectedCounts.push(1, 1)

    await store.markSent(task(), 'worker-1', { providerMessageId: 'provider-9' }, 2_000)

    const update = db.statements.find(statement => statement.sql.includes('nilm_report'))
    expect(update?.sql).toContain("status = 'delivered'")
    expect(update?.params).toEqual([new Date(2_000), 'tenant-a', 'report_1'])
  })

  it('does not update a report for alert-only delivery or a lost lease', async () => {
    const alertDb = new FakeDatabase()
    alertDb.affectedCounts.push(1)
    alertDb.queries.push([{ status: 'confirmed' }])
    alertDb.affectedCounts.push(1, 0)
    await new MysqlOutboxStore(() => alertDb).markSent(
      task({ eventId: 'alert_1', reportId: null }), 'worker-1', {}, 2_000,
    )
    expect(alertDb.statements.some(statement => statement.sql.includes('nilm_report'))).toBe(false)

    const lostDb = new FakeDatabase()
    lostDb.affectedCounts.push(0)
    await new MysqlOutboxStore(() => lostDb).markSent(task(), 'worker-1', {}, 2_000)
    expect(lostDb.statements).toHaveLength(1)
  })

  it('applies a diagnosis once and purges notification records', async () => {
    const db = new FakeDatabase()
    const store = new MysqlOutboxStore(() => db)
    db.affectedCounts.push(1, 2)

    await expect(store.applyDiagnosis('tenant-a', 'alert_1', {
      text: '检查电容柜', model: 'deepseek', promptVersion: 'v1',
    }, 3_000)).resolves.toBe(true)
    await expect(store.purgeNotificationRecords(4_000, 5)).resolves.toBe(2)
  })
})
