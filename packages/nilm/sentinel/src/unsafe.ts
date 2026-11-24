/**
 * Mapping from upstream `nilm_unsafe_record` rows to stage-3 findings. Only
 * confirmed type names are mapped; an unknown type is reported, never guessed
 * into the wrong rule.
 * @module @deepseek-ai/dsh-nilm-sentinel/unsafe
 */

import { classifyUnsafeHazard, type UnsafeHazardFamily } from '@deepseek-ai/dsh-nilm-core'
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

const FAMILY_RULES: Readonly<Record<UnsafeHazardFamily, Omit<UnsafeClassification, 'severity'>>> = {
  transient: { ruleId: 'R-01a', metric: 'unsafe_transient_event', bypassSilence: true },
  overload: { ruleId: 'R-03', metric: 'unsafe_overload_power_kw', bypassSilence: true },
  unbalance: { ruleId: 'R-04', metric: 'unsafe_three_phase_event', bypassSilence: false },
  voltage: { ruleId: 'R-05', metric: 'unsafe_voltage_event', bypassSilence: false },
}

/**
 * Classify one upstream hazard type through the shared core classifier.
 * @param unsafeType - upstream type name.
 * @returns the classification, or `undefined` for an unconfirmed type.
 */
export function classifyUnsafeType(unsafeType: string): UnsafeClassification | undefined {
  const hazard = classifyUnsafeHazard(unsafeType)
  if (hazard === undefined) return undefined
  return { ...FAMILY_RULES[hazard.family], severity: hazard.severity }
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
