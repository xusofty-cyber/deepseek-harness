/**
 * Active inspection service: incremental upstream safety polling plus
 * tenant-configured energy rules. The service never calls a model and never
 * decides severity from model output.
 * @module @deepseek-ai/dsh-nilm-sentinel
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NilmError, redactText } from '@deepseek-ai/dsh-nilm-core'
import type {} from '@deepseek-ai/dsh-nilm-assets'
import type {} from '@deepseek-ai/dsh-nilm-timeseries'
import { isNonProduction, shanghaiIso } from './calendar.ts'
import {
  alignBucket,
  maxSeverity,
  silenceKey,
  type AlertCandidate,
  type AlertScope,
  type AlertSeverity,
  type AlertState,
  type NotificationChannel,
  type SentinelRuleId,
} from './model.ts'
import { JsonRecipientPolicy, type RecipientPolicy, type RecipientRef } from './recipients.ts'
import {
  evaluateR01a,
  evaluateR01b,
  evaluateR02,
  evaluateR05,
  isSustained,
  type R01aThresholds,
  type R01bThresholds,
  type R02Thresholds,
  type R05Thresholds,
  type RuleFinding,
} from './rules.ts'
import { SourceRuleSignalProvider, type RuleSignalProvider } from './signals.ts'
import { SourceUnsafeIncrementalSource, type IncrementalUnsafeSource } from './source.ts'
import {
  MysqlSentinelStore,
  newAlertId,
  newNotificationId,
  type AlertPage,
  type AlertQuery,
  type AlertRuleRow,
  type AlertWrite,
  type OutboxDraft,
  type SentinelStore,
  type TenantPolicy,
  type Watermark,
} from './store.ts'
import { decideNotification } from './suppression.ts'
import { classifyUnsafeType, findingFromUnsafeRow, toMs, type UnsafeRecordRow } from './unsafe.ts'

/** Notification template identifiers keyed by channel. */
export type TemplateIds = Partial<Record<NotificationChannel, string>>

/** Deployment configuration; every value is deployment-varying and has no embedded secret. */
export interface Config {
  /** Upstream incremental poll interval. */
  pollIntervalMs?: number
  /** Energy-rule evaluation interval. */
  energyIntervalMs?: number
  /** De-duplication and escalation bucket width in minutes. */
  bucketMinutes?: number
  /** Maximum upstream rows read per batch. */
  batchSize?: number
  /** Consecutive rising buckets required for warning-to-critical escalation. */
  escalateAfterWindows?: number
  /** Outbox attempts before dead-lettering. */
  maxAttempts?: number
  /** Provider templates keyed by channel. */
  templates?: TemplateIds
  /** Fallback nominal phase voltage for R-05 when the rule omits one. */
  nominalVoltageV?: number
  /** Worker identification written by the notification dispatcher. */
  workerId?: string
  /** Zero-based StatefulSet shard served by this Pod. */
  shardIndex?: number
  /** Total StatefulSet shards. Only shard 0 runs the scanner. */
  shardCount?: number
  /** Configured source identity used by `nilm_source_tenant_map`. */
  sourceId?: string
  /** Upstream tenant key this deployment reads. */
  sourceTenantId: string
}

/** Cordis schema for {@link Config}. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.natural().min(1_000).default(5_000),
  energyIntervalMs: z.natural().min(5_000).default(60_000),
  bucketMinutes: z.natural().min(1).default(5),
  batchSize: z.natural().min(1).max(1_000).default(200),
  escalateAfterWindows: z.natural().min(2).max(10).default(3),
  maxAttempts: z.natural().min(1).max(20).default(5),
  templates: z.dict(String).default({}),
  nominalVoltageV: z.natural().min(1).default(220),
  workerId: z.string().default('sentinel'),
  shardIndex: z.natural().default(0),
  shardCount: z.natural().min(1).default(1),
  sourceId: z.string().default('upstream_unsafe'),
  sourceTenantId: z.string().required(),
})

/** Resolved configuration with defaults applied. */
export interface ResolvedConfig {
  pollIntervalMs: number
  energyIntervalMs: number
  bucketMinutes: number
  batchSize: number
  escalateAfterWindows: number
  maxAttempts: number
  templates: TemplateIds
  nominalVoltageV: number
  workerId: string
  shardIndex: number
  shardCount: number
  sourceId: string
  sourceTenantId: string
}

/** Minimal caller identity accepted by the alert API. */
export interface AlertCaller {
  /** Tenant boundary. */
  tenantId: string
  /** Opaque receiving user reference. */
  userRef: string
}

