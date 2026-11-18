/**
 * CUSUM step detection and compact feature extraction over second-level power
 * samples. The result is bounded for model consumption and never contains the
 * raw waveform.
 * @module @deepseek-ai/dsh-nilm-analytics/cusum
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import { phaseUnbalancePct, type Phase } from './power-quality.ts'

/** One second-level sample used for edge detection. */
export interface TimeSeriesSample {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Active power in kW, null when upstream has no value at this instant. */
  powerKw: number | null
  /** Reactive power in kvar when available. */
  reactivePowerKvar?: number | null
  /** Current in amperes when available. */
  currentA?: number | null
  /** Upstream power factor when available. */
  powerFactor?: number | null
  /** Per-phase currents when upstream exposes them. */
  phaseCurrentA?: Partial<Record<Phase, number | null>>
  /** Odd harmonic currents in amperes when available. */
  harmonicCurrentA?: Partial<Record<3 | 5 | 7, number | null>>
}

/** One detected power step after steady-state comparison. */
export interface DetectedEdge {
  /** Step instant in epoch milliseconds. */
  atMs: number
  /** Direction inferred from the steady-state change. */
  direction: 'up' | 'down'
  /** Median power before the step in kW. */
  beforeKw: number
  /** Median power after the step in kW. */
  afterKw: number
  /** Signed steady-state change in kW. */
  deltaKw: number
}

/** Compact features for one detected step. */
export interface TimeSeriesFeature extends DetectedEdge {
  /** Signed reactive-power change in kvar, absent when the samples lack Q. */
  deltaReactiveKvar: number | null
  /** How long the step's steady level lasted before the next step or the window end. */
  durationMs: number
  /** Peak current divided by post-startup steady current, absent without current samples. */
  inrushRatio: number | null
  /** Time until current fell back to 1.2x steady current, absent when it never did. */
  inrushDurationMs: number | null
  /** Worst three-phase current unbalance after the step, absent without phase currents. */
  phaseImbalancePct: number | null
  /** Signed harmonic-current change in amperes per order. */
  harmonicDeltaA: Partial<Record<3 | 5 | 7, number | null>>
  /** Mean power factor before the step. */
  powerFactorBefore: number | null
  /** Mean power factor after the step. */
  powerFactorAfter: number | null
  /** Signed power-factor change. */
  powerFactorDelta: number | null
}

/** One inferred start-stop cycle from symmetric up/down steps. */
export interface InferredCycle {
  /** Step-up instant. */
  startMs: number
  /** Step-down instant. */
  endMs: number
  /** Inferred operating power in kW. */
  powerKw: number
  /** Cycle duration in milliseconds. */
  durationMs: number
}

/** One deterministic microscopic hazard finding. */
export interface MicroHazard {
  /** Stable hazard kind. */
  kind: 'frequent_cycling' | 'startup_lag' | 'phase_unbalance' | 'harmonic_resonance'
  /** Deterministic severity. */
  severity: 'warning' | 'critical'
  /** Finding instant in epoch milliseconds. */
  atMs: number
  /** Evidence values cited from the feature set. */
  evidence: Record<string, number | string | null>
}

/** Complete bounded feature payload. */
export interface TimeSeriesFeatureResult {
  /** Detected steps in ascending time order, capped by `maxEvents`. */
  events: TimeSeriesFeature[]
  /** Symmetric start-stop pairs. */
  cycles: InferredCycle[]
  /** Deterministic hazard findings. */
  hazards: MicroHazard[]
  /** Share of the window covered by adjacent finite power samples. */
  coverage: number
  /** Deterministic caveats. */
  warnings: string[]
}

