import { brandString } from '@deepseek-ai/dsh-brand'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {
  CallContext,
  ChannelId,
  MeterPoint,
  NilmDataQuality,
  ScopeResolution,
  SessionId,
  TenantId,
  TerminalId,
} from '@deepseek-ai/dsh-nilm-core'
import {
  analyzePowerQuality,
  detectTimeSeriesFeatures,
  type ApplianceUsage,
  type CompareTrend,
  type CostBreakdown,
  type TimeSeriesFeature,
  type TimeSeriesFeatureResult,
} from '@deepseek-ai/dsh-nilm-analytics'
import type { AnalysisQueryResult, AnalysisSample, ApplianceQueryResult, EnergyQueryResult } from '@deepseek-ai/dsh-nilm-timeseries'
import type { SafetyQueryResult } from '@deepseek-ai/dsh-nilm-safety'
import type { TariffPlan, TariffSegmentation } from '@deepseek-ai/dsh-nilm-tariff'
import { applyTools, type NilmToolHost } from '../src/index.ts'

const HOUR = 3_600_000
const START = Date.UTC(2026, 10, 18, 0, 0, 0)
const END = START + HOUR

const context: CallContext = {
  tenantId: brandString<TenantId>('tenant-a'),
  userRef: 'user-1',
  requestId: 'request-1',
  sessionId: brandString<SessionId>('session-1'),
}

const quality: NilmDataQuality = { coverage: 1, provisional: false, gaps: [], source: 'raw', warnings: [] }

const meter: MeterPoint = {
  terminalId: 't1' as TerminalId,
  channelId: 'c1' as ChannelId,
  role: 'terminal_total',
}

const plan: TariffPlan = {
  planId: 'plan-1',
  tenantId: context.tenantId,
  effectiveFromMs: START,
  periods: [],
}

function resolution(overrides: Partial<ScopeResolution> = {}): ScopeResolution {
  return {
    matched: [{ level: 'channel', id: 'c1', name: '总进线', path: '工厂A/一号车间/终端1/总进线' }],
    ambiguous: false,
    resolvedPath: '工厂A/一号车间/终端1/总进线',
    meterSet: [meter],
    warnings: [],
    ...overrides,
  }
}

function energy(overrides: Partial<EnergyQueryResult> = {}): EnergyQueryResult {
  return {
    buckets: [{ startMs: START, endMs: END, energyKwh: 12 }],
    dataQuality: quality,
    warnings: [],
    ...overrides,
  }
}

function appliances(overrides: Partial<ApplianceQueryResult> = {}): ApplianceQueryResult {
  return {
    points: [
      { tsMs: START, terminalId: 't1', applianceNum: 3, running: true, powerKw: 10, currentA: 4 },
      { tsMs: START + 15 * 60_000, terminalId: 't1', applianceNum: 3, running: false, powerKw: null, currentA: null },
    ],
    dataQuality: quality,
    warnings: [],
    ...overrides,
  }
}

function analysisSample(overrides: Partial<AnalysisSample> & { tsMs: number }): AnalysisSample {
  return {
    terminalId: 't1',
    channelId: 'c1' as ChannelId,
    powerKw: 10,
    reactivePowerKvar: 2,
    powerFactor: 0.98,
    harmonicCurrentA: { '1': 90, '2': null, '3': 12, '5': 3, '7': 1 },
    voltageV: 220,
    currentA: 20,
    lineVoltageV: null,
    lineCurrentA: null,
    ...overrides,
  }
}

function analysis(samples?: AnalysisSample[]): AnalysisQueryResult {
  return {
    samples: samples ?? [
      analysisSample({ tsMs: START }),
      analysisSample({ tsMs: START + 60_000 }),
    ],
    dataQuality: quality,
    warnings: [],
  }
}

