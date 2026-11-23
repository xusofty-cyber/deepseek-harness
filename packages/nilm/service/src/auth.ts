/**
 * Caller authentication for the NILM BFF: HMAC request envelope, clock skew,
 * nonce replay protection, and allowed-scope parsing.
 * @module @deepseek-ai/dsh-nilm-service/auth
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { brandString } from '@deepseek-ai/dsh-brand'
import {
  NilmError,
  type NilmErrorCode,
  type ScopeLevel,
  type ScopeTarget,
  type TenantId,
} from '@deepseek-ai/dsh-nilm-core'

/** One authenticated caller before the BFF assigns a session identity. */
export interface VerifiedCaller {
  readonly tenantId: TenantId
  readonly userRef: string
  readonly allowedScope?: readonly ScopeTarget[]
  readonly requestId: string
}

/** Failure from caller authentication or scope decoding. */
export class AuthError extends NilmError {
  /**
   * @param code - stable NILM error code.
   * @param message - caller-safe message.
   * @param status - HTTP status the BFF should return.
   */
  constructor(code: NilmErrorCode, message: string, readonly status: 400 | 401) {
    super(code, message)
  }
}

/**
 * Process-local nonce cache. Replicas do not share entries; a multi-replica
 * deployment must inject a shared implementation before relying on global replay protection.
 */
export class NonceStore {
  private readonly seen = new Map<string, number>()

  /**
   * Record one nonce when it has not been observed inside the retention window.
   * @param tenantId - tenant whose caller issued the nonce.
   * @param nonce - caller-generated nonce.
   * @param nowMs - current epoch milliseconds.
   * @param ttlMs - retention window.
   * @returns true when the nonce is fresh.
   */
  accept(tenantId: string, nonce: string, nowMs: number, ttlMs: number): boolean {
    this.prune(nowMs)
    const key = `${tenantId}\n${nonce}`
    const expiresAt = this.seen.get(key)
    if (expiresAt !== undefined && expiresAt > nowMs) return false
    this.seen.set(key, nowMs + ttlMs)
    return true
  }

  private prune(nowMs: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) this.seen.delete(key)
    }
  }
}

/** Inputs needed to authenticate one HTTP request. */
export interface VerifyRequestInput {
  readonly method: string
  readonly path: string
  readonly headers: IncomingHttpHeaders
  readonly body: Buffer
  readonly nowMs: number
  readonly secrets: Readonly<Record<string, string>>
  readonly nonces: NonceStore
  readonly clockSkewMs: number
  readonly nonceTtlMs: number
}

/** Required context headers, in the order used by the canonical string. */
const REQUIRED_HEADERS = [
  'x-nilm-tenant-id',
  'x-nilm-user-ref',
  'x-nilm-request-id',
  'x-nilm-timestamp',
  'x-nilm-nonce',
  'x-nilm-signature',
] as const

/** `nilm_conversation.tenant_id` and `nilm_security_audit.tenant_id` column width. */
const MAX_TENANT_ID_CHARACTERS = 64

/** `nilm_conversation.user_ref` and `nilm_security_audit.user_ref` column width. */
const MAX_USER_REF_CHARACTERS = 64

/** Upper bound that keeps audit values and structured log lines bounded. */
const MAX_REQUEST_ID_CHARACTERS = 128

const SCOPE_LEVELS = new Set<ScopeLevel>(['factory', 'workshop', 'terminal', 'channel', 'appliance'])
const SCOPE_KEYS = new Set(['level', 'id', 'name', 'path'])

/**
 * Build the exact canonical string signed by the caller.
 * @param method - HTTP method, upper-cased by the caller before signing.
 * @param path - request path without query parameters.
 * @param body - raw request body.
 * @param tenantId - caller tenant header.
 * @param userRef - caller user header.
 * @param allowedScopeB64 - raw allowed-scope header, or the empty string.
 * @param requestId - caller request correlation id.
 * @param timestamp - caller timestamp string.
 * @param nonce - caller nonce.
 * @returns the newline-delimited canonical string.
 */
export function canonicalRequest(
  method: string,
  path: string,
  body: Buffer,
  tenantId: string,
  userRef: string,
  allowedScopeB64: string,
  requestId: string,
  timestamp: string,
  nonce: string,
): string {
  const digest = createHash('sha256').update(body).digest('hex')
  return [method.toUpperCase(), path, digest, tenantId, userRef, allowedScopeB64, requestId, timestamp, nonce].join('\n')
}

/**
 * Produce the `X-Nilm-Signature` value for one request.
 * @param secret - caller secret.
 * @param canonical - exact canonical string.
 * @returns `v1=<lowercase hex>`.
 */
export function createSignature(secret: string, canonical: string): string {
  return `v1=${createHmac('sha256', secret).update(canonical).digest('hex')}`
}

/**
 * Authenticate one request and return its verified caller identity.
 * @param input - request bytes, headers, current time, and deployment secrets.
 * @returns the verified caller; scope is absent when the caller omitted the header.
 * @throws AuthError with 401 for authentication failures and 400 for invalid scope syntax.
 */