/** Tunables for CUSUM and hazard rules; defaults follow the architecture plan. */
export interface CusumOptions {
  /** CUSUM decision threshold in kW. */
  thresholdKw?: number
  /** CUSUM drift allowance in kW. */
  driftKw?: number
  /** Centered moving-average radius in samples. */
  filterRadius?: number
  /** Samples on each side used for the steady-state median. */
  steadyWindow?: number
  /** Minimum steady-state change accepted as an edge. */
  minDeltaKw?: number
  /** Maximum adjacent-sample distance treated as continuous. */
  maxGapMs?: number
  /** Maximum returned events. */
  maxEvents?: number
  /** Post-edge window for peak current. */
  inrushWindowMs?: number
  /** Post-edge window for steady current and inrush settling. */
  settleWindowMs?: number
  /** Duration above 1.5x steady current that counts as a startup lag. */
  startupLagMs?: number
  /** Start-stop count that triggers the frequent-cycling rule. */
  frequentCycleCount?: number
  /** Sliding window for the frequent-cycling rule. */
  frequentCycleWindowMs?: number
  /** Phase unbalance threshold in percent. */
  unbalanceThresholdPct?: number
  /** Harmonic current increment threshold in amperes. */
  harmonicDeltaThresholdA?: number
  /** Power-factor swing that must accompany a harmonic jump. */
  powerFactorSwingThreshold?: number
  /** Allowed relative asymmetry when pairing an up step with a down step. */
  cycleToleranceRatio?: number
  /** Same-direction detections closer than this are one transition. */
  edgeMergeMs?: number
}

const DEFAULTS = {
  thresholdKw: 1,
  driftKw: 0.05,
  filterRadius: 3,
  steadyWindow: 10,
  minDeltaKw: 0.5,
  maxGapMs: 15_000,
  maxEvents: 20,
  inrushWindowMs: 10_000,
  settleWindowMs: 30_000,
  startupLagMs: 8_000,
  frequentCycleCount: 5,
  frequentCycleWindowMs: 10 * 60_000,
  unbalanceThresholdPct: 15,
  harmonicDeltaThresholdA: 1,
  powerFactorSwingThreshold: 0.05,
  cycleToleranceRatio: 0.25,
  edgeMergeMs: 10_000,
} as const

/**
 * Detect power steps with a centered moving average and a two-sided CUSUM.
 * @param samples - second-level samples in any order.
 * @param options - detection tunables.
 * @returns steps in ascending time order plus coverage and caveats.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed samples or options.
 */
export function detectPowerEdges(
  samples: readonly TimeSeriesSample[],
  options: CusumOptions = {},
): { edges: DetectedEdge[]; coverage: number; warnings: string[] } {
  const settings = resolveOptions(options)
  const ordered = validateSamples(samples)
  const window = ordered.length === 0
    ? { startMs: 0, endMs: 0 }
    : { startMs: ordered[0]!.tsMs, endMs: ordered.at(-1)!.tsMs }
  const result = detectEdgesInOrder(ordered, settings)
  const coverage = window.endMs <= window.startMs
    ? 0
    : coveredDuration(ordered, window, settings.maxGapMs) / (window.endMs - window.startMs)
  return { edges: result.edges, coverage, warnings: result.warnings }
}

/**
 * Extract features, pair cycles, and diagnose hazards from second-level samples.
 * @param samples - second-level samples in any order.
 * @param window - half-open analysis window.
 * @param options - detection and hazard tunables.
 * @returns compact events, cycles, hazards, coverage, and caveats.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed input.
 */
export function detectTimeSeriesFeatures(
  samples: readonly TimeSeriesSample[],
  window: { readonly startMs: number; readonly endMs: number },
  options: CusumOptions = {},
): TimeSeriesFeatureResult {
  const settings = resolveOptions(options)
  requireWindow(window)
  const ordered = validateSamples(samples).filter(sample => sample.tsMs >= window.startMs && sample.tsMs < window.endMs)
  const detected = detectEdgesInOrder(ordered, settings)
  const indexByTs = new Map(ordered.map((sample, index) => [sample.tsMs, index]))
  const features: TimeSeriesFeature[] = detected.edges.map(edge => featureOf(edge, ordered, indexByTs, settings))
  for (const [index, feature] of features.entries()) {
    const next = features[index + 1]
    feature.durationMs = next === undefined ? window.endMs - feature.atMs : next.atMs - feature.atMs
  }
  const warnings = [...detected.warnings]
  const finitePower = ordered.filter(sample => sample.powerKw !== null)
  const coverage = coveredDuration(finitePower, window, settings.maxGapMs) / (window.endMs - window.startMs)
  if (coverage < 0.95) warnings.push('less than 95% of the window has adjacent finite power samples')
  if (!ordered.some(sample => sample.phaseCurrentA !== undefined)) {
    warnings.push('upstream did not provide three-phase currents; phase unbalance is unavailable')
  }
  if (!ordered.some(sample => sample.harmonicCurrentA !== undefined)) {
    warnings.push('upstream did not provide harmonic currents; harmonic fingerprints are unavailable')
  }
  const cycles = pairCycles(features, settings)
  const hazards = diagnoseMicroHazards(features, settings)
  return { events: features, cycles, hazards, coverage: Math.min(1, coverage), warnings: [...new Set(warnings)] }
}

