import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { NonceStore, verifyRequest } from '../src/auth.ts'
import {
  SseParser,
  signedHeaders,
  type AcceptedTurn,
  type LoadCaller,
  type LoadClient,
  type RequestMetrics,
  type StreamFrame,
} from '../scripts/perf/http.ts'
import { startLoopback } from '../scripts/perf/loopback.ts'
import {
  evaluateGates,
  gatesPass,
  percentile,
  summarize,
  validateDatasetManifest,
  type LatencySummary,
} from '../scripts/perf/metrics.ts'
import { runLoad } from '../scripts/perf/runner.ts'

describe('load-test percentile aggregation', () => {
  it('uses nearest-rank percentiles for every sample count', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 50)).toBe(50)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile(values, 99)).toBe(99)
    expect(percentile(values, 100)).toBe(100)
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([], 95)).toBeUndefined()
  })

  it('keeps the input array and ignores non-finite samples', () => {
    const values = [3, 1, 2, Number.NaN]
    const summary = summarize(values)
    expect(values).toEqual([3, 1, 2, Number.NaN])
    expect(summary).toMatchObject({ count: 3, p50: 2, p95: 3, p99: 3, max: 3 })
  })

  it('summarizes a long soak without spreading the sample array', () => {
    const summary = summarize(Array.from({ length: 200_000 }, (_, index) => index % 1000))
    expect(summary.count).toBe(200_000)
    expect(summary.max).toBe(999)
  })

  it('rejects a percentile outside the allowed range', () => {
    expect(() => percentile([1], 101)).toThrow(TypeError)
    expect(() => percentile([1], Number.NaN)).toThrow(TypeError)
  })
})

describe('load-test dataset preflight', () => {
  const valid = {
    schemaVersion: 1,
    generatedAt: '2026-11-19T00:00:00.000Z',
    tenants: 100,
    minuteDays: 90,
    secondDays: 7,
    meteringPointsPerTenant: 5,
  } as const

  it('accepts the G4-3 coverage and declared tenant ids', () => {
    const result = validateDatasetManifest({ ...valid, tenantIds: ['a', 'b'] }, 2, ['a', 'b'])
    expect(result.errors).toEqual([])
    expect(result.manifest?.secondDays).toBe(7)
  })

  it('refuses a short or malformed declaration', () => {
    expect(validateDatasetManifest({ ...valid, tenants: 99 }, 100).errors).toContain('tenants is 99; the run needs 100')
    expect(validateDatasetManifest({ ...valid, minuteDays: 89 }, 100).errors[0]).toContain('minuteDays is 89')
    expect(validateDatasetManifest({ ...valid, secondDays: 6 }, 100).errors[0]).toContain('secondDays is 6')
    expect(validateDatasetManifest({ ...valid, meteringPointsPerTenant: 4 }, 100).errors[0]).toContain('meteringPointsPerTenant')
    expect(validateDatasetManifest({ ...valid, tenantIds: ['a'] }, 2, ['a', 'b']).errors[0]).toContain('does not declare b')
    expect(validateDatasetManifest('nope', 100).errors[0]).toContain('JSON object')
  })
})

describe('load-test gate evaluation', () => {
  const fast = summarize(Array.from({ length: 100 }, () => 100))
  const input = {
    firstEvent: fast,
    noToolFirstText: fast,
    toolEndToEnd: fast,
    httpRequests: 10_000,
    http5xx: 10,
    transportErrors: 0,
    turnsStarted: 1_000,
    turnsCompleted: 1_000,
    promptClasses: { simple: 700, singleTool: 150, multiTool: 150 },
    isolationProbes: 200,
    isolationFailures: 0,
    durationMs: 1_800_000,
    tenants: 100,
    sessionsPerTenant: 5,
  }

  it('passes every gate at the G4-3 shape and thresholds', () => {
    expect(evaluateGates(input).every(gate => gate.status === 'pass')).toBe(true)
    expect(gatesPass(evaluateGates(input))).toBe(true)
  })

  it('fails a gate when the sample or threshold is not met', () => {
    const slow: LatencySummary = summarize(Array.from({ length: 100 }, () => 9_000))
    const gates = evaluateGates({ ...input, toolEndToEnd: slow, http5xx: 51, turnsCompleted: 990 })
    expect(gates.find(gate => gate.id === 'tool-e2e-p95')?.status).toBe('fail')
    expect(gates.find(gate => gate.id === 'http-5xx-rate')?.status).toBe('fail')
    expect(gates.find(gate => gate.id === 'turn-error-rate')?.status).toBe('fail')
    expect(gatesPass(gates)).toBe(false)
  })

  it('reports insufficient samples and a short window instead of passing', () => {
    const gates = evaluateGates({
      ...input,
      firstEvent: summarize([1, 2, 3]),
      promptClasses: { simple: 3, singleTool: 0, multiTool: 0 },
      isolationProbes: 0,
      durationMs: 60_000,
      tenants: 10,
      sessionsPerTenant: 1,
    })
    expect(gates.find(gate => gate.id === 'first-stream-p95')?.status).toBe('insufficient')
    expect(gates.find(gate => gate.id === 'soak-duration')?.status).toBe('fail')
    expect(gates.find(gate => gate.id === 'load-shape')?.status).toBe('fail')
    expect(gates.find(gate => gate.id === 'scenario-coverage')?.status).toBe('fail')
    expect(gates.find(gate => gate.id === 'tenant-isolation')?.status).toBe('fail')
    expect(gatesPass(gates)).toBe(false)
  })

  it('requires two isolation probes for every declared tenant', () => {
    const gates = evaluateGates({ ...input, isolationProbes: 199 })
    expect(gates.find(gate => gate.id === 'tenant-isolation')?.status).toBe('fail')
  })
})

