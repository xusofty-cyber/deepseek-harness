/**
 * Outbox dispatcher: leases tasks, sends through one channel adapter, and
 * persists success, retry, or dead-letter outcomes.
 * @module @deepseek-ai/dsh-nilm-notify/dispatcher
 */

import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import { DeliveryFailureError, type ChannelTransport } from './channels.ts'
import type { DeliveryFailure } from './model.ts'
import type { OutboxStore } from './store.ts'

/** Logger surface used for dead letters and dropped enrichments. */
export interface DispatcherLogger {
  /**
   * @param message - bounded operational message without secrets.
   */
  warn(message: string): void
}

/** Dispatcher configuration. */
export interface DispatcherOptions {
  /** Persistence. */
  store: OutboxStore
  /** One transport per fixed channel. */
  transports: ReadonlyMap<NotificationChannel, ChannelTransport>
  /** Stable worker identity used by leases. */
  workerId: string
  /** Rows claimed per tick. */
  batchSize?: number
  /** Lease duration. */
  leaseMs?: number
  /** Poll interval. */
  pollIntervalMs?: number
  /** Per-channel send timeout. */
  sendTimeoutMs?: number
  /** Delivery-record retention. */
  retentionDays?: number
  /** Injectable clock. */
  now?: () => number
  /** Optional warning sink. */
  logger?: DispatcherLogger
}

const DAY_MS = 86_400_000

/** At-least-once Outbox dispatcher. */
export class NotificationDispatcher {
  private readonly store: OutboxStore
  private readonly transports: ReadonlyMap<NotificationChannel, ChannelTransport>
  private readonly workerId: string
  private readonly batchSize: number
  private readonly leaseMs: number
  private readonly pollIntervalMs: number
  private readonly sendTimeoutMs: number
  private readonly retentionDays: number
  private readonly now: () => number
  private readonly logger: DispatcherLogger | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false
  private lastPurgeAtMs = 0

  /**
   * @param options - store, transports, and scheduling policy.
   */
  constructor(options: DispatcherOptions) {
    this.store = options.store
    this.transports = options.transports
    this.workerId = options.workerId
    this.batchSize = options.batchSize ?? 20
    this.leaseMs = options.leaseMs ?? 60_000
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000
    this.sendTimeoutMs = options.sendTimeoutMs ?? 10_000
    this.retentionDays = options.retentionDays ?? 180
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  /** Start polling; the first tick runs immediately. */
  start(): void {
    if (this.timer !== undefined) return
    const tick = (): void => {
      if (this.running) return
      this.running = true
      void this.tick()
        .catch((error: unknown) => { this.warn(`notification tick failed: ${messageOf(error)}`) })
        .finally(() => { this.running = false })
    }
    this.timer = setInterval(tick, this.pollIntervalMs)
    this.timer.unref()
    tick()
  }

  /** Stop polling. In-flight sends finish. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Claim and deliver one batch.
   * @returns counts by final outcome for this tick.
   */
  async tick(): Promise<{ claimed: number; sent: number; failed: number; dead: number }> {
    const nowMs = this.now()
    await this.purgeIfDue(nowMs)
    const tasks = await this.store.claim(this.workerId, nowMs, this.batchSize, this.leaseMs)
    let sent = 0
    let failed = 0
    let dead = 0
    await Promise.all(tasks.map(async task => {
      const transport = this.transports.get(task.channel)
      if (transport === undefined) {
        await this.store.markFailed(task, this.workerId, {
          code: 'channel_not_configured',
          retryable: false,
        }, nowMs)
        dead += 1
        return
      }
      try {
        const result = await transport.send(task, AbortSignal.timeout(this.sendTimeoutMs))
        await this.store.markSent(task, this.workerId, result, this.now())
        sent += 1
      } catch (error) {
        const failure = failureOf(error)
        const outcome = await this.store.markFailed(task, this.workerId, failure, this.now())
        if (outcome.status === 'dead') {
          dead += 1
          this.warn(`notification ${task.notificationId} dead-lettered on ${task.channel}: ${failure.code}`)
        } else {
          failed += 1
        }
      }
    }))
    return { claimed: tasks.length, sent, failed, dead }
  }

  private async purgeIfDue(nowMs: number): Promise<void> {
    if (this.retentionDays <= 0) return
    if (nowMs - this.lastPurgeAtMs < DAY_MS) return
    this.lastPurgeAtMs = nowMs
    try {
      await this.store.purgeNotificationRecords(nowMs - this.retentionDays * DAY_MS, 5_000)
    } catch (error) {
      this.warn(`notification retention purge failed: ${messageOf(error)}`)
    }
  }

  private warn(message: string): void {
    this.logger?.warn(message)
  }
}

/**
 * Normalize a channel error into a delivery classification.
 * @param error - thrown failure.
 * @returns stable code and retryability.
 */
export function failureOf(error: unknown): DeliveryFailure {
  if (error instanceof DeliveryFailureError) return error.failure
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return { code: 'channel_timeout', retryable: true, detail: 'channel send timed out' }
  }
  return { code: 'channel_unavailable', retryable: true, detail: messageOf(error) }
}

/**
 * Read an error message without exposing an object dump.
 * @param error - unknown failure.
 * @returns bounded text.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown failure'
}