function feature(overrides: Partial<TimeSeriesFeature> = {}): TimeSeriesFeature {
  return {
    atMs: START + 60_000,
    direction: 'up',
    beforeKw: 1,
    afterKw: 6,
    deltaKw: 5,
    deltaReactiveKvar: 1,
    durationMs: 120_000,
    inrushRatio: 2.5,
    inrushDurationMs: 2_000,
    phaseImbalancePct: 3,
    harmonicDeltaA: { 3: 0.5, 5: 0.2, 7: 0.1 },
    powerFactorBefore: 0.98,
    powerFactorAfter: 0.96,
    powerFactorDelta: -0.02,
    ...overrides,
  }
}

function features(overrides: Partial<TimeSeriesFeatureResult> = {}): TimeSeriesFeatureResult {
  return { events: [feature()], cycles: [], hazards: [], coverage: 1, warnings: [], ...overrides }
}

function usage(overrides: Partial<ApplianceUsage> = {}): ApplianceUsage {
  return {
    terminalId: 't1',
    applianceNum: 3,
    runningMinutes: 15,
    stoppedMinutes: 45,
    unknownMinutes: 0,
    estimatedEnergyKwh: 2.5,
    sampleCount: 2,
    warnings: [],
    ...overrides,
  }
}

const cost: CostBreakdown = {
  totalEnergyKwh: 12,
  pricedEnergyKwh: 12,
  unpricedEnergyKwh: 0,
  totalCost: 9.6,
  byPeriod: {
    sharp: { energyKwh: 0, cost: 0 },
    peak: { energyKwh: 0, cost: 0 },
    flat: { energyKwh: 12, cost: 9.6 },
    valley: { energyKwh: 0, cost: 0 },
  },
  precise: true,
  warnings: [],
}

const trend: CompareTrend = {
  energyDeltaKwh: 0,
  comparable: true,
  precise: true,
  warnings: [],
}

const segmentation: TariffSegmentation = {
  slices: [{ startMs: START, endMs: END, periodType: 'flat', pricePerKwh: 0.8, planId: 'plan-1' }],
  gaps: [],
  warnings: [],
}

function host(options: {
  resolution?: ScopeResolution
  energy?: EnergyQueryResult
  appliances?: ApplianceQueryResult
  usages?: ApplianceUsage[]
  safety?: SafetyQueryResult
  analysis?: AnalysisQueryResult
  features?: TimeSeriesFeatureResult
} = {}): { host: NilmToolHost; registered: Map<string, ToolDefinition>; calls: Array<Record<string, unknown>> } {
  const registered = new Map<string, ToolDefinition>()
  const calls: Array<Record<string, unknown>> = []
  const host: NilmToolHost = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    nilmContext: {
      require(agentId) {
        if (agentId !== 'session-1') throw new Error('unexpected agent')
        return context
      },
      current(agentId) {
        return agentId === 'session-1' ? context : undefined
      },
    },
    nilmAssets: { resolveScope: async () => options.resolution ?? resolution() },
    nilmTimeseries: {
      queryAggregatedEnergy: async () => options.energy ?? energy(),
      queryApplianceStates: async (_context, _meters, _range, category) => {
        calls.push({ category })
        return options.appliances ?? appliances()
      },
      queryAnalysisSamples: async () => {
        calls.push({ analysis: true })
        return options.analysis ?? analysis()
      },
    },
    nilmTariff: {
      effectivePlan: async () => plan,
      splitByTariff: async () => segmentation,
    },
    nilmAnalytics: {
      calculateEnergyCosts: () => cost,
      calculateCompareTrends: () => trend,
      summarizeApplianceStates: () => options.usages ?? [usage()],
      analyzePowerQuality: (samples, window, powerQualityOptions) =>
        analyzePowerQuality(samples, window, powerQualityOptions),
      detectTimeSeriesFeatures: (samples, window, cusumOptions) =>
        options.features ?? detectTimeSeriesFeatures(samples, window, cusumOptions),
    },
    nilmSafety: {
      queryUnsafeRecords: async (_context, input) => {
        calls.push({ terminalIds: input.terminalIds, channelIds: input.channelIds })
        return options.safety ?? { records: [], dataQuality: quality, warnings: [] }
      },
    },
  }
  return { host, registered, calls }
}

