import { describe, expect, it } from 'vitest'
import { RETRY_DELAYS_MS, retryDelayMs, shouldDeadLetter } from '../src/model.ts'

describe('notification retry policy', () => {
  it('uses the fixed exponential backoff table', () => {
    expect(RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000])
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([
      60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000,
    ])
  })

  it('rejects an invalid attempt number', () => {
    expect(() => retryDelayMs(0)).toThrow('attempt must be a positive integer')
    expect(() => retryDelayMs(1.5)).toThrow('attempt must be a positive integer')
  })

  it('dead-letters on a permanent failure or at the attempt ceiling', () => {
    expect(shouldDeadLetter(1, 5, false)).toBe(true)
    expect(shouldDeadLetter(4, 5, true)).toBe(false)
    expect(shouldDeadLetter(5, 5, true)).toBe(true)
    expect(shouldDeadLetter(6, 5, true)).toBe(true)
  })
})
