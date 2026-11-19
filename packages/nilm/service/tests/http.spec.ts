import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { shardForTenant } from '@deepseek-ai/dsh-nilm-sharding'
import { resolveConfig } from '../src/config.ts'
import { FileConversationStore } from '../src/conversations.ts'
import { NilmHttpService, type AlertApi, type AuditEvent } from '../src/http.ts'
import {
  call,
  createConversation,
  createTurn,
  FakeRuntime,
  FakeSession,
  newService,
  NOW,
  openStream,
  parseSse,
  SECRET_A,
  SECRET_B,
  TENANT_A,
  TENANT_B,
} from './support/harness.ts'

class BlockingRuntime extends FakeRuntime {
  private releaseOpen!: () => void
  private markOpenStarted!: () => void
  private readonly gate = new Promise<void>(resolve => { this.releaseOpen = resolve })
  private readonly started = new Promise<void>(resolve => { this.markOpenStarted = resolve })

  override async open(...args: Parameters<FakeRuntime['open']>): ReturnType<FakeRuntime['open']> {
    this.markOpenStarted()
    await this.gate
    return super.open(...args)
  }

  release(): void {
    this.releaseOpen()
  }

  awaitOpen(): Promise<void> {
    return this.started
  }
}

class FailingOnceRuntime extends FakeRuntime {
  failNext = true

  override async open(...args: Parameters<FakeRuntime['open']>): ReturnType<FakeRuntime['open']> {
    if (this.failNext) {
      this.failNext = false
      throw new Error('runtime open failed')
    }
    return super.open(...args)
  }
}

class FailingSendSession extends FakeSession {
  failNext = true

  override send(text: string): void {
    if (this.failNext) {
      this.failNext = false
      throw new Error('session send failed')
    }
    super.send(text)
  }
}

class FailingSendRuntime extends FakeRuntime {
  override async open(...args: Parameters<FakeRuntime['open']>): ReturnType<FakeRuntime['open']> {
    if (!this.sessions.has(args[0])) this.sessions.set(args[0], new FailingSendSession(args[0]))
    return super.open(...args)
  }
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

  it('reserves a clientMessageId before awaits so concurrent retries cannot start twice', async () => {
    const runtime = new BlockingRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId: 'client-race', content: '查询昨日用电' }))
      const first = call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
      await runtime.awaitOpen()
      const second = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
      expect(second.status).toBe(429)
      expect(JSON.parse(second.body)).toMatchObject({ code: 'RATE_LIMITED' })
      expect(second.body).toContain('already being processed')
      runtime.release()
      expect((await first).status).toBe(202)
      expect(runtime.opens).toBe(1)
    } finally {
      await service.close()
    }
  })

  it('releases a clientMessageId reservation when turn creation fails', async () => {
    const runtime = new FailingOnceRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId: 'client-retry', content: '查询昨日用电' }))
      expect((await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)).status).toBe(500)
      expect((await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)).status).toBe(202)
      expect(runtime.opens).toBe(1)
    } finally {
      await service.close()
    }
  })

  it('finalizes a turn and releases its conversation when send fails synchronously', async () => {
    const runtime = new FailingSendRuntime()
    const service = newService(runtime)
    try {
      const conversationId = await createConversation(service)
      const body = Buffer.from(JSON.stringify({ conversationId, clientMessageId: 'client-send', content: '查询昨日用电' }))
      expect((await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)).status).toBe(500)
      const retry = await call(service, 'POST', '/v1/turns', body, TENANT_A, SECRET_A)
      expect(retry.status).toBe(202)
      expect(JSON.parse(retry.body)).toMatchObject({ idempotent: false })
      expect(runtime.opens).toBe(2)
      const session = runtime.sessions.get(conversationId) as FailingSendSession
      expect(session.sent).toEqual(['查询昨日用电'])
    } finally {
      await service.close()
    }
  })
})

