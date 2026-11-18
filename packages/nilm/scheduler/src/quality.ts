/**
 * R-08 data-quality checks. Findings are operational facts, never customer
 * alerts, and every threshold is supplied by deployment configuration.
 * @module @deepseek-ai/dsh-nilm-scheduler/quality
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'

/** One meter or terminal observation used by R-08. */
export interface DataQualityObservation {
  /** Stable meter, terminal, or channel identifier. */
  scopeId: string
  /** Human-readable scope label. */
  scopeName: string
  /** Expected-sample coverage from 0 to 1. */
  coverage: number
  /** Parent meter energy over the window in kWh. */
  parentEnergyKwh?: number
  /** Sum of child meter energy over the same window in kWh. */
  childEnergyKwh?: number
  /** Hot-store energy over the window in kWh. */
  hotEnergyKwh?: number
  /** Cold-store energy over the same window in kWh. */
  coldEnergyKwh?: number
}

/** R-08 thresholds. */
export interface QualityThresholds {
  /** Minimum acceptable sample coverage from 0 to 1. */
  minimumCoverage: number
  /** Maximum acceptable parent-child energy deviation as a ratio. */
  maximumParentDeviation: number
  /** Maximum acceptable hot-cold energy deviation as a ratio. */
  maximumHotColdDeviation: number
}

/** Finding family emitted by R-08. */
export type QualityFindingKind = 'coverage' | 'parent_child' | 'hot_cold'

/** One deterministic R-08 violation. */
export interface QualityFinding {
  /** Finding family. */
  kind: QualityFindingKind
  /** Affected scope. */
  scopeId: string
  /** Affected scope label. */
  scopeName: string
  /** Observed coverage or deviation ratio. */
  observed: number
  /** Configured threshold. */
  threshold: number
  /** Bounded operational explanation. */
  message: string
}

/**
 * Evaluate R-08 over already collected observations.
 * @param observations - coverage and energy observations.
 * @param thresholds - deployment thresholds.
 * @returns findings in input order, then by finding family.
 * @throws NilmError with `INVALID_ARGUMENT` for malformed observations or thresholds.
 */
export function evaluateDataQuality(
  observations: readonly DataQualityObservation[],
  thresholds: QualityThresholds,
): QualityFinding[] {
  validateThresholds(thresholds)
  const findings: QualityFinding[] = []
  for (const [index, observation] of observations.entries()) {
    const coverage = ratio(observation.coverage, `observations[${String(index)}].coverage`)
    if (coverage < thresholds.minimumCoverage) {
      findings.push({
        kind: 'coverage',
        scopeId: observation.scopeId,
        scopeName: observation.scopeName,
        observed: coverage,
        threshold: thresholds.minimumCoverage,
        message: `${observation.scopeName} 采集覆盖率 ${formatPct(coverage)}，低于 ${formatPct(thresholds.minimumCoverage)}`,
      })
    }
    if (observation.parentEnergyKwh !== undefined && observation.childEnergyKwh !== undefined) {
      const parent = nonNegative(observation.parentEnergyKwh, `observations[${String(index)}].parentEnergyKwh`)
      const child = nonNegative(observation.childEnergyKwh, `observations[${String(index)}].childEnergyKwh`)
      const deviation = relativeDeviation(parent, child)
      if (deviation > thresholds.maximumParentDeviation) {
        findings.push({
          kind: 'parent_child',
          scopeId: observation.scopeId,
          scopeName: observation.scopeName,
          observed: deviation,
          threshold: thresholds.maximumParentDeviation,
          message: `${observation.scopeName} 父子计量偏差 ${formatPct(deviation)}，高于 ${formatPct(thresholds.maximumParentDeviation)}`,
        })
      }
    }
    if (observation.hotEnergyKwh !== undefined && observation.coldEnergyKwh !== undefined) {
      const hot = nonNegative(observation.hotEnergyKwh, `observations[${String(index)}].hotEnergyKwh`)
      const cold = nonNegative(observation.coldEnergyKwh, `observations[${String(index)}].coldEnergyKwh`)
      const deviation = relativeDeviation(hot, cold)
      if (deviation > thresholds.maximumHotColdDeviation) {
        findings.push({
          kind: 'hot_cold',
          scopeId: observation.scopeId,
          scopeName: observation.scopeName,
          observed: deviation,
          threshold: thresholds.maximumHotColdDeviation,
          message: `${observation.scopeName} 冷热库电量偏差 ${formatPct(deviation)}，高于 ${formatPct(thresholds.maximumHotColdDeviation)}`,
        })
      }
    }
  }
  return findings
}

/**
 * Compute the relative deviation between two non-negative energy totals.
 * @param reference - parent or hot total.
 * @param candidate - child-sum or cold total.
 * @returns absolute difference divided by the larger total.
 */
function relativeDeviation(reference: number, candidate: number): number {
  const denominator = Math.max(reference, candidate)
  if (denominator === 0) return 0
  return Math.abs(reference - candidate) / denominator
}

/**
 * Validate R-08 thresholds.
 * @param thresholds - configured ratios.
 */
function validateThresholds(thresholds: QualityThresholds): void {
  ratio(thresholds.minimumCoverage, 'minimumCoverage')
  nonNegative(thresholds.maximumParentDeviation, 'maximumParentDeviation')
  nonNegative(thresholds.maximumHotColdDeviation, 'maximumHotColdDeviation')
}

/**
 * Validate a ratio from 0 to 1.
 * @param value - candidate ratio.
 * @param label - diagnostic label.
 * @returns the same value.
 */
function ratio(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw invalid(`${label} must be between 0 and 1`)
  return value
}

/**
 * Validate one non-negative value.
 * @param value - candidate value.
 * @param label - diagnostic label.
 * @returns the same value.
 */
function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw invalid(`${label} must be finite and non-negative`)
  return value
}

/**
 * Format a ratio as a percentage.
 * @param ratioValue - ratio from 0 to 1.
 * @returns percentage text with two decimals.
 */
function formatPct(ratioValue: number): string {
  return `${(ratioValue * 100).toFixed(2)}%`
}

/**
 * Build a stable invalid-argument error.
 * @param message - diagnostic text.
 * @returns the error.
 */
function invalid(message: string): NilmError {
  return new NilmError('INVALID_ARGUMENT', message)
}
