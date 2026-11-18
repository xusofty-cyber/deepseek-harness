import { describe, expect, it } from 'vitest'
import { DeliveryFailureError, GatewayChannelTransport, buildTransports } from '../src/channels.ts'
import type { OutboxTask } from '../src/model.ts'

function task(overrides: Partial<OutboxTask> = {}): OutboxTask {
  return {
    id: 1,
    notificationId: 'notif-1',
    tenantId: 'tenant-a',
    userRef: 'user-1',
    eventId: 'alert-1',
    channel: 'sms',
    templateId: 'tpl-1',
    recipientCiphertext: Uint8Array.from(Buffer.from('13800138000', 'utf8')),
    recipientMasked: '138****8000',
    payloadJson: '{"summary":"夜间基载偏高"}',
    dedupeKey: 'dedupe-1',
    attemptCount: 1,
    maxAttempts: 5,
    claimedBy: 'worker-1',
    ...overrides,
  }
}

describe('gateway channel transport', () => {
  it('posts deterministic template parameters and only encrypted recipient material', async () => {
    let captured: { url: string; init: RequestInit } | undefined
    const transport = new GatewayChannelTransport('sms', 'https://gateway.test/send', 'token-1', async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ messageId: 'msg-9' }), { status: 200 })
    })

    await expect(transport.send(task())).resolves.toEqual({ providerMessageId: 'msg-9' })

    expect(captured!.url).toBe('https://gateway.test/send')
    expect(captured!.init.method).toBe('POST')
    expect((captured!.init.headers as Record<string, string>).authorization).toBe('Bearer token-1')
    const body = captured!.init.body as string
    expect(body).not.toContain('13800138000')
    expect(body).toContain(Buffer.from('13800138000', 'utf8').toString('base64'))
    expect(JSON.parse(body)).toMatchObject({
      channel: 'sms',
      notificationId: 'notif-1',
      templateId: 'tpl-1',
      userRef: 'user-1',
      recipientMasked: '138****8000',
      payload: { summary: '夜间基载偏高' },
    })
  })

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
  ])('classifies HTTP %i as retryable=%s', async (status, retryable) => {
    const transport = new GatewayChannelTransport('sms', 'https://gateway.test/send', undefined,
      async () => new Response('', { status }))

    await expect(transport.send(task())).rejects.toMatchObject({
      name: 'DeliveryFailureError',
      failure: { code: `gateway_${String(status)}`, retryable },
    })
  })

  it('rejects a corrupt stored payload without calling the gateway', async () => {
    let called = false
    const transport = new GatewayChannelTransport('sms', 'https://gateway.test/send', undefined, async () => {
      called = true
      return new Response('')
    })

    await expect(transport.send(task({ payloadJson: '{not-json' }))).rejects.toBeInstanceOf(DeliveryFailureError)
    expect(called).toBe(false)
  })

  it('builds unconfigured transports for channels without an endpoint', async () => {
    const transports = buildTransports({ sms: { endpoint: 'https://gateway.test/sms' } })

    expect(transports.size).toBe(4)
    await expect(transports.get('wecom_webhook')!.send(task({ channel: 'wecom_webhook' })))
      .rejects.toMatchObject({ failure: { code: 'channel_not_configured', retryable: false } })
  })
})
