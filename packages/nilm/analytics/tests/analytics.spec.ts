import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type { TariffSlice } from '@deepseek-ai/dsh-nilm-tariff'
import NilmAnalyticsService, {
  calculateCompareTrends,
  calculateEnergyCosts,
  calculateRunningAndIdleTime,
  summarizeApplianceStates,
  type ApplianceStateSample,
  type DeviceTransition,
  type EnergyBucket,
} from '../src/index.ts'

const HOUR = 3_600_000
const t0 = 1_000_000

const plan = { planId: 'plan-1' }

function slice(startHour: number, endHour: number, periodType: TariffSlice['periodType'], pricePerKwh: number): TariffSlice {
  return { startMs: t0 + startHour * HOUR, endMs: t0 + endHour * HOUR, periodType, pricePerKwh, planId: 'plan-1' }
}

function codeOf(action: () => void): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return error instanceof NilmError ? error.code : 'not-nilm'
  }
}

describe('calculateEnergyCosts', () => {
  it('prices a bucket that exactly spans two slices and fills per-band totals', () => {
    const result = calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + 2 * HOUR, energyKwh: 200 }],
      [slice(0, 1, 'valley', 0.5), slice(1, 2, 'peak', 1.5)],
      plan,
    )
    expect(result).toMatchObject({
      totalEnergyKwh: 200,
      pricedEnergyKwh: 200,
      unpricedEnergyKwh: 0,
      totalCost: 200,
      precise: true,
      warnings: [],
    })
    expect(result.byPeriod.valley).toEqual({ energyKwh: 100, cost: 50 })
    expect(result.byPeriod.peak).toEqual({ energyKwh: 100, cost: 150 })
    expect(result.byPeriod.flat).toEqual({ energyKwh: 0, cost: 0 })
  })

  it('prorates a bucket uniformly across a slice boundary', () => {
    const result = calculateEnergyCosts(
      [{ startMs: t0 + HOUR / 2, endMs: t0 + 3 * HOUR, energyKwh: 250 }],
      [slice(0, 2, 'flat', 0.8), slice(2, 3, 'peak', 1.2)],
      plan,
    )
    expect(result.pricedEnergyKwh).toBe(250)
    expect(result.byPeriod.flat.energyKwh).toBe(150)
    expect(result.byPeriod.peak.energyKwh).toBe(100)
    expect(result.totalCost).toBeCloseTo(240, 10)
  })

  it('keeps energy outside every slice unpriced and marks the result imprecise', () => {
    const result = calculateEnergyCosts(
      [{ startMs: t0 + 2 * HOUR, endMs: t0 + 3 * HOUR, energyKwh: 50 }],
      [slice(0, 1, 'valley', 0.5)],
      plan,
    )
    expect(result.totalEnergyKwh).toBe(50)
    expect(result.pricedEnergyKwh).toBe(0)
    expect(result.unpricedEnergyKwh).toBe(50)
    expect(result.precise).toBe(false)
    expect(result.warnings).toContain('bucket 0 has no tariff slice and 50 kWh remains unpriced')
    expect(result.warnings).toContain('50 kWh falls outside the priced slices')
  })

  it('marks an empty slice set as imprecise', () => {
    const result = calculateEnergyCosts([{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }], [], plan)
    expect(result.precise).toBe(false)
    expect(result.warnings).toContain('plan plan-1 supplied no priced slices')
  })

  it('rejects malformed buckets and overlapping or invalid slices', () => {
    expect(codeOf(() => calculateEnergyCosts([{ startMs: t0, endMs: t0, energyKwh: 1 }], [], plan))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts([{ startMs: t0, endMs: t0 + HOUR, energyKwh: -1 }], [], plan))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts([{ startMs: Number.NaN, endMs: t0 + HOUR, energyKwh: 1 }], [], plan))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }],
      [slice(0, 2, 'flat', 1), slice(1, 3, 'peak', 1)],
      plan,
    ))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }],
      [{ ...slice(0, 1, 'flat', 1), pricePerKwh: -1 }],
      plan,
    ))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }],
      [{ ...slice(0, 1, 'flat', 1), endMs: t0 }],
      plan,
    ))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }],
      [{ ...slice(0, 1, 'flat', 1), periodType: 'unknown' as never }],
      plan,
    ))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateEnergyCosts(
      [{ startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }],
      [{ ...slice(0, 1, 'flat', 1), startMs: Number.NaN }],
      plan,
    ))).toBe('INVALID_ARGUMENT')
  })
})

