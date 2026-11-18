/**
 * Monthly billing power-factor projection. Actual energy is summed from
 * completed business days; remaining days use the median of up to seven recent
 * occurrences of the same weekday. No point-wise power factor is averaged.
 * @module @deepseek-ai/dsh-nilm-scheduler/pf
 */

import { energyWeightedPowerFactor } from '@deepseek-ai/dsh-nilm-analytics'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import {
  addBusinessDays,
  businessDateKey,
  businessWeekday,
  endOfBusinessMonth,
  parseBusinessDate,
  startOfBusinessMonth,
} from './time.ts'

/** One completed business day of active and reactive energy. */
export interface DailyEnergy {
  /** Business date in `YYYY-MM-DD`. */
  date: string
  /** Active energy in kWh. */
  activeKwh: number
  /** Reactive energy in kvarh. */
  reactiveKvarh: number
}

/** Risk band relative to the configured billing threshold. */
export type PowerFactorRisk = 'pass' | 'watch' | 'risk'

/** Deterministic monthly projection result. */
export interface PowerFactorForecast {
  /** First business date of the month. */
  monthStartDate: string
  /** Last business date in the month. */
  monthEndDate: string
  /** Latest completed day included in actual totals. */
  asOfDate: string
  /** Actual active energy in kWh. */
  actualActiveKwh: number
  /** Actual reactive energy in kvarh. */
  actualReactiveKvarh: number
  /** Projected remaining active energy in kWh. */
  forecastActiveKwh: number
  /** Projected remaining reactive energy in kvarh. */
  forecastReactiveKvarh: number
  /** Actual plus projected active energy. */
  projectedActiveKwh: number
  /** Actual plus projected reactive energy. */
  projectedReactiveKvarh: number
  /** Projected billing power factor. */
  projectedPowerFactor?: number
  /** Configured assessment threshold. */
  threshold: number
  /** Distance from threshold used to mark a watch band. */
  watchMargin: number
  /** Projected risk band. */
  risk: PowerFactorRisk
  /** Remaining days included in the projection. */
  remainingDays: number
  /** Days projected from the all-day fallback median. */
  fallbackDays: number
  /** Explicit extrapolation assumptions. */
  assumptions: string[]
  /** Deterministic caveats. */
  warnings: string[]
}

/** Input to {@link forecastMonthlyPowerFactor}. */
export interface PowerFactorForecastInput {
  /** Last completed business date included in actual totals. */
  asOfDate: string
  /** Assessment threshold from `nilm_pf_policy`. */
  threshold: number
  /** Completed daily energy rows in any order. */
  days: readonly DailyEnergy[]
  /** Watch-band width above the threshold; defaults to 0.02. */
  watchMargin?: number
}

interface WeekdayMedian {
  activeKwh: number
  reactiveKvarh: number
  samples: number
}

/**
 * Project month-end power factor and a deterministic risk band.
 * @param input - completed days, assessment threshold, and as-of date.
 * @returns projected totals, risk, and explicit assumptions.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed dates, values, or thresholds.
 */
