import { describe, expect, it } from 'vitest'
import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import { ColdProxyClient, type ColdProxyTransport } from '../src/index.ts'

describe('ColdProxyClient', () => {
  it('sends the fixed template and bound parameters', async () => {
    const calls: unknown[] = []
    const transport: ColdProxyTransport = {
      request(request, signal) {
        calls.push({ request, aborted: signal.aborted })
        return Promise.resolve({ rows: [] })
      },
    }
    const client = new ColdProxyClient(transport, 50)
    await expect(client.query('daily_energy', { tenantId: 'tenant-a', days: 7 })).resolves.toEqual({ rows: [] })
    expect(calls).toEqual([{ request: { template: 'daily_energy', params: { tenantId: 'tenant-a', days: 7 } }, aborted: false }])
  })

  it('maps a timeout to COLD_LINK_UNAVAILABLE', async () => {
    const transport: ColdProxyTransport = {
      request: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }
    const client = new ColdProxyClient(transport, 10)
    await expect(client.query('health_check', {})).rejects.toMatchObject({
      name: 'NilmSourceError',
      code: 'COLD_LINK_UNAVAILABLE',
    })
  })

  it('preserves a typed proxy failure', async () => {
    const failure = new NilmSourceError('COLD_LINK_UNAVAILABLE', 'proxy unavailable')
    const client = new ColdProxyClient({ request: () => Promise.reject(failure) }, 50)
    await expect(client.query('health_check', {})).rejects.toBe(failure)
  })

  it('maps caller cancellation before the fixed timeout', async () => {
    const client = new ColdProxyClient({
      request: (_request, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }),
    }, 1000)
    const caller = new AbortController()
    const pending = client.query('health_check', {}, caller.signal)
    caller.abort()
    await expect(pending).rejects.toMatchObject({
      code: 'COLD_LINK_UNAVAILABLE',
      message: 'cold proxy request was cancelled',
    })
  })
})
