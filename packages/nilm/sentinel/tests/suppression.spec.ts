import { describe, expect, it } from 'vitest'
import {
  alignBucket,
  decideNotification,
  type AlertCandidate,
  type WindowObservation,
} from '../src/index.ts'

const BUCKET = 300_000
const NOW = alignBucket(1_700_000_123, BUCKET)

function candidate(overrides: Partial<AlertCandidate> = {}): AlertCandidate {
  return {
    tenantId: 'tenant-a',
    ruleId: 'R-01b',
    sourceType: 'sentinel_rule',
    scope: { level: 'channel', id: 'channel-1', name: '一号车间/总进线' },
    severity: 'warning',
    metric: 'non_work_base_load_kw',
    value: 20,
    threshold: 10,
    unit: 'kW',
    bucketStartMs: NOW,
    rawEventTimeMs: NOW + 1_000,
    summaryText: '夜间基载偏高',
    channels: ['wx_subscribe'],
    silentMinutes: 30,
    facts: {},
    ...overrides,
  }
}

function observation(bucketStartMs: number, value: number): WindowObservation {
  return { eventId: `alert_${String(bucketStartMs)}`, bucketStartMs, value, severity: 'warning', state: 'suppressed' }
}

describe('suppression window', () => {
  it('notifies the first finding and suppresses repeats inside the window', () => {
    const first = decideNotification({
      candidate: candidate(),
      history: [],
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(first.action).toBe('notify')

    const repeated = decideNotification({
      candidate: candidate({ bucketStartMs: NOW + BUCKET, rawEventTimeMs: NOW + BUCKET + 1_000 }),
      history: [observation(NOW, 20)],
      lastNotifiedAtMs: NOW,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(repeated).toMatchObject({ action: 'suppress', reason: 'within-silence-window:30m' })
  })

  it('delivers again after the silence window', () => {
    const decision = decideNotification({
      candidate: candidate({ bucketStartMs: NOW, rawEventTimeMs: NOW }),
      history: [],
      lastNotifiedAtMs: NOW - 31 * 60_000,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(decision.action).toBe('notify')
  })
})

describe('escalation', () => {
  it('promotes a warning after three consecutive rising windows and bypasses silence', () => {
    const decision = decideNotification({
      candidate: candidate({ value: 20 }),
      history: [observation(NOW - 2 * BUCKET, 12), observation(NOW - BUCKET, 15)],
      lastNotifiedAtMs: NOW,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(decision).toMatchObject({
      action: 'notify',
      severity: 'critical',
      escalatedFrom: 'warning',
      reason: 'escalated-after-3-rising-windows',
    })
    expect(decision.dedupeKey).toMatch(/:escalated:critical$/)
  })

  it('does not escalate when the magnitude shrinks', () => {
    const decision = decideNotification({
      candidate: candidate({ value: 14 }),
      history: [observation(NOW - 2 * BUCKET, 12), observation(NOW - BUCKET, 15)],
      lastNotifiedAtMs: NOW - 1,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(decision.action).toBe('suppress')
    expect(decision.escalatedFrom).toBeUndefined()
  })

  it('requires continuous buckets', () => {
    const decision = decideNotification({
      candidate: candidate({ value: 20 }),
      history: [observation(NOW - 3 * BUCKET, 12), observation(NOW - BUCKET, 15)],
      lastNotifiedAtMs: NOW - 1,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(decision.action).toBe('suppress')
  })

  it('never silences a safety finding flagged by the rule engine', () => {
    const decision = decideNotification({
      candidate: candidate({ severity: 'critical', bypassSilence: true, threshold: null }),
      history: [],
      lastNotifiedAtMs: NOW,
      bucketMs: BUCKET,
      escalateAfterWindows: 3,
    })
    expect(decision).toMatchObject({ action: 'notify', reason: 'safety-finding-never-silenced' })
  })
})
