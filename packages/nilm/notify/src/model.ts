/**
 * Outbox state vocabulary and the explicit retry schedule.
 * @module @deepseek-ai/dsh-nilm-notify/model
 */

import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'

/** Persisted Outbox state. */
export type OutboxStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead'

/** Retry delays after the first, second, third, and fourth failures. */
export const RETRY_DELAYS_MS: readonly number[] = [60_000, 300_000, 900_000, 3_600_000]

/** One claimed Outbox row. */
export interface OutboxTask {
  /** Database row identifier. */
  id: number
  /** Public notification identifier shared by channels. */
  notificationId: string
  /** Tenant boundary. */
  tenantId: string
  /** Receiving caller-side user reference. */
  userRef: string | null
  /** Connected alert event, when present. */
  eventId: string | null
  /** Delivery channel. */
  channel: NotificationChannel
  /** Provider template. */
  templateId: string | null
  /** Encrypted recipient material for the provider gateway. */
  recipientCiphertext: Uint8Array | null
  /** Masked recipient hint. */
  recipientMasked: string | null
  /** Deterministic template parameters. */
  payloadJson: string
  /** Per-channel idempotency key. */
  dedupeKey: string
  /** Attempt number including the current claim. */
  attemptCount: number
  /** Attempt ceiling. */
  maxAttempts: number
  /** Worker that currently owns the lease. */
  claimedBy: string
  /** Alert severity when the channel row joins an alert event. */
  severity?: 'info' | 'warning' | 'critical'
}

/** Channel delivery result. */
export interface DeliveryResult {
  /** Provider message identifier when the gateway returns one. */
  providerMessageId?: string
}

/** Failure classification returned by a channel adapter. */
export interface DeliveryFailure {
  /** Stable machine-readable failure code. */
  code: string
  /** False for authorization, template, or permanent recipient failures. */
  retryable: boolean
  /** Optional diagnostic detail without secrets or plaintext recipients. */
  detail?: string
}

/**
 * Compute the delay after a failed attempt.
 * @param attempt - attempt number including the failed attempt, starting at 1.
 * @returns the delay in milliseconds; the final delay repeats after the table ends.
 */
export function retryDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error('attempt must be a positive integer')
  return RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!
}

/**
 * Decide whether a claimed task becomes dead instead of retrying.
 * @param attempt - attempt number including the current claim.
 * @param maxAttempts - attempt ceiling.
 * @param retryable - whether the channel classified the failure as transient.
 * @returns true when the task must be dead-lettered.
 */
export function shouldDeadLetter(attempt: number, maxAttempts: number, retryable: boolean): boolean {
  return !retryable || attempt >= maxAttempts
}

/**
 * Build a stable channel timeout signal.
 * @param timeoutMs - maximum send duration.
 * @param parent - worker cancellation signal.
 * @returns a signal aborted by either source.
 */
export function timeoutSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (parent === undefined) return timeout
  if (parent.aborted) return parent
  return AbortSignal.any([parent, timeout])
}
