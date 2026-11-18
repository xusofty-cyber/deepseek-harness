/**
 * Cordis-backed NILM agent runtime used by the BFF.
 * @module @deepseek-ai/dsh-nilm-service/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { NilmError, type CallContext } from '@deepseek-ai/dsh-nilm-core'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig } from './config.ts'

/** Model posture requested by the caller; it never changes Tool authority. */
export type TurnMode = 'auto' | 'reasoner'

/** One user or assistant turn as returned by the history endpoint. */
export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Events the BFF consumes from one live agent. */
export type NilmAgentEvent =
  | { readonly type: 'delta'; readonly text: string }
  | { readonly type: 'message'; readonly text: string }
  | { readonly type: 'tool-start'; readonly callId: string; readonly tool: string; readonly title: string }
  | {
    readonly type: 'tool-result'
    readonly callId: string
    readonly tool: string
    readonly status: 'completed' | 'failed'
    readonly summary: string
    readonly warnings: readonly string[]
    readonly meta?: JsonValue
  }
  | { readonly type: 'turn-end'; readonly reason: string }
  | { readonly type: 'error'; readonly code: string; readonly message: string; readonly retryable: boolean }
  | { readonly type: 'status'; readonly status: 'idle' | 'running' }

/** One live conversation surface. */
export interface NilmAgentSession {
  readonly sessionId: string
  /** Queue one user message and wake the agent loop. */
  send(text: string): void
  /** Cancel the active turn without discarding later queued work. */
  cancel(): void
  /** Current user/assistant history. */
  messages(): readonly ChatMessage[]
  /** Subscribe to normalized agent events for this session. */
  subscribe(listener: (event: NilmAgentEvent) => void): () => void
}

/** Runtime seam allowing tests to replace the Cordis agent stack. */
export interface NilmAgentRuntime {
  /**
   * Open or reuse the agent for one conversation and bind its caller context.
   * @param sessionId - conversation/session identity.
   * @param callContext - verified caller identity.
   * @param mode - model posture for this turn.
   * @returns the live session surface.
   */
  open(sessionId: string, callContext: CallContext, mode: TurnMode): Promise<NilmAgentSession>
}

/** Cordis-backed runtime implementation. */
export class CordisNilmRuntime implements NilmAgentRuntime {
  private readonly sessions = new Map<string, RuntimeSession>()

  /**
   * @param ctx - owning plugin context.
   * @param config - resolved deployment configuration.
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig) {
    ctx.on('session/event', (session, event) => {
      this.sessions.get(session.id)?.onSessionEvent(event)
    })
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.sessions.get(agent.session.id)?.onFrame(frame)
    })
    ctx.on('agent/error', ({ agent, error }) => {
      this.sessions.get(agent.session.id)?.onError(error)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      this.sessions.get(agent.session.id)?.emit({ type: 'status', status })
    })
  }

  /**
   * Open or reuse one agent and replace its caller binding.
   * @param sessionId - conversation identity.
   * @param callContext - verified caller identity.
   * @param mode - model posture for this turn.
   * @returns the live session surface.
   */
  async open(sessionId: string, callContext: CallContext, mode: TurnMode): Promise<NilmAgentSession> {
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) {
      if (existing.tenantId !== callContext.tenantId || existing.userRef !== callContext.userRef) {
        throw new NilmError('SCOPE_FORBIDDEN', 'conversation belongs to another caller')
      }
      existing.rebind(callContext)
      existing.select(mode)
      return existing
    }
    const handle = await this.openHandle(sessionId, mode)
    const runtimeSession = new RuntimeSession(this.ctx, handle.agent, callContext, mode, this.config)
    this.sessions.set(sessionId, runtimeSession)
    return runtimeSession
  }

  private async openHandle(sessionId: string, mode: TurnMode): Promise<AgentHandle> {
    const id = brandString<SessionId>(sessionId)
    const persisted = await this.ctx.get('sessionPersistence')?.stat(id)
    const agentOptions = this.route(mode)
    if (persisted !== undefined) {
      return this.ctx.agents.resume({ resumeSessionId: id, agentOptions })
    }
    return this.ctx.agents.create({
      sessionId: id,
      meta: { cwd: this.config.sessionCwd },
      agentOptions,
    })
  }

  private route(mode: TurnMode): { provider: string; model: string } {
    const model = mode === 'reasoner' ? this.config.reasoningModel ?? this.config.model : this.config.model
    return { provider: this.config.provider, model }
  }
}