/** Payload emitted after a transactional alert write when a notification was enqueued. */
export interface AlertCreatedPayload {
  /** Public alert identifier. */
  eventId: string
  /** Tenant boundary. */
  tenantId: string
  /** Rule identifier. */
  ruleId: SentinelRuleId
  /** Final severity. */
  severity: AlertSeverity
  /** Addressed scope. */
  scope: AlertScope
  /** Metric name. */
  metric: string
  /** Observed value. */
  value: number
  /** Threshold when one applies. */
  threshold: number | null
  /** Metric unit. */
  unit: string
  /** Deterministic template summary. */
  summaryText: string
  /** Upstream event instant. */
  occurredAtMs: number
  /** Detection instant. */
  detectedAtMs: number
  /** Deterministic facts. */
  facts: Readonly<Record<string, string | number | boolean | null>>
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One new deliverable alert was committed. Listeners run after the
     * transaction; they must not block or roll back the alert.
     * @param payload - committed alert facts.
     * @mode emit
     */
    'nilm/alert/created'(payload: AlertCreatedPayload): void
  }

  interface Context {
    nilmSentinel: NilmSentinelService
  }
}

/** Injectable seams used by tests and alternate deployments. */
export interface SentinelDependencies {
  /** Persistence replacing the project database. */
  store?: SentinelStore
  /** Upstream incremental reader. */
  unsafe?: IncrementalUnsafeSource
  /** Energy-rule signal provider. */
  signals?: RuleSignalProvider
  /** Tenant recipient policy reader. */
  recipients?: RecipientPolicy
  /** Injectable clock. */
  now?: () => number
  /** Injectable alert identifier generator. */
  newEventId?: () => string
  /** Injectable notification identifier generator. */
  newNotificationId?: () => string
}

interface PowerSample {
  tsMs: number
  powerKw: number
}

interface ViolationSample {
  tsMs: number
  violated: boolean
}

interface ProcessContext {
  readonly tenants: ReadonlyMap<string, TenantPolicy>
  readonly rules: Map<string, readonly AlertRuleRow[]>
}

const UNSAFE_SOURCE = 'upstream_unsafe'
/** Bound diagnostic de-duplication so a poisoned upstream cannot grow memory. */
const MAX_DIAGNOSTIC_KEYS = 1_024
/** Maximum batches per scan before yielding to the next poll tick. */
const MAX_SCAN_BATCHES = 10
/** Active inspection service. */
export class NilmSentinelService extends Service {
  /** Cordis configuration schema. */
  static Config = Config

  private readonly config: ResolvedConfig
  private readonly store: SentinelStore
  private readonly unsafe: IncrementalUnsafeSource
  private readonly signals: RuleSignalProvider
  private readonly recipients: RecipientPolicy
  private readonly now: () => number
  private readonly newEventId: () => string
  private readonly newNotificationId: () => string
  private readonly powerBuffers = new Map<string, PowerSample[]>()
  private readonly violationBuffers = new Map<string, ViolationSample[]>()
  private readonly missingSignalsLogged = new Set<string>()
  private readonly badUnsafeRecords = new Set<string>()
  private readonly ambiguousUnsafeRecords = new Set<string>()
  private unmappedSourceLogged = false
  private timer: NodeJS.Timeout | undefined
  private scanning = false
  private watermark: Watermark | undefined
  private scanOffset = 0
  private lastEnergyAtMs = 0

  /**
   * @param ctx - owning plugin context.
   * @param config - deployment configuration.
   * @param dependencies - store, source, and clock overrides.
   */
  constructor(ctx: Context, config: Config, dependencies: SentinelDependencies = {}) {
    super(ctx, 'nilmSentinel')
    this.config = resolveConfig(config)
    this.store = dependencies.store ?? new MysqlSentinelStore(() => ctx.get('nilmSource')!)
    this.unsafe = dependencies.unsafe ?? new SourceUnsafeIncrementalSource(() => ctx.get('nilmSource')!)
    this.signals = dependencies.signals ?? new SourceRuleSignalProvider(() => ctx, this.config.nominalVoltageV)
    this.recipients = dependencies.recipients ?? new JsonRecipientPolicy()
    this.now = dependencies.now ?? (() => Date.now())
    this.newEventId = dependencies.newEventId ?? newAlertId
    this.newNotificationId = dependencies.newNotificationId ?? newNotificationId
    ctx.effect(() => () => this.stop(), 'nilm-sentinel.timer')
  }

