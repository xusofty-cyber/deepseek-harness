/**
 * Mapping from upstream `nilm_unsafe_record` rows to stage-3 findings. Only
 * confirmed type names are mapped; an unknown type is reported, never guessed
 * into the wrong rule.
 * @module @deepseek-ai/dsh-nilm-sentinel/unsafe
 */

import type { AlertSeverity, SentinelRuleId } from './model.ts'
import type { RuleFinding } from './rules.ts'

/** Upstream unsafe-record fields consumed by the scanner. */
export interface UnsafeRecordRow {
  /** Upstream primary identifier. */
  recordId: string
  /** Upstream event time. */
  recordTime: string | Date
  /** Terminal/channel tag used for topology matching. */
  terminalChannelId: string | null
  /** Asset identifier used for topology matching. */
  assetId: string | null
  /** Upstream hazard type. */
  unsafeType: string
  /** Upstream description. */
  unsafeDesc: string | null
  /** Observed power in kW, when supplied. */
  power: string | number | null
  /** Observed current in amperes, when supplied. */
  current: string | number | null
  /** Appliance name when the upstream row identified one. */
  applianceName: string | null
  /** Upstream handling status. */
  handlingStatus: string | null
}

/** Classification attached to one upstream record. */
export interface UnsafeClassification {
  /** Rule that owns the hazard family. */
  ruleId: SentinelRuleId
  /** Base severity; the tenant rule may raise it but never lower a safety-critical value. */
  severity: AlertSeverity
  /** Metric name stored with the alert. */
  metric: string
  /** Whether the finding bypasses the silence window. */
  bypassSilence: boolean
}

const SAFETY_CRITICAL_TYPES = ['transient', 'step', 'shock', 'arc', 'flashover'] as const
const OVERLOAD_TYPES = ['overload', 'over_current', 'overcurrent', 'current_over', 'power_over'] as const
const UNBALANCE_TYPES = ['unbalance', 'imbalance', 'three_phase', 'phase_loss'] as const
const VOLTAGE_TYPES = ['voltage', 'over_voltage', 'under_voltage', 'voltage_deviation'] as const

/**
 * Classify one upstream hazard type.
 * @param unsafeType - upstream type name.
 * @returns the classification, or `undefined` for an unconfirmed type.
 */
export function classifyUnsafeType(unsafeType: string): UnsafeClassification | undefined {
  const normalized = normalize(unsafeType)
  if (normalized.length === 0) return undefined
  if (matches(normalized, SAFETY_CRITICAL_TYPES)) {
    return { ruleId: 'R-01a', severity: 'critical', metric: 'unsafe_transient_event', bypassSilence: true }
  }
  if (matches(normalized, OVERLOAD_TYPES)) {
    return { ruleId: 'R-03', severity: 'critical', metric: 'unsafe_overload_power_kw', bypassSilence: true }
  }
  if (matches(normalized, UNBALANCE_TYPES)) {
    return { ruleId: 'R-04', severity: 'warning', metric: 'unsafe_three_phase_event', bypassSilence: false }
  }
  if (matches(normalized, VOLTAGE_TYPES)) {
    return { ruleId: 'R-05', severity: 'warning', metric: 'unsafe_voltage_event', bypassSilence: false }
  }
  return undefined
}

/**
 * Convert one upstream row to a deterministic finding.
 * @param row - upstream row.
 * @param classification - result of {@link classifyUnsafeType}.
 * @returns the rule finding and the row's event instant.
 */
export function findingFromUnsafeRow(
  row: UnsafeRecordRow,
  classification: UnsafeClassification,
): { finding: RuleFinding; rawEventTimeMs: number } {
  const rawEventTimeMs = toMs(row.recordTime, row.recordId)
  const power = numeric(row.power)
  const current = numeric(row.current)
  const value = classification.metric.endsWith('_a') && current !== undefined
    ? current
    : classification.metric.endsWith('_kw') && power !== undefined ? power : 1
  const unit = classification.metric.endsWith('_a') && current !== undefined
    ? 'A'
    : classification.metric.endsWith('_kw') && power !== undefined ? 'kW' : 'count'
  const detail = cleanText(row.unsafeDesc, 300)
  const appliance = cleanText(row.applianceName, 80)
  const scopeText = appliance === '' ? '' : `设备「${appliance}」`
  const summary = detail === ''
    ? `上游隐患记录 ${cleanText(row.unsafeType, 64)}：${scopeText || '现场监测点'}触发安全规则，请核查。`
    : `上游隐患记录：${detail}${scopeText === '' ? '' : `（${scopeText}）`}。`
  return {
    finding: {
      severity: classification.severity,
      metric: classification.metric,
      value: round(value),
      threshold: null,
      unit,
      summary: summary.slice(0, 1024),
      facts: {
        sourceRecordId: row.recordId,
        unsafeType: cleanText(row.unsafeType, 64),
        terminalChannelId: row.terminalChannelId,
        assetId: row.assetId,
        applianceName: appliance === '' ? null : appliance,
        power: power === undefined ? null : round(power),
        current: current === undefined ? null : round(current),
        handlingStatus: row.handlingStatus,
      },
    },
    rawEventTimeMs,
  }
}

/**
 * Read an upstream timestamp as epoch milliseconds.
 * @param value - ISO text or Date.
 * @param recordId - diagnostic identifier.
 * @returns the instant.
 * @throws NilmError-shaped Error when the timestamp is invalid.
 */
export function toMs(value: string | Date, recordId: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`unsafe record ${recordId} has an invalid record_time`)
  return ms
}

/**
 * Normalize an upstream type for matching.
 * @param value - upstream type text.
 * @returns lowercase text with separators collapsed.
 */
function normalize(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[\s-]+/g, '_')
}

/**
 * Test whether a normalized type contains one of the confirmed fragments.
 * @param normalized - normalized upstream type.
 * @param fragments - confirmed fragments for the family.
 * @returns true when any fragment occurs.
 */
function matches(normalized: string, fragments: readonly string[]): boolean {
  return fragments.some(fragment => normalized.includes(fragment))
}

/**
 * Read a nullable numeric upstream value without substituting zero.
 * @param value - driver value.
 * @returns the finite number, or `undefined` when absent or invalid.
 */
function numeric(value: string | number | null): number | undefined {
  if (value === null) return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * Remove control characters and bound text copied into deterministic summaries.
 * @param value - upstream text.
 * @param max - maximum retained characters.
 * @returns cleaned text.
 */
function cleanText(value: string | null, max: number): string {
  if (value === null) return ''
  return value.replaceAll(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, max)
}

/**
 * Round to the metric storage precision.
 * @param value - raw value.
 * @returns rounded value.
 */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
