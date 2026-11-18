/**
 * Pure NILM calculations over already authorized, already fetched values.
 * Functions here perform no IO and never consult the clock.
 * @module @deepseek-ai/dsh-nilm-analytics
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { NilmError, type EnergyBucket } from '@deepseek-ai/dsh-nilm-core'
import type { TariffPeriodType, TariffPlan, TariffSlice } from '@deepseek-ai/dsh-nilm-tariff'
import {
  analyzePowerQuality,
  energyWeightedPowerFactor,
  type PowerQualityOptions,
  type PowerQualityResult,
  type PowerQualitySample,
} from './power-quality.ts'
import {
  detectTimeSeriesFeatures,
  type CusumOptions,
  type TimeSeriesFeatureResult,
  type TimeSeriesSample,
} from './cusum.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmAnalytics: NilmAnalyticsService
  }
}

export type { EnergyBucket }
export {
  analyzePowerQuality,
  energyWeightedPowerFactor,
  phaseUnbalancePct,
  type HarmonicBand,
  type HarmonicCurrentOrder,
  type HarmonicOrder,
  type Phase,
  type PowerQualityOptions,
  type PowerQualityResult,
  type PowerQualitySample,
} from './power-quality.ts'
export {
  detectPowerEdges,
  detectTimeSeriesFeatures,
  diagnoseMicroHazards,
  pairCycles,
  type CusumOptions,
  type DetectedEdge,
  type InferredCycle,
  type MicroHazard,
  type TimeSeriesFeature,
  type TimeSeriesFeatureResult,
  type TimeSeriesSample,
} from './cusum.ts'

/** Energy and cost totals split by tariff band. */
export interface CostBreakdown {
  /** Energy supplied by the buckets. */
  totalEnergyKwh: number
  /** Energy that fell inside at least one priced slice. */
  pricedEnergyKwh: number
  /** Energy that no slice could price. */
  unpricedEnergyKwh: number
  /** Total priced cost in the deployment currency. */
  totalCost: number
  /** Per-band totals, always containing all four bands. */
  byPeriod: Record<TariffPeriodType, { energyKwh: number; cost: number }>
  /** False when any energy could not be priced. */
  precise: boolean
  /** Deterministic explanation of unpriced energy or empty plans. */
  warnings: string[]
}

/** One period metric used for comparison. */
export interface PeriodMetric {
  /** Energy over the period. */
  energyKwh: number
  /** Cost over the period when the caller has a priced result. */
  cost?: number
  /** Expected-sample coverage from 0 to 1. */
  coverage: number
}

/** Comparison result that separates arithmetic from reliability. */
export interface CompareTrend {
  /** Signed current-minus-baseline energy. */
  energyDeltaKwh: number
  /** Signed energy ratio, absent when the baseline is zero. */
  energyDeltaPct?: number
  /** Signed current-minus-baseline cost, absent when either side lacks cost. */
  costDelta?: number
  /** Signed cost ratio, absent when either side lacks cost or the baseline is zero. */
  costDeltaPct?: number
  /** False when coverage differs by more than two percentage points. */
  comparable: boolean
  /** False when either period is below 95% coverage; costs are estimates. */
  precise: boolean
  /** Deterministic caveats for the model and BFF. */
  warnings: string[]
}

/** One state transition observed for running/idle accounting. */
export interface DeviceTransition {
  /** Transition instant in epoch milliseconds. */
  ts: number
  /** Equipment is running. */
  isRunning: boolean
  /** Equipment is powered but idle. */
  isIdle: boolean
}

/** Debounced running and idle totals. */
export interface RunningIdleResult {
  /** Debounced running minutes. */
  runningMinutes: number
  /** Debounced idle minutes. */
  idleMinutes: number
  /** Share of the window covered by a known running or idle state. */
  validRatio: number
  /** Window portions with no known state. */
  unknownMinutes: number
}

/** One appliance-state sample from the upstream NILM disaggregation table. */
export interface ApplianceStateSample {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Upstream terminal that produced the sample. */
  terminalId: string
  /** Upstream appliance category number. */
  applianceNum: number
  /** True when the upstream state is running. */
  running: boolean
  /** Observed realtime power in kW, absent when upstream supplies none. */
  powerKw: number | null
  /** Observed current in A, absent when upstream supplies none. */
  currentA: number | null
}

