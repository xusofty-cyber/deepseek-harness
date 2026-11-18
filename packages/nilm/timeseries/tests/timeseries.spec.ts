import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NilmError,
  type CallContext,
  type ChannelId,
  type MeterPoint,
  type SessionId,
  type TenantId,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import NilmTimeseriesService, {
  downsampleBuckets,
  downsamplePoints,
  type TimeseriesSource,
} from '../src/index.ts'

const contexts: Context[] = []
const DAY = 86_400_000
const HOUR = 3_600_000
const base = Date.UTC(2026, 10, 18, 0, 0, 0)

function meter(overrides: Partial<MeterPoint> = {}): MeterPoint {
  return {
    terminalId: 't1' as MeterPoint['terminalId'],
    channelId: 'c1' as ChannelId,
    role: 'terminal_total',
    ...overrides,
  }
}

function callContext(): CallContext {
  return {
    tenantId: brandString<TenantId>('tenant-a'),
    userRef: 'user-1',
    requestId: 'request-1',
    sessionId: brandString<SessionId>('session-1'),
  }
}

function range(startMs: number, endMs: number, granularity: TimeRangeSpec['granularity'] = 'hour'): TimeRangeSpec {
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    timeZone: 'Asia/Shanghai',
    granularity,
  }
}

function setup(source: TimeseriesSource, now = base + DAY): NilmTimeseriesService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NilmTimeseriesService(ctx, { rawPointLimit: 3, chartPointLimit: 2 }, { source, now: () => now })
}

