/**
 * Channel adapters post to service-provider-owned gateways. The gateway owns
 * vendor credentials and recipient decryption; this project sends only the
 * encrypted recipient material and deterministic template parameters.
 * @module @deepseek-ai/dsh-nilm-notify/channels
 */

import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import {
  assertHttpEndpoint,
  readBoundedResponseText,
  ResponseLimitError,
} from '@deepseek-ai/dsh-nilm-core'
import { timeoutSignal, type DeliveryFailure, type DeliveryResult, type OutboxTask } from './model.ts'

/** Gateway responses carry only a provider id; larger bodies are ignored. */
const MAX_GATEWAY_RESPONSE_BYTES = 64 * 1024

/** One channel transport. */
export interface ChannelTransport {
  /** Fixed channel identity. */
  readonly channel: NotificationChannel
  /**
   * @param task - claimed Outbox row.
   * @param signal - worker cancellation.
   * @returns the provider result.
   * @throws DeliveryFailureError for any classified failure.
   */
  send(task: OutboxTask, signal?: AbortSignal): Promise<DeliveryResult>
}

/** Classified channel failure consumed by the dispatcher. */
export class DeliveryFailureError extends Error {
  /** Machine-readable classification. */
  readonly failure: DeliveryFailure

  /**
   * @param failure - stable code, retryability, and diagnostic detail.
   */
  constructor(failure: DeliveryFailure) {
    super(failure.detail ?? failure.code)
    this.name = 'DeliveryFailureError'
    this.failure = failure
  }
}

/** Structural fetch surface used by the gateway adapter and tests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Service-provider gateway client shared by all four channels. */
export class GatewayChannelTransport implements ChannelTransport {
  /**
   * @param channel - fixed channel identity.
   * @param endpoint - provider gateway URL from deployment configuration.
   * @param token - optional bearer token from deployment configuration.
   * @param fetchImpl - injectable fetch.
   * @param timeoutMs - per-send timeout.
   */
  constructor(
    readonly channel: NotificationChannel,
    private readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = globalThis.fetch,
    private readonly timeoutMs: number = 10_000,
  ) {
    assertHttpEndpoint(endpoint, `${channel} gateway endpoint`)
  }

  /** @param task - claimed Outbox row. @param signal - worker cancellation. @returns provider result. */
  async send(task: OutboxTask, signal?: AbortSignal): Promise<DeliveryResult> {
    const payload = parsePayload(task.payloadJson)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token !== undefined) headers.authorization = `Bearer ${this.token}`
    const body = JSON.stringify({
      channel: this.channel,
      notificationId: task.notificationId,
      templateId: task.templateId,
      userRef: task.userRef,
      recipient: task.recipientCiphertext === null ? null : Buffer.from(task.recipientCiphertext).toString('base64'),
      recipientMasked: task.recipientMasked,
      payload,
    })
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers,
      body,
      signal: timeoutSignal(this.timeoutMs, signal),
      redirect: 'manual',
    })
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500
      throw new DeliveryFailureError({
        code: `gateway_${String(response.status)}`,
        retryable,
        detail: `gateway returned HTTP ${String(response.status)}`,
      })
    }
    const result = await readJson(response)
    const providerMessageId = messageIdOf(result)
    return providerMessageId === undefined ? {} : { providerMessageId }
  }
}

/** Adapter used when a channel has no configured gateway; it fails without retrying. */
export class UnconfiguredChannelTransport implements ChannelTransport {
  /**
   * @param channel - fixed channel identity.
   */
  constructor(readonly channel: NotificationChannel) {}

  /** @returns never. @throws DeliveryFailureError with `channel_not_configured`. */
  async send(): Promise<DeliveryResult> {
    throw new DeliveryFailureError({ code: 'channel_not_configured', retryable: false })
  }
}

/**
 * Build the channel map from deployment configuration.
 * @param channels - endpoint, token, and timeout per channel.
 * @param fetchImpl - injectable fetch for tests.
 * @returns one transport per fixed channel.
 */
export function buildTransports(
  channels: Partial<Record<NotificationChannel, { endpoint?: string | undefined; token?: string | undefined; timeoutMs?: number }>>,
  fetchImpl?: FetchLike,
): ReadonlyMap<NotificationChannel, ChannelTransport> {
  const fixed: readonly NotificationChannel[] = ['wx_subscribe', 'wx_template', 'wecom_webhook', 'sms']
  const transports = new Map<NotificationChannel, ChannelTransport>()
  for (const channel of fixed) {
    const config = channels[channel]
    if (config?.endpoint === undefined || config.endpoint.length === 0) {
      transports.set(channel, new UnconfiguredChannelTransport(channel))
      continue
    }
    assertHttpEndpoint(config.endpoint, `${channel} gateway endpoint`)
    transports.set(channel, new GatewayChannelTransport(
      channel,
      config.endpoint,
      config.token,
      fetchImpl ?? globalThis.fetch,
      config.timeoutMs ?? 10_000,
    ))
  }
  return transports
}

/**
 * Parse the deterministic payload column.
 * @param text - stored JSON.
 * @returns the decoded object.
 * @throws DeliveryFailureError with `invalid_payload` when the column is corrupt.
 */
function parsePayload(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    throw new DeliveryFailureError({ code: 'invalid_payload', retryable: false })
  }
}

/**
 * Read an optional JSON response body.
 * @param response - successful gateway response.
 * @returns the decoded body, or undefined when empty or non-JSON.
 */
async function readJson(response: Response): Promise<unknown> {
  let text: string
  try {
    text = await readBoundedResponseText(response, MAX_GATEWAY_RESPONSE_BYTES)
  } catch (error) {
    if (error instanceof ResponseLimitError) return undefined
    throw error
  }
  if (text.trim() === '') return undefined
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return undefined
  }
}

/**
 * Extract a provider id from common gateway response fields.
 * @param body - decoded response.
 * @returns the id when present.
 */
function messageIdOf(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['providerMessageId', 'messageId', 'msgid', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return undefined
}
