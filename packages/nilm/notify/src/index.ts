/**
 * Reliable notification service: Outbox dispatcher plus asynchronous alert
 * enrichment. Delivery is independent of the model and never waits for it.
 * @module @deepseek-ai/dsh-nilm-notify
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactText } from '@deepseek-ai/dsh-nilm-core'
import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import { buildTransports, type ChannelTransport, type FetchLike } from './channels.ts'
import { CordisDiagnosisAgent } from './diagnosis.ts'
import { NotificationDispatcher } from './dispatcher.ts'
import { EnrichmentWorker, type DiagnosisAgent } from './enrich.ts'
import { MysqlOutboxStore, type OutboxStore } from './store.ts'

/** Deployment configuration for delivery and enrichment. */
export interface Config {
  /** Dispatcher poll interval. */
  pollIntervalMs?: number
  /** Rows claimed per tick. */
  batchSize?: number
  /** Outbox lease duration. */
  leaseMs?: number
  /** Per-channel gateway timeout. */
  channelTimeoutMs?: number
  /** Delivery-record retention. */
  retentionDays?: number
  /** Worker identity used by leases. */
  workerId?: string
  /** WeChat mini-program subscription gateway. */
  wxSubscribeUrl?: string
  /** Subscription gateway bearer token. */
  wxSubscribeToken?: string
  /** WeChat official-account template gateway. */
  wxTemplateUrl?: string
  /** Template gateway bearer token. */
  wxTemplateToken?: string
  /** WeCom robot gateway. */
  wecomWebhookUrl?: string
  /** WeCom gateway bearer token. */
  wecomWebhookToken?: string
  /** SMS gateway. */
  smsUrl?: string
  /** SMS gateway bearer token. */
  smsToken?: string
  /** Registered provider for enrichment. */
  enrichProvider?: string
  /** Enrichment model; absent disables enrichment. */
  enrichModel?: string
  /** Prompt version recorded with the diagnosis. */
  enrichPromptVersion?: string
  /** Hard enrichment timeout. */
  enrichTimeoutMs?: number
  /** Concurrent enrichments. */
  enrichConcurrency?: number
  /** Enrichment session working directory. */
  enrichCwd?: string
}

/** Cordis schema for {@link Config}. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.natural().min(500).default(2_000),
  batchSize: z.natural().min(1).max(200).default(20),
  leaseMs: z.natural().min(1_000).default(60_000),
  channelTimeoutMs: z.natural().min(1_000).default(10_000),
  retentionDays: z.natural().min(0).default(180),
  workerId: z.string().default('notifier'),
  wxSubscribeUrl: z.string(),
  wxSubscribeToken: z.string(),
  wxTemplateUrl: z.string(),
  wxTemplateToken: z.string(),
  wecomWebhookUrl: z.string(),
  wecomWebhookToken: z.string(),
  smsUrl: z.string(),
  smsToken: z.string(),
  enrichProvider: z.string().default('deepseek-official'),
  enrichModel: z.string(),
  enrichPromptVersion: z.string().default('alert-enrich-v1'),
  enrichTimeoutMs: z.natural().min(100).default(8_000),
  enrichConcurrency: z.natural().min(1).max(20).default(2),
  enrichCwd: z.string(),
})

/** Injectable seams used by tests and alternate deployments. */
export interface NotifyDependencies {
  /** Outbox persistence. */
  store?: OutboxStore
  /** Channel transports keyed by fixed channel. */
  transports?: ReadonlyMap<NotificationChannel, ChannelTransport>
  /** Enrichment agent; overrides the Cordis adapter. */
  diagnosisAgent?: DiagnosisAgent
  /** Injectable fetch for gateway transports. */
  fetchImpl?: FetchLike
  /** Injectable clock. */
  now?: () => number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmNotify: NilmNotifyService
  }
}

/** Notification service owned by the BFF process. */
export class NilmNotifyService extends Service {
  /** Cordis configuration schema. */
  static Config = Config

  /** Dispatcher exposed for administrative smoke tests. */
  readonly dispatcher: NotificationDispatcher
  /** Enrichment queue, present only when a model is configured. */
  readonly enrichment: EnrichmentWorker | undefined
  private started = false

