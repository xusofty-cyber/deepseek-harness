/**
 * Per-turn SSE event buffer with monotonic ids and disconnect replay.
 * @module @deepseek-ai/dsh-nilm-service/events
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Event names in the stage-1 BFF stream. */
export type SseEventType =
  | 'status'
  | 'text.delta'
  | 'text.done'
  | 'tool.start'
  | 'tool.result'
  | 'chart'
  | 'alert'
  | 'clarify'
  | 'error'
  | 'done'

/** One durable-in-process SSE event. */
export interface SseEvent {
  readonly id: number
  readonly event: SseEventType
  readonly data: JsonValue
}

/** Internal safety bound for one turn's replay buffer. */
const MAX_BUFFERED_EVENTS = 20_000

/** Buffered event channel for one turn. */
export class TurnEventBuffer {
  private readonly events: SseEvent[] = []
  private readonly waiters = new Set<() => void>()
  private nextId = 1
  private closed = false
  private overflowed = false

  /**
   * @param turnId - turn identity included in overflow diagnostics.
   * @param sessionId - session identity included in the terminal event.
   */
  constructor(private readonly turnId: string, private readonly sessionId: string) {}

  /** Last event id currently buffered, or 0 before the first event. */
  get lastEventId(): number {
    return this.nextId - 1
  }

  /** Whether the terminal event has been appended. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Append one event and wake every waiting stream.
   * @param event - SSE event name.
   * @param data - lossless JSON payload.
   * @returns the appended event, or undefined after the buffer overflowed.
   */
  append(event: SseEventType, data: JsonValue): SseEvent | undefined {
    if (this.closed || this.overflowed) return undefined
    if (this.events.length >= MAX_BUFFERED_EVENTS) {
      this.overflowed = true
      const error = this.push('error', {
        turnId: this.turnId,
        code: 'QUERY_LIMIT_EXCEEDED',
        message: 'turn produced too many streaming events; reconnect for the durable answer',
        retryable: false,
      })
      const doneId = this.nextId
      this.push('done', {
        turnId: this.turnId,
        sessionId: this.sessionId,
        lastEventId: String(doneId),
      })
      this.closed = true
      this.notify()
      return error
    }
    const appended = this.push(event, data)
    this.notify()
    return appended
  }

  /** Append the terminal `done` event and close the channel. */
  finish(): void {
    if (this.closed) return
    const doneId = this.nextId
    this.push('done', {
      turnId: this.turnId,
      sessionId: this.sessionId,
      lastEventId: String(doneId),
    })
    this.closed = true
    this.notify()
  }

  /**
   * List buffered events newer than one client checkpoint.
   * @param lastEventId - last event id already delivered to the client.
   * @returns events with a greater id.
   */
  eventsSince(lastEventId: number): SseEvent[] {
    return this.events.filter(event => event.id > lastEventId)
  }

  /**
   * Resolve on the next append, close, or explicit wake.
   * @returns a promise settled when buffer state changes.
   */
  waitForChange(): Promise<void> {
    return new Promise(resolve => { this.waiters.add(resolve) })
  }

  /** Wake one waiter for a keepalive or cancellation check. */
  wake(): void {
    this.notify()
  }

  private push(event: SseEventType, data: JsonValue): SseEvent {
    const appended: SseEvent = { id: this.nextId++, event, data }
    this.events.push(appended)
    return appended
  }

  private notify(): void {
    for (const resolve of this.waiters) resolve()
    this.waiters.clear()
  }
}
