/**
 * Report summary authorship. The model receives only the deterministic payload
 * and returns prose; report numbers remain the persisted payload.
 * @module @deepseek-ai/dsh-nilm-scheduler/summary-agent
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type Message } from '@deepseek-ai/dsh-llm'
import type { CallContext, SessionId, TenantId } from '@deepseek-ai/dsh-nilm-core'
import type {} from '@deepseek-ai/dsh-nilm-context'

/** Material passed to a report summary writer. */
export interface ReportSummaryInput {
  /** Tenant boundary. */
  tenantId: string
  /** Report family. */
  reportType: 'morning_report' | 'pf_forecast'
  /** Business date. */
  reportDate: string
  /** Deterministic structured payload. */
  payload: unknown
  /** Deterministic summary retained when model authorship fails. */
  fallback: string
}

/** Summary authorship seam. */
export interface ReportSummaryWriter {
  /**
   * @param input - deterministic report facts.
   * @param signal - abort signal fired at the configured hard timeout.
   * @returns bounded summary text.
   */
  write(input: ReportSummaryInput, signal: AbortSignal): Promise<string>
}

/** Deterministic writer used when no model route is configured. */
export class TemplateReportSummaryWriter implements ReportSummaryWriter {
  /** @param input - deterministic report facts. @returns the fallback summary. */
  async write(input: ReportSummaryInput): Promise<string> {
    return input.fallback
  }
}

/** Agent configuration for summary authorship. */
export interface ReportSummaryAgentConfig {
  /** Registered LLM provider route. */
  provider: string
  /** Model id. */
  model: string
  /** Prompt version recorded by the caller. */
  promptVersion: string
  /** Session working directory. */
  cwd?: string
}

/** Cordis one-shot agent adapter for report summaries. */
export class CordisReportSummaryWriter implements ReportSummaryWriter {
  /**
   * @param ctx - lazily resolved owning context.
   * @param config - provider, model, prompt version, and session cwd.
   */
  constructor(
    private readonly ctx: () => Context,
    private readonly config: ReportSummaryAgentConfig,
  ) {}

  /**
   * @param input - deterministic report facts.
   * @param signal - abort signal fired at the configured hard timeout.
   * @returns model-authored summary text.
   */
  async write(input: ReportSummaryInput, signal: AbortSignal): Promise<string> {
    const ctx = this.ctx()
    const sessionId = brandString<SessionId>(`report-summary-${randomUUID()}`)
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd: this.config.cwd ?? process.cwd() },
      agentOptions: { provider: this.config.provider, model: this.config.model },
      signal,
    })
    const unbind = this.bind(handle, input, sessionId)
    try {
      handle.agent.followup(createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: promptFor(input) }],
      }))
      await waitForIdle(handle, signal)
      if (signal.aborted) throw new Error('report summary aborted at the hard timeout')
      const text = lastAssistantText(handle.agent.session.deriveMessages()).trim()
      if (text === '') throw new Error('report summary produced no assistant text')
      return text.slice(0, 2_000)
    } finally {
      unbind()
      await handle.dispose()
    }
  }

  private bind(handle: AgentHandle, input: ReportSummaryInput, sessionId: SessionId): () => void {
    const context = this.ctx()
    const bind = context.nilmContext?.bind
    if (bind === undefined) return () => undefined
    return bind.call(context.nilmContext, handle.agent.id, callContext(input, sessionId))
  }
}

/**
 * Build the immutable system caller context.
 * @param input - report facts.
 * @param sessionId - one-shot session.
 * @returns tenant-bound call context.
 */
function callContext(input: ReportSummaryInput, sessionId: SessionId): CallContext {
  return {
    tenantId: brandString<TenantId>(input.tenantId),
    userRef: 'system:scheduler',
    requestId: `report-summary:${input.reportType}:${input.reportDate}`,
    sessionId,
  }
}

/**
 * Build the summary prompt.
 * @param input - report facts.
 * @returns bounded prompt text.
 */
function promptFor(input: ReportSummaryInput): string {
  return [
    '你是工业企业能源日报摘要助手。只根据下面的结构化事实写一段中文摘要。',
    '要求：不得修改、重算或补造任何数字；不得调用工具；不得推断其他租户数据；控制在 220 字以内。',
    `报表类型：${input.reportType}；业务日期：${input.reportDate}`,
    `确定性摘要：${input.fallback}`,
    `结构化事实：${JSON.stringify(input.payload)}`,
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
    throw new Error('report summary aborted before the turn started')
  }
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => {
      handle.agent.cancel({ kind: 'user' })
      reject(new Error('report summary aborted at the hard timeout'))
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
 * @returns assistant text, or an empty string.
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
