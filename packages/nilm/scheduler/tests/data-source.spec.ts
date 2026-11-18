import { brandString } from '@deepseek-ai/dsh-brand'
import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import {
  NilmError,
  type ChannelId,
  type EnergyBucket,
  type MeterPoint,
  type TenantId,
  type TerminalId,
} from '@deepseek-ai/dsh-nilm-core'
import type { TariffPlan } from '@deepseek-ai/dsh-nilm-tariff'
import { describe, expect, it } from 'vitest'
import {
  SourceSchedulerDataSource,
  UnavailableMonthlyEnergySource,
  type SchedulerDataSourceDependencies,
} from '../src/index.ts'

const DAY_START = Date.parse('2026-11-17T00:00:00+08:00')
const DAY_END = Date.parse('2026-11-18T00:00:00+08:00')

const COST: CostBreakdown = {
  totalEnergyKwh: 300,
  pricedEnergyKwh: 300,
  unpricedEnergyKwh: 0,
  totalCost: 210,
  byPeriod: {
    sharp: { energyKwh: 30, cost: 30 },
    peak: { energyKwh: 90, cost: 90 },
    flat: { energyKwh: 120, cost: 72 },
    valley: { energyKwh: 60, cost: 18 },
  },
  precise: true,
  warnings: ['cost warning'],
}

function meter(channel: string, role: MeterPoint['role']): MeterPoint {
  return {
    terminalId: brandString<TerminalId>('terminal-1'),
    channelId: brandString<ChannelId>(channel),
    role,
  }
}

function buckets(...values: number[]): EnergyBucket[] {
  return values.map((energyKwh, index) => ({
    startMs: DAY_START + index * 3_600_000,
    endMs: DAY_START + (index + 1) * 3_600_000,
    energyKwh,
  }))
}

function dependencies(overrides: Partial<SchedulerDataSourceDependencies> = {}): SchedulerDataSourceDependencies {
  return {
    source: {
      queryLocalReadOnly: async <T>(sql: string): Promise<T[]> => sql.includes('nilm_asset_snapshot')
        ? [{ nodeId: 'workshop-1', nodeName: '冲压' }] as T[]
        : [],
    },
    assets: {
      resolveMeterSet: async () => [meter('factory', 'terminal_total')],
      getWorkshopChannels: async () => [meter('workshop', 'branch')],
    },
    timeseries: {
      queryAggregatedEnergy: async (_caller, meters) => ({
        buckets: buckets(meters[0]?.channelId === 'workshop' ? 80 : 100, 200),
        dataQuality: { coverage: 0.98, provisional: false, gaps: [], source: 'raw', warnings: [] },
        warnings: [`energy warning for ${meters[0]?.channelId ?? 'none'}`],
      }),
    },
    tariff: {
      effectivePlan: async () => ({ planId: 'plan-1' }) as TariffPlan,
      splitByTariff: async () => ({
        planId: 'plan-1', slices: [], gaps: [], warnings: ['tariff warning'],
      }),
    },
    analytics: {
      calculateEnergyCosts: () => COST,
    },
    ...overrides,
  }
}

