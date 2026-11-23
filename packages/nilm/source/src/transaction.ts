/**
 * Write-capable MySQL transaction seam for project-owned tables. Read paths
 * keep using {@link SqlExecutor}; this runner is never exposed to model tools.
 * @module @deepseek-ai/dsh-nilm-source/transaction
 */

import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import type { MysqlEndpointConfig } from './config.ts'
import { loadMysql2, sourceUnavailable, type Mysql2Connection, type Mysql2Pool } from './mysql.ts'
import type { MysqlDriverLoader } from './mysql.ts'

/** One statement surface inside a transaction. Statements are server-owned. */
export interface SqlTransaction {
  /**
   * Execute one statement and return its rows.
   * @param sql - parameterized statement owned by a NILM package.
   * @param params - positional values bound by the driver.
   * @returns result rows; statements without rows return an empty array.
   */
  query<T>(sql: string, params?: readonly unknown[]): Promise<T[]>
  /**
   * Execute one statement and return the affected-row count.
   * @param sql - parameterized statement owned by a NILM package.
   * @param params - positional values bound by the driver.
   * @returns number of affected rows reported by MySQL.
   */
  affected(sql: string, params?: readonly unknown[]): Promise<number>
}

/** Transaction boundary shared by Sentinel and the Outbox dispatcher. */
export interface SqlTransactionRunner {
  /**
   * Run a callback in one transaction, committing only when it resolves.
   * @param body - statements to run with the transaction handle.
   * @returns the callback result after commit.
   */
  transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T>
  /** Release the underlying pool. */
  close(): Promise<void>
}

/** Lazy mysql2 transaction pool: construction performs no network IO. */
export class MysqlTransactionRunner implements SqlTransactionRunner {
  private poolPromise: Promise<Mysql2Pool> | undefined

  /**
   * @param config - endpoint and pool size; credentials come from deployment configuration.
   * @param loadDriver - optional driver loader; defaults to the variable `mysql2/promise` import.
   */
  constructor(
    private readonly config: MysqlEndpointConfig & { connectionLimit: number },
    private readonly loadDriver: MysqlDriverLoader = loadMysql2,
  ) {}

  /**
   * Run one callback inside `BEGIN` / `COMMIT`; any throw is rolled back.
   * @param body - statements to run with the transaction handle.
   * @returns the callback result after commit.
   */
  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    const pool = await this.pool()
    if (pool.getConnection === undefined) {
      throw new NilmSourceError('SOURCE_UNAVAILABLE', 'configured MySQL driver does not support transactions')
    }
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
    } catch (error) {
      connection.release()
      throw sourceUnavailable(error)
    }
    let committed = false
    try {
      const result = await body(new ConnectionTransaction(connection))
      await connection.commit()
      committed = true
      return result
    } catch (error) {
      if (!committed) {
        try {
          await connection.rollback()
        } catch (rollbackError: unknown) {
          void rollbackError
          // The transaction is already unusable; the original failure is the actionable cause.
        }
      }
      throw error
    } finally {
      connection.release()
    }
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

/** Transaction handle that normalizes mysql2's rows-or-result-header union. */
class ConnectionTransaction implements SqlTransaction {
  /**
   * @param connection - pooled connection owned by the runner.
   */
  constructor(private readonly connection: Mysql2Connection) {}

  /** @param sql - parameterized statement. @param params - bound values. @returns result rows. */
  async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    try {
      const [rows] = await this.connection.query(sql, params)
      return Array.isArray(rows) ? rows as T[] : []
    } catch (error) {
      throw sourceUnavailable(error)
    }
  }

  /** @param sql - parameterized statement. @param params - bound values. @returns affected rows. */
  async affected(sql: string, params: readonly unknown[] = []): Promise<number> {
    try {
      const [result] = await this.connection.query(sql, params)
      const header = result as { affectedRows?: unknown }
      return typeof header.affectedRows === 'number' ? header.affectedRows : 0
    } catch (error) {
      throw sourceUnavailable(error)
    }
  }
}