function fakeSource(overrides: Partial<TimeseriesSource> = {}): TimeseriesSource {
  return {
    queryHot: async () => [],
    queryStats: async () => [],
    queryCold: async () => [],
    ...overrides,
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('NilmTimeseriesService', () => {
  it('prefers summarized realtime rows and reports coverage gaps', async () => {
    const calls: string[] = []
    const source = fakeSource({
      queryHot: async sql => {
        calls.push(sql)
        if (sql.includes('summarized_realtime')) {
          return [
            { ts: base, power: 10 },
            { ts: base + 60_000, power: 11 },
          ]
        }
        return [
          { ts: base, power: 99 },
          { ts: base + 120_000, power: 12 },
        ]
      },
    })
    const service = setup(source)
    const result = await service.queryRealtimePoints(callContext(), [meter()], range(base, base + HOUR, 'minute'), ['power'])
    expect(result.points.map(point => point.value)).toEqual([10, 11, 12])
    expect(result.warnings).toContain('summarized realtime rows took precedence over duplicate raw rows')
    expect(result.dataQuality.source).toBe('raw')
    expect(result.dataQuality.coverage).toBeCloseTo(3 / 60, 5)
    expect(result.dataQuality.gaps.length > 0).toBe(true)
    expect(calls.length).toBe(2)
  })

  it('rejects unsupported metrics and malformed ranges', async () => {
    const service = setup(fakeSource())
    await expect(service.queryRealtimePoints(callContext(), [meter()], range(base, base + HOUR), ['power; DROP TABLE x']))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.queryRealtimePoints(callContext(), [meter()], {
      start: 'not-a-date', end: 'also-bad', timeZone: 'Asia/Shanghai', granularity: 'minute',
    }, ['power'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(service.queryRealtimePoints(callContext(), [meter()], {
      ...range(base, base + HOUR), timeZone: 'UTC' as never,
    }, ['power'])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })

  it('computes raw energy deltas and never counts a meter reset as negative energy', async () => {
    const source = fakeSource({
      queryHot: async sql => sql.includes('summarized_energy')
        ? [
            { ts: base, energy_value: 10 },
            { ts: base + 10 * 60_000, energy_value: 15 },
            { ts: base + 20 * 60_000, energy_value: 12 },
          ]
        : [],
    })
    const service = setup(source)
    const result = await service.queryAggregatedEnergy(callContext(), [meter()], range(base, base + HOUR, 'hour'), 'hour')
    expect(result.buckets).toEqual([{ startMs: base, endMs: base + HOUR, energyKwh: 5 }])
    expect(result.warnings.some(warning => warning.includes('meter reset'))).toBe(true)
    expect(result.dataQuality.source).toBe('raw')
  })

  it('uses the statistics endpoint for day aggregates with a projected path', async () => {
    let statsCalls = 0
    const source = fakeSource({
      queryHot: async () => { throw new Error('raw route must not run') },
      queryStats: async sql => {
        statsCalls += 1
        expect(sql).toContain("group_name = '工厂A/一号车间/终端1/总进线'")
        return [{ ts: base, statistic_result: 12.5 }]
      },
    })
    const service = setup(source)
    const result = await service.queryAggregatedEnergy(
      callContext(),
      [meter({ pathName: '工厂A/一号车间/终端1/总进线' })],
      range(base, base + DAY, 'day'),
      'day',
    )
    expect(statsCalls).toBe(1)
    expect(result.buckets).toEqual([{ startMs: base - 8 * HOUR, endMs: base + DAY - 8 * HOUR, energyKwh: 12.5 }])
    expect(result.dataQuality.source).toBe('preaggregated')
  })

  it('routes ranges older than the hot window to the cold proxy', async () => {
    let hotCalls = 0
    const source = fakeSource({
      queryHot: async () => { hotCalls += 1; return [] },
      queryCold: async (template, params) => {
        expect(template).toBe('daily_energy')
        expect(params.meter).toBe('工厂A/一号车间/终端1/总进线')
        return { rows: [{ startMs: base, endMs: base + DAY, energyKwh: 8 }] }
      },
    })
    const service = setup(source, base + 100 * DAY)
    const result = await service.queryAggregatedEnergy(
      callContext(),
      [meter({ pathName: '工厂A/一号车间/终端1/总进线' })],
      range(base, base + DAY, 'day'),
      'day',
    )
    expect(hotCalls).toBe(0)
    expect(result.buckets).toEqual([{ startMs: base, endMs: base + DAY, energyKwh: 8 }])
    expect(result.dataQuality.source).toBe('cold')
    expect(result.warnings[0]).toContain('cold warehouse')
  })

  it('escapes a projected path instead of rejecting non-ASCII names', async () => {
    let captured = ''
    const source = fakeSource({
      queryStats: async sql => { captured = sql; return [{ ts: base, statistic_result: 1 }] },
    })
    const service = setup(source)
    await service.queryAggregatedEnergy(
      callContext(),
      [meter({ pathName: "工厂A/一号'车间" })],
      range(base, base + DAY, 'day'),
      'day',
    )
    expect(captured).toContain("group_name = '工厂A/一号''车间'")
  })

  it('downsamples points and buckets deterministically', () => {
    const points = Array.from({ length: 10 }, (_, index) => ({
      tsMs: base + index * 1000,
      deviceId: 'c1',
      metric: 'power',
      value: index,
    }))
    const sampled = downsamplePoints(points, 3)
    expect(sampled.map(point => point.value)).toEqual([0, 5, 9])
    expect(sampled.map(point => point.tsMs)).toEqual([base, base + 5000, base + 9000])
    const buckets = Array.from({ length: 10 }, (_, index) => ({ startMs: base + index * HOUR, endMs: base + (index + 1) * HOUR, energyKwh: index }))
    expect(downsampleBuckets(buckets, 3).map(bucket => bucket.energyKwh)).toEqual([0, 5, 9])
    expect(() => downsamplePoints(points, 0)).toThrow(NilmError)
  })

  it('rejects unsafe table identifiers at composition time', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => new NilmTimeseriesService(ctx, { realtimeTable: 'x; DROP TABLE y' }, { source: fakeSource() }))
      .toThrow(NilmError)
  })

  it('queries appliance states by authorized terminal and keeps upstream nulls', async () => {
    let captured = ''
    const source = fakeSource({
      queryHot: async sql => {
        captured = sql
        return [
          { ts: base, device_id: 't1', appliance_num: 3, appliance_state: 1, realtime_power: 12.5, irms: null },
          { ts: base, device_id: 't2', appliance_num: 3, appliance_state: 0, realtime_power: null, irms: 4 },
          { ts: base, device_id: 'other', appliance_num: 3, appliance_state: 1, realtime_power: 99, irms: 9 },
        ]
      },
    })
    const service = setup(source)
    const result = await service.queryApplianceStates(
      callContext(),
      [meter(), meter({ terminalId: 't2' as MeterPoint['terminalId'], channelId: 'c2' as ChannelId })],
      range(base, base + HOUR, 'minute'),
      3,
    )
    expect(captured).toContain('FROM nilmdc_appliance_identification')
    expect(captured).toContain("device_id IN ('t1', 't2')")
    expect(captured).toContain('appliance_num = 3')
    expect(result.points).toHaveLength(2)
    expect(result.points.map(point => [point.terminalId, point.running, point.powerKw])).toEqual([
      ['t1', true, 12.5],
      ['t2', false, null],
    ])
    expect(result.warnings[0]).toContain('estimate')
  })

  it('returns no appliance rows without querying when the meter set is empty', async () => {
    let calls = 0
    const service = setup(fakeSource({ queryHot: async () => { calls += 1; return [] } }))
    const result = await service.queryApplianceStates(callContext(), [], range(base, base + HOUR, 'minute'))
    expect(calls).toBe(0)
    expect(result.points).toEqual([])
    expect(result.warnings[0]).toContain('no authorized terminal')
  })
})