  /**
   * @param ctx - owning plugin context.
   * @param config - deployment configuration.
   * @param dependencies - store, transports, agent, and clock overrides.
   */
  constructor(ctx: Context, config: Config = {}, dependencies: NotifyDependencies = {}) {
    super(ctx, 'nilmNotify')
    const resolved = resolveConfig(config)
    const store = dependencies.store ?? new MysqlOutboxStore(() => ctx.get('nilmSource')!)
    const transports = dependencies.transports ?? buildTransports({
      wx_subscribe: { endpoint: resolved.wxSubscribeUrl, token: resolved.wxSubscribeToken, timeoutMs: resolved.channelTimeoutMs },
      wx_template: { endpoint: resolved.wxTemplateUrl, token: resolved.wxTemplateToken, timeoutMs: resolved.channelTimeoutMs },
      wecom_webhook: { endpoint: resolved.wecomWebhookUrl, token: resolved.wecomWebhookToken, timeoutMs: resolved.channelTimeoutMs },
      sms: { endpoint: resolved.smsUrl, token: resolved.smsToken, timeoutMs: resolved.channelTimeoutMs },
    }, dependencies.fetchImpl)
    this.dispatcher = new NotificationDispatcher({
      store,
      transports,
      workerId: resolved.workerId,
      batchSize: resolved.batchSize,
      leaseMs: resolved.leaseMs,
      pollIntervalMs: resolved.pollIntervalMs,
      sendTimeoutMs: resolved.channelTimeoutMs,
      retentionDays: resolved.retentionDays,
      now: dependencies.now ?? (() => Date.now()),
      logger: { warn: message => { ctx.logger.warn(redactText(message)) } },
    })
    const agent = dependencies.diagnosisAgent ?? (resolved.enrichModel === undefined
      ? undefined
      : new CordisDiagnosisAgent(() => ctx, {
        provider: resolved.enrichProvider,
        model: resolved.enrichModel,
        promptVersion: resolved.enrichPromptVersion,
        ...(resolved.enrichCwd === undefined ? {} : { cwd: resolved.enrichCwd }),
      }))
    this.enrichment = agent === undefined
      ? undefined
      : new EnrichmentWorker({
        store,
        agent,
        timeoutMs: resolved.enrichTimeoutMs,
        concurrency: resolved.enrichConcurrency,
        now: dependencies.now ?? (() => Date.now()),
        logger: { warn: message => { ctx.logger.warn(redactText(message)) } },
      })
    const off = ctx.on('nilm/alert/created', payload => { this.enrichment?.enqueue(payload) })
    ctx.effect(() => off)
    ctx.effect(() => () => { this.stop() }, 'nilm-notify.timer')
  }

  /** Start the Outbox polling loop. */
  start(): void {
    if (this.started) return
    this.started = true
    this.dispatcher.start()
  }

  /** Stop polling; in-flight sends finish. */
  stop(): void {
    this.started = false
    this.dispatcher.stop()
  }
}

/**
 * Mount the notification service.
 * @param ctx - owning plugin context.
 * @param config - deployment configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const service = new NilmNotifyService(ctx, config)
  service.start()
}

/** Resolved configuration with optional fields preserved. */
export interface ResolvedConfig {
  pollIntervalMs: number
  batchSize: number
  leaseMs: number
  channelTimeoutMs: number
  retentionDays: number
  workerId: string
  wxSubscribeUrl?: string
  wxSubscribeToken?: string
  wxTemplateUrl?: string
  wxTemplateToken?: string
  wecomWebhookUrl?: string
  wecomWebhookToken?: string
  smsUrl?: string
  smsToken?: string
  enrichProvider: string
  enrichModel?: string
  enrichPromptVersion: string
  enrichTimeoutMs: number
  enrichConcurrency: number
  enrichCwd?: string
}

/**
 * Apply defaults.
 * @param config - loader or programmatic configuration.
 * @returns detached resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    pollIntervalMs: config.pollIntervalMs ?? 2_000,
    batchSize: config.batchSize ?? 20,
    leaseMs: config.leaseMs ?? 60_000,
    channelTimeoutMs: config.channelTimeoutMs ?? 10_000,
    retentionDays: config.retentionDays ?? 180,
    workerId: config.workerId ?? 'notifier',
    ...optional('wxSubscribeUrl', config.wxSubscribeUrl),
    ...optional('wxSubscribeToken', config.wxSubscribeToken),
    ...optional('wxTemplateUrl', config.wxTemplateUrl),
    ...optional('wxTemplateToken', config.wxTemplateToken),
    ...optional('wecomWebhookUrl', config.wecomWebhookUrl),
    ...optional('wecomWebhookToken', config.wecomWebhookToken),
    ...optional('smsUrl', config.smsUrl),
    ...optional('smsToken', config.smsToken),
    ...optional('enrichModel', config.enrichModel),
    ...optional('enrichCwd', config.enrichCwd),
    enrichProvider: config.enrichProvider ?? 'deepseek-official',
    enrichPromptVersion: config.enrichPromptVersion ?? 'alert-enrich-v1',
    enrichTimeoutMs: config.enrichTimeoutMs ?? 8_000,
    enrichConcurrency: config.enrichConcurrency ?? 2,
  }
}

/**
 * Copy an optional string without inventing a value.
 * @param key - destination key.
 * @param value - optional value.
 * @returns a spreadable object.
 */
function optional<K extends keyof ResolvedConfig>(key: K, value: ResolvedConfig[K] | undefined): Partial<ResolvedConfig> {
  return value === undefined ? {} : { [key]: value } as Partial<ResolvedConfig>
}

export { NotificationDispatcher, failureOf } from './dispatcher.ts'
export { EnrichmentWorker } from './enrich.ts'
export { CordisDiagnosisAgent } from './diagnosis.ts'
export { MysqlOutboxStore } from './store.ts'
export {
  GatewayChannelTransport,
  UnconfiguredChannelTransport,
  DeliveryFailureError,
  buildTransports,
} from './channels.ts'
export { RETRY_DELAYS_MS, retryDelayMs, shouldDeadLetter } from './model.ts'
export type { OutboxTask, OutboxStatus, DeliveryFailure, DeliveryResult } from './model.ts'
export type { OutboxStore, DiagnosisResult, FailureOutcome } from './store.ts'
export type { DiagnosisAgent, EnrichOutcome } from './enrich.ts'
export type { ChannelTransport, FetchLike } from './channels.ts'

export default NilmNotifyService
