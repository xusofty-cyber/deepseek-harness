/**
 * Durable Outbox operations. Claiming uses a transaction-owned
 * `FOR UPDATE SKIP LOCKED` read and a 60-second lease; delivery is
 * at-least-once and the public notification id is the client dedupe key.
 * @module @deepseek-ai/dsh-nilm-notify/store
 */

import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import { retryDelayMs, shouldDeadLetter, type DeliveryFailure, type DeliveryResult, type OutboxStatus, type OutboxTask } from './model.ts'

/** Project database surface used by the dispatcher. */
export interface ProjectDatabase {
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

/** Persisted asynchronous diagnosis. */
export interface DiagnosisResult {
  /** Diagnosis text. */
  text: string
  /** Producing model. */
  model: string
  /** Prompt version. */
  promptVersion: string
}

/** Outcome of a failed delivery attempt. */
export interface FailureOutcome {
  /** Final persisted state. */
  status: Extract<OutboxStatus, 'failed' | 'dead'>
  /** Attempt number including this failure. */
  attemptCount: number
  /** Next eligible instant, absent for a dead row. */
  nextRetryAtMs?: number
}

/** Outbox persistence seam. */
export interface OutboxStore {
  /**
   * @param workerId - lease owner.
   * @param nowMs - claim instant.
   * @param limit - maximum rows.
   * @param leaseMs - lease duration.
   * @returns claimed tasks with attempt numbers already incremented.
   */
  claim(workerId: string, nowMs: number, limit: number, leaseMs: number): Promise<OutboxTask[]>
  /**
   * @param task - claimed task.
   * @param workerId - lease owner.
   * @param result - provider result.
   * @param nowMs - completion instant.
   */
  markSent(task: OutboxTask, workerId: string, result: DeliveryResult, nowMs: number): Promise<void>
  /**
   * @param task - claimed task.
   * @param workerId - lease owner.
   * @param failure - channel classification.
   * @param nowMs - failure instant.
   * @returns the persisted outcome.
   */
  markFailed(task: OutboxTask, workerId: string, failure: DeliveryFailure, nowMs: number): Promise<FailureOutcome>
  /**
   * Fill a diagnosis only while the event is still active and has no diagnosis.
   * @param tenantId - tenant boundary.
   * @param eventId - alert event.
   * @param diagnosis - diagnosis result.
   * @param nowMs - generation instant.
   * @returns true when the row was updated; false when a late result was dropped.
   */
  applyDiagnosis(tenantId: string, eventId: string, diagnosis: DiagnosisResult, nowMs: number): Promise<boolean>
  /**
   * Delete delivery records older than the retention cutoff.
   * @param beforeMs - exclusive cutoff.
   * @param limit - maximum deleted rows.
   * @returns deleted row count.
   */
  purgeNotificationRecords(beforeMs: number, limit: number): Promise<number>
}

/** MySQL-backed Outbox store. */
export class MysqlOutboxStore implements OutboxStore {
  /**
   * @param database - lazily resolved project database service.
   */
  constructor(private readonly database: () => ProjectDatabase) {}

