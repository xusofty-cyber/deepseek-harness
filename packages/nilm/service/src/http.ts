/**
 * HTTP/SSE BFF for the NILM agent. The caller owns identity and UI; this
 * service verifies the caller envelope, owns turn orchestration, and returns
 * stable REST/SSE protocol values.
 * @module @deepseek-ai/dsh-nilm-service/http
 */

import { randomBytes } from 'node:crypto'
import {
  createServer,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { brandString } from '@deepseek-ai/dsh-brand'
import { NilmError, SECURITY_TOOL_FAILURE_CODES, type SessionId, type TenantId } from '@deepseek-ai/dsh-nilm-core'
import { shardForTenant, type ShardAssignment } from '@deepseek-ai/dsh-nilm-sharding'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { AuthError, NonceStore, verifyRequest, type VerifiedCaller } from './auth.ts'
import type { ResolvedConfig } from './config.ts'
import { MemoryConversationStore, type ConversationStore, type StoredConversation } from './conversations.ts'
import { TurnEventBuffer } from './events.ts'
import type { ChatMessage, NilmAgentEvent, NilmAgentRuntime, NilmAgentSession, TurnMode } from './runtime.ts'

/** One security-relevant BFF event; implementations must not include request bodies or secrets. */
export interface AuditEvent {
  readonly type: string
  readonly requestId?: string
  readonly tenantId?: string
  readonly userRef?: string
  readonly code?: string
}

/** Request fields the BFF reads; `IncomingMessage` satisfies this interface. */
export interface NilmHttpRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
  readonly headers: IncomingHttpHeaders
  on(event: 'close', listener: () => void): unknown
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}

/** Response fields the BFF writes; `ServerResponse` satisfies this interface. */
export interface NilmHttpResponse {
  readonly headersSent: boolean
  readonly writableEnded: boolean
  readonly destroyed: boolean
  writeHead(status: number, headers?: OutgoingHttpHeaders): unknown
  flushHeaders(): void
  write(chunk: string): boolean
  end(chunk?: string): unknown
}

/** JSON-safe alert list page returned by the mounted Sentinel service. */
export interface AlertListPage {
  /** Projected alert cards in stable order. */
  alerts: JsonValue
  /** Total visible rows matching the implicit default filter. */
  total: number
}

/** Alert API mounted by the Sentinel stage. */
export interface AlertApi {
  /**
   * @param caller - verified tenant and receiving user.
   * @returns the caller-visible alert page.
   */
  list(caller: { tenantId: TenantId; userRef: string }): Promise<AlertListPage>
  /**
   * @param caller - verified tenant and receiving user.
   * @param eventId - public alert identifier.
   * @returns the acknowledgement outcome; an invisible alert is not revealed.
   */
  acknowledge(caller: { tenantId: TenantId; userRef: string }, eventId: string): Promise<'acknowledged' | 'already-final'>
}

/** Options for one BFF instance. */
export interface NilmHttpServiceOptions {
  readonly config: ResolvedConfig
  readonly runtime: NilmAgentRuntime
  /** Whether dependencies needed to serve a turn are mounted. */
  readonly ready?: () => boolean
  /** Security audit sink; defaults to a no-op. */
  readonly audit?: (event: AuditEvent) => void
  /** Injectable clock for tests. */
  readonly now?: () => number
  /** Injectable nonce cache for tests or a shared implementation. */
  readonly nonces?: NonceStore
  /** Alert API; absent keeps the stage-1 empty, explicitly unavailable skeleton. */
  readonly alerts?: AlertApi
  /** Durable conversation index; absent keeps process-local metadata. */
  readonly conversations?: ConversationStore
  /** Shard membership enforced after caller verification; absent serves every tenant. */
  readonly shard?: ShardAssignment
  /** Report a failed background write that did not fail the caller's turn. */
  readonly reportBackgroundFailure?: (operation: string, error: unknown) => void
}

/** Caller-owned conversation in process memory. */
interface ConversationRecord {
  readonly id: string
  readonly sessionId: string
  readonly tenantId: TenantId
  readonly userRef: string
  readonly createdAt: number
  updatedAt: number
  lastText: string
  agent?: NilmAgentSession
  activeTurnId?: string
}

