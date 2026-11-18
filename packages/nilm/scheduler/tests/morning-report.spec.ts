import { Context } from '@deepseek-ai/cordis'
import { JsonRecipientPolicy } from '@deepseek-ai/dsh-nilm-sentinel'
import { afterEach, describe, expect, it } from 'vitest'
import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import NilmSchedulerService, { TemplateReportSummaryWriter, type TenantSchedule } from '../src/index.ts'
import { energyDays, FakeSchedulerDataSource } from './fake-data-source.ts'
import { MemorySchedulerRepository } from './memory-repository.ts'

const MORNING = Date.parse('2026-11-18T08:31:00+08:00')
const contexts: Context[] = []

const COST: CostBreakdown = {
  totalEnergyKwh: 1_500,
  pricedEnergyKwh: 1_500,
  unpricedEnergyKwh: 0,
  totalCost: 1_050,
  byPeriod: {
    sharp: { energyKwh: 150, cost: 150 },
    peak: { energyKwh: 450, cost: 450 },
    flat: { energyKwh: 600, cost: 360 },
    valley: { energyKwh: 300, cost: 90 },
  },
  precise: true,
  warnings: [],
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('G4-1 morning-report rehearsal', () => {
  it('recomputes twenty tenants within the latency budget and remains idempotent', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const repo = new MemorySchedulerRepository()
    const data = new FakeSchedulerDataSource()
    const tenants: TenantSchedule[] = []
    for (let index = 1; index <= 20; index += 1) {
      const schedule: TenantSchedule = {
        tenantId: `tenant-${String(index).padStart(2, '0')}`,
        tenantName: `工厂${String(index)}`,
        notificationPolicy: { recipients: [{ userRef: `user-${String(index)}`, channel: 'wx_subscribe', masked: '138****0000' }] },
      }
      tenants.push(schedule)
      repo.tenants.push(schedule)
      const start = Date.parse('2026-11-17T00:00:00+08:00')
      data.morning.set(schedule.tenantId, {
        buckets: Array.from({ length: 5 }, (_, bucket) => ({
          startMs: start + bucket * 3_600_000,
          endMs: start + (bucket + 1) * 3_600_000,
          energyKwh: 300,
        })),
        dataQuality: { coverage: 0.99, source: 'mixed' },
        tariff: { planId: 'plan-1', cost: COST },
        workshops: [{ name: '冲压', energyKwh: 900 }, { name: '装配', energyKwh: 600 }],
        warnings: [],
      })
      data.monthly.set(schedule.tenantId, { days: energyDays(30, 300, 60), warnings: [] })
    }
    const service = new NilmSchedulerService(ctx, {}, {
      repository: repo,
      dataSource: data,
      recipients: new JsonRecipientPolicy(),
      summaryWriter: new TemplateReportSummaryWriter(),
      now: () => MORNING,
      newId: (() => {
        let next = 0
        return (prefix: string) => `${prefix}_${String(++next)}`
      })(),
    })

    const durations: number[] = []
    for (const schedule of tenants) {
      const started = performance.now()
      const outcome = await service.runJob('morning_report', schedule, MORNING)
      durations.push(performance.now() - started)
      expect(outcome.status).toBe('completed')
    }

    durations.sort((left, right) => left - right)
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!
    expect(p95).toBeLessThan(500)
    expect(repo.reports).toHaveLength(20)
    expect(repo.outbox).toHaveLength(20)

    for (const schedule of tenants) {
      const again = await service.runJob('morning_report', schedule, MORNING)
      expect(again.status).toBe('completed-earlier')
    }
    expect(repo.reports).toHaveLength(20)
    expect(repo.outbox).toHaveLength(20)
  })
})
