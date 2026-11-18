import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { NilmError, type CallContext, type SessionId, type TenantId, type TimeRangeSpec } from '@deepseek-ai/dsh-nilm-core'
import {
  NilmTariffService,
  parseClockMinutes,
  selectEffectivePlan,
  splitRangeByTariff,
  tariffPeriodRank,
  validateTariffPlan,
  type TariffRepository,
  type TariffDay,
  type TariffPlan,
} from '../src/index.ts'

const contexts: Context[] = []

const DAY = 86_400_000
const day0 = Date.UTC(2026, 6, 1)
const tenant = 'tenant-a' as TenantId

const periods: TariffPlan['periods'] = [
  { season: 'summer', dayType: 'workday', periodType: 'valley', start: '00:00', end: '08:00', pricePerKwh: 0.3 },
  { season: 'summer', dayType: 'workday', periodType: 'flat', start: '08:00', end: '11:00', pricePerKwh: 0.7 },
  { season: 'summer', dayType: 'workday', periodType: 'peak', start: '11:00', end: '13:00', pricePerKwh: 1 },
  { season: 'summer', dayType: 'workday', periodType: 'flat', start: '13:00', end: '18:00', pricePerKwh: 0.7 },
  { season: 'summer', dayType: 'workday', periodType: 'peak', start: '18:00', end: '22:00', pricePerKwh: 1 },
  { season: 'summer', dayType: 'workday', periodType: 'valley', start: '22:00', end: '24:00', pricePerKwh: 0.3 },
]

function plan(overrides: Partial<TariffPlan> = {}): TariffPlan {
  return {
    planId: 'plan-1',
    tenantId: tenant,
    effectiveFromMs: day0,
    periods,
    ...overrides,
  }
}

function day(overrides: Partial<TariffDay> = {}): TariffDay {
  return { startMs: day0, endMs: day0 + DAY, season: 'summer', dayType: 'workday', ...overrides }
}

function codeOf(action: () => void): string | undefined {
  try {
    action()
    return undefined
  } catch (error) {
    return error instanceof NilmError ? error.code : 'not-nilm'
  }
}

describe('tariff clock and validation', () => {
  it('parses HH:mm and rejects malformed clock values', () => {
    expect(parseClockMinutes('00:00')).toBe(0)
    expect(parseClockMinutes('23:59')).toBe(1439)
    expect(parseClockMinutes('24:00')).toBe(1440)
    expect(codeOf(() => parseClockMinutes('24:01'))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => parseClockMinutes('7:00'))).toBe('INVALID_ARGUMENT')
  })

  it('rejects overlapping, wrapping, empty, and negative-price plans', () => {
    expect(codeOf(() => validateTariffPlan(plan({
      periods: [{ season: 'summer', dayType: 'workday', periodType: 'flat', start: '08:00', end: '20:00', pricePerKwh: 1 }],
    })))).toBeUndefined()
    expect(codeOf(() => validateTariffPlan(plan({ periods: [] })))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => validateTariffPlan(plan({
      periods: [periods[0], { ...periods[0], start: '07:00', end: '09:00' }],
    })))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => validateTariffPlan(plan({
      periods: [{ season: 'summer', dayType: 'workday', periodType: 'valley', start: '22:00', end: '06:00', pricePerKwh: 0.3 }],
    })))).toBe('INVALID_ARGUMENT')
    expect(codeOf(() => validateTariffPlan(plan({
      periods: [{ season: 'summer', dayType: 'workday', periodType: 'flat', start: '08:00', end: '09:00', pricePerKwh: -1 }],
    })))).toBe('INVALID_ARGUMENT')
  })

  it('ranks bands from sharp to valley', () => {
    expect(['sharp', 'peak', 'flat', 'valley'].map(type => tariffPeriodRank(type as never))).toEqual([0, 1, 2, 3])
  })
})

describe('effective plan selection', () => {
  it('selects the sole plan inside its effective interval', () => {
    const selected = selectEffectivePlan([plan({ effectiveToMs: day0 + 2 * DAY })], day0 + DAY)
    expect(selected.planId).toBe('plan-1')
  })

  it('rejects an absent or overlapping effective plan', () => {
    expect(codeOf(() => selectEffectivePlan([plan({ effectiveFromMs: day0 + DAY })], day0))).toBe('DATA_UNAVAILABLE')
    expect(codeOf(() => selectEffectivePlan([plan(), plan({ planId: 'plan-2' })], day0))).toBe('INVALID_ARGUMENT')
  })
})

