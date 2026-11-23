import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import NilmSourceService, {
  type Config,
  type SourceDependencies,
  type SqlExecutor,
  type TdengineExecutor,
} from '../src/index.ts'

const config: Config = {
  localMysql: { host: 'local', port: 3306, user: 'local', password: 'secret', database: 'nilm_system' },
  upstreamMysql: { host: 'upstream', port: 3306, user: 'readonly', password: 'secret', database: 'tpim_system' },
  tdengineHotUrl: 'http://hot/rest/sql/tpim_system',
  tdengineStatsUrl: 'http://stats/rest/sql/tpim_system',
  coldProxyUrl: 'http://cold/query',
  mysqlConnectionLimit: 4,
  tdengineTimeoutMs: 100,
  coldProxyTimeoutMs: 100,
  probeTimeoutMs: 1000,
}

const contexts: Context[] = []

function executor(rows: unknown[] = []): SqlExecutor & { calls: Array<{ sql: string; params: readonly unknown[] }> } {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = []
  return {
    calls,
    query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params })
      return Promise.resolve(rows as T[])
    },
    close: () => Promise.resolve(),
  }
}

function allLocalTables(): Array<{ tableName: string }> {
  return [
    'nilm_tenant_config', 'nilm_asset_snapshot', 'nilm_source_tenant_map', 'nilm_measurement_binding', 'nilm_conversation',
    'nilm_turn_log', 'nilm_security_audit', 'nilm_alert_rule', 'nilm_alert_event', 'nilm_alert_transition',
    'nilm_notification_outbox', 'nilm_notification_record', 'nilm_sentinel_watermark', 'nilm_job_run', 'nilm_report', 'nilm_tariff_plan',
    'nilm_tariff_period', 'nilm_calendar_day', 'nilm_pf_policy',
  ].map(tableName => ({ tableName }))
}

function tdengine(tables: string[]): TdengineExecutor {
  return { query: <T>() => Promise.resolve(tables.map(name => ({ table_name: name })) as T[]) }
}

function service(overrides: Partial<SourceDependencies> = {}): NilmSourceService {
  const ctx = new Context()
  contexts.push(ctx)
  return new NilmSourceService(ctx, config, {
    localMysql: executor(),
    upstreamMysql: executor(),
    tdengineHot: tdengine(['nilmdc_realtime_data', 'nilmdc_energy_data', 'nilmdc_appliance_identification']),
    tdengineStats: tdengine(['consum_energy_day_statistics_info']),
    coldProxyTransport: { request: () => Promise.resolve({ ok: true }) },
    ...overrides,
  })
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

describe('NilmSourceService', () => {
  it('guards both local and upstream reads before touching a driver', async () => {
    const upstream = executor()
    const source = service({ upstreamMysql: upstream })
    await expect(source.queryUpstreamReadOnly('INSERT INTO nilm_unsafe_record VALUES (?)', [])).rejects.toMatchObject({
      code: 'UNAUTHORIZED_SQL_OPERATION',
    })
    expect(upstream.calls).toHaveLength(0)
    await source.queryUpstreamReadOnly('SELECT record_id FROM nilm_unsafe_record WHERE record_time >= ?', [1])
    expect(upstream.calls).toHaveLength(1)
  })

  it('lists local tables through a parameterized metadata query', async () => {
    const local = executor([{ tableName: 'nilm_tenant_config' }])
    const source = service({ localMysql: local })
    const signal = new AbortController().signal
    await expect(source.listLocalTables(signal)).resolves.toEqual(['nilm_tenant_config'])
    expect(local.calls[0]?.params).toEqual(['nilm_system'])
  })

  it('passes every connectivity check within the aggregate budget', async () => {
    const source = service({ localMysql: executor(allLocalTables()) })
    const report = await source.probe()
    expect(report.ok).toBe(true)
    expect(report.checks.map(item => item.name)).toEqual([
      'local-mysql', 'upstream-mysql', 'tdengine-hot', 'tdengine-stats', 'cold-proxy',
    ])
    expect(report.durationMs).toBeLessThanOrEqual(config.probeTimeoutMs)
  })

  it('stops a non-cooperative check at the aggregate deadline', async () => {
    const hanging: SqlExecutor = {
      query: <T>() => new Promise<T[]>(() => {}),
      close: () => Promise.resolve(),
    }
    const ctx = new Context()
    contexts.push(ctx)
    const source = new NilmSourceService(ctx, { ...config, probeTimeoutMs: 10 }, {
      localMysql: hanging,
      upstreamMysql: executor(),
      tdengineHot: tdengine([]),
      tdengineStats: tdengine([]),
      coldProxyTransport: { request: () => Promise.resolve({ ok: true }) },
    })
    const report = await source.probe()
    expect(report.ok).toBe(false)
    expect(report.durationMs).toBeLessThan(500)
    expect(report.checks).toHaveLength(5)
    expect(report.checks.every(item => !item.ok)).toBe(true)
    expect(report.checks[0]?.detail).toContain('probe budget')
    expect(report.checks[1]?.detail).toContain('already exhausted')
  })

  it('reports every missing table and keeps a failing check visible', async () => {
    const source = service({
      localMysql: executor([]),
      tdengineHot: tdengine([]),
    })
    const report = await source.probe()
    const local = report.checks.find(item => item.name === 'local-mysql')
    const hot = report.checks.find(item => item.name === 'tdengine-hot')
    expect(report.ok).toBe(false)
    expect(local?.detail).toContain('missing tables')
    expect(hot?.detail).toContain('nilmdc_realtime_data')
  })

  it('rejects work after close', async () => {
    const source = service()
    await source.close()
    await source.close()
    await expect(source.queryLocalReadOnly('SELECT 1')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })
})
