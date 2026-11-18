/**
 * Model-facing NILM tools. Every tool resolves caller scope from the immutable
 * context, never accepts a tenant id, and returns bounded deterministic facts.
 * @module @deepseek-ai/dsh-nilm-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  defineTool,
  ToolArgsError,
  ToolContextUnavailableError,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type CallContext,
  type ChartSpec,
  type EnergyBucket,
  type ScopeLevel,
  type ScopeTarget,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import type { PeriodMetric } from '@deepseek-ai/dsh-nilm-analytics'
import { downsampleBuckets } from '@deepseek-ai/dsh-nilm-timeseries'

/** Cordis plugin name. */
export const name = 'nilm-tools'
/** NILM services consumed by the tool matrix. */
export const inject = [
  'tools',
  'nilmContext',
  'nilmAssets',
  'nilmTimeseries',
  'nilmTariff',
  'nilmAnalytics',
  'nilmSafety',
]

/** The NILM tool plugin takes no configuration. */
export type Config = Record<never, never>
/** Loader schema for the NILM tool plugin. */
export const Config: z<Config> = z.object({})

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const MAX_SCOPE_METERS = 200
const MAX_FACT_SERIES = 200
const MAX_APPLIANCES = 20
const MAX_SAFETY_RECORDS = 20

const SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    level: {
      type: 'string',
      required: true,
      enum: ['factory', 'workshop', 'terminal', 'channel', 'appliance'],
      description: 'Topology level to resolve.',
    },
    id: { type: 'string', description: 'Exact upstream node identifier.' },
    name: { type: 'string', description: 'Human-readable node name.' },
    path: { type: 'string', description: 'Full path, used to disambiguate duplicate names.' },
  },
} as const

/** Narrow service surface required to register the NILM tool matrix. */
export interface NilmToolHost {
  /** Tool registry that receives the definitions. */
  tools: Pick<Context['tools'], 'register'>
  /** Process-memory caller context bound by the BFF. */
  nilmContext: Pick<Context['nilmContext'], 'require'>
  /** Authorized topology resolver. */
  nilmAssets: Pick<Context['nilmAssets'], 'resolveScope'>
  /** Authorized timeseries router. */
  nilmTimeseries: Pick<Context['nilmTimeseries'], 'queryAggregatedEnergy' | 'queryApplianceStates'>
  /** Tenant tariff reader. */
  nilmTariff: Pick<Context['nilmTariff'], 'effectivePlan' | 'splitByTariff'>
  /** Deterministic calculators. */
  nilmAnalytics: Pick<Context['nilmAnalytics'], 'calculateEnergyCosts' | 'calculateCompareTrends' | 'summarizeApplianceStates'>
  /** Authorized unsafe-record projection. */
  nilmSafety: Pick<Context['nilmSafety'], 'queryUnsafeRecords'>
}

const RESULT_OUTPUT = {
  schema: { type: 'json' },
  type: 'json',
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(withoutChart(value)) }],
  presentationMeta: (_args: unknown, value: JsonValue): JsonValue => ({
    chart: chartOf(value),
    dataQuality: dataQualityOf(value),
    clarify: clarifyOf(value),
  }),
} as const

function withoutChart(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const out: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'chart') out[key] = child
  }
  return out
}

function chartOf(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.hasOwn(value, 'chart') ? value.chart ?? null : null
}

function dataQualityOf(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return Object.hasOwn(value, 'dataQuality') ? value.dataQuality ?? null : null
}

function clarifyOf(value: JsonValue): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const actions = value.actions
  if (!Array.isArray(actions)) return null
  const action = actions.find(candidate =>
    typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate) && candidate.kind === 'clarify')
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return null
  const facts = value.facts
  const matched = typeof facts === 'object' && facts !== null && !Array.isArray(facts) ? facts.matched : undefined
  return {
    question: typeof action.label === 'string' ? action.label : '请补充更精确的范围',
    candidates: Array.isArray(matched) ? matched.slice(0, 5) : [],
  }
}

/**
 * Register the stage-1 NILM scope, energy, appliance, and safety tools.
 * @param ctx - context carrying NILM services and the tool registry.
 */
export function apply(ctx: Context): void {
  applyTools(ctx)
}

/**
 * Register the NILM tools against the narrow service surface used by tests and
 * alternate compositions.
 * @param ctx - host carrying the tool registry and NILM services.
 */
