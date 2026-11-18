import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import type { DeliveryFailure, OutboxTask } from '../src/model.ts'
import { retryDelayMs, shouldDeadLetter } from '../src/model.ts'
import type { DiagnosisResult, FailureOutcome, OutboxStore } from '../src/store.ts'

interface TaskRow extends OutboxTask {
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead'
  nextRetryAtMs: number
  leaseExpiresAtMs?: number
  sentAtMs?: number
  lastError?: string
}

export interface RecordRow {
  tenantId: string
  notificationId: string
  channel: NotificationChannel
  status: string
  createdAtMs: number
  providerMessageId?: string
  errorCode?: string
}

export interface EventRow {
  tenantId: string
  eventId: string
  status: 'detected' | 'confirmed' | 'notified' | 'acknowledged'
  diagnosis?: string
}

export class MemoryOutboxStore implements OutboxStore {
  readonly tasks: TaskRow[] = []
  readonly records: RecordRow[] = []
  readonly events = new Map<string, EventRow>()
  claims = 0

  addTask(overrides: Partial<TaskRow> & { id?: number } = {}): TaskRow {
    const row: TaskRow = {
      id: overrides.id ?? this.tasks.length + 1,
      notificationId: overrides.notificationId ?? `notif_${String(this.tasks.length + 1)}`,
      tenantId: overrides.tenantId ?? 'tenant-a',
      userRef: overrides.userRef ?? 'user-1',
      eventId: overrides.eventId ?? 'alert_1',
      reportId: overrides.reportId ?? null,
      channel: overrides.channel ?? 'sms',
      templateId: overrides.templateId ?? 'tpl-1',
      recipientCiphertext: overrides.recipientCiphertext ?? null,
      recipientMasked: overrides.recipientMasked ?? '138****0000',
      payloadJson: overrides.payloadJson ?? '{"summary":"夜间基载偏高"}',
      dedupeKey: overrides.dedupeKey ?? `tenant-a:R-01b:channel-1:base:${String(this.tasks.length + 1)}`,
      attemptCount: overrides.attemptCount ?? 0,
      maxAttempts: overrides.maxAttempts ?? 5,
      claimedBy: overrides.claimedBy ?? '',
      status: overrides.status ?? 'pending',
      nextRetryAtMs: overrides.nextRetryAtMs ?? 0,
      ...(overrides.leaseExpiresAtMs === undefined ? {} : { leaseExpiresAtMs: overrides.leaseExpiresAtMs }),
      ...(overrides.severity === undefined ? {} : { severity: overrides.severity }),
    }
    this.tasks.push(row)
    return row
  }

  seedEvent(eventId = 'alert_1', tenantId = 'tenant-a'): EventRow {
    const event: EventRow = { tenantId, eventId, status: 'confirmed' }
    this.events.set(`${tenantId}\n${eventId}`, event)
    return event
  }

  async claim(workerId: string, nowMs: number, limit: number, leaseMs: number): Promise<OutboxTask[]> {
    const eligible = this.tasks
      .filter(task => task.nextRetryAtMs <= nowMs)
      .filter(task => task.status === 'pending' || task.status === 'failed'
        || (task.status === 'sending' && (task.leaseExpiresAtMs === undefined || task.leaseExpiresAtMs < nowMs)))
      .sort((left, right) => severityRank(right.severity) - severityRank(left.severity)
        || left.nextRetryAtMs - right.nextRetryAtMs
        || left.id - right.id)
      .slice(0, limit)
    this.claims += 1
    return eligible.map(task => {
      task.status = 'sending'
      task.claimedBy = workerId
      task.leaseExpiresAtMs = nowMs + leaseMs
      task.attemptCount += 1
      return { ...task, claimedBy: workerId }
    })
  }

  async markSent(task: OutboxTask, workerId: string, result: { providerMessageId?: string }, nowMs: number): Promise<void> {
    const row = this.row(task.id, workerId)
    if (row === undefined) return
    row.status = 'sent'
    row.sentAtMs = nowMs
    row.lastError = undefined
    row.leaseExpiresAtMs = undefined
    this.record(row, 'sent', result.providerMessageId, undefined, nowMs)
    if (row.eventId === null) return
    const event = this.events.get(`${row.tenantId}\n${row.eventId}`)
    if (event !== undefined && (event.status === 'detected' || event.status === 'confirmed')) event.status = 'notified'
  }

  async markFailed(task: OutboxTask, workerId: string, failure: DeliveryFailure, nowMs: number): Promise<FailureOutcome> {
    const row = this.row(task.id, workerId)
    if (row === undefined) return { status: 'dead', attemptCount: task.attemptCount }
    const dead = shouldDeadLetter(row.attemptCount, row.maxAttempts, failure.retryable)
    row.status = dead ? 'dead' : 'failed'
    const nextRetryAtMs = dead ? undefined : nowMs + retryDelayMs(row.attemptCount)
    row.nextRetryAtMs = nextRetryAtMs ?? nowMs
    row.lastError = failure.code
    row.leaseExpiresAtMs = undefined
    this.record(row, row.status, undefined, failure.code, nowMs)
    return { status: row.status, attemptCount: row.attemptCount, ...(nextRetryAtMs === undefined ? {} : { nextRetryAtMs }) }
  }

  async applyDiagnosis(tenantId: string, eventId: string, diagnosis: DiagnosisResult, _nowMs: number): Promise<boolean> {
    const event = this.events.get(`${tenantId}\n${eventId}`)
    if (event === undefined || event.diagnosis !== undefined) return false
    if (!['detected', 'confirmed', 'notified'].includes(event.status)) return false
    event.diagnosis = diagnosis.text
    return true
  }

  async purgeNotificationRecords(beforeMs: number, limit: number): Promise<number> {
    let removed = 0
    for (let index = this.records.length - 1; index >= 0 && removed < limit; index -= 1) {
      if (this.records[index]!.createdAtMs < beforeMs) {
        this.records.splice(index, 1)
        removed += 1
      }
    }
    return removed
  }

  private row(id: number, workerId: string): TaskRow | undefined {
    return this.tasks.find(task => task.id === id && task.claimedBy === workerId && task.status === 'sending')
  }

  private record(row: TaskRow, status: string, providerMessageId: string | undefined, errorCode: string | undefined, nowMs: number): void {
    const existing = this.records.find(item => item.tenantId === row.tenantId
      && item.notificationId === row.notificationId && item.channel === row.channel)
    const value: RecordRow = {
      tenantId: row.tenantId,
      notificationId: row.notificationId,
      channel: row.channel,
      status,
      createdAtMs: nowMs,
      ...(providerMessageId === undefined ? {} : { providerMessageId }),
      ...(errorCode === undefined ? {} : { errorCode }),
    }
    if (existing === undefined) this.records.push(value)
    else Object.assign(existing, value)
  }
}

function severityRank(severity: TaskRow['severity']): number {
  if (severity === 'critical') return 2
  if (severity === 'warning') return 1
  return 0
}