export function verifyRequest(input: VerifyRequestInput): VerifiedCaller {
  const { method, path, headers, body } = input
  if (!path.startsWith('/') || path.includes('?')) {
    throw new AuthError('INVALID_ARGUMENT', 'request path must be an absolute path without a query string', 400)
  }
  const values = new Map<string, string>()
  for (const name of REQUIRED_HEADERS) {
    const value = header(headers, name)
    if (value === undefined || value === '') {
      throw new AuthError('UNAUTHORIZED_TENANT', `missing required header ${name}`, 401)
    }
    values.set(name, value)
  }
  const tenantId = values.get('x-nilm-tenant-id') as string
  const userRef = values.get('x-nilm-user-ref') as string
  const requestId = values.get('x-nilm-request-id') as string
  const timestampText = values.get('x-nilm-timestamp') as string
  const nonce = values.get('x-nilm-nonce') as string
  const signature = values.get('x-nilm-signature') as string
  const allowedScopeB64 = header(headers, 'x-nilm-allowed-scope') ?? ''

  if (Array.from(tenantId).length > MAX_TENANT_ID_CHARACTERS) {
    throw new AuthError('UNAUTHORIZED_TENANT', `tenant header exceeds ${String(MAX_TENANT_ID_CHARACTERS)} characters`, 401)
  }
  if (Array.from(userRef).length > MAX_USER_REF_CHARACTERS) {
    throw new AuthError('UNAUTHORIZED_TENANT', `user header exceeds ${String(MAX_USER_REF_CHARACTERS)} characters`, 401)
  }
  if (Array.from(requestId).length > MAX_REQUEST_ID_CHARACTERS) {
    throw new AuthError('INVALID_ARGUMENT', `request id exceeds ${String(MAX_REQUEST_ID_CHARACTERS)} characters`, 400)
  }

  const timestamp = Number(timestampText)
  if (!Number.isSafeInteger(timestamp) || Math.abs(input.nowMs - timestamp) > input.clockSkewMs) {
    throw new AuthError('UNAUTHORIZED_TENANT', 'request timestamp is outside the accepted window', 401)
  }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(nonce)) {
    throw new AuthError('UNAUTHORIZED_TENANT', 'request nonce is malformed', 401)
  }
  const secret = input.secrets[tenantId]
  if (secret === undefined) throw new AuthError('UNAUTHORIZED_TENANT', 'caller is not authorized', 401)
  const canonical = canonicalRequest(
    method,
    path,
    body,
    tenantId,
    userRef,
    allowedScopeB64,
    requestId,
    timestampText,
    nonce,
  )
  const expected = createSignature(secret, canonical)
  const given = Buffer.from(signature, 'utf8')
  const wanted = Buffer.from(expected, 'utf8')
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new AuthError('UNAUTHORIZED_TENANT', 'signature verification failed', 401)
  }
  if (!input.nonces.accept(tenantId, nonce, input.nowMs, input.nonceTtlMs)) {
    throw new AuthError('UNAUTHORIZED_TENANT', 'request nonce was already used', 401)
  }
  const allowedScope = allowedScopeB64 === '' ? undefined : parseAllowedScope(allowedScopeB64)
  return {
    tenantId: brandString<TenantId>(tenantId),
    userRef,
    requestId,
    ...(allowedScope === undefined ? {} : { allowedScope }),
  }
}

/**
 * Decode and validate the base64url(JSON) allowed-scope header.
 * @param encoded - caller-supplied header value.
 * @returns a detached scope list; an empty array delegates no scope.
 * @throws AuthError when the payload is malformed or exceeds the candidate bound.
 */
export function parseAllowedScope(encoded: string): readonly ScopeTarget[] {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new AuthError('INVALID_ARGUMENT', 'allowed scope is not valid base64url JSON', 400)
  }
  if (!Array.isArray(value) || value.length > 100) {
    throw new AuthError('INVALID_ARGUMENT', 'allowed scope must be an array of at most 100 targets', 400)
  }
  return value.map((entry): ScopeTarget => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new AuthError('INVALID_ARGUMENT', 'each allowed scope target must be an object', 400)
    }
    const record = entry as Record<string, unknown>
    if (Object.keys(record).some(key => !SCOPE_KEYS.has(key))) {
      throw new AuthError('INVALID_ARGUMENT', 'allowed scope target has an unknown field', 400)
    }
    const level = record.level
    if (typeof level !== 'string' || !SCOPE_LEVELS.has(level as ScopeLevel)) {
      throw new AuthError('INVALID_ARGUMENT', 'allowed scope target has an invalid level', 400)
    }
    const fields: string[] = []
    for (const [key, candidate] of Object.entries(record)) {
      if (key === 'level') continue
      if (typeof candidate !== 'string' || candidate.trim() === '') {
        throw new AuthError('INVALID_ARGUMENT', `allowed scope ${key} must be a non-empty string`, 400)
      }
      fields.push(key)
    }
    if (fields.length === 0) {
      throw new AuthError('INVALID_ARGUMENT', 'allowed scope target requires an id, name, or path', 400)
    }
    const target: ScopeTarget = { level: level as ScopeLevel }
    if (typeof record.id === 'string') target.id = record.id
    if (typeof record.name === 'string') target.name = record.name
    if (typeof record.path === 'string') target.path = record.path
    return target
  })
}

/** Read one header, rejecting duplicate values that would make signing ambiguous. */
function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const direct = headers[name]
  if (Array.isArray(direct)) {
    if (direct.length !== 1) throw new AuthError('UNAUTHORIZED_TENANT', `duplicate header ${name}`, 401)
    return direct[0]
  }
  if (direct !== undefined) return direct
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (Array.isArray(value)) {
      if (value.length !== 1) throw new AuthError('UNAUTHORIZED_TENANT', `duplicate header ${name}`, 401)
      return value[0]
    }
    return value
  }
  return undefined
}
