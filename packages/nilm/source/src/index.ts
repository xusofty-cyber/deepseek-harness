/**
 * Read-only NILM source service: one guard and one connection policy per upstream.
 * @module @deepseek-ai/dsh-nilm-source
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { NilmSourceError, redactValue } from '@deepseek-ai/dsh-nilm-core'
import { Config } from './config.ts'
import { ColdProxyClient, HttpColdProxyTransport, type ColdProxyTransport } from './cold-proxy.ts'
import { MysqlExecutor, sourceUnavailable, type SqlExecutor } from './mysql.ts'
import {
  assertReadOnlySql,
  INFORMATION_SCHEMA_TABLES,
  NILM_LOCAL_TABLES,
  NILM_UPSTREAM_TABLES,
} from './sql-guard.ts'
import { HttpTdengineExecutor, type TdengineExecutor } from './tdengine.ts'
import { MysqlTransactionRunner, type SqlTransaction, type SqlTransactionRunner } from './transaction.ts'

export { Config, loadSourceConfigFromEnv, SOURCE_ENV } from './config.ts'
export type { MysqlEndpointConfig } from './config.ts'
export {
  assertReadOnlySql,
  INFORMATION_SCHEMA_TABLES,
  NILM_LOCAL_TABLES,
  NILM_UPSTREAM_TABLES,
} from './sql-guard.ts'
export { ColdProxyClient, HttpColdProxyTransport } from './cold-proxy.ts'
export type { ColdProxyTransport, ColdQueryRequest } from './cold-proxy.ts'
export { MysqlExecutor } from './mysql.ts'
export type { SqlExecutor } from './mysql.ts'
export { MysqlTransactionRunner } from './transaction.ts'
export type { SqlTransaction, SqlTransactionRunner } from './transaction.ts'
export { HttpTdengineExecutor } from './tdengine.ts'
export type { TdengineExecutor } from './tdengine.ts'

/** One read-only guard rejection; the original SQL never reaches the audit record. */
export interface SourceSecurityAuditEvent {
  /** Stable event class. */
  readonly type: 'sql.rejected'
  /** Guarded source that refused the statement. */
  readonly source: 'local' | 'upstream'
  /** Stable refusal code. */
  readonly code: 'UNAUTHORIZED_SQL_OPERATION'
}

/** Injectable transports used by tests and by alternate deployment drivers. */
export interface SourceDependencies {
  /** Project MySQL executor. */
  localMysql?: SqlExecutor
  /** Project MySQL transaction runner used by Sentinel and the Outbox dispatcher. */
  localTransactions?: SqlTransactionRunner
  /** Upstream read-only MySQL executor. */
  upstreamMysql?: SqlExecutor
  /** Hot TDengine executor. */
  tdengineHot?: TdengineExecutor
  /** Statistics TDengine executor. */
  tdengineStats?: TdengineExecutor
  /** Cold-proxy transport. */
  coldProxyTransport?: ColdProxyTransport
  /** Security audit sink; absent writes a redacted warning through the plugin logger. */
  securityAudit?: (event: SourceSecurityAuditEvent) => void
}

/** One named connectivity assertion. */
export interface ConnectivityCheck {
  /** Check name. */
  name: string
  /** Whether the check passed. */
  ok: boolean
  /** Failure detail or observed table names. */
  detail?: string
  /** Check duration in milliseconds. */
  durationMs: number
}

/** Aggregate result of the stage-0 connectivity gate. */
export interface ConnectivityReport {
  /** True when every check passed within the configured probe budget. */
  ok: boolean
  /** Total elapsed milliseconds. */
  durationMs: number
  /** Individual checks. */
  checks: ConnectivityCheck[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmSource: NilmSourceService
  }
}

/** Read-only source adapter. Holds no model, session, or business-computation state. */
export class NilmSourceService extends Service {
  /** Cordis config schema. */
  static Config = Config

  private readonly local: SqlExecutor
  private readonly localTransactions: SqlTransactionRunner
  private readonly upstream: SqlExecutor
  private readonly hot: TdengineExecutor
  private readonly stats: TdengineExecutor
  private readonly cold: ColdProxyClient
  private readonly audit: (event: SourceSecurityAuditEvent) => void
  private readonly owned: SqlExecutor[]
  private readonly ownedTransactions: SqlTransactionRunner[]
  private closed = false

