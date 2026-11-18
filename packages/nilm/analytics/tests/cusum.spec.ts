import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import {
  detectPowerEdges,
  detectTimeSeriesFeatures,
  diagnoseMicroHazards,
  pairCycles,
  type TimeSeriesFeature,
  type TimeSeriesSample,
} from '../src/index.ts'

const SECOND = 1000
const t0 = Date.UTC(2026, 10, 18, 0, 0, 0)

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function feature(overrides: Partial<TimeSeriesFeature> = {}): TimeSeriesFeature {
  return {
    atMs: t0,
    direction: 'up',
    beforeKw: 0,
    afterKw: 2,
    deltaKw: 2,
    deltaReactiveKvar: null,
    durationMs: 0,
    inrushRatio: null,
    inrushDurationMs: null,
    phaseImbalancePct: null,
    harmonicDeltaA: { 3: null, 5: null, 7: null },
    powerFactorBefore: null,
    powerFactorAfter: null,
    powerFactorDelta: null,
    ...overrides,
  }
}

function numberEvidence(value: number | string | null | undefined): number {
  return typeof value === 'number' ? value : 0
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return error instanceof NilmError ? error.code : 'not-nilm'
  }
}

interface Step {
  atSecond: number
  deltaKw: number
  inrushPeakRatio?: number
}

function baseline(seconds: number, steps: readonly Step[], seed = 20261118): TimeSeriesSample[] {
  const random = lcg(seed)
  const samples: TimeSeriesSample[] = []
  let powerKw = 10
  for (let second = 0; second < seconds; second += 1) {
    for (const step of steps) {
      if (step.atSecond === second) powerKw += step.deltaKw
    }
    const inrush = steps.find(step => second >= step.atSecond && second < step.atSecond + 3 && step.inrushPeakRatio !== undefined)
    const steadyCurrent = 20 + powerKw * 2
    const currentA = (inrush?.inrushPeakRatio ?? 1) * steadyCurrent + (random() - 0.5) * 0.4
    samples.push({
      tsMs: t0 + second * SECOND,
      powerKw: powerKw + (random() - 0.5) * 0.16,
      currentA,
    })
  }
  return samples
}

function matchCount(actual: readonly TimeSeriesFeature[], expected: readonly Step[]): number {
  const used = new Set<number>()
  let matched = 0
  for (const event of actual) {
    const index = expected.findIndex((step, candidate) => {
      if (used.has(candidate)) return false
      const direction = step.deltaKw >= 0 ? 'up' : 'down'
      return direction === event.direction && Math.abs(t0 + step.atSecond * SECOND - event.atMs) <= 3 * SECOND
    })
    if (index >= 0) {
      used.add(index)
      matched += 1
    }
  }
  return matched
}

describe('detectTimeSeriesFeatures', () => {
  it('recovers motor, heater, and fan steps from industrial white noise with bounded output', () => {
    const steps: Step[] = [
      { atSecond: 600, deltaKw: 5.5, inrushPeakRatio: 3.2 },
      { atSecond: 1800, deltaKw: -5.5 },
      { atSecond: 2400, deltaKw: 8 },
      { atSecond: 4200, deltaKw: -8 },
      { atSecond: 4800, deltaKw: 3, inrushPeakRatio: 1.8 },
      { atSecond: 6600, deltaKw: -3 },
    ]
    const samples = baseline(7200, steps).filter(sample => {
      const second = (sample.tsMs - t0) / SECOND
      return second < 3000 || second >= 3030
    })
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 7200 * SECOND })
    const matched = matchCount(result.events, steps)
    const recall = matched / steps.length
    const precision = matched / result.events.length
    expect(recall >= 0.98).toBe(true)
    expect(precision >= 0.95).toBe(true)
    expect(result.events.length <= 20).toBe(true)
    const motorStart = result.events.find(event => event.direction === 'up' && Math.abs(event.atMs - (t0 + 600 * SECOND)) <= 3 * SECOND)
    expect(motorStart?.inrushRatio === null || motorStart?.inrushRatio === undefined).toBe(false)
    const relativeError = Math.abs((motorStart?.inrushRatio ?? 0) - 3.2) / 3.2
    expect(relativeError < 0.02).toBe(true)
    expect(JSON.stringify(result.events).length < 4096).toBe(true)
    expect(result.cycles.length).toBe(3)
    expect(result.warnings).toContain('power samples contain a gap longer than 15000 ms; edges across it were ignored')
    expect(result.events.map(event => (event.atMs - t0) / SECOND)).toEqual([600, 1800, 2400, 4199, 4799, 6599])
  })

  it('collapses repeated detections during one transition into one event', () => {
    const samples = baseline(120, [{ atSecond: 40, deltaKw: 8 }])
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND })
    expect(result.events).toHaveLength(1)
    expect(Math.abs((result.events[0]?.atMs ?? 0) - (t0 + 40 * SECOND)) <= 2 * SECOND).toBe(true)
    expect(result.events[0]?.deltaKw).toBeCloseTo(8, 0)
  })

  it('processes four hours of second-level samples within the analysis budget', () => {
    const steps: Step[] = [
      { atSecond: 600, deltaKw: 5.5 },
      { atSecond: 1800, deltaKw: -5.5 },
      { atSecond: 2400, deltaKw: 8 },
      { atSecond: 4200, deltaKw: -8 },
      { atSecond: 4800, deltaKw: 3 },
      { atSecond: 6600, deltaKw: -3 },
      { atSecond: 8400, deltaKw: 6 },
      { atSecond: 10200, deltaKw: -6 },
      { atSecond: 12000, deltaKw: 4 },
      { atSecond: 13800, deltaKw: -4 },
    ]
    const samples = baseline(14_400, steps)
    const durations: number[] = []
    let result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 14_400 * SECOND })
    for (let run = 0; run < 5; run += 1) {
      const startedAt = performance.now()
      result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 14_400 * SECOND })
      durations.push(performance.now() - startedAt)
    }
    const p95 = [...durations].sort((left, right) => left - right).at(-1)!
    expect(p95 < 2500).toBe(true)
    expect(result.events.length <= 20).toBe(true)
    expect(JSON.stringify(result.events).length < 4096).toBe(true)
  })

  it('pairs a symmetric up and down step into one cycle', () => {
    const samples = baseline(300, [
      { atSecond: 30, deltaKw: 4 },
      { atSecond: 210, deltaKw: -4 },
    ])
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 300 * SECOND })
    expect(result.cycles).toHaveLength(1)
    expect(result.cycles[0]).toMatchObject({ startMs: t0 + 30 * SECOND, endMs: t0 + 210 * SECOND, durationMs: 180 * SECOND })
  })
})