export function applyTools(ctx: NilmToolHost): void {
  ctx.tools.register(closed(defineTool({
    name: 'nilm_scope_resolve',
    description: 'Resolve a factory, workshop, terminal, channel, or appliance name/id/path into authorized scope and a non-overlapping meter set.',
    parameters: {
      level: { ...SCOPE_SCHEMA.properties.level },
      id: { ...SCOPE_SCHEMA.properties.id },
      name: { ...SCOPE_SCHEMA.properties.name },
      path: { ...SCOPE_SCHEMA.properties.path },
    },
    output: RESULT_OUTPUT,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const callContext = requireCallContext(ctx, exec.agent?.id)
      const target = scopeTarget(args)
      const resolution = await ctx.nilmAssets.resolveScope(callContext, target, exec.signal)
      const warnings = [...(resolution.warnings ?? [])]
      const matched = resolution.matched.slice(0, 5)
      if (resolution.matched.length > matched.length) {
        warnings.push(`matched candidates were truncated from ${String(resolution.matched.length)} to 5`)
      }
      const meterSet = resolution.meterSet.slice(0, MAX_SCOPE_METERS)
      if (resolution.meterSet.length > meterSet.length) {
        warnings.push(`meter set was truncated from ${String(resolution.meterSet.length)} to ${String(MAX_SCOPE_METERS)}; narrow the scope for complete aggregation`)
      }
      const facts = {
        matched,
        ambiguous: resolution.ambiguous,
        resolvedPath: resolution.resolvedPath ?? null,
        meterSet,
        meterSetTruncated: resolution.meterSet.length > meterSet.length,
      }
      return canonicalJson({
        summaryText: resolution.ambiguous
          ? `范围“${describe(target)}”存在多个候选，需要调用方澄清`
          : `已解析范围“${resolution.resolvedPath ?? describe(target)}”，选择 ${String(meterSet.length)} 个互不重叠计量点`,
        facts,
        dataQuality: eventQuality(warnings),
        warnings,
        ...(resolution.ambiguous
          ? { actions: [{ id: 'clarify', label: '请提供更精确的节点 ID 或完整路径', kind: 'clarify' as const }] }
          : {}),
      })
    },
  })))

  ctx.tools.register(closed(defineTool({
    name: 'nilm_appliance_query',
    description: 'Query NILM-disaggregated appliance running/stopped time and estimated energy for one authorized scope and time range.',
    parameters: {
      scope: { ...SCOPE_SCHEMA, required: true, description: 'Authorized scope to inspect.' },
      start: { type: 'string', required: true, description: 'ISO 8601 inclusive start with offset.' },
      end: { type: 'string', required: true, description: 'ISO 8601 exclusive end with offset.' },
      applianceCategory: { type: 'string', description: 'Optional upstream appliance_num integer encoded as a decimal string.' },
    },
    output: RESULT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const callContext = requireCallContext(ctx, exec.agent?.id)
      const range = timeRange(args.start, args.end, 'minute')
      const target = scopeTarget(args.scope)
      const applianceNum = args.applianceCategory === undefined ? undefined : Number(args.applianceCategory)
      if (applianceNum !== undefined && (!Number.isInteger(applianceNum) || applianceNum < 0)) {
        throw new ToolArgsError(['applianceCategory must be a non-negative decimal integer'])
      }
      const resolution = await ctx.nilmAssets.resolveScope(callContext, target, exec.signal)
      if (resolution.ambiguous) return ambiguityResult(target, resolution.matched)
      if (resolution.meterSet.length === 0) {
        return emptyApplianceResult(target, dateRange(range), resolution.warnings ?? [])
      }
      const warnings = [...(resolution.warnings ?? [])]
      warnings.push('upstream appliance_state distinguishes running and stopped only; idle time is not inferred')
      const detected = await ctx.nilmTimeseries.queryApplianceStates(
        callContext,
        resolution.meterSet,
        range,
        applianceNum,
        exec.signal,
      )
      warnings.push(...detected.warnings)
      const usages = ctx.nilmAnalytics.summarizeApplianceStates(
        detected.points,
        { startMs: Date.parse(range.start), endMs: Date.parse(range.end) },
      )
      for (const usage of usages) warnings.push(...usage.warnings.map(warning => `appliance ${String(usage.applianceNum)}: ${warning}`))
      if (usages.length === 0) warnings.push('no appliance-state samples matched the requested scope and range')
      const totalEnergy = await ctx.nilmTimeseries.queryAggregatedEnergy(
        callContext,
        resolution.meterSet,
        range,
        'hour',
        exec.signal,
      )
      warnings.push(...totalEnergy.warnings)
      const totalKwh = totalEnergy.buckets.length === 0
        ? null
        : totalEnergy.buckets.reduce((sum, bucket) => sum + bucket.energyKwh, 0)
      const applianceKwh = usages.reduce((sum, usage) => sum + usage.estimatedEnergyKwh, 0)
      const residualKwh = totalKwh === null ? null : totalKwh - applianceKwh
      const residualRatio = residualKwh === null || totalKwh === 0 || totalKwh === null ? null : residualKwh / totalKwh
      const syntheticBucket: EnergyBucket = {
        startMs: Date.parse(range.start),
        endMs: Date.parse(range.end),
        energyKwh: applianceKwh,
      }
      const cost = applianceKwh > 0
        ? await costFor(ctx, callContext, [syntheticBucket], range, exec.signal).catch(error => {
            if (isNilmError(error, 'DATA_UNAVAILABLE')) {
              warnings.push('tenant tariff plan is unavailable; appliance energy is reported without cost')
              return undefined
            }
            throw error
          })
        : undefined
      if (cost !== undefined) warnings.push(...cost.warnings)
      if (cost !== undefined) warnings.push('appliance cost shares the aggregate tariff cost by estimated energy, not by each device time slice')
      const shown = usages.slice(0, MAX_APPLIANCES)
      if (usages.length > shown.length) {
        warnings.push(`appliance rows in model facts were truncated from ${String(usages.length)} to ${String(MAX_APPLIANCES)}; totals still use every row`)
      }
      const facts = {
        scope: resolution.matched[0],
        range: dateRange(range),
        dataAvailable: usages.length > 0,
        appliances: shown.map(usage => ({
          ...usage,
          idleMinutes: null,
          estimatedCost: cost === undefined || applianceKwh === 0
            ? null
            : usage.estimatedEnergyKwh / applianceKwh * cost.totalCost,
        })),
        applianceCount: usages.length,
        estimatedTotalEnergyKwh: applianceKwh,
        terminalEnergyKwh: totalKwh,
        residualKwh,
        residualRatio,
      }
      return canonicalJson({
        summaryText: usages.length === 0
          ? `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 没有可用 NILM 设备识别数据`
          : `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 识别 ${String(usages.length)} 个设备，估算运行 ${usages.reduce((sum, usage) => sum + usage.runningMinutes, 0).toFixed(0)} 分钟`,
        facts,
        dataQuality: detected.dataQuality,
        warnings,
      })
    },
  })))

  ctx.tools.register(closed(defineTool({
    name: 'nilm_energy_query',
    description: 'Query authorized energy in kWh for one scope and time range, optionally priced by the tenant tariff plan and compared with the previous period or previous year.',
    parameters: {
      scope: { ...SCOPE_SCHEMA, required: true, description: 'Authorized scope to aggregate.' },
      start: { type: 'string', required: true, description: 'ISO 8601 inclusive start with offset.' },
      end: { type: 'string', required: true, description: 'ISO 8601 exclusive end with offset.' },
      granularity: {
        type: 'string',
        required: true,
        enum: ['second', 'minute', '15min', 'hour', 'day', 'month'],
        description: 'Bucket size.',
      },
      compare: {
        type: 'string',
        enum: ['none', 'previous_period', 'year_over_year'],
        description: 'Comparison mode; defaults to none.',
      },
      include_cost: { type: 'boolean', description: 'Price energy with the tenant tariff plan; defaults to true.' },
    },
    output: RESULT_OUTPUT,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const callContext = requireCallContext(ctx, exec.agent?.id)
      const range = timeRange(args.start, args.end, args.granularity)
      const target = scopeTarget(args.scope)
      const resolution = await ctx.nilmAssets.resolveScope(callContext, target, exec.signal)
      if (resolution.ambiguous) {
        return ambiguityResult(target, resolution.matched)
      }
      if (resolution.meterSet.length === 0) {
        return emptyEnergyResult(target, dateRange(range), resolution.warnings ?? [])
      }
      const warnings = [...(resolution.warnings ?? [])]
      const energy = await ctx.nilmTimeseries.queryAggregatedEnergy(
        callContext,
        resolution.meterSet,
        range,
        args.granularity,
        exec.signal,
      )
      warnings.push(...energy.warnings)
      const includeCost = args.include_cost ?? true
      const cost = includeCost
        ? await costFor(ctx, callContext, energy.buckets, range, exec.signal).catch(error => {
            if (isNilmError(error, 'DATA_UNAVAILABLE')) {
              warnings.push('tenant tariff plan is unavailable; energy is reported without cost')
              return undefined
            }
            throw error
          })
        : undefined
      if (cost !== undefined) warnings.push(...cost.warnings)
      const dataAvailable = energy.buckets.length > 0
      const totalEnergyKwh = dataAvailable
        ? energy.buckets.reduce((sum, bucket) => sum + bucket.energyKwh, 0)
        : null
      const series = downsampleBuckets(energy.buckets, MAX_FACT_SERIES)
      if (series.length < energy.buckets.length) {
        warnings.push(`energy series in model facts was reduced from ${String(energy.buckets.length)} to ${String(series.length)} buckets; totals still use every bucket`)
      }
      const comparison = args.compare === undefined || args.compare === 'none'
        ? undefined
        : await compareEnergy(ctx, callContext, resolution.meterSet, range, args.compare, includeCost, exec.signal)
      const dataQuality = energy.dataQuality
      const facts = {
        scope: resolution.matched[0],
        range: dateRange(range),
        dataAvailable,
        totalEnergyKwh,
        cost: cost === undefined
          ? null
          : { totalCost: cost.totalCost, byPeriod: cost.byPeriod, precise: cost.precise },
        comparison: comparison ?? null,
        series,
      }
      const chart = energyChart(resolution.resolvedPath ?? describe(target), energy.buckets)
      return canonicalJson({
        summaryText: totalEnergyKwh === null
          ? `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 没有可用电量数据，未以 0 代替`
          : `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 用电 ${totalEnergyKwh.toFixed(3)} kWh${cost === undefined ? '' : `，电费 ${cost.totalCost.toFixed(2)} 元`}`,
        facts,
        dataQuality,
        warnings,
        ...(chart === undefined ? {} : { chart }),
      })
    },
  })))

  ctx.tools.register(closed(defineTool({
    name: 'nilm_safety_query',
    description: 'Query stored electrical safety events for one authorized scope and time range; missing upstream fields remain null.',
    parameters: {
      scope: { ...SCOPE_SCHEMA, required: true, description: 'Authorized scope to inspect.' },
      start: { type: 'string', required: true, description: 'ISO 8601 inclusive start with offset.' },
      end: { type: 'string', required: true, description: 'ISO 8601 exclusive end with offset.' },
      severity: { type: 'string', enum: ['info', 'warning', 'critical', 'unknown'], description: 'Optional normalized severity filter.' },
      limit: { type: 'integer', description: 'Maximum records, 1 through 500; defaults to 100.' },
    },
    output: RESULT_OUTPUT,
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const callContext = requireCallContext(ctx, exec.agent?.id)
      const range = timeRange(args.start, args.end, 'minute')
      const target = scopeTarget(args.scope)
      const resolution = await ctx.nilmAssets.resolveScope(callContext, target, exec.signal)
      if (resolution.ambiguous) return ambiguityResult(target, resolution.matched)
      if (resolution.meterSet.length === 0) {
        return emptySafetyResult(target, dateRange(range), resolution.warnings ?? [])
      }
      const terminalIds = [...new Set(resolution.meterSet.map(meter => meter.terminalId as string))].sort()
      const channelIds = [...new Set(resolution.meterSet.map(meter => meter.channelId as string))].sort()
      const safety = await ctx.nilmSafety.queryUnsafeRecords(callContext, {
        range,
        terminalIds,
        channelIds,
        ...(args.severity === undefined ? {} : { severity: args.severity }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      }, exec.signal)
      const records = safety.records.slice(0, MAX_SAFETY_RECORDS)
      const warnings = [...(resolution.warnings ?? []), ...safety.warnings]
      if (safety.records.length > records.length) {
        warnings.push(`safety records in model facts were truncated from ${String(safety.records.length)} to ${String(MAX_SAFETY_RECORDS)}; query a narrower range or severity for complete detail`)
      }
      return canonicalJson({
        summaryText: records.length === 0
          ? `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 未发现匹配的安全事件`
          : `范围“${resolution.resolvedPath ?? describe(target)}”在 ${dateRange(range)} 发现 ${String(safety.records.length)} 条安全事件`,
        facts: {
          scope: resolution.matched[0],
          range: dateRange(range),
          totalMatched: safety.records.length,
          records,
        },
        dataQuality: safety.dataQuality,
        warnings,
      })
    },
  })))
}