describe('SSE parser', () => {
  it('handles frames split across chunks, comments, and keepalives', () => {
    const parser = new SseParser()
    const frames = [
      ...parser.push('id: 1\nevent: status\ndata: {"phase":"accepted"}\n'),
      ...parser.push('\n: comment\nevent: ping\ndata: {}\n\nevent: text.delta\ndata: {"text":"部分'),
      ...parser.push('"}\n\n'),
    ]
    expect(frames).toEqual([
      { id: 1, event: 'status', data: { phase: 'accepted' } },
      { event: 'ping', data: {} },
      { event: 'text.delta', data: { text: '部分' } },
    ])
  })

  it('flushes a trailing frame without a blank line', () => {
    const parser = new SseParser()
    expect(parser.push('event: done\ndata: {"turnId":"t"}')).toEqual([])
    expect(parser.end()).toEqual([{ event: 'done', data: { turnId: 't' } }])
  })
})

describe('signed load headers', () => {
  it('produces an envelope the real verifier accepts', () => {
    const caller: LoadCaller = { tenantId: 'tenant-a', userRef: 'load-user', secret: 's'.repeat(32) }
    const body = Buffer.from(JSON.stringify({ clientMessageId: 'load-1' }), 'utf8')
    const now = Date.now()
    const headers = signedHeaders('POST', '/v1/turns', body, caller, now)
    const verified = verifyRequest({
      method: 'POST',
      path: '/v1/turns',
      headers,
      body,
      nowMs: now,
      secrets: { 'tenant-a': caller.secret },
      nonces: new NonceStore(),
      clockSkewMs: 300_000,
      nonceTtlMs: 600_000,
    })
    expect(verified.tenantId).toBe('tenant-a')
    expect(verified.userRef).toBe('load-user')
  })
})

describe('load runner with an injected transport', () => {
  it('schedules sessions, classifies observed tool use, and probes every tenant', async () => {
    const client = new FakeLoadClient()
    const callers = ['tenant-a', 'tenant-b'].map(tenantId => ({
      tenantId,
      userRef: `user-${tenantId}`,
      secret: 'unused-by-the-fake',
    }))
    const report = await runLoad({
      baseUrl: 'http://fake.invalid',
      client,
      callers,
      dataset: {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        tenants: 2,
        minuteDays: 90,
        secondDays: 7,
        meteringPointsPerTenant: 5,
      },
      mode: 'self-check',
      shape: {
        tenants: 2,
        sessionsPerTenant: 2,
        durationMs: 120,
        warmupMs: 0,
        toolRatio: 0.5,
        turnTimeoutMs: 2_000,
        thinkTimeMinMs: 1,
        thinkTimeMaxMs: 2,
        seed: 11,
      },
    })
    expect(report.ok).toBe(true)
    expect(report.totals.turnsCompleted).toBeGreaterThan(0)
    expect(report.totals.turnsFailed).toBe(0)
    expect(report.latency.firstEvent.count).toBe(report.totals.turnsCompleted)
    expect(report.latency.toolEndToEnd.count).toBeGreaterThan(0)
    expect(report.latency.noToolFirstText.count).toBeGreaterThan(0)
    expect(report.totals.promptClasses.simple).toBeGreaterThan(0)
    expect(report.totals.promptClasses.singleTool).toBeGreaterThan(0)
    expect(report.totals.promptClasses.multiTool).toBeGreaterThan(0)
    expect(report.totals.toolCalls).toBeGreaterThanOrEqual(report.totals.toolObservedTurns)
    expect(report.isolation.probes).toBe(4)
    expect(report.isolation.failures).toBe(0)
    expect(client.metrics.serverErrors).toBe(0)
  })
})