describe('diagnoseMicroHazards through detectTimeSeriesFeatures', () => {
  it('flags more than five starts in ten minutes as frequent cycling', () => {
    const steps: Step[] = []
    for (let index = 0; index < 6; index += 1) {
      steps.push({ atSecond: 60 + index * 80, deltaKw: 2 })
      steps.push({ atSecond: 100 + index * 80, deltaKw: -2 })
    }
    const samples = baseline(600, steps)
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 600 * SECOND })
    const hazard = result.hazards.find(candidate => candidate.kind === 'frequent_cycling')
    expect(hazard?.severity).toBe('warning')
    expect(hazard?.evidence.starts).toBe(6)
  })

  it('flags an inrush that stays above steady current for more than eight seconds', () => {
    const samples = baseline(120, [{ atSecond: 20, deltaKw: 5, inrushPeakRatio: 3 }])
    for (const sample of samples) {
      const second = (sample.tsMs - t0) / SECOND
      if (second >= 20 && second < 35) sample.currentA = 3
      else if (second >= 35) sample.currentA = 1
    }
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND })
    const hazard = result.hazards.find(candidate => candidate.kind === 'startup_lag')
    expect(hazard?.severity).toBe('critical')
    expect(hazard?.evidence.inrushDurationMs).toBe(15_000)
  })

  it('flags phase unbalance above fifteen percent after a step', () => {
    const samples = baseline(120, [{ atSecond: 20, deltaKw: 5 }])
    for (const sample of samples) {
      const second = (sample.tsMs - t0) / SECOND
      sample.phaseCurrentA = second >= 20 ? { A: 100, B: 100, C: 140 } : { A: 60, B: 60, C: 60 }
    }
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND })
    const hazard = result.hazards.find(candidate => candidate.kind === 'phase_unbalance')
    expect(hazard?.severity).toBe('critical')
    expect(numberEvidence(hazard?.evidence.phaseImbalancePct) > 15).toBe(true)
  })

  it('flags a harmonic jump together with a power-factor swing', () => {
    const samples = baseline(120, [{ atSecond: 20, deltaKw: 5 }])
    for (const sample of samples) {
      const second = (sample.tsMs - t0) / SECOND
      sample.powerFactor = second >= 20 ? 0.85 : 0.95
      sample.harmonicCurrentA = { 3: second >= 20 ? 2 : 0.2, 5: 0, 7: 0 }
    }
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND })
    const hazard = result.hazards.find(candidate => candidate.kind === 'harmonic_resonance')
    expect(hazard?.severity).toBe('critical')
    expect(numberEvidence(hazard?.evidence.harmonicDeltaA) > 1).toBe(true)
    expect(Math.abs(numberEvidence(hazard?.evidence.powerFactorDelta)) > 0.05).toBe(true)
  })
})

