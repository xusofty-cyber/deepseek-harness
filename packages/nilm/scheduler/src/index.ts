/**
 * Scheduled NILM reports: R-07 morning report, R-06 monthly power-factor
 * projection, and R-08 data-quality inspection. Jobs are idempotent per tenant
 * and business date; report delivery uses the shared notification Outbox.
 * @module @deepseek-ai/dsh-nilm-scheduler
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NilmError, redactText, type ChartSpec } from '@deepseek-ai/dsh-nilm-core'
import { JsonRecipientPolicy, type NotificationChannel, type RecipientPolicy } from '@deepseek-ai/dsh-nilm-sentinel'
import {
  SourceSchedulerDataSource,
  type MonthlyEnergySource,
  type SchedulerDataSource,
  type SchedulerDataSourceDependencies,
} from './data-source.ts'
import type {
  JobType,
  QualityAuditDraft,
  ReportOutboxDraft,
  ReportType,
  SchedulerRepository,
  TenantSchedule,
} from './model.ts'
import {
  buildMorningReport,
  buildPowerFactorReport,
  type MorningPowerFactor,
} from './report.ts'
import { forecastMonthlyPowerFactor } from './pf.ts'
import { evaluateDataQuality, type QualityFinding } from './quality.ts'
import { MysqlSchedulerRepository } from './store.ts'
import {
  CordisReportSummaryWriter,
  TemplateReportSummaryWriter,
  type ReportSummaryInput,
  type ReportSummaryWriter,
} from './summary-agent.ts'
import {
  addBusinessDays,
  atBusinessTime,
  businessDateKey,
  isAtOrAfterBusinessTime,
  isPowerFactorForecastDay,
  startOfBusinessDay,
  startOfBusinessMonth,
} from './time.ts'

/** Deployment configuration. */
export interface Config {
  /** Due-job check interval. */
  tickIntervalMs?: number
  /** Morning-report hour in Shanghai time. */
  morningHour?: number
  /** Morning-report minute in Shanghai time. */
  morningMinute?: number
  /** Daily R-08 hour in Shanghai low-peak time. */
  qualityHour?: number
  /** Daily R-08 minute in Shanghai low-peak time. */
  qualityMinute?: number
  /** Report delivery channels. */
  reportChannels?: readonly string[]
  /** Provider template ids keyed by channel. */
  reportTemplates?: Record<string, string>
  /** Outbox attempt ceiling for report delivery. */
  maxAttempts?: number
  /** Running-job lease before a crashed claim is retried. */
  jobLeaseMs?: number
  /** Delay before retrying a failed job. */
  jobRetryDelayMs?: number
  /** Hard model-summary timeout. */
  summaryTimeoutMs?: number
  /** Registered provider for report summaries. */
  summaryProvider?: string
  /** Summary model; absent keeps the deterministic template. */
  summaryModel?: string
  /** Prompt version recorded for the summary. */
  summaryPromptVersion?: string
  /** Summary session working directory. */
  summaryCwd?: string
  /** Minimum acceptable R-08 coverage. */
  qualityMinimumCoverage?: number
  /** Maximum acceptable R-08 parent-child deviation. */
  qualityMaximumParentDeviation?: number
  /** Maximum acceptable R-08 hot-cold deviation. */
  qualityMaximumHotColdDeviation?: number
}

/** Cordis schema for {@link Config}. */
export const Config = z.object({
  tickIntervalMs: z.natural().min(1_000).default(60_000),
  morningHour: z.natural().max(23).default(8),
  morningMinute: z.natural().max(59).default(30),
  qualityHour: z.natural().max(23).default(3),
  qualityMinute: z.natural().max(59).default(30),
  reportChannels: z.array(z.string()).default(['wx_subscribe']),
  reportTemplates: z.object({}).default({}),
  maxAttempts: z.natural().min(1).max(20).default(5),
  jobLeaseMs: z.natural().min(1_000).default(300_000),
  jobRetryDelayMs: z.natural().min(0).default(300_000),
  summaryTimeoutMs: z.natural().min(100).default(20_000),
  summaryProvider: z.string().default('deepseek-official'),
  summaryModel: z.string(),
  summaryPromptVersion: z.string().default('report-summary-v1'),
  summaryCwd: z.string(),
  qualityMinimumCoverage: z.number().min(0).max(1).default(0.95),
  qualityMaximumParentDeviation: z.number().min(0).default(0.01),
  qualityMaximumHotColdDeviation: z.number().min(0).default(0.01),
})