/** Per-session event normalization and caller binding. */
class RuntimeSession implements NilmAgentSession {
  readonly tenantId: string
  readonly userRef: string
  private readonly listeners = new Set<(event: NilmAgentEvent) => void>()
  private readonly toolNames = new Map<string, string>()
  private unbind: (() => void) | undefined
  private readonly config: ResolvedConfig

  constructor(
    private readonly ctx: Context,
    private readonly agent: Agent,
    callContext: CallContext,
    mode: TurnMode,
    config: ResolvedConfig,
  ) {
    this.tenantId = callContext.tenantId
    this.userRef = callContext.userRef
    this.config = config
    this.rebind(callContext)
    this.select(mode)
  }

  get sessionId(): string {
    return this.agent.session.id
  }

  send(text: string): void {
    this.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  }

  cancel(): void {
    this.agent.cancel({ kind: 'user' })
  }

  messages(): readonly ChatMessage[] {
    return this.agent.session.deriveMessages().flatMap((message) => {
      if (message.role !== 'user' && message.role !== 'assistant') return []
      const text = textOf(message.content)
      return text === '' ? [] : [{ id: String(message.id), role: message.role, text }]
    })
  }

  subscribe(listener: (event: NilmAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  rebind(callContext: CallContext): void {
    this.unbind?.()
    this.unbind = this.ctx.nilmContext.bind(this.agent.id, callContext)
  }

  select(mode: TurnMode): void {
    const model = mode === 'reasoner' ? this.config.reasoningModel ?? this.config.model : this.config.model
    this.agent.model.select({ provider: this.config.provider, model })
  }

  emit(event: NilmAgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  onSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case 'tool/call': {
        this.toolNames.set(event.data.callId, event.data.name)
        this.emit({ type: 'tool-start', callId: event.data.callId, tool: event.data.name, title: toolTitle(event.data.name) })
        break
      }
      case 'tool/result': {
        const callId = event.data.message.toolCallId
        const tool = this.toolNames.get(callId) ?? 'unknown'
        this.toolNames.delete(callId)
        this.emit({
          type: 'tool-result',
          callId,
          tool,
          status: event.data.message.isError === true ? 'failed' : 'completed',
          summary: bound(textOf(event.data.message.content), 4000),
          warnings: warningsOf(event.data.meta),
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        })
        break
      }
      case 'assistant/message': {
        this.emit({ type: 'message', text: textOf(event.data.message.content) })
        break
      }
      case 'turn/end': {
        this.emit({ type: 'turn-end', reason: event.data.reason.kind })
        break
      }
      default:
        break
    }
  }

  onFrame(frame: AssistantStreamFrame): void {
    if (frame.type !== 'chunk' || frame.chunk.type !== 'text-delta' || frame.chunk.text === '') return
    this.emit({ type: 'delta', text: frame.chunk.text })
  }

  onError(error: unknown): void {
    const known = error instanceof NilmError
    const code = known ? error.code : 'INTERNAL_ERROR'
    this.emit({
      type: 'error',
      code,
      message: known ? error.message : 'model request failed',
      retryable: code === 'MODEL_TIMEOUT'
        || code === 'RATE_LIMITED'
        || code === 'DATA_UNAVAILABLE'
        || code === 'SOURCE_UNAVAILABLE'
        || code === 'QUERY_TIMEOUT',
    })
  }
}

/** Concatenate visible text blocks only. */
function textOf(content: readonly ContentBlock[]): string {
  return content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Bound one model summary without splitting a surrogate pair. */
function bound(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = maxChars
  const code = text.charCodeAt(end - 1)
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1
  return `${text.slice(0, end)}…`
}

/** Extract presentation warnings without trusting the Tool meta shape. */
function warningsOf(meta: JsonValue | undefined): string[] {
  if (!isRecord(meta)) return []
  const quality = meta.dataQuality
  if (isRecord(quality) && Array.isArray(quality.warnings)) {
    return quality.warnings.filter((warning): warning is string => typeof warning === 'string')
  }
  return Array.isArray(meta.warnings)
    ? meta.warnings.filter((warning): warning is string => typeof warning === 'string')
    : []
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** User-facing Tool titles; unknown names keep the raw tool id. */
function toolTitle(name: string): string {
  switch (name) {
    case 'nilm_scope_resolve': return '解析工厂范围'
    case 'nilm_energy_query': return '查询用电与电费'
    case 'nilm_appliance_query': return '查询设备运行工况'
    case 'nilm_power_quality_query': return '分析电能质量'
    case 'nilm_timeseries_analyze': return '分析秒级负荷特征'
    case 'nilm_safety_query': return '查询电气安全事件'
    default: return name
  }
}
