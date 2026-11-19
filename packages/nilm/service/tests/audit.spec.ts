import { describe, expect, it } from 'vitest'
import {
  BufferedSecurityAuditSink,
  DEFAULT_AUDIT_BATCH_SIZE,
  DEFAULT_AUDIT_QUEUE_SIZE,
  SqlSecurityAuditStore,
  UNVERIFIED_AUDIT_TENANT,
  type AuditTransaction,
  type AuditTransactionRunner,
  type SecurityAuditRow,
  type SecurityAuditStore,
} from '../src/audit.ts'
import { resolveConfig } from '../src/config.ts'

interface Statement {
  sql: string
  params: readonly unknown[]
}

class RecordingDatabase implements AuditTransactionRunner {
  readonly statements: Statement[] = []
  transactions = 0

  async transaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T> {
    this.transactions += 1
    return body({
      affected: async (sql, params = []) => {
        this.statements.push({ sql, params })
        return 1
      },
    })
  }
}

class RecordingStore implements SecurityAuditStore {
  readonly batches: SecurityAuditRow[][] = []
  gate: Promise<void> | undefined
  failures = 0

  async record(rows: readonly SecurityAuditRow[]): Promise<void> {
    await this.gate
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('audit store unavailable')
    }
    this.batches.push([...rows])
  }
}

describe('SqlSecurityAuditStore', () => {
  it('writes one parameterized multi-row insert inside one transaction', async () => {
    const database = new RecordingDatabase()
    const store = new SqlSecurityAuditStore(database)
    await store.record([])
    expect(database.transactions).toBe(0)

    await store.record([
      {
        auditId: 'audit-1',
        tenantId: 'tenant-a',
        userRef: 'user-1',
        sessionId: 'session-1',
        eventType: 'tool.rejected',
        tool: 'nilm_energy_query',
        errorCode: 'SCOPE_FORBIDDEN',
      },
      { auditId: 'audit-2', tenantId: UNVERIFIED_AUDIT_TENANT, eventType: 'auth.rejected' },
    ])

    expect(database.transactions).toBe(1)
    expect(database.statements).toHaveLength(1)
    const statement = database.statements[0]
    expect(statement?.sql).toContain('INSERT INTO nilm_security_audit')
    expect(statement?.sql).toContain('(?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)')
    expect(statement?.params).toEqual([
      'audit-1',
      'tenant-a',
      'user-1',
      'session-1',
      'tool.rejected',
      'nilm_energy_query',
      'SCOPE_FORBIDDEN',
      'audit-2',
      UNVERIFIED_AUDIT_TENANT,
      null,
      null,
      'auth.rejected',
      null,
      null,
    ])
  })
})

describe('BufferedSecurityAuditSink', () => {
  it('maps events without copying request content and flushes them in order', async () => {
    const store = new RecordingStore()
    const errors: Array<{ error: unknown; dropped: number }> = []
    const overflows: number[] = []
    let sequence = 0
    const sink = new BufferedSecurityAuditSink({
      store,
      capacity: 10,
      batchSize: 2,
      onError: (error, dropped) => { errors.push({ error, dropped }) },
      onOverflow: dropped => { overflows.push(dropped) },
    }, () => `audit-${String(++sequence)}`)

    sink.record({
      type: 'tool.rejected',
      tenantId: 'tenant-a',
      userRef: 'user-1',
      sessionId: 'session-1',
      tool: 'nilm_energy_query',
      code: 'SCOPE_FORBIDDEN',
    })
    sink.record({ type: 'auth.rejected', code: 'UNAUTHORIZED_TENANT' })
    await sink.flush()

    expect(errors).toEqual([])
    expect(overflows).toEqual([])
    expect(store.batches.map(batch => batch.map(row => row.eventType))).toEqual([
      ['tool.rejected'],
      ['auth.rejected'],
    ])
    expect(store.batches.flat()).toEqual([
      {
        auditId: 'audit-1',
        tenantId: 'tenant-a',
        userRef: 'user-1',
        sessionId: 'session-1',
        eventType: 'tool.rejected',
        tool: 'nilm_energy_query',
        errorCode: 'SCOPE_FORBIDDEN',
      },
      {
        auditId: 'audit-2',
        tenantId: UNVERIFIED_AUDIT_TENANT,
        eventType: 'auth.rejected',
        errorCode: 'UNAUTHORIZED_TENANT',
      },
    ])
  })

  it('drops the newest event when the bounded queue is full', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const store = new RecordingStore()
    store.gate = gate
    const overflows: number[] = []
    const errors: Array<{ error: unknown; dropped: number }> = []
    const sink = new BufferedSecurityAuditSink({
      store,
      capacity: 1,
      batchSize: 8,
      onError: (error, dropped) => { errors.push({ error, dropped }) },
      onOverflow: dropped => { overflows.push(dropped) },
    })

    sink.record({ type: 'event.one' })
    sink.record({ type: 'event.two' })
    sink.record({ type: 'event.three' })
    release()
    await sink.flush()

    expect(overflows).toEqual([1])
    expect(errors).toEqual([])
    expect(store.batches.map(batch => batch.map(row => row.eventType))).toEqual([
      ['event.one'],
      ['event.two'],
    ])
  })

  it('reports a failed batch, keeps draining, and rejects records after close', async () => {
    const store = new RecordingStore()
    store.failures = 1
    const errors: Array<{ error: unknown; dropped: number }> = []
    const sink = new BufferedSecurityAuditSink({
      store,
      capacity: 4,
      batchSize: 4,
      onError: (error, dropped) => { errors.push({ error, dropped }) },
      onOverflow: () => undefined,
    })

    sink.record({ type: 'event.failed', tenantId: 'tenant-a' })
    await sink.flush()
    expect(errors).toHaveLength(1)
    expect(errors[0]?.error).toBeInstanceOf(Error)
    expect(errors[0]?.dropped).toBe(1)

    sink.record({ type: 'event.retried', tenantId: 'tenant-a' })
    await sink.flush()
    expect(store.batches.map(batch => batch.map(row => row.eventType))).toEqual([['event.retried']])

    await sink.close()
    sink.record({ type: 'event.late', tenantId: 'tenant-a' })
    expect(errors).toHaveLength(2)
    expect(errors[1]?.dropped).toBe(1)
    await sink.close()
  })

  it('uses the configured queue defaults', () => {
    const config = resolveConfig({
      model: 'deepseek-chat',
      signingSecrets: { 'tenant-a': 'a'.repeat(32) },
    })
    expect(config.auditQueueSize).toBe(DEFAULT_AUDIT_QUEUE_SIZE)
    expect(config.auditBatchSize).toBe(DEFAULT_AUDIT_BATCH_SIZE)

    const explicit = resolveConfig({
      model: 'deepseek-chat',
      signingSecrets: { 'tenant-a': 'a'.repeat(32) },
      auditQueueSize: 8,
      auditBatchSize: 4,
    })
    expect(explicit.auditQueueSize).toBe(8)
    expect(explicit.auditBatchSize).toBe(4)

    expect(() => resolveConfig({
      model: 'deepseek-chat',
      signingSecrets: { [UNVERIFIED_AUDIT_TENANT]: 'a'.repeat(32) },
    })).toThrow(TypeError)
  })
})