/** Injectable seams used by tests and alternate deployments. */
export interface SchedulerDependencies {
  /** Job, report, Outbox, and audit persistence. */
  repository?: SchedulerRepository
  /** Authorized data collector. */
  dataSource?: SchedulerDataSource
  /** Monthly active/reactive preaggregation for the default collector. */
  monthlyEnergy?: MonthlyEnergySource
  /** Recipient policy. */
  recipients?: RecipientPolicy
  /** Report summary writer; overrides the Cordis adapter. */
  summaryWriter?: ReportSummaryWriter
  /** Injectable clock. */
  now?: () => number
  /** Injectable identifier generator. */
  newId?: (prefix: string) => string
}

/** Outcome of one due-job attempt. */
export interface JobOutcome {
  /** Job family. */
  jobType: JobType
  /** Tenant boundary. */
  tenantId: string
  /** Business date used by the idempotency key. */
  businessDate: string
  /** Final attempt state. */
  status: 'claimed' | 'completed' | 'failed' | 'completed-earlier' | 'in-progress'
  /** Stable failure code when the attempt failed. */
  errorCode?: string
}

/** Aggregate result of one due-job sweep. */
export interface SchedulerSweepResult {
  /** Tenant jobs attempted in this sweep. */
  outcomes: JobOutcome[]
  /** Reports inserted in this sweep. */
  reports: number
  /** Report delivery rows inserted or confirmed idempotent. */
  notifications: number
  /** R-08 findings written to operational audit. */
  qualityFindings: number
}

interface JobWork {
  outcome: JobOutcome
  reportInserted: boolean
  notifications: number
  qualityFindings: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmScheduler: NilmSchedulerService
  }
}

/** Resolved configuration. */
export interface ResolvedConfig {
  tickIntervalMs: number
  morningHour: number
  morningMinute: number
  qualityHour: number
  qualityMinute: number
  reportChannels: NotificationChannel[]
  reportTemplates: Partial<Record<NotificationChannel, string>>
  maxAttempts: number
  jobLeaseMs: number
  jobRetryDelayMs: number
  summaryTimeoutMs: number
  summaryProvider: string
  summaryModel?: string
  summaryPromptVersion: string
  summaryCwd?: string
  qualityMinimumCoverage: number
  qualityMaximumParentDeviation: number
  qualityMaximumHotColdDeviation: number
}

const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = ['wx_subscribe', 'wx_template', 'wecom_webhook', 'sms']

/** Scheduled report service. */
export class NilmSchedulerService extends Service {
  /** Cordis configuration schema. */
  static Config = Config

  private readonly resolved: ResolvedConfig
  private readonly repository: SchedulerRepository
  private readonly dataSource: SchedulerDataSource
  private readonly recipients: RecipientPolicy
  private readonly summaryWriter: ReportSummaryWriter
  private readonly now: () => number
  private readonly newId: (prefix: string) => string
  private timer: NodeJS.Timeout | undefined
  private running = false

  /**
   * @param ctx - owning plugin context.
   * @param config - deployment configuration.
   * @param dependencies - repository, data, summary, and clock overrides.
   */
  constructor(ctx: Context, config: Config = {}, dependencies: SchedulerDependencies = {}) {
    super(ctx, 'nilmScheduler')
    this.resolved = resolveConfig(config)
    this.repository = dependencies.repository ?? new MysqlSchedulerRepository(() => ctx.get('nilmSource')!)
    this.dataSource = dependencies.dataSource ?? new SourceSchedulerDataSource(defaultDataSource(ctx, dependencies.monthlyEnergy))
    this.recipients = dependencies.recipients ?? new JsonRecipientPolicy()
    this.summaryWriter = dependencies.summaryWriter ?? (this.resolved.summaryModel === undefined
      ? new TemplateReportSummaryWriter()
      : new CordisReportSummaryWriter(() => ctx, {
        provider: this.resolved.summaryProvider,
        model: this.resolved.summaryModel,
        promptVersion: this.resolved.summaryPromptVersion,
        ...(this.resolved.summaryCwd === undefined ? {} : { cwd: this.resolved.summaryCwd }),
      }))
    this.now = dependencies.now ?? (() => Date.now())
    this.newId = dependencies.newId ?? ((prefix: string) => `${prefix}_${randomUUID()}`)
    ctx.effect(() => () => { this.stop() }, 'nilm-scheduler.timer')
  }

