import { describe, expect, it } from 'vitest'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import {
  alignBucket,
  assertAlertTransition,
  dedupeKey,
  escalationDedupeKey,
  maxSeverity,
  silenceKey,
} from '../src/index.ts'

describe('alert keys', () => {
  it('builds a stable cross-window key and a bucketed de-duplication key', () => {
    expect(silenceKey('tenant-a', 'R-03', 'channel-1', 'device_overload_kw'))
      .toBe('tenant-a:R-03:channel-1:device_overload_kw')
    expect(dedupeKey('tenant-a', 'R-03', 'channel-1', 'device_overload_kw', 1_700_000_003))
      .toBe('tenant-a:R-03:channel-1:device_overload_kw:1700000')
  })

  it('aligns a bucket down to its start', () => {
    expect(alignBucket(1_700_000_123, 300_000)).toBe(1_699_800_000)
  })

  it('rejects a key beyond the indexed storage width', () => {
    expect(() => dedupeKey('a'.repeat(80), 'R-03', 'b'.repeat(80), 'c'.repeat(80), 0))
      .toThrow(NilmError)
  })

  it('namespaces escalation keys', () => {
    expect(escalationDedupeKey('base:1', 'critical')).toBe('base:1:escalated:critical')
  })
})

describe('alert lifecycle', () => {
  it('allows the designed path', () => {
    expect(assertAlertTransition('detected', 'confirmed')).toBe('confirmed')
    expect(assertAlertTransition('confirmed', 'notified')).toBe('notified')
    expect(assertAlertTransition('notified', 'acknowledged')).toBe('acknowledged')
    expect(assertAlertTransition('acknowledged', 'resolved')).toBe('resolved')
  })

  it('allows suppression to be revived by escalation', () => {
    expect(assertAlertTransition('suppressed', 'confirmed')).toBe('confirmed')
  })

  it('rejects resurrection of a final state', () => {
    expect(() => assertAlertTransition('resolved', 'notified')).toThrow(/illegal alert transition/)
    expect(() => assertAlertTransition('false_positive', 'detected')).toThrow(NilmError)
  })
})

describe('severity ordering', () => {
  it('keeps the most urgent value', () => {
    expect(maxSeverity('warning', 'critical')).toBe('critical')
    expect(maxSeverity('info', 'warning')).toBe('warning')
    expect(maxSeverity('critical', 'critical')).toBe('critical')
  })
})
