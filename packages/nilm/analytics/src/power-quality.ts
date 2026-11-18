/**
 * Energy-weighted power factor, harmonic content, phase unbalance, and voltage
 * deviation over already authorized samples. No function performs IO.
 * @module @deepseek-ai/dsh-nilm-analytics/power-quality
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'

/** Harmonic current orders the upstream realtime table currently exposes beyond the fundamental. */
export type HarmonicOrder = 2 | 3 | 5 | 7

const HARMONIC_ORDERS: readonly HarmonicOrder[] = [2, 3, 5, 7]

/** Available harmonic-current orders including the fundamental. */
export type HarmonicCurrentOrder = 1 | HarmonicOrder

/** One phase identifier. */
export type Phase = 'A' | 'B' | 'C'

/** One realtime sample used for power-quality calculations. */
export interface PowerQualitySample {
  /** Sample instant in epoch milliseconds. */
  tsMs: number
  /** Active power in kW, absent when upstream supplies none. */
  activePowerKw: number | null
  /** Reactive power in kvar, absent when upstream supplies none. */
  reactivePowerKvar: number | null
  /** Upstream power factor, retained for context and never used as the billing value. */
  powerFactor: number | null
  /** Harmonic current magnitudes in amperes, keyed by order. */
  harmonicCurrentA: Partial<Record<HarmonicCurrentOrder, number | null>>
  /** Per-phase currents in amperes when upstream exposes them. */
  phaseCurrentA?: Partial<Record<Phase, number | null>>
  /** Line or phase voltage in volts when upstream exposes it. */
  voltageV?: number | null
}

/** One harmonic band with explicit availability. */
export interface HarmonicBand {
  /** Harmonic order. */
  order: HarmonicOrder
  /** True when at least one sample had a positive fundamental and this order. */
  available: boolean
  /** Mean content in percent over valid samples. */
  meanPct: number | null
  /** Maximum content in percent over valid samples. */
  maxPct: number | null
  /** Number of valid samples. */
  samples: number
  /** Why the band is unavailable, absent when available. */
  reason?: string
}

/** Deterministic power-quality totals for one window. */
export interface PowerQualityResult {
  /** Integrated active energy over intervals with both P and Q. */
  activeEnergyKwh: number
  /** Integrated reactive energy over the same intervals. */
  reactiveEnergyKvarh: number
  /** Billing power factor from active and reactive energy, absent when active energy is non-positive. */
  energyWeightedPowerFactor: number | null
  /** Risk band against the configured threshold. */
  powerFactorRisk: 'ok' | 'warning' | 'critical' | 'unknown'
  /** Threshold used for the risk band. */
  powerFactorThreshold: number
  /** Harmonic bands 2, 3, 5, and 7 with per-order availability. */
  harmonicBands: HarmonicBand[]
  /** Worst three-phase current unbalance in percent, absent when phase currents are unavailable. */
  worstUnbalancePct: number | null
  /** Worst absolute voltage deviation in percent, absent without a voltage sample and nominal value. */
  worstVoltageDeviationPct: number | null
  /** Share of the window covered by intervals with both P and Q. */
  sampleCoverage: number
  /** Deterministic caveats for the model and caller. */
  warnings: string[]
}

/** Options shared by the power-quality calculations. */
export interface PowerQualityOptions {
  /** Billing power-factor threshold, default 0.90. */
  powerFactorThreshold?: number
  /** Nominal voltage for voltage-deviation reporting, absent when not configured. */
  nominalVoltageV?: number
  /** Maximum adjacent-sample distance credited to integration, default 15 minutes. */
  maxGapMs?: number
}

/**
 * Calculate the billing power factor from active and reactive energy.
 * @param activeKwh - active energy over the period.
 * @param reactiveKvarh - reactive energy over the period.
 * @returns the power factor, or undefined when active energy is not positive.
 * @throws NilmError with `INVALID_ARGUMENT` for non-finite inputs.
 */
export function energyWeightedPowerFactor(activeKwh: number, reactiveKvarh: number): number | undefined {
  requireFinite(activeKwh, 'activeKwh')
  requireFinite(reactiveKvarh, 'reactiveKvarh')
  if (activeKwh <= 0) return undefined
  return activeKwh / Math.sqrt(activeKwh * activeKwh + reactiveKvarh * reactiveKvarh)
}

/**
 * Calculate three-phase current unbalance as the maximum phase deviation from the mean.
 * @param currents - phase currents in amperes; every phase must be present.
 * @returns unbalance in percent, or undefined when a phase is missing or the mean is not positive.
 * @throws NilmError with `INVALID_ARGUMENT` for non-finite values.
 */
