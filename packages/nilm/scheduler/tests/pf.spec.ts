import { describe, expect, it } from 'vitest'
import { forecastMonthlyPowerFactor, type DailyEnergy } from '../src/index.ts'
import { energyDays } from './fake-data-source.ts'

describe('monthly power-factor forecast', () => {
  it('projects from actual energy and same-weekday medians', () => {
    const days = energyDays(19, 100, 20)
    const forecast = forecastMonthlyPowerFactor({ asOfDate: '2026-11-19', threshold: 0.9, days })

    expect(forecast).toMatchObject({
      actualActiveKwh: 1_900,
      actualReactiveKvarh: 380,
      forecastActiveKwh: 1_100,
      forecastReactiveKvarh: 220,
      projectedActiveKwh: 3_000,
      projectedReactiveKvarh: 600,
      remainingDays: 11,
      fallbackDays: 0,
      risk: 'pass',
    })
    expect(forecast.projectedPowerFactor).toBeCloseTo(0.98058, 5)
  })

  it('classifies an adverse projection as a threshold risk', () => {
    const forecast = forecastMonthlyPowerFactor({
      asOfDate: '2026-11-19',
      threshold: 0.9,
      days: energyDays(19, 100, 80),
    })
    expect(forecast.risk).toBe('risk')
    expect(forecast.projectedPowerFactor).toBeCloseTo(0.78087, 5)
  })

  it('classifies a projection inside the watch band', () => {
    const forecast = forecastMonthlyPowerFactor({
      asOfDate: '2026-11-19',
      threshold: 0.9,
      watchMargin: 0.02,
      days: energyDays(19, 100, 46),
    })
    expect(forecast.risk).toBe('watch')
  })

  it('falls back to the recent all-day median for missing weekdays', () => {
    const days: DailyEnergy[] = [
      { date: '2026-11-02', activeKwh: 100, reactiveKvarh: 20 },
      { date: '2026-11-09', activeKwh: 100, reactiveKvarh: 20 },
      { date: '2026-11-16', activeKwh: 100, reactiveKvarh: 20 },
    ]
    const forecast = forecastMonthlyPowerFactor({ asOfDate: '2026-11-19', threshold: 0.9, days })
    expect(forecast.fallbackDays).toBeGreaterThan(0)
    expect(forecast.assumptions.join('\n')).toContain('all-day fallback')
  })

  it('does not invent a factor when no energy exists', () => {
    const forecast = forecastMonthlyPowerFactor({ asOfDate: '2026-11-19', threshold: 0.9, days: [] })
    expect(forecast.projectedPowerFactor).toBeUndefined()
    expect(forecast.risk).toBe('risk')
    expect(forecast.warnings).toContain('no completed energy day is available for the current month')
  })

  it('rejects duplicate, negative, and invalid-threshold inputs', () => {
    expect(() => forecastMonthlyPowerFactor({
      asOfDate: '2026-11-19',
      threshold: 0.9,
      days: [
        { date: '2026-11-01', activeKwh: 1, reactiveKvarh: 0 },
        { date: '2026-11-01', activeKwh: 1, reactiveKvarh: 0 },
      ],
    })).toThrow(/repeats/)
    expect(() => forecastMonthlyPowerFactor({
      asOfDate: '2026-11-19',
      threshold: 0.9,
      days: [{ date: '2026-11-01', activeKwh: -1, reactiveKvarh: 0 }],
    })).toThrow(/non-negative|negative/)
    expect(() => forecastMonthlyPowerFactor({ asOfDate: '2026-11-19', threshold: 1.2, days: [] })).toThrow(/between 0 and 1/)
  })
})
