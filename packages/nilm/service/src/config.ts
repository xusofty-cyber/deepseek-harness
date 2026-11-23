/**
 * Validated deployment configuration for the NILM BFF.
 * @module @deepseek-ai/dsh-nilm-service/config
 */

import { isAbsolute, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveShardAssignment, type ShardAssignment } from '@deepseek-ai/dsh-nilm-sharding'
import { UNVERIFIED_AUDIT_TENANT } from './audit.ts'

/** Deployment-varying settings; no address, secret, or model id is compiled in. */
export interface Config {
  /** Listen address. */
  host?: string
  /** Listen port; `0` selects an ephemeral port. */
  port?: number
  /** Absolute directory persisted with every new Session. */
  sessionCwd?: string
  /**
   * Absolute PVC root that holds one directory per tenant. When set, new
   * Sessions use `<sessionsRoot>/<tenant>` and conversation records live under
   * the same tenant directory.
   */
  sessionsRoot?: string
  /** Zero-based shard served by this Pod. */
  shardIndex?: number
  /** Total StatefulSet shards; tenants are routed by MurmurHash3 over this count. */
  shardCount?: number
  /** LLM provider route for ordinary questions. */
  provider?: string
  /** LLM model route for ordinary questions. */
  model: string
  /** Optional stronger model route used by `mode: "reasoner"`. */
  reasoningModel?: string
  /** HMAC secrets keyed by tenant id. Empty means no caller can authenticate. */
  signingSecrets: Record<string, string>
  /** Maximum accepted request body size. */
  maxBodyBytes?: number
  /** Accepted clock skew for the request timestamp. */
  clockSkewMs?: number
  /** Nonce retention window. */
  nonceTtlMs?: number
  /** Maximum wall-clock duration of one turn. */
  turnTimeoutMs?: number
  /** SSE keepalive interval. */
  pingIntervalMs?: number
  /** Maximum queued security-audit events before new events are dropped. */
  auditQueueSize?: number
  /** Maximum security-audit rows written in one transaction. */
  auditBatchSize?: number
  /** How long a finished turn remains replayable in process memory. */
  turnRetentionMs?: number
  /** Maximum finished turns retained for replay across all callers. */
  maxRetainedTurns?: number
  /** Maximum aggregate replay bytes retained across finished turns. */
  maxRetainedTurnBytes?: number
  /** Maximum bytes buffered for one turn's SSE replay. */
  maxTurnBufferBytes?: number
  /** Idle time before a live agent session is released from memory. */
  sessionIdleTtlMs?: number
  /** Maximum conversation index entries cached in process. */
  conversationCacheSize?: number
  /** Maximum clientMessageId idempotency entries retained. */
  maxIdempotencyEntries?: number
  /** Periodic cache and rate-window maintenance interval. */
  maintenanceIntervalMs?: number
  /** Per-user request allowance inside one rate window. */
  rateLimitPerUserPerMinute?: number
  /** Maximum concurrent active turns per tenant. */
  rateLimitTenantConcurrency?: number
  /** Rate window width. */
  rateLimitWindowMs?: number
}

/** Loader schema with deployment-safe defaults. */
export const Config: z<Config> = z.object({
  host: z.string().default('0.0.0.0'),
  port: z.natural().max(65535).default(8080),
  sessionCwd: z.string().default(process.cwd()),
  sessionsRoot: z.string(),
  shardIndex: z.natural().default(0),
  shardCount: z.natural().min(1).default(1),
  provider: z.string().default('deepseek-official'),
  model: z.string().required(),
  reasoningModel: z.string(),
  signingSecrets: z.dict(String).required(),
  maxBodyBytes: z.natural().min(1).default(1_048_576),
  clockSkewMs: z.natural().min(1).default(300_000),
  nonceTtlMs: z.natural().min(1).default(600_000),
  turnTimeoutMs: z.natural().min(1).default(60_000),
  pingIntervalMs: z.natural().min(1).default(15_000),
  auditQueueSize: z.natural().min(1).default(1_024),
  auditBatchSize: z.natural().min(1).default(64),
  turnRetentionMs: z.natural().min(1).default(600_000),
  maxRetainedTurns: z.natural().min(1).default(1_024),
  maxRetainedTurnBytes: z.natural().min(64 * 1024).default(64 * 1024 * 1024),
  maxTurnBufferBytes: z.natural().min(64 * 1024).default(8 * 1024 * 1024),
  sessionIdleTtlMs: z.natural().min(1).default(900_000),
  conversationCacheSize: z.natural().min(1).default(4_096),
  maxIdempotencyEntries: z.natural().min(1).default(10_000),
  maintenanceIntervalMs: z.natural().min(1_000).default(60_000),
  rateLimitPerUserPerMinute: z.natural().min(1).default(10),
  rateLimitTenantConcurrency: z.natural().min(1).default(20),
  rateLimitWindowMs: z.natural().min(1_000).default(60_000),
})