describe('scheduled-report data collection', () => {
  it('collects factory energy, tariff costs, and workshop energy', async () => {
    const source = new SourceSchedulerDataSource(dependencies())
    const result = await source.collectMorning('tenant-a', DAY_START, DAY_END)

    expect(result.buckets.map(bucket => bucket.energyKwh)).toEqual([100, 200])
    expect(result.dataQuality).toEqual({ coverage: 0.98, source: 'raw' })
    expect(result.tariff).toEqual({ planId: 'plan-1', cost: COST })
    expect(result.workshops).toEqual([{ name: '冲压', energyKwh: 280 }])
    expect(result.warnings).toContain('cost warning')
    expect(result.warnings).toContain('tariff warning')
  })

  it('keeps recoverable tenant gaps as warnings but rethrows fatal failures', async () => {
    const available = new SourceSchedulerDataSource(dependencies({
      assets: {
        resolveMeterSet: async () => { throw new NilmError('DATA_UNAVAILABLE', 'no topology') },
        getWorkshopChannels: async () => { throw new NilmError('SCOPE_NOT_FOUND', 'no workshop') },
      },
      tariff: {
        effectivePlan: async () => { throw new NilmError('COLD_LINK_UNAVAILABLE', 'cold route down') },
        splitByTariff: async () => ({
          planId: 'plan-1', slices: [], gaps: [], warnings: [],
        }),
      },
    }))
    const result = await available.collectMorning('tenant-a', DAY_START, DAY_END)
    expect(result.buckets).toEqual([])
    expect(result.dataQuality).toEqual({ coverage: 0, source: 'raw' })
    expect(result.tariff).toBeUndefined()
    expect(result.warnings).toContain('no authorized factory meter is available for the morning report')
    expect(result.warnings.some(warning => warning.includes('factory meter set is unavailable'))).toBe(true)
    expect(result.warnings.some(warning => warning.includes('tariff plan is unavailable'))).toBe(true)

    await expect(new SourceSchedulerDataSource(dependencies({
      assets: {
        resolveMeterSet: async () => { throw new Error('topology failed') },
        getWorkshopChannels: async () => [],
      },
    })).collectMorning('tenant-a', DAY_START, DAY_END)).rejects.toThrow('topology failed')

    await expect(new SourceSchedulerDataSource(dependencies({
      assets: {
        resolveMeterSet: async () => [],
        getWorkshopChannels: async () => { throw new Error('workshop failed') },
      },
    })).collectMorning('tenant-a', DAY_START, DAY_END)).rejects.toThrow('workshop failed')
  })

  it('collects configured monthly energy and reports an empty preaggregation', async () => {
    const source = new SourceSchedulerDataSource(dependencies({
      monthlyEnergy: { listDaily: async () => [{ date: '2026-11-01', activeKwh: 10, reactiveKvarh: 2 }] },
    }))
    await expect(source.collectMonthly('tenant-a', DAY_START, '2026-11-16', DAY_END)).resolves.toEqual({
      days: [{ date: '2026-11-01', activeKwh: 10, reactiveKvarh: 2 }],
      warnings: [],
    })

    await expect(new SourceSchedulerDataSource(dependencies({
      monthlyEnergy: { listDaily: async () => [] },
    })).collectMonthly('tenant-a', DAY_START, '2026-11-16', DAY_END)).resolves.toEqual({
      days: [], warnings: ['no completed daily energy is available for 2026-11-16'],
    })

    await expect(new SourceSchedulerDataSource(dependencies()).collectMonthly(
      'tenant-a', DAY_START, '2026-11-16', DAY_END,
    )).rejects.toThrow('no monthly active/reactive preaggregation')
    await expect(new UnavailableMonthlyEnergySource().listDaily(
      brandString<TenantId>('tenant-a'), DAY_START, DAY_END,
    )).rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' })
  })

  it('checks parent and child energy per terminal and skips incomplete bindings', async () => {
    const source = new SourceSchedulerDataSource(dependencies({
      source: {
        queryLocalReadOnly: async <T>(): Promise<T[]> => [
          { terminalId: 'terminal-1', channelId: 'total', role: 'terminal_total', parentChannelId: null },
          { terminalId: 'terminal-1', channelId: 'branch-1', role: 'branch', parentChannelId: 'total' },
          { terminalId: 'terminal-1', channelId: 'branch-2', role: 'branch', parentChannelId: 'total' },
          { terminalId: 'terminal-2', channelId: 'branch-only', role: 'branch', parentChannelId: null },
        ] as T[],
      },
      timeseries: {
        queryAggregatedEnergy: async (_caller, meters) => ({
          buckets: buckets(meters[0]?.channelId === 'total' ? 100 : 40),
          dataQuality: { coverage: 0.97, provisional: false, gaps: [], source: 'mixed', warnings: [] },
          warnings: [],
        }),
      },
    }))
    const result = await source.collectQuality('tenant-a', DAY_START, DAY_END)
    expect(result.observations).toEqual([{
      scopeId: 'terminal-1',
      scopeName: 'terminal-1',
      coverage: 0.97,
      parentEnergyKwh: 100,
      childEnergyKwh: 80,
    }])
    expect(result.warnings).toContain('hot/cold consistency is not checked until a cold energy route is configured for R-08')
  })

  it('keeps a recoverable terminal query gap and rethrows fatal quality failures', async () => {
    const source = new SourceSchedulerDataSource(dependencies({
      source: {
        queryLocalReadOnly: async <T>(): Promise<T[]> => [
          { terminalId: 'terminal-1', channelId: 'total', role: 'terminal_total', parentChannelId: null },
          { terminalId: 'terminal-1', channelId: 'branch-1', role: 'branch', parentChannelId: 'total' },
        ] as T[],
      },
      timeseries: {
        queryAggregatedEnergy: async () => { throw new NilmError('DATA_UNAVAILABLE', 'hot data missing') },
      },
    }))
    const result = await source.collectQuality('tenant-a', DAY_START, DAY_END)
    expect(result.observations).toEqual([])
    expect(result.warnings.some(warning => warning.includes('quality query failed'))).toBe(true)

    await expect(new SourceSchedulerDataSource(dependencies({
      source: {
        queryLocalReadOnly: async <T>(): Promise<T[]> => [
          { terminalId: 'terminal-1', channelId: 'total', role: 'terminal_total', parentChannelId: null },
          { terminalId: 'terminal-1', channelId: 'branch-1', role: 'branch', parentChannelId: 'total' },
        ] as T[],
      },
      timeseries: {
        queryAggregatedEnergy: async () => { throw new Error('fatal') },
      },
    })).collectQuality('tenant-a', DAY_START, DAY_END)).rejects.toThrow('fatal')
  })
})