/** One accepted turn and its replay buffer. */
interface TurnRecord {
  readonly id: string
  readonly conversationId: string
  readonly tenantId: TenantId
  readonly userRef: string
  readonly requestId: string
  readonly createdAt: number
  readonly buffer: TurnEventBuffer
  readonly agent: NilmAgentSession
  readonly unsubscribe: () => void
  readonly timeout: NodeJS.Timeout
  text: string
  messageHadDelta: boolean
  hadError: boolean
  finished: boolean
}

/** Request payload accepted by `POST /v1/turns`. */
interface TurnBody {
  readonly conversationId?: string
  readonly clientMessageId: string
  readonly content: string
  readonly mode: TurnMode
  readonly ignoredTenantId: boolean
}

const TURN_PATH = /^\/v1\/turns\/([A-Za-z0-9_-]+)\/stream$/
const CANCEL_PATH = /^\/v1\/turns\/([A-Za-z0-9_-]+)\/cancel$/
const MESSAGES_PATH = /^\/v1\/conversations\/([A-Za-z0-9_-]+)\/messages$/
const ACK_PATH = /^\/v1\/alerts\/([A-Za-z0-9_-]+)\/ack$/
const MAX_EVENT_BYTES = 64 * 1024
const MAX_TEXT_CHARS = 20_000
const IDEMPOTENCY_TTL_MS = 86_400_000

/** In-process BFF HTTP service. */
export class NilmHttpService {
  private readonly server: Server
  private readonly nonces: NonceStore
  private readonly now: () => number
  private readonly audit: (event: AuditEvent) => void
  private readonly conversations = new Map<string, ConversationRecord>()
  private readonly store: ConversationStore
  private readonly tenantLoads = new Map<string, Promise<void>>()
  private readonly turns = new Map<string, TurnRecord>()
  private readonly idempotency = new Map<string, { turnId: string; expiresAt: number }>()
  private readonly streams = new Set<NilmHttpResponse>()
  private readonly pendingWrites = new Set<Promise<void>>()
  private readonly auditedFailures = new WeakSet<object>()
  private closing = false
  private listening = false

  /**
   * @param options - configuration, agent runtime, readiness, and audit sink.
   */
  constructor(private readonly options: NilmHttpServiceOptions) {
    this.nonces = options.nonces ?? new NonceStore()
    this.now = options.now ?? (() => Date.now())
    this.audit = options.audit ?? (() => undefined)
    this.store = options.conversations ?? new MemoryConversationStore()
    this.server = createServer((req, res) => { void this.handleRequest(req, res) })
  }