describe('CUSUM edge cases', () => {
  it('returns an empty bounded result for no samples', () => {
    const edges = detectPowerEdges([])
    expect(edges.edges).toEqual([])
    expect(edges.coverage).toBe(0)
    const features = detectTimeSeriesFeatures([], { startMs: t0, endMs: t0 + SECOND })
    expect(features.events).toEqual([])
  })

  it('warns when sparse samples cover less than ninety-five percent of the window', () => {
    const samples = [
      { tsMs: t0, powerKw: 1 },
      { tsMs: t0 + SECOND, powerKw: 1 },
      { tsMs: t0 + 60 * SECOND, powerKw: 1 },
    ]
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 60 * SECOND })
    expect(result.coverage < 0.95).toBe(true)
    expect(result.warnings).toContain('less than 95% of the window has adjacent finite power samples')
  })

  it('caps returned edges and reports the truncation', () => {
    const samples = baseline(600, [
      { atSecond: 60, deltaKw: 3 },
      { atSecond: 300, deltaKw: -3 },
    ])
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 600 * SECOND }, { maxEvents: 1 })
    expect(result.events).toHaveLength(1)
    expect(result.warnings).toContain('detected 2 edges; only the first 1 are returned')
  })

  it('ignores a step below the configured minimum delta', () => {
    const samples = baseline(120, [{ atSecond: 40, deltaKw: 1 }])
    const result = detectTimeSeriesFeatures(
      samples,
      { startMs: t0, endMs: t0 + 120 * SECOND },
      { thresholdKw: 0.01, driftKw: 0.001, minDeltaKw: 5 },
    )
    expect(result.events).toEqual([])
  })

  it('handles power-only samples and a missing power sample without inventing current', () => {
    const samples = baseline(120, [{ atSecond: 20, deltaKw: 3 }])
    for (const sample of samples) delete sample.currentA
    samples[5]!.powerKw = null
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND })
    expect(result.events).toHaveLength(1)
    expect(result.events[0]?.inrushRatio).toBe(null)
    expect(result.events[0]?.inrushDurationMs).toBe(null)
    expect(result.warnings).toContain('upstream did not provide three-phase currents; phase unbalance is unavailable')
  })

  it('supports an odd steady-state window', () => {
    const samples = baseline(120, [{ atSecond: 40, deltaKw: 4 }])
    const result = detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 + 120 * SECOND }, { steadyWindow: 3 })
    expect(result.events).toHaveLength(1)
    expect((result.events[0]?.deltaKw ?? 0) > 1).toBe(true)
  })

  it('returns no inrush settling time when current never reaches the steady band inside the limit', () => {
    const samples = baseline(120, [{ atSecond: 20, deltaKw: 5 }])
    for (const sample of samples) {
      const second = (sample.tsMs - t0) / SECOND
      sample.currentA = second < 20 || second >= 51 ? 1 : 3
    }
    const result = detectTimeSeriesFeatures(
      samples,
      { startMs: t0, endMs: t0 + 120 * SECOND },
      { inrushWindowMs: 20_000, settleWindowMs: 30_000 },
    )
    expect(result.events[0]?.inrushRatio).toBeCloseTo(3, 0)
    expect(result.events[0]?.inrushDurationMs).toBe(null)
  })

  it('skips an up step while looking for a down partner and deduplicates identical hazards', () => {
    const events = [
      feature({ atMs: t0, direction: 'up', deltaKw: 2 }),
      feature({ atMs: t0 + SECOND, direction: 'up', deltaKw: 2 }),
      feature({ atMs: t0 + 2 * SECOND, direction: 'down', deltaKw: -2 }),
    ]
    expect(pairCycles(events)).toHaveLength(2)
    const hazards = diagnoseMicroHazards([
      feature({ phaseImbalancePct: 20 }),
      feature({ phaseImbalancePct: 20 }),
    ])
    expect(hazards).toHaveLength(1)
    expect(hazards[0]?.kind).toBe('phase_unbalance')
  })
})

describe('CUSUM validation', () => {
  it('rejects malformed windows and tunables', () => {
    const samples = baseline(10, [])
    expect(errorCode(() => detectPowerEdges(samples, { thresholdKw: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges(samples, { driftKw: 2 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges(samples, { edgeMergeMs: -1 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectTimeSeriesFeatures(samples, { startMs: t0, endMs: t0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges([{ tsMs: t0, powerKw: 1, phaseCurrentA: { A: Number.NaN } }]))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges([{ tsMs: t0, powerKw: 1, harmonicCurrentA: { 3: Number.NaN } }]))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges(samples, { filterRadius: -1 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges(samples, { steadyWindow: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges(samples, { maxEvents: 0 }))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges([{ tsMs: Number.NaN, powerKw: 1 }]))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectPowerEdges([{ tsMs: t0, powerKw: Number.NaN }]))).toBe('INVALID_ARGUMENT')
    expect(errorCode(() => detectTimeSeriesFeatures(samples, { startMs: Number.NaN, endMs: t0 }))).toBe('INVALID_ARGUMENT')
  })

  it('keeps cycle pairing tolerant of a request for no tolerance', () => {
    expect(errorCode(() => pairCycles([], { cycleToleranceRatio: 1 }))).toBe('INVALID_ARGUMENT')
  })
})
