/**
 * In-process BFF used by `--self-check`. It exercises the real HTTP, signing,
 * SSE, and persistence seams with a deterministic synthetic agent; it does not
 * touch a model, database, or Kubernetes target.
 *
 * @module @deepseek-ai/dsh-nilm-service/perf/loopback
 */

import { randomBytes } from 'node:crypto'
import type { CallContext } from '@deepseek-ai/dsh-nilm-core'
import { resolveConfig } from '../../src/config.ts'
import { MemoryConversationStore } from '../../src/conversations.ts'
import { NilmHttpService } from '../../src/http.ts'
import type {
  ChatMessage,
  NilmAgentEvent,
  NilmAgentRuntime,
  NilmAgentSession,
  TurnMode,
} from '../../src/runtime.ts'

/** Running loopback target and its per-tenant secrets. */
export interface LoopbackTarget {
  readonly url: string
  readonly secrets: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
}

/**
 * Start the real BFF against an in-memory conversation store and a synthetic
 * agent that answers simple prompts or emits one analysis Tool call.
 * @param tenantIds - tenant ids the self-check will authenticate.
 * @returns the bound URL, matching secrets, and a close function.
 */
export async function startLoopback(tenantIds: readonly string[]): Promise<LoopbackTarget> {
  const secrets: Record<string, string> = {}
  for (const tenantId of tenantIds) secrets[tenantId] = randomBytes(24).toString('hex')
  const config = resolveConfig({
    host: '127.0.0.1',
    port: 0,
    model: 'synthetic-load-model',
    signingSecrets: secrets,
    turnTimeoutMs: 10_000,
    pingIntervalMs: 500,
    // The self-check drives many short turns per caller; it must not trip the
    // production per-user or tenant concurrency limits under test.
    rateLimitPerUserPerMinute: 10_000,
    rateLimitTenantConcurrency: 1_000,
  })
  const service = new NilmHttpService({
    config,
    runtime: new SyntheticRuntime(),
    conversations: new MemoryConversationStore(),
    shard: { index: 0, count: 1 },
  })
  const address = await service.start()
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    secrets,
    close: () => service.close(),
  }
}

/** Deterministic runtime that honours cancel and emits real BFF event shapes. */
class SyntheticRuntime implements NilmAgentRuntime {
  private readonly sessions = new Map<string, SyntheticSession>()

  /** @inheritDoc */
  async open(sessionId: string, _callContext: CallContext, _mode: TurnMode): Promise<NilmAgentSession> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const session = new SyntheticSession(sessionId)
    this.sessions.set(sessionId, session)
    return session
  }

  /** @inheritDoc */
  async history(sessionId: string, _callContext: CallContext, _mode: TurnMode): Promise<readonly ChatMessage[] | undefined> {
    return this.sessions.get(sessionId)?.messages()
  }

  /** @inheritDoc */
  async release(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }
}

class SyntheticSession implements NilmAgentSession {
  private readonly listeners = new Set<(event: NilmAgentEvent) => void>()
  private readonly history: ChatMessage[] = []
  private readonly timers = new Set<NodeJS.Timeout>()
  private turn = 0

  constructor(readonly sessionId: string) {}

  send(text: string): void {
    this.turn += 1
    const turn = this.turn
    this.history.push({ id: `u${String(turn)}`, role: 'user', text })
    this.emit({ type: 'status', status: 'running' })
    const tool = /波形|隐患|分析/u.test(text)
    if (tool) {
      this.at(2, () => { this.emit({ type: 'tool-start', callId: `c${String(turn)}`, tool: 'nilm_timeseries_analyze', title: '时序特征分析' }) })
      this.at(4, () => {
        this.emit({
          type: 'tool-result',
          callId: `c${String(turn)}`,
          tool: 'nilm_timeseries_analyze',
          status: 'completed',
          summary: '检出 1 次启停冲击',
          warnings: [],
        })
      })
    }
    const chunks = tool ? ['检出', '一次', '启停', '冲击', '。'] : ['今日', '用电', '平稳', '。']
    const reply = chunks.join('')
    let delay = tool ? 6 : 3
    for (const chunk of chunks) {
      this.at(delay, () => { this.emit({ type: 'delta', text: chunk }) })
      delay += 2
    }
    this.at(delay, () => {
      this.history.push({ id: `a${String(turn)}`, role: 'assistant', text: reply })
      this.emit({ type: 'message', text: reply })
      this.emit({ type: 'turn-end', reason: 'completed' })
    })
  }

  cancel(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.emit({ type: 'turn-end', reason: 'aborted' })
  }

  messages(): readonly ChatMessage[] {
    return [...this.history]
  }

  subscribe(listener: (event: NilmAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(event: NilmAgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private at(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      action()
    }, delayMs)
    this.timers.add(timer)
  }
}