describe('loopback self-check', () => {
  it('drives signed turns through the real BFF and blocks cross-tenant reads', async (context) => {
    const tenantIds = ['load-tenant-a', 'load-tenant-b']
    let target
    try {
      target = await startLoopback(tenantIds)
    } catch (error) {
      if (isListenBlocked(error)) {
        context.skip()
        return
      }
      throw error
    }
    try {
      const report = await runLoad({
        baseUrl: target.url,
        callers: tenantIds.map(tenantId => ({
          tenantId,
          userRef: `user-${tenantId}`,
          secret: target.secrets[tenantId] as string,
        })),
        dataset: {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          tenants: 2,
          minuteDays: 90,
          secondDays: 7,
          meteringPointsPerTenant: 5,
        },
        mode: 'self-check',
        shape: {
          tenants: 2,
          sessionsPerTenant: 2,
          durationMs: 600,
          warmupMs: 0,
          toolRatio: 0.5,
          turnTimeoutMs: 2_000,
          thinkTimeMinMs: 1,
          thinkTimeMaxMs: 3,
          seed: 7,
        },
      })
      expect(report.ok).toBe(true)
      expect(report.totals.turnsCompleted).toBeGreaterThan(0)
      expect(report.totals.turnsFailed).toBe(0)
      expect(report.totals.http5xx).toBe(0)
      expect(report.latency.firstEvent.count).toBe(report.totals.turnsCompleted)
      expect(report.latency.noToolFirstText.count).toBeGreaterThan(0)
      expect(report.latency.toolEndToEnd.count).toBeGreaterThan(0)
      expect(report.isolation.probes).toBe(4)
      expect(report.isolation.failures).toBe(0)
      expect(report.gates).toEqual([])
    } finally {
      await target.close()
    }
  })
})

/** The sandbox used by some local runs denies binding a loopback socket. */
function isListenBlocked(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EPERM'
}

class FakeLoadClient implements LoadClient {
  readonly metrics: RequestMetrics = { requests: 0, serverErrors: 0, transportErrors: 0 }
  private readonly prompts = new Map<string, string>()
  private sequence = 0

  async createConversation(caller: LoadCaller): Promise<string> {
    this.metrics.requests += 1
    this.sequence += 1
    return `conv_${caller.tenantId.replaceAll('-', '')}${String(this.sequence)}`
  }

  async createTurn(_caller: LoadCaller, input: {
    readonly conversationId: string
    readonly clientMessageId: string
    readonly content: string
  }): Promise<AcceptedTurn> {
    this.metrics.requests += 1
    this.sequence += 1
    const turnId = `turn_${String(this.sequence)}`
    this.prompts.set(turnId, input.content)
    return { turnId, conversationId: input.conversationId, streamUrl: `/v1/turns/${turnId}/stream` }
  }

  async stream(
    _caller: LoadCaller,
    streamUrl: string,
    onFrame: (frame: StreamFrame, atMs: number) => void,
  ): Promise<number> {
    this.metrics.requests += 1
    const turnId = streamUrl.split('/')[3] as string
    const prompt = this.prompts.get(turnId) ?? ''
    const emit = (event: string, data: unknown, delay: number): Promise<void> => new Promise(resolve => {
      setTimeout(() => {
        onFrame({ event, data }, performance.now())
        resolve()
      }, delay)
    })
    await emit('status', { phase: 'accepted' }, 0)
    if (/波形|隐患|分析/u.test(prompt)) {
      await emit('tool.start', { tool: 'nilm_timeseries_analyze' }, 1)
      await emit('tool.result', { status: 'completed' }, 1)
    }
    await emit('text.delta', { text: '答' }, 1)
    await emit('done', { turnId }, 1)
    return 200
  }

  async probeMessages(): Promise<{ status: number; text: string }> {
    this.metrics.requests += 1
    return { status: 404, text: '' }
  }

  async listConversations(): Promise<{ status: number; text: string }> {
    this.metrics.requests += 1
    return { status: 200, text: '{"conversations":[]}' }
  }
}