/** Configuration after defaults have been applied. */
export interface ResolvedConfig {
  host: string
  port: number
  sessionCwd: string
  sessionsRoot?: string
  shard: ShardAssignment
  provider: string
  model: string
  reasoningModel?: string
  signingSecrets: Readonly<Record<string, string>>
  maxBodyBytes: number
  clockSkewMs: number
  nonceTtlMs: number
  turnTimeoutMs: number
  pingIntervalMs: number
  auditQueueSize: number
  auditBatchSize: number
  turnRetentionMs: number
  maxRetainedTurns: number
  maxRetainedTurnBytes: number
  maxTurnBufferBytes: number
  sessionIdleTtlMs: number
  conversationCacheSize: number
  maxIdempotencyEntries: number
  maintenanceIntervalMs: number
  rateLimitPerUserPerMinute: number
  rateLimitTenantConcurrency: number
  rateLimitWindowMs: number
}

/**
 * Apply defaults and validate values that a loader cannot express.
 * @param config - validated or programmatic configuration.
 * @returns a detached resolved configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const sessionCwd = resolve(config.sessionCwd ?? process.cwd())
  if (!isAbsolute(sessionCwd)) throw new TypeError('sessionCwd must resolve to an absolute path')
  const sessionsRoot = config.sessionsRoot === undefined ? undefined : resolve(config.sessionsRoot)
  if (sessionsRoot !== undefined && !isAbsolute(sessionsRoot)) {
    throw new TypeError('sessionsRoot must resolve to an absolute path')
  }
  const shard = resolveShardAssignment(config.shardIndex, config.shardCount)
  if (config.model.trim() === '') throw new TypeError('model must be a non-empty string')
  const provider = config.provider ?? 'deepseek-official'
  if (provider.trim() === '') throw new TypeError('provider must be a non-empty string')
  const secrets: Record<string, string> = {}
  for (const [tenantId, secret] of Object.entries(config.signingSecrets)) {
    if (tenantId === UNVERIFIED_AUDIT_TENANT) {
      throw new TypeError(`tenant id '${UNVERIFIED_AUDIT_TENANT}' is reserved for unverified audit events`)
    }
    if (tenantId.trim() === '' || secret.length < 16) {
      throw new TypeError('each signing secret requires a non-empty tenant and at least 16 characters')
    }
    secrets[tenantId] = secret
  }
  return {
    host: config.host ?? '0.0.0.0',
    port: config.port ?? 8080,
    sessionCwd,
    ...(sessionsRoot === undefined ? {} : { sessionsRoot }),
    shard,
    provider,
    model: config.model,
    ...(config.reasoningModel === undefined ? {} : { reasoningModel: config.reasoningModel }),
    signingSecrets: Object.freeze(secrets),
    maxBodyBytes: config.maxBodyBytes ?? 1_048_576,
    clockSkewMs: config.clockSkewMs ?? 300_000,
    nonceTtlMs: config.nonceTtlMs ?? 600_000,
    turnTimeoutMs: config.turnTimeoutMs ?? 60_000,
    pingIntervalMs: config.pingIntervalMs ?? 15_000,
    auditQueueSize: config.auditQueueSize ?? 1_024,
    auditBatchSize: config.auditBatchSize ?? 64,
    turnRetentionMs: config.turnRetentionMs ?? 600_000,
    maxRetainedTurns: config.maxRetainedTurns ?? 1_024,
    maxRetainedTurnBytes: config.maxRetainedTurnBytes ?? 64 * 1024 * 1024,
    maxTurnBufferBytes: config.maxTurnBufferBytes ?? 8 * 1024 * 1024,
    sessionIdleTtlMs: config.sessionIdleTtlMs ?? 900_000,
    conversationCacheSize: config.conversationCacheSize ?? 4_096,
    maxIdempotencyEntries: config.maxIdempotencyEntries ?? 10_000,
    maintenanceIntervalMs: config.maintenanceIntervalMs ?? 60_000,
    rateLimitPerUserPerMinute: config.rateLimitPerUserPerMinute ?? 10,
    rateLimitTenantConcurrency: config.rateLimitTenantConcurrency ?? 20,
    rateLimitWindowMs: config.rateLimitWindowMs ?? 60_000,
  }
}
