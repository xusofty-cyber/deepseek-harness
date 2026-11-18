/**
 * One-shot Cordis agent session used for asynchronous alert explanation. The
 * session is durable and short-lived; the agent never changes alert severity
 * or delivery state.
 * @module @deepseek-ai/dsh-nilm-notify/diagnosis
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { CallContext, SessionId, TenantId } from '@deepseek-ai/dsh-nilm-core'
import type { AlertCreatedPayload } from '@deepseek-ai/dsh-nilm-sentinel'
import type {} from '@deepseek-ai/dsh-nilm-context'
import type { DiagnosisAgent } from './enrich.ts'
import type { DiagnosisResult } from './store.ts'

/** Agent configuration for enrichment. */
export interface DiagnosisConfig {
  /** Registered LLM provider route. */
  provider: string
  /** Model id. */
  model: string
  /** Prompt version recorded with the result. */
  promptVersion: string
  /** Session working directory. */
  cwd?: string
}

/** Cordis agent adapter implementing {@link DiagnosisAgent}. */
export class CordisDiagnosisAgent implements DiagnosisAgent {
  /**
   * @param ctx - lazily resolved owning context.
   * @param config - provider, model, prompt version, and session cwd.
   */
  constructor(
    private readonly ctx: () => Context,
    private readonly config: DiagnosisConfig,
  ) {}

  /**
   * @param alert - committed alert facts.
   * @param signal - abort signal fired at the eight-second hard timeout.
   * @returns the model explanation.
   */
  async diagnose(alert: AlertCreatedPayload, signal: AbortSignal): Promise<DiagnosisResult> {
    const ctx = this.ctx()
    const sessionId = brandString<SessionId>(`alert-enrich-${randomUUID()}`)
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: this.config.cwd ?? process.cwd() },
      agentOptions: { provider: this.config.provider, model: this.config.model },
      signal,
    })
    const unbind = this.bind(handle, alert)
    try {
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: promptFor(alert) }],
      }))
      await waitForIdle(handle, signal)
      if (signal.aborted) throw new Error('enrichment aborted at the hard timeout')
      const text = lastAssistantText(handle.agent.session.deriveMessages())
      if (text.trim() === '') throw new Error('enrichment produced no assistant text')
      return {
        text: text.slice(0, 4_000),
        model: this.config.model,
        promptVersion: this.config.promptVersion,
      }
    } finally {
      unbind()
      await handle.dispose()
    }
  }

  private bind(handle: AgentHandle, alert: AlertCreatedPayload): () => void {
    const context = this.ctx()
    const bind = context.nilmContext?.bind
    if (bind === undefined) return () => undefined
    return bind.call(context.nilmContext, handle.agent.id, callContext(alert))
  }
}

/**
 * Build the caller context used by the enrichment session. It is explicitly a
 * system workload, not a customer user, but remains inside one tenant.
 * @param alert - committed alert facts.
 * @returns the immutable call context.
 */
function callContext(alert: AlertCreatedPayload): CallContext {
  return {
    tenantId: brandString<TenantId>(alert.tenantId),
    userRef: 'system:alert-enrichment',
    requestId: `enrich:${alert.eventId}`,
    sessionId: brandString<SessionId>(`enrich:${alert.eventId}`),
  }
}

/**
 * Build the deterministic enrichment prompt.
 * @param alert - committed alert facts.
 * @returns bounded prompt text containing only this alert's facts.
 */
function promptFor(alert: AlertCreatedPayload): string {
  const facts = {
    ruleId: alert.ruleId,
    severity: alert.severity,
    scope: alert.scope,
    metric: alert.metric,
    value: alert.value,
    threshold: alert.threshold,
    unit: alert.unit,
    occurredAt: new Date(alert.occurredAtMs).toISOString(),
    deterministicSummary: alert.summaryText,
    facts: alert.facts,
  }
  return [
    '你是工业企业用电安全研判助手。只根据下面这一条已确认的告警事实，给出简明、可执行的成因分析与排查建议。',
    '要求：不得修改告警级别，不得建议关闭告警，不得调用任何工具，不得推断其他租户数据；控制在 180 字以内。',
    JSON.stringify(facts),
  ].join('\n')
}

/**
 * Wait for the agent to become idle or for the caller timeout.
 * @param handle - live agent handle.
 * @param signal - caller abort signal.
 */
async function waitForIdle(handle: AgentHandle, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    handle.agent.cancel({ kind: 'user' })
    throw new Error('enrichment aborted before the turn started')
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      handle.agent.cancel({ kind: 'user' })
      reject(new Error('enrichment aborted at the hard timeout'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([handle.agent.whenIdle(), aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Take the latest assistant text from the durable session projection.
 * @param messages - derived session messages.
 * @returns text, or an empty string when no assistant text exists.
 */
function lastAssistantText(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('')
    if (text !== '') return text
  }
  return ''
}