  /** Start the due-job sweep. The first sweep runs immediately. */
  start(): void {
    if (this.timer !== undefined) return
    const tick = (): void => {
      if (this.running) return
      this.running = true
      void this.runDue()
        .catch((error: unknown) => { this.ctx.logger.warn(redactText(`nilm-scheduler sweep failed: ${errorText(error)}`)) })
        .finally(() => { this.running = false })
    }
    this.timer = setInterval(tick, this.resolved.tickIntervalMs)
    this.timer.unref()
    tick()
  }

  /** Stop the sweep. An in-flight job finishes. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Run every job that is due at an instant.
   * @param nowMs - sweep instant; defaults to the injected clock.
   * @returns aggregate counts and per-tenant outcomes.
   */
  async runDue(nowMs: number = this.now()): Promise<SchedulerSweepResult> {
    const tenants = await this.repository.listTenants()
    const result: SchedulerSweepResult = { outcomes: [], reports: 0, notifications: 0, qualityFindings: 0 }
    const qualityDue = isAtOrAfterBusinessTime(nowMs, this.resolved.qualityHour, this.resolved.qualityMinute)
    const morningDue = isAtOrAfterBusinessTime(nowMs, this.resolved.morningHour, this.resolved.morningMinute)
    const pfDue = isPowerFactorForecastDay(nowMs) && morningDue
    for (const tenant of tenants) {
      if (qualityDue) this.append(result, await this.runQuality(tenant, nowMs))
      if (morningDue) this.append(result, await this.runMorning(tenant, nowMs))
      if (pfDue) this.append(result, await this.runPowerFactor(tenant, nowMs))
    }
    return result
  }

  /**
   * Run one job for one tenant.
   * @param jobType - job family.
   * @param tenant - tenant schedule.
   * @param nowMs - attempt instant.
   * @returns the outcome.
   */
  async runJob(jobType: JobType, tenant: TenantSchedule, nowMs: number = this.now()): Promise<JobOutcome> {
    switch (jobType) {
      case 'morning_report': return (await this.runMorning(tenant, nowMs)).outcome
      case 'pf_forecast': return (await this.runPowerFactor(tenant, nowMs)).outcome
      case 'data_quality': return (await this.runQuality(tenant, nowMs)).outcome
    }
  }

  private async runMorning(tenant: TenantSchedule, nowMs: number): Promise<JobWork> {
    const runDay = startOfBusinessDay(nowMs)
    const reportDay = addBusinessDays(runDay, -1)
    const reportDate = businessDateKey(reportDay)
    return this.withClaim('morning_report', tenant, reportDate, atBusinessTime(runDay, this.resolved.morningHour, this.resolved.morningMinute), nowMs, async () => {
      const data = await this.dataSource.collectMorning(tenant.tenantId, reportDay, addBusinessDays(reportDay, 1))
      const alerts = await this.repository.alertCounts(tenant.tenantId, reportDay, addBusinessDays(reportDay, 1))
      const powerFactor = await this.morningPowerFactor(tenant.tenantId, reportDate)
      const built = buildMorningReport({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        reportDate,
        dayStartMs: reportDay,
        dayEndMs: addBusinessDays(reportDay, 1),
        buckets: data.buckets,
        dataQuality: data.dataQuality,
        ...(data.tariff === undefined ? {} : { tariff: data.tariff }),
        workshops: data.workshops,
        alerts,
        ...(powerFactor === undefined ? {} : { powerFactor }),
        warnings: data.warnings,
      })
      const summary = await this.summarize({
        tenantId: tenant.tenantId,
        reportType: 'morning_report',
        reportDate,
        payload: built.payload,
        fallback: built.summaryText,
      })
      const saved = await this.repository.saveReport({
        reportId: this.newId('report'),
        tenantId: tenant.tenantId,
        reportType: 'morning_report',
        reportDate,
        payloadJson: JSON.stringify(built.payload),
        ...(built.chart === undefined ? {} : { chartJson: JSON.stringify(built.chart) }),
        summaryText: summary,
        generatedAtMs: nowMs,
      })
      const notifications = await this.deliverReport(tenant, 'morning_report', reportDate, saved.reportId, summary, built.payload, built.chart)
      return { reportInserted: saved.inserted, notifications, qualityFindings: 0 }
    })
  }