  /**
   * @param ctx - owning Cordis context.
   * @param config - validated source configuration.
   * @param dependencies - optional injected transports for tests or alternate drivers.
   */
  constructor(ctx: Context, private readonly config: Config, dependencies: SourceDependencies = {}) {
    super(ctx, 'nilmSource')
    const owned: SqlExecutor[] = []
    const ownedTransactions: SqlTransactionRunner[] = []
    this.local = dependencies.localMysql ?? own(owned, new MysqlExecutor({ ...config.localMysql, connectionLimit: config.mysqlConnectionLimit }))
    this.localTransactions = dependencies.localTransactions ?? ownTransaction(
      ownedTransactions,
      new MysqlTransactionRunner({ ...config.localMysql, connectionLimit: config.mysqlConnectionLimit }),
    )
    this.upstream = dependencies.upstreamMysql ?? own(owned, new MysqlExecutor({ ...config.upstreamMysql, connectionLimit: config.mysqlConnectionLimit }))
    this.hot = dependencies.tdengineHot ?? new HttpTdengineExecutor(
      config.tdengineHotUrl,
      config.tdengineTimeoutMs,
      config.tdengineUser,
      config.tdenginePassword,
    )
    this.stats = dependencies.tdengineStats ?? new HttpTdengineExecutor(
      config.tdengineStatsUrl,
      config.tdengineTimeoutMs,
      config.tdengineUser,
      config.tdenginePassword,
    )
    this.cold = new ColdProxyClient(
      dependencies.coldProxyTransport ?? new HttpColdProxyTransport(config.coldProxyUrl),
      config.coldProxyTimeoutMs,
    )
    this.audit = dependencies.securityAudit ?? (event => {
      ctx.logger.warn(`nilm.security ${JSON.stringify(redactValue(event))}`)
    })
    this.owned = owned
    this.ownedTransactions = ownedTransactions
    ctx.effect(() => () => this.close())
  }

  /**
   * Execute a guarded SELECT against the project database.
   * @param sql - parameterized SELECT over a project table.
   * @param params - positional values bound by the driver.
   * @param signal - optional caller cancellation.
   * @returns result rows.
   */
  async queryLocalReadOnly<T>(sql: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T[]> {
    return this.run('local', this.local, this.guard('local', sql, [...NILM_LOCAL_TABLES, INFORMATION_SCHEMA_TABLES]), params, signal)
  }

  /**
   * Run project-owned writes inside one MySQL transaction. The transaction
   * handle is never reachable from model-facing tools; callers own the fixed
   * statements and parameter binding.
   * @param body - statements to run with the transaction handle.
   * @returns the callback result after commit.
   */
  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    if (this.closed) throw new NilmSourceError('SOURCE_UNAVAILABLE', 'local source is closed')
    return this.localTransactions.transaction(body)
  }

  /**
   * Execute a guarded SELECT against the upstream business database.
   * @param sql - parameterized SELECT over a whitelisted upstream table.
   * @param params - positional values bound by the driver.
   * @param signal - optional caller cancellation.
   * @returns result rows.
   */
  async queryUpstreamReadOnly<T>(sql: string, params: readonly unknown[] = [], signal?: AbortSignal): Promise<T[]> {
    return this.run('upstream', this.upstream, this.guard('upstream', sql, NILM_UPSTREAM_TABLES), params, signal)
  }

  /**
   * List the tables currently present in the project `nilm_system` database.
   * @param signal - optional caller cancellation.
   * @returns table names in lexical order.
   */
  async listLocalTables(signal?: AbortSignal): Promise<string[]> {
    const rows = await this.queryLocalReadOnly<{ tableName: string }>(
      'SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name',
      [this.config.localMysql.database],
      signal,
    )
    return rows.map(row => row.tableName)
  }

  /**
   * Execute one internally generated statement against the hot TDengine endpoint.
   * This method is not exposed to model-facing tools; callers own the fixed
   * template and validated parameter escaping.
   * @param sql - TDengine statement generated by a domain adapter.
   * @param signal - caller cancellation combined with the transport timeout.
   * @returns rows keyed by column name.
   */
  async queryHot<T>(sql: string, signal?: AbortSignal): Promise<T[]> {
    return this.hot.query<T>(sql, signal)
  }

  /**
   * Execute one internally generated statement against the statistics endpoint.
   * @param sql - TDengine statement generated by a domain adapter.
   * @param signal - caller cancellation combined with the transport timeout.
   * @returns rows keyed by column name.
   */
  async queryStats<T>(sql: string, signal?: AbortSignal): Promise<T[]> {
    return this.stats.query<T>(sql, signal)
  }

  /**
   * Execute one server-owned cold-warehouse template.
   * @param template - proxy template identifier.
   * @param params - bound scalar parameters.
   * @param signal - optional caller cancellation.
   * @returns proxy response body.
   */
  async queryCold(
    template: string,
    params: Record<string, string | number | boolean | null>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.cold.query(template, params, signal)
  }

