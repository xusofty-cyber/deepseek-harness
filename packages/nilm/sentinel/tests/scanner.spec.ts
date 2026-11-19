import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import NilmSentinelService, {
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

  async readAfter(after: Watermark, limit: number): Promise<UnsafeRecordRow[]> {
    return this.rows
      .filter(row => timeOf(row) > after.recordTimeMs || (timeOf(row) === after.recordTimeMs && row.recordId > after.recordId))
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

function scope(): { tenantId: string; scope: { level: 'channel'; id: string; name: string } } {
  return { tenantId: 'tenant-a', scope: { level: 'channel' as const, id: 'channel-1', name: '一号车间/总进线' } }
}

function setup(options: { rules?: AlertRuleRow[]; now?: () => number; recipients?: readonly RecipientRef[] } = {}): {
  service: NilmSentinelService
  store: MemorySentinelStore
  unsafe: FakeUnsafeSource
  signals: FakeSignals
  recipients: FakeRecipients
  events: AlertCreatedPayload[]
} {
  const ctx = context()
  const store = new MemorySentinelStore()
  const unsafe = new FakeUnsafeSource()
  const signals = new FakeSignals()
  const recipients = new FakeRecipients(options.recipients)
  store.tenants.set('tenant-a', tenant())
  store.rules.set('tenant-a', options.rules ?? [])
  store.scopes.set('channel-1', [scope()])
  const events: AlertCreatedPayload[] = []
  ctx.on('nilm/alert/created', payload => { events.push(payload) })
  let counter = 0
  const service = new NilmSentinelService(ctx, {
    pollIntervalMs: 60_000,
    energyIntervalMs: 60 * 60_000,
    bucketMinutes: 5,
    templates: { sms: 'tpl-alert' },
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
