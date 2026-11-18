/**
 * Pure tariff-plan validation, effective-plan selection, and time-of-use slicing.
 * The package owns no clock, database connection, or business-time-zone conversion.
 * @module @deepseek-ai/dsh-nilm-tariff
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NilmError,
  type CallContext,
  type TenantId,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmTariff: NilmTariffService
  }
}

/** One business tariff band. */
export type TariffPeriodType = 'sharp' | 'peak' | 'flat' | 'valley'

/** Calendar classification that selects a period set. */
export type TariffDayType = 'workday' | 'weekend' | 'holiday'

/** One time-of-day price band for one season and day type. */
export interface TariffPeriod {
  /** Tenant-defined season label, such as `summer` or `all-year`. */
  season: string
  /** Calendar classification. */
  dayType: TariffDayType
  /** Business tariff band. */
  periodType: TariffPeriodType
  /** Inclusive start clock time as `HH:mm`; `24:00` is not a start. */
  start: string
  /** Exclusive end clock time as `HH:mm`; `24:00` is allowed. */
  end: string
  /** Price in the deployment currency per kWh. */
  pricePerKwh: number
}

/** Versioned plan whose effective interval is expressed in epoch milliseconds. */
export interface TariffPlan {
  /** Stable plan identifier. */
  planId: string
  /** Tenant that owns the plan. */
  tenantId: TenantId
  /** First instant at which the plan is effective, inclusive. */
  effectiveFromMs: number
  /** Last instant at which the plan is effective, exclusive. */
  effectiveToMs?: number
  /** Time-of-day bands; seasons and day types may each define their own set. */
  periods: readonly TariffPeriod[]
}

/** One calendar day supplied by the tariff service after database projection. */
export interface TariffDay {
  /** Day start in epoch milliseconds. */
  startMs: number
  /** Day end in epoch milliseconds, exclusive. */
  endMs: number
  /** Season label used to select periods. */
  season: string
  /** Calendar classification used to select periods. */
  dayType: TariffDayType
}

/** One priced interval clipped to the requested range. */
export interface TariffSlice {
  /** Inclusive interval start in epoch milliseconds. */
  startMs: number
  /** Exclusive interval end in epoch milliseconds. */
  endMs: number
  /** Business tariff band. */
  periodType: TariffPeriodType
  /** Plan price for this interval. */
  pricePerKwh: number
  /** Plan that supplied the price. */
  planId: string
}

/** Unpriced interval, retained so callers can report exactly what could not be costed. */
export interface TariffGap {
  /** Inclusive interval start in epoch milliseconds. */
  startMs: number
  /** Exclusive interval end in epoch milliseconds. */
  endMs: number
  /** Stable reason code. */
  reason: 'no_period' | 'outside_plan' | 'missing_day'
}

/** Segmentation result for one requested range. */
export interface TariffSegmentation {
  /** Priced slices in ascending order and without overlapping each other. */
  slices: TariffSlice[]
  /** Unpriced intervals in ascending order. */
  gaps: TariffGap[]
  /** Non-fatal plan or calendar defects. */
  warnings: string[]
}

/** Read seam for tariff plans and projected calendar days. */
export interface TariffRepository {
  /**
   * @param tenantId - tenant boundary.
   * @param atMs - instant in epoch milliseconds.
   * @param signal - caller cancellation.
   * @returns plans effective at the instant, with their periods.
   */
  listEffective(tenantId: string, atMs: number, signal?: AbortSignal): Promise<TariffPlan[]>
  /**
   * @param tenantId - tenant boundary.
   * @param planId - explicit plan identifier.
   * @param signal - caller cancellation.
   * @returns the plan, or undefined when absent.
   */
  getPlan(tenantId: string, planId: string, signal?: AbortSignal): Promise<TariffPlan | undefined>
  /**
   * @param tenantId - tenant boundary.
   * @param startMs - inclusive range start.
   * @param endMs - exclusive range end.
   * @param signal - caller cancellation.
   * @returns projected calendar days covering the range.
   */
  listDays(tenantId: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<TariffDay[]>
}

/** Optional dependency overrides. */
export interface NilmTariffDependencies {
  /** Repository replacing the project-database adapter. */
  repository?: TariffRepository
}

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/
const PERIOD_ORDER: readonly TariffPeriodType[] = ['sharp', 'peak', 'flat', 'valley']
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86_400_000

/** Project-database repository backed by the guarded source adapter. */
export class SourceTariffRepository implements TariffRepository {
  /**
   * @param source - lazily resolved source service.
   */
  constructor(private readonly source: () => NilmSourceService) {}

