import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { expect } from 'vitest'
import type { CallContext } from '@deepseek-ai/dsh-nilm-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { canonicalRequest, createSignature } from '../../src/auth.ts'
import { resolveConfig } from '../../src/config.ts'
import {
  NilmHttpService,
  type AlertApi,
  type AuditEvent,
  type NilmHttpRequest,
  type NilmHttpResponse,
  type NilmHttpServiceOptions,
} from '../../src/http.ts'
import type {
  ChatMessage,
  NilmAgentEvent,
  NilmAgentRuntime,
  NilmAgentSession,
  TurnMode,
} from '../../src/runtime.ts'

export const NOW = Date.UTC(2026, 10, 18, 2, 0, 0)
export const TENANT_A = 'tenant-a'
export const TENANT_B = 'tenant-b'
export const SECRET_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
export const SECRET_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
let nonceCounter = 0

export interface ResponseRecord {
  status: number
  body: string
}

export class FakeRequest implements NilmHttpRequest {
  private readonly closeListeners = new Set<() => void>()

  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: IncomingHttpHeaders,
    private readonly body: Buffer,
  ) {}

  on(event: 'close', listener: () => void): this {
    if (event === 'close') this.closeListeners.add(listener)
    return this
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    if (this.body.length > 0) yield this.body
  }
}

export class FakeResponse implements NilmHttpResponse {
  status = 0
  body = ''
  headersSent = false
  writableEnded = false
  destroyed = false

  writeHead(status: number, _headers?: OutgoingHttpHeaders): this {
    this.status = status
    this.headersSent = true
    return this
  }

  flushHeaders(): void {
    this.headersSent = true
  }

  write(chunk: string): boolean {
    this.body += chunk
    return true
  }

  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk
    this.writableEnded = true
  }
}

export class FakeSession implements NilmAgentSession {
  readonly sessionId: string
  readonly sent: string[] = []
  cancelled = 0
  private readonly listeners = new Set<(event: NilmAgentEvent) => void>()
  private readonly history: ChatMessage[] = []

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  send(text: string): void {
    this.sent.push(text)
    this.history.push({ id: 'u1', role: 'user', text })
  }

  cancel(): void {
    this.cancelled += 1
  }

  messages(): readonly ChatMessage[] {
    return this.history
  }

  subscribe(listener: (event: NilmAgentEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(event: NilmAgentEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

export class FakeRuntime implements NilmAgentRuntime {
  readonly sessions = new Map<string, FakeSession>()
  readonly persisted = new Map<string, readonly ChatMessage[]>()
  opens = 0
  lastContext: CallContext | undefined
  lastMode: TurnMode | undefined

  async open(sessionId: string, callContext: CallContext, mode: TurnMode): Promise<NilmAgentSession> {
    this.opens += 1
    this.lastContext = callContext
    this.lastMode = mode
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    const session = new FakeSession(sessionId)
    this.sessions.set(sessionId, session)
    return session
  }

  async history(sessionId: string): Promise<readonly ChatMessage[] | undefined> {
    return this.persisted.get(sessionId)
  }
}

export function headers(
  method: string,
  path: string,
  body: Buffer,
  tenant: string,
  secret: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const timestamp = String(NOW)
  const nonce = `nonce-${String(++nonceCounter).padStart(8, '0')}`
  const canonical = canonicalRequest(method, path, body, tenant, 'user-1', '', 'request-1', timestamp, nonce)
  return {
    'x-nilm-tenant-id': tenant,
    'x-nilm-user-ref': 'user-1',
    'x-nilm-request-id': 'request-1',
    'x-nilm-timestamp': timestamp,
    'x-nilm-nonce': nonce,
    'x-nilm-signature': createSignature(secret, canonical),
    ...extra,
  }
}

export async function call(
  service: NilmHttpService,
  method: string,
  path: string,
  body: Buffer,
  tenant: string,
  secret: string,
  extra: Record<string, string> = {},
): Promise<ResponseRecord> {
  const req = new FakeRequest(method, path, headers(method, path, body, tenant, secret, extra), body)
  const res = new FakeResponse()
  await service.handleRequest(req, res)
  return { status: res.status, body: res.body }
}

export function openStream(
  service: NilmHttpService,
  path: string,
  tenant: string,
  secret: string,
  extra: Record<string, string> = {},
): { complete: Promise<ResponseRecord>; abort: () => void } {
  const body = Buffer.alloc(0)
  const req = new FakeRequest('GET', path, headers('GET', path, body, tenant, secret, extra), body)
  const res = new FakeResponse()
  const complete = service.handleRequest(req, res).then(() => ({ status: res.status, body: res.body }))
  return { complete, abort: () => { req.close() } }
}

export function parseSse(body: string): Array<{ id?: number; event: string; data: JsonValue }> {
  return body.split('\n\n').filter(block => block.trim() !== '').map((block) => {
    let id: number | undefined
    let event = ''
    let data = ''
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = Number(line.slice(4))
      else if (line.startsWith('event: ')) event = line.slice(7)
      else if (line.startsWith('data: ')) data = line.slice(6)
    }
    return { ...(id === undefined ? {} : { id }), event, data: JSON.parse(data) as JsonValue }
  })
}

export function newService(
  runtime: FakeRuntime,
  alerts?: AlertApi,
  extra: Pick<Partial<NilmHttpServiceOptions>, 'shard' | 'conversations' | 'audit'> = {},
): NilmHttpService {
  return new NilmHttpService({
    config: resolveConfig({
      port: 0,
      sessionCwd: '/tmp',
      model: 'deepseek-chat',
      signingSecrets: { [TENANT_A]: SECRET_A, [TENANT_B]: SECRET_B },
      turnTimeoutMs: 5_000,
      pingIntervalMs: 10_000,
      clockSkewMs: 300_000,
      nonceTtlMs: 600_000,
    }),
    runtime,
    ready: () => true,
    now: () => NOW,
    ...(alerts === undefined ? {} : { alerts }),
    ...extra,
  })
}

export async function createConversation(service: NilmHttpService): Promise<string> {
  const response = await call(service, 'POST', '/v1/conversations', Buffer.from('{}'), TENANT_A, SECRET_A)
  expect(response.status).toBe(201)
  return (JSON.parse(response.body) as { conversationId: string }).conversationId
}

export async function createTurn(service: NilmHttpService, conversationId: string, clientMessageId: string): Promise<string> {
  const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId, content: '查询昨日用电', mode: 'auto' }))
  const response = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
  expect(response.status).toBe(202)
  return (JSON.parse(response.body) as { turnId: string }).turnId
}

/** Capture audit events and the service they come from. */
export function auditedService(
  runtime: FakeRuntime,
  extra: Pick<Partial<NilmHttpServiceOptions>, 'shard' | 'conversations'> = {},
): { service: NilmHttpService; audit: AuditEvent[] } {
  const audit: AuditEvent[] = []
  const service = newService(runtime, undefined, { ...extra, audit: event => { audit.push(event) } })
  return { service, audit }
}
