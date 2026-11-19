/**
 * Deterministic masking for secrets and personal identifiers that may reach
 * NILM logs, audit records, or operator-visible diagnostics.
 * @module @deepseek-ai/dsh-nilm-core/redact
 */

/** Replacement written in place of a masked value. */
export const REDACTED = '<redacted>'

const MOBILE_NUMBER = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g
const RAW_OPEN_ID = /(?<![A-Za-z0-9_-])o[A-Za-z0-9_-]{27}(?![A-Za-z0-9_-])/g
const LABELED_SECRET = /(\b(?:openid|open_id|unionid|union_id|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|api[_-]?token|wx[_-]?token|sms[_-]?token|webhook[_-]?token|client[_-]?secret|signing[_-]?secret|signature|secret|password|passwd)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi
const AUTHORIZATION = /(\bauthorization\b\s*[:=]\s*)(?:(?:Bearer|Basic)\s+)?[A-Za-z0-9._~+/=-]+/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const NILM_SIGNATURE = /(\bx-nilm-signature\b\s*[:=]\s*)v1=[0-9a-fA-F]+/gi
const V1_SIGNATURE = /\bv1=[0-9a-fA-F]{16,}\b/g

const SENSITIVE_KEY = /^(?:authorization|openid|open_?id|unionid|union_?id|phone|mobile|phone_?number|api_?key|apikey|access_?token|refresh_?token|auth_?token|api_?token|wx_?token|sms_?token|webhook_?token|client_?secret|signing_?secret|signature|x-nilm-signature|secret|password|passwd)$/i

/**
 * Mask known sensitive values in one free-form diagnostic string.
 * @param text - message that may contain identifiers or credentials.
 * @returns the message with phone numbers, OpenID values, and tokens masked.
 */
export function redactText(text: string): string {
  return text
    .replace(NILM_SIGNATURE, `$1${REDACTED}`)
    .replace(AUTHORIZATION, `$1${REDACTED}`)
    .replace(BEARER, 'Bearer <redacted>')
    .replace(LABELED_SECRET, `$1${REDACTED}`)
    .replace(V1_SIGNATURE, `v1=${REDACTED}`)
    .replace(MOBILE_NUMBER, '$1****$2')
    .replace(RAW_OPEN_ID, REDACTED)
}

/**
 * Mask known sensitive values while preserving JSON structure.
 * @param value - JSON-compatible value about to be logged or audited.
 * @returns a detached copy with sensitive fields and strings masked.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(child)
    }
    return out
  }
  return value
}