  private async runPowerFactor(tenant: TenantSchedule, nowMs: number): Promise<JobWork> {
    const runDay = startOfBusinessDay(nowMs)
    const reportDate = businessDateKey(runDay)
    const completedDay = addBusinessDays(runDay, -1)
    const asOfDate = businessDateKey(completedDay)
    return this.withClaim('pf_forecast', tenant, reportDate, atBusinessTime(runDay, this.resolved.morningHour, this.resolved.morningMinute), nowMs, async () => {
      const threshold = await this.repository.powerFactorThreshold(tenant.tenantId, reportDate)
      if (threshold === undefined) throw new NilmError('DATA_UNAVAILABLE', `tenant ${tenant.tenantId} has no effective power-factor policy`)
      const data = await this.dataSource.collectMonthly(tenant.tenantId, startOfBusinessMonth(runDay), asOfDate, runDay)
      const forecast = forecastMonthlyPowerFactor({ asOfDate, threshold, days: data.days })
      forecast.warnings.push(...data.warnings)
      const built = buildPowerFactorReport({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        reportDate,
        forecast,
      })
      const summary = await this.summarize({
        tenantId: tenant.tenantId,
        reportType: 'pf_forecast',
        reportDate,
        payload: built.payload,
        fallback: built.summaryText,
      })
      const saved = await this.repository.saveReport({
        reportId: this.newId('report'),
        tenantId: tenant.tenantId,
        reportType: 'pf_forecast',
        reportDate,
        payloadJson: JSON.stringify(built.payload),
        summaryText: summary,
        generatedAtMs: nowMs,
      })
      const notifications = await this.deliverReport(tenant, 'pf_forecast', reportDate, saved.reportId, summary, built.payload)
      return { reportInserted: saved.inserted, notifications, qualityFindings: 0 }
    })
  }

  private async runQuality(tenant: TenantSchedule, nowMs: number): Promise<JobWork> {
    const runDay = startOfBusinessDay(nowMs)
    const reportDate = businessDateKey(runDay)
    const windowStart = addBusinessDays(runDay, -1)
    return this.withClaim('data_quality', tenant, reportDate, atBusinessTime(runDay, this.resolved.qualityHour, this.resolved.qualityMinute), nowMs, async () => {
      const data = await this.dataSource.collectQuality(tenant.tenantId, windowStart, runDay)
      const findings = evaluateDataQuality(data.observations, {
        minimumCoverage: this.resolved.qualityMinimumCoverage,
        maximumParentDeviation: this.resolved.qualityMaximumParentDeviation,
        maximumHotColdDeviation: this.resolved.qualityMaximumHotColdDeviation,
      })
      for (const finding of findings) await this.auditFinding(tenant.tenantId, finding, nowMs)
      for (const warning of data.warnings) this.ctx.logger.warn(redactText(`nilm-scheduler R-08 ${tenant.tenantId}: ${warning}`))
      return { reportInserted: false, notifications: 0, qualityFindings: findings.length }
    })
  }

