/**
 * Authorized NILM timeseries routing across hot, pre-aggregated, and cold sources.
 * Raw data is bounded, downsampled before model or chart consumption, and always
 * returned with coverage and gap metadata.
 * @module @deepseek-ai/dsh-nilm-timeseries
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NilmError,
  type CallContext,
  type EnergyBucket,
  type MeterPoint,
  type NilmDataQuality,
  type TelemetryPoint,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'
import {
  Config,
  resolveTimeseriesConfig,
  type TimeseriesConfig,
} from './config.ts'

export { Config, DEFAULT_TIMESERIES_CONFIG, resolveTimeseriesConfig } from './config.ts'
export type { TimeseriesConfig } from './config.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmTimeseries: NilmTimeseriesService
  }
}

/** One realtime query result with its quality envelope. */
export interface RealtimeQueryResult {
  /** Authorized samples in ascending order. */
  points: TelemetryPoint[]
  /** Coverage, provenance, gaps, and warnings. */
  dataQuality: NilmDataQuality
  /** Non-fatal routing or limit caveats. */
  warnings: string[]
}

/** One energy query result with its quality envelope. */
export interface EnergyQueryResult {
  /** Energy buckets in ascending order. */
  buckets: EnergyBucket[]
  /** Coverage, provenance, gaps, and warnings. */
  dataQuality: NilmDataQuality
  /** Non-fatal routing or limit caveats. */
  warnings: string[]
}

/** One upstream NILM appliance-state sample. */
export interface ApplianceStatePoint {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Upstream terminal tag (`device_id`). */
  terminalId: string
  /** Upstream appliance category number. */
  applianceNum: number
  /** True when `appliance_state` is 1. */
  running: boolean
  /** Realtime power in kW, absent when upstream supplies none. */
  powerKw: number | null
  /** Current in A, absent when upstream supplies none. */
  currentA: number | null
}

/** Appliance-state query result with coverage and provenance. */
export interface ApplianceQueryResult {
  /** Authorized samples in ascending time order. */
  points: ApplianceStatePoint[]
  /** Coverage and provenance envelope. */
  dataQuality: NilmDataQuality
  /** Non-fatal routing or limit caveats. */
  warnings: string[]
}

/** Realtime columns fetched for power-quality and edge analysis. */
export const ANALYSIS_METRICS = [
  'power',
  'reactive_power',
  'power_factor',
  'ih1',
  'ih2',
  'ih3',
  'ih5',
  'ih7',
  'urms',
  'irms',
  'line_voltage',
  'line_current',
] as const

/** One accepted analysis metric. */
export type AnalysisMetric = typeof ANALYSIS_METRICS[number]

/** One raw realtime row kept for deterministic analysis. */
export interface AnalysisSample {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Authorized terminal. */
  terminalId: string
  /** Authorized channel. */
  channelId: MeterPoint['channelId']
  /** Active power in kW. */
  powerKw: number | null
  /** Reactive power in kvar. */
  reactivePowerKvar: number | null
  /** Upstream power factor. */
  powerFactor: number | null
  /** Harmonic current magnitudes in amperes. */
  harmonicCurrentA: Partial<Record<'1' | '2' | '3' | '5' | '7', number | null>>
  /** RMS voltage in volts. */
  voltageV: number | null
  /** RMS current in amperes. */
  currentA: number | null
  /** Line voltage in volts. */
  lineVoltageV: number | null
  /** Line current in amperes. */
  lineCurrentA: number | null
}

/** Raw analysis query result with its quality envelope. */
export interface AnalysisQueryResult {
  /** Samples in ascending time order. */
  samples: AnalysisSample[]
  /** Coverage, provenance, gaps, and warnings. */
  dataQuality: NilmDataQuality
  /** Non-fatal routing or limit caveats. */
  warnings: string[]
}