/** Deterministic usage totals for one terminal-local appliance. */
export interface ApplianceUsage {
  /** Upstream terminal identifier. */
  terminalId: string
  /** Upstream appliance category number. */
  applianceNum: number
  /** Minutes observed running. */
  runningMinutes: number
  /** Minutes observed stopped. */
  stoppedMinutes: number
  /** Minutes with no trustworthy adjacent sample. */
  unknownMinutes: number
  /** Energy estimated by integrating running realtime power. */
  estimatedEnergyKwh: number
  /** Number of upstream samples used. */
  sampleCount: number
  /** Local caveats for this appliance. */
  warnings: string[]
}

const PERIODS: readonly TariffPeriodType[] = ['sharp', 'peak', 'flat', 'valley']

/**
 * Price energy buckets against non-overlapping tariff slices, prorating a bucket
 * uniformly when slice boundaries fall inside it.
 * @param buckets - energy amounts in any order.
 * @param slices - priced slices from {@link splitRangeByTariff}.
 * @param plan - plan that supplied the slices; its id is used for diagnostics.
 * @returns totals by band and explicit unpriced energy.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed values or overlapping slices.
 */
export function calculateEnergyCosts(
  buckets: readonly EnergyBucket[],
  slices: readonly TariffSlice[],
  plan: Pick<TariffPlan, 'planId'>,
): CostBreakdown {
  validateSlices(slices)
  const byPeriod = emptyByPeriod()
  let totalEnergyKwh = 0
  let pricedEnergyKwh = 0
  let totalCost = 0
  const warnings: string[] = []
  for (const [index, bucket] of buckets.entries()) {
    requireFinite(bucket.startMs, `buckets[${String(index)}].startMs`)
    requireFinite(bucket.endMs, `buckets[${String(index)}].endMs`)
    requireFinite(bucket.energyKwh, `buckets[${String(index)}].energyKwh`)
    if (bucket.endMs <= bucket.startMs) throw invalid(`buckets[${String(index)}] ends before it starts`)
    if (bucket.energyKwh < 0) throw invalid(`buckets[${String(index)}].energyKwh must not be negative`)
    const durationMs = bucket.endMs - bucket.startMs
    const overlaps = slices
      .map(slice => ({
        slice,
        startMs: Math.max(bucket.startMs, slice.startMs),
        endMs: Math.min(bucket.endMs, slice.endMs),
      }))
      .filter(overlap => overlap.endMs > overlap.startMs)
    const coveredMs = overlaps.reduce((sum, overlap) => sum + overlap.endMs - overlap.startMs, 0)
    const energyPerMs = bucket.energyKwh / durationMs
    for (const overlap of overlaps) {
      const energyKwh = energyPerMs * (overlap.endMs - overlap.startMs)
      const cost = energyKwh * overlap.slice.pricePerKwh
      totalEnergyKwh += energyKwh
      pricedEnergyKwh += energyKwh
      totalCost += cost
      byPeriod[overlap.slice.periodType].energyKwh += energyKwh
      byPeriod[overlap.slice.periodType].cost += cost
    }
    if (coveredMs === 0) {
      totalEnergyKwh += bucket.energyKwh
      warnings.push(`bucket ${String(index)} has no tariff slice and ${String(bucket.energyKwh)} kWh remains unpriced`)
    } else if (coveredMs < durationMs) {
      totalEnergyKwh += bucket.energyKwh
    }
  }
  const rawUnpriced = totalEnergyKwh - pricedEnergyKwh
  const unpricedEnergyKwh = Math.abs(rawUnpriced) <= Number.EPSILON * Math.max(1, totalEnergyKwh) * 8
    ? 0
    : Math.max(0, rawUnpriced)
  if (slices.length === 0) warnings.push(`plan ${plan.planId} supplied no priced slices`)
  if (unpricedEnergyKwh > 0 && slices.length > 0) {
    warnings.push(`${String(unpricedEnergyKwh)} kWh falls outside the priced slices`)
  }
  return {
    totalEnergyKwh,
    pricedEnergyKwh,
    unpricedEnergyKwh,
    totalCost,
    byPeriod,
    precise: unpricedEnergyKwh === 0,
    warnings,
  }
}

/**
 * Debounce known running/idle states and total them inside a window.
 * A state segment shorter than `minDwellMs` merges into its predecessor, or
 * into its successor when it is the first segment. Unknown segments stay
 * unknown and reduce `validRatio`; they are never treated as idle.
 * @param transitions - observed transitions; order is irrelevant.
 * @param window - half-open window in epoch milliseconds.
 * @param minDwellMs - minimum credible state dwell.
 * @returns running and idle minutes plus unknown time.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed values or contradictory states.
 */