/**
 * Pair an up step with a later down step whose magnitude is symmetric.
 * @param events - features in ascending time order.
 * @param options - pairing tunables.
 * @returns inferred start-stop cycles.
 */
export function pairCycles(events: readonly TimeSeriesFeature[], options: CusumOptions = {}): InferredCycle[] {
  const settings = resolveOptions(options)
  const tolerance = settings.cycleToleranceRatio
  const cycles: InferredCycle[] = []
  for (const [index, event] of events.entries()) {
    if (event.direction !== 'up' || event.deltaKw <= 0) continue
    for (const next of events.slice(index + 1)) {
      if (next.direction !== 'down') continue
      const allowed = Math.max(settings.minDeltaKw, event.deltaKw * tolerance)
      if (Math.abs(next.deltaKw + event.deltaKw) <= allowed) {
        cycles.push({
          startMs: event.atMs,
          endMs: next.atMs,
          powerKw: event.deltaKw,
          durationMs: next.atMs - event.atMs,
        })
      }
      break
    }
  }
  return cycles
}

/**
 * Apply the four deterministic microscopic hazard rules.
 * @param events - features in ascending time order.
 * @param options - rule tunables.
 * @returns hazard findings with evidence.
 */
export function diagnoseMicroHazards(
  events: readonly TimeSeriesFeature[],
  options: CusumOptions = {},
): MicroHazard[] {
  const settings = resolveOptions(options)
  const hazards: MicroHazard[] = []
  const ups = events.filter(event => event.direction === 'up')
  for (const event of ups) {
    const within = ups.filter(candidate => candidate.atMs >= event.atMs && candidate.atMs < event.atMs + settings.frequentCycleWindowMs)
    if (within.length > settings.frequentCycleCount) {
      hazards.push({
        kind: 'frequent_cycling',
        severity: 'warning',
        atMs: event.atMs,
        evidence: {
          starts: within.length,
          windowMinutes: settings.frequentCycleWindowMs / 60_000,
        },
      })
      break
    }
  }
  for (const event of events) {
    const inrushDurationMs = event.inrushDurationMs
    if (inrushDurationMs !== null && inrushDurationMs > settings.startupLagMs) {
      hazards.push({
        kind: 'startup_lag',
        severity: 'critical',
        atMs: event.atMs,
        evidence: {
          inrushRatio: roundNullable(event.inrushRatio),
          inrushDurationMs,
          deltaPowerKw: round(event.deltaKw),
        },
      })
    }
    if (event.phaseImbalancePct !== null && event.phaseImbalancePct > settings.unbalanceThresholdPct) {
      hazards.push({
        kind: 'phase_unbalance',
        severity: 'critical',
        atMs: event.atMs,
        evidence: {
          phaseImbalancePct: round(event.phaseImbalancePct),
          thresholdPct: settings.unbalanceThresholdPct,
        },
      })
    }
    const harmonicJump = Math.max(
      event.harmonicDeltaA[3] ?? 0,
      event.harmonicDeltaA[5] ?? 0,
      event.harmonicDeltaA[7] ?? 0,
    )
    if (harmonicJump > settings.harmonicDeltaThresholdA
      && event.powerFactorDelta !== null
      && Math.abs(event.powerFactorDelta) > settings.powerFactorSwingThreshold) {
      hazards.push({
        kind: 'harmonic_resonance',
        severity: 'critical',
        atMs: event.atMs,
        evidence: {
          harmonicDeltaA: round(harmonicJump),
          powerFactorDelta: round(event.powerFactorDelta),
        },
      })
    }
  }
  return dedupeHazards(hazards)
}