function requireCallContext(ctx: NilmToolHost, agentId: string | undefined): CallContext {
  if (agentId === undefined) throw new ToolContextUnavailableError('NILM tools require a calling Agent')
  return ctx.nilmContext.require(agentId)
}

function closed<T extends ToolDefinition>(tool: T): T {
  return { ...tool, parameters: { ...tool.parameters, additionalProperties: false } }
}

function scopeTarget(value: { level: ScopeLevel; id?: string; name?: string; path?: string }): ScopeTarget {
  if (value.id === undefined && value.name === undefined && value.path === undefined) {
    throw new ToolArgsError(['scope requires an id, name, or path'])
  }
  return {
    level: value.level,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.name === undefined ? {} : { name: value.name }),
    ...(value.path === undefined ? {} : { path: value.path }),
  }
}

function timeRange(start: string, end: string, granularity: TimeRangeSpec['granularity']): TimeRangeSpec {
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new ToolArgsError(['start and end must be ordered ISO 8601 instants'])
  }
  return { start, end, timeZone: 'Asia/Shanghai', granularity }
}

function dateRange(range: TimeRangeSpec): { start: string; end: string } {
  return { start: range.start, end: range.end }
}

function describe(target: ScopeTarget): string {
  return target.id ?? target.path ?? target.name ?? target.level
}