export function calculateRunningAndIdleTime(
  transitions: readonly DeviceTransition[],
  window: { readonly startMs: number; readonly endMs: number },
  minDwellMs: number,
): RunningIdleResult {
  requireFinite(window.startMs, 'window.startMs')
  requireFinite(window.endMs, 'window.endMs')
  requireFinite(minDwellMs, 'minDwellMs')
  if (window.endMs <= window.startMs) throw invalid('window end must be after window start')
  if (minDwellMs < 0) throw invalid('minDwellMs must not be negative')
  const sorted = [...transitions].sort((left, right) => left.ts - right.ts)
  for (const [index, transition] of sorted.entries()) {
    requireFinite(transition.ts, `transitions[${String(index)}].ts`)
    if (transition.isRunning && transition.isIdle) throw invalid('a transition cannot be running and idle at once')
  }
  let state: 'running' | 'idle' | 'unknown' = 'unknown'
  for (const transition of sorted) {
    if (transition.ts > window.startMs) break
    state = stateOf(transition)
  }
  const raw: Array<{ startMs: number; endMs: number; state: 'running' | 'idle' | 'unknown' }> = []
  let cursor = window.startMs
  for (const transition of sorted) {
    if (transition.ts <= window.startMs) continue
    if (transition.ts >= window.endMs) break
    if (transition.ts > cursor) raw.push({ startMs: cursor, endMs: transition.ts, state })
    state = stateOf(transition)
    cursor = transition.ts
  }
  raw.push({ startMs: cursor, endMs: window.endMs, state })
  const debounced = debounce(raw, minDwellMs)
  let runningMs = 0
  let idleMs = 0
  let unknownMs = 0
  for (const segment of debounced) {
    const duration = segment.endMs - segment.startMs
    if (segment.state === 'running') runningMs += duration
    else if (segment.state === 'idle') idleMs += duration
    else unknownMs += duration
  }
  const totalMs = window.endMs - window.startMs
  return {
    runningMinutes: runningMs / 60_000,
    idleMinutes: idleMs / 60_000,
    validRatio: (runningMs + idleMs) / totalMs,
    unknownMinutes: unknownMs / 60_000,
  }
}

/**
 * Compare two period metrics while retaining coverage caveats.
 * @param current - current period.
 * @param baseline - previous period or the same period one year earlier.
 * @returns signed deltas and comparability flags.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed metrics.
 */
export function calculateCompareTrends(current: PeriodMetric, baseline: PeriodMetric): CompareTrend {
  validateMetric(current, 'current')
  validateMetric(baseline, 'baseline')
  const energyDeltaKwh = current.energyKwh - baseline.energyKwh
  const precise = current.coverage >= 0.95 && baseline.coverage >= 0.95
  const comparable = Math.abs(current.coverage - baseline.coverage) <= 0.02
  const warnings: string[] = []
  if (!precise) warnings.push('coverage below 95%; cost and energy comparisons are estimates')
  if (!comparable) warnings.push('coverage differs by more than 2 percentage points; comparability is reduced')
  const result: CompareTrend = {
    energyDeltaKwh,
    comparable,
    precise,
    warnings,
  }
  if (baseline.energyKwh !== 0) result.energyDeltaPct = energyDeltaKwh / baseline.energyKwh
  if (current.cost !== undefined && baseline.cost !== undefined) {
    result.costDelta = current.cost - baseline.cost
    if (baseline.cost !== 0) result.costDeltaPct = result.costDelta / baseline.cost
  }
  return result
}

/**
 * Summarize running and stopped time plus integrated energy per terminal appliance.
 * Intervals longer than `maxGapMs` are unknown rather than attributed to the last state.
 * @param points - already authorized appliance-state samples.
 * @param window - half-open accounting window.
 * @param maxGapMs - maximum adjacent-sample distance credited to one state.
 * @returns one usage row per terminal and appliance number, in stable order.
 */