describe('calculateRunningAndIdleTime', () => {
  const window = { startMs: t0, endMs: t0 + 10 * HOUR }

  function transition(hours: number, isRunning: boolean, isIdle: boolean): DeviceTransition {
    return { ts: t0 + hours * HOUR, isRunning, isIdle }
  }

  it('uses the last pre-window transition as the initial state', () => {
    const result = calculateRunningAndIdleTime([
      transition(-1, true, false),
      transition(4, false, true),
      transition(6, false, false),
    ], window, 0)
    expect(result.runningMinutes).toBe(240)
    expect(result.idleMinutes).toBe(120)
    expect(result.unknownMinutes).toBe(240)
    expect(result.validRatio).toBe(0.6)
  })

  it('stays unknown until the first in-window transition when no prior state exists', () => {
    const result = calculateRunningAndIdleTime([transition(2, true, false), transition(4, false, true)], window, 0)
    expect(result.runningMinutes).toBe(120)
    expect(result.idleMinutes).toBe(360)
    expect(result.unknownMinutes).toBe(120)
  })

  it('absorbs a short state flip into the preceding state', () => {
    const result = calculateRunningAndIdleTime([
      transition(0, true, false),
      transition(1, false, true),
      transition(1.1, true, false),
    ], { startMs: t0, endMs: t0 + 5 * HOUR }, 30 * 60_000)
    expect(result.runningMinutes).toBe(300)
    expect(result.idleMinutes).toBe(0)
  })

  it('absorbs a short first segment into the next state', () => {
    const result = calculateRunningAndIdleTime([
      transition(0, true, false),
      transition(0.1, false, true),
    ], { startMs: t0, endMs: t0 + 5 * HOUR }, 30 * 60_000)
    expect(result.idleMinutes).toBe(300)
    expect(result.runningMinutes).toBe(0)
  })

  it('keeps unknown gaps even when they are short', () => {
    const result = calculateRunningAndIdleTime([
      transition(0, true, false),
      transition(1, false, false),
      transition(1.1, true, false),
    ], { startMs: t0, endMs: t0 + 2 * HOUR }, 0)
    expect(result.unknownMinutes).toBe(6)
    expect(result.runningMinutes).toBe(114)
  })

  it('merges adjacent equal states and ignores transitions outside the window', () => {
    const result = calculateRunningAndIdleTime([
      transition(-2, false, true),
      transition(-1, false, true),
      transition(3, true, false),
      transition(20, false, true),
    ], window, 0)
    expect(result.idleMinutes).toBe(180)
    expect(result.runningMinutes).toBe(420)
  })

  it('rejects malformed windows, dwell, and contradictory states', () => {
    expect(codeOf(() => calculateRunningAndIdleTime([], { startMs: t0, endMs: t0 }, 0))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateRunningAndIdleTime([], window, -1))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateRunningAndIdleTime([transition(0, true, true)], window, 0))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateRunningAndIdleTime([{ ts: Number.NaN, isRunning: true, isIdle: false }], window, 0))).toBe('INVALID_ARGUMENT')
  })
})

