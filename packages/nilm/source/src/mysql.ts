/**
 * MySQL executor seam and the mysql2-backed pool implementation.
 * @module @deepseek-ai/dsh-nilm-source/mysql
 */

import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import type { MysqlEndpointConfig } from './config.ts'

/** Minimal query surface consumed by the source service; tests inject a fake. */
export interface SqlExecutor {
  /**
   * Execute one already validated statement.
   * @param sql - parameterized SQL template.
   * @param params - positional parameter values.
   * @param signal - caller cancellation; the driver may finish the statement, but the result is discarded.
   * @returns result rows.
   */
  query<T>(sql: string, params: readonly unknown[], signal?: AbortSignal): Promise<T[]>
  /** Release the underlying pool or transport. */
  close(): Promise<void>
}

/** Structural subset of the mysql2/promise module used by the adapter. */
export interface Mysql2Module {
  createPool(options: {
    host: string
    port: number
    user: string
    password: string
    database: string
    connectionLimit: number
    waitForConnections: boolean
    charset: string
    timezone: string
  }): Mysql2Pool
}

export interface Mysql2Pool {
  query(sql: string, params: readonly unknown[]): Promise<[unknown, unknown]>
  end(): Promise<void>
  /** Acquire one connection for a transaction; absent on read-only test doubles. */
  getConnection?(): Promise<Mysql2Connection>
}

/** One pooled connection with explicit transaction control. */
export interface Mysql2Connection {
  query(sql: string, params: readonly unknown[]): Promise<[unknown, unknown]>
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

/** Lazy loader for the optional driver; tests inject a fake module. */
export type MysqlDriverLoader = () => Promise<Mysql2Module>

/** Lazy mysql2 pool: construction performs no network IO. */
export class MysqlExecutor implements SqlExecutor {
  private poolPromise: Promise<Mysql2Pool> | undefined

  /**
   * @param config - endpoint and pool size.
   * @param loadDriver - optional driver loader; defaults to the variable `mysql2/promise` import.
   */
  constructor(
    private readonly config: MysqlEndpointConfig & { connectionLimit: number },
    private readonly loadDriver: MysqlDriverLoader = loadMysql2,
  ) {}

  /**
   * Execute one statement through the lazily created pool.
   * @param sql - parameterized SQL template.
   * @param params - positional parameter values.
   * @returns result rows.
   */
  async query<T>(sql: string, params: readonly unknown[], signal?: AbortSignal): Promise<T[]> {
    if (signal?.aborted === true) throw abortFailure()
    const pool = await this.pool()
    const [rows] = await abortable(pool.query(sql, params), signal)
    return Array.isArray(rows) ? rows as T[] : []
  }

  /** Close the pool if it was opened. */
  async close(): Promise<void> {
    const opening = this.poolPromise
    if (opening === undefined) return
    this.poolPromise = undefined
    const pool = await opening
    await pool.end()
  }

  private async pool(): Promise<Mysql2Pool> {
    this.poolPromise ??= this.create()
    return this.poolPromise
  }

  private async create(): Promise<Mysql2Pool> {
    const mysql = await this.loadDriver()
    return mysql.createPool({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      connectionLimit: this.config.connectionLimit,
      waitForConnections: true,
      charset: 'utf8mb4',
      timezone: 'Z',
    })
  }
}

/**
 * Import the optional driver without a static specifier that would enter the type graph.
 * @returns the driver module.
 */
export async function loadMysql2(): Promise<Mysql2Module> {
  // A variable specifier keeps the optional native driver out of the type graph.
  const moduleName = 'mysql2/promise'
  return await import(moduleName) as Mysql2Module
}

/**
 * Race one driver promise against caller cancellation. mysql2 has no
 * cancellable query handle, so the pool may finish the statement after this
 * rejection; the adapter still stops waiting and never returns its rows.
 * @param operation - in-flight driver call.
 * @param signal - caller cancellation.
 * @returns the driver result when it settles before cancellation.
 * @throws NilmSourceError with `SOURCE_UNAVAILABLE` when the signal aborts.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(abortFailure())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortFailure())
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

/** Build the stable cancellation failure without exposing connection details. */
function abortFailure(): NilmSourceError {
  return new NilmSourceError('SOURCE_UNAVAILABLE', 'source query was cancelled')
}

/**
 * Wrap a failed driver call as a source failure without leaking connection details.
 * @param error - driver failure.
 * @returns the typed source error.
 */
export function sourceUnavailable(error: unknown): NilmSourceError {
  return new NilmSourceError('SOURCE_UNAVAILABLE', 'source query failed', { cause: error })
}