  /**
   * Listen on the configured address.
   * @returns the bound address.
   */
  async start(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => { reject(error) }
      this.server.once('error', onError)
      this.server.listen(this.options.config.port, this.options.config.host, () => {
        this.server.off('error', onError)
        this.listening = true
        resolve(this.server.address() as AddressInfo)
      })
    })
  }

  /** Stop accepting connections and close active streams. */
  async close(): Promise<void> {
    this.closing = true
    for (const stream of this.streams) stream.end()
    this.streams.clear()
    for (const turn of this.turns.values()) {
      clearTimeout(turn.timeout)
      turn.unsubscribe()
      turn.buffer.finish()
    }
    if (this.listening) {
      this.listening = false
      await new Promise<void>((resolve, reject) => {
        this.server.close(error => error === undefined ? resolve() : reject(error))
      })
    }
    await Promise.allSettled([...this.pendingWrites])
  }

  /**
   * Handle one request. Public so an embedding server or test can mount the
   * same routing and SSE behavior without opening a socket.
   * @param req - HTTP request.
   * @param res - HTTP response.
   */
  async handleRequest(req: NilmHttpRequest, res: NilmHttpResponse): Promise<void> {
    const state: { caller?: VerifiedCaller } = {}
    try {
      await this.route(req, res, state)
    } catch (error) {
      this.sendFailure(res, error, state.caller)
    }
  }

  private async route(
    req: NilmHttpRequest,
    res: NilmHttpResponse,
    state: { caller?: VerifiedCaller },
  ): Promise<void> {
    if (this.closing) {
      this.sendJson(res, 503, { code: 'SOURCE_UNAVAILABLE', message: 'service is shutting down' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://nilm.local')
    if (url.search !== '') throw new NilmError('INVALID_ARGUMENT', 'query strings are not part of the signed request')
    const path = url.pathname
    if (path === '/healthz') {
      this.sendJson(res, 200, { status: 'ok' })
      return
    }
    if (path === '/readyz') {
      const ready = this.options.ready?.() ?? true
      const secretsConfigured = Object.keys(this.options.config.signingSecrets).length > 0
      this.sendJson(res, ready && secretsConfigured ? 200 : 503, {
        status: ready && secretsConfigured ? 'ready' : 'not_ready',
        secretsConfigured,
        ...(this.options.shard === undefined ? {} : {
          shard: { index: this.options.shard.index, count: this.options.shard.count },
        }),
      })
      return
    }
    const body = req.method === 'POST' ? await readBody(req, this.options.config.maxBodyBytes) : Buffer.alloc(0)
    const caller = verifyRequest({
      method: req.method ?? 'GET',
      path,
      headers: req.headers,
      body,
      nowMs: this.now(),
      secrets: this.options.config.signingSecrets,
      nonces: this.nonces,
      clockSkewMs: this.options.config.clockSkewMs,
      nonceTtlMs: this.options.config.nonceTtlMs,
    })
    state.caller = caller
    this.assertShardOwnership(caller)
    if (caller.allowedScope === undefined) this.auditSecurity(caller, 'scope-defaulted-tenant-wide')
    if (path === '/v1/conversations' && req.method === 'POST') {
      await this.createConversation(caller, body, res)
      return
    }
    if (path === '/v1/conversations' && req.method === 'GET') {
      await this.listConversations(caller, res)
      return
    }
    if (path === '/v1/turns' && req.method === 'POST') {
      await this.createTurn(caller, body, res)
      return
    }
    const turnPath = TURN_PATH.exec(path)
    if (turnPath !== null && req.method === 'GET') {
      await this.streamTurn(caller, turnPath[1] as string, req, res)
      return
    }
    const cancelPath = CANCEL_PATH.exec(path)
    if (cancelPath !== null && req.method === 'POST') {
      this.cancelTurn(caller, cancelPath[1] as string, res)
      return
    }
    const messagesPath = MESSAGES_PATH.exec(path)
    if (messagesPath !== null && req.method === 'GET') {
      await this.listMessages(caller, messagesPath[1] as string, res)
      return
    }
    if (path === '/v1/alerts' && req.method === 'GET') {
      await this.listAlerts(caller, res)
      return
    }
    const ackPath = ACK_PATH.exec(path)
    if (ackPath !== null && req.method === 'POST') {
      await this.acknowledgeAlert(caller, ackPath[1] as string, res)
      return
    }
    throw new NilmError('SCOPE_NOT_FOUND', 'endpoint not found')
  }

  private async listAlerts(caller: VerifiedCaller, res: NilmHttpResponse): Promise<void> {
    const alerts = this.options.alerts
    if (alerts === undefined) {
      this.sendJson(res, 200, { alerts: [], total: 0, available: false })
      return
    }
    const page = await alerts.list({ tenantId: caller.tenantId, userRef: caller.userRef })
    this.sendJson(res, 200, { alerts: page.alerts, total: page.total, available: true })
  }

  private async acknowledgeAlert(caller: VerifiedCaller, eventId: string, res: NilmHttpResponse): Promise<void> {
    const alerts = this.options.alerts
    if (alerts === undefined) {
      throw new NilmError('DATA_UNAVAILABLE', 'alert acknowledgement is unavailable until the Sentinel store is mounted')
    }
    const outcome = await alerts.acknowledge({ tenantId: caller.tenantId, userRef: caller.userRef }, eventId)
    this.audit({
      type: `alert.${outcome}`,
      requestId: caller.requestId,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
    })
    this.sendJson(res, 200, { status: outcome })
  }

  private async createConversation(caller: VerifiedCaller, body: Buffer, res: NilmHttpResponse): Promise<void> {
    if (body.length > 0) parseJsonObject(body)
    const id = `conv_${randomBytes(16).toString('hex')}`
    const now = this.now()
    await this.ensureTenantLoaded(caller.tenantId)
    const conversation: ConversationRecord = {
      id,
      sessionId: id,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      createdAt: now,
      updatedAt: now,
      lastText: '',
    }
    await this.store.put(toStored(conversation))
    this.conversations.set(id, conversation)
    this.sendJson(res, 201, { conversationId: id, sessionId: id, createdAt: new Date(now).toISOString() })
  }

  private async listConversations(caller: VerifiedCaller, res: NilmHttpResponse): Promise<void> {
    await this.ensureTenantLoaded(caller.tenantId)
    const rows = [...this.conversations.values()]
      .filter(item => item.tenantId === caller.tenantId && item.userRef === caller.userRef)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(item => ({
        conversationId: item.id,
        sessionId: item.sessionId,
        createdAt: new Date(item.createdAt).toISOString(),
        updatedAt: new Date(item.updatedAt).toISOString(),
        lastText: item.lastText,
        ...(item.activeTurnId === undefined ? {} : { activeTurnId: item.activeTurnId }),
      }))
    this.sendJson(res, 200, { conversations: rows })
  }

  private async createTurn(caller: VerifiedCaller, body: Buffer, res: NilmHttpResponse): Promise<void> {
    const parsed = parseTurnBody(body)
    if (parsed.ignoredTenantId) this.auditSecurity(caller, 'body-tenant-ignored')
    const now = this.now()
    this.pruneIdempotency(now)
    const idempotencyKey = `${caller.tenantId}\n${caller.userRef}\n${parsed.clientMessageId}`
    const previous = this.idempotency.get(idempotencyKey)
    const previousTurn = previous === undefined ? undefined : this.turns.get(previous.turnId)
    if (previousTurn !== undefined) {
      if (previousTurn.tenantId !== caller.tenantId || previousTurn.userRef !== caller.userRef) {
        throw new NilmError('SCOPE_FORBIDDEN', 'clientMessageId belongs to another caller')
      }
      this.sendAccepted(res, previousTurn, true)
      return
    }
    const conversation = parsed.conversationId === undefined
      ? await this.newConversation(caller)
      : await this.conversationFor(caller, parsed.conversationId)
    if (conversation.activeTurnId !== undefined) {
      throw new NilmError('INVALID_ARGUMENT', 'conversation already has an active turn')
    }
    const agent = await this.options.runtime.open(conversation.id, {
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      requestId: caller.requestId,
      sessionId: brandString<SessionId>(conversation.sessionId),
      ...(caller.allowedScope === undefined ? {} : { allowedScope: caller.allowedScope }),
    }, parsed.mode)
    const turnId = `turn_${randomBytes(12).toString('hex')}`
    const buffer = new TurnEventBuffer(turnId, conversation.sessionId)
    let turn!: TurnRecord
    const timeout = setTimeout(() => {
      if (turn.finished) return
      agent.cancel()
      this.append(turn, 'error', {
        turnId: turn.id,
        code: 'MODEL_TIMEOUT',
        message: '本轮回答超时，已取消生成',
        retryable: true,
      })
      turn.hadError = true
      this.finalizeTurn(turn)
    }, this.options.config.turnTimeoutMs)
    timeout.unref()
    turn = {
      id: turnId,
      conversationId: conversation.id,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      requestId: caller.requestId,
      createdAt: now,
      buffer,
      agent,
      unsubscribe: agent.subscribe(event => { this.onAgentEvent(turn, event) }),
      timeout,
      text: '',
      messageHadDelta: false,
      hadError: false,
      finished: false,
    }
    this.turns.set(turnId, turn)
    conversation.agent = agent
    conversation.activeTurnId = turnId
    conversation.updatedAt = now
    this.idempotency.set(idempotencyKey, { turnId, expiresAt: now + IDEMPOTENCY_TTL_MS })
    this.append(turn, 'status', { turnId, phase: 'accepted', message: '已受理' })
    try {
      agent.send(parsed.content)
    } catch (error) {
      this.append(turn, 'error', {
        turnId,
        code: 'INTERNAL_ERROR',
        message: '无法提交本轮消息',
        retryable: false,
      })
      turn.hadError = true
      this.finalizeTurn(turn)
      throw error
    }
    this.sendAccepted(res, turn, false)
  }

  private sendAccepted(res: NilmHttpResponse, turn: TurnRecord, idempotent: boolean): void {
    const sessionId = this.conversations.get(turn.conversationId)?.sessionId ?? turn.conversationId
    this.sendJson(res, 202, {
      turnId: turn.id,
      sessionId,
      conversationId: turn.conversationId,
      streamUrl: `/v1/turns/${turn.id}/stream`,
      idempotent,
    })
  }

  private onAgentEvent(turn: TurnRecord, event: NilmAgentEvent): void {
    if (turn.finished) return
    switch (event.type) {
      case 'delta':
        turn.text += event.text
        turn.messageHadDelta = true
        this.appendText(turn, event.text)
        break
      case 'message':
        if (event.text !== turn.text && !turn.messageHadDelta && event.text !== '') this.appendText(turn, event.text)
        turn.text = event.text
        turn.messageHadDelta = false
        if (event.text !== '') {
          const conversation = this.conversations.get(turn.conversationId)
          if (conversation !== undefined) conversation.lastText = bound(event.text, 200)
        }
        break
      case 'tool-start':
        this.append(turn, 'tool.start', {
          turnId: turn.id,
          callId: event.callId,
          tool: event.tool,
          title: event.title,
        })
        break
      case 'tool-result': {
        if (event.status === 'failed' && event.code !== undefined && SECURITY_TOOL_FAILURE_CODES.has(event.code)) {
          this.audit({
            type: 'tool.rejected',
            requestId: turn.requestId,
            tenantId: turn.tenantId,
            userRef: turn.userRef,
            code: event.code,
          })
        }
        this.append(turn, 'tool.result', {
          turnId: turn.id,
          callId: event.callId,
          tool: event.tool,
          status: event.status,
          summary: event.summary,
          warnings: [...event.warnings],
        })
        const chart = chartOf(event.meta)
        if (chart !== undefined) {
          const emitted = this.append(turn, 'chart', {
            turnId: turn.id,
            chartId: `ch_${turn.id}_${String(turn.buffer.lastEventId + 1)}`,
            spec: chart,
          })
          if (!emitted) {
            this.append(turn, 'error', {
              turnId: turn.id,
              code: 'CHART_TOO_LARGE',
              message: '图表数据超过单事件大小上限，请在客户端重新请求较小范围',
              retryable: false,
            })
            turn.hadError = true
          }
        }
        const clarify = clarifyOf(event.meta)
        if (clarify !== undefined) {
          this.append(turn, 'clarify', { turnId: turn.id, ...clarify })
        }
        break
      }
      case 'error':
        this.append(turn, 'error', {
          turnId: turn.id,
          code: event.code,
          message: event.message,
          retryable: event.retryable,
        })
        turn.hadError = true
        break
      case 'status':
        this.append(turn, 'status', { turnId: turn.id, phase: event.status })
        break
      case 'turn-end':
        if (event.reason === 'aborted') this.append(turn, 'status', { turnId: turn.id, phase: 'cancelled' })
        if (event.reason === 'error' && !turn.hadError) {
          this.append(turn, 'error', {
            turnId: turn.id,
            code: 'INTERNAL_ERROR',
            message: '本轮生成失败，请重试',
            retryable: false,
          })
          turn.hadError = true
        }
        this.finalizeTurn(turn)
        break
    }
  }

  private finalizeTurn(turn: TurnRecord): void {
    if (turn.finished) return
    turn.finished = true
    clearTimeout(turn.timeout)
    turn.unsubscribe()
    if (turn.text !== '') this.append(turn, 'text.done', { turnId: turn.id, text: turn.text })
    turn.buffer.finish()
    const conversation = this.conversations.get(turn.conversationId)
    if (conversation !== undefined) {
      if (conversation.activeTurnId === turn.id) delete conversation.activeTurnId
      conversation.updatedAt = this.now()
      this.persistConversation(conversation)
    }
  }

  /** Write the index change without letting a failed background write break the SSE stream. */
  private persistConversation(conversation: ConversationRecord): void {
    const write = this.store.put(toStored(conversation)).catch((error: unknown) => {
      this.audit({
        type: 'conversation.persist-failed',
        tenantId: conversation.tenantId,
        userRef: conversation.userRef,
        code: error instanceof Error ? error.name : 'UNKNOWN',
      })
      this.options.reportBackgroundFailure?.('conversation.persist', error)
    })
    this.pendingWrites.add(write)
    void write.finally(() => { this.pendingWrites.delete(write) })
  }

  /**
   * Load one tenant's index once per process. Records written by a previous Pod
   * become visible before the first list, continue, or history request.
   * @param tenantId - verified tenant.
   */
  private async ensureTenantLoaded(tenantId: TenantId): Promise<void> {
    const loaded = this.tenantLoads.get(tenantId)
    if (loaded !== undefined) return loaded
    const load = this.store.list(tenantId).then((records) => {
      for (const record of records) {
        if (!this.conversations.has(record.id)) this.conversations.set(record.id, fromStored(record))
      }
    }, (error: unknown) => {
      this.tenantLoads.delete(tenantId)
      throw error
    })
    this.tenantLoads.set(tenantId, load)
    return load
  }

  private cancelTurn(caller: VerifiedCaller, turnId: string, res: NilmHttpResponse): void {
    const turn = this.turnFor(caller, turnId)
    if (!turn.finished) turn.agent.cancel()
    res.writeHead(204)
    res.end()
  }

  private async streamTurn(caller: VerifiedCaller, turnId: string, req: NilmHttpRequest, res: NilmHttpResponse): Promise<void> {
    const turn = this.turnFor(caller, turnId)
    const requested = header(req, 'last-event-id')
    let lastEventId = 0
    if (requested !== undefined) {
      const parsed = Number(requested)
      if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > turn.buffer.lastEventId) {
        throw new NilmError('INVALID_ARGUMENT', 'Last-Event-ID is outside this turn buffer')
      }
      lastEventId = parsed
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.flushHeaders()
    this.streams.add(res)
    let closed = false
    req.on('close', () => {
      closed = true
      turn.buffer.wake()
    })
    try {
      while (!closed) {
        const pending = turn.buffer.eventsSince(lastEventId)
        for (const event of pending) {
          if (closureClosed(res)) return
          writeFrame(res, event.id, event.event, event.data)
          lastEventId = event.id
          if (event.event === 'done') {
            res.end()
            return
          }
        }
        if (turn.buffer.isClosed) {
          res.end()
          return
        }
        const changed = await waitForChange(turn.buffer, this.options.config.pingIntervalMs)
        if (closed) return
        if (!changed) writePing(res)
      }
    } finally {
      this.streams.delete(res)
      if (!closureClosed(res)) res.end()
    }
  }

  private async listMessages(caller: VerifiedCaller, conversationId: string, res: NilmHttpResponse): Promise<void> {
    const conversation = await this.conversationFor(caller, conversationId)
    const messages: readonly ChatMessage[] = conversation.agent?.messages()
      ?? await this.options.runtime.history(conversation.sessionId, {
        tenantId: caller.tenantId,
        userRef: caller.userRef,
        requestId: caller.requestId,
        sessionId: brandString<SessionId>(conversation.sessionId),
        ...(caller.allowedScope === undefined ? {} : { allowedScope: caller.allowedScope }),
      }, 'auto')
      ?? []
    this.sendJson(res, 200, {
      conversationId,
      messages: messages.map(message => ({ id: message.id, role: message.role, text: message.text })),
    })
  }

  private async newConversation(caller: VerifiedCaller): Promise<ConversationRecord> {
    const id = `conv_${randomBytes(16).toString('hex')}`
    const now = this.now()
    await this.ensureTenantLoaded(caller.tenantId)
    const conversation: ConversationRecord = {
      id,
      sessionId: id,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      createdAt: now,
      updatedAt: now,
      lastText: '',
    }
    await this.store.put(toStored(conversation))
    this.conversations.set(id, conversation)
    return conversation
  }

  private async conversationFor(caller: VerifiedCaller, id: string): Promise<ConversationRecord> {
    await this.ensureTenantLoaded(caller.tenantId)
    const conversation = this.conversations.get(id)
    if (conversation === undefined) throw new NilmError('SCOPE_NOT_FOUND', 'conversation not found')
    if (conversation.tenantId !== caller.tenantId || conversation.userRef !== caller.userRef) {
      throw new NilmError('SCOPE_FORBIDDEN', 'conversation belongs to another caller')
    }
    return conversation
  }

  private turnFor(caller: VerifiedCaller, id: string): TurnRecord {
    const turn = this.turns.get(id)
    if (turn === undefined) throw new NilmError('SCOPE_NOT_FOUND', 'turn not found')
    if (turn.tenantId !== caller.tenantId || turn.userRef !== caller.userRef) {
      throw new NilmError('SCOPE_FORBIDDEN', 'turn belongs to another caller')
    }
    return turn
  }

  private append(turn: TurnRecord, event: Parameters<TurnEventBuffer['append']>[0], data: JsonValue): boolean {
    const size = Buffer.byteLength(JSON.stringify(data), 'utf8')
    if (size > MAX_EVENT_BYTES) return false
    return turn.buffer.append(event, data) !== undefined
  }

  private appendText(turn: TurnRecord, text: string): void {
    for (const chunk of textChunks(text)) {
      this.append(turn, 'text.delta', { turnId: turn.id, text: chunk })
    }
  }

  private pruneIdempotency(now: number): void {
    for (const [key, entry] of this.idempotency) {
      if (entry.expiresAt <= now) this.idempotency.delete(key)
    }
  }

  private auditSecurity(caller: VerifiedCaller, type: string, code?: string): void {
    this.audit({
      type,
      requestId: caller.requestId,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      ...(code === undefined ? {} : { code }),
    })
  }

  /**
   * Refuse a verified caller whose tenant is owned by another shard. The edge
   * routes by the same function; this check makes a misroute harmless instead
   * of writing a tenant's Session onto the wrong PVC.
   * @param caller - caller after envelope verification.
   */
  private assertShardOwnership(caller: VerifiedCaller): void {
    const shard = this.options.shard
    if (shard === undefined) return
    if (shardForTenant(caller.tenantId, shard.count) === shard.index) return
    const error = new NilmError('SCOPE_FORBIDDEN', 'tenant is assigned to another shard')
    this.auditSecurity(caller, 'tenant-shard-mismatch', 'SCOPE_FORBIDDEN')
    this.auditedFailures.add(error)
    throw error
  }

  private sendFailure(res: NilmHttpResponse, error: unknown, caller: VerifiedCaller | undefined): void {
    if (closureClosed(res)) return
    if (res.headersSent) {
      res.end()
      return
    }
    const code = error instanceof NilmError ? error.code : 'INTERNAL_ERROR'
    const status = error instanceof AuthError
      ? error.status
      : error instanceof NilmError ? statusFor(code) : 500
    const message = error instanceof NilmError && code !== 'INTERNAL_ERROR'
      ? error.message
      : 'internal service failure'
    this.auditFailure(error, code, caller)
    this.sendJson(res, status, { code, message, requestId: 'unavailable' })
  }

  /**
   * Record one refused request. Authentication failures happen before tenant
   * identity is verified, so their audit record carries only the stable code;
   * including caller-supplied headers would let an attacker forge audit data.
   */
  private auditFailure(error: unknown, code: string, caller: VerifiedCaller | undefined): void {
    if (typeof error === 'object' && error !== null) {
      if (this.auditedFailures.has(error)) return
      this.auditedFailures.add(error)
    }
    if (error instanceof AuthError) {
      this.audit({ type: 'auth.rejected', code })
      return
    }
    if (caller === undefined) {
      this.audit({ type: 'request.rejected', code })
      return
    }
    this.audit({
      type: 'request.rejected',
      requestId: caller.requestId,
      tenantId: caller.tenantId,
      userRef: caller.userRef,
      code,
    })
  }

  private sendJson(res: NilmHttpResponse, status: number, value: JsonValue): void {
    if (closureClosed(res)) return
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }
}

/** Project the durable record into the live index entry. */
function fromStored(record: StoredConversation): ConversationRecord {
  return {
    id: record.id,
    sessionId: record.sessionId,
    tenantId: record.tenantId,
    userRef: record.userRef,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastText: record.lastText,
  }
}

/** Strip live agent, turn, and idempotency state from the durable record. */
function toStored(record: ConversationRecord): StoredConversation {
  return {
    id: record.id,
    sessionId: record.sessionId,
    tenantId: record.tenantId,
    userRef: record.userRef,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastText: record.lastText,
  }
}

/** Parse a turn request body, allowing and reporting only the ignored `tenant_id`. */
function parseTurnBody(body: Buffer): TurnBody {
  const record = parseJsonObject(body)
  const allowed = new Set(['conversationId', 'clientMessageId', 'content', 'mode', 'tenant_id'])
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new NilmError('INVALID_ARGUMENT', `unknown request field ${key}`)
  }
  const conversationId = record.conversationId
  if (conversationId !== undefined && (typeof conversationId !== 'string' || !/^conv_[A-Za-z0-9]+$/.test(conversationId))) {
    throw new NilmError('INVALID_ARGUMENT', 'conversationId is malformed')
  }
  const clientMessageId = record.clientMessageId
  if (typeof clientMessageId !== 'string' || clientMessageId.trim() === '' || clientMessageId.length > 128) {
    throw new NilmError('INVALID_ARGUMENT', 'clientMessageId must be a non-empty string of at most 128 characters')
  }
  const content = record.content
  if (typeof content !== 'string' || content.trim() === '' || content.length > MAX_TEXT_CHARS) {
    throw new NilmError('INVALID_ARGUMENT', `content must be a non-empty string of at most ${String(MAX_TEXT_CHARS)} characters`)
  }
  const mode = record.mode ?? 'auto'
  if (mode !== 'auto' && mode !== 'reasoner') throw new NilmError('INVALID_ARGUMENT', 'mode must be auto or reasoner')
  return {
    ...(conversationId === undefined ? {} : { conversationId }),
    clientMessageId,
    content,
    mode,
    ignoredTenantId: record.tenant_id !== undefined,
  }
}

/** Parse one JSON object body. */
function parseJsonObject(body: Buffer): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    throw new NilmError('INVALID_ARGUMENT', 'request body must be valid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new NilmError('INVALID_ARGUMENT', 'request body must be a JSON object')
  }
  return value as Record<string, unknown>
}

