import { describe, expect, it } from 'vitest'
import { evaluateDataQuality } from '../src/index.ts'

const THRESHOLDS = {
  minimumCoverage: 0.95,
  maximumParentDeviation: 0.01,
  maximumHotColdDeviation: 0.01,
}

describe('R-08 data quality', () => {
  it('reports coverage, parent-child, and hot-cold violations', () => {
    const findings = evaluateDataQuality([{
      scopeId: 'terminal-1',
      scopeName: '一号终端',
      coverage: 0.94,
      parentEnergyKwh: 100,
      childEnergyKwh: 109,
      hotEnergyKwh: 100,
      coldEnergyKwh: 98,
    }], THRESHOLDS)

    expect(findings.map(finding => finding.kind)).toEqual(['coverage', 'parent_child', 'hot_cold'])
    expect(findings[1]!.observed).toBeCloseTo(9 / 109, 6)
    expect(findings[2]!.observed).toBeCloseTo(0.02, 6)
  })

  it('stays silent when observations are within the configured thresholds', () => {
    expect(evaluateDataQuality([{
      scopeId: 'terminal-1',
      scopeName: '一号终端',
      coverage: 0.99,
      parentEnergyKwh: 100,
      childEnergyKwh: 100.5,
      hotEnergyKwh: 100,
      coldEnergyKwh: 100.5,
    }], THRESHOLDS)).toEqual([])
  })

  it('treats zero totals as zero deviation', () => {
    expect(evaluateDataQuality([{
      scopeId: 'terminal-1',
      scopeName: '一号终端',
      coverage: 1,
      parentEnergyKwh: 0,
      childEnergyKwh: 0,
      hotEnergyKwh: 0,
      coldEnergyKwh: 0,
    }], THRESHOLDS)).toEqual([])
  })

  it('rejects malformed ratios and observations', () => {
    expect(() => evaluateDataQuality([], { ...THRESHOLDS, minimumCoverage: 1.1 })).toThrow(/between 0 and 1/)
    expect(() => evaluateDataQuality([{
      scopeId: 'terminal-1',
      scopeName: '一号终端',
      coverage: 0.99,
      parentEnergyKwh: -1,
      childEnergyKwh: 0,
    }], THRESHOLDS)).toThrow(/non-negative/)
  })
})