  /**
   * @param tenantId - tenant boundary.
   * @param atMs - instant in epoch milliseconds.
   * @param signal - caller cancellation.
   * @returns effective plans with periods.
   */
  async listEffective(tenantId: string, atMs: number, signal?: AbortSignal): Promise<TariffPlan[]> {
    const day = localDate(atMs)
    const rows = await this.source().queryLocalReadOnly<PlanRow>(
      `SELECT plan_id AS planId, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effectiveFrom,
              DATE_FORMAT(effective_to, '%Y-%m-%d') AS effectiveTo
         FROM nilm_tariff_plan
        WHERE tenant_id = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
        ORDER BY effective_from`,
      [tenantId, day, day],
      signal,
    )
    return this.assemble(tenantId, rows, signal)
  }

  /**
   * @param tenantId - tenant boundary.
   * @param planId - explicit plan identifier.
   * @param signal - caller cancellation.
   * @returns the plan, or undefined.
   */
  async getPlan(tenantId: string, planId: string, signal?: AbortSignal): Promise<TariffPlan | undefined> {
    const rows = await this.source().queryLocalReadOnly<PlanRow>(
      `SELECT plan_id AS planId, DATE_FORMAT(effective_from, '%Y-%m-%d') AS effectiveFrom,
              DATE_FORMAT(effective_to, '%Y-%m-%d') AS effectiveTo
         FROM nilm_tariff_plan
        WHERE tenant_id = ? AND plan_id = ?`,
      [tenantId, planId],
      signal,
    )
    return (await this.assemble(tenantId, rows, signal))[0]
  }

