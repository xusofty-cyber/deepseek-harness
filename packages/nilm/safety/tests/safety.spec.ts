import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NilmError,
  type CallContext,
  type SessionId,
  type TenantId,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import NilmSafetyService, {
  type SafetyRepository,
} from '../src/index.ts'

const contexts: Context[] = []
const base = Date.UTC(2026, 10, 18, 2, 0, 0)

function callContext(): CallContext {
  return {
    tenantId: brandString<TenantId>('tenant-a'),
    userRef: 'user-1',
    requestId: 'request-1',
    sessionId: brandString<SessionId>('session-1'),
  }
}

function range(): TimeRangeSpec {
  return {
    start: new Date(base).toISOString(),
    end: new Date(base + 3_600_000).toISOString(),
    timeZone: 'Asia/Shanghai',
    granularity: 'hour',
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: 'r1',
    recordTime: new Date(base),
    terminalChannelId: 'terminal-1',
    assetId: 'channel-1',
    unsafeType: 'overload_single_power',
    unsafeDesc: '额定功率超限',
    power: '12.5',
    current: null,
    applianceName: '空压机',
    handlingStatus: 'pending',
    ...overrides,
  }
}

function setup(repository: SafetyRepository): NilmSafetyService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NilmSafetyService(ctx, { repository })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('NilmSafetyService', () => {
  it('projects upstream fields and preserves missing values as null', async () => {
    const service = setup({
      list: async () => [row() as never],
    })
    const result = await service.queryUnsafeRecords(callContext(), {
      range: range(), terminalIds: ['terminal-1'], channelIds: ['channel-1'],
    })
    expect(result.records).toEqual([{
      recordId: 'r1',
      occurredAt: '2026-11-18T10:00:00+08:00',
      sitePath: null,
      terminalId: 'terminal-1',
      channelId: 'channel-1',
      phase: null,
      unsafeType: 'overload_single_power',
      severity: 'warning',
      description: '额定功率超限',
      powerKw: 12.5,
      currentA: null,
      applianceName: '空压机',
      threshold: null,
      durationSeconds: null,
      status: 'pending',
    }])
    expect(result.dataQuality.source).toBe('raw')
    expect(result.dataQuality.gaps).toEqual([])
  })

  it('passes tenant filters to SQL and keeps unknown severity explicit', async () => {
    let captured: { terminalIds?: readonly string[]; channelIds?: readonly string[] } | undefined
    const service = setup({
      list: async (_window, _limit, filter) => {
        captured = filter
        return [row({ unsafeType: 'vendor_specific_code' }) as never]
      },
    })
    const result = await service.queryUnsafeRecords(callContext(), {
      range: range(),
      terminalIds: ['terminal-1'],
      channelIds: ['channel-1'],
      severity: 'unknown',
    })
    expect(captured).toEqual({ terminalIds: ['terminal-1'], channelIds: ['channel-1'] })
    expect(result.records[0]!.severity).toBe('unknown')
  })

  it('clamps limits and reports an empty result instead of fabricating rows', async () => {
    let limit = 0
    const service = setup({
      list: async (_window, requested) => { limit = requested; return [] },
    })
    const result = await service.queryUnsafeRecords(callContext(), {
      range: range(), terminalIds: ['terminal-1'], limit: 10_000,
    })
    expect(limit).toBe(500)
    expect(result.records).toEqual([])
    expect(result.warnings).toContain('no matching unsafe records')
    await expect(service.queryUnsafeRecords(callContext(), { range: range(), terminalIds: ['terminal-1'], limit: 0 }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('rejects malformed ranges and unsafe filters before the repository runs', async () => {
    let calls = 0
    const service = setup({ list: async () => { calls += 1; return [] } })
    await expect(service.queryUnsafeRecords(callContext(), {
      range: { ...range(), start: 'bad date' },
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.queryUnsafeRecords(callContext(), {
      range: range(), terminalIds: ["x' OR 1=1"],
    })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(calls).toBe(0)
  })

  it('filters severity after row projection', async () => {
    const service = setup({
      list: async () => [row() as never, row({ recordId: 'r2', unsafeType: 'transient' }) as never],
    })
    const result = await service.queryUnsafeRecords(callContext(), {
      range: range(), terminalIds: ['terminal-1'], severity: 'critical',
    })
    expect(result.records.map(record => record.recordId)).toEqual(['r2'])
  })

  it('throws a typed error for unparseable upstream times', async () => {
    const service = setup({ list: async () => [row({ recordTime: 'not-a-time' }) as never] })
    let thrown: unknown
    try {
      await service.queryUnsafeRecords(callContext(), { range: range(), terminalIds: ['terminal-1'] })
    } catch (error) {
      thrown = error
    }
    expect(thrown instanceof NilmError).toBe(true)
  })
})
