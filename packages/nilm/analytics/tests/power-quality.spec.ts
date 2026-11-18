import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import {
  analyzePowerQuality,
  energyWeightedPowerFactor,
  phaseUnbalancePct,
  type PowerQualitySample,
} from '../src/index.ts'

const MINUTE = 60_000
const t0 = Date.UTC(2026, 10, 18, 0, 0, 0)

function sample(overrides: Partial<PowerQualitySample> & { tsMs: number }): PowerQualitySample {
  return {
    activePowerKw: 100,
    reactivePowerKvar: 50,
    powerFactor: 0.894,
    harmonicCurrentA: {},
    ...overrides,
  }
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return error instanceof NilmError ? error.code : 'not-nilm'
  }
}

describe('energyWeightedPowerFactor', () => {
  it('derives the billing power factor from active and reactive energy', () => {
    expect(energyWeightedPowerFactor(800, 600)).toBeCloseTo(0.8, 9)
    expect(energyWeightedPowerFactor(100, 0)).toBe(1)
  })

  it('returns undefined when active energy is not positive', () => {
    expect(energyWeightedPowerFactor(0, 10)).toBeUndefined()
    expect(energyWeightedPowerFactor(-5, 10)).toBeUndefined()
  })

  it('rejects non-finite energy', () => {
    expect(errorCode(() => energyWeightedPowerFactor(Number.NaN, 1))).toBe('INVALID_ARGUMENT')
  })
})

describe('phaseUnbalancePct', () => {
  it('uses the maximum deviation from the three-phase mean', () => {
    expect(phaseUnbalancePct({ A: 100, B: 100, C: 130 })).toBeCloseTo(18.1818, 4)
  })

  it('returns undefined when a phase is missing or all phases are zero', () => {
    expect(phaseUnbalancePct({ A: 100, B: 100 })).toBeUndefined()
    expect(phaseUnbalancePct({ A: 0, B: 0, C: 0 })).toBeUndefined()
  })

  it('rejects negative phase current', () => {
    expect(errorCode(() => phaseUnbalancePct({ A: -1, B: 10, C: 10 }))).toBe('INVALID_ARGUMENT')
  })
})