function ambiguityResult(target: ScopeTarget, matched: readonly ScopeTarget[]): JsonValue {
  const candidates = matched.slice(0, 5)
  const warnings = [
    'multiple authorized nodes match the requested scope',
    ...(matched.length > candidates.length ? [`matched candidates were truncated from ${String(matched.length)} to 5`] : []),
  ]
  return canonicalJson({
    summaryText: `范围“${describe(target)}”存在多个候选，需要调用方澄清`,
    facts: { matched: candidates, ambiguous: true, truncated: matched.length > candidates.length },
    dataQuality: eventQuality(warnings),
    warnings,
    actions: [{ id: 'clarify', label: '请提供更精确的节点 ID 或完整路径', kind: 'clarify' }],
  })
}

function emptyEnergyResult(target: ScopeTarget, range: { start: string; end: string }, warnings: readonly string[]): JsonValue {
  return canonicalJson({
    summaryText: `范围“${describe(target)}”在 ${range.start}~${range.end} 没有可用计量点`,
    facts: { dataAvailable: false, totalEnergyKwh: null, series: [] },
    dataQuality: eventQuality(warnings),
    warnings: [...warnings],
  })
}

function emptyApplianceResult(target: ScopeTarget, range: { start: string; end: string }, warnings: readonly string[]): JsonValue {
  return canonicalJson({
    summaryText: `范围“${describe(target)}”在 ${range.start}~${range.end} 没有可用计量点`,
    facts: {
      dataAvailable: false,
      appliances: [],
      estimatedTotalEnergyKwh: null,
      terminalEnergyKwh: null,
      residualKwh: null,
      residualRatio: null,
    },
    dataQuality: eventQuality(warnings),
    warnings: [...warnings],
  })
}