export function phaseUnbalancePct(currents: Partial<Record<Phase, number | null>>): number | undefined {
  const values = [currents.A, currents.B, currents.C]
  if (values.some(value => value === undefined || value === null)) return undefined
  const [a, b, c] = values as [number, number, number]
  for (const value of [a, b, c]) requireFinite(value, 'phase current')
  if (a < 0 || b < 0 || c < 0) throw invalid('phase currents must not be negative')
  const mean = (a + b + c) / 3
  if (mean <= 0) return undefined
  return Math.max(Math.abs(a - mean), Math.abs(b - mean), Math.abs(c - mean)) / mean * 100
}

/**
 * Analyze power quality over one half-open window.
 * Energy is integrated from adjacent P/Q samples; gaps longer than `maxGapMs`
 * stay uncovered. Harmonics report only the orders the upstream supplies, so
 * the result never claims a complete THD value.
 * @param samples - already authorized samples in any order.
 * @param window - half-open window in epoch milliseconds.
 * @param options - threshold, nominal voltage, and maximum integration gap.
 * @returns energy, power factor, harmonic bands, unbalance, and caveats.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed windows or options.
 */
export function analyzePowerQuality(
  samples: readonly PowerQualitySample[],
  window: { readonly startMs: number; readonly endMs: number },
  options: PowerQualityOptions = {},
): PowerQualityResult {
  requireWindow(window)
  const threshold = options.powerFactorThreshold ?? 0.9
  const maxGapMs = options.maxGapMs ?? 15 * 60_000
  requireFinite(threshold, 'powerFactorThreshold')
  requireFinite(maxGapMs, 'maxGapMs')
  if (threshold <= 0 || threshold > 1) throw invalid('powerFactorThreshold must be within (0, 1]')
  if (maxGapMs <= 0) throw invalid('maxGapMs must be positive')
  if (options.nominalVoltageV !== undefined) {
    requireFinite(options.nominalVoltageV, 'nominalVoltageV')
    if (options.nominalVoltageV <= 0) throw invalid('nominalVoltageV must be positive')
  }
  const ordered = validateSamples(samples)
  const integrated = integratePower(ordered, window, maxGapMs)
  const warnings = [...integrated.warnings]
  const powerFactor = energyWeightedPowerFactor(integrated.activeEnergyKwh, integrated.reactiveEnergyKvarh) ?? null
  const powerFactorRisk = powerFactor === null
    ? 'unknown'
    : powerFactor >= threshold
      ? 'ok'
      : powerFactor >= threshold - 0.05
        ? 'warning'
        : 'critical'
  const harmonicBands = HARMONIC_ORDERS.map(order => harmonicBand(ordered, order))
  if (harmonicBands.some(band => !band.available)) {
    warnings.push('harmonic content is reported per available order; it is not a complete THD value')
  }
  const unbalanceValues = ordered.flatMap((sample) => {
    const value = phaseUnbalancePct(sample.phaseCurrentA ?? {})
    return value === undefined ? [] : [value]
  })
  if (unbalanceValues.length === 0) warnings.push('upstream did not provide three-phase currents; unbalance is unavailable')
  const deviations = options.nominalVoltageV === undefined
    ? []
    : ordered.flatMap((sample) => {
      if (sample.voltageV === undefined || sample.voltageV === null) return []
      return [Math.abs(sample.voltageV - options.nominalVoltageV!) / options.nominalVoltageV! * 100]
    })
  if (options.nominalVoltageV === undefined) warnings.push('nominal voltage is not configured; voltage deviation is unavailable')
  return {
    activeEnergyKwh: integrated.activeEnergyKwh,
    reactiveEnergyKvarh: integrated.reactiveEnergyKvarh,
    energyWeightedPowerFactor: powerFactor,
    powerFactorRisk,
    powerFactorThreshold: threshold,
    harmonicBands,
    worstUnbalancePct: unbalanceValues.length === 0 ? null : Math.max(...unbalanceValues),
    worstVoltageDeviationPct: deviations.length === 0 ? null : Math.max(...deviations),
    sampleCoverage: integrated.coverage,
    warnings: [...new Set(warnings)],
  }
}

/**
 * Integrate active and reactive power over adjacent samples.
 * @param samples - validated, sorted samples.
 * @param window - half-open window.
 * @param maxGapMs - maximum adjacent-sample distance credited.
 * @returns energy totals, covered duration, and gap caveats.
 */