  /**
   * Run every stage-0 connectivity assertion and report per-check outcomes.
   * @returns aggregate connectivity report; failures are reported, not thrown.
   */
  async probe(): Promise<ConnectivityReport> {
    const started = Date.now()
    const checks: ConnectivityCheck[] = []
    const controller = new AbortController()
    const budget = this.config.probeTimeoutMs
    const deadline = setTimeout(() => {
      controller.abort()
    }, budget)
    const runCheck = (name: string, body: (signal: AbortSignal) => Promise<string>): Promise<ConnectivityCheck> =>
      check(name, body, controller.signal, budget)
    try {
      checks.push(await runCheck('local-mysql', async signal => {
        const tables = await this.listLocalTables(signal)
        const missing = NILM_LOCAL_TABLES.filter(table => !tables.includes(table))
        if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`)
        return `${String(tables.length)} tables present`
      }))
      checks.push(await runCheck('upstream-mysql', async signal => {
        await this.upstream.query('SELECT 1 AS ok', [], signal)
        return 'read query succeeded'
      }))
      checks.push(await runCheck('tdengine-hot', async signal => {
        const tables = await this.hot.query<Record<string, unknown>>('SHOW TABLES', signal)
        const names = tables.map(row => String(Object.values(row)[0] ?? ''))
        assertTables(names, ['nilmdc_realtime_data', 'nilmdc_energy_data', 'nilmdc_appliance_identification'])
        return `${String(names.length)} tables present`
      }))
      checks.push(await runCheck('tdengine-stats', async signal => {
        const tables = await this.stats.query<Record<string, unknown>>('SHOW TABLES', signal)
        const names = tables.map(row => String(Object.values(row)[0] ?? ''))
        assertTables(names, ['consum_energy_day_statistics_info'])
        return `${String(names.length)} tables present`
      }))
      checks.push(await runCheck('cold-proxy', async signal => {
        await this.cold.probe(signal)
        return 'health template succeeded'
      }))
    } finally {
      clearTimeout(deadline)
    }
    const durationMs = Date.now() - started
    return {
      ok: checks.every(item => item.ok) && !controller.signal.aborted && durationMs <= budget,
      durationMs,
      checks,
    }
  }

  /** Close every pool owned by this service. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.allSettled([
      ...this.owned.map(executor => executor.close()),
      ...this.ownedTransactions.map(runner => runner.close()),
    ])
  }

  /** Apply the SELECT-only guard and audit every refusal before the driver sees SQL. */
  private guard(source: 'local' | 'upstream', sql: string, allowedTables: readonly string[]): string {
    try {
      return assertReadOnlySql(sql, allowedTables)
    } catch (error) {
      if (error instanceof NilmSourceError && error.code === 'UNAUTHORIZED_SQL_OPERATION') {
        this.audit({ type: 'sql.rejected', source, code: 'UNAUTHORIZED_SQL_OPERATION' })
      }
      throw error
    }
  }

  private async run<T>(
    label: string,
    executor: SqlExecutor,
    sql: string,
    params: readonly unknown[],
    signal?: AbortSignal,
  ): Promise<T[]> {
    if (this.closed) throw new NilmSourceError('SOURCE_UNAVAILABLE', `${label} source is closed`)
    try {
      return await executor.query<T>(sql, params, signal)
    } catch (error) {
      if (error instanceof NilmSourceError) throw error
      throw sourceUnavailable(error)
    }
  }
}

/**
 * Track a pool created by this service.
 * @param owned - mutable pool list.
 * @param executor - newly created executor.
 * @returns the same executor.
 */
function own<T extends SqlExecutor>(owned: SqlExecutor[], executor: T): T {
  owned.push(executor)
  return executor
}

/**
 * Track a transaction runner owned by this service.
 * @param owned - runner list released on close.
 * @param runner - runner created by this service.
 * @returns the same runner.
 */
function ownTransaction<T extends SqlTransactionRunner>(owned: SqlTransactionRunner[], runner: T): T {
  owned.push(runner)
  return runner
}

/**
 * Time one check and convert failure into a report row.
 * @param name - check name.
 * @param body - assertion to run.
 * @param signal - aggregate probe budget signal.
 * @param budgetMs - total probe budget used in the failure detail.
 * @returns the completed check.
 */
async function check(
  name: string,
  body: (signal: AbortSignal) => Promise<string>,
  signal: AbortSignal,
  budgetMs: number,
): Promise<ConnectivityCheck> {
  const started = Date.now()
  if (signal.aborted) {
    return { name, ok: false, detail: `probe budget of ${String(budgetMs)} ms already exhausted`, durationMs: 0 }
  }
  try {
    return { name, ok: true, detail: await raceAbort(body(signal), signal), durationMs: Date.now() - started }
  } catch (error) {
    const detail = signal.aborted
      ? `probe budget of ${String(budgetMs)} ms exceeded`
      : error instanceof Error ? error.message : 'unknown failure'
    return { name, ok: false, detail, durationMs: Date.now() - started }
  }
}

/**
 * Bound one check by the aggregate budget even when an injected executor does
 * not observe its cancellation signal.
 * @param operation - check body already running.
 * @param signal - aggregate probe budget signal.
 * @returns the body result when it settles before the budget.
 * @throws Error `probe budget exceeded` when the signal aborts first.
 */
function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('probe budget exceeded'))
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new Error('probe budget exceeded'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Assert required tables are visible on one TDengine endpoint.
 * @param actual - observed table names.
 * @param required - tables required by the design.
 */
function assertTables(actual: readonly string[], required: readonly string[]): void {
  const missing = required.filter(table => !actual.includes(table))
  if (missing.length > 0) throw new Error(`missing tables: ${missing.join(', ')}`)
}

export default NilmSourceService
