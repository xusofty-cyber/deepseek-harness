/**
 * NILM BFF plugin: verifies caller envelopes, runs agent turns, and exposes
 * REST/SSE endpoints for the caller's application or mini-program backend.
 * @module @deepseek-ai/dsh-nilm-service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { AlertPage } from '@deepseek-ai/dsh-nilm-sentinel'
import { redactText, redactValue } from '@deepseek-ai/dsh-nilm-core'
import { Config, resolveConfig, type Config as NilmServiceConfig } from './config.ts'
import { FileConversationStore, MemoryConversationStore } from './conversations.ts'
import { NilmHttpService, type AlertListPage } from './http.ts'
import { CordisNilmRuntime } from './runtime.ts'

/** Cordis plugin name. */
export const name = 'nilm-service'

/** Services that must be mounted before the BFF can serve a turn. */
export const inject = [
  'agents',
  'sessions',
  'llm',
  'nilmContext',
  'nilmSource',
  'nilmAssets',
  'nilmTimeseries',
  'nilmTariff',
  'nilmAnalytics',
  'nilmSafety',
  'nilmSentinel',
]

export { Config }
export type { Config as NilmServiceConfig }
export {
  NilmHttpService,
  type AlertApi,
  type AlertListPage,
  type AuditEvent,
  type NilmHttpServiceOptions,
} from './http.ts'
export {
  AuthError,
  NonceStore,
  canonicalRequest,
  createSignature,
  parseAllowedScope,
  verifyRequest,
  type VerifiedCaller,
  type VerifyRequestInput,
} from './auth.ts'
export { TurnEventBuffer, type SseEvent, type SseEventType } from './events.ts'
export {
  FileConversationStore,
  MemoryConversationStore,
  type ConversationStore,
  type StoredConversation,
} from './conversations.ts'
export { tenantPathSegment, tenantSessionRoot } from './paths.ts'
export {
  CordisNilmRuntime,
  type ChatMessage,
  type NilmAgentEvent,
  type NilmAgentRuntime,
  type NilmAgentSession,
  type TurnMode,
} from './runtime.ts'

/**
 * Mount the BFF HTTP server. Configuration comes from the profile so no
 * address, signing secret, or model id is compiled into this package.
 * @param ctx - owning plugin context.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: NilmServiceConfig): void {
  const resolved = resolveConfig(config)
  const runtime = new CordisNilmRuntime(ctx, resolved)
  const conversations = resolved.sessionsRoot === undefined
    ? new MemoryConversationStore()
    : new FileConversationStore(resolved.sessionsRoot)
  const sentinel = ctx.get('nilmSentinel')
  const service = new NilmHttpService({
    config: resolved,
    runtime,
    conversations,
    shard: resolved.shard,
    ready: () => ctx.get('nilmSource') !== undefined
      && ctx.get('nilmAssets') !== undefined
      && ctx.get('nilmTimeseries') !== undefined
      && ctx.get('nilmTariff') !== undefined
      && ctx.get('nilmAnalytics') !== undefined
      && ctx.get('nilmSafety') !== undefined
      && ctx.get('agents') !== undefined
      && ctx.get('sessions') !== undefined,
    audit: event => { ctx.logger.warn(`nilm.security ${JSON.stringify(redactValue(event))}`) },
    reportBackgroundFailure: (operation, error) => {
      ctx.logger.error(redactText(`${operation} failed: ${error instanceof Error ? error.message : String(error)}`))
    },
    ...(sentinel === undefined ? {} : {
      alerts: {
        list: async (caller: { tenantId: string; userRef: string }) => alertPageJson(await sentinel.alerts(caller)),
        acknowledge: (caller: { tenantId: string; userRef: string }, eventId: string) => sentinel.acknowledge(caller, eventId),
      },
    }),
  })
  ctx.effect(() => {
    void service.start().then(
      address => { ctx.logger.info(redactText(`nilm-service listening on ${address.address}:${String(address.port)}`)) },
      error => { ctx.logger.error(redactText(`nilm-service failed to listen: ${String(error)}`)) },
    )
    return async () => { await service.close() }
  }, 'nilm-service.http')
}

/**
 * Project a Sentinel alert page into the BFF's JSON wire values.
 * @param page - caller-visible alert projections.
 * @returns the page with optional diagnosis materialized as null.
 */
function alertPageJson(page: AlertPage): AlertListPage {
  return {
    alerts: page.alerts.map((alert): JsonValue => ({
      id: alert.id,
      severity: alert.severity,
      status: alert.status,
      ruleId: alert.ruleId,
      scopeLevel: alert.scopeLevel,
      scopeId: alert.scopeId,
      scopeName: alert.scopeName,
      metric: alert.metric,
      value: alert.value,
      threshold: alert.threshold,
      unit: alert.unit,
      detectedAt: alert.detectedAt,
      occurredAt: alert.occurredAt,
      finding: alert.finding,
      agentDiagnosis: alert.agentDiagnosis ?? null,
    })),
    total: page.total,
  }
}