function integratePower(
  samples: readonly PowerQualitySample[],
  window: { readonly startMs: number; readonly endMs: number },
  maxGapMs: number,
): { activeEnergyKwh: number; reactiveEnergyKvarh: number; coverage: number; warnings: string[] } {
  let activeEnergyKwh = 0
  let reactiveEnergyKvarh = 0
  let coveredMs = 0
  let gapSkipped = false
  let missingSkipped = false
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]!
    const current = samples[index]!
    const startMs = Math.max(previous.tsMs, window.startMs)
    const endMs = Math.min(current.tsMs, window.endMs)
    if (endMs <= startMs) continue
    const durationMs = endMs - startMs
    if (durationMs > maxGapMs) {
      gapSkipped = true
      continue
    }
    if (previous.activePowerKw === null || previous.reactivePowerKvar === null) {
      missingSkipped = true
      continue
    }
    activeEnergyKwh += previous.activePowerKw * durationMs / 3_600_000
    reactiveEnergyKvarh += previous.reactivePowerKvar * durationMs / 3_600_000
    coveredMs += durationMs
  }
  const totalMs = window.endMs - window.startMs
  const warnings: string[] = []
  if (gapSkipped) warnings.push(`sample gaps longer than ${String(maxGapMs)} ms were left uncovered`)
  if (missingSkipped) warnings.push('intervals without both active and reactive power were excluded from energy')
  if (coveredMs / totalMs < 0.95) warnings.push('less than 95% of the window contributed to energy integration')
  return {
    activeEnergyKwh,
    reactiveEnergyKvarh,
    coverage: Math.min(1, coveredMs / totalMs),
    warnings,
  }
}

/**
 * Summarize one harmonic order from samples that carry both fundamental and order current.
 * @param samples - validated, sorted samples.
 * @param order - harmonic order above the fundamental.
 * @returns the band with mean/max content and availability.
 */
function harmonicBand(samples: readonly PowerQualitySample[], order: HarmonicOrder): HarmonicBand {
  const ratios: number[] = []
  for (const sample of samples) {
    const fundamental = sample.harmonicCurrentA[1]
    const harmonic = sample.harmonicCurrentA[order]
    if (fundamental === undefined || fundamental === null || fundamental <= 0) continue
    if (harmonic === undefined || harmonic === null) continue
    ratios.push(harmonic / fundamental * 100)
  }
  if (ratios.length === 0) {
    return {
      order,
      available: false,
      meanPct: null,
      maxPct: null,
      samples: 0,
      reason: 'upstream did not provide a positive fundamental and this harmonic order together',
    }
  }
  return {
    order,
    available: true,
    meanPct: ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length,
    maxPct: Math.max(...ratios),
    samples: ratios.length,
  }
}

/**
 * Sort samples and reject malformed values.
 * @param samples - caller-supplied samples.
 * @returns a new array in ascending time order.
 */
function validateSamples(samples: readonly PowerQualitySample[]): PowerQualitySample[] {
  for (const [index, sample] of samples.entries()) {
    requireFinite(sample.tsMs, `samples[${String(index)}].tsMs`)
    if (sample.activePowerKw !== null) requireFinite(sample.activePowerKw, `samples[${String(index)}].activePowerKw`)
    if (sample.reactivePowerKvar !== null) requireFinite(sample.reactivePowerKvar, `samples[${String(index)}].reactivePowerKvar`)
    if (sample.powerFactor !== null) requireFinite(sample.powerFactor, `samples[${String(index)}].powerFactor`)
    if (sample.voltageV !== undefined && sample.voltageV !== null) requireFinite(sample.voltageV, `samples[${String(index)}].voltageV`)
    for (const value of Object.values(sample.harmonicCurrentA)) {
      if (value !== null && value !== undefined) requireFinite(value, `samples[${String(index)}].harmonicCurrentA`)
    }
    for (const value of Object.values(sample.phaseCurrentA ?? {})) {
      if (value !== null && value !== undefined) requireFinite(value, `samples[${String(index)}].phaseCurrentA`)
    }
  }
  return [...samples].sort((left, right) => left.tsMs - right.tsMs)
}

function requireWindow(window: { readonly startMs: number; readonly endMs: number }): void {
  requireFinite(window.startMs, 'window.startMs')
  requireFinite(window.endMs, 'window.endMs')
  if (window.endMs <= window.startMs) throw invalid('window end must be after window start')
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw invalid(`${label} must be a finite number`)
}

function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}
