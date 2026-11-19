import { describe, expect, it } from 'vitest'
import type { IncomingHttpHeaders } from 'node:http'
import {
  AuthError,
  canonicalRequest,
  createSignature,
  NonceStore,
  verifyRequest,
} from '../src/auth.ts'

const NOW = Date.UTC(2026, 10, 18, 2, 0, 0)
const TENANT = 'tenant-a'
const SECRET = '0123456789abcdef0123456789abcdef'
const OTHER_SECRET = 'fedcba9876543210fedcba9876543210'
let nonceCounter = 0

function signed(
  method: string,
  path: string,
  body: Buffer,
  options: {
    tenantId?: string
    userRef?: string
    requestId?: string
    secret?: string
    timestamp?: string
    nonce?: string
    allowedScope?: string
    signature?: string
  } = {},
): { headers: IncomingHttpHeaders; body: Buffer } {
  const tenantId = options.tenantId ?? TENANT
  const userRef = options.userRef ?? 'user-1'
  const requestId = options.requestId ?? 'request-1'
  const secret = options.secret ?? SECRET
  const timestamp = options.timestamp ?? String(NOW)
  const nonce = options.nonce ?? `nonce-${String(++nonceCounter).padStart(8, '0')}`
  const allowedScope = options.allowedScope ?? ''
  const canonical = canonicalRequest(method, path, body, tenantId, userRef, allowedScope, requestId, timestamp, nonce)
  return {
    body,
    headers: {
      'x-nilm-tenant-id': tenantId,
      'x-nilm-user-ref': userRef,
      'x-nilm-request-id': requestId,
      'x-nilm-timestamp': timestamp,
      'x-nilm-nonce': nonce,
      'x-nilm-signature': options.signature ?? createSignature(secret, canonical),
      ...(allowedScope === '' ? {} : { 'x-nilm-allowed-scope': allowedScope }),
    },
  }
}

function verify(request: ReturnType<typeof signed>, nonces = new NonceStore()): ReturnType<typeof verifyRequest> {
  return verifyRequest({
    method: 'POST',
    path: '/v1/turns',
    headers: request.headers,
    body: request.body,
    nowMs: NOW,
    secrets: { [TENANT]: SECRET },
    nonces,
    clockSkewMs: 300_000,
    nonceTtlMs: 600_000,
  })
}

describe('NILM BFF caller envelope', () => {
  it('accepts a valid envelope and absent allowed scope', () => {
    const caller = verify(signed('POST', '/v1/turns', Buffer.from('{}')))
    expect(caller.tenantId).toBe(TENANT)
    expect(caller.userRef).toBe('user-1')
    expect(caller.requestId).toBe('request-1')
    expect(caller.allowedScope).toBeUndefined()
  })

  it('decodes a valid allowed scope', () => {
    const scope = Buffer.from(JSON.stringify([
      { level: 'workshop', id: 'ws-1' },
      { level: 'terminal', name: '一号终端' },
    ])).toString('base64url')
    const caller = verify(signed('POST', '/v1/turns', Buffer.from('{}'), { allowedScope: scope }))
    expect(caller.allowedScope).toEqual([
      { level: 'workshop', id: 'ws-1' },
      { level: 'terminal', name: '一号终端' },
    ])
  })

  it('rejects a body modified after signing', () => {
    const request = signed('POST', '/v1/turns', Buffer.from('{"content":"a"}'))
    request.body = Buffer.from('{"content":"b"}')
    expect(() => verify(request)).toThrow(AuthError)
  })

  it('rejects a timestamp outside the accepted window', () => {
    const request = signed('POST', '/v1/turns', Buffer.from('{}'), { timestamp: String(NOW - 300_001) })
    expect(() => verify(request)).toThrow('timestamp')
  })

  it('rejects a replayed nonce', () => {
    const nonces = new NonceStore()
    const request = signed('POST', '/v1/turns', Buffer.from('{}'))
    verify(request, nonces)
    expect(() => verify(request, nonces)).toThrow('nonce was already used')
  })

  it('rejects an unknown tenant without revealing whether the tenant exists', () => {
    const request = signed('POST', '/v1/turns', Buffer.from('{}'), { tenantId: 'tenant-unknown' })
    expect(() => verify(request)).toThrow('caller is not authorized')
  })

  it('rejects a signature produced with another secret', () => {
    const request = signed('POST', '/v1/turns', Buffer.from('{}'), { secret: OTHER_SECRET })
    expect(() => verify(request)).toThrow('signature verification failed')
  })

  it('rejects malformed allowed scope JSON', () => {
    const request = signed('POST', '/v1/turns', Buffer.from('{}'), { allowedScope: 'not-base64-json' })
    expect(() => verify(request)).toThrow('allowed scope')
  })

  it('rejects caller identifiers that exceed audit column widths', () => {
    const longTenant = signed('POST', '/v1/turns', Buffer.from('{}'), { tenantId: 't'.repeat(65) })
    expect(() => verify(longTenant)).toThrow('tenant header exceeds 64 characters')
    const longUser = signed('POST', '/v1/turns', Buffer.from('{}'), { userRef: 'u'.repeat(65) })
    expect(() => verify(longUser)).toThrow('user header exceeds 64 characters')
    const longRequest = signed('POST', '/v1/turns', Buffer.from('{}'), { requestId: 'r'.repeat(129) })
    expect(() => verify(longRequest)).toThrow('request id exceeds 128 characters')
  })
})