  /**
   * @param tenantId - tenant boundary.
   * @param startMs - inclusive range start.
   * @param endMs - exclusive range end.
   * @param signal - caller cancellation.
   * @returns projected calendar days.
   */
  async listDays(tenantId: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<TariffDay[]> {
    const rows = await this.source().queryLocalReadOnly<{
      date: string
      dayType: TariffDayType
      season: string
    }>(
      `SELECT DATE_FORMAT(date, '%Y-%m-%d') AS date, day_type AS dayType, season
         FROM nilm_calendar_day
        WHERE tenant_id = ? AND date >= ? AND date <= ?
        ORDER BY date`,
      [tenantId, localDate(startMs), localDate(endMs - 1)],
      signal,
    )
    return rows.map(row => {
      const start = localDayStart(row.date)
      return { startMs: start, endMs: start + DAY_MS, season: row.season, dayType: row.dayType }
    })
  }

  private async assemble(
    tenantId: string,
    rows: readonly PlanRow[],
    signal?: AbortSignal,
  ): Promise<TariffPlan[]> {
    if (rows.length === 0) return []
    const planIds = rows.map(row => row.planId)
    const placeholders = planIds.map(() => '?').join(', ')
    const periods = await this.source().queryLocalReadOnly<PeriodRow>(
      `SELECT plan_id AS planId, season, day_type AS dayType, period_type AS periodType,
              LEFT(start_time, 5) AS start, LEFT(end_time, 5) AS end, price
         FROM nilm_tariff_period
        WHERE plan_id IN (${placeholders})
        ORDER BY plan_id, season, day_type, start_time`,
      planIds,
      signal,
    )
    const byPlan = new Map<string, TariffPeriod[]>()
    for (const period of periods) {
      const group = byPlan.get(period.planId) ?? []
      group.push({
        season: period.season,
        dayType: period.dayType,
        periodType: period.periodType,
        start: period.start,
        end: period.end,
        pricePerKwh: Number(period.price),
      })
      byPlan.set(period.planId, group)
    }
    return rows.map(row => ({
      planId: row.planId,
      tenantId: tenantId as TenantId,
      effectiveFromMs: localDayStart(row.effectiveFrom),
      ...(row.effectiveTo === null ? {} : { effectiveToMs: localDayStart(row.effectiveTo) + DAY_MS }),
      periods: byPlan.get(row.planId) ?? [],
    }))
  }
}

interface PlanRow {
  planId: string
  effectiveFrom: string
  effectiveTo: string | null
}

interface PeriodRow {
  planId: string
  season: string
  dayType: TariffDayType
  periodType: TariffPeriodType
  start: string
  end: string
  price: string | number
}

/**
 * Parse one clock value into minutes from midnight.
 * @param value - authored `HH:mm` value; `24:00` maps to 1440.
 * @returns minutes from midnight.
 * @throws NilmError with `INVALID_ARGUMENT` for a malformed value.
 */
export function parseClockMinutes(value: string): number {
  if (!CLOCK.test(value)) throw invalid(`clock value ${JSON.stringify(value)} must be HH:mm`)
  const [hour, minute] = value.split(':').map(Number) as [number, number]
  return hour * 60 + minute
}

/**
 * Validate one plan's periods and reject ambiguous overlaps.
 * @param plan - plan to validate.
 * @throws NilmError with `INVALID_ARGUMENT` when the plan cannot be priced deterministically.
 */
export function validateTariffPlan(plan: TariffPlan): void {
  if (plan.planId.length === 0) throw invalid('tariff plan id is required')
  if (plan.tenantId.length === 0) throw invalid('tariff plan tenant is required')
  requireFinite(plan.effectiveFromMs, 'effectiveFromMs')
  if (plan.effectiveToMs !== undefined) {
    requireFinite(plan.effectiveToMs, 'effectiveToMs')
    if (plan.effectiveToMs <= plan.effectiveFromMs) throw invalid('effectiveToMs must be after effectiveFromMs')
  }
  if (plan.periods.length === 0) throw invalid(`tariff plan ${plan.planId} has no periods`)
  const groups = new Map<string, Array<{ start: number; end: number; period: TariffPeriod }>>()
  for (const period of plan.periods) {
    if (period.season.length === 0) throw invalid('tariff period season is required')
    if (!PERIOD_ORDER.includes(period.periodType)) throw invalid(`unknown tariff period ${String(period.periodType)}`)
    requireFinite(period.pricePerKwh, 'pricePerKwh')
    if (period.pricePerKwh < 0) throw invalid('pricePerKwh must not be negative')
    const start = parseClockMinutes(period.start)
    const end = parseClockMinutes(period.end)
    if (start >= end) throw invalid(`tariff period ${period.start}-${period.end} must not wrap past midnight; split it into two periods`)
    const key = `${period.season}\u0000${period.dayType}`
    const entries = groups.get(key) ?? []
    for (const existing of entries) {
      if (start < existing.end && existing.start < end) {
        throw invalid(`overlapping tariff periods on ${period.season}/${period.dayType} at ${period.start}`)
      }
    }
    entries.push({ start, end, period })
    groups.set(key, entries)
  }
}

/**
 * Select the one plan effective at an instant.
 * @param plans - candidate plans, in any order.
 * @param atMs - instant to test, in epoch milliseconds.
 * @returns the effective plan.
 * @throws NilmError with `DATA_UNAVAILABLE` when no plan is effective or more than one plan overlaps.
 */
export function selectEffectivePlan(plans: readonly TariffPlan[], atMs: number): TariffPlan {
  requireFinite(atMs, 'atMs')
  const effective = plans.filter(plan => plan.effectiveFromMs <= atMs
    && (plan.effectiveToMs === undefined || atMs < plan.effectiveToMs))
  if (effective.length === 0) throw new NilmError('DATA_UNAVAILABLE', `no tariff plan is effective at ${String(atMs)}`)
  if (effective.length > 1) throw invalid(`multiple tariff plans are effective at ${String(atMs)}`)
  const plan = effective[0]!
  validateTariffPlan(plan)
  return plan
}

/**
 * Split one range into priced slices and explicit gaps for the supplied days.
 * Days must be non-overlapping and sorted; each day is interpreted as a fixed
 * local calendar day whose boundaries the caller computed in the deployment time zone.
 * @param range - requested half-open interval in epoch milliseconds.
 * @param plan - effective plan providing prices.
 * @param days - projected calendar days covering all or part of the range.
 * @returns priced slices, unpriced gaps, and plan/calendar warnings.
 * @throws NilmError with `INVALID_ARGUMENT` for an invalid range, plan, or day sequence.
 */
export function splitRangeByTariff(
  range: { readonly startMs: number; readonly endMs: number },
  plan: TariffPlan,
  days: readonly TariffDay[],
): TariffSegmentation {
  requireFinite(range.startMs, 'range.startMs')
  requireFinite(range.endMs, 'range.endMs')
  if (range.endMs <= range.startMs) throw invalid('range end must be after range start')
  validateTariffPlan(plan)
  const effectiveStart = Math.max(range.startMs, plan.effectiveFromMs)
  const effectiveEnd = Math.min(range.endMs, plan.effectiveToMs ?? range.endMs)
  if (effectiveEnd <= effectiveStart) {
    return {
      slices: [],
      gaps: [{ startMs: range.startMs, endMs: range.endMs, reason: 'outside_plan' }],
      warnings: [`range ${String(range.startMs)}-${String(range.endMs)} lies outside plan ${plan.planId}`],
    }
  }

  const warnings: string[] = []
  const slices: TariffSlice[] = []
  const dayCoverage: Array<{ startMs: number; endMs: number }> = []
  let previousDayStart: number | undefined
  let previousDayEnd: number | undefined
  for (const [index, day] of days.entries()) {
    requireFinite(day.startMs, `days[${String(index)}].startMs`)
    requireFinite(day.endMs, `days[${String(index)}].endMs`)
    if (day.endMs <= day.startMs) throw invalid(`tariff day ${String(index)} ends before it starts`)
    if (previousDayStart !== undefined && day.startMs < previousDayStart) {
      throw invalid(`tariff day ${String(index)} is not sorted`)
    }
    if (previousDayEnd !== undefined && day.startMs < previousDayEnd) {
      throw invalid(`tariff day ${String(index)} overlaps the previous day`)
    }
    previousDayStart = day.startMs
    previousDayEnd = day.endMs
    const dayStart = Math.max(day.startMs, effectiveStart)
    const dayEnd = Math.min(day.endMs, effectiveEnd)
    if (dayEnd <= dayStart) continue
    dayCoverage.push({ startMs: dayStart, endMs: dayEnd })
    const daySlices = dayPeriodSlices(day, plan, warnings)
    for (const slice of daySlices) {
      const startMs = Math.max(slice.startMs, dayStart)
      const endMs = Math.min(slice.endMs, dayEnd)
      if (endMs <= startMs) continue
      slices.push({ ...slice, startMs, endMs })
    }
  }

  const gaps: TariffGap[] = []
  if (effectiveStart > range.startMs) {
    gaps.push({ startMs: range.startMs, endMs: effectiveStart, reason: 'outside_plan' })
  }
  for (const gap of uncovered(effectiveStart, effectiveEnd, slices, 'no_period')) {
    if (!dayCoverage.some(day => day.startMs <= gap.startMs && gap.endMs <= day.endMs)) {
      gap.reason = 'missing_day'
    }
    gaps.push(gap)
  }
  if (effectiveEnd < range.endMs) {
    gaps.push({ startMs: effectiveEnd, endMs: range.endMs, reason: 'outside_plan' })
  }
  if (days.length === 0) warnings.push('no calendar days were supplied')
  slices.sort((left, right) => left.startMs - right.startMs)
  gaps.sort((left, right) => left.startMs - right.startMs)
  return { slices: mergeAdjacentSlices(slices), gaps: mergeGaps(gaps), warnings }
}

/**
 * Order period types from highest to lowest price band.
 * @param period - period type to rank.
 * @returns zero-based rank, with `sharp` first.
 */
export function tariffPeriodRank(period: TariffPeriodType): number {
  return PERIOD_ORDER.indexOf(period)
}

/** Cordis service loading tenant plans and exposing pure tariff operations. */
export class NilmTariffService extends Service {
  private readonly repository: TariffRepository

