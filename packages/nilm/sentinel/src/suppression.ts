/**
 * Suppression-window and escalation decisions for one candidate alert.
 * @module @deepseek-ai/dsh-nilm-sentinel/suppression
 */

import type { AlertCandidate, AlertSeverity } from './model.ts'
import { compareSeverity, dedupeKey, escalationDedupeKey } from './model.ts'

/** One persisted bucket observation used by escalation checks. */
export interface WindowObservation {
  /** Persisted event identifier. */
  eventId: string
  /** Bucket start in epoch milliseconds. */
  bucketStartMs: number
  /** Observed metric value. */
  value: number
  /** Persisted severity. */
  severity: AlertSeverity
  /** Persisted lifecycle state. */
  state: string
}

/** Decision consumed by the scanner before the transactional write. */
export interface NotificationDecision {
  /** Whether to enqueue a notification. */
  action: 'notify' | 'suppress'
  /** Final severity after any escalation. */
  severity: AlertSeverity
  /** Severity replaced by escalation, when applicable. */
  escalatedFrom?: AlertSeverity
  /** Outbox de-duplication key. */
  dedupeKey: string
  /** Stable explanation for tests, audit, and deterministic summaries. */
  reason: string
}

/** Inputs whose combination decides notification versus silent recording. */
export interface DecideNotificationInput {
  /** Candidate finding. */
  candidate: AlertCandidate
  /** Previous observations for the same silence key, ascending by bucket. */
  history: readonly WindowObservation[]
  /** Most recent successfully sent notification instant for the silence key. */
  lastNotifiedAtMs?: number
  /** Bucket width used to prove that escalation windows are consecutive. */
  bucketMs: number
  /** Number of consecutive rising windows required for escalation. */
  escalateAfterWindows: number
}

/**
 * Decide whether the candidate is suppressed or delivered. Critical findings
 * always notify; a warning that rises across consecutive windows is promoted
 * to critical and bypasses the silence window with a distinct key.
 * @param input - candidate, history, and cadence.
 * @returns the notification decision.
 */
export function decideNotification(input: DecideNotificationInput): NotificationDecision {
  const { candidate, history, lastNotifiedAtMs, bucketMs, escalateAfterWindows } = input
  const baseKey = dedupeKey(candidate.tenantId, candidate.ruleId, candidate.scope.id, candidate.metric, candidate.bucketStartMs)
  if (escalateAfterWindows < 2) throw new Error('escalateAfterWindows must be at least 2')
  if (candidate.bypassSilence === true) {
    return {
      action: 'notify',
      severity: candidate.severity,
      dedupeKey: baseKey,
      reason: 'safety-finding-never-silenced',
    }
  }
  const escalation = escalationFor(candidate, history, bucketMs, escalateAfterWindows)
  if (escalation !== undefined) {
    return {
      action: 'notify',
      severity: 'critical',
      escalatedFrom: candidate.severity,
      dedupeKey: escalationDedupeKey(baseKey, 'critical'),
      reason: escalation,
    }
  }
  if (candidate.silentMinutes > 0 && lastNotifiedAtMs !== undefined) {
    const silenceUntilMs = lastNotifiedAtMs + candidate.silentMinutes * 60_000
    if (candidate.rawEventTimeMs < silenceUntilMs) {
      return {
        action: 'suppress',
        severity: candidate.severity,
        dedupeKey: baseKey,
        reason: `within-silence-window:${String(candidate.silentMinutes)}m`,
      }
    }
  }
  return {
    action: 'notify',
    severity: candidate.severity,
    dedupeKey: baseKey,
    reason: 'outside-silence-window',
  }
}

/**
 * Detect a rising run of consecutive over-threshold windows.
 * @param candidate - current finding.
 * @param history - prior observations, ascending.
 * @param bucketMs - bucket width.
 * @param requiredWindows - total consecutive windows including the current one.
 * @returns the escalation reason, or `undefined` when escalation does not apply.
 */
export function escalationFor(
  candidate: AlertCandidate,
  history: readonly WindowObservation[],
  bucketMs: number,
  requiredWindows: number,
): string | undefined {
  if (requiredWindows < 2) return undefined
  if (candidate.threshold === null) return undefined
  if (!(candidate.value > candidate.threshold)) return undefined
  if (compareSeverity(candidate.severity, 'critical') >= 0) return undefined
  const needed = requiredWindows - 1
  if (history.length < needed) return undefined
  const recent = history.slice(-needed)
  let expectedBucket = candidate.bucketStartMs - bucketMs
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const observation = recent[index]
    if (observation === undefined) return undefined
    if (observation.bucketStartMs !== expectedBucket) return undefined
    if (!(observation.value > candidate.threshold)) return undefined
    if (compareSeverity(observation.severity, 'critical') >= 0) return undefined
    expectedBucket -= bucketMs
  }
  const previousMax = Math.max(...recent.map(item => item.value))
  if (!(candidate.value > previousMax)) return undefined
  return `escalated-after-${String(requiredWindows)}-rising-windows`
}