  private async withClaim(
    jobType: JobType,
    tenant: TenantSchedule,
    businessDate: string,
    scheduledAtMs: number,
    nowMs: number,
    work: () => Promise<{ reportInserted: boolean; notifications: number; qualityFindings: number }>,
  ): Promise<JobWork> {
    const idempotencyKey = `${tenant.tenantId}:${jobType}:${businessDate}`
    const outcome = (status: JobOutcome['status'], errorCode?: string): JobOutcome => ({
      jobType, tenantId: tenant.tenantId, businessDate, status,
      ...(errorCode === undefined ? {} : { errorCode }),
    })
    let claim: Awaited<ReturnType<SchedulerRepository['claimJob']>>
    try {
      claim = await this.repository.claimJob({
        jobType,
        tenantId: tenant.tenantId,
        scheduledAtMs,
        idempotencyKey,
        nowMs,
        leaseMs: this.resolved.jobLeaseMs,
        retryDelayMs: this.resolved.jobRetryDelayMs,
        newJobRunId: () => this.newId('job'),
      })
    } catch (error) {
      const code = errorCode(error)
      this.ctx.logger.warn(redactText(`nilm-scheduler ${jobType} claim failed for ${tenant.tenantId}: ${errorText(error)}`))
      return { outcome: outcome('failed', code), reportInserted: false, notifications: 0, qualityFindings: 0 }
    }
    if (claim.status === 'completed') return { outcome: outcome('completed-earlier'), reportInserted: false, notifications: 0, qualityFindings: 0 }
    if (claim.status === 'in-progress') return { outcome: outcome('in-progress'), reportInserted: false, notifications: 0, qualityFindings: 0 }
    try {
      const result = await work()
      const held = await this.repository.completeJob(claim.jobRunId, claim.attempt, nowMs)
      if (!held) {
        this.ctx.logger.warn(redactText(`nilm-scheduler ${jobType} attempt ${claim.attempt} for ${tenant.tenantId} lost its lease before completion`))
      }
      return { outcome: outcome('completed'), ...result }
    } catch (error) {
      const code = errorCode(error)
      try {
        const held = await this.repository.failJob(claim.jobRunId, claim.attempt, code, nowMs)
        if (!held) {
          this.ctx.logger.warn(redactText(`nilm-scheduler ${jobType} attempt ${claim.attempt} for ${tenant.tenantId} lost its lease before failure was recorded`))
        }
      } catch (failError) {
        // The lease expires on its own; one tenant's bookkeeping failure must not
        // abort the sweep for the tenants after it.
        this.ctx.logger.warn(redactText(`nilm-scheduler ${jobType} failJob failed for ${tenant.tenantId}: ${errorText(failError)}`))
      }
      this.ctx.logger.warn(redactText(`nilm-scheduler ${jobType} failed for ${tenant.tenantId}: ${errorText(error)}`))
      return { outcome: outcome('failed', code), reportInserted: false, notifications: 0, qualityFindings: 0 }
    }
  }

  private append(result: SchedulerSweepResult, work: JobWork): void {
    result.outcomes.push(work.outcome)
    if (work.reportInserted) result.reports += 1
    result.notifications += work.notifications
    result.qualityFindings += work.qualityFindings
  }

  private async summarize(input: ReportSummaryInput): Promise<string> {
    const controller = new AbortController()
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, this.resolved.summaryTimeoutMs)
    timer.unref()
    try {
      const text = await Promise.race([
        this.summaryWriter.write(input, controller.signal),
        timeoutAfter(this.resolved.summaryTimeoutMs),
      ])
      if (expired || text === undefined || text.trim() === '') return input.fallback
      return text
    } catch (error) {
      this.ctx.logger.warn(redactText(`nilm-scheduler summary fallback for ${input.tenantId}: ${errorText(error)}`))
      return input.fallback
    } finally {
      clearTimeout(timer)
    }
  }

  private async deliverReport(
    tenant: TenantSchedule,
    reportType: ReportType,
    reportDate: string,
    reportId: string,
    summary: string,
    payload: unknown,
    chart?: ChartSpec,
  ): Promise<number> {
    const recipients = await this.recipients.resolve(tenant.tenantId, tenant.notificationPolicy, this.resolved.reportChannels)
    if (recipients.length === 0) {
      this.ctx.logger.warn(redactText(`nilm-scheduler ${reportType} for ${tenant.tenantId} has no configured recipient`))
      return 0
    }
    const body = JSON.stringify({
      reportId,
      reportType,
      reportDate,
      title: reportType === 'morning_report' ? `${reportDate} 能源晨报` : `${reportDate} 力调预测`,
      summary,
      facts: notificationFacts(payload),
      ...(chart === undefined ? {} : { chart }),
    })
    const dedupeKey = `${tenant.tenantId}:${reportType}:${reportDate}`
    for (const recipient of recipients) {
      const draft: ReportOutboxDraft = {
        notificationId: reportId,
        tenantId: tenant.tenantId,
        userRef: recipient.userRef,
        reportId,
        channel: recipient.channel,
        ...(this.resolved.reportTemplates[recipient.channel] === undefined
          ? {}
          : { templateId: this.resolved.reportTemplates[recipient.channel] }),
        ...(recipient.ciphertext === undefined ? {} : { recipientCiphertext: recipient.ciphertext }),
        ...(recipient.masked === undefined ? {} : { recipientMasked: recipient.masked }),
        payloadJson: body,
        dedupeKey,
        maxAttempts: this.resolved.maxAttempts,
        nextRetryAtMs: this.now(),
      }
      await this.repository.enqueueReport(draft)
    }
    return recipients.length
  }

  private async morningPowerFactor(tenantId: string, reportDate: string): Promise<MorningPowerFactor | undefined> {
    const report = await this.repository.latestReport(tenantId, 'pf_forecast', reportDate)
    if (report === undefined) return undefined
    const payload = report.payload
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
    const forecast = (payload as { forecast?: unknown }).forecast
    if (typeof forecast !== 'object' || forecast === null || Array.isArray(forecast)) return undefined
    const value = forecast as {
      projectedPowerFactor?: unknown
      threshold?: unknown
      risk?: unknown
      asOfDate?: unknown
    }
    if (typeof value.threshold !== 'number' || typeof value.asOfDate !== 'string') return undefined
    if (value.risk !== 'pass' && value.risk !== 'watch' && value.risk !== 'risk') return undefined
    const projected = typeof value.projectedPowerFactor === 'number' ? value.projectedPowerFactor : undefined
    return {
      ...(projected === undefined ? {} : { projectedPowerFactor: projected }),
      threshold: value.threshold,
      risk: value.risk,
      asOfDate: value.asOfDate,
    }
  }

  private async auditFinding(tenantId: string, finding: QualityFinding, nowMs: number): Promise<void> {
    const draft: QualityAuditDraft = {
      auditId: this.newId('audit'),
      tenantId,
      kind: finding.kind,
      scope: `${finding.scopeId}:${finding.scopeName}`,
      message: finding.message,
      observed: finding.observed,
      threshold: finding.threshold,
      atMs: nowMs,
    }
    await this.repository.writeQualityAudit(draft)
  }
}