function emptySafetyResult(target: ScopeTarget, range: { start: string; end: string }, warnings: readonly string[]): JsonValue {
  return canonicalJson({
    summaryText: `范围“${describe(target)}”在 ${range.start}~${range.end} 没有可用计量点，未查询安全事件`,
    facts: { totalMatched: 0, records: [] },
    dataQuality: eventQuality(warnings),
    warnings: [...warnings],
  })
}

function canonicalJson(value: object): JsonValue {
  if (!isJsonValue(value)) throw new TypeError('NILM tool result must be lossless JSON')
  return value as JsonValue
}

function eventQuality(warnings: readonly string[]): {
  coverage: number
  provisional: boolean
  gaps: Array<{ start: string; end: string; reason: string }>
  source: 'preaggregated' | 'raw' | 'cold' | 'mixed'
  warnings: string[]
} {
  return { coverage: 1, provisional: false, gaps: [], source: 'raw', warnings: [...warnings] }
}

async function costFor(
  ctx: NilmToolHost,
  callContext: CallContext,
  buckets: readonly EnergyBucket[],
  range: TimeRangeSpec,
  signal: AbortSignal,
): Promise<{
  totalCost: number
  byPeriod: Record<string, { energyKwh: number; cost: number }>
  precise: boolean
  warnings: string[]
}> {
  const plan = await ctx.nilmTariff.effectivePlan(callContext, Date.parse(range.start), signal)
  const segmentation = await ctx.nilmTariff.splitByTariff(callContext, range, plan.planId, signal)
  const cost = ctx.nilmAnalytics.calculateEnergyCosts(buckets, segmentation.slices, plan)
  return {
    totalCost: cost.totalCost,
    byPeriod: cost.byPeriod,
    precise: cost.precise,
    warnings: [
      ...segmentation.warnings,
      ...cost.warnings,
      ...segmentation.gaps.map(gap => `unpriced ${gap.reason} interval ${businessIso(gap.startMs)}~${businessIso(gap.endMs)}`),
    ],
  }
}