interface Settings {
  thresholdKw: number
  driftKw: number
  filterRadius: number
  steadyWindow: number
  minDeltaKw: number
  maxGapMs: number
  maxEvents: number
  inrushWindowMs: number
  settleWindowMs: number
  startupLagMs: number
  frequentCycleCount: number
  frequentCycleWindowMs: number
  unbalanceThresholdPct: number
  harmonicDeltaThresholdA: number
  powerFactorSwingThreshold: number
  cycleToleranceRatio: number
  edgeMergeMs: number
}

function detectEdgesInOrder(
  ordered: readonly TimeSeriesSample[],
  settings: Settings,
): { edges: DetectedEdge[]; warnings: string[] } {
  const warnings: string[] = []
  const segments = splitSegments(ordered, settings.maxGapMs, warnings)
  const edges: DetectedEdge[] = []
  for (const segment of segments) {
    const filtered = filterPower(segment, settings.filterRadius)
    let positive = 0
    let negative = 0
    for (let index = 1; index < filtered.length; index += 1) {
      const change = filtered[index]!.powerKw - filtered[index - 1]!.powerKw
      positive = Math.max(0, positive + change - settings.driftKw)
      negative = Math.max(0, negative - change - settings.driftKw)
      if (positive <= settings.thresholdKw && negative <= settings.thresholdKw) continue
      const before = medianOf(filtered.slice(Math.max(0, index - settings.steadyWindow), index).map(point => point.powerKw))
      const after = medianOf(filtered.slice(index, Math.min(filtered.length, index + settings.steadyWindow)).map(point => point.powerKw))
      const delta = after - before
      positive = 0
      negative = 0
      if (Math.abs(delta) < settings.minDeltaKw) continue
      edges.push({
        atMs: filtered[index]!.tsMs,
        direction: delta >= 0 ? 'up' : 'down',
        beforeKw: round(before),
        afterKw: round(after),
        deltaKw: round(delta),
      })
    }
  }
  edges.sort((left, right) => left.atMs - right.atMs)
  const merged = mergeNearbyEdges(edges, settings.edgeMergeMs)
  edges.length = 0
  edges.push(...merged)
  if (edges.length > settings.maxEvents) {
    warnings.push(`detected ${String(edges.length)} edges; only the first ${String(settings.maxEvents)} are returned`)
    edges.length = settings.maxEvents
  }
  return { edges, warnings }
}

/**
 * Collapse repeated detections from one centered-moving-average transition.
 * The strongest same-direction step within the merge window represents the
 * transition; real steps further apart remain separate.
 * @param edges - detections in ascending time order.
 * @param mergeMs - maximum distance between repeated detections.
 * @returns one detection per transition.
 */
function mergeNearbyEdges(edges: readonly DetectedEdge[], mergeMs: number): DetectedEdge[] {
  const merged: DetectedEdge[] = []
  for (const edge of edges) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.direction === edge.direction && edge.atMs - previous.atMs <= mergeMs) {
      if (Math.abs(edge.deltaKw) > Math.abs(previous.deltaKw)) merged[merged.length - 1] = edge
      continue
    }
    merged.push(edge)
  }
  return merged
}

function splitSegments(
  samples: readonly TimeSeriesSample[],
  maxGapMs: number,
  warnings: string[],
): Array<Array<{ tsMs: number; powerKw: number }>> {
  const segments: Array<Array<{ tsMs: number; powerKw: number }>> = []
  let current: Array<{ tsMs: number; powerKw: number }> = []
  let previousTs: number | undefined
  for (const sample of samples) {
    if (sample.powerKw === null) {
      if (current.length > 1) segments.push(current)
      current = []
      previousTs = undefined
      continue
    }
    if (previousTs !== undefined && sample.tsMs - previousTs > maxGapMs) {
      warnings.push(`power samples contain a gap longer than ${String(maxGapMs)} ms; edges across it were ignored`)
      if (current.length > 1) segments.push(current)
      current = []
    }
    current.push({ tsMs: sample.tsMs, powerKw: sample.powerKw })
    previousTs = sample.tsMs
  }
  if (current.length > 1) segments.push(current)
  return segments
}

