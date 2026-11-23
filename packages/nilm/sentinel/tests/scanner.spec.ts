import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import NilmSentinelService, {
  resolveConfig,
  type AlertCreatedPayload,
  type AlertRuleRow,
  type ApplianceSignal,
  type IncrementalUnsafeSource,
  type PowerSignal,
  type RecipientRef,
  type RecipientPolicy,
  type RuleSignalProvider,
  type TenantPolicy,
  type UnsafeRecordRow,
  type Watermark,
} from '../src/index.ts'
import type { PhaseCurrents, PhaseVoltages } from '../src/rules.ts'
import { MemorySentinelStore } from './memory-store.ts'

const T0 = Date.UTC(2026, 10, 18, 2, 0, 0)
const contexts: Context[] = []

class FakeUnsafeSource implements IncrementalUnsafeSource {
  readonly rows: UnsafeRecordRow[] = []

  async head(): Promise<Watermark | undefined> {
    const last = this.rows[this.rows.length - 1]
    return last === undefined ? undefined : { recordTimeMs: timeOf(last), recordId: last.recordId }
  }

  async readAfter(after: Watermark, limit: number, offset = 0): Promise<UnsafeRecordRow[]> {
    return this.rows
      .filter((row) => {
        const time = timeOf(row)
        return Number.isNaN(time) || time > after.recordTimeMs || (time === after.recordTimeMs && row.recordId > after.recordId)
      })
      .slice(Math.max(0, offset))
      .slice(0, limit)
  }
}

class FakeRecipients implements RecipientPolicy {
  calls = 0

  constructor(private readonly targets: readonly RecipientRef[] = [
    { userRef: 'user-1', channel: 'sms', masked: '138****0000' },
  ]) {}

  async resolve(): Promise<RecipientRef[]> {
    this.calls += 1
    return [...this.targets]
  }
}

class FakeSignals implements RuleSignalProvider {
  power: PowerSignal | undefined
  applianceList: ApplianceSignal[] = []

  async totalPower(): Promise<PowerSignal | undefined> {
    return this.power
  }

  async appliances(): Promise<ApplianceSignal[]> {
    return this.applianceList
  }

  async voltages(): Promise<{ voltages: PhaseVoltages; nominalVoltageV: number } | undefined> {
    return undefined
  }

  async currents(): Promise<PhaseCurrents | undefined> {
    return undefined
  }
}

function context(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function row(overrides: Partial<UnsafeRecordRow> = {}): UnsafeRecordRow {
  return {
    recordId: 'r1',
    recordTime: new Date(T0),
    terminalChannelId: 'channel-1',
    assetId: null,
    unsafeType: 'overload_single_power',
    unsafeDesc: '空压机额定功率超限',
    power: 12,
    current: 30,
    applianceName: '空压机',
    handlingStatus: 'pending',
    ...overrides,
  }
}

function timeOf(row: UnsafeRecordRow): number {
  return row.recordTime instanceof Date ? row.recordTime.getTime() : Date.parse(row.recordTime)
}

function tenant(): TenantPolicy {
  return {
    tenantId: 'tenant-a',
    tenantName: '工厂A',
    baselineKw: 5,
    nonWorkAlertMinutes: 10,
    workHours: [],
    notificationPolicy: { recipients: [] },
  }
}

function scope(tenantId = 'tenant-a'): { tenantId: string; scope: { level: 'channel'; id: string; name: string } } {
  return { tenantId, scope: { level: 'channel' as const, id: 'channel-1', name: '一号车间/总进线' } }
}

function setup(options: {
  rules?: AlertRuleRow[]
  now?: () => number
  recipients?: readonly RecipientRef[]
  shardIndex?: number
  shardCount?: number
  sourceId?: string
  sourceTenantId?: string
  batchSize?: number
  store?: MemorySentinelStore
  unsafe?: FakeUnsafeSource
} = {}): {
  service: NilmSentinelService
  store: MemorySentinelStore
  unsafe: FakeUnsafeSource
  signals: FakeSignals
  recipients: FakeRecipients
  events: AlertCreatedPayload[]
} {
  const ctx = context()
  const store = options.store ?? new MemorySentinelStore()
  const unsafe = options.unsafe ?? new FakeUnsafeSource()
  const signals = new FakeSignals()
  const recipients = new FakeRecipients(options.recipients)
  const sourceTenantId = options.sourceTenantId ?? 'upstream-a'
  store.tenants.set('tenant-a', tenant())
  store.rules.set('tenant-a', options.rules ?? [])
  store.scopes.set('channel-1', [scope()])
  if (options.sourceTenantId === undefined) store.sourceTenants.set(`upstream_unsafe\n${sourceTenantId}`, 'tenant-a')
  const events: AlertCreatedPayload[] = []
  ctx.on('nilm/alert/created', payload => { events.push(payload) })
  let counter = 0
  const service = new NilmSentinelService(ctx, {
    pollIntervalMs: 60_000,
    energyIntervalMs: 60 * 60_000,
    bucketMinutes: 5,
    templates: { sms: 'tpl-alert' },
    shardIndex: options.shardIndex ?? 0,
    shardCount: options.shardCount ?? 1,
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.sourceId === undefined ? {} : { sourceId: options.sourceId }),
    sourceTenantId,
  }, {
    store,
    unsafe,
    signals,
    recipients,
    now: options.now ?? (() => T0 + 60_000),
    newEventId: () => `alert_${String(++counter)}`,
    newNotificationId: () => `notif_${String(counter)}`,
  })
  return { service, store, unsafe, signals, recipients, events }
}