describe('time-of-use slicing', () => {
  it('splits a full day into ordered priced slices without gaps', () => {
    const result = splitRangeByTariff({ startMs: day0, endMs: day0 + DAY }, plan(), [day()])
    expect(result.slices.map(slice => [slice.periodType, (slice.endMs - slice.startMs) / 60_000])).toEqual([
      ['valley', 480],
      ['flat', 180],
      ['peak', 120],
      ['flat', 300],
      ['peak', 240],
      ['valley', 120],
    ])
    expect(result.gaps).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('clips slices to the requested range and preserves exact boundaries', () => {
    const start = day0 + 7 * 3_600_000
    const end = day0 + 12 * 3_600_000
    const result = splitRangeByTariff({ startMs: start, endMs: end }, plan(), [day()])
    expect(result.slices).toEqual([
      { startMs: start, endMs: day0 + 8 * 3_600_000, periodType: 'valley', pricePerKwh: 0.3, planId: 'plan-1' },
      { startMs: day0 + 8 * 3_600_000, endMs: day0 + 11 * 3_600_000, periodType: 'flat', pricePerKwh: 0.7, planId: 'plan-1' },
      { startMs: day0 + 11 * 3_600_000, endMs: end, periodType: 'peak', pricePerKwh: 1, planId: 'plan-1' },
    ])
    expect(result.gaps).toEqual([])
  })

  it('reports every uncovered interval exactly once', () => {
    const sparse = plan({
      periods: [{ season: 'summer', dayType: 'workday', periodType: 'valley', start: '00:00', end: '02:00', pricePerKwh: 0.3 }],
    })
    const result = splitRangeByTariff({ startMs: day0, endMs: day0 + DAY }, sparse, [day()])
    expect(result.gaps).toEqual([{ startMs: day0 + 2 * 3_600_000, endMs: day0 + DAY, reason: 'no_period' }])
  })

  it('marks days absent from the projection as missing rather than unpriced periods', () => {
    const result = splitRangeByTariff({ startMs: day0, endMs: day0 + 2 * DAY }, plan(), [day()])
    expect(result.gaps).toEqual([{ startMs: day0 + DAY, endMs: day0 + 2 * DAY, reason: 'missing_day' }])
    expect(result.warnings).toEqual([])
  })

  it('clips the range to the plan effective interval and reports the rest', () => {
    const result = splitRangeByTariff(
      { startMs: day0, endMs: day0 + 2 * DAY },
      plan({ effectiveToMs: day0 + DAY }),
      [day(), day({ startMs: day0 + DAY, endMs: day0 + 2 * DAY })],
    )
    expect(result.slices.at(-1)?.endMs).toBe(day0 + DAY)
    expect(result.gaps).toEqual([{ startMs: day0 + DAY, endMs: day0 + 2 * DAY, reason: 'outside_plan' }])
  })

  it('warns when no calendar days are supplied and rejects unordered days', () => {
    const empty = splitRangeByTariff({ startMs: day0, endMs: day0 + DAY }, plan(), [])
    expect(empty.slices).toEqual([])
    expect(empty.gaps).toEqual([{ startMs: day0, endMs: day0 + DAY, reason: 'missing_day' }])
    expect(empty.warnings).toContain('no calendar days were supplied')
    expect(codeOf(() => splitRangeByTariff(
      { startMs: day0, endMs: day0 + 2 * DAY },
      plan(),
      [day({ startMs: day0 + DAY, endMs: day0 + 2 * DAY }), day()],
    ))).toBe('INVALID_ARGUMENT')
  })

  it('merges adjacent slices only when band, price, and plan all match', () => {
    const merged = plan({
      periods: [
        { season: 'summer', dayType: 'workday', periodType: 'flat', start: '00:00', end: '12:00', pricePerKwh: 0.7 },
        { season: 'summer', dayType: 'workday', periodType: 'flat', start: '12:00', end: '24:00', pricePerKwh: 0.7 },
      ],
    })
    const result = splitRangeByTariff({ startMs: day0, endMs: day0 + DAY }, merged, [day()])
    expect(result.slices).toHaveLength(1)
  })

  it('warns when a day lacks a period set for its season and day type', () => {
    const result = splitRangeByTariff({ startMs: day0, endMs: day0 + DAY }, plan(), [day({ dayType: 'holiday' })])
    expect(result.slices).toEqual([])
    expect(result.gaps).toEqual([{ startMs: day0, endMs: day0 + DAY, reason: 'no_period' }])
    expect(result.warnings).toContain('no tariff periods for summer/holiday')
  })
})

describe('NilmTariffService', () => {
  afterEach(async () => {
    for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  })

  function callContext(): CallContext {
    return {
      tenantId: brandString<TenantId>('tenant-a'),
      userRef: 'user-1',
      requestId: 'request-1',
      sessionId: brandString<SessionId>('session-1'),
    }
  }

  function range(): TimeRangeSpec {
    return {
      start: new Date(day0).toISOString(),
      end: new Date(day0 + DAY).toISOString(),
      timeZone: 'Asia/Shanghai',
      granularity: 'hour',
    }
  }

  function setup(repository: TariffRepository): NilmTariffService {
    const ctx = new Context()
    contexts.push(ctx)
    return new NilmTariffService(ctx, { repository })
  }

  it('loads the effective plan and calendar days from the repository', async () => {
    const requested = plan({ effectiveToMs: day0 + 2 * DAY })
    const repository: TariffRepository = {
      listEffective: async () => [requested],
      getPlan: async () => requested,
      listDays: async () => [day()],
    }
    const service = setup(repository)
    expect((await service.effectivePlan(callContext(), day0)).planId).toBe('plan-1')
    const result = await service.splitByTariff(callContext(), range())
    expect(result.slices.length > 0).toBe(true)
    expect(result.slices[0]!.planId).toBe('plan-1')
  })

  it('uses an explicit plan id and rejects a missing plan or foreign time zone', async () => {
    const repository: TariffRepository = {
      listEffective: async () => [plan()],
      getPlan: async () => undefined,
      listDays: async () => [day()],
    }
    const service = setup(repository)
    await expect(service.splitByTariff(callContext(), range(), 'missing'))
      .rejects.toMatchObject({ code: 'DATA_UNAVAILABLE' })
    await expect(service.splitByTariff(callContext(), { ...range(), timeZone: 'UTC' as never }))
      .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