  /** Start the polling loop; the first scan runs immediately. */
  start(): void {
    if (this.timer !== undefined) return
    if (this.config.shardIndex !== 0) return
    const tick = (): void => {
      if (this.scanning) return
      this.scanning = true
      void this.scanOnce()
        .catch((error: unknown) => { this.ctx.logger.warn(redactText(`nilm-sentinel scan failed: ${errorText(error)}`)) })
        .finally(() => { this.scanning = false })
    }
    this.timer = setInterval(tick, this.config.pollIntervalMs)
    this.timer.unref()
    tick()
  }

  /** Stop polling. An in-flight scan finishes. */
  stop(): void {
    if (this.timer === undefined) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /**
   * Run one incremental pass immediately. Safe to call from an administrative
   * smoke test; the polling loop serializes its own calls.
   * @returns counts of read rows and inserted alerts.
   */
  async scanOnce(): Promise<{ read: number; inserted: number }> {
    if (this.config.shardIndex !== 0) return { read: 0, inserted: 0 }
    const nowMs = this.now()
    const context = await this.processContext()
    const mappedTenantId = await this.resolveMappedTenant()
    let inserted = 0
    if (mappedTenantId === null) {
      if (nowMs - this.lastEnergyAtMs >= this.config.energyIntervalMs) {
        this.lastEnergyAtMs = nowMs
        inserted += await this.evaluateEnergyRules(context, nowMs)
      }
      return { read: 0, inserted }
    }
    await this.ensureWatermark(nowMs)
    let read = 0
    let batches = 0
    while (batches < MAX_SCAN_BATCHES) {
      batches += 1
      const rows = await this.unsafe.readAfter(this.watermark!, this.config.batchSize, this.scanOffset)
      if (rows.length === 0) break
      read += rows.length
      let lastValid: { recordId: string; recordTimeMs: number } | undefined
      for (const row of rows) {
        let recordTimeMs: number
        try {
          recordTimeMs = toMs(row.recordTime, row.recordId)
        } catch {
          this.noteBadUnsafeRecord(row.recordId)
          continue
        }
        lastValid = { recordId: row.recordId, recordTimeMs }
        inserted += await this.processUnsafeRow(row, context, nowMs, mappedTenantId)
      }
      if (lastValid === undefined) {
        // The watermark only advances across rows with a usable instant. Offset
        // scanning walks a poison prefix without putting it in query parameters.
        this.scanOffset += rows.length
        // Persist the walk so a restart resumes here instead of re-reading the prefix.
        await this.store.saveWatermark(UNSAFE_SOURCE, { ...this.watermark!, scanOffset: this.scanOffset })
        if (rows.length < this.config.batchSize) break
        continue
      }
      this.watermark = lastValid
      this.scanOffset = 0
      await this.store.saveWatermark(UNSAFE_SOURCE, { ...this.watermark, scanOffset: 0 })
      if (rows.length < this.config.batchSize) break
    }
    if (nowMs - this.lastEnergyAtMs >= this.config.energyIntervalMs) {
      this.lastEnergyAtMs = nowMs
      inserted += await this.evaluateEnergyRules(context, nowMs)
    }
    return { read, inserted }
  }

  /**
   * List alerts visible to one receiving caller.
   * @param caller - tenant and receiving user.
   * @param query - optional filter.
   * @returns alert projections and total.
   */
  async alerts(caller: AlertCaller, query: AlertQuery = {}): Promise<AlertPage> {
    return this.store.listAlerts(caller.tenantId, caller.userRef, query)
  }

  /**
   * Acknowledge one alert visible to the caller.
   * @param caller - tenant and receiving user.
   * @param eventId - alert identifier.
   * @returns the outcome.
   */
  async acknowledge(caller: AlertCaller, eventId: string): Promise<'acknowledged' | 'already-final'> {
    if (!/^alert_[A-Za-z0-9]+$/.test(eventId)) throw new NilmError('INVALID_ARGUMENT', 'alert id is malformed')
    return this.store.acknowledge(caller.tenantId, caller.userRef, eventId, this.now())
  }

  private async ensureWatermark(nowMs: number): Promise<void> {
    if (this.watermark !== undefined) return
    const persisted = await this.store.loadWatermark(UNSAFE_SOURCE)
    if (persisted !== undefined) {
      this.watermark = { recordTimeMs: persisted.recordTimeMs, recordId: persisted.recordId }
      this.scanOffset = persisted.scanOffset ?? 0
      return
    }
    const head = await this.unsafe.head()
    if (head !== undefined && Number.isFinite(head.recordTimeMs)) {
      this.watermark = head
    } else {
      if (head !== undefined) {
        this.ctx.logger.warn(redactText(`nilm-sentinel ignored an invalid watermark head ${head.recordId}`))
      }
      this.watermark = { recordTimeMs: nowMs, recordId: '' }
    }
    await this.store.saveWatermark(UNSAFE_SOURCE, this.watermark)
  }

  /**
   * @returns configured source tenant's mapped project tenant, or `null` when
   * the configured source tenant has no mapping.
   */
  private async resolveMappedTenant(): Promise<string | null> {
    const sourceTenantId = this.config.sourceTenantId
    const tenantId = await this.store.resolveSourceTenant(this.config.sourceId, sourceTenantId)
    if (tenantId !== undefined) {
      this.unmappedSourceLogged = false
      return tenantId
    }
    if (!this.unmappedSourceLogged) {
      this.unmappedSourceLogged = true
      this.ctx.logger.warn(redactText(`nilm-sentinel rejected source tenant ${sourceTenantId}: no nilm_source_tenant_map row`))
    }
    return null
  }

  private async processContext(): Promise<ProcessContext> {
    const tenants = new Map<string, TenantPolicy>()
    for (const tenant of await this.store.listTenants()) tenants.set(tenant.tenantId, tenant)
    return { tenants, rules: new Map() }
  }

  private async rulesFor(context: ProcessContext, tenantId: string): Promise<readonly AlertRuleRow[]> {
    const cached = context.rules.get(tenantId)
    if (cached !== undefined) return cached
    const rules = await this.store.listRules(tenantId)
    context.rules.set(tenantId, rules)
    return rules
  }

  private async processUnsafeRow(
    row: UnsafeRecordRow,
    context: ProcessContext,
    nowMs: number,
    mappedTenantId: string,
  ): Promise<number> {
    const classification = classifyUnsafeType(row.unsafeType)
    if (classification === undefined) return 0
    const nodeIds = [row.terminalChannelId, row.assetId].filter((id): id is string => id !== null && id.length > 0)
    if (nodeIds.length === 0) return 0
    const ownerships = await this.store.resolveScopes(nodeIds, mappedTenantId)
    const tenantIds = new Set(ownerships.map(ownership => ownership.tenantId))
    if (tenantIds.size > 1) {
      this.noteAmbiguousUnsafeRecord(row.recordId)
      return 0
    }
    let inserted = 0
    for (const ownership of ownerships) {
      const tenant = context.tenants.get(ownership.tenantId)
      if (tenant === undefined) continue
      const rules = await this.rulesFor(context, tenant.tenantId)
      const rule = rules.find(item => item.ruleId === classification.ruleId)
      const channels = rule?.channels.length ? rule.channels : defaultChannels(classification.severity)
      const finding = findingFromUnsafeRow(row, classification)
      const candidate: AlertCandidate = {
        tenantId: tenant.tenantId,
        ruleId: classification.ruleId,
        sourceType: 'upstream_unsafe',
        scope: ownership.scope,
        severity: rule === undefined ? classification.severity : maxSeverity(rule.severity, classification.severity),
        metric: finding.finding.metric,
        value: finding.finding.value,
        threshold: null,
        unit: finding.finding.unit,
        bucketStartMs: alignBucket(finding.rawEventTimeMs, this.config.bucketMinutes * 60_000),
        rawEventTimeMs: finding.rawEventTimeMs,
        summaryText: finding.finding.summary,
        channels,
        silentMinutes: rule?.silentMinutes ?? defaultSilentMinutes(classification.ruleId),
        bypassSilence: classification.bypassSilence,
        facts: finding.finding.facts,
      }
      inserted += await this.commitCandidate(candidate, tenant, finding.finding, nowMs)
    }
    return inserted
  }

  /**
   * Record one poison row as a dead-letter id.
   * @param recordId - upstream record identity.
   */
  private noteBadUnsafeRecord(recordId: string): void {
    const key = `bad-record:${recordId}`
    if (!this.badUnsafeRecords.has(key)) {
      if (this.badUnsafeRecords.size >= MAX_DIAGNOSTIC_KEYS) this.badUnsafeRecords.clear()
      this.badUnsafeRecords.add(key)
      this.ctx.logger.warn(redactText(`nilm-sentinel skipped upstream record ${recordId} with an invalid record_time`))
    }
  }

  private noteAmbiguousUnsafeRecord(recordId: string): void {
    const key = `ambiguous-record:${recordId}`
    if (this.ambiguousUnsafeRecords.has(key)) return
    if (this.ambiguousUnsafeRecords.size >= MAX_DIAGNOSTIC_KEYS) this.ambiguousUnsafeRecords.clear()
    this.ambiguousUnsafeRecords.add(key)
    this.ctx.logger.warn(redactText(`nilm-sentinel skipped upstream record ${recordId}: node maps to multiple tenants`))
  }

  private async evaluateEnergyRules(context: ProcessContext, nowMs: number): Promise<number> {
    let inserted = 0
    for (const tenant of context.tenants.values()) {
      const rules = await this.rulesFor(context, tenant.tenantId)
      const nonProduction = isNonProduction(nowMs, tenant.workHours)
      for (const rule of rules) {
        switch (rule.ruleId) {
          case 'R-01a':
            if (nonProduction) inserted += await this.evaluateR01aRule(tenant, rule, nowMs)
            break
          case 'R-01b':
            if (nonProduction) inserted += await this.evaluateR01bRule(tenant, rule, nowMs)
            break
          case 'R-02':
            if (nonProduction) inserted += await this.evaluateR02Rule(tenant, rule, nowMs)
            break
          case 'R-05':
            inserted += await this.evaluateR05Rule(tenant, rule, nowMs)
            break
          case 'R-04':
            this.noteMissingSignal(tenant.tenantId, rule.ruleId, 'upstream realtime projection has no per-phase current columns')
            break
          case 'R-03':
            break
        }
      }
    }
    return inserted
  }

  private async evaluateR01aRule(tenant: TenantPolicy, rule: AlertRuleRow, nowMs: number): Promise<number> {
    const thresholds = rule.thresholds as R01aThresholds
    const signal = await this.signals.totalPower(tenant.tenantId, rule, nowMs)
    if (signal === undefined) {
      this.noteMissingSignal(tenant.tenantId, rule.ruleId, 'no authorized realtime power sample')
      return 0
    }
    const key = bufferKey(tenant.tenantId, rule)
    let samples: PowerSample[] = []
    for (const sample of signal.samples) {
      samples = pushPower(this.powerBuffers, key, sample, nowMs - 2 * 60_000)
    }
    const finding = evaluateR01a({ samples: samples.map(item => item.powerKw), baselineKw: tenant.baselineKw, thresholds })
    if (finding === undefined) return 0
    return this.commitEnergyCandidate(tenant, rule, finding, nowMs, rule.scope)
  }

  private async evaluateR01bRule(tenant: TenantPolicy, rule: AlertRuleRow, nowMs: number): Promise<number> {
    const thresholds = rule.thresholds as R01bThresholds
    const signal = await this.signals.totalPower(tenant.tenantId, rule, nowMs)
    if (signal === undefined) return 0
    const threshold = tenant.baselineKw * thresholds.baselineMultiplier
    const key = bufferKey(tenant.tenantId, rule)
    const samples = pushViolation(this.violationBuffers, key, { tsMs: signal.latestSampleAtMs, violated: signal.powerKw > threshold }, nowMs - thresholds.sustainedMinutes * 60_000)
    const required = Math.max(2, Math.floor(thresholds.sustainedMinutes * 60_000 / this.config.energyIntervalMs) - 1)
    const sustained = isSustained(samples, nowMs, thresholds.sustainedMinutes * 60_000, required)
    const finding = evaluateR01b({ powerKw: signal.powerKw, baselineKw: tenant.baselineKw, sustained, thresholds })
    if (finding === undefined) return 0
    return this.commitEnergyCandidate(tenant, rule, finding, nowMs, rule.scope)
  }

  private async evaluateR02Rule(tenant: TenantPolicy, rule: AlertRuleRow, nowMs: number): Promise<number> {
    const thresholds = rule.thresholds as R02Thresholds
    const appliances = await this.signals.appliances(tenant.tenantId, rule, nowMs, thresholds.idlePowerKw)
    let inserted = 0
    for (const appliance of appliances) {
      const finding = evaluateR02({
        name: appliance.name,
        powerKw: appliance.powerKw,
        running: appliance.running,
        stateSinceMs: appliance.stateSinceMs,
        nowMs,
        thresholds,
      })
      if (finding === undefined) continue
      const scope: AlertScope = {
        level: 'appliance',
        id: `${rule.scope.id}#${appliance.name}`.slice(0, 64),
        name: `${rule.scope.name}/${appliance.name}`,
      }
      inserted += await this.commitEnergyCandidate(tenant, rule, finding, nowMs, scope)
    }
    return inserted
  }

  private async evaluateR05Rule(tenant: TenantPolicy, rule: AlertRuleRow, nowMs: number): Promise<number> {
    const thresholds = rule.thresholds as R05Thresholds
    const signal = await this.signals.voltages(tenant.tenantId, rule, nowMs)
    if (signal === undefined) return 0
    const values = [signal.voltages.a, signal.voltages.b, signal.voltages.c]
    const violated = values.some(value => Math.abs(value - signal.nominalVoltageV) / signal.nominalVoltageV * 100 > thresholds.deviationPercent)
    const key = bufferKey(tenant.tenantId, rule)
    const samples = pushViolation(this.violationBuffers, key, { tsMs: nowMs, violated }, nowMs - thresholds.sustainedMinutes * 60_000)
    const required = Math.max(2, Math.floor(thresholds.sustainedMinutes * 60_000 / this.config.energyIntervalMs) - 1)
    const sustained = isSustained(samples, nowMs, thresholds.sustainedMinutes * 60_000, required)
    const finding = evaluateR05({ voltages: signal.voltages, nominalVoltageV: signal.nominalVoltageV, sustained, thresholds })
    if (finding === undefined) return 0
    return this.commitEnergyCandidate(tenant, rule, finding, nowMs, rule.scope)
  }

  private async commitEnergyCandidate(
    tenant: TenantPolicy,
    rule: AlertRuleRow,
    finding: RuleFinding,
    nowMs: number,
    scope: AlertScope,
  ): Promise<number> {
    const candidate: AlertCandidate = {
      tenantId: tenant.tenantId,
      ruleId: rule.ruleId,
      sourceType: 'sentinel_rule',
      scope,
      severity: maxSeverity(rule.severity, finding.severity),
      metric: finding.metric,
      value: finding.value,
      threshold: finding.threshold,
      unit: finding.unit,
      bucketStartMs: alignBucket(nowMs, this.config.bucketMinutes * 60_000),
      rawEventTimeMs: nowMs,
      summaryText: finding.summary,
      channels: rule.channels.length === 0 ? defaultChannels(finding.severity) : rule.channels,
      silentMinutes: rule.silentMinutes,
      bypassSilence: finding.severity === 'critical' && isSafetyRule(rule.ruleId),
      facts: finding.facts,
    }
    return this.commitCandidate(candidate, tenant, finding, nowMs)
  }

  private async commitCandidate(
    candidate: AlertCandidate,
    tenant: TenantPolicy,
    finding: RuleFinding,
    nowMs: number,
  ): Promise<number> {
    const key = silenceKey(candidate.tenantId, candidate.ruleId, candidate.scope.id, candidate.metric)
    const sinceMs = candidate.bucketStartMs - this.config.escalateAfterWindows * this.config.bucketMinutes * 60_000
    const history = await this.store.recentObservations(
      candidate.tenantId,
      key,
      sinceMs,
      this.config.escalateAfterWindows,
    )
    const lastNotifiedAtMs = await this.store.lastNotificationAt(candidate.tenantId, key)
    const decision = decideNotification({
      candidate,
      history,
      ...(lastNotifiedAtMs === undefined ? {} : { lastNotifiedAtMs }),
      bucketMs: this.config.bucketMinutes * 60_000,
      escalateAfterWindows: this.config.escalateAfterWindows,
    })
    const notificationId = this.newNotificationId()
    const eventId = this.newEventId()
    const status: AlertState = decision.action === 'notify' ? 'confirmed' : 'suppressed'
    const escalatedFrom = decision.escalatedFrom === undefined ? undefined : history[history.length - 1]?.eventId
    const summary = decision.escalatedFrom === undefined
      ? finding.summary
      : `${finding.summary} 该告警已连续 ${String(this.config.escalateAfterWindows)} 个窗口升高，级别提升为 critical。`
    const recipients = decision.action === 'notify'
      ? await this.recipients.resolve(tenant.tenantId, tenant.notificationPolicy, candidate.channels)
      : []
    const outbox = recipients.map(recipient => outboxFor(
      candidate,
      recipient,
      notificationId,
      eventId,
      decision.dedupeKey,
      this.config.templates[recipient.channel],
      this.config.maxAttempts,
      nowMs,
    ))
    const write: AlertWrite = {
      event: {
        eventId,
        tenantId: candidate.tenantId,
        ruleId: candidate.ruleId,
        sourceType: candidate.sourceType,
        scope: candidate.scope,
        severity: decision.severity,
        metric: candidate.metric,
        value: candidate.value,
        threshold: candidate.threshold,
        unit: candidate.unit,
        bucketStartMs: candidate.bucketStartMs,
        silenceKey: key,
        dedupeKey: decision.dedupeKey,
        rawEventTimeMs: candidate.rawEventTimeMs,
        detectedAtMs: nowMs,
        summaryText: summary,
        status,
        ...(escalatedFrom === undefined ? {} : { escalatedFrom }),
        facts: candidate.facts,
      },
      transition: {
        eventId,
        toStatus: status,
        operatorType: 'sentinel',
        reason: decision.reason,
        atMs: nowMs,
      },
      outbox,
    }
    const outcome = await this.store.insertAlert(write)
    if (outcome === 'duplicate') return 0
    if (outbox.length > 0) {
      this.ctx.emit('nilm/alert/created', {
        eventId: write.event.eventId,
        tenantId: candidate.tenantId,
        ruleId: candidate.ruleId,
        severity: decision.severity,
        scope: candidate.scope,
        metric: candidate.metric,
        value: candidate.value,
        threshold: candidate.threshold,
        unit: candidate.unit,
        summaryText: summary,
        occurredAtMs: candidate.rawEventTimeMs,
        detectedAtMs: nowMs,
        facts: candidate.facts,
      })
    }
    return 1
  }

  private noteMissingSignal(tenantId: string, ruleId: SentinelRuleId, reason: string): void {
    const key = `${tenantId}:${ruleId}:${reason}`
    if (this.missingSignalsLogged.has(key)) return
    this.missingSignalsLogged.add(key)
    this.ctx.logger.warn(redactText(`nilm-sentinel ${ruleId} skipped for tenant ${tenantId}: ${reason}`))
  }
}

/**
 * Mount the Sentinel service.
 * @param ctx - owning plugin context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const service = new NilmSentinelService(ctx, config)
  if (resolved.shardIndex === 0) {
    service.start()
  } else {
    ctx.logger.info(redactText(`nilm-sentinel scanner disabled on shard ${String(resolved.shardIndex)} of ${String(resolved.shardCount)}`))
  }
}

/**
 * Resolve defaults and validate cross-field constraints.
 * @param config - loader or programmatic configuration.
 * @returns detached resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const shardIndex = config.shardIndex ?? 0
  const shardCount = config.shardCount ?? 1
  if (shardIndex >= shardCount) throw new TypeError('shardIndex must be less than shardCount')
  const sourceTenantId = config.sourceTenantId?.trim()
  if (sourceTenantId === undefined || sourceTenantId.length === 0) {
    throw new TypeError('sourceTenantId is required')
  }
  return {
    pollIntervalMs: config.pollIntervalMs ?? 5_000,
    energyIntervalMs: config.energyIntervalMs ?? 60_000,
    bucketMinutes: config.bucketMinutes ?? 5,
    batchSize: config.batchSize ?? 200,
    escalateAfterWindows: config.escalateAfterWindows ?? 3,
    maxAttempts: config.maxAttempts ?? 5,
    templates: { ...config.templates },
    nominalVoltageV: config.nominalVoltageV ?? 220,
    workerId: config.workerId ?? 'sentinel',
    shardIndex,
    shardCount,
    sourceId: config.sourceId ?? 'upstream_unsafe',
    sourceTenantId,
  }
}

/**
 * Build one Outbox row for a recipient.
 * @param candidate - alert facts.
 * @param recipient - delivery target.
 * @param notificationId - shared public id.
 * @param dedupeKey - decision key.
 * @param templateId - provider template.
 * @param maxAttempts - attempt ceiling.
 * @param nowMs - creation instant.
 * @returns the Outbox draft.
 */
function outboxFor(
  candidate: AlertCandidate,
  recipient: RecipientRef,
  notificationId: string,
  eventId: string,
  dedupeKey: string,
  templateId: string | undefined,
  maxAttempts: number,
  nowMs: number,
): OutboxDraft {
  const payload = {
    alertId: notificationId,
    tenantId: candidate.tenantId,
    ruleId: candidate.ruleId,
    severity: candidate.severity,
    scopeLevel: candidate.scope.level,
    scopeId: candidate.scope.id,
    scopeName: candidate.scope.name,
    metric: candidate.metric,
    value: candidate.value,
    threshold: candidate.threshold,
    unit: candidate.unit,
    occurredAt: shanghaiIso(candidate.rawEventTimeMs),
    summary: candidate.summaryText,
    facts: candidate.facts,
  }
  return {
    notificationId,
    tenantId: candidate.tenantId,
    userRef: recipient.userRef,
    eventId,
    channel: recipient.channel,
    ...(templateId === undefined ? {} : { templateId }),
    ...(recipient.ciphertext === undefined ? {} : { recipientCiphertext: recipient.ciphertext }),
    ...(recipient.masked === undefined ? {} : { recipientMasked: recipient.masked }),
    payloadJson: JSON.stringify(payload),
    dedupeKey,
    maxAttempts,
    nextRetryAtMs: nowMs,
  }
}

/** @param tenantId - tenant boundary. @param rule - rule row. @returns a stable buffer key. */
function bufferKey(tenantId: string, rule: AlertRuleRow): string {
  return `${tenantId}\n${rule.ruleId}\n${rule.scope.level}\n${rule.scope.id}`
}

/**
 * Append a power sample and prune the buffer.
 * @param buffers - per-scope buffers.
 * @param key - buffer key.
 * @param sample - new sample.
 * @param sinceMs - earliest retained instant.
 * @returns retained samples in chronological order.
 */
function pushPower(
  buffers: Map<string, PowerSample[]>,
  key: string,
  sample: PowerSample,
  sinceMs: number,
): PowerSample[] {
  const list = buffers.get(key) ?? []
  list.push(sample)
  const retained = list.filter(item => item.tsMs >= sinceMs).sort((left, right) => left.tsMs - right.tsMs)
  buffers.set(key, retained)
  return retained
}

/**
 * Append a violation sample and prune the buffer.
 * @param buffers - per-scope buffers.
 * @param key - buffer key.
 * @param sample - new sample.
 * @param sinceMs - earliest retained instant.
 * @returns retained samples in chronological order.
 */
function pushViolation(
  buffers: Map<string, ViolationSample[]>,
  key: string,
  sample: ViolationSample,
  sinceMs: number,
): ViolationSample[] {
  const list = buffers.get(key) ?? []
  list.push(sample)
  const retained = list.filter(item => item.tsMs >= sinceMs).sort((left, right) => left.tsMs - right.tsMs)
  buffers.set(key, retained)
  return retained
}

/** @param severity - finding severity. @returns channels used when a rule row omits them. */
function defaultChannels(severity: AlertSeverity): NotificationChannel[] {
  return severity === 'critical' ? ['wx_subscribe', 'wx_template'] : ['wx_subscribe']
}

/** @param ruleId - rule identifier. @returns documented fallback silence window. */
function defaultSilentMinutes(ruleId: SentinelRuleId): number {
  switch (ruleId) {
    case 'R-01a': return 10
    case 'R-02': return 120
    case 'R-03': return 10
    case 'R-04': return 30
    case 'R-05': return 15
    case 'R-01b': return 30
  }
}

/** @param ruleId - rule identifier. @returns true for electrical-safety rules. */
function isSafetyRule(ruleId: SentinelRuleId): boolean {
  return ruleId === 'R-03' || ruleId === 'R-04' || ruleId === 'R-05'
}

/** @param error - unknown failure. @returns bounded diagnostic text. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export {
  MysqlSentinelStore,
  newAlertId,
  newNotificationId,
} from './store.ts'
export { SourceUnsafeIncrementalSource } from './source.ts'
export { SourceRuleSignalProvider } from './signals.ts'
export { JsonRecipientPolicy } from './recipients.ts'
export { decideNotification, escalationFor } from './suppression.ts'
export {
  assertAlertTransition,
  alignBucket,
  dedupeKey,
  escalationDedupeKey,
  maxSeverity,
  compareSeverity,
  silenceKey,
} from './model.ts'
export { parseWorkHours, isNonProduction } from './calendar.ts'
export { classifyUnsafeType } from './unsafe.ts'
export {
  evaluateR01a,
  evaluateR01b,
  evaluateR02,
  evaluateR03,
  evaluateR04,
  evaluateR05,
  isSustained,
  parseThresholds,
} from './rules.ts'
export type {
  AlertPage,
  AlertQuery,
  AlertRuleRow,
  AlertView,
  OutboxDraft,
  ScopeOwnership,
  SentinelStore,
  TenantPolicy,
  Watermark,
} from './store.ts'
export type { AlertCandidate, AlertSeverity, AlertState, AlertScope, NotificationChannel, SentinelRuleId } from './model.ts'
export type { RuleSignalProvider, PowerSignal, ApplianceSignal } from './signals.ts'
export type { RecipientPolicy, RecipientRef } from './recipients.ts'
export type { IncrementalUnsafeSource } from './source.ts'
export type { UnsafeRecordRow, UnsafeClassification } from './unsafe.ts'
export type { WindowObservation, NotificationDecision } from './suppression.ts'
export type {
  RuleFinding,
  RuleThresholds,
  R01aThresholds,
  R01bThresholds,
  R02Thresholds,
  R03Thresholds,
  R04Thresholds,
  R05Thresholds,
  PhaseCurrents,
  PhaseVoltages,
} from './rules.ts'

export default NilmSentinelService