/** Read a bounded request body. */
async function readBody(req: NilmHttpRequest, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > maxBytes) throw new NilmError('QUERY_LIMIT_EXCEEDED', 'request body exceeds the configured limit')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** Map a stable NILM code to the HTTP status the caller sees. */
function statusFor(code: string): number {
  switch (code) {
    case 'UNAUTHORIZED_TENANT': return 401
    case 'SCOPE_FORBIDDEN': return 403
    case 'SCOPE_NOT_FOUND': return 404
    case 'AMBIGUOUS_SCOPE': return 409
    case 'INVALID_ARGUMENT': return 400
    case 'QUERY_LIMIT_EXCEEDED': return 413
    case 'RATE_LIMITED': return 429
    case 'DATA_UNAVAILABLE':
    case 'DATA_PARTIAL':
    case 'COLD_LINK_UNAVAILABLE':
    case 'SOURCE_UNAVAILABLE': return 503
    case 'MODEL_TIMEOUT':
    case 'QUERY_TIMEOUT':
    case 'TOOL_EXECUTION_TIMEOUT': return 504
    default: return 500
  }
}

/** Read the first value of one request header. */
function header(req: NilmHttpRequest, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

/** Split long text into SSE-sized chunks without splitting a surrogate pair. */
function textChunks(text: string): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + 12_000, text.length)
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xD800 && code <= 0xDBFF) end -= 1
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks
}