  /** @param workerId - lease owner. @param nowMs - claim instant. @param limit - batch size. @param leaseMs - lease duration. @returns claimed tasks. */
  async claim(workerId: string, nowMs: number, limit: number, leaseMs: number): Promise<OutboxTask[]> {
    const capped = Math.max(1, Math.min(limit, 200))
    return this.database().transaction(async tx => {
      const rows = await tx.query<{
        id: number
        notificationId: string
        tenantId: string
        userRef: string | null
        eventId: string | null
        reportId: string | null
        channel: NotificationChannel
        templateId: string | null
        recipientCiphertext: Uint8Array | null
        recipientMasked: string | null
        payloadJson: string
        dedupeKey: string
        attemptCount: number
        maxAttempts: number
        severity: OutboxTask['severity'] | null | undefined
      }>(
        `SELECT o.id, o.notification_id AS notificationId, o.tenant_id AS tenantId,
                o.user_ref AS userRef, o.event_id AS eventId, o.report_id AS reportId, o.channel,
                o.template_id AS templateId, o.recipient_ciphertext AS recipientCiphertext,
                o.recipient_masked AS recipientMasked, o.payload_json AS payloadJson,
                o.dedupe_key AS dedupeKey, o.attempt_count AS attemptCount,
                o.max_attempts AS maxAttempts,
                e.severity
           FROM nilm_notification_outbox o
           LEFT JOIN nilm_alert_event e
             ON e.tenant_id = o.tenant_id AND e.event_id = o.event_id
          WHERE o.next_retry_at <= ?
            AND (
              o.status IN ('pending', 'failed')
              OR (o.status = 'sending' AND (o.lease_expires_at IS NULL OR o.lease_expires_at < ?))
            )
          ORDER BY CASE WHEN e.severity = 'critical' THEN 0 ELSE 1 END,
                   o.next_retry_at ASC, o.id ASC
          LIMIT ${String(capped)}
          FOR UPDATE SKIP LOCKED`,
        [new Date(nowMs), new Date(nowMs)],
      )
      const tasks: OutboxTask[] = []
      for (const row of rows) {
        const attemptCount = Number(row.attemptCount) + 1
        const affected = await tx.affected(
          `UPDATE nilm_notification_outbox
              SET status = 'sending', claimed_by = ?, lease_expires_at = ?, attempt_count = ?
            WHERE id = ?`,
          [workerId, new Date(nowMs + leaseMs), attemptCount, row.id],
        )
        if (affected === 0) continue
        tasks.push({
          id: Number(row.id),
          notificationId: row.notificationId,
          tenantId: row.tenantId,
          userRef: row.userRef,
          eventId: row.eventId,
          reportId: row.reportId,
          channel: row.channel,
          templateId: row.templateId,
          recipientCiphertext: toBytes(row.recipientCiphertext),
          recipientMasked: row.recipientMasked,
          payloadJson: row.payloadJson,
          dedupeKey: row.dedupeKey,
          attemptCount,
          maxAttempts: Number(row.maxAttempts),
          claimedBy: workerId,
          ...(row.severity === null || row.severity === undefined ? {} : { severity: row.severity }),
        })
      }
      return tasks
    })
  }

  /** @param task - claimed task. @param workerId - lease owner. @param result - provider result. @param nowMs - completion instant. */
  async markSent(task: OutboxTask, workerId: string, result: DeliveryResult, nowMs: number): Promise<void> {
    await this.database().transaction(async tx => {
      const affected = await tx.affected(
        `UPDATE nilm_notification_outbox
            SET status = 'sent', provider_message_id = ?, sent_at = ?, last_error = NULL,
                lease_expires_at = NULL, claimed_by = NULL
          WHERE id = ? AND status = 'sending' AND claimed_by = ?`,
        [result.providerMessageId ?? null, new Date(nowMs), task.id, workerId],
      )
      if (affected === 0) return
      await upsertRecord(tx, task, 'sent', result.providerMessageId ?? null, null, nowMs)
      if (task.reportId !== null) {
        await tx.affected(
          `UPDATE nilm_report
              SET status = 'delivered', delivered_at = ?
            WHERE tenant_id = ? AND report_id = ? AND delivered_at IS NULL`,
          [new Date(nowMs), task.tenantId, task.reportId],
        )
      }
      if (task.eventId === null) return
      const event = await tx.query<{ status: string }>(
        `SELECT status FROM nilm_alert_event
          WHERE tenant_id = ? AND event_id = ? FOR UPDATE`,
        [task.tenantId, task.eventId],
      )
      const from = event[0]?.status
      if (from !== 'detected' && from !== 'confirmed') return
      await tx.affected(
        `UPDATE nilm_alert_event
            SET status = 'notified'
          WHERE tenant_id = ? AND event_id = ? AND status IN ('detected', 'confirmed')`,
        [task.tenantId, task.eventId],
      )
      await tx.query(
        `INSERT INTO nilm_alert_transition
          (event_id, from_status, to_status, operator_type, reason, channel, created_at)
         VALUES (?, ?, 'notified', 'notifier', 'at-least-one-channel-sent', ?, ?)`,
        [task.eventId, from, task.channel, new Date(nowMs)],
      )
    })
  }