function filterPower(
  segment: ReadonlyArray<{ tsMs: number; powerKw: number }>,
  radius: number,
): Array<{ tsMs: number; powerKw: number }> {
  return segment.map((point, index) => {
    const start = Math.max(0, index - radius)
    const end = Math.min(segment.length, index + radius + 1)
    const values = segment.slice(start, end).map(candidate => candidate.powerKw)
    return { tsMs: point.tsMs, powerKw: values.reduce((sum, value) => sum + value, 0) / values.length }
  })
}

function featureOf(
  edge: DetectedEdge,
  ordered: readonly TimeSeriesSample[],
  indexByTs: ReadonlyMap<number, number>,
  settings: Settings,
): TimeSeriesFeature {
  const index = indexByTs.get(edge.atMs) ?? 0
  const before = ordered.slice(Math.max(0, index - settings.steadyWindow * 6), index)
  const after = ordered.slice(index, Math.min(ordered.length, index + settings.steadyWindow * 6))
  const postStart = edge.atMs
  const postEnd = postStart + settings.inrushWindowMs + settings.settleWindowMs
  const inrushWindow = ordered.filter(sample => sample.tsMs >= postStart && sample.tsMs < postStart + settings.inrushWindowMs)
  const settleWindow = ordered.filter(sample => sample.tsMs >= postStart + settings.inrushWindowMs && sample.tsMs < postEnd)
  const steadyCurrent = medianNullable(settleWindow.map(sample => sample.currentA ?? null))
  const peakCurrent = maxNullable(inrushWindow.map(sample => sample.currentA ?? null))
  const inrushRatio = peakCurrent === null || steadyCurrent === null || steadyCurrent <= 0
    ? null
    : peakCurrent / steadyCurrent
  const inrushDurationMs = inrushRatio === null || steadyCurrent === null
    ? null
    : inrushSettledMs(ordered, index, steadyCurrent, settings)
  const imbalances = after.flatMap((sample) => {
    const value = phaseUnbalancePct(sample.phaseCurrentA ?? {})
    return value === undefined ? [] : [value]
  })
  return {
    ...edge,
    deltaReactiveKvar: difference(meanNullable(after.map(sample => sample.reactivePowerKvar ?? null)), meanNullable(before.map(sample => sample.reactivePowerKvar ?? null))),
    durationMs: 0,
    inrushRatio: roundNullable(inrushRatio),
    inrushDurationMs,
    phaseImbalancePct: imbalances.length === 0 ? null : round(Math.max(...imbalances)),
    harmonicDeltaA: {
      3: difference(meanNullable(after.map(sample => sample.harmonicCurrentA?.[3] ?? null)), meanNullable(before.map(sample => sample.harmonicCurrentA?.[3] ?? null))),
      5: difference(meanNullable(after.map(sample => sample.harmonicCurrentA?.[5] ?? null)), meanNullable(before.map(sample => sample.harmonicCurrentA?.[5] ?? null))),
      7: difference(meanNullable(after.map(sample => sample.harmonicCurrentA?.[7] ?? null)), meanNullable(before.map(sample => sample.harmonicCurrentA?.[7] ?? null))),
    },
    powerFactorBefore: meanNullable(before.map(sample => sample.powerFactor ?? null)),
    powerFactorAfter: meanNullable(after.map(sample => sample.powerFactor ?? null)),
    powerFactorDelta: difference(meanNullable(after.map(sample => sample.powerFactor ?? null)), meanNullable(before.map(sample => sample.powerFactor ?? null))),
  }
}

function inrushSettledMs(
  ordered: readonly TimeSeriesSample[],
  index: number,
  steadyCurrent: number,
  settings: Settings,
): number | null {
  const limit = ordered[index]!.tsMs + settings.settleWindowMs
  for (let cursor = index; cursor < ordered.length; cursor += 1) {
    const sample = ordered[cursor]!
    if (sample.tsMs > limit) return null
    const current = sample.currentA
    if (current !== undefined && current !== null && current <= steadyCurrent * 1.2) return sample.tsMs - ordered[index]!.tsMs
  }
  return null
}

