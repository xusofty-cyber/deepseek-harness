/**
 * Asynchronous alert enrichment. Enrichment is bounded by a hard timeout and
 * never participates in alert delivery; a late model result is dropped.
 * @module @deepseek-ai/dsh-nilm-notify/enrich
 */

import type { AlertCreatedPayload } from '@deepseek-ai/dsh-nilm-sentinel'
import type { DiagnosisResult, OutboxStore } from './store.ts'

/** Agent seam implemented by the Cordis one-shot agent session. */
export interface DiagnosisAgent {
  /**
   * @param alert - committed deterministic alert facts.
   * @param signal - abort signal fired at the hard timeout or shutdown.
   * @returns the model-authored explanation.
   */
  diagnose(alert: AlertCreatedPayload, signal: AbortSignal): Promise<DiagnosisResult>
}

/** Logger seam used for dropped or failed enrichments. */
export interface EnrichLogger {
  /**
   * @param message - bounded operational message without alert PII.
   */
  warn(message: string): void
}

/** Worker configuration. */
export interface EnrichmentOptions {
  /** Persistence used for the conditional write. */
  store: Pick<OutboxStore, 'applyDiagnosis'>
  /** Agent adapter. */
  agent: DiagnosisAgent
  /** Hard timeout; the design contract fixes eight seconds by default. */
  timeoutMs?: number
  /** Concurrent enrichments. */
  concurrency?: number
  /** Maximum queued alerts before the oldest is dropped. */
  queueLimit?: number
  /** Injectable clock. */
  now?: () => number
  /** Optional warning sink. */
  logger?: EnrichLogger
}

/** Result of one enrichment attempt. */
export type EnrichOutcome = 'applied' | 'dropped-late' | 'timeout' | 'failed'

/** Bounded asynchronous enrichment queue. */
export class EnrichmentWorker {
  private readonly store: Pick<OutboxStore, 'applyDiagnosis'>
  private readonly agent: DiagnosisAgent
  private readonly timeoutMs: number
  private readonly concurrency: number
  private readonly queueLimit: number
  private readonly now: () => number
  private readonly logger: EnrichLogger | undefined
  private readonly queue: AlertCreatedPayload[] = []
  private readonly seen = new Set<string>()
  private active = 0
  private idleWaiters: Array<() => void> = []

  /**
   * @param options - store, agent, and queue policy.
   */
  constructor(options: EnrichmentOptions) {
    this.store = options.store
    this.agent = options.agent
    this.timeoutMs = options.timeoutMs ?? 8_000
    this.concurrency = options.concurrency ?? 2
    this.queueLimit = options.queueLimit ?? 200
    this.now = options.now ?? (() => Date.now())
    this.logger = options.logger
  }

  /**
   * Queue one committed alert. Returns immediately; enrichment never blocks
   * notification delivery or the scanner transaction.
   * @param alert - committed alert facts.
   */
  enqueue(alert: AlertCreatedPayload): void {
    if (this.seen.has(alert.eventId)) return
    this.seen.add(alert.eventId)
    if (this.queue.length >= this.queueLimit) {
      const dropped = this.queue.shift()
      if (dropped !== undefined) {
        this.seen.delete(dropped.eventId)
        this.warn(`alert enrichment queue overflow; dropped ${dropped.eventId}`)
      }
    }
    this.queue.push(alert)
    this.drain()
  }

  /**
   * Run one enrichment immediately, preserving the hard timeout.
   * @param alert - committed alert facts.
   * @returns the outcome.
   */
  async run(alert: AlertCreatedPayload): Promise<EnrichOutcome> {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.timeoutMs)
    timer.unref()
    try {
      const diagnosis = await Promise.race([
        this.agent.diagnose(alert, controller.signal),
        timeoutAfter(this.timeoutMs),
      ])
      if (expired || diagnosis === undefined) {
        this.warn(`alert enrichment timed out for ${alert.eventId}; deterministic template retained`)
        return 'timeout'
      }
      if (controller.signal.aborted) return 'dropped-late'
      const applied = await this.store.applyDiagnosis(alert.tenantId, alert.eventId, diagnosis, this.now())
      return applied ? 'applied' : 'dropped-late'
    } catch (error) {
      if (expired || controller.signal.aborted) return 'timeout'
      this.warn(`alert enrichment failed for ${alert.eventId}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown failure'}`)
      return 'failed'
    } finally {
      clearTimeout(timer)
    }
  }

  /** @returns a promise resolved after the queue and all active workers are empty. */
  async waitForIdle(): Promise<void> {
    if (this.active === 0 && this.queue.length === 0) return
    await new Promise<void>(resolve => {
      this.idleWaiters.push(resolve)
    })
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const alert = this.queue.shift()!
      this.active += 1
      void this.run(alert).finally(() => {
        this.active -= 1
        this.seen.delete(alert.eventId)
        if (this.active === 0 && this.queue.length === 0) {
          const waiters = this.idleWaiters.splice(0)
          for (const resolve of waiters) resolve()
        } else {
          this.drain()
        }
      })
    }
  }

  private warn(message: string): void {
    this.logger?.warn(message)
  }
}

/**
 * Resolve after the timeout without retaining a timer.
 * @param timeoutMs - delay.
 * @returns a promise resolving to `undefined` after the delay.
 */
function timeoutAfter(timeoutMs: number): Promise<undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    timer.unref()
  })
}
