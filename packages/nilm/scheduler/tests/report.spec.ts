import { describe, expect, it } from 'vitest'
import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import {
  buildMorningReport,
  buildPowerFactorReport,
  forecastMonthlyPowerFactor,
} from '../src/index.ts'
import { energyDays } from './fake-data-source.ts'

const COST: CostBreakdown = {
  totalEnergyKwh: 300,
  pricedEnergyKwh: 300,
  unpricedEnergyKwh: 0,
  totalCost: 210,
  byPeriod: {
    sharp: { energyKwh: 30, cost: 30 },
    peak: { energyKwh: 90, cost: 90 },
    flat: { energyKwh: 120, cost: 72 },
    valley: { energyKwh: 60, cost: 18 },
  },
  precise: true,
  warnings: [],
}

describe('report builders', () => {
  it('builds deterministic morning payload, chart, and shares', () => {
    const built = buildMorningReport({
      tenantId: 'tenant-a',
      tenantName: '工厂A',
      reportDate: '2026-11-17',
      dayStartMs: Date.parse('2026-11-17T00:00:00+08:00'),
      dayEndMs: Date.parse('2026-11-18T00:00:00+08:00'),
      buckets: [
        { startMs: Date.parse('2026-11-17T00:00:00+08:00'), endMs: Date.parse('2026-11-17T01:00:00+08:00'), energyKwh: 100 },
        { startMs: Date.parse('2026-11-17T01:00:00+08:00'), endMs: Date.parse('2026-11-17T02:00:00+08:00'), energyKwh: 200 },
      ],
      dataQuality: { coverage: 0.98, source: 'raw' },
      tariff: { planId: 'plan-1', cost: COST },
      workshops: [
        { name: '冲压', energyKwh: 180 },
        { name: '装配', energyKwh: 120 },
        { name: '涂装', energyKwh: 0 },
      ],
      alerts: { critical: 1, warning: 2, info: 3, unresolved: 4 },
      warnings: ['sample caveat', 'sample caveat'],
    })

    const payload = built.payload
    if (payload.kind !== 'morning_report') throw new Error('expected morning payload')
    expect(payload.energy).toEqual({ totalKwh: 300, coverage: 0.98, source: 'raw' })
    expect(payload.cost?.totalCost).toBe(210)
    expect(payload.periodShares).toEqual({ sharp: 0.1, peak: 0.3, flat: 0.4, valley: 0.2 })
    expect(payload.workshopRanking[0]).toEqual({ name: '冲压', energyKwh: 180, share: 0.6 })
    expect(payload.warnings).toEqual(['sample caveat'])
    expect(built.chart).toMatchObject({ version: 1, type: 'line', series: [{ data: [100, 200] }] })
    expect(built.summaryText).toContain('210.00 元')
    expect(built.summaryText).toContain('冲压')
    expect(built.summaryText).toContain('严重 1 条')
  })

  it('keeps period shares null when no tariff plan is available', () => {
    const built = buildMorningReport({
      tenantId: 'tenant-a',
      tenantName: '工厂A',
      reportDate: '2026-11-17',
      dayStartMs: 0,
      dayEndMs: 86_400_000,
      buckets: [],
      dataQuality: { coverage: 0, source: 'raw' },
      workshops: [],
      alerts: { critical: 0, warning: 0, info: 0, unresolved: 0 },
      warnings: [],
    })
    const payload = built.payload
    if (payload.kind !== 'morning_report') throw new Error('expected morning payload')
    expect(payload.cost).toBeNull()
    expect(payload.periodShares).toEqual({ sharp: null, peak: null, flat: null, valley: null })
    expect(built.summaryText).toContain('费用未计算')
  })

  it('builds a mandatory monthly forecast report', () => {
    const forecast = forecastMonthlyPowerFactor({ asOfDate: '2026-11-19', threshold: 0.9, days: energyDays(19, 100, 20) })
    const built = buildPowerFactorReport({
      tenantId: 'tenant-a',
      tenantName: '工厂A',
      reportDate: '2026-11-20',
      forecast,
    })
    const payload = built.payload
    if (payload.kind !== 'pf_forecast') throw new Error('expected forecast payload')
    expect(payload.mandatory).toBe(true)
    expect(built.summaryText).toContain('0.9806')
    expect(built.summaryText).toContain('风险 pass')
  })
})