function resolveOptions(options: CusumOptions): Settings {
  const settings = { ...DEFAULTS, ...options }
  for (const [key, value] of Object.entries(settings)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${key} must be a finite number`)
  }
  if (settings.thresholdKw <= 0) throw invalid('thresholdKw must be positive')
  if (settings.driftKw < 0 || settings.driftKw >= settings.thresholdKw) throw invalid('driftKw must be within [0, thresholdKw)')
  if (!Number.isInteger(settings.filterRadius) || settings.filterRadius < 0) throw invalid('filterRadius must be a non-negative integer')
  if (!Number.isInteger(settings.steadyWindow) || settings.steadyWindow < 1) throw invalid('steadyWindow must be a positive integer')
  if (!Number.isInteger(settings.maxEvents) || settings.maxEvents < 1) throw invalid('maxEvents must be a positive integer')
  if (settings.cycleToleranceRatio <= 0 || settings.cycleToleranceRatio >= 1) throw invalid('cycleToleranceRatio must be within (0, 1)')
  if (settings.edgeMergeMs < 0) throw invalid('edgeMergeMs must be non-negative')
  return settings
}

function validateSamples(samples: readonly TimeSeriesSample[]): TimeSeriesSample[] {
  for (const [index, sample] of samples.entries()) {
    if (!Number.isFinite(sample.tsMs)) throw invalid(`samples[${String(index)}].tsMs must be finite`)
    if (sample.powerKw !== null && !Number.isFinite(sample.powerKw)) throw invalid(`samples[${String(index)}].powerKw must be finite`)
    for (const value of [sample.reactivePowerKvar, sample.currentA, sample.powerFactor]) {
      if (value !== undefined && value !== null && !Number.isFinite(value)) throw invalid(`samples[${String(index)}] contains a non-finite optional value`)
    }
    for (const value of Object.values(sample.phaseCurrentA ?? {})) {
      if (value !== undefined && value !== null && !Number.isFinite(value)) throw invalid(`samples[${String(index)}] contains a non-finite phase current`)
    }
    for (const value of Object.values(sample.harmonicCurrentA ?? {})) {
      if (value !== undefined && value !== null && !Number.isFinite(value)) throw invalid(`samples[${String(index)}] contains a non-finite harmonic current`)
    }
  }
  return [...samples].sort((left, right) => left.tsMs - right.tsMs)
}

function requireWindow(window: { readonly startMs: number; readonly endMs: number }): void {
  if (!Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) throw invalid('window bounds must be finite')
  if (window.endMs <= window.startMs) throw invalid('window end must be after window start')
}

function coveredDuration(
  samples: readonly { tsMs: number }[],
  window: { readonly startMs: number; readonly endMs: number },
  maxGapMs: number,
): number {
  let covered = 0
  for (let index = 1; index < samples.length; index += 1) {
    const start = Math.max(samples[index - 1]!.tsMs, window.startMs)
    const end = Math.min(samples[index]!.tsMs, window.endMs)
    if (end > start && end - start <= maxGapMs) covered += end - start
  }
  return covered
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!
}

function meanNullable(values: ReadonlyArray<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function medianNullable(values: ReadonlyArray<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return finite.length === 0 ? null : medianOf(finite)
}

function maxNullable(values: ReadonlyArray<number | null | undefined>): number | null {
  const finite = values.filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
  return finite.length === 0 ? null : Math.max(...finite)
}

function difference(after: number | null, before: number | null): number | null {
  if (after === null || before === null) return null
  return round(after - before)
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function roundNullable(value: number | null): number | null {
  return value === null ? null : round(value)
}

function dedupeHazards(hazards: readonly MicroHazard[]): MicroHazard[] {
  const seen = new Set<string>()
  return hazards.filter((hazard) => {
    const key = `${hazard.kind}\u0000${String(hazard.atMs)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}