/**
 * Resolve defaults and validate cross-field constraints.
 * @param config - loader or programmatic configuration.
 * @returns detached resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const requestedChannels = config.reportChannels ?? ['wx_subscribe']
  const unknownChannel = requestedChannels.find(
    channel => !NOTIFICATION_CHANNELS.includes(channel as NotificationChannel))
  if (unknownChannel !== undefined) throw new NilmError('INVALID_ARGUMENT', `unknown report channel: ${unknownChannel}`)
  const reportChannels = [...new Set(requestedChannels as readonly NotificationChannel[])]
  const templates: Partial<Record<NotificationChannel, string>> = {}
  for (const [channel, template] of Object.entries(config.reportTemplates ?? {})) {
    if (!NOTIFICATION_CHANNELS.includes(channel as NotificationChannel)) {
      throw new NilmError('INVALID_ARGUMENT', `unknown report template channel: ${channel}`)
    }
    templates[channel as NotificationChannel] = template
  }
  return {
    tickIntervalMs: config.tickIntervalMs ?? 60_000,
    morningHour: config.morningHour ?? 8,
    morningMinute: config.morningMinute ?? 30,
    qualityHour: config.qualityHour ?? 3,
    qualityMinute: config.qualityMinute ?? 30,
    reportChannels,
    reportTemplates: templates,
    maxAttempts: config.maxAttempts ?? 5,
    jobLeaseMs: config.jobLeaseMs ?? 300_000,
    jobRetryDelayMs: config.jobRetryDelayMs ?? 300_000,
    summaryTimeoutMs: config.summaryTimeoutMs ?? 20_000,
    summaryProvider: config.summaryProvider ?? 'deepseek-official',
    ...(config.summaryModel === undefined ? {} : { summaryModel: config.summaryModel }),
    summaryPromptVersion: config.summaryPromptVersion ?? 'report-summary-v1',
    ...(config.summaryCwd === undefined ? {} : { summaryCwd: config.summaryCwd }),
    qualityMinimumCoverage: config.qualityMinimumCoverage ?? 0.95,
    qualityMaximumParentDeviation: config.qualityMaximumParentDeviation ?? 0.01,
    qualityMaximumHotColdDeviation: config.qualityMaximumHotColdDeviation ?? 0.01,
  }
}

/**
 * Build the default collector from the owning context.
 * @param ctx - owning context.
 * @param monthlyEnergy - optional monthly preaggregation.
 * @returns authorized collector dependencies.
 */