export function summarizeApplianceStates(
  points: readonly ApplianceStateSample[],
  window: { startMs: number; endMs: number },
  maxGapMs = 15 * 60_000,
): ApplianceUsage[] {
  requireFinite(window.startMs, 'window.startMs')
  requireFinite(window.endMs, 'window.endMs')
  requireFinite(maxGapMs, 'maxGapMs')
  if (window.endMs <= window.startMs) throw invalid('window ends before it starts')
  if (maxGapMs <= 0) throw invalid('maxGapMs must be positive')
  const groups = new Map<string, ApplianceStateSample[]>()
  for (const [index, point] of points.entries()) {
    requireFinite(point.tsMs, `points[${String(index)}].tsMs`)
    requireFinite(point.applianceNum, `points[${String(index)}].applianceNum`)
    if (point.powerKw !== null) requireFinite(point.powerKw, `points[${String(index)}].powerKw`)
    if (point.currentA !== null) requireFinite(point.currentA, `points[${String(index)}].currentA`)
    const key = `${point.terminalId}\u0000${String(point.applianceNum)}`
    const group = groups.get(key) ?? []
    group.push(point)
    groups.set(key, group)
  }
  const usages: ApplianceUsage[] = []
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.tsMs - right.tsMs)
    const first = ordered[0]
    if (first === undefined) continue
    let runningMs = 0
    let stoppedMs = 0
    let unknownMs = 0
    let energyKwh = 0
    const warnings: string[] = []
    for (const [index, sample] of ordered.entries()) {
      const next = ordered[index + 1]?.tsMs ?? window.endMs
      const durationMs = Math.max(0, Math.min(next, window.endMs) - Math.max(sample.tsMs, window.startMs))
      if (durationMs === 0) continue
      if (durationMs > maxGapMs) {
        unknownMs += durationMs
        continue
      }
      if (sample.running) {
        runningMs += durationMs
        if (sample.powerKw === null) warnings.push('running samples without realtime power were excluded from energy')
        else energyKwh += sample.powerKw * durationMs / 3_600_000
      } else {
        stoppedMs += durationMs
      }
    }
    if (ordered.length === 1) warnings.push('a single sample cannot establish a reliable state duration')
    if (unknownMs > 0) warnings.push('long sample gaps were left unknown instead of extending the previous state')
    usages.push({
      terminalId: first.terminalId,
      applianceNum: first.applianceNum,
      runningMinutes: runningMs / 60_000,
      stoppedMinutes: stoppedMs / 60_000,
      unknownMinutes: unknownMs / 60_000,
      estimatedEnergyKwh: energyKwh,
      sampleCount: ordered.length,
      warnings: [...new Set(warnings)],
    })
  }
  return usages.sort((left, right) => left.terminalId.localeCompare(right.terminalId) || left.applianceNum - right.applianceNum)
}

/** Cordis service exposing deterministic calculations to model-facing tools. */
export class NilmAnalyticsService extends Service {
  /**
   * @param ctx - owning plugin context.
   */
  constructor(ctx: Context) {
    super(ctx, 'nilmAnalytics')
  }

  /**
   * Price energy buckets against tariff slices.
   * @param buckets - energy amounts.
   * @param slices - priced slices.
   * @param plan - plan that supplied the slices.
   * @returns totals by band.
   */
  calculateEnergyCosts(
    buckets: readonly EnergyBucket[],
    slices: readonly TariffSlice[],
    plan: Pick<TariffPlan, 'planId'>,
  ): CostBreakdown {
    return calculateEnergyCosts(buckets, slices, plan)
  }

  /**
   * Debounce and total running/idle states.
   * @param transitions - observed transitions.
   * @param window - half-open window.
   * @param minDwellMs - minimum credible dwell.
   * @returns running and idle totals.
   */
  calculateRunningAndIdleTime(
    transitions: readonly DeviceTransition[],
    window: { readonly startMs: number; readonly endMs: number },
    minDwellMs: number,
  ): RunningIdleResult {
    return calculateRunningAndIdleTime(transitions, window, minDwellMs)
  }

  /**
   * Compare two period metrics with coverage caveats.
   * @param current - current period.
   * @param baseline - baseline period.
   * @returns signed deltas and comparability flags.
   */
  calculateCompareTrends(current: PeriodMetric, baseline: PeriodMetric): CompareTrend {
    return calculateCompareTrends(current, baseline)
  }

  /**
   * Summarize appliance running, stopped, and estimated energy totals.
   * @param points - already authorized appliance-state samples.
   * @param window - half-open accounting window.
   * @param maxGapMs - maximum adjacent-sample distance credited to one state.
   * @returns usage rows in stable order.
   */
  summarizeApplianceStates(
    points: readonly ApplianceStateSample[],
    window: { startMs: number; endMs: number },
    maxGapMs?: number,
  ): ApplianceUsage[] {
    return summarizeApplianceStates(points, window, maxGapMs)
  }

  /**
   * Calculate billing power factor from active and reactive energy.
   * @param activeKwh - active energy.
   * @param reactiveKvarh - reactive energy.
   * @returns the power factor, or undefined when active energy is not positive.
   */
  energyWeightedPowerFactor(activeKwh: number, reactiveKvarh: number): number | undefined {
    return energyWeightedPowerFactor(activeKwh, reactiveKvarh)
  }

