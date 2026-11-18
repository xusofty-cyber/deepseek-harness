/**
 * Alert vocabulary, keys, and lifecycle rules independent of storage or timers.
 * @module @deepseek-ai/dsh-nilm-sentinel/model
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'

/** Severity ordered from least to most urgent. */
export type AlertSeverity = 'info' | 'warning' | 'critical'

/** Persisted alert lifecycle state. */
export type AlertState =
  | 'detected'
  | 'confirmed'
  | 'notified'
  | 'acknowledged'
  | 'resolved'
  | 'suppressed'
  | 'false_positive'

/** Fixed notification channel vocabulary shared with the Outbox schema. */
export type NotificationChannel = 'wx_subscribe' | 'wx_template' | 'wecom_webhook' | 'sms'

/** Source that produced an alert event. */
export type AlertSourceType = 'sentinel_rule' | 'upstream_unsafe' | 'scheduler_check'

/** Topology level of an alert scope. */
export type AlertScopeLevel = 'factory' | 'workshop' | 'terminal' | 'channel' | 'appliance'

/** Supported stage-3 rule identifiers. */
export type SentinelRuleId = 'R-01a' | 'R-01b' | 'R-02' | 'R-03' | 'R-04' | 'R-05'

/** All stage-3 rule identifiers in evaluation order. */
export const SENTINEL_RULE_IDS: readonly SentinelRuleId[] = ['R-01a', 'R-01b', 'R-02', 'R-03', 'R-04', 'R-05']

/** Ordered severity rank used for comparisons. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  info: 0,
  warning: 1,
  critical: 2,
}

/** Ordered notification channels; the first configured channel is the primary. */
export const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['wx_subscribe', 'wx_template', 'wecom_webhook', 'sms']

const ALERT_TRANSITIONS: Readonly<Record<AlertState, readonly AlertState[]>> = {
  detected: ['confirmed', 'suppressed', 'false_positive'],
  confirmed: ['notified', 'acknowledged', 'resolved', 'suppressed', 'false_positive'],
  notified: ['acknowledged', 'resolved', 'false_positive'],
  acknowledged: ['resolved', 'false_positive'],
  resolved: [],
  suppressed: ['confirmed', 'false_positive'],
  false_positive: [],
}

/** One scope addressed by a rule. */
export interface AlertScope {
  /** Topology level. */
  level: AlertScopeLevel
  /** Stable project node identifier. */
  id: string
  /** Human-readable node name used in deterministic summaries. */
  name: string
}

/** One deterministic rule finding before persistence. */
export interface AlertCandidate {
  /** Owning tenant. */
  tenantId: string
  /** Rule that produced the finding. */
  ruleId: SentinelRuleId
  /** Event source family. */
  sourceType: AlertSourceType
  /** Addressable scope. */
  scope: AlertScope
  /** Final severity; escalation may raise it later. */
  severity: AlertSeverity
  /** Metric name stored in `nilm_alert_event.metric_name`. */
  metric: string
  /** Observed numeric value. */
  value: number
  /** Configured threshold, absent for upstream-classified events. */
  threshold: number | null
  /** Metric unit. */
  unit: string
  /** De-duplication bucket start in epoch milliseconds. */
  bucketStartMs: number
  /** Upstream event or sample instant in epoch milliseconds. */
  rawEventTimeMs: number
  /** Deterministic template summary; never model-authored. */
  summaryText: string
  /** Channels requested by the rule configuration. */
  channels: readonly NotificationChannel[]
  /** Suppression window in minutes. */
  silentMinutes: number
  /** True only for safety findings that must bypass the silence window. */
  bypassSilence?: boolean
  /** Extra deterministic context copied to the Outbox payload. */
  facts: Readonly<Record<string, string | number | boolean | null>>
}

/**
 * Compare severities.
 * @param left - first severity.
 * @param right - second severity.
 * @returns negative, zero, or positive ordering value.
 */
export function compareSeverity(left: AlertSeverity, right: AlertSeverity): number {
  return SEVERITY_RANK[left] - SEVERITY_RANK[right]
}

/**
 * Return the more urgent severity.
 * @param left - first severity.
 * @param right - second severity.
 * @returns the higher-ranked severity.
 */
export function maxSeverity(left: AlertSeverity, right: AlertSeverity): AlertSeverity {
  return compareSeverity(left, right) >= 0 ? left : right
}

/**
 * Assert one legal lifecycle transition.
 * @param from - current state.
 * @param to - requested state.
 * @returns the destination state.
 * @throws NilmError with `INVALID_ARGUMENT` when the transition is illegal.
 */
export function assertAlertTransition(from: AlertState, to: AlertState): AlertState {
  if (!ALERT_TRANSITIONS[from].includes(to)) {
    throw new NilmError('INVALID_ARGUMENT', `illegal alert transition ${from} -> ${to}`)
  }
  return to
}

/**
 * Build the cross-window suppression key.
 * @param tenantId - tenant boundary.
 * @param ruleId - rule identifier.
 * @param scopeId - scope identifier.
 * @param metric - metric name.
 * @returns the stable suppression key.
 */
export function silenceKey(tenantId: string, ruleId: string, scopeId: string, metric: string): string {
  return `${tenantId}:${ruleId}:${scopeId}:${metric}`
}

/**
 * Align an instant to the start of its de-duplication bucket.
 * @param atMs - instant in epoch milliseconds.
 * @param bucketMs - bucket width in milliseconds.
 * @returns bucket start in epoch milliseconds.
 */
export function alignBucket(atMs: number, bucketMs: number): number {
  if (!Number.isFinite(atMs) || !Number.isInteger(bucketMs) || bucketMs <= 0) {
    throw new NilmError('INVALID_ARGUMENT', 'bucket alignment requires a finite instant and positive bucket width')
  }
  return Math.floor(atMs / bucketMs) * bucketMs
}

/**
 * Build the per-bucket de-duplication key.
 * @param tenantId - tenant boundary.
 * @param ruleId - rule identifier.
 * @param scopeId - scope identifier.
 * @param metric - metric name.
 * @param bucketStartMs - bucket start in epoch milliseconds.
 * @returns the de-duplication key, at most 191 characters for the indexed column.
 */
export function dedupeKey(
  tenantId: string,
  ruleId: string,
  scopeId: string,
  metric: string,
  bucketStartMs: number,
): string {
  const key = `${silenceKey(tenantId, ruleId, scopeId, metric)}:${String(Math.floor(bucketStartMs / 1000))}`
  if (key.length > 191) throw new NilmError('INVALID_ARGUMENT', 'dedupe key exceeds the 191-character storage limit')
  return key
}

/**
 * Build the escalation notification key that bypasses suppression.
 * @param baseDedupeKey - bucketed de-duplication key.
 * @param severity - escalated severity.
 * @returns the escalation key.
 */
export function escalationDedupeKey(baseDedupeKey: string, severity: AlertSeverity): string {
  return `${baseDedupeKey}:escalated:${severity}`
}

/**
 * Convert a persisted status to the initial state after a new finding.
 * @param notified - whether at least one notification is being enqueued.
 * @returns `confirmed` for deliverable alerts, `suppressed` otherwise.
 */
export function initialState(notified: boolean): AlertState {
  return notified ? 'confirmed' : 'suppressed'
}