describe('incremental safety scan', () => {
  it('bootstraps the watermark at the current head without replaying history', async () => {
    const fixture = setup()
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 0, inserted: 0 })
    expect(fixture.store.events).toHaveLength(0)
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r0')
  })

  it('requires a configured source tenant', () => {
    expect(() => resolveConfig({})).toThrow('sourceTenantId is required')
  })

  it('delivers a dual-owned node only to the tenant mapped from the upstream source tenant', async () => {
    const fixture = setup({ rules: [ruleRow()], sourceTenantId: 'upstream-a' })
    fixture.store.tenants.set('tenant-b', { ...tenant(), tenantId: 'tenant-b', tenantName: '工厂B' })
    fixture.store.scopes.set('channel-1', [scope('tenant-a'), scope('tenant-b')])
    fixture.store.sourceTenants.set('upstream_unsafe\nupstream-a', 'tenant-a')
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))

    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events.map(event => event.tenantId)).toEqual(['tenant-a'])
    expect(fixture.store.outbox.map(item => item.tenantId)).toEqual(['tenant-a'])
  })

  it('refuses upstream rows when the configured source tenant has no mapping', async () => {
    const fixture = setup({ rules: [ruleRow()], sourceTenantId: 'upstream-unknown' })
    fixture.store.sourceTenants.set('upstream_unsafe\nupstream-unknown', 'tenant-a')
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r0')
    fixture.store.sourceTenants.delete('upstream_unsafe\nupstream-unknown')
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))

    expect(await fixture.service.scanOnce()).toEqual({ read: 0, inserted: 0 })
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r0')
    expect(fixture.store.events).toHaveLength(0)
    expect(fixture.store.outbox).toHaveLength(0)

    fixture.store.sourceTenants.set('upstream_unsafe\nupstream-unknown', 'tenant-a')
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r1')
  })

  it('does not bootstrap a NaN watermark from a poisoned head row', async () => {
    const fixture = setup()
    fixture.unsafe.rows.push(row({ recordId: 'bad-head', recordTime: 'not-a-date' }))

    await fixture.service.scanOnce()
    const watermark = fixture.store.watermarks.get('upstream_unsafe')
    expect(Number.isFinite(watermark?.recordTimeMs)).toBe(true)
    expect(watermark?.recordId).toBe('')
  })

  it('skips a poison timestamp and still processes later rows', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(
      row({ recordId: 'bad', recordTime: 'not-a-date' }),
      row({ recordId: 'r2', recordTime: new Date(T0 + 2_000) }),
    )

    expect(await fixture.service.scanOnce()).toEqual({ read: 2, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r2')
  })

  it('keeps an all-invalid batch from corrupting the watermark', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(
      row({ recordId: 'bad-1', recordTime: 'not-a-date' }),
      row({ recordId: 'bad-2', recordTime: 'still-not-a-date' }),
    )

    expect(await fixture.service.scanOnce()).toEqual({ read: 2, inserted: 0 })
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r0')
  })

  it('dead-letters an all-invalid batch so later valid rows still process', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(
      row({ recordId: 'bad-1', recordTime: 'not-a-date' }),
      row({ recordId: 'bad-2', recordTime: 'still-not-a-date' }),
    )

    expect(await fixture.service.scanOnce()).toEqual({ read: 2, inserted: 0 })
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r0')

    fixture.unsafe.rows.push(row({ recordId: 'r3', recordTime: new Date(T0 + 3_000) }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('r3')
  })

  it('advances past more than the former dead-letter bound', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    for (let index = 0; index < 513; index += 1) {
      fixture.unsafe.rows.push(row({ recordId: `bad-${String(index).padStart(3, '0')}`, recordTime: 'not-a-date' }))
    }
    fixture.unsafe.rows.push(row({ recordId: 'valid', recordTime: new Date(T0 + 2_000) }))

    expect(await fixture.service.scanOnce()).toEqual({ read: 514, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.watermarks.get('upstream_unsafe')?.recordId).toBe('valid')
  })

  it('resumes a poison-prefix walk from the persisted offset after a restart', async () => {
    const store = new MemorySentinelStore()
    const unsafe = new FakeUnsafeSource()
    const first = setup({ rules: [ruleRow()], batchSize: 2, store, unsafe })
    unsafe.rows.push(row({ recordId: 'r0' }))
    await first.service.scanOnce()
    // 24 poison rows: the final batch after a restart is the lone valid row, which
    // ends the pass without re-reading the prefix the fake source keeps returning.
    for (let index = 0; index < 24; index += 1) {
      unsafe.rows.push(row({ recordId: `bad-${String(index).padStart(2, '0')}`, recordTime: 'not-a-date' }))
    }
    unsafe.rows.push(row({ recordId: 'valid', recordTime: new Date(T0 + 2_000) }))

    // One pass is capped at 10 batches of 2 rows, so it stops inside the prefix.
    expect(await first.service.scanOnce()).toEqual({ read: 20, inserted: 0 })
    expect(store.watermarks.get('upstream_unsafe')).toMatchObject({ recordId: 'r0', scanOffset: 20 })

    // A fresh instance over the same store reads only the 4 unexamined poison rows plus the valid row.
    const restarted = setup({ rules: [ruleRow()], batchSize: 2, store, unsafe })
    expect(await restarted.service.scanOnce()).toEqual({ read: 5, inserted: 1 })
    expect(store.events).toHaveLength(1)
    expect(store.watermarks.get('upstream_unsafe')).toMatchObject({ recordId: 'valid', scanOffset: 0 })
  })

  it('does not scan upstream on a non-zero shard', async () => {
    const fixture = setup({ rules: [ruleRow()], shardIndex: 1, shardCount: 4 })
    fixture.unsafe.rows.push(row({ recordId: 'r1' }))

    expect(await fixture.service.scanOnce()).toEqual({ read: 0, inserted: 0 })
    expect(fixture.store.watermarks.size).toBe(0)
    expect(fixture.store.events).toHaveLength(0)
  })

  it('rejects a shard index outside the configured shard count', () => {
    expect(() => resolveConfig({ shardIndex: 4, shardCount: 4 })).toThrow('shardIndex must be less than shardCount')
  })

  it('writes the alert event and Outbox in one store call and emits the enrich payload', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.events[0]).toMatchObject({ severity: 'critical', status: 'confirmed', ruleId: 'R-03' })
    expect(fixture.store.outbox).toHaveLength(1)
    expect(fixture.recipients.calls).toBe(1)
    expect(fixture.events).toHaveLength(1)
    expect(fixture.events[0]).toMatchObject({ tenantId: 'tenant-a', ruleId: 'R-03', metric: 'unsafe_overload_power_kw' })
  })

  it('enqueues one alert row per recipient on the same channel', async () => {
    const fixture = setup({
      rules: [ruleRow()],
      recipients: [
        { userRef: 'user-1', channel: 'sms', masked: '138****0000' },
        { userRef: 'user-2', channel: 'sms', masked: '139****0000' },
      ],
    })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.outbox).toHaveLength(2)
    expect(new Set(fixture.store.outbox.map(item => item.userRef))).toEqual(new Set(['user-1', 'user-2']))
  })

  it('keeps every bucket row but collapses a duplicate de-duplication key', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(
      row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }),
      row({ recordId: 'r2', recordTime: new Date(T0 + 2_000) }),
    )
    expect(await fixture.service.scanOnce()).toEqual({ read: 2, inserted: 1 })
    expect(fixture.store.events).toHaveLength(1)
    expect(fixture.store.outbox).toHaveLength(1)
  })

  it('suppresses a repeated warning inside the silence window while retaining the bucket event', async () => {
    const fixture = setup({ rules: [ruleRow({ silentMinutes: 30 })], now: () => T0 + 6 * 60_000 })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({
      recordId: 'r1',
      recordTime: new Date(T0 + 1_000),
      unsafeType: 'voltage_deviation',
      power: null,
      current: null,
    }))
    await fixture.service.scanOnce()
    fixture.store.outbox[0]!.sentAtMs = T0 + 1_000
    fixture.unsafe.rows.push(row({
      recordId: 'r2',
      recordTime: new Date(T0 + 5 * 60_000 + 1_000),
      unsafeType: 'voltage_deviation',
      power: null,
      current: null,
    }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events).toHaveLength(2)
    expect(fixture.store.events[1]).toMatchObject({ status: 'suppressed' })
    expect(fixture.store.outbox).toHaveLength(1)
  })

  it('delivers a safety alert that bypasses the silence window', async () => {
    const fixture = setup({ rules: [ruleRow({ silentMinutes: 30 })], now: () => T0 + 6 * 60_000 })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))
    await fixture.service.scanOnce()
    fixture.store.outbox[0]!.sentAtMs = T0 + 1_000
    fixture.unsafe.rows.push(row({ recordId: 'r2', recordTime: new Date(T0 + 5 * 60_000 + 1_000) }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 1 })
    expect(fixture.store.events).toHaveLength(2)
    expect(fixture.store.outbox).toHaveLength(2)
  })

  it('ignores an unconfirmed upstream type instead of guessing a rule', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000), unsafeType: 'unconfirmed_future_type' }))
    expect(await fixture.service.scanOnce()).toEqual({ read: 1, inserted: 0 })
    expect(fixture.store.events).toHaveLength(0)
  })
})