async function compareEnergy(
  ctx: NilmToolHost,
  callContext: CallContext,
  meterSet: Parameters<Context['nilmTimeseries']['queryAggregatedEnergy']>[1],
  range: TimeRangeSpec,
  mode: 'previous_period' | 'year_over_year',
  includeCost: boolean,
  signal: AbortSignal,
): Promise<{
  energyDeltaKwh: number
  energyDeltaPct: number | null
  costDelta: number | null
  comparable: boolean
  precise: boolean
  warnings: string[]
}> {
  const startMs = Date.parse(range.start)
  const endMs = Date.parse(range.end)
  const previousStart = mode === 'year_over_year' ? shiftLocalYear(startMs) : startMs - (endMs - startMs)
  const previousEnd = mode === 'year_over_year' ? shiftLocalYear(endMs) : startMs
  const previousRange: TimeRangeSpec = {
    ...range,
    start: new Date(previousStart).toISOString(),
    end: new Date(previousEnd).toISOString(),
  }
  const previous = await ctx.nilmTimeseries.queryAggregatedEnergy(callContext, meterSet, previousRange, range.granularity, signal)
  const currentTotal = await currentEnergy(ctx, callContext, meterSet, range, signal)
  const previousTotal = previous.buckets.reduce((sum, bucket) => sum + bucket.energyKwh, 0)
  const currentCost = includeCost ? await costFor(ctx, callContext, currentTotal.buckets, range, signal) : undefined
  const previousCost = includeCost ? await costFor(ctx, callContext, previous.buckets, previousRange, signal) : undefined
  const currentMetric: PeriodMetric = {
    energyKwh: currentTotal.buckets.reduce((sum, bucket) => sum + bucket.energyKwh, 0),
    coverage: currentTotal.dataQuality.coverage,
    ...(currentCost === undefined ? {} : { cost: currentCost.totalCost }),
  }
  const baselineMetric: PeriodMetric = {
    energyKwh: previousTotal,
    coverage: previous.dataQuality.coverage,
    ...(previousCost === undefined ? {} : { cost: previousCost.totalCost }),
  }
  const trend = ctx.nilmAnalytics.calculateCompareTrends(currentMetric, baselineMetric)
  return {
    energyDeltaKwh: trend.energyDeltaKwh,
    energyDeltaPct: trend.energyDeltaPct ?? null,
    costDelta: trend.costDelta ?? null,
    comparable: trend.comparable,
    precise: trend.precise,
    warnings: trend.warnings,
  }
}

async function currentEnergy(
  ctx: NilmToolHost,
  callContext: CallContext,
  meterSet: Parameters<Context['nilmTimeseries']['queryAggregatedEnergy']>[1],
  range: TimeRangeSpec,
  signal: AbortSignal,
): ReturnType<Context['nilmTimeseries']['queryAggregatedEnergy']> {
  return ctx.nilmTimeseries.queryAggregatedEnergy(callContext, meterSet, range, range.granularity, signal)
}

function shiftLocalYear(ms: number): number {
  const date = new Date(ms + SHANGHAI_OFFSET_MS)
  return Date.UTC(
    date.getUTCFullYear() - 1,
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ) - SHANGHAI_OFFSET_MS
}

function energyChart(title: string, buckets: readonly EnergyBucket[]): ChartSpec | undefined {
  if (buckets.length === 0) return undefined
  const reduced = downsampleBuckets(buckets, 500)
  return {
    version: 1,
    type: 'bar',
    title: `${title} 电量`,
    unit: 'kWh',
    xAxis: { type: 'category', labels: reduced.map(bucket => businessIso(bucket.startMs)) },
    series: [{ name: '电量', data: reduced.map(bucket => round(bucket.energyKwh)) }],
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function businessIso(ms: number): string {
  return `${new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, 'Z').slice(0, -1)}+08:00`
}

function isNilmError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
