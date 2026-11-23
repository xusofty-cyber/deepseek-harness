import { Context } from '@deepseek-ai/cordis'
import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import { JsonRecipientPolicy } from '@deepseek-ai/dsh-nilm-sentinel'
import { afterEach, describe, expect, it } from 'vitest'
import type { CostBreakdown } from '@deepseek-ai/dsh-nilm-analytics'
import NilmSchedulerService, {
  TemplateReportSummaryWriter,
  resolveConfig,
  type ReportSummaryWriter,
  type SchedulerDependencies,
  type TenantSchedule,
} from '../src/index.ts'
import { energyDays, FakeSchedulerDataSource } from './fake-data-source.ts'
import { MemorySchedulerRepository } from './memory-repository.ts'

const MORNING = Date.parse('2026-11-18T08:31:00+08:00')
const EARLY = Date.parse('2026-11-18T07:00:00+08:00')
const PF_DAY = Date.parse('2026-11-20T08:31:00+08:00')
const contexts: Context[] = []

const COST: CostBreakdown = {
  totalEnergyKwh: 300,
  pricedEnergyKwh: 300,
  unpricedEnergyKwh: 0,
  totalCost: 210,
  byPeriod: {
    sharp: { energyKwh: 30, cost: 30 },
    peak: { energyKwh: 90, cost: 90 },
    flat: { energyKwh: 120, cost: 72 },
    valley: { energyKwh: 60, cost: 18 },
  },
  precise: true,
  warnings: [],
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function tenant(overrides: Partial<TenantSchedule> = {}): TenantSchedule {
  return {
    tenantId: 'tenant-a',
    tenantName: '工厂A',
    notificationPolicy: {
      recipients: [{ userRef: 'user-1', channel: 'wx_subscribe', masked: '138****0000' }],
    },
    ...overrides,
  }
}

function setup(options: {
  now: number
  tenants?: TenantSchedule[]
  summaryWriter?: ReportSummaryWriter
  repository?: MemorySchedulerRepository
  config?: ConstructorParameters<typeof NilmSchedulerService>[1]
}): { service: NilmSchedulerService; repo: MemorySchedulerRepository; data: FakeSchedulerDataSource } {
  const ctx = new Context()
  contexts.push(ctx)
  const repo = options.repository ?? new MemorySchedulerRepository()
  repo.tenants.push(...(options.tenants ?? [tenant()]))
  const data = new FakeSchedulerDataSource()
  const dependencies: SchedulerDependencies = {
    repository: repo,
    dataSource: data,
    recipients: new JsonRecipientPolicy(),
    summaryWriter: options.summaryWriter ?? new TemplateReportSummaryWriter(),
    now: () => options.now,
    newId: (() => {
      let next = 0
      return (prefix: string) => `${prefix}_${String(++next)}`
    })(),
  }
  return { service: new NilmSchedulerService(ctx, options.config ?? {}, dependencies), repo, data }
}

function seedMorning(data: FakeSchedulerDataSource): void {
  const start = Date.parse('2026-11-17T00:00:00+08:00')
  data.morning.set('tenant-a', {
    buckets: [
      { startMs: start, endMs: start + 3_600_000, energyKwh: 100 },
      { startMs: start + 3_600_000, endMs: start + 7_200_000, energyKwh: 200 },
    ],
    dataQuality: { coverage: 0.98, source: 'raw' },
    tariff: { planId: 'plan-1', cost: COST },
    workshops: [{ name: '冲压', energyKwh: 180 }],
    warnings: [],
  })
}

describe('scheduler jobs', () => {
  it('rejects unknown report channels and templates at configuration load', () => {
    expect(() => resolveConfig({ reportChannels: ['email'] })).toThrow('unknown report channel')
    expect(() => resolveConfig({ reportTemplates: { email: 'tpl' } })).toThrow('unknown report template channel')
  })

  it('generates and delivers an idempotent morning report', async () => {
    const { service, repo, data } = setup({ now: MORNING })
    seedMorning(data)

    const first = await service.runJob('morning_report', tenant(), MORNING)
    expect(first).toMatchObject({ status: 'completed', businessDate: '2026-11-17' })
    expect(repo.reports).toHaveLength(1)
    expect(repo.reports[0]!.payload).toMatchObject({ kind: 'morning_report', reportDate: '2026-11-17' })
    expect(repo.outbox).toHaveLength(1)
    expect(repo.outbox[0]).toMatchObject({
      reportId: repo.reports[0]!.reportId,
      channel: 'wx_subscribe',
      userRef: 'user-1',
    })
    expect(repo.outbox[0]!.payloadJson).not.toContain('13800000000')
    expect([...repo.jobs.values()][0]).toMatchObject({ status: 'completed', attempt: 1 })

    const second = await service.runJob('morning_report', tenant(), MORNING)
    expect(second.status).toBe('completed-earlier')
    expect(repo.reports).toHaveLength(1)
    expect(repo.outbox).toHaveLength(1)
  })

  it('delivers one outbox row per recipient on the same channel', async () => {
    const recipients = [
      { userRef: 'user-1', channel: 'wx_subscribe', masked: '138****0000' },
      { userRef: 'user-2', channel: 'wx_subscribe', masked: '139****0000' },
    ]
    const shared = tenant({ notificationPolicy: { recipients } })
    const { service, repo, data } = setup({ now: MORNING, tenants: [shared] })
    seedMorning(data)
    await service.runJob('morning_report', shared, MORNING)
    expect(repo.outbox).toHaveLength(2)
    expect(new Set(repo.outbox.map(row => row.userRef))).toEqual(new Set(['user-1', 'user-2']))
  })

  it('runs R-08 and R-07 in one sweep without customer delivery for quality findings', async () => {
    const { service, repo, data } = setup({ now: MORNING })
    seedMorning(data)
    data.quality.set('tenant-a', {
      observations: [{ scopeId: 'terminal-1', scopeName: '一号终端', coverage: 0.9, parentEnergyKwh: 100, childEnergyKwh: 110 }],
      warnings: [],
    })

    const result = await service.runDue(MORNING)

    expect(result).toMatchObject({ reports: 1, notifications: 1, qualityFindings: 2 })
    expect(result.outcomes.map(outcome => outcome.jobType)).toEqual(['data_quality', 'morning_report'])
    expect(repo.audits.map(audit => audit.kind)).toEqual(['coverage', 'parent_child'])
    expect(repo.outbox.every(row => row.reportId.startsWith('report_'))).toBe(true)
  })

  it('does not run the morning report before its configured time', async () => {
    const { service, data } = setup({ now: EARLY })
    seedMorning(data)

    const result = await service.runDue(EARLY)

    expect(result.reports).toBe(0)
    expect(result.outcomes.map(outcome => outcome.jobType)).toEqual(['data_quality'])
  })

  it('runs the monthly projection on the configured forecast day', async () => {
    const { service, repo, data } = setup({ now: PF_DAY, config: { jobRetryDelayMs: 0 } })
    repo.thresholds.set('tenant-a', 0.9)
    data.monthly.set('tenant-a', { days: energyDays(19, 100, 20), warnings: [] })

    const outcome = await service.runJob('pf_forecast', tenant(), PF_DAY)

    expect(outcome).toMatchObject({ status: 'completed', businessDate: '2026-11-20' })
    const report = repo.reports.find(row => row.reportType === 'pf_forecast')
    expect(report?.payload).toMatchObject({ kind: 'pf_forecast', mandatory: true })
    expect(report?.summaryText).toContain('风险 pass')
    expect(repo.outbox).toHaveLength(1)
  })

  it('fails the projection instead of inventing a policy or monthly energy', async () => {
    const { service, repo, data } = setup({ now: PF_DAY, config: { jobRetryDelayMs: 0 } })
    const noPolicy = await service.runJob('pf_forecast', tenant(), PF_DAY)
    expect(noPolicy).toMatchObject({ status: 'failed', errorCode: 'DATA_UNAVAILABLE' })
    expect(repo.reports).toHaveLength(0)

    repo.thresholds.set('tenant-a', 0.9)
    data.errors.set('tenant-a', new NilmError('DATA_UNAVAILABLE', 'no monthly P/Q'))
    const noEnergy = await service.runJob('pf_forecast', tenant(), PF_DAY + 60_000)
    expect(noEnergy).toMatchObject({ status: 'failed', errorCode: 'DATA_UNAVAILABLE' })
  })

  it('keeps the deterministic summary when model authorship fails', async () => {
    const failing: ReportSummaryWriter = { write: async () => { throw new Error('model unavailable') } }
    const { service, repo, data } = setup({ now: MORNING, summaryWriter: failing })
    seedMorning(data)

    await expect(service.runJob('morning_report', tenant(), MORNING)).resolves.toMatchObject({ status: 'completed' })
    expect(repo.reports[0]!.summaryText).toContain('用电 300.00 kWh')
  })

  it('keeps the deterministic summary for blank or timed-out model text', async () => {
    const blank: ReportSummaryWriter = { write: async () => '   ' }
    const blankRun = setup({ now: MORNING, summaryWriter: blank })
    seedMorning(blankRun.data)
    await blankRun.service.runJob('morning_report', tenant(), MORNING)
    expect(blankRun.repo.reports[0]!.summaryText).toContain('用电 300.00 kWh')

    const slow: ReportSummaryWriter = {
      write: async () => new Promise(resolve => {
        setTimeout(() => { resolve('late model text') }, 200)
      }),
    }
    const timeoutRun = setup({ now: MORNING, summaryWriter: slow, config: { summaryTimeoutMs: 20 } })
    seedMorning(timeoutRun.data)
    const started = performance.now()
    await timeoutRun.service.runJob('morning_report', tenant(), MORNING)
    expect(performance.now() - started).toBeLessThan(180)
    expect(timeoutRun.repo.reports[0]!.summaryText).toContain('用电 300.00 kWh')
  })

  it('reports success without delivery when no recipient is configured', async () => {
    const { service, repo, data } = setup({ now: MORNING, tenants: [tenant({ notificationPolicy: { recipients: [] } })] })
    seedMorning(data)

    await expect(service.runJob('morning_report', tenant({ notificationPolicy: { recipients: [] } }), MORNING))
      .resolves.toMatchObject({ status: 'completed' })
    expect(repo.reports).toHaveLength(1)
    expect(repo.outbox).toHaveLength(0)
  })

  it('retries a failed job only after the configured delay', async () => {
    const { service, data } = setup({ now: MORNING, config: { jobRetryDelayMs: 60_000 } })
    data.errors.set('tenant-a', new NilmError('DATA_UNAVAILABLE', 'temporary gap'))
    const first = await service.runJob('morning_report', tenant(), MORNING)
    expect(first.status).toBe('failed')
    const waiting = await service.runJob('morning_report', tenant(), MORNING + 1_000)
    expect(waiting.status).toBe('in-progress')
    data.errors.clear()
    seedMorning(data)
    const retried = await service.runJob('morning_report', tenant(), MORNING + 61_000)
    expect(retried.status).toBe('completed')
  })

  it('continues other tenants when one tenant claim throws', async () => {
    class FailingClaimRepository extends MemorySchedulerRepository {
      override async claimJob(input: Parameters<MemorySchedulerRepository['claimJob']>[0]) {
        if (input.tenantId === 'tenant-a') throw new Error('database lock unavailable')
        return super.claimJob(input)
      }
    }
    const repository = new FailingClaimRepository()
    const second = tenant({ tenantId: 'tenant-b', tenantName: '工厂B' })
    const { service, repo, data } = setup({
      now: MORNING,
      tenants: [tenant(), second],
      repository,
    })
    seedMorning(data)
    data.morning.set('tenant-b', data.morning.get('tenant-a')!)

    const result = await service.runDue(MORNING)

    expect(result.outcomes.filter(outcome => outcome.tenantId === 'tenant-a'))
      .toEqual([
        expect.objectContaining({ status: 'failed' }),
        expect.objectContaining({ status: 'failed' }),
      ])
    expect(result.outcomes.filter(outcome => outcome.tenantId === 'tenant-b'))
      .toEqual([
        expect.objectContaining({ status: 'completed' }),
        expect.objectContaining({ status: 'completed' }),
      ])
    expect(repo.reports.filter(row => row.tenantId === 'tenant-b')).toHaveLength(1)
  })
})