/** Minimal source operations consumed by this adapter. */
export interface TimeseriesSource {
  /**
   * @param sql - internally generated TDengine statement.
   * @param signal - caller cancellation.
   * @returns rows keyed by column name.
   */
  queryHot<T>(sql: string, signal?: AbortSignal): Promise<T[]>
  /**
   * @param sql - internally generated TDengine statement.
   * @param signal - caller cancellation.
   * @returns rows keyed by column name.
   */
  queryStats<T>(sql: string, signal?: AbortSignal): Promise<T[]>
  /**
   * @param template - server-owned cold template.
   * @param params - bound scalar values.
   * @param signal - caller cancellation.
   * @returns proxy response body.
   */
  queryCold(
    template: string,
    params: Record<string, string | number | boolean | null>,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** Optional dependency overrides. */
export interface NilmTimeseriesDependencies {
  /** Source adapter replacing the bundled connection owner. */
  source?: TimeseriesSource
  /** Clock override for route-age tests. */
  now?: () => number
}

/** Realtime columns accepted from Tool input. */
export const REALTIME_METRICS = [
  'power',
  'reactive_power',
  'apparent_power',
  'power_factor',
  'power_angle',
  'urms',
  'irms',
  'freq',
  'line_voltage',
  'line_current',
  'ih1',
  'ih2',
  'ih3',
  'ih5',
  'ih7',
] as const

/** One accepted realtime metric. */
export type RealtimeMetric = typeof REALTIME_METRICS[number]

const METRICS = new Set<string>(REALTIME_METRICS)
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86_400_000

/** Authorized timeseries router. Performs no model calls and stores no state. */
export class NilmTimeseriesService extends Service {
  /** Cordis configuration schema. */
  static Config = Config

  private readonly config: TimeseriesConfig
  private readonly source: TimeseriesSource
  private readonly now: () => number

  /**
   * @param ctx - owning plugin context.
   * @param config - optional table and limit overrides.
   * @param dependencies - source and clock overrides.
   */
  constructor(
    ctx: Context,
    config: Partial<TimeseriesConfig> = {},
    dependencies: NilmTimeseriesDependencies = {},
  ) {
    super(ctx, 'nilmTimeseries')
    this.config = validateConfig(resolveTimeseriesConfig(config))
    this.source = dependencies.source ?? sourcePort(ctx.get('nilmSource')!)
    this.now = dependencies.now ?? (() => Date.now())
  }

  /**
   * Query authorized realtime points and downsample them to the configured limit.
   * @param callContext - verified caller identity.
   * @param meterSet - non-overlapping authorized meters.
   * @param range - half-open business range.
   * @param metrics - upstream metric names from {@link REALTIME_METRICS}.
   * @param signal - optional caller cancellation.
   * @returns points, warnings, and coverage metadata.
   */
  async queryRealtimePoints(
    callContext: CallContext,
    meterSet: readonly MeterPoint[],
    range: TimeRangeSpec,
    metrics: readonly string[],
    signal?: AbortSignal,
  ): Promise<RealtimeQueryResult> {
    requireContext(callContext)
    const window = parseRange(range)
    const columns = uniqueMetrics(metrics)
    const warnings: string[] = []
    const collected: TelemetryPoint[] = []
    for (const meter of meterSet) {
      const channel = meter.channelId as string
      const summarized = await this.realtimeRows(this.config.summarizedRealtimeTable, channel, window, columns, signal)
      const raw = await this.realtimeRows(this.config.realtimeTable, channel, window, columns, signal)
      const merged = mergeRealtime(meter, summarized, raw, warnings)
      collected.push(...merged)
    }
    const points = downsamplePoints(collected, this.config.rawPointLimit)
    if (points.length < collected.length) {
      warnings.push(`realtime result reduced from ${String(collected.length)} to ${String(points.length)} points`)
    }
    const steps = uniqueTimestamps(collected)
    const dataQuality = quality(
      window,
      steps,
      granularityMs(range.granularity),
      'raw',
      warnings,
      this.now(),
    )
    return { points, dataQuality, warnings }
  }

  /**
   * Query authorized energy buckets through the statistics or cold route when eligible.
   * @param callContext - verified caller identity.
   * @param meterSet - non-overlapping authorized meters.
   * @param range - half-open business range.
   * @param granularity - requested bucket size; defaults to the range granularity.
   * @param signal - optional caller cancellation.
   * @returns energy buckets, warnings, and coverage metadata.
   */
  async queryAggregatedEnergy(
    callContext: CallContext,
    meterSet: readonly MeterPoint[],
    range: TimeRangeSpec,
    granularity: TimeRangeSpec['granularity'] = range.granularity,
    signal?: AbortSignal,
  ): Promise<EnergyQueryResult> {
    requireContext(callContext)
    const window = parseRange(range)
    const ageMs = this.now() - window.startMs
    if (ageMs > this.config.hotDays * DAY_MS) {
      return this.coldEnergy(callContext, meterSet, window, granularity, signal)
    }
    if ((granularity === 'day' || granularity === 'month') && meterSet.some(meter => meter.pathName !== undefined)) {
      const stats = await this.statsEnergy(meterSet, window, granularity, signal)
      if (stats.buckets.length > 0) return stats
    }
    return this.rawEnergy(meterSet, window, granularity, signal)
  }

  /**
   * Query authorized NILM appliance-state samples from the hot database.
   * Upstream rows carry only a terminal `device_id`, so a channel-level scope is
   * restricted by its owning terminal set rather than by channel association.
   * @param callContext - verified caller identity.
   * @param meterSet - non-overlapping authorized meters.
   * @param range - half-open business range.
   * @param applianceNum - optional upstream appliance category filter.
   * @param signal - optional caller cancellation.
   * @returns appliance-state samples, warnings, and coverage metadata.
   */
  async queryApplianceStates(
    callContext: CallContext,
    meterSet: readonly MeterPoint[],
    range: TimeRangeSpec,
    applianceNum?: number,
    signal?: AbortSignal,
  ): Promise<ApplianceQueryResult> {
    requireContext(callContext)
    const window = parseRange(range)
    const terminals = [...new Set(meterSet.map(meter => meter.terminalId as string))].sort()
    if (terminals.length === 0) {
      const warnings = ['no authorized terminal is available for appliance identification']
      return {
        points: [],
        dataQuality: quality(window, [], granularityMs(range.granularity), 'raw', warnings, this.now()),
        warnings,
      }
    }
    if (applianceNum !== undefined && (!Number.isInteger(applianceNum) || applianceNum < 0)) {
      throw new NilmError('INVALID_ARGUMENT', 'applianceNum must be a non-negative integer')
    }
    const filter = applianceNum === undefined ? '' : ` AND appliance_num = ${String(applianceNum)}`
    const sql = `SELECT ts, device_id, appliance_num, appliance_state, realtime_power, irms
      FROM ${identifier(this.config.applianceTable)}
      WHERE device_id IN (${terminals.map(terminal => `'${safeId(terminal)}'`).join(', ')})
        AND ts >= ${String(window.startMs)} AND ts < ${String(window.endMs)}${filter}
      ORDER BY ts LIMIT ${String(this.config.rawPointLimit + 1)}`
    const rows = await this.source.queryHot<Record<string, unknown>>(sql, signal)
    const warnings: string[] = [
      'appliance identification rows are keyed by terminal device_id; this result is an estimate, not a submeter reading',
    ]
    const points: ApplianceStatePoint[] = []
    for (const row of rows) {
      const appliance = typeof row.appliance_num === 'number' ? row.appliance_num : Number(row.appliance_num)
      if (!Number.isFinite(appliance)) continue
      const state = typeof row.appliance_state === 'number' ? row.appliance_state : Number(row.appliance_state)
      if (!Number.isFinite(state)) continue
      const terminal = typeof row.device_id === 'string' ? row.device_id : String(row.device_id ?? '')
      if (!terminals.includes(terminal)) continue
      points.push({
        tsMs: timestamp(row.ts),
        terminalId: terminal,
        applianceNum: appliance,
        running: state === 1,
        powerKw: nullable(row.realtime_power),
        currentA: nullable(row.irms),
      })
    }
    points.sort((left, right) => left.tsMs - right.tsMs || left.terminalId.localeCompare(right.terminalId) || left.applianceNum - right.applianceNum)
    if (points.length > this.config.rawPointLimit) {
      warnings.push(`appliance rows were capped at ${String(this.config.rawPointLimit)} samples`)
      points.length = this.config.rawPointLimit
    }
    const dataQuality = quality(
      window,
      uniqueTimestamps(points.map(point => ({ tsMs: point.tsMs }))),
      granularityMs(range.granularity),
      'raw',
      warnings,
      this.now(),
    )
    return { points, dataQuality, warnings }
  }

  /**
   * Query raw realtime rows for deterministic power-quality and edge analysis.
   * This route is not downsampled: it keeps one row per timestamp up to
   * `analysisPointLimit` so CUSUM sees the original transitions.
   * @param callContext - verified caller identity.
   * @param meterSet - non-overlapping authorized meters.
   * @param range - half-open business range.
   * @param signal - optional caller cancellation.
   * @returns raw samples, coverage, and limit caveats.
   */
  async queryAnalysisSamples(
    callContext: CallContext,
    meterSet: readonly MeterPoint[],
    range: TimeRangeSpec,
    signal?: AbortSignal,
  ): Promise<AnalysisQueryResult> {
    requireContext(callContext)
    const window = parseRange(range)
    const warnings: string[] = []
    const samples: AnalysisSample[] = []
    const perMeterLimit = Math.max(1, Math.floor(this.config.analysisPointLimit / Math.max(1, meterSet.length)))
    if (meterSet.length > 1) {
      warnings.push(`analysis budget of ${String(this.config.analysisPointLimit)} samples was split across ${String(meterSet.length)} meters at ${String(perMeterLimit)} samples each; narrow the scope for full resolution`)
    }
    for (const meter of meterSet) {
      const channel = meter.channelId as string
      const sql = `SELECT ts, power, reactive_power, power_factor, ih1, ih2, ih3, ih5, ih7, urms, irms, line_voltage, line_current
        FROM ${identifier(this.config.realtimeTable)}
        WHERE association_asset = '${safeId(channel)}' AND ts >= ${String(window.startMs)} AND ts < ${String(window.endMs)}
        ORDER BY ts LIMIT ${String(perMeterLimit + 1)}`
      const rows = await this.source.queryHot<Record<string, unknown>>(sql, signal)
      if (rows.length > perMeterLimit) {
        warnings.push(`meter ${channel} analysis rows were capped at ${String(perMeterLimit)} samples`)
      }
      for (const row of rows.slice(0, perMeterLimit)) {
        const sample = analysisSample(row, meter)
        if (sample !== undefined) samples.push(sample)
      }
    }
    samples.sort((left, right) => left.tsMs - right.tsMs || (left.channelId as string).localeCompare(right.channelId as string))
    const dataQuality = quality(
      window,
      uniqueTimestamps(samples),
      granularityMs(range.granularity),
      'raw',
      warnings,
      this.now(),
    )
    return { samples, dataQuality, warnings }
  }

  private async realtimeRows(
    table: string,
    channel: string,
    window: Window,
    metrics: readonly RealtimeMetric[],
    signal?: AbortSignal,
  ): Promise<TelemetryPoint[]> {
    const sql = `SELECT ts, ${metrics.join(', ')} FROM ${identifier(table)}
      WHERE association_asset = '${safeId(channel)}' AND ts >= ${String(window.startMs)} AND ts < ${String(window.endMs)}
      ORDER BY ts LIMIT ${String(this.config.rawPointLimit + 1)}`
    const rows = await this.source.queryHot<Record<string, unknown>>(sql, signal)
    const points: TelemetryPoint[] = []
    for (const row of rows) {
      const tsMs = timestamp(row.ts)
      for (const metric of metrics) {
        const value = row[metric]
        if (typeof value === 'number' && Number.isFinite(value)) {
          points.push({ tsMs, deviceId: channel, channelId: channel as MeterPoint['channelId'], metric, value })
        }
      }
    }
    return points
  }

  private async rawEnergy(
    meterSet: readonly MeterPoint[],
    window: Window,
    granularity: TimeRangeSpec['granularity'],
    signal?: AbortSignal,
  ): Promise<EnergyQueryResult> {
    const warnings: string[] = []
    const buckets: EnergyBucket[] = []
    for (const meter of meterSet) {
      const channel = meter.channelId as string
      const summarized = await this.energyRows(this.config.summarizedEnergyTable, channel, window, false, signal)
      const single = await this.energyRows(this.config.energyTable, channel, window, true, signal)
      const merged = mergeEnergyPoints(summarized, single)
      if (merged.length === 0) {
        warnings.push(`meter ${channel} has no energy samples`)
        continue
      }
      for (let index = 1; index < merged.length; index += 1) {
        const previous = merged[index - 1]!
        const current = merged[index]!
        const delta = current.energy - previous.energy
        if (delta < 0) {
          warnings.push(`meter ${channel} energy decreased at ${businessIso(current.tsMs)}; treated as a meter reset`)
          continue
        }
        distributeEnergy(buckets, previous.tsMs, current.tsMs, delta, window, granularity)
      }
    }
    sortBuckets(buckets)
    const starts = buckets.map(bucket => bucket.startMs)
    const dataQuality = quality(
      window,
      starts,
      bucketWidth(window.startMs, granularity),
      'raw',
      warnings,
      this.now(),
    )
    return { buckets, dataQuality, warnings }
  }

  private async energyRows(
    table: string,
    channel: string,
    window: Window,
    singlePhase: boolean,
    signal?: AbortSignal,
  ): Promise<Array<{ tsMs: number; energy: number }>> {
    const filter = singlePhase ? " AND wiring_method = 'SGL'" : ''
    const sql = `SELECT ts, energy_value FROM ${identifier(table)}
      WHERE association_asset = '${safeId(channel)}' AND ts >= ${String(window.startMs)} AND ts < ${String(window.endMs)}${filter}
      ORDER BY ts LIMIT ${String(this.config.rawPointLimit + 1)}`
    const rows = await this.source.queryHot<Record<string, unknown>>(sql, signal)
    return rows.flatMap(row => {
      const value = row.energy_value
      return typeof value === 'number' && Number.isFinite(value)
        ? [{ tsMs: timestamp(row.ts), energy: value }]
        : []
    })
  }

  private async statsEnergy(
    meterSet: readonly MeterPoint[],
    window: Window,
    granularity: TimeRangeSpec['granularity'],
    signal?: AbortSignal,
  ): Promise<EnergyQueryResult> {
    const warnings: string[] = []
    const buckets: EnergyBucket[] = []
    for (const meter of meterSet) {
      if (meter.pathName === undefined) continue
      const sql = `SELECT ts, statistic_result FROM ${identifier(this.config.dailyStatsTable)}
        WHERE group_name = '${safeString(meter.pathName)}' AND ts >= ${String(window.startMs)} AND ts < ${String(window.endMs)}
        ORDER BY ts LIMIT ${String(this.config.rawPointLimit + 1)}`
      const rows = await this.source.queryStats<Record<string, unknown>>(sql, signal)
      for (const row of rows) {
        const value = row.statistic_result
        if (typeof value !== 'number' || !Number.isFinite(value)) continue
        const tsMs = timestamp(row.ts)
        addToBucket(buckets, bucketStart(tsMs, granularity), bucketStart(tsMs, granularity) + bucketWidth(tsMs, granularity), value)
      }
    }
    sortBuckets(buckets)
    if (buckets.length === 0) return { buckets: [], dataQuality: quality(window, [], bucketWidth(window.startMs, granularity), 'preaggregated', warnings, this.now()), warnings }
    const dataQuality = quality(window, buckets.map(bucket => bucket.startMs), bucketWidth(window.startMs, granularity), 'preaggregated', warnings, this.now())
    return { buckets, dataQuality, warnings }
  }

  private async coldEnergy(
    callContext: CallContext,
    meterSet: readonly MeterPoint[],
    window: Window,
    granularity: TimeRangeSpec['granularity'],
    signal?: AbortSignal,
  ): Promise<EnergyQueryResult> {
    const warnings: string[] = ['cold warehouse data may lag upstream synchronization']
    const buckets: EnergyBucket[] = []
    for (const meter of meterSet) {
      const payload = await this.source.queryCold(this.config.coldTemplate, {
        tenantId: callContext.tenantId,
        meter: meter.pathName ?? (meter.channelId as string),
        startMs: window.startMs,
        endMs: window.endMs,
        granularity,
      }, signal)
      for (const row of coldRows(payload)) {
        const startMs = row.startMs
        const endMs = row.endMs
        const energyKwh = row.energyKwh
        if (Number.isFinite(startMs) && Number.isFinite(endMs) && Number.isFinite(energyKwh) && endMs > startMs) {
          addToBucket(buckets, startMs, endMs, energyKwh)
        }
      }
    }
    sortBuckets(buckets)
    const dataQuality = quality(window, buckets.map(bucket => bucket.startMs), bucketWidth(window.startMs, granularity), 'cold', warnings, this.now())
    return { buckets, dataQuality, warnings }
  }
}

interface Window {
  startMs: number
  endMs: number
}

function analysisSample(row: Record<string, unknown>, meter: MeterPoint): AnalysisSample | undefined {
  const harmonicCurrentA: AnalysisSample['harmonicCurrentA'] = {
    1: nullable(row.ih1),
    2: nullable(row.ih2),
    3: nullable(row.ih3),
    5: nullable(row.ih5),
    7: nullable(row.ih7),
  }
  const sample: AnalysisSample = {
    tsMs: timestamp(row.ts),
    terminalId: meter.terminalId as string,
    channelId: meter.channelId,
    powerKw: nullable(row.power),
    reactivePowerKvar: nullable(row.reactive_power),
    powerFactor: nullable(row.power_factor),
    harmonicCurrentA,
    voltageV: nullable(row.urms),
    currentA: nullable(row.irms),
    lineVoltageV: nullable(row.line_voltage),
    lineCurrentA: nullable(row.line_current),
  }
  const numeric = [
    sample.powerKw,
    sample.reactivePowerKvar,
    sample.powerFactor,
    sample.voltageV,
    sample.currentA,
    sample.lineVoltageV,
    sample.lineCurrentA,
    ...Object.values(harmonicCurrentA),
  ]
  return numeric.some(value => value !== null && value !== undefined) ? sample : undefined
}

function sourcePort(source: NilmSourceService): TimeseriesSource {
  return {
    queryHot: (sql, signal) => source.queryHot(sql, signal),
    queryStats: (sql, signal) => source.queryStats(sql, signal),
    queryCold: (template, params, signal) => source.queryCold(template, params, signal),
  }
}

function validateConfig(config: TimeseriesConfig): TimeseriesConfig {
  for (const table of [
    config.realtimeTable,
    config.summarizedRealtimeTable,
    config.energyTable,
    config.summarizedEnergyTable,
    config.dailyStatsTable,
    config.applianceTable,
  ]) identifier(table)
  if (!IDENTIFIER.test(config.coldTemplate)) throw new NilmError('INVALID_ARGUMENT', 'cold template must be a bare identifier')
  return config
}

function requireContext(callContext: CallContext): void {
  if (callContext.tenantId.length === 0) throw new NilmError('UNAUTHORIZED_TENANT', 'call context tenant is required')
}

function parseRange(range: TimeRangeSpec): Window {
  const startMs = Date.parse(range.start)
  const endMs = Date.parse(range.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new NilmError('INVALID_ARGUMENT', 'time range must contain two ordered ISO instants')
  }
  if (range.timeZone !== 'Asia/Shanghai') throw new NilmError('INVALID_ARGUMENT', 'only Asia/Shanghai business time is supported')
  return { startMs, endMs }
}

function uniqueMetrics(metrics: readonly string[]): RealtimeMetric[] {
  if (metrics.length === 0) throw new NilmError('INVALID_ARGUMENT', 'at least one metric is required')
  const out: RealtimeMetric[] = []
  for (const metric of metrics) {
    if (!METRICS.has(metric)) throw new NilmError('INVALID_ARGUMENT', `unsupported metric ${JSON.stringify(metric)}`)
    if (!out.includes(metric as RealtimeMetric)) out.push(metric as RealtimeMetric)
  }
  return out
}

function mergeRealtime(
  meter: MeterPoint,
  summarized: readonly TelemetryPoint[],
  raw: readonly TelemetryPoint[],
  warnings: string[],
): TelemetryPoint[] {
  const byKey = new Map<string, TelemetryPoint>()
  for (const point of [...summarized, ...raw]) {
    const key = `${point.metric}\u0000${String(point.tsMs)}`
    if (!byKey.has(key)) byKey.set(key, { ...point, deviceId: meter.terminalId as string })
  }
  if (summarized.length > 0 && raw.length > 0) warnings.push('summarized realtime rows took precedence over duplicate raw rows')
  return [...byKey.values()].sort((left, right) => left.tsMs - right.tsMs || left.metric.localeCompare(right.metric))
}

function mergeEnergyPoints(
  summarized: ReadonlyArray<{ tsMs: number; energy: number }>,
  single: ReadonlyArray<{ tsMs: number; energy: number }>,
): Array<{ tsMs: number; energy: number }> {
  const byTs = new Map<number, { tsMs: number; energy: number }>()
  for (const point of [...summarized, ...single]) if (!byTs.has(point.tsMs)) byTs.set(point.tsMs, point)
  return [...byTs.values()].sort((left, right) => left.tsMs - right.tsMs)
}

/**
 * Reduce points with a per-metric uniform stride while retaining first and last.
 * @param points - points in any order.
 * @param maxPoints - maximum returned points.
 * @returns deterministic bounded points in ascending time order.
 */
export function downsamplePoints(points: readonly TelemetryPoint[], maxPoints: number): TelemetryPoint[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 1) throw new NilmError('INVALID_ARGUMENT', 'maxPoints must be a positive integer')
  if (points.length <= maxPoints) return [...points].sort((left, right) => left.tsMs - right.tsMs)
  const byMetric = new Map<string, TelemetryPoint[]>()
  for (const point of points) {
    const group = byMetric.get(point.metric) ?? []
    group.push(point)
    byMetric.set(point.metric, group)
  }
  const budget = Math.max(1, Math.floor(maxPoints / byMetric.size))
  const out: TelemetryPoint[] = []
  for (const group of byMetric.values()) {
    out.push(...uniformSample(group.sort((left, right) => left.tsMs - right.tsMs), budget))
  }
  out.sort((left, right) => left.tsMs - right.tsMs || left.metric.localeCompare(right.metric))
  return out.slice(0, maxPoints)
}

/**
 * Reduce energy buckets while retaining first and last.
 * @param buckets - buckets in any order.
 * @param maxBuckets - maximum returned buckets.
 * @returns deterministic bounded buckets in ascending time order.
 */
export function downsampleBuckets(buckets: readonly EnergyBucket[], maxBuckets: number): EnergyBucket[] {
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1) throw new NilmError('INVALID_ARGUMENT', 'maxBuckets must be a positive integer')
  return uniformSample([...buckets].sort((left, right) => left.startMs - right.startMs), maxBuckets)
}

