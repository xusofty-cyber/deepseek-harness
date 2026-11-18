import { describe, expect, it } from 'vitest'
import type { AlertCreatedPayload } from '@deepseek-ai/dsh-nilm-sentinel'
import type { DiagnosisAgent } from '../src/enrich.ts'
import { EnrichmentWorker } from '../src/enrich.ts'
import type { DiagnosisResult } from '../src/store.ts'
import { MemoryOutboxStore } from './memory-store.ts'

function alert(eventId = 'alert_1'): AlertCreatedPayload {
  return {
    eventId,
    tenantId: 'tenant-a',
    ruleId: 'R-01b',
    severity: 'warning',
    scope: { level: 'terminal', id: 'terminal-1' },
    metric: 'night_base_load_kw',
    value: 42,
    threshold: 30,
    unit: 'kW',
    summaryText: '夜间基载偏高',
    occurredAtMs: 1_700_000_000_000,
    detectedAtMs: 1_700_000_060_000,
    facts: { nightHours: 3 },
  }
}

const diagnosis: DiagnosisResult = { text: '检查夜间保温设备', model: 'stub', promptVersion: 'v1' }

describe('alert enrichment', () => {
  it('applies a diagnosis inside the hard timeout', async () => {
    const store = new MemoryOutboxStore()
    store.seedEvent('alert_1')
    const agent: DiagnosisAgent = { diagnose: async () => diagnosis }
    const worker = new EnrichmentWorker({ store, agent, timeoutMs: 500, now: () => 9_000 })

    await expect(worker.run(alert())).resolves.toBe('applied')
    expect(store.events.get('tenant-a\nalert_1')!.diagnosis).toBe('检查夜间保温设备')
  })

  it('times out and drops a late model result', async () => {
    const store = new MemoryOutboxStore()
    store.seedEvent('alert_1')
    const agent: DiagnosisAgent = {
      diagnose: async () => {
        await new Promise(resolve => setTimeout(resolve, 80))
        return diagnosis
      },
    }
    const worker = new EnrichmentWorker({ store, agent, timeoutMs: 10 })

    await expect(worker.run(alert())).resolves.toBe('timeout')
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(store.events.get('tenant-a\nalert_1')!.diagnosis).toBeUndefined()
  })

  it('does not overwrite an acknowledged alert', async () => {
    const store = new MemoryOutboxStore()
    store.events.set('tenant-a\nalert_1', { tenantId: 'tenant-a', eventId: 'alert_1', status: 'acknowledged' })
    const worker = new EnrichmentWorker({ store, agent: { diagnose: async () => diagnosis } })

    await expect(worker.run(alert())).resolves.toBe('dropped-late')
    expect(store.events.get('tenant-a\nalert_1')!.diagnosis).toBeUndefined()
  })

  it('reports a failed agent without throwing', async () => {
    const store = new MemoryOutboxStore()
    store.seedEvent('alert_1')
    const warnings: string[] = []
    const worker = new EnrichmentWorker({
      store,
      agent: { diagnose: async () => { throw new Error('provider down') } },
      logger: { warn: message => warnings.push(message) },
    })

    await expect(worker.run(alert())).resolves.toBe('failed')
    expect(warnings[0]).toContain('provider down')
  })

  it('de-duplicates queued alerts and drains the queue', async () => {
    const store = new MemoryOutboxStore()
    store.seedEvent('alert_1')
    let calls = 0
    const worker = new EnrichmentWorker({
      store,
      agent: { diagnose: async () => { calls += 1; return diagnosis } },
      concurrency: 2,
    })

    worker.enqueue(alert('alert_1'))
    worker.enqueue(alert('alert_1'))
    await worker.waitForIdle()

    expect(calls).toBe(1)
  })
})