describe('alert API', () => {
  it('lists only alerts visible to the receiving user and acknowledges them once', async () => {
    const fixture = setup({ rules: [ruleRow()] })
    fixture.unsafe.rows.push(row({ recordId: 'r0' }))
    await fixture.service.scanOnce()
    fixture.unsafe.rows.push(row({ recordId: 'r1', recordTime: new Date(T0 + 1_000) }))
    await fixture.service.scanOnce()
    const page = await fixture.service.alerts({ tenantId: 'tenant-a', userRef: 'user-1' })
    expect(page.total).toBe(1)
    expect(page.alerts[0]?.finding).toContain('额定功率超限')
    expect(await fixture.service.acknowledge({ tenantId: 'tenant-a', userRef: 'user-1' }, page.alerts[0]!.id))
      .toBe('acknowledged')
    expect(await fixture.service.acknowledge({ tenantId: 'tenant-a', userRef: 'user-1' }, page.alerts[0]!.id))
      .toBe('already-final')
  })
})

function ruleRow(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    tenantId: 'tenant-a',
    ruleId: 'R-03',
    ruleType: 'overload',
    scope: { level: 'channel', id: 'channel-1', name: '一号车间/总进线' },
    thresholds: { overloadRatio: 1.1 },
    severity: 'warning',
    silentMinutes: 10,
    channels: ['sms'],
    version: 1,
    ...overrides,
  }
}