function uniformSample<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values]
  if (limit === 1) return [values[0]!]
  const out: T[] = []
  const step = (values.length - 1) / (limit - 1)
  for (let index = 0; index < limit; index += 1) out.push(values[Math.round(index * step)]!)
  return out
}

function distributeEnergy(
  buckets: EnergyBucket[],
  startMs: number,
  endMs: number,
  energy: number,
  window: Window,
  granularity: TimeRangeSpec['granularity'],
): void {
  if (energy === 0 || endMs <= startMs) return
  let cursor = Math.max(startMs, window.startMs)
  const limit = Math.min(endMs, window.endMs)
  const total = endMs - startMs
  while (cursor < limit) {
    const sliceStart = bucketStart(cursor, granularity)
    const bucketEnd = Math.min(limit, sliceStart + bucketWidth(cursor, granularity))
    const share = (bucketEnd - cursor) / total
    addToBucket(buckets, sliceStart, sliceStart + bucketWidth(cursor, granularity), energy * share)
    cursor = bucketEnd
  }
}

function addToBucket(buckets: EnergyBucket[], startMs: number, endMs: number, energyKwh: number): void {
  const existing = buckets.find(bucket => bucket.startMs === startMs && bucket.endMs === endMs)
  if (existing === undefined) buckets.push({ startMs, endMs, energyKwh })
  else existing.energyKwh += energyKwh
}

