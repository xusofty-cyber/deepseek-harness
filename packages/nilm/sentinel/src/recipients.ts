/**
 * Delivery recipients are provisioned by the service provider in the tenant
 * notification policy. This package never maintains a customer user directory
 * and never stores plaintext phone numbers or OpenIDs.
 * @module @deepseek-ai/dsh-nilm-sentinel/recipients
 */

import { NilmError } from '@deepseek-ai/dsh-nilm-core'
import type { NotificationChannel } from './model.ts'
import { NOTIFICATION_CHANNELS } from './model.ts'

/** One encrypted delivery target from tenant policy. */
export interface RecipientRef {
  /** Caller-side opaque user reference used for list/ack visibility. */
  userRef: string
  /** Delivery channel. */
  channel: NotificationChannel
  /** Opaque encrypted recipient material; the channel adapter owns decryption. */
  ciphertext?: Uint8Array
  /** Masked display hint such as `138****0000`. */
  masked?: string
}

/** Delivery policy seam replaced in tests or by an alternate tenant store. */
export interface RecipientPolicy {
  /**
   * @param tenantId - tenant boundary.
   * @param policyJson - raw `notification_policy_json` value.
   * @param channels - channels requested by the rule.
   * @returns deduplicated recipients for the requested channels.
   */
  resolve(tenantId: string, policyJson: unknown, channels: readonly NotificationChannel[]): Promise<RecipientRef[]>
}

/** Policy parser for the documented `notification_policy_json` recipient list. */
export class JsonRecipientPolicy implements RecipientPolicy {
  /**
   * @param tenantId - tenant boundary.
   * @param policyJson - decoded policy or JSON text.
   * @param channels - rule channels.
   * @returns deduplicated recipients.
   */
  async resolve(
    tenantId: string,
    policyJson: unknown,
    channels: readonly NotificationChannel[],
  ): Promise<RecipientRef[]> {
    const policy = decode(policyJson, tenantId)
    if (policy === undefined) return []
    const requested = new Set(channels.filter(channel => NOTIFICATION_CHANNELS.includes(channel)))
    if (requested.size === 0) return []
    const entries = policy.recipients
    if (!Array.isArray(entries)) return []
    const seen = new Set<string>()
    const recipients: RecipientRef[] = []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} notification recipient must be an object`)
      }
      const record = entry as Record<string, unknown>
      if (typeof record.userRef !== 'string' || record.userRef.trim() === '') {
        throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} notification recipient requires a userRef`)
      }
      if (typeof record.channel !== 'string' || !requested.has(record.channel as NotificationChannel)) continue
      const channel = record.channel as NotificationChannel
      const key = `${record.userRef}\n${channel}`
      if (seen.has(key)) continue
      seen.add(key)
      const recipient: RecipientRef = { userRef: record.userRef, channel }
      if (record.ciphertext !== undefined) {
        if (typeof record.ciphertext !== 'string') {
          throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} recipient ciphertext must be base64 text`)
        }
        recipient.ciphertext = decodeBase64(record.ciphertext, tenantId)
      }
      if (record.masked !== undefined) {
        if (typeof record.masked !== 'string' || record.masked.length > 64) {
          throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} masked recipient must be at most 64 characters`)
        }
        recipient.masked = record.masked
      }
      recipients.push(recipient)
    }
    return recipients
  }
}

/**
 * Decode the tenant policy value.
 * @param value - decoded policy or JSON text.
 * @param tenantId - diagnostic tenant.
 * @returns the policy object, or `undefined` when no policy is configured.
 */
function decode(value: unknown, tenantId: string): { recipients?: unknown } | undefined {
  if (value === null || value === undefined) return undefined
  const decoded = typeof value === 'string' ? parseJson(value, tenantId) : value
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} notification policy must be an object`)
  }
  return decoded as { recipients?: unknown }
}

/**
 * Decode base64 recipient material.
 * @param text - base64 text.
 * @param tenantId - diagnostic tenant.
 * @returns raw bytes.
 */
function decodeBase64(text: string, tenantId: string): Uint8Array {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length % 4 !== 0) {
    throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} recipient ciphertext is not valid base64`)
  }
  const bytes = Buffer.from(trimmed, 'base64')
  if (bytes.toString('base64') !== trimmed) {
    throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} recipient ciphertext is not valid base64`)
  }
  return bytes
}

/**
 * Parse policy JSON text.
 * @param text - JSON text.
 * @param tenantId - diagnostic tenant.
 * @returns the decoded value.
 */
function parseJson(text: string, tenantId: string): unknown {
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (error) {
    throw new NilmError('INVALID_ARGUMENT', `tenant ${tenantId} notification policy is not valid JSON`, { cause: error })
  }
}
