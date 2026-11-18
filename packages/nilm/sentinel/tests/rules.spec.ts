import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import {
  evaluateR01a,
  evaluateR01b,
  evaluateR02,
  evaluateR03,
  evaluateR04,
  evaluateR05,
  isSustained,
  parseThresholds,
} from '../src/index.ts'

describe('threshold parsing', () => {
  it('parses each supported rule payload', () => {
    expect(parseThresholds('R-01a', { stepKw: 5, minIncrementKw: 1, samples: 2 }))
      .toEqual({ stepKw: 5, minIncrementKw: 1, samples: 2 })
    expect(parseThresholds('R-02', '{"idlePowerKw":0.3,"sustainedMinutes":30}'))
      .toEqual({ idlePowerKw: 0.3, sustainedMinutes: 30 })
    expect(parseThresholds('R-05', { deviationPercent: 10, criticalPercent: 15, sustainedMinutes: 5, nominalVoltageV: 230 }))
      .toEqual({ deviationPercent: 10, criticalPercent: 15, sustainedMinutes: 5, nominalVoltageV: 230 })
  })

  it('fails loud on a missing or negative threshold', () => {
    expect(() => parseThresholds('R-01a', { stepKw: -1, minIncrementKw: 0, samples: 2 })).toThrow(NilmError)
    expect(() => parseThresholds('R-03', {})).toThrow(/overloadRatio/)
    expect(() => parseThresholds('R-01a', 'not json')).toThrow(/valid JSON/)
  })
})

describe('R-01a non-work step', () => {
  it('fires when consecutive samples exceed baseline plus step and the increment is material', () => {
    const finding = evaluateR01a({
      samples: [5, 5, 12, 13],
      baselineKw: 5,
      energyPricePerKwh: 1,
      thresholds: { stepKw: 5, minIncrementKw: 2, samples: 2, criticalCostPerHour: 5 },
    })
    expect(finding).toMatchObject({
      severity: 'critical',
      metric: 'non_work_step_kw',
      value: 8,
      threshold: 5,
      facts: { wasteCostPerHour: 8 },
    })
    expect(finding?.summary).toContain('每小时浪费')
  })

  it('does not fire on an isolated spike or a small increment', () => {
    expect(evaluateR01a({
      samples: [3, 15],
      baselineKw: 5,
      thresholds: { stepKw: 5, minIncrementKw: 1, samples: 2 },
    })).toBeUndefined()
    expect(evaluateR01a({
      samples: [11, 11],
      baselineKw: 10,
      thresholds: { stepKw: 0.5, minIncrementKw: 2, samples: 2 },
    })).toBeUndefined()
  })
})

describe('R-01b base-load deviation', () => {
  it('fires only after the sustained window', () => {
    const thresholds = { baselineMultiplier: 1.2, sustainedMinutes: 10 }
    expect(evaluateR01b({ powerKw: 15, baselineKw: 10, sustained: false, thresholds })).toBeUndefined()
    expect(evaluateR01b({ powerKw: 10.5, baselineKw: 10, sustained: true, thresholds })).toBeUndefined()
    expect(evaluateR01b({ powerKw: 15, baselineKw: 10, sustained: true, thresholds })).toMatchObject({
      severity: 'warning',
      value: 15,
      threshold: 12,
      metric: 'non_work_base_load_kw',
    })
  })
})

describe('R-02 device long-run and idle', () => {
  it('fires for a running appliance below idle power for the configured window', () => {
    const now = 1_700_000_000_000
    const finding = evaluateR02({
      name: '空压机',
      powerKw: 0.2,
      running: true,
      stateSinceMs: now - 40 * 60_000,
      nowMs: now,
      thresholds: { idlePowerKw: 0.5, sustainedMinutes: 30 },
    })
    expect(finding).toMatchObject({ severity: 'warning', metric: 'appliance_idle_power_kw', value: 0.2 })
  })

  it('ignores a stopped appliance and a short interval', () => {
    const now = 1_700_000_000_000
    const thresholds = { idlePowerKw: 0.5, sustainedMinutes: 30 }
    expect(evaluateR02({ name: '风机', powerKw: 0, running: false, stateSinceMs: now - 60_000, nowMs: now, thresholds }))
      .toBeUndefined()
    expect(evaluateR02({ name: '风机', powerKw: 0.1, running: true, stateSinceMs: now - 60_000, nowMs: now, thresholds }))
      .toBeUndefined()
  })
})

describe('R-03 overload', () => {
  it('is critical above the rated ratio', () => {
    expect(evaluateR03({ powerKw: 12, ratedPowerKw: 10, thresholds: { overloadRatio: 1.1 } }))
      .toMatchObject({ severity: 'critical', value: 12, threshold: 11 })
    expect(evaluateR03({ powerKw: 10.5, ratedPowerKw: 10, thresholds: { overloadRatio: 1.1 } })).toBeUndefined()
  })
})

describe('R-04 three-phase unbalance', () => {
  it('computes the worst deviation from the mean', () => {
    const finding = evaluateR04({
      currents: { a: 100, b: 80, c: 60 },
      sustained: true,
      thresholds: { unbalancePercent: 10, criticalPercent: 30, sustainedMinutes: 5 },
    })
    expect(finding).toMatchObject({ severity: 'warning', metric: 'three_phase_unbalance_percent', value: 25 })
  })

  it('requires the sustained window and finite non-negative values', () => {
    const thresholds = { unbalancePercent: 10, criticalPercent: 30, sustainedMinutes: 5 }
    expect(evaluateR04({ currents: { a: 100, b: 80, c: 60 }, sustained: false, thresholds })).toBeUndefined()
    expect(evaluateR04({ currents: { a: -1, b: 80, c: 60 }, sustained: true, thresholds })).toBeUndefined()
  })
})

describe('R-05 voltage deviation', () => {
  it('fires on the worst phase deviation', () => {
    const finding = evaluateR05({
      voltages: { a: 220, b: 220, c: 240 },
      nominalVoltageV: 220,
      sustained: true,
      thresholds: { deviationPercent: 5, criticalPercent: 10, sustainedMinutes: 5 },
    })
    expect(finding).toMatchObject({ severity: 'warning', metric: 'voltage_deviation_percent', value: 9.0909 })
    expect(finding?.summary).toContain('偏高')
  })

  it('promotes to critical at the configured percentage', () => {
    const finding = evaluateR05({
      voltages: { a: 240, b: 240, c: 240 },
      nominalVoltageV: 220,
      sustained: true,
      thresholds: { deviationPercent: 5, criticalPercent: 8, sustainedMinutes: 5 },
    })
    expect(finding?.severity).toBe('critical')
  })
})

describe('sustained window', () => {
  it('accepts a complete violated window and rejects gaps or partial coverage', () => {
    const now = 1_700_000_000_000
    const window = 5 * 60_000
    const samples = [0, 1, 2, 3, 4, 5].map(offset => ({ tsMs: now - window + offset * 60_000, violated: true }))
    expect(isSustained(samples, now, window, 5)).toBe(true)
    expect(isSustained([...samples.slice(0, 2)], now, window, 5)).toBe(false)
    expect(isSustained([...samples.slice(0, 3), { tsMs: now - 30_000, violated: false }], now, window, 5)).toBe(false)
  })
})