describe('analyzePowerQuality', () => {
  it('integrates adjacent samples into active and reactive energy', () => {
    const samples = Array.from({ length: 61 }, (_, index) => sample({ tsMs: t0 + index * MINUTE }))
    const result = analyzePowerQuality(samples, { startMs: t0, endMs: t0 + 60 * MINUTE })
    expect(result.activeEnergyKwh).toBeCloseTo(100, 6)
    expect(result.reactiveEnergyKvarh).toBeCloseTo(50, 6)
    expect(result.energyWeightedPowerFactor).toBeCloseTo(100 / Math.sqrt(100 * 100 + 50 * 50), 6)
    expect(result.powerFactorRisk).toBe('warning')
    expect(result.sampleCoverage).toBe(1)
  })

  it('applies the configured threshold and treats the warning band as inclusive', () => {
    const samples = Array.from({ length: 11 }, (_, index) => sample({
      tsMs: t0 + index * MINUTE,
      activePowerKw: 86,
      reactivePowerKvar: 50,
    }))
    const window = { startMs: t0, endMs: t0 + 10 * MINUTE }
    expect(analyzePowerQuality(samples, window, { powerFactorThreshold: 0.9 }).powerFactorRisk).toBe('warning')
    expect(analyzePowerQuality(samples, window, { powerFactorThreshold: 0.8 }).powerFactorRisk).toBe('ok')
    expect(analyzePowerQuality(samples, window, { powerFactorThreshold: 0.95 }).powerFactorRisk).toBe('critical')
  })

  it('returns only the harmonic orders upstream supplied and never claims complete THD', () => {
    const samples = [
      ...Array.from({ length: 11 }, (_, index) => sample({
        tsMs: t0 + index * MINUTE,
        harmonicCurrentA: { 1: 100, 3: 12, 5: 5 },
      })),
      sample({ tsMs: t0 + 11 * MINUTE, harmonicCurrentA: { 1: 0, 3: 12 } }),
    ]
    const result = analyzePowerQuality(samples, { startMs: t0, endMs: t0 + 12 * MINUTE })
    const bands = new Map(result.harmonicBands.map(band => [band.order, band]))
    expect(bands.get(3)).toMatchObject({ available: true, meanPct: 12, maxPct: 12, samples: 11 })
    expect(bands.get(5)).toMatchObject({ available: true, meanPct: 5 })
    expect(bands.get(2)?.available).toBe(false)
    expect(bands.get(2)?.meanPct).toBe(null)
    expect(bands.get(7)?.available).toBe(false)
    expect(result.warnings).toContain('harmonic content is reported per available order; it is not a complete THD value')
  })

  it('leaves gaps longer than the integration limit uncovered', () => {
    const samples = [
      sample({ tsMs: t0 }),
      sample({ tsMs: t0 + MINUTE }),
      sample({ tsMs: t0 + 40 * MINUTE }),
    ]
    const result = analyzePowerQuality(samples, { startMs: t0, endMs: t0 + 40 * MINUTE })
    expect(result.activeEnergyKwh).toBeCloseTo(100 / 60, 6)
    expect(result.sampleCoverage).toBeCloseTo(1 / 40, 6)
    expect(result.warnings).toContain('sample gaps longer than 900000 ms were left uncovered')
    expect(result.warnings).toContain('less than 95% of the window contributed to energy integration')
  })

  it('reports the worst voltage deviation only when a nominal voltage is configured', () => {
    const samples = [
      sample({ tsMs: t0, voltageV: 220 }),
      sample({ tsMs: t0 + MINUTE, voltageV: 235 }),
      sample({ tsMs: t0 + 2 * MINUTE, voltageV: null }),
    ]
    const window = { startMs: t0, endMs: t0 + 2 * MINUTE }
    expect(analyzePowerQuality(samples, window).worstVoltageDeviationPct).toBe(null)
    expect(analyzePowerQuality(samples, window).warnings).toContain('nominal voltage is not configured; voltage deviation is unavailable')
    expect(analyzePowerQuality(samples, window, { nominalVoltageV: 220 }).worstVoltageDeviationPct).toBeCloseTo(6.8182, 3)
  })

  it('reports the worst three-phase unbalance from supplied phase currents', () => {
    const samples = [
      sample({ tsMs: t0, phaseCurrentA: { A: 100, B: 100, C: 100 } }),
      sample({ tsMs: t0 + MINUTE, phaseCurrentA: { A: 100, B: 100, C: 130 } }),
    ]
    const result = analyzePowerQuality(samples, { startMs: t0, endMs: t0 + MINUTE })
    expect(result.worstUnbalancePct).toBeCloseTo(18.1818, 4)
    expect(result.warnings).not.toContain('upstream did not provide three-phase currents; unbalance is unavailable')
  })

  it('returns an unknown risk and no power factor when active energy is not positive', () => {
    const samples = [
      sample({ tsMs: t0, activePowerKw: 0 }),
      sample({ tsMs: t0 + MINUTE, activePowerKw: 0 }),
    ]
    const result = analyzePowerQuality(samples, { startMs: t0, endMs: t0 + MINUTE })
    expect(result.energyWeightedPowerFactor).toBe(null)
    expect(result.powerFactorRisk).toBe('unknown')
  })

  it('skips intervals outside the window and intervals missing active or reactive power', () => {
    const samples = [
      sample({ tsMs: t0 }),
      sample({ tsMs: t0 + 10_000, activePowerKw: null }),
      sample({ tsMs: t0 + 20_000 }),
      sample({ tsMs: t0 + 30_000, reactivePowerKvar: null }),
      sample({ tsMs: t0 + 40_000 }),
    ]
    const result = analyzePowerQuality(samples, { startMs: t0 + 20_000, endMs: t0 + 40_000 })
    expect(result.activeEnergyKwh).toBeCloseTo(100 * 10_000 / 3_600_000, 9)
    expect(result.sampleCoverage).toBeCloseTo(0.5, 9)
    expect(result.warnings).toContain('intervals without both active and reactive power were excluded from energy')
    expect(result.warnings).toContain('less than 95% of the window contributed to energy integration')
  })

  it('rejects an invalid threshold, nominal voltage, gap, or window', () => {
    const samples = [sample({ tsMs: t0 }), sample({ tsMs: t0 + MINUTE })]
    const window = { startMs: t0, endMs: t0 + MINUTE }
    expect(errorCode(() => analyzePowerQuality(samples, window, { powerFactorThreshold: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality(samples, window, { nominalVoltageV: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality(samples, window, { maxGapMs: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality(samples, { startMs: t0, endMs: t0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality([sample({ tsMs: t0, voltageV: Number.NaN })], window))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality([sample({ tsMs: t0, harmonicCurrentA: { 3: Number.NaN } })], window))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => analyzePowerQuality([sample({ tsMs: t0, phaseCurrentA: { A: Number.NaN } })], window))).toBe('INVALID_ARGUMENT')
  })
})