describe('calculateCompareTrends', () => {
  it('returns signed deltas and percentages for comparable, precise periods', () => {
    const result = calculateCompareTrends(
      { energyKwh: 120, cost: 96, coverage: 0.99 },
      { energyKwh: 100, cost: 80, coverage: 0.98 },
    )
    expect(result).toEqual({
      energyDeltaKwh: 20,
      energyDeltaPct: 0.2,
      costDelta: 16,
      costDeltaPct: 0.2,
      comparable: true,
      precise: true,
      warnings: [],
    })
  })

  it('omits ratios for a zero baseline and omits cost when either side lacks it', () => {
    const result = calculateCompareTrends(
      { energyKwh: 5, coverage: 1 },
      { energyKwh: 0, cost: 0, coverage: 1 },
    )
    expect(result.energyDeltaPct).toBeUndefined()
    expect(result.costDelta).toBeUndefined()
    expect(result.costDeltaPct).toBeUndefined()
  })

  it('marks low coverage imprecise and a wide coverage gap incomparable', () => {
    const result = calculateCompareTrends(
      { energyKwh: 10, cost: 8, coverage: 0.9 },
      { energyKwh: 20, cost: 12, coverage: 0.99 },
    )
    expect(result.precise).toBe(false)
    expect(result.comparable).toBe(false)
    expect(result.warnings).toEqual([
      'coverage below 95%; cost and energy comparisons are estimates',
      'coverage differs by more than 2 percentage points; comparability is reduced',
    ])
  })

  it('rejects malformed metrics', () => {
    expect(codeOf(() => calculateCompareTrends({ energyKwh: -1, coverage: 1 }, { energyKwh: 1, coverage: 1 }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateCompareTrends({ energyKwh: 1, coverage: 1.1 }, { energyKwh: 1, coverage: 1 }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateCompareTrends({ energyKwh: 1, coverage: Number.NaN }, { energyKwh: 1, coverage: 1 }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => calculateCompareTrends({ energyKwh: 1, cost: -1, coverage: 1 }, { energyKwh: 1, coverage: 1 }))).toBe('INVALID_ARGUMENT')
  })
})

describe('energy bucket type', () => {
  it('accepts integral buckets without extra fields', () => {
    const bucket: EnergyBucket = { startMs: t0, endMs: t0 + HOUR, energyKwh: 1 }
    expect(bucket.energyKwh).toBe(1)
  })
})

describe('summarizeApplianceStates', () => {
  function sample(tsMs: number, running: boolean, powerKw: number | null): ApplianceStateSample {
    return { tsMs, terminalId: 't1', applianceNum: 3, running, powerKw, currentA: null }
  }

  it('integrates only credited running intervals and leaves long gaps unknown', () => {
    const result = summarizeApplianceStates([
      sample(t0, true, 10),
      sample(t0 + 30 * 60_000, true, 10),
      sample(t0 + 45 * 60_000, false, null),
    ], { startMs: t0, endMs: t0 + HOUR }, 15 * 60_000)
    expect(result).toHaveLength(1)
    expect(result[0]?.runningMinutes).toBe(15)
    expect(result[0]?.stoppedMinutes).toBe(15)
    expect(result[0]?.unknownMinutes).toBe(30)
    expect(result[0]?.estimatedEnergyKwh).toBe(2.5)
    expect(result[0]?.warnings[0]).toContain('long sample gaps')
  })

  it('keeps terminals and appliance numbers as separate groups', () => {
    const result = summarizeApplianceStates([
      sample(t0, true, 1),
      { ...sample(t0, true, 2), terminalId: 't2' },
      { ...sample(t0, false, null), applianceNum: 4 },
    ], { startMs: t0, endMs: t0 + 60_000 }, 60_000)
    expect(result.map(row => [row.terminalId, row.applianceNum])).toEqual([
      ['t1', 3], ['t1', 4], ['t2', 3],
    ])
  })

  it('warns for a lone sample and rejects malformed input', () => {
    expect(summarizeApplianceStates([sample(t0, true, 1)], { startMs: t0, endMs: t0 + 60_000 })[0]?.warnings)
      .toContain('a single sample cannot establish a reliable state duration')
    expect(codeOf(() => summarizeApplianceStates([], { startMs: t0, endMs: t0 }))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => summarizeApplianceStates([], { startMs: t0, endMs: t0 + 1 }, 0))).toBe('INVALID_ARGUMENT')
  })
})


describe('NilmAnalyticsService facade', () => {
  it('delegates power-quality and CUSUM operations to the pure functions', async () => {
    const ctx = new Context()
    const service = new NilmAnalyticsService(ctx)
    try {
      expect(service.energyWeightedPowerFactor(800, 600)).toBeCloseTo(0.8, 9)
      const power = service.analyzePowerQuality([
        { tsMs: t0, activePowerKw: 10, reactivePowerKvar: 2, powerFactor: 0.98, harmonicCurrentA: {} },
        { tsMs: t0 + 1000, activePowerKw: 10, reactivePowerKvar: 2, powerFactor: 0.98, harmonicCurrentA: {} },
      ], { startMs: t0, endMs: t0 + 1000 })
      expect(power.activeEnergyKwh).toBeCloseTo(10 / 3600, 9)
      const features = service.detectTimeSeriesFeatures([
        { tsMs: t0, powerKw: 1 },
        { tsMs: t0 + 1000, powerKw: 1 },
      ], { startMs: t0, endMs: t0 + 2000 })
      expect(features.events).toEqual([])
      expect(features.coverage).toBeCloseTo(0.5, 9)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
