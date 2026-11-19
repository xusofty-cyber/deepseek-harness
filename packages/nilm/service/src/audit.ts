/**
 * Security-audit persistence for the NILM BFF. Events are written to
 * `nilm_security_audit` through a bounded background queue so a slow or
 * unavailable project database never blocks request handling.
 * @module @deepseek-ai/dsh-nilm-service/audit
 */

import { randomUUID } from 'node:crypto'
import type { AuditEvent } from './http.ts'

/** Tenant marker used when authentication rejected the request before identity was verified. */
export const UNVERIFIED_AUDIT_TENANT = '__unverified__'

/** Default number of queued audit events before new events are dropped. */
export const DEFAULT_AUDIT_QUEUE_SIZE = 1024

/** Default number of audit rows written per transaction. */
export const DEFAULT_AUDIT_BATCH_SIZE = 64

/** One row of `nilm_security_audit` produced from a BFF audit event. */
export interface SecurityAuditRow {
  /** Server-generated primary key. */
  readonly auditId: string
  /** Verified tenant, or {@link UNVERIFIED_AUDIT_TENANT} for authentication failures. */
  readonly tenantId: string
  /** Opaque caller-side user reference when identity was verified. */
  readonly userRef?: string
  /** Session that produced the event when one exists. */
  readonly sessionId?: string
  /** Stable event class, such as `request.rejected`. */
  readonly eventType: string
  /** Registered tool name for tool events. */
  readonly tool?: string
  /** Stable failure code for rejected events. */
  readonly errorCode?: string
}

/** Statement surface used by the audit repository inside one transaction. */
export interface AuditTransaction {
  /**
   * Execute one parameterized write and return the affected-row count.
   * @param sql - statement owned by this package.
   * @param params - positional values bound by the driver.
   * @returns number of affected rows.
   */
  affected(sql: string, params?: readonly unknown[]): Promise<number>
}

/** Transaction seam supplied by `nilmSource`; tests inject a recording fake. */
export interface AuditTransactionRunner {
  /**
   * Run one callback inside a transaction, committing only when it resolves.
   * @param body - statements to execute with the transaction handle.
   * @returns the callback result after commit.
   */
  transaction<T>(body: (tx: AuditTransaction) => Promise<T>): Promise<T>
}

/** Persistence seam for security-audit rows. */
export interface SecurityAuditStore {
  /**
   * Persist one batch atomically.
   * @param rows - rows produced from consecutive audit events.
   * @returns a promise that settles after the transaction commits.
   */
  record(rows: readonly SecurityAuditRow[]): Promise<void>
}

const INSERT_AUDIT = `INSERT INTO nilm_security_audit
  (audit_id, tenant_id, user_ref, session_id, event_type, tool, error_code)
  VALUES `
const AUDIT_PLACEHOLDER = '(?, ?, ?, ?, ?, ?, ?)'

/** MySQL-backed repository over the project transaction runner. */
export class SqlSecurityAuditStore implements SecurityAuditStore {
  /**
   * @param database - project transaction runner, normally `ctx.nilmSource`.
   */
  constructor(private readonly database: AuditTransactionRunner) {}

  /**
   * Persist a batch in one transaction. An empty batch performs no I/O.
   * @param rows - rows produced from consecutive audit events.
   * @returns a promise that settles after commit.
   */
  async record(rows: readonly SecurityAuditRow[]): Promise<void> {
    if (rows.length === 0) return
    const values = rows.map(() => AUDIT_PLACEHOLDER).join(', ')
    const params = rows.flatMap(row => [
      row.auditId,
      row.tenantId,
      row.userRef ?? null,
      row.sessionId ?? null,
      row.eventType,
      row.tool ?? null,
      row.errorCode ?? null,
    ])
    await this.database.transaction(async tx => {
      await tx.affected(`${INSERT_AUDIT}${values}`, params)
    })
  }
}

/** Construction options for {@link BufferedSecurityAuditSink}. */
export interface BufferedSecurityAuditOptions {
  /** Persistence implementation. */
  readonly store: SecurityAuditStore
  /** Maximum queued events; the newest event is dropped when the queue is full. */
  readonly capacity: number
  /** Maximum rows sent to the store in one transaction. */
  readonly batchSize: number
  /** Report a failed batch and the number of rows that were not persisted. */
  readonly onError: (error: unknown, dropped: number) => void
  /** Report one dropped event when the queue is full. */
  readonly onOverflow: (dropped: number) => void
}

/** Bounded, ordered, asynchronous audit writer used as the HTTP service sink. */
export class BufferedSecurityAuditSink {
  private readonly queue: SecurityAuditRow[] = []
  private draining: Promise<void> | undefined
  private closed = false

  /**
   * @param options - persistence seam and queue policy.
   * @param createAuditId - audit id generator; tests inject a deterministic value.
   */
  constructor(
    private readonly options: BufferedSecurityAuditOptions,
    private readonly createAuditId: () => string = randomUUID,
  ) {}

  /**
   * Queue one event without blocking the caller.
   * @param event - BFF security event; must not contain request bodies or secrets.
   */
  record(event: AuditEvent): void {
    if (this.closed) {
      this.options.onError(new Error('security audit sink is closed'), 1)
      return
    }
    if (this.queue.length >= this.options.capacity) {
      this.options.onOverflow(1)
      return
    }
    this.queue.push(toRow(event, this.createAuditId()))
    if (this.draining === undefined) this.draining = this.drain()
  }

  /**
   * Wait until every queued event has been written or dropped by a failure.
   * @returns a promise that settles when the queue is empty.
   */
  async flush(): Promise<void> {
    while (this.draining !== undefined) {
      await this.draining
    }
  }

  /**
   * Stop accepting events and flush the queue. Repeated calls are no-ops.
   * @returns a promise that settles after the final batch.
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.flush()
  }

  private async drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.options.batchSize)
        try {
          await this.options.store.record(batch)
        } catch (error) {
          this.options.onError(error, batch.length)
        }
      }
    } finally {
      this.draining = undefined
    }
  }
}

/** Map one BFF event to its audit row without copying request content. */
function toRow(event: AuditEvent, auditId: string): SecurityAuditRow {
  return {
    auditId,
    tenantId: event.tenantId ?? UNVERIFIED_AUDIT_TENANT,
    ...(event.userRef === undefined ? {} : { userRef: event.userRef }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    eventType: event.type,
    ...(event.tool === undefined ? {} : { tool: event.tool }),
    ...(event.code === undefined ? {} : { errorCode: event.code }),
  }
}
