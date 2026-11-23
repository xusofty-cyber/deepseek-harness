/**
 * Business-calendar helpers for non-production detection. Times are evaluated
 * in the fixed `Asia/Shanghai` business zone used by every NILM query.
 * @module @deepseek-ai/dsh-nilm-sentinel/calendar
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'

/** One inclusive-start, exclusive-end working range in minutes after midnight. */
export interface WorkRange {
  /** Start minute, from 0 to 1439. */
  startMinute: number
  /** End minute, from 1 to 1440. */
  endMinute: number
}

const MINUTES_PER_DAY = 1440
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * Parse `nilm_tenant_config.work_hours_json`.
 * @param raw - JSON text or a decoded object shaped as `{ "ranges": [["08:00","12:00"]] }`.
 * @returns normalized working ranges, sorted by start.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed calendar data.
 */
export function parseWorkHours(raw: unknown): WorkRange[] {
  const value = typeof raw === 'string' ? parseJson(raw) : raw
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NilmError('INVALID_ARGUMENT', 'work_hours_json must be an object with a ranges array')
  }
  const ranges = (value as { ranges?: unknown }).ranges
  if (!Array.isArray(ranges)) throw new NilmError('INVALID_ARGUMENT', 'work_hours_json.ranges must be an array')
  const parsed: WorkRange[] = []
  for (const entry of ranges) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string') {
      throw new NilmError('INVALID_ARGUMENT', 'each work range must be a ["HH:MM","HH:MM"] pair')
    }
    const startMinute = minuteOf(entry[0])
    const endMinute = minuteOf(entry[1])
    if (endMinute <= startMinute) throw new NilmError('INVALID_ARGUMENT', 'work range end must be after its start')
    parsed.push({ startMinute, endMinute })
  }
  return parsed.sort((left, right) => left.startMinute - right.startMinute)
}

/**
 * Decide whether an instant falls outside every working range.
 * @param atMs - instant in epoch milliseconds.
 * @param ranges - parsed working ranges; an empty list means the whole day is non-production.
 * @returns true when the instant is outside working hours.
 */
export function isNonProduction(atMs: number, ranges: readonly WorkRange[]): boolean {
  if (ranges.length === 0) return true
  const minute = shanghaiMinuteOfDay(atMs)
  return !ranges.some(range => minute >= range.startMinute && minute < range.endMinute)
}

/**
 * Format an instant in business time.
 * @param atMs - epoch milliseconds.
 * @returns ISO 8601 text with the `+08:00` offset.
 */
export function shanghaiIso(atMs: number): string {
  return new Date(atMs + 8 * 60 * 60 * 1000).toISOString().replace('.000Z', '+08:00')
}

/**
 * Convert an instant to the Shanghai minute of day.
 * @param atMs - epoch milliseconds.
 * @returns minute from 0 to 1439.
 */
function shanghaiMinuteOfDay(atMs: number): number {
  const local = new Date(atMs + 8 * 60 * 60 * 1000)
  return local.getUTCHours() * 60 + local.getUTCMinutes()
}

/**
 * Parse `HH:MM` into minutes after midnight.
 * @param text - clock text.
 * @returns minute from 0 to 1439.
 */
function minuteOf(text: string): number {
  const match = TIME.exec(text)
  if (match === null) throw new NilmError('INVALID_ARGUMENT', `work range time '${text}' must use HH:MM`)
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Parse JSON text from MySQL.
 * @param text - JSON text.
 * @returns the decoded value.
 */
function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    throw new NilmError('INVALID_ARGUMENT', 'work_hours_json is not valid JSON', { cause: error })
  }
}

/** Exposed for tests that need the day width. */
export const MINUTES_IN_DAY = MINUTES_PER_DAY