async function execute(definition: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const exec: ToolRunContext = {
    callId: brandString<ToolRunContext['callId']>('call-1'),
    rootCallId: brandString<ToolRunContext['callId']>('call-1'),
    name: definition.name,
    arguments: args,
    signal: new AbortController().signal,
    agent: { id: brandString<SessionId>('session-1') },
    token: Symbol('tool-token') as ToolRunContext['token'],
    deferContext: () => {},
    concludeTurn: () => {},
  }
  return await definition.execute(args, exec) as Record<string, unknown>
}

describe('nilm tools', () => {
  it('registers six closed-schema tools', () => {
    const { host: h, registered } = host()
    applyTools(h)
    expect([...registered.keys()]).toEqual([
      'nilm_scope_resolve',
      'nilm_appliance_query',
      'nilm_energy_query',
      'nilm_power_quality_query',
      'nilm_timeseries_analyze',
      'nilm_safety_query',
    ])
    for (const tool of registered.values()) expect(tool.parameters.additionalProperties).toBe(false)
  })

  it('caps scope facts and reports truncation', async () => {
    const meters = Array.from({ length: 201 }, (_, index) => ({
      ...meter,
      channelId: `c${String(index)}` as ChannelId,
    }))
    const { host: h, registered } = host({ resolution: resolution({ meterSet: meters }) })
    applyTools(h)
    const result = await execute(registered.get('nilm_scope_resolve')!, { level: 'workshop', id: 'w1' })
    const facts = result.facts as Record<string, unknown>
    expect((facts.meterSet as unknown[]).length).toBe(200)
    expect(facts.meterSetTruncated).toBe(true)
    expect((result.warnings as string[]).some(warning => warning.includes('truncated'))).toBe(true)
  })

  it('never turns missing energy into zero', async () => {
    const { host: h, registered } = host({ energy: energy({ buckets: [] }) })
    applyTools(h)
    const tool = registered.get('nilm_energy_query')!
    const args = {
      scope: { level: 'channel', id: 'c1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
      granularity: 'hour',
      include_cost: false,
    }
    const result = await execute(tool, args)
    const facts = result.facts as Record<string, unknown>
    expect(facts.dataAvailable).toBe(false)
    expect(facts.totalEnergyKwh).toBe(null)
    expect(result.summaryText as string).toContain('未以 0 代替')
    const rendered = tool.output.render(args, result)
    expect((JSON.parse(rendered[0]!.text) as Record<string, unknown>).chart).toBeUndefined()
    const meta = tool.output.presentationMeta?.(args, result) as Record<string, unknown>
    expect(meta.dataQuality).not.toBe(null)
  })

  it('exposes clarification candidates in presentation metadata for ambiguous scopes', async () => {
    const matched = [
      { level: 'workshop' as const, id: 'w1', name: '一号车间', path: '工厂A/一号车间' },
      { level: 'workshop' as const, id: 'w2', name: '二号车间', path: '工厂A/二号车间' },
    ]
    const { host: h, registered } = host({
      resolution: resolution({ ambiguous: true, matched, resolvedPath: undefined }),
    })
    applyTools(h)
    const args = { level: 'workshop', name: '车间' }
    const result = await execute(registered.get('nilm_scope_resolve')!, args)
    const meta = registered.get('nilm_scope_resolve')!.output.presentationMeta?.(args, result as never) as Record<string, unknown>
    const clarify = meta.clarify as { question: string; candidates: Array<Record<string, unknown>> }
    expect(clarify.question).toContain('更精确')
    expect(clarify.candidates.map(candidate => candidate.id)).toEqual(['w1', 'w2'])
    expect(result.actions).toEqual([{ id: 'clarify', label: '请提供更精确的节点 ID 或完整路径', kind: 'clarify' }])
  })

  it('keeps chart data out of model content and in presentation metadata', async () => {
    const { host: h, registered } = host()
    applyTools(h)
    const tool = registered.get('nilm_energy_query')!
    const args = {
      scope: { level: 'channel', id: 'c1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
      granularity: 'hour',
      include_cost: false,
    }
    const result = await execute(tool, args)
    const rendered = tool.output.render(args, result)
    expect((JSON.parse(rendered[0]!.text) as Record<string, unknown>).chart).toBeUndefined()
    const meta = tool.output.presentationMeta?.(args, result) as Record<string, unknown>
    expect((meta.chart as Record<string, unknown>).version).toBe(1)
  })

  it('calculates energy-weighted power quality and keeps harmonic charts out of model content', async () => {
    const { host: h, registered } = host()
    applyTools(h)
    const tool = registered.get('nilm_power_quality_query')!
    const args = {
      scope: { level: 'channel', id: 'c1' },
      start: new Date(START).toISOString(),
      end: new Date(START + 60_000).toISOString(),
    }
    const result = await execute(tool, args)
    const facts = result.facts as Record<string, unknown>
    expect(facts.energyWeightedPowerFactor).toBe(0.981)
    expect(facts.powerFactorRisk).toBe('ok')
    expect(facts.sampleCoverage).toBe(1)
    expect((facts.harmonicBands as Array<Record<string, unknown>>).find(band => band.order === 3)?.meanPct).toBeCloseTo(13.3333, 3)
    expect(result.summaryText as string).toContain('能量加权功率因数 0.981')
    const chart = result.chart as Record<string, unknown>
    expect(chart.version).toBe(1)
    expect(chart.unit).toBe('%')
    expect((chart.series as unknown[]).length).toBe(3)
    const rendered = tool.output.render(args, result)
    expect((JSON.parse(rendered[0]!.text) as Record<string, unknown>).chart).toBeUndefined()
    expect((tool.output.presentationMeta?.(args, result) as Record<string, unknown>).chart).toMatchObject({ unit: '%' })
  })

  it('does not invent power-quality values when no sample is available', async () => {
    const { host: h, registered } = host({ analysis: { samples: [], dataQuality: quality, warnings: [] } })
    applyTools(h)
    const result = await execute(registered.get('nilm_power_quality_query')!, {
      scope: { level: 'channel', id: 'c1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
    })
    const facts = result.facts as Record<string, unknown>
    expect(facts.dataAvailable).toBe(false)
    expect(facts.energyWeightedPowerFactor).toBe(null)
    expect(result.warnings as string[]).toContain('no realtime sample matched the requested scope and range')
  })

  it('analyzes a short second-level window and emits bounded chart annotations', async () => {
    const samples = Array.from({ length: 181 }, (_, index) => analysisSample({
      tsMs: START + index * 1000,
      powerKw: index < 60 ? 1 : 6,
      reactivePowerKvar: 0.2,
    }))
    const { host: h, registered } = host({ analysis: analysis(samples) })
    applyTools(h)
    const tool = registered.get('nilm_timeseries_analyze')!
    const args = {
      scope: { level: 'channel', id: 'c1' },
      start: new Date(START).toISOString(),
      end: new Date(START + 180_000).toISOString(),
      analysisMode: 'comprehensive',
    }
    const result = await execute(tool, args)
    const facts = result.facts as Record<string, unknown>
    expect((facts.events as unknown[]).length).toBe(1)
    expect(result.summaryText as string).toContain('检测到 1 个功率突变')
    const chart = result.chart as Record<string, unknown>
    expect(chart.version).toBe(1)
    expect((chart.series as Array<{ data: unknown[] }>)[0]!.data.length <= 500).toBe(true)
    const annotations = chart.annotations as Array<Record<string, unknown>>
    expect(annotations).toHaveLength(1)
    expect(Object.keys(annotations[0]!).sort()).toEqual(['at', 'label', 'severity'])
    expect(annotations[0]!.severity).toBe('info')
    expect(JSON.stringify(chart).includes('markLine')).toBe(false)
    expect(JSON.stringify(chart).includes('markPoint')).toBe(false)
  })

  it('hides hazards in disaggregation-only mode and rejects windows longer than four hours', async () => {
    const { host: h, registered } = host({
      features: features({
        hazards: [{ kind: 'frequent_cycling', severity: 'warning', atMs: START + 60_000, evidence: { starts: 6 } }],
      }),
    })
    applyTools(h)
    const tool = registered.get('nilm_timeseries_analyze')!
    const start = new Date(START).toISOString()
    const end = new Date(START + 180_000).toISOString()
    const hidden = await execute(tool, { scope: { level: 'channel', id: 'c1' }, start, end, analysisMode: 'disaggregation_only' })
    expect((hidden.facts as Record<string, unknown>).hazards).toEqual([])
    const shown = await execute(tool, { scope: { level: 'channel', id: 'c1' }, start, end, analysisMode: 'comprehensive' })
    expect(((shown.facts as Record<string, unknown>).hazards as unknown[]).length).toBe(1)
    await expect(execute(tool, {
      scope: { level: 'channel', id: 'c1' },
      start,
      end: new Date(START + 4 * HOUR + 1000).toISOString(),
    })).rejects.toThrow('four hours')
  })

  it('summarizes appliances and residual against terminal energy', async () => {
    const { host: h, registered, calls } = host()
    applyTools(h)
    const result = await execute(registered.get('nilm_appliance_query')!, {
      scope: { level: 'terminal', id: 't1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
      applianceCategory: '3',
    })
    const facts = result.facts as Record<string, unknown>
    expect(calls[0]?.category).toBe(3)
    expect(facts.estimatedTotalEnergyKwh).toBe(2.5)
    expect(facts.terminalEnergyKwh).toBe(12)
    expect(facts.residualKwh).toBe(9.5)
    expect((facts.appliances as Array<Record<string, unknown>>)[0]?.idleMinutes).toBe(null)
    expect((result.warnings as string[]).some(warning => warning.includes('idle time is not inferred'))).toBe(true)
  })

  it('restricts safety SQL to the resolved terminals and channels', async () => {
    const { host: h, registered, calls } = host()
    applyTools(h)
    await execute(registered.get('nilm_safety_query')!, {
      scope: { level: 'workshop', id: 'w1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
    })
    expect(calls[0]?.terminalIds).toEqual(['t1'])
    expect(calls[0]?.channelIds).toEqual(['c1'])
  })

  it('caps safety facts and reports the truncation', async () => {
    const records = Array.from({ length: 25 }, (_, index) => ({
      recordId: `r${String(index)}`,
      occurredAt: '2026-11-18T08:00:00+08:00',
      sitePath: null,
      terminalId: 't1',
      channelId: 'c1',
      phase: null,
      unsafeType: 'transient',
      severity: 'critical' as const,
      description: null,
      powerKw: null,
      currentA: null,
      applianceName: null,
      threshold: null,
      durationSeconds: null,
      status: null,
    }))
    const { host: h, registered } = host({ safety: { records, dataQuality: quality, warnings: [] } })
    applyTools(h)
    const result = await execute(registered.get('nilm_safety_query')!, {
      scope: { level: 'terminal', id: 't1' },
      start: new Date(START).toISOString(),
      end: new Date(END).toISOString(),
    })
    const facts = result.facts as Record<string, unknown>
    expect(facts.totalMatched).toBe(25)
    expect((facts.records as unknown[]).length).toBe(20)
    expect((result.warnings as string[]).some(warning => warning.includes('truncated'))).toBe(true)
  })
})
