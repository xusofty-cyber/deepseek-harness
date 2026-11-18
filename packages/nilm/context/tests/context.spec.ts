import { brandString } from '@deepseek-ai/dsh-brand'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { NilmToolError, type CallContext, type SessionId, type TenantId } from '@deepseek-ai/dsh-nilm-core'
import NilmContextService from '../src/index.ts'

const contexts: Context[] = []

function setup(): NilmContextService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NilmContextService(ctx)
}

function callContext(tenant = 'tenant-a'): CallContext {
  return {
    tenantId: brandString<TenantId>(tenant),
    userRef: 'user-1',
    allowedScope: [{ level: 'factory', id: 'factory-1' }],
    requestId: 'request-1',
    sessionId: brandString<SessionId>('session-1'),
  }
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('NilmContextService', () => {
  it('binds and requires an immutable caller context', () => {
    const service = setup()
    service.bind('agent-1', callContext())
    const bound = service.require('agent-1')
    expect(bound.tenantId).toBe('tenant-a')
    expect(Object.isFrozen(bound)).toBe(true)
    expect(Object.isFrozen(bound.allowedScope)).toBe(true)
  })

  it('rejects lookups before binding and after revoke', () => {
    const service = setup()
    expect(() => service.require('agent-1')).toThrow(NilmToolError)
    service.bind('agent-1', callContext())
    service.revoke('agent-1')
    service.revoke('agent-1')
    let thrown: unknown
    try { service.require('agent-1') } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(NilmToolError)
    expect((thrown as NilmToolError).code).toBe('TENANT_CONTEXT_UNAVAILABLE')
  })

  it('does not let a stale disposer revoke a replacement binding', () => {
    const service = setup()
    const dispose = service.bind('agent-1', callContext('tenant-a'))
    service.bind('agent-1', callContext('tenant-b'))
    dispose()
    expect(service.require('agent-1').tenantId).toBe('tenant-b')
  })
})