  /** @param task - claimed task. @param workerId - lease owner. @param failure - classification. @param nowMs - failure instant. @returns persisted outcome. */
  async markFailed(task: OutboxTask, workerId: string, failure: DeliveryFailure, nowMs: number): Promise<FailureOutcome> {
    const dead = shouldDeadLetter(task.attemptCount, task.maxAttempts, failure.retryable)
    const status: FailureOutcome['status'] = dead ? 'dead' : 'failed'
    const nextRetryAtMs = dead ? undefined : nowMs + retryDelayMs(task.attemptCount)
    await this.database().transaction(async tx => {
      const affected = await tx.affected(
        `UPDATE nilm_notification_outbox
            SET status = ?, next_retry_at = ?, last_error = ?, lease_expires_at = NULL, claimed_by = NULL
          WHERE id = ? AND status = 'sending' AND claimed_by = ?`,
        [status, new Date(nextRetryAtMs ?? nowMs), failure.code, task.id, workerId],
      )
      if (affected === 0) return
      await upsertRecord(tx, task, status, null, failure.code, nowMs)
    })
    return { status, attemptCount: task.attemptCount, ...(nextRetryAtMs === undefined ? {} : { nextRetryAtMs }) }
  }

  /** @param tenantId - tenant boundary. @param eventId - alert event. @param diagnosis - diagnosis result. @param nowMs - generation instant. @returns true when written; false for a late or inapplicable result. */
  async applyDiagnosis(
    tenantId: string,
    eventId: string,
    diagnosis: DiagnosisResult,
    nowMs: number,
  ): Promise<boolean> {
    const affected = await this.database().transaction(async tx => tx.affected(
      `UPDATE nilm_alert_event
          SET agent_diagnosis = ?, agent_model = ?, agent_prompt_version = ?, agent_generated_at = ?
        WHERE tenant_id = ? AND event_id = ?
          AND agent_diagnosis IS NULL
          AND status IN ('detected', 'confirmed', 'notified')`,
      [diagnosis.text, diagnosis.model, diagnosis.promptVersion, new Date(nowMs), tenantId, eventId],
    ))
    return affected > 0
  }

  /** @param beforeMs - exclusive cutoff. @param limit - maximum deleted rows. @returns deleted row count. */
  async purgeNotificationRecords(beforeMs: number, limit: number): Promise<number> {
    return this.database().transaction(async tx => tx.affected(
      `DELETE FROM nilm_notification_record WHERE created_at < ? ORDER BY id LIMIT ${String(Math.max(1, Math.min(limit, 10_000)))}`,
      [new Date(beforeMs)],
    ))
  }
}

/**
 * Insert or update one channel delivery record.
 * @param tx - active transaction.
 * @param task - claimed task.
 * @param status - persisted state.
 * @param providerMessageId - provider id.
 * @param errorCode - stable error code.
 * @param nowMs - record instant.
 */
async function upsertRecord(
  tx: SqlTransaction,
  task: OutboxTask,
  status: OutboxStatus,
  providerMessageId: string | null,
  errorCode: string | null,
  nowMs: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO nilm_notification_record
      (notification_id, tenant_id, user_ref, channel, recipient_masked, event_id, status,
       provider_message_id, error_code, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status = VALUES(status),
       recipient_masked = VALUES(recipient_masked),
       provider_message_id = VALUES(provider_message_id),
       error_code = VALUES(error_code),
       sent_at = VALUES(sent_at)`,
    [
      task.notificationId, task.tenantId, task.userRef, task.channel, task.recipientMasked,
      task.eventId, status, providerMessageId, errorCode,
      status === 'sent' ? new Date(nowMs) : null, new Date(nowMs),
    ],
  )
}

/**
 * Normalize a mysql2 binary column to bytes.
 * @param value - driver value.
 * @returns bytes or null.
 */
function toBytes(value: Uint8Array | Buffer | null): Uint8Array | null {
  if (value === null) return null
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}