  /**
   * @param ctx - owning plugin context.
   * @param dependencies - repository override for tests or alternate projections.
   */
  constructor(ctx: Context, dependencies: NilmTariffDependencies = {}) {
    super(ctx, 'nilmTariff')
    this.repository = dependencies.repository ?? new SourceTariffRepository(() => ctx.get('nilmSource')!)
  }

  /**
   * Load and select the one plan effective at an instant.
   * @param callContext - verified caller identity.
   * @param atMs - instant in epoch milliseconds; defaults to the current time.
   * @param signal - optional caller cancellation.
   * @returns the effective plan.
   */
  async effectivePlan(callContext: CallContext, atMs: number = Date.now(), signal?: AbortSignal): Promise<TariffPlan> {
    requireCallContext(callContext)
    const plans = await this.repository.listEffective(callContext.tenantId, atMs, signal)
    return selectEffectivePlan(plans, atMs)
  }

  /**
   * Load the plan and projected calendar, then split a range into priced slices and gaps.
   * @param callContext - verified caller identity.
   * @param range - requested half-open interval in business time.
   * @param planId - optional explicit plan; otherwise the plan effective at range start is used.
   * @param signal - optional caller cancellation.
   * @returns priced slices and gaps.
   */
  async splitByTariff(
    callContext: CallContext,
    range: TimeRangeSpec,
    planId?: string,
    signal?: AbortSignal,
  ): Promise<TariffSegmentation> {
    requireCallContext(callContext)
    if (range.timeZone !== 'Asia/Shanghai') throw invalid('only Asia/Shanghai business time is supported')
    const startMs = Date.parse(range.start)
    const endMs = Date.parse(range.end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      throw invalid('time range must contain two ordered ISO instants')
    }
    const plan = planId === undefined
      ? await this.effectivePlan(callContext, startMs, signal)
      : await this.repository.getPlan(callContext.tenantId, planId, signal)
    if (plan === undefined) throw new NilmError('DATA_UNAVAILABLE', `tariff plan ${String(planId)} was not found`)
    const days = await this.repository.listDays(callContext.tenantId, startMs, endMs, signal)
    return splitRangeByTariff({ startMs, endMs }, plan, days)
  }
}

function dayPeriodSlices(day: TariffDay, plan: TariffPlan, warnings: string[]): TariffSlice[] {
  const relevant = plan.periods.filter(period => period.season === day.season && period.dayType === day.dayType)
  if (relevant.length === 0) {
    warnings.push(`no tariff periods for ${day.season}/${day.dayType}`)
    return []
  }
  const durationMs = day.endMs - day.startMs
  const dayMinutes = durationMs / 60_000
  if (!Number.isInteger(dayMinutes) || dayMinutes !== 1440) {
    warnings.push(`calendar day ${String(day.startMs)} is ${String(dayMinutes)} minutes, expected 1440`)
  }
  return relevant.map(period => ({
    startMs: day.startMs + parseClockMinutes(period.start) * 60_000,
    endMs: day.startMs + parseClockMinutes(period.end) * 60_000,
    periodType: period.periodType,
    pricePerKwh: period.pricePerKwh,
    planId: plan.planId,
  })).filter(slice => slice.endMs <= day.endMs)
}

function uncovered(
  startMs: number,
  endMs: number,
  covered: readonly { readonly startMs: number; readonly endMs: number }[],
  reason: TariffGap['reason'],
): TariffGap[] {
  const sorted = [...covered].sort((left, right) => left.startMs - right.startMs)
  const gaps: TariffGap[] = []
  let cursor = startMs
  for (const interval of sorted) {
    if (interval.endMs <= startMs || interval.startMs >= endMs) continue
    if (interval.startMs > cursor) gaps.push({ startMs: cursor, endMs: interval.startMs, reason })
    cursor = Math.max(cursor, interval.endMs)
    if (cursor >= endMs) break
  }
  if (cursor < endMs) gaps.push({ startMs: cursor, endMs, reason })
  return gaps
}

function mergeAdjacentSlices(slices: TariffSlice[]): TariffSlice[] {
  const out: TariffSlice[] = []
  for (const slice of slices) {
    const previous = out.at(-1)
    if (previous !== undefined
      && previous.endMs === slice.startMs
      && previous.periodType === slice.periodType
      && previous.pricePerKwh === slice.pricePerKwh
      && previous.planId === slice.planId) {
      previous.endMs = slice.endMs
    } else {
      out.push({ ...slice })
    }
  }
  return out
}

function mergeGaps(gaps: TariffGap[]): TariffGap[] {
  const out: TariffGap[] = []
  for (const gap of gaps) {
    const previous = out.at(-1)
    if (previous !== undefined && previous.reason === gap.reason && previous.endMs >= gap.startMs) {
      previous.endMs = Math.max(previous.endMs, gap.endMs)
    } else {
      out.push({ ...gap })
    }
  }
  return out
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw invalid(`${label} must be a finite number`)
}

function requireCallContext(callContext: CallContext): void {
  if (callContext.tenantId.length === 0) throw new NilmError('UNAUTHORIZED_TENANT', 'call context tenant is required')
}

function localDate(ms: number): string {
  return new Date(ms + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

function localDayStart(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (match === null) throw new NilmError('DATA_UNAVAILABLE', `calendar date ${JSON.stringify(date)} is malformed`)
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - SHANGHAI_OFFSET_MS
}

function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}

export default NilmTariffService