  /**
   * Analyze energy-weighted PF, harmonics, unbalance, and voltage deviation.
   * @param samples - authorized realtime samples.
   * @param window - half-open analysis window.
   * @param options - threshold, nominal voltage, and gap limits.
   * @returns deterministic power-quality totals and caveats.
   */
  analyzePowerQuality(
    samples: readonly PowerQualitySample[],
    window: { readonly startMs: number; readonly endMs: number },
    options?: PowerQualityOptions,
  ): PowerQualityResult {
    return analyzePowerQuality(samples, window, options)
  }

  /**
   * Detect power steps, pair start-stop cycles, and diagnose micro hazards.
   * @param samples - authorized second-level samples.
   * @param window - half-open analysis window.
   * @param options - detection and hazard thresholds.
   * @returns compact events, cycles, hazards, coverage, and caveats.
   */
  detectTimeSeriesFeatures(
    samples: readonly TimeSeriesSample[],
    window: { readonly startMs: number; readonly endMs: number },
    options?: CusumOptions,
  ): TimeSeriesFeatureResult {
    return detectTimeSeriesFeatures(samples, window, options)
  }
}

function debounce(
  segments: Array<{ startMs: number; endMs: number; state: 'running' | 'idle' | 'unknown' }>,
  minDwellMs: number,
): Array<{ startMs: number; endMs: number; state: 'running' | 'idle' | 'unknown' }> {
  const out: Array<{ startMs: number; endMs: number; state: 'running' | 'idle' | 'unknown' }> = []
  for (const segment of segments) {
    const previous = out.at(-1)
    if (previous !== undefined && previous.state === segment.state) {
      previous.endMs = segment.endMs
      continue
    }
    if (previous !== undefined && segment.state !== 'unknown' && segment.endMs - segment.startMs < minDwellMs) {
      previous.endMs = segment.endMs
      continue
    }
    out.push({ ...segment })
  }
  if (out.length > 1) {
    const first = out[0]!
    if (first.state !== 'unknown' && first.endMs - first.startMs < minDwellMs) {
      out[1]!.startMs = first.startMs
      out.shift()
    }
  }
  return out
}

function stateOf(transition: DeviceTransition): 'running' | 'idle' | 'unknown' {
  return transition.isRunning ? 'running' : transition.isIdle ? 'idle' : 'unknown'
}

function emptyByPeriod(): Record<TariffPeriodType, { energyKwh: number; cost: number }> {
  return {
    sharp: { energyKwh: 0, cost: 0 },
    peak: { energyKwh: 0, cost: 0 },
    flat: { energyKwh: 0, cost: 0 },
    valley: { energyKwh: 0, cost: 0 },
  }
}

function validateSlices(slices: readonly TariffSlice[]): void {
  const sorted = [...slices].sort((left, right) => left.startMs - right.startMs)
  for (const [index, slice] of sorted.entries()) {
    requireFinite(slice.startMs, `slices[${String(index)}].startMs`)
    requireFinite(slice.endMs, `slices[${String(index)}].endMs`)
    requireFinite(slice.pricePerKwh, `slices[${String(index)}].pricePerKwh`)
    if (slice.endMs <= slice.startMs) throw invalid(`slices[${String(index)}] ends before it starts`)
    if (slice.pricePerKwh < 0) throw invalid(`slices[${String(index)}].pricePerKwh must not be negative`)
    if (!PERIODS.includes(slice.periodType)) throw invalid(`unknown tariff period ${String(slice.periodType)}`)
    const previous = sorted[index - 1]
    if (previous !== undefined && previous.endMs > slice.startMs) throw invalid('tariff slices overlap')
  }
}

function validateMetric(metric: PeriodMetric, label: string): void {
  requireFinite(metric.energyKwh, `${label}.energyKwh`)
  requireFinite(metric.coverage, `${label}.coverage`)
  if (metric.energyKwh < 0) throw invalid(`${label}.energyKwh must not be negative`)
  if (metric.coverage < 0 || metric.coverage > 1) throw invalid(`${label}.coverage must be between 0 and 1`)
  if (metric.cost !== undefined) {
    requireFinite(metric.cost, `${label}.cost`)
    if (metric.cost < 0) throw invalid(`${label}.cost must not be negative`)
  }
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw invalid(`${label} must be a finite number`)
}

function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}

export default NilmAnalyticsService