export function forecastMonthlyPowerFactor(input: PowerFactorForecastInput): PowerFactorForecast {
  const asOfStart = parseBusinessDate(input.asOfDate)
  const monthStart = startOfBusinessMonth(asOfStart)
  const monthEnd = endOfBusinessMonth(asOfStart)
  const monthEndDate = businessDateKey(monthEnd - 1)
  const threshold = finite(input.threshold, 'threshold')
  if (threshold <= 0 || threshold >= 1) throw invalid('threshold must be between 0 and 1')
  const watchMargin = finite(input.watchMargin ?? 0.02, 'watchMargin')
  if (watchMargin < 0) throw invalid('watchMargin must not be negative')

  const seen = new Set<string>()
  const completed: DailyEnergy[] = []
  for (const [index, day] of input.days.entries()) {
    const dateMs = parseBusinessDate(day.date)
    if (dateMs < monthStart || dateMs > asOfStart) continue
    if (seen.has(day.date)) throw invalid(`days[${String(index)}] repeats ${day.date}`)
    seen.add(day.date)
    completed.push({
      date: day.date,
      activeKwh: nonNegative(day.activeKwh, `days[${String(index)}].activeKwh`),
      reactiveKvarh: nonNegative(day.reactiveKvarh, `days[${String(index)}].reactiveKvarh`),
    })
  }
  completed.sort((left, right) => left.date.localeCompare(right.date))

  const byWeekday = mediansByWeekday(completed)
  const fallback = medianOf(completed.slice(-7))
  const remaining: string[] = []
  for (let cursor = addBusinessDays(asOfStart, 1); cursor < monthEnd; cursor = addBusinessDays(cursor, 1)) {
    remaining.push(businessDateKey(cursor))
  }
  const warnings: string[] = []
  if (completed.length === 0) warnings.push('no completed energy day is available for the current month')
  if (fallback === undefined && remaining.length > 0) warnings.push('no recent day is available for remaining-day extrapolation')

  let forecastActiveKwh = 0
  let forecastReactiveKvarh = 0
  let fallbackDays = 0
  for (const date of remaining) {
    const weekday = businessWeekday(parseBusinessDate(date))
    const median = byWeekday.get(weekday) ?? fallback
    if (median === undefined) continue
    if (!byWeekday.has(weekday)) fallbackDays += 1
    forecastActiveKwh += median.activeKwh
    forecastReactiveKvarh += median.reactiveKvarh
  }

  const actualActiveKwh = sum(completed.map(day => day.activeKwh))
  const actualReactiveKvarh = sum(completed.map(day => day.reactiveKvarh))
  const projectedActiveKwh = actualActiveKwh + forecastActiveKwh
  const projectedReactiveKvarh = actualReactiveKvarh + forecastReactiveKvarh
  const projectedPowerFactor = energyWeightedPowerFactor(projectedActiveKwh, projectedReactiveKvarh)
  const risk = riskOf(projectedPowerFactor, threshold, watchMargin)
  const assumptions = [
    'remaining days are extrapolated from the median of up to seven recent same-weekday completed days',
    'fallback days use the median of the seven most recent completed days',
    'billing power factor is energy weighted, not an arithmetic mean of point power factors',
    `assessment threshold ${threshold.toFixed(4)} comes from nilm_pf_policy`,
  ]
  if (fallbackDays > 0) assumptions.push(`${String(fallbackDays)} remaining days use the all-day fallback median`)
  return {
    monthStartDate: businessDateKey(monthStart),
    monthEndDate,
    asOfDate: input.asOfDate,
    actualActiveKwh,
    actualReactiveKvarh,
    forecastActiveKwh,
    forecastReactiveKvarh,
    projectedActiveKwh,
    projectedReactiveKvarh,
    ...(projectedPowerFactor === undefined ? {} : { projectedPowerFactor }),
    threshold,
    watchMargin,
    risk,
    remainingDays: remaining.length,
    fallbackDays,
    assumptions,
    warnings,
  }
}

/**
 * Group completed days by weekday and take recent medians.
 * @param days - ordered completed days.
 * @returns weekday medians with up to seven samples each.
 */
function mediansByWeekday(days: readonly DailyEnergy[]): Map<number, WeekdayMedian> {
  const groups = new Map<number, DailyEnergy[]>()
  for (const day of days) {
    const weekday = businessWeekday(parseBusinessDate(day.date))
    const group = groups.get(weekday) ?? []
    group.push(day)
    groups.set(weekday, group)
  }
  const result = new Map<number, WeekdayMedian>()
  for (const [weekday, group] of groups) {
    const median = medianOf(group.slice(-7))
    if (median !== undefined) result.set(weekday, median)
  }
  return result
}

/**
 * Take the median of up to seven daily rows.
 * @param days - daily rows in ascending date order.
 * @returns the median values, or undefined for an empty list.
 */
function medianOf(days: readonly DailyEnergy[]): WeekdayMedian | undefined {
  if (days.length === 0) return undefined
  return {
    activeKwh: median(days.map(day => day.activeKwh)),
    reactiveKvarh: median(days.map(day => day.reactiveKvarh)),
    samples: days.length,
  }
}

/**
 * Take a numeric median.
 * @param values - finite values in any order.
 * @returns the middle value, or the mean of the middle pair.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/**
 * Sum finite values.
 * @param values - values to add.
 * @returns the total.
 */
function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

/**
 * Classify a projected power factor.
 * @param projected - projected power factor.
 * @param threshold - assessment threshold.
 * @param watchMargin - watch-band width.
 * @returns the risk band.
 */
function riskOf(projected: number | undefined, threshold: number, watchMargin: number): PowerFactorRisk {
  if (projected === undefined) return 'risk'
  if (projected < threshold) return 'risk'
  if (projected < threshold + watchMargin) return 'watch'
  return 'pass'
}

/**
 * Validate one finite value.
 * @param value - candidate value.
 * @param label - diagnostic label.
 * @returns the same value.
 */
function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw invalid(`${label} must be finite`)
  return value
}

/**
 * Validate one non-negative value.
 * @param value - candidate value.
 * @param label - diagnostic label.
 * @returns the same value.
 */
function nonNegative(value: number, label: string): number {
  finite(value, label)
  if (value < 0) throw invalid(`${label} must not be negative`)
  return value
}

/**
 * Build a stable invalid-argument error.
 * @param message - diagnostic text.
 * @returns the error.
 */
function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}