/** Bound one user-facing summary. */
function bound(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`
}

/** Extract a valid ChartSpec v1 from Tool presentation metadata. */
function chartOf(meta: JsonValue | undefined): JsonValue | undefined {
  if (!isRecord(meta)) return undefined
  const chart = meta.chart
  if (!isRecord(chart) || chart.version !== 1 || typeof chart.type !== 'string') return undefined
  if (!Array.isArray(chart.series) || !isRecord(chart.xAxis)) return undefined
  return chart
}

/** Extract the structured clarification payload from Tool presentation metadata. */
function clarifyOf(meta: JsonValue | undefined): { question: string; candidates: JsonValue[] } | undefined {
  if (!isRecord(meta)) return undefined
  const clarify = meta.clarify
  if (!isRecord(clarify) || typeof clarify.question !== 'string' || !Array.isArray(clarify.candidates)) return undefined
  return { question: clarify.question, candidates: clarify.candidates.slice(0, 5) }
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Write one SSE frame. */
function writeFrame(res: NilmHttpResponse, id: number, event: string, data: JsonValue): void {
  res.write(`id: ${String(id)}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

/** Write one keepalive frame without consuming an event id. */
function writePing(res: NilmHttpResponse): void {
  res.write('event: ping\ndata: {}\n\n')
}

/** Wait for a buffer change or the ping interval. */
async function waitForChange(buffer: TurnEventBuffer, pingIntervalMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<boolean>(resolve => {
    timer = setTimeout(() => { resolve(false) }, pingIntervalMs)
    timer.unref()
  })
  try {
    return await Promise.race([buffer.waitForChange().then(() => true), timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function closureClosed(res: NilmHttpResponse): boolean {
  return res.writableEnded || res.destroyed
}
