/**
 * Business-time helpers for scheduled NILM jobs. Every boundary is evaluated in
 * the fixed `Asia/Shanghai` zone used by the rest of the NILM packages.
 * @module @deepseek-ai/dsh-nilm-scheduler/time
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const DAY_MS = 86_400_000

/**
 * Format an instant as a Shanghai business date.
 * @param atMs - instant in epoch milliseconds.
 * @returns `YYYY-MM-DD` in business time.
 */
export function businessDateKey(atMs: number): string {
  return new Date(atMs + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Resolve the start of the Shanghai day containing an instant.
 * @param atMs - instant in epoch milliseconds.
 * @returns inclusive day start in epoch milliseconds.
 */
export function startOfBusinessDay(atMs: number): number {
  const shifted = new Date(atMs + SHANGHAI_OFFSET_MS)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - SHANGHAI_OFFSET_MS
}

/**
 * Move a day start by a whole number of business days.
 * @param dayStartMs - inclusive day start.
 * @param days - signed day count.
 * @returns the shifted day start.
 */
export function addBusinessDays(dayStartMs: number, days: number): number {
  return dayStartMs + days * DAY_MS
}

/**
 * Resolve the first instant of the Shanghai month containing an instant.
 * @param atMs - instant in epoch milliseconds.
 * @returns inclusive month start.
 */
export function startOfBusinessMonth(atMs: number): number {
  const shifted = new Date(atMs + SHANGHAI_OFFSET_MS)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - SHANGHAI_OFFSET_MS
}

/**
 * Resolve the exclusive end of the Shanghai month containing an instant.
 * @param atMs - instant in epoch milliseconds.
 * @returns exclusive month end.
 */
export function endOfBusinessMonth(atMs: number): number {
  const shifted = new Date(atMs + SHANGHAI_OFFSET_MS)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 1) - SHANGHAI_OFFSET_MS
}

/**
 * Read the Shanghai weekday for an instant.
 * @param atMs - instant in epoch milliseconds.
 * @returns weekday from 0 (Sunday) to 6 (Saturday).
 */
export function businessWeekday(atMs: number): number {
  return new Date(atMs + SHANGHAI_OFFSET_MS).getUTCDay()
}

/**
 * Read the Shanghai day of month for an instant.
 * @param atMs - instant in epoch milliseconds.
 * @returns day from 1 to 31.
 */
export function businessDayOfMonth(atMs: number): number {
  return new Date(atMs + SHANGHAI_OFFSET_MS).getUTCDate()
}

/**
 * Decide whether an instant is at or after a Shanghai clock time.
 * @param atMs - instant in epoch milliseconds.
 * @param hour - hour from 0 to 23.
 * @param minute - minute from 0 to 59.
 * @returns true when the local clock has reached the time.
 */
export function isAtOrAfterBusinessTime(atMs: number, hour: number, minute: number): boolean {
  const shifted = new Date(atMs + SHANGHAI_OFFSET_MS)
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes() >= hour * 60 + minute
}

/**
 * Build an instant at a Shanghai clock time inside one business day.
 * @param dayStartMs - inclusive day start.
 * @param hour - hour from 0 to 23.
 * @param minute - minute from 0 to 59.
 * @returns the instant in epoch milliseconds.
 */
export function atBusinessTime(dayStartMs: number, hour: number, minute: number): number {
  return dayStartMs + (hour * 60 + minute) * 60_000
}

/**
 * Decide whether an instant falls on a monthly power-factor forecast day.
 * @param atMs - instant in epoch milliseconds.
 * @returns true on the 20th and 25th Shanghai days.
 */
export function isPowerFactorForecastDay(atMs: number): boolean {
  const day = businessDayOfMonth(atMs)
  return day === 20 || day === 25
}

/**
 * Convert a `YYYY-MM-DD` business date to its day start.
 * @param date - business date text.
 * @returns inclusive day start in epoch milliseconds.
 * @throws RangeError when the date is not a valid calendar date.
 */
export function parseBusinessDate(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00+08:00`)
  if (!Number.isFinite(parsed) || businessDateKey(parsed) !== date) throw new RangeError(`invalid business date ${date}`)
  return parsed
}

/** One Shanghai business day width in milliseconds. */
export const BUSINESS_DAY_MS = DAY_MS