function defaultDataSource(ctx: Context, monthlyEnergy?: MonthlyEnergySource): SchedulerDataSourceDependencies {
  return {
    source: ctx.get('nilmSource')!,
    assets: ctx.get('nilmAssets')!,
    timeseries: ctx.get('nilmTimeseries')!,
    tariff: ctx.get('nilmTariff')!,
    analytics: ctx.get('nilmAnalytics')!,
    ...(monthlyEnergy === undefined ? {} : { monthlyEnergy }),
  }
}

/**
 * Mount the scheduled-report service.
 * @param ctx - owning plugin context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new NilmSchedulerService(ctx, config)
  service.start()
}

/**
 * Extract bounded facts for a provider template.
 * @param payload - structured report payload.
 * @returns primitive notification facts.
 */
function notificationFacts(payload: unknown): Record<string, string | number | boolean | null> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  const record = payload as Record<string, unknown>
  if (record.kind === 'morning_report') {
    const energy = record.energy
    const alerts = record.alerts
    return {
      kind: 'morning_report',
      totalKwh: numberField(energy, 'totalKwh'),
      coverage: numberField(energy, 'coverage'),
      critical: numberField(alerts, 'critical'),
      warning: numberField(alerts, 'warning'),
      unresolved: numberField(alerts, 'unresolved'),
    }
  }
  if (record.kind === 'pf_forecast') {
    const forecast = record.forecast
    return {
      kind: 'pf_forecast',
      risk: stringField(forecast, 'risk'),
      threshold: numberField(forecast, 'threshold'),
      projectedPowerFactor: numberField(forecast, 'projectedPowerFactor'),
    }
  }
  return {}
}

/**
 * Read a number field from a decoded object.
 * @param value - decoded object.
 * @param key - field name.
 * @returns the number, or null when absent.
 */
function numberField(value: unknown, key: string): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'number' ? field : null
}

/**
 * Read a string field from a decoded object.
 * @param value - decoded object.
 * @param key - field name.
 * @returns the string, or null when absent.
 */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : null
}

/**
 * Resolve a timeout without retaining a timer.
 * @param timeoutMs - delay.
 * @returns a promise resolving to `undefined` after the delay.
 */
function timeoutAfter(timeoutMs: number): Promise<undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    timer.unref()
  })
}

/**
 * @param error - thrown failure.
 * @returns stable error code.
 */
function errorCode(error: unknown): string {
  if (error instanceof NilmError) return error.code
  return 'INTERNAL_ERROR'
}

/**
 * @param error - thrown failure.
 * @returns bounded diagnostic text.
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown failure'
}

export { MysqlSchedulerRepository } from './store.ts'
export { SourceSchedulerDataSource, UnavailableMonthlyEnergySource } from './data-source.ts'
export { CordisReportSummaryWriter, TemplateReportSummaryWriter } from './summary-agent.ts'
export { forecastMonthlyPowerFactor } from './pf.ts'
export { evaluateDataQuality } from './quality.ts'
export { buildMorningReport, buildPowerFactorReport } from './report.ts'
export {
  addBusinessDays,
  atBusinessTime,
  businessDayOfMonth,
  businessDateKey,
  businessWeekday,
  endOfBusinessMonth,
  isAtOrAfterBusinessTime,
  isPowerFactorForecastDay,
  parseBusinessDate,
  startOfBusinessDay,
  startOfBusinessMonth,
} from './time.ts'
export type { SchedulerRepository, ReportType, JobType, JobClaim, TenantSchedule, AlertCounts, ReportDraft, SavedReport, StoredReport, ReportOutboxDraft, QualityAuditDraft } from './model.ts'
export type { MorningData, MonthlyData, QualityData, SchedulerDataSource, MonthlyEnergySource, SchedulerDataSourceDependencies } from './data-source.ts'
export type { ReportSummaryInput, ReportSummaryWriter, ReportSummaryAgentConfig } from './summary-agent.ts'
export type { DailyEnergy, PowerFactorForecast, PowerFactorForecastInput, PowerFactorRisk } from './pf.ts'
export type { DataQualityObservation, QualityThresholds, QualityFinding, QualityFindingKind } from './quality.ts'
export type { MorningReportInput, MorningReportPayload, MorningPowerFactor, PowerFactorReportPayload, BuiltReport, WorkshopEnergy } from './report.ts'

export default NilmSchedulerService
