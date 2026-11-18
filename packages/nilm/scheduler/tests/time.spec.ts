import { describe, expect, it } from 'vitest'
import {
  addBusinessDays,
  atBusinessTime,
  businessDateKey,
  businessDayOfMonth,
  businessWeekday,
  endOfBusinessMonth,
  isAtOrAfterBusinessTime,
  isPowerFactorForecastDay,
  parseBusinessDate,
  startOfBusinessDay,
  startOfBusinessMonth,
} from '../src/index.ts'

const MORNING = Date.parse('2026-11-18T08:31:00+08:00')

describe('business time', () => {
  it('formats and bounds the Shanghai business day', () => {
    expect(businessDateKey(MORNING)).toBe('2026-11-18')
    const start = startOfBusinessDay(MORNING)
    expect(start).toBe(parseBusinessDate('2026-11-18'))
    expect(businessDateKey(start)).toBe('2026-11-18')
    expect(businessDateKey(addBusinessDays(start, 1))).toBe('2026-11-19')
    expect(atBusinessTime(start, 8, 30)).toBe(start + 8.5 * 3_600_000)
  })

  it('resolves month boundaries in business time', () => {
    expect(businessDateKey(startOfBusinessMonth(MORNING))).toBe('2026-11-01')
    expect(businessDateKey(endOfBusinessMonth(MORNING) - 1)).toBe('2026-11-30')
    expect(businessWeekday(MORNING)).toBe(3)
    expect(businessDayOfMonth(MORNING)).toBe(18)
  })

  it('recognizes due times and monthly forecast days', () => {
    expect(isAtOrAfterBusinessTime(MORNING, 8, 30)).toBe(true)
    expect(isAtOrAfterBusinessTime(MORNING, 9, 0)).toBe(false)
    expect(isPowerFactorForecastDay(Date.parse('2026-11-20T00:01:00+08:00'))).toBe(true)
    expect(isPowerFactorForecastDay(Date.parse('2026-11-25T00:01:00+08:00'))).toBe(true)
    expect(isPowerFactorForecastDay(MORNING)).toBe(false)
  })

  it('rejects impossible calendar dates', () => {
    expect(() => parseBusinessDate('2026-02-30')).toThrow(RangeError)
    expect(() => parseBusinessDate('not-a-date')).toThrow(RangeError)
  })
})