function sortBuckets(buckets: EnergyBucket[]): void {
  buckets.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs)
}

function bucketStart(tsMs: number, granularity: TimeRangeSpec['granularity']): number {
  const local = tsMs + SHANGHAI_OFFSET_MS
  if (granularity === 'month') {
    const date = new Date(local)
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS
  }
  if (granularity === 'day') {
    return Math.floor(local / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS
  }
  return Math.floor(tsMs / granularityMs(granularity)) * granularityMs(granularity)
}

function bucketWidth(tsMs: number, granularity: TimeRangeSpec['granularity']): number {
  if (granularity !== 'month') return granularityMs(granularity)
  const date = new Date(tsMs + SHANGHAI_OFFSET_MS)
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - SHANGHAI_OFFSET_MS
  return next - bucketStart(tsMs, granularity)
}

function granularityMs(granularity: TimeRangeSpec['granularity']): number {
  switch (granularity) {
    case 'second': return 1000
    case 'minute': return 60_000
    case '15min': return 900_000
    case 'hour': return 3_600_000
    case 'day': return DAY_MS
    case 'month': return 30 * DAY_MS
    default: return assertNever(granularity)
  }
}

function quality(
  window: Window,
  observed: readonly number[],
  stepMs: number,
  source: NilmDataQuality['source'],
  warnings: string[],
  nowMs: number,
): NilmDataQuality {
  const expected = Math.max(1, Math.ceil((window.endMs - window.startMs) / stepMs))
  const unique = [...new Set(observed)].sort((left, right) => left - right)
  const gaps = gapIntervals(window, unique, stepMs)
  if (gaps.length > 100) warnings.push(`gap list truncated from ${String(gaps.length)} intervals`)
  return {
    coverage: Math.min(1, unique.length / expected),
    ...(unique.length === 0 ? {} : { lastSampleAt: businessIso(unique.at(-1)!) }),
    provisional: window.endMs > nowMs - 5 * 60_000,
    gaps: gaps.slice(0, 100).map(gap => ({ start: businessIso(gap.startMs), end: businessIso(gap.endMs), reason: 'missing_samples' })),
    source,
    warnings,
  }
}

function gapIntervals(window: Window, observed: readonly number[], stepMs: number): Array<{ startMs: number; endMs: number }> {
  const gaps: Array<{ startMs: number; endMs: number }> = []
  let cursor = window.startMs
  for (const instant of observed) {
    if (instant > cursor + stepMs) gaps.push({ startMs: cursor, endMs: Math.min(instant, window.endMs) })
    cursor = Math.max(cursor, instant + stepMs)
    if (cursor >= window.endMs) break
  }
  if (cursor < window.endMs) gaps.push({ startMs: cursor, endMs: window.endMs })
  return gaps
}

function uniqueTimestamps(points: readonly { tsMs: number }[]): number[] {
  return [...new Set(points.map(point => point.tsMs))].sort((left, right) => left - right)
}

function nullable(value: unknown): number | null {
  const number = typeof value === 'number' ? value : Number(value)
  return value === null || value === undefined || !Number.isFinite(number) ? null : number
}

function timestamp(value: unknown): number {
  if (typeof value === 'number') {
    if (value >= 1e17) return value / 1e6
    if (value >= 1e14) return value / 1e3
    if (value >= 1e9 && value < 1e11) return value * 1e3
    return value
  }
  if (typeof value === 'string') {
    const numeric = Number(value)
    if (Number.isFinite(numeric) && value.trim().length > 0) return timestamp(numeric)
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  throw new NilmError('DATA_UNAVAILABLE', 'source returned an unparseable timestamp')
}

function coldRows(payload: unknown): Array<{ startMs: number; endMs: number; energyKwh: number }> {
  const rows = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { rows?: unknown }).rows)
      ? (payload as { rows: unknown[] }).rows
      : []
  return rows.flatMap(row => {
    if (row === null || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    const startMs = typeof record.startMs === 'number' ? record.startMs : Number(record.startMs)
    const endMs = typeof record.endMs === 'number' ? record.endMs : Number(record.endMs)
    const energyKwh = typeof record.energyKwh === 'number' ? record.energyKwh : Number(record.energyKwh)
    return Number.isFinite(startMs) && Number.isFinite(endMs) && Number.isFinite(energyKwh)
      ? [{ startMs, endMs, energyKwh }]
      : []
  })
}

function identifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new NilmError('INVALID_ARGUMENT', `unsafe SQL identifier ${JSON.stringify(value)}`)
  return value
}

function safeId(value: string): string {
  if (!SAFE_ID.test(value)) throw new NilmError('INVALID_ARGUMENT', `unsafe source identifier ${JSON.stringify(value)}`)
  return value
}

function safeString(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new NilmError('INVALID_ARGUMENT', 'source string contains a control character')
  }
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function businessIso(ms: number): string {
  return `${new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, -1)}+08:00`
}

function assertNever(value: never): never {
  throw new NilmError('INVALID_ARGUMENT', `unsupported granularity ${String(value)}`)
}

export default NilmTimeseriesService