describe('NILM BFF alerts', () => {
  it('keeps the explicit unavailable skeleton when no Sentinel is mounted', async () => {
    const service = newService(new FakeRuntime())

    const response = await call(service, 'GET', '/v1/alerts', Buffer.alloc(0), TENANT_A, SECRET_A)

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ alerts: [], total: 0, available: false })
  })

  it('projects caller-visible alerts from the mounted Sentinel', async () => {
    const calls: Array<{ tenantId: string; userRef: string }> = []
    const alerts: AlertApi = {
      list: async caller => {
        calls.push(caller)
        return {
          alerts: [{
            id: 'alert_1',
            severity: 'warning',
            status: 'confirmed',
            finding: '夜间基载偏高',
            agentDiagnosis: null,
          }],
          total: 1,
        }
      },
      acknowledge: async () => 'acknowledged',
    }
    const service = newService(new FakeRuntime(), alerts)

    const response = await call(service, 'GET', '/v1/alerts', Buffer.alloc(0), TENANT_A, SECRET_A)

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      alerts: [{
        id: 'alert_1',
        severity: 'warning',
        status: 'confirmed',
        finding: '夜间基载偏高',
        agentDiagnosis: null,
      }],
      total: 1,
      available: true,
    })
    expect(calls).toEqual([{ tenantId: TENANT_A, userRef: 'user-1' }])
  })

  it('acknowledges an alert and audits the outcome', async () => {
    const events: string[] = []
    const seen: Array<{ caller: { tenantId: string; userRef: string }; eventId: string }> = []
    const service = new NilmHttpService({
      config: resolveConfig({
        port: 0,
        sessionCwd: '/tmp',
        model: 'deepseek-chat',
        signingSecrets: { [TENANT_A]: SECRET_A },
      }),
      runtime: new FakeRuntime(),
      ready: () => true,
      now: () => NOW,
      audit: event => events.push(event.type),
      alerts: {
        list: async () => ({ alerts: [], total: 0 }),
        acknowledge: async (caller, eventId) => {
          seen.push({ caller, eventId })
          return 'acknowledged'
        },
      },
    })

    const response = await call(service, 'POST', '/v1/alerts/alert_1/ack', Buffer.alloc(0), TENANT_A, SECRET_A)

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ status: 'acknowledged' })
    expect(seen).toEqual([{ caller: { tenantId: TENANT_A, userRef: 'user-1' }, eventId: 'alert_1' }])
    expect(events).toContain('alert.acknowledged')
  })

  it('does not reveal an alert owned by another caller', async () => {
    const service = newService(new FakeRuntime(), {
      list: async () => ({ alerts: [], total: 0 }),
      acknowledge: async () => { throw new NilmError('SCOPE_NOT_FOUND', 'alert event not found for this caller') },
    })

    const response = await call(service, 'POST', '/v1/alerts/alert_1/ack', Buffer.alloc(0), TENANT_A, SECRET_A)

    expect(response.status).toBe(404)
    expect(JSON.parse(response.body)).toMatchObject({ code: 'SCOPE_NOT_FOUND' })
  })

  it('returns DATA_UNAVAILABLE when acknowledgement is requested without a mount', async () => {
    const service = newService(new FakeRuntime())

    const response = await call(service, 'POST', '/v1/alerts/alert_1/ack', Buffer.alloc(0), TENANT_A, SECRET_A)

    expect(response.status).toBe(503)
    expect(JSON.parse(response.body)).toMatchObject({ code: 'DATA_UNAVAILABLE' })
  })
})

describe('NILM BFF shard ownership', () => {
  it('serves a tenant only on the shard selected by MurmurHash3', async () => {
    const expected = shardForTenant(TENANT_A, 8)
    const wrong = (expected + 1) % 8
    const audited: AuditEvent[] = []
    const service = newService(new FakeRuntime(), undefined, {
      shard: { index: wrong, count: 8 },
      audit: event => { audited.push(event) },
    })
    try {
      const response = await call(service, 'POST', '/v1/conversations', Buffer.from('{}'), TENANT_A, SECRET_A)
      expect(response.status).toBe(403)
      expect(JSON.parse(response.body)).toMatchObject({ code: 'SCOPE_FORBIDDEN', message: 'tenant is assigned to another shard' })
      expect(audited).toContainEqual(expect.objectContaining({ type: 'tenant-shard-mismatch', tenantId: TENANT_A }))
      const health = await call(service, 'GET', '/healthz', Buffer.alloc(0), '', '')
      expect(health.status).toBe(200)
    } finally {
      await service.close()
    }
  })

  it('keeps the health and readiness probes shard-addressable without a caller envelope', async () => {
    const service = newService(new FakeRuntime(), undefined, { shard: { index: 3, count: 8 } })
    try {
      const ready = await call(service, 'GET', '/readyz', Buffer.alloc(0), '', '')
      expect(ready.status).toBe(200)
      expect(JSON.parse(ready.body)).toMatchObject({ shard: { index: 3, count: 8 } })
    } finally {
      await service.close()
    }
  })
})

describe('NILM BFF conversation persistence', () => {
  it('lists and continues a conversation created before the previous Pod stopped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nilm-conversations-'))
    const store = new FileConversationStore(root)
    const first = newService(new FakeRuntime(), undefined, { conversations: store })
    let second: NilmHttpService | undefined
    try {
      const conversationId = await createConversation(first)
      await first.close()

      const runtime = new FakeRuntime()
      second = newService(runtime, undefined, { conversations: store })
      const listed = await call(second, 'GET', '/v1/conversations', Buffer.alloc(0), TENANT_A, SECRET_A)
      expect(listed.status).toBe(200)
      expect(JSON.parse(listed.body)).toMatchObject({
        conversations: [{ conversationId, sessionId: conversationId }],
      })

      await createTurn(second, conversationId, 'client-after-restart')
      expect(runtime.opens).toBe(1)
      expect(runtime.sessions.has(conversationId)).toBe(true)
    } finally {
      await first.close().catch(() => undefined)
      await second?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads persisted history after a restart instead of returning an empty transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nilm-history-'))
    const store = new FileConversationStore(root)
    const first = newService(new FakeRuntime(), undefined, { conversations: store })
    let second: NilmHttpService | undefined
    try {
      const conversationId = await createConversation(first)
      await first.close()

      const runtime = new FakeRuntime()
      runtime.persisted.set(conversationId, [{ id: 'm1', role: 'assistant', text: '昨日用电 12.3 kWh' }])
      second = newService(runtime, undefined, { conversations: store })
      const response = await call(
        second,
        'GET',
        `/v1/conversations/${conversationId}/messages`,
        Buffer.alloc(0),
        TENANT_A,
        SECRET_A,
      )

      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toMatchObject({
        messages: [{ id: 'm1', role: 'assistant', text: '昨日用电 12.3 kWh' }],
      })
    } finally {
      await first.close().catch(() => undefined)
      await second?.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
