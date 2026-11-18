import { describe, expect, it } from 'vitest'
import type { NotificationChannel } from '@deepseek-ai/dsh-nilm-sentinel'
import { DeliveryFailureError, type ChannelTransport } from '../src/channels.ts'
import { NotificationDispatcher, failureOf } from '../src/dispatcher.ts'
import type { DeliveryResult, OutboxTask } from '../src/model.ts'
import { MemoryOutboxStore } from './memory-store.ts'

function transport(
  channel: NotificationChannel,
  send: (task: OutboxTask) => Promise<DeliveryResult>,
): ChannelTransport {
  return { channel, send: task => send(task) }
}

function allTransports(send: (task: OutboxTask) => Promise<DeliveryResult>): ReadonlyMap<NotificationChannel, ChannelTransport> {
  return new Map((['wx_subscribe', 'wx_template', 'wecom_webhook', 'sms'] as const)
    .map(channel => [channel, transport(channel, send)]))
}

describe('notification dispatcher', () => {
  it('marks a delivered alert sent, records it, and advances the event', async () => {
    const store = new MemoryOutboxStore()
    const task = store.addTask({ eventId: 'alert_1' })
    store.seedEvent('alert_1')
    const dispatcher = new NotificationDispatcher({
      store,
      transports: allTransports(async () => ({ providerMessageId: 'provider-1' })),
      workerId: 'worker-1',
      sendTimeoutMs: 1_000,
      now: () => 1_000,
    })

    await expect(dispatcher.tick()).resolves.toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 })

    expect(store.tasks[0]!.status).toBe('sent')
    expect(store.tasks[0]!.attemptCount).toBe(1)
    expect(store.records).toEqual([{
      tenantId: 'tenant-a',
      notificationId: task.notificationId,
      channel: 'sms',
      status: 'sent',
      createdAtMs: 1_000,
      providerMessageId: 'provider-1',
    }])
    expect(store.events.get('tenant-a\nalert_1')!.status).toBe('notified')
  })

  it('schedules a transient failure at the table delay', async () => {
    const store = new MemoryOutboxStore()
    store.addTask()
    const dispatcher = new NotificationDispatcher({
      store,
      transports: allTransports(async () => {
        throw new DeliveryFailureError({ code: 'gateway_503', retryable: true })
      }),
      workerId: 'worker-1',
      now: () => 5_000,
    })

    await expect(dispatcher.tick()).resolves.toEqual({ claimed: 1, sent: 0, failed: 1, dead: 0 })

    expect(store.tasks[0]!.status).toBe('failed')
    expect(store.tasks[0]!.nextRetryAtMs).toBe(65_000)
    expect(store.tasks[0]!.lastError).toBe('gateway_503')
  })

  it('dead-letters a permanent failure immediately', async () => {
    const store = new MemoryOutboxStore()
    store.addTask()
    const dispatcher = new NotificationDispatcher({
      store,
      transports: allTransports(async () => {
        throw new DeliveryFailureError({ code: 'gateway_400', retryable: false })
      }),
      workerId: 'worker-1',
      now: () => 5_000,
    })

    await expect(dispatcher.tick()).resolves.toEqual({ claimed: 1, sent: 0, failed: 0, dead: 1 })

    expect(store.tasks[0]!.status).toBe('dead')
    expect(store.tasks[0]!.nextRetryAtMs).toBe(5_000)
  })

  it('claims each row once across concurrent workers', async () => {
    const store = new MemoryOutboxStore()
    for (let index = 0; index < 100; index += 1) store.addTask({ id: index + 1 })
    const send = async (): Promise<DeliveryResult> => ({ providerMessageId: 'p' })
    const dispatchers = [1, 2, 3, 4, 5].map(worker => new NotificationDispatcher({
      store,
      transports: allTransports(send),
      workerId: `worker-${String(worker)}`,
      batchSize: 20,
      now: () => 1_000,
    }))

    const results = await Promise.all(dispatchers.map(item => item.tick()))

    expect(results.reduce((sum, item) => sum + item.claimed, 0)).toBe(100)
    expect(results.reduce((sum, item) => sum + item.sent, 0)).toBe(100)
    expect(store.claims).toBe(5)
    expect(store.tasks.every(task => task.status === 'sent')).toBe(true)
    expect(new Set(store.tasks.map(task => task.attemptCount))).toEqual(new Set([1]))
  })

  it('reclaims a row whose lease expired', async () => {
    const store = new MemoryOutboxStore()
    store.addTask({ status: 'sending', claimedBy: 'dead-worker', attemptCount: 1, leaseExpiresAtMs: 1_000 })
    const dispatcher = new NotificationDispatcher({
      store,
      transports: allTransports(async () => ({ providerMessageId: 'p' })),
      workerId: 'worker-2',
      now: () => 2_000,
    })

    await expect(dispatcher.tick()).resolves.toEqual({ claimed: 1, sent: 1, failed: 0, dead: 0 })
    expect(store.tasks[0]!.claimedBy).toBe('worker-2')
    expect(store.tasks[0]!.attemptCount).toBe(2)
  })

  it('dead-letters a channel with no configured transport', async () => {
    const store = new MemoryOutboxStore()
    store.addTask()
    const dispatcher = new NotificationDispatcher({
      store,
      transports: new Map(),
      workerId: 'worker-1',
      now: () => 1_000,
    })

    await expect(dispatcher.tick()).resolves.toEqual({ claimed: 1, sent: 0, failed: 0, dead: 1 })
    expect(store.tasks[0]!.lastError).toBe('channel_not_configured')
  })
})

describe('delivery failure classification', () => {
  it('keeps typed gateway failures', () => {
    expect(failureOf(new DeliveryFailureError({ code: 'gateway_429', retryable: true })))
      .toEqual({ code: 'gateway_429', retryable: true })
  })

  it('treats timeouts and unknown failures as transient', () => {
    expect(failureOf(new DOMException('timed out', 'TimeoutError'))).toMatchObject({ code: 'channel_timeout', retryable: true })
    expect(failureOf(new Error('socket closed'))).toMatchObject({ code: 'channel_unavailable', retryable: true })
  })
})
