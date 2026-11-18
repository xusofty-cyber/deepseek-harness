import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { CallContext } from '@deepseek-ai/dsh-nilm-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { canonicalRequest, createSignature } from '../src/auth.ts'
import { resolveConfig } from '../src/config.ts'
import { NilmHttpService, type NilmHttpRequest, type NilmHttpResponse } from '../src/http.ts'
import type {
  ChatMessage,
  NilmAgentEvent,
  NilmAgentRuntime,
  NilmAgentSession,
  TurnMode,
} from '../src/runtime.ts'

const NOW = Date.UTC(2026, 10, 18, 2, 0, 0)
const TENANT_A = 'tenant-a'
const TENANT_B = 'tenant-b'
const SECRET_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const SECRET_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
let nonceCounter = 0

interface ResponseRecord {
  status: number
  body: string
}

class FakeRequest implements NilmHttpRequest {
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

class FakeResponse implements NilmHttpResponse {
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

class FakeSession implements NilmAgentSession {
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

class FakeRuntime implements NilmAgentRuntime {
  readonly sessions = new Map<string, FakeSession>()
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
}

function headers(
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

async function call(
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

function openStream(
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

function parseSse(body: string): Array<{ id?: number; event: string; data: JsonValue }> {
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

function newService(runtime: FakeRuntime): NilmHttpService {
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
  })
}

async function createConversation(service: NilmHttpService): Promise<string> {
  const response = await call(service, 'POST', '/v1/conversations', Buffer.from('{}'), TENANT_A, SECRET_A)
  expect(response.status).toBe(201)
  return (JSON.parse(response.body) as { conversationId: string }).conversationId
}

async function createTurn(service: NilmHttpService, conversationId: string, clientMessageId: string): Promise<string> {
  const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId, content: '查询昨日用电', mode: 'auto' }))
  const response = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
  expect(response.status).toBe(202)
  return (JSON.parse(response.body) as { turnId: string }).turnId
}

describe('NILM BFF HTTP/SSE', () => {
  it('serves health and readiness without caller envelopes', async () => {
    const runtime = new FakeRuntime()
    const service = newService(runtime)
    try {
      const health = await call(service, 'GET', '/healthz', Buffer.alloc(0), '', '')
      expect(health.status).toBe(200)
      const ready = await call(service, 'GET', '/readyz', Buffer.alloc(0), '', '')
      expect(ready.status).toBe(200)
    } finally {
      await service.close()
    }
  })

  it('rejects query strings before routing or verification', async () => {
    const service = newService(new FakeRuntime())
    try {
      const response = await call(service, 'GET', '/healthz?probe=1', Buffer.alloc(0), '', '')
      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    } finally {
      await service.close()
    }
  })

  it('runs one turn and replays buffered SSE events including Last-Event-ID', async () => {
    const runtime = new FakeRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const turnId = await createTurn(service, conversationId, 'client-1')
      const stream = openStream(service, `/v1/turns/${turnId}/stream`, TENANT_A, SECRET_A)
      const session = runtime.sessions.get(conversationId) as FakeSession
      const meta: JsonValue = {
        chart: {
          version: 1,
          type: 'bar',
          title: '昨日电量',
          unit: 'kWh',
          xAxis: { type: 'category', labels: ['01:00'] },
          series: [{ name: '电量', data: [1.2] }],
        },
        clarify: { question: '请选择车间', candidates: [{ level: 'workshop', id: 'ws-1' }] },
        dataQuality: { warnings: ['数据存在 10 分钟缺口'] },
      }
      session.emit({ type: 'delta', text: '昨日用电 ' })
      session.emit({ type: 'message', text: '昨日用电 12.3 kWh' })
      session.emit({ type: 'tool-start', callId: 'c1', tool: 'nilm_energy_query', title: '查询用电与电费' })
      session.emit({
        type: 'tool-result',
        callId: 'c1',
        tool: 'nilm_energy_query',
        status: 'completed',
        summary: '12.3 kWh',
        warnings: ['数据存在 10 分钟缺口'],
        meta,
      })
      session.emit({ type: 'turn-end', reason: 'completed' })
      const response = await stream.complete
      expect(response.status).toBe(200)
      const events = parseSse(response.body)
      expect(events.map(event => event.event)).toEqual([
        'status',
        'text.delta',
        'tool.start',
        'tool.result',
        'chart',
        'clarify',
        'text.done',
        'done',
      ])
      expect(events.find(event => event.event === 'text.done')?.data).toMatchObject({ text: '昨日用电 12.3 kWh' })
      expect(events.find(event => event.event === 'tool.result')?.data).toMatchObject({ warnings: ['数据存在 10 分钟缺口'] })
      expect(events.find(event => event.event === 'chart')?.data).toMatchObject({ chartId: `ch_${turnId}_5` })
      expect(events.find(event => event.event === 'clarify')?.data).toMatchObject({ question: '请选择车间' })
      expect(events.at(-1)?.event).toBe('done')
      expect(session.sent).toEqual(['查询昨日用电'])
      expect(runtime.lastMode).toBe('auto')
      expect(runtime.lastContext?.tenantId).toBe(TENANT_A)

      const replay = await openStream(service, `/v1/turns/${turnId}/stream`, TENANT_A, SECRET_A, { 'last-event-id': '1' }).complete
      const replayed = parseSse(replay.body)
      expect(replayed[0]?.id).toBe(2)
      expect(replayed.at(-1)?.event).toBe('done')

      const messages = await call(service, 'GET', `/v1/conversations/${conversationId}/messages`, Buffer.alloc(0), TENANT_A, SECRET_A)
      expect(messages.status).toBe(200)
      expect(JSON.parse(messages.body)).toMatchObject({ messages: [{ role: 'user', text: '查询昨日用电' }] })
    } finally {
      await service.close()
    }
  })

  it('rejects cross-tenant turn streams and conversation reads without revealing existence', async () => {
    const runtime = new FakeRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const turnId = await createTurn(service, conversationId, 'client-cross')
      const stream = await call(service, 'GET', `/v1/turns/${turnId}/stream`, Buffer.alloc(0), TENANT_B, SECRET_B)
      expect(stream.status).toBe(403)
      const messages = await call(service, 'GET', `/v1/conversations/${conversationId}/messages`, Buffer.alloc(0), TENANT_B, SECRET_B)
      expect(messages.status).toBe(403)
      const unknown = await call(service, 'GET', '/v1/conversations/conv_absent/messages', Buffer.alloc(0), TENANT_A, SECRET_A)
      expect(unknown.status).toBe(404)
    } finally {
      await service.close()
    }
  })

  it('returns the same turn for a repeated clientMessageId and cancels the active turn', async () => {
    const runtime = new FakeRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId: 'client-same', content: '查询昨日用电' }))
      const first = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
      const second = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
      expect(first.status).toBe(202)
      expect(second.status).toBe(202)
      const firstTurn = JSON.parse(first.body) as { turnId: string; idempotent: boolean }
      const secondTurn = JSON.parse(second.body) as { turnId: string; idempotent: boolean }
      expect(secondTurn.turnId).toBe(firstTurn.turnId)
      expect(firstTurn.idempotent).toBe(false)
      expect(secondTurn.idempotent).toBe(true)
      expect(runtime.opens).toBe(1)
      const session = runtime.sessions.get(conversationId) as FakeSession
      expect(session.sent).toHaveLength(1)

      const cancel = await call(service, 'POST', `/v1/turns/${firstTurn.turnId}/cancel`, Buffer.alloc(0), TENANT_A, SECRET_A)
      expect(cancel.status).toBe(204)
      expect(session.cancelled).toBe(1)
      session.emit({ type: 'turn-end', reason: 'aborted' })
    } finally {
      await service.close()
    }
  })
})
