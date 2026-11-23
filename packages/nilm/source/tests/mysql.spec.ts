import { describe, expect, it } from 'vitest'
import { MysqlExecutor, loadMysql2, sourceUnavailable } from '../src/mysql.ts'
import type { Mysql2Module, Mysql2Pool } from '../src/mysql.ts'

const endpoint = {
  host: 'local', port: 3306, user: 'local', password: 'secret', database: 'nilm_system', connectionLimit: 4,
}

function driver(pool: Partial<Mysql2Pool> = {}): Mysql2Module & { options: unknown[] } {
  const options: unknown[] = []
  return {
    options,
    createPool(config) {
      options.push(config)
      return {
        query: () => Promise.resolve([[], []]),
        end: () => Promise.resolve(),
        ...pool,
      }
    },
  }
}

describe('MysqlExecutor', () => {
  it('resolves the optional driver or reports its absence', async () => {
    const loaded = await loadMysql2().catch((error: unknown) => error)
    if (loaded instanceof Error) expect(loaded).toBeInstanceOf(Error)
    else expect(typeof loaded.createPool).toBe('function')
  })

  it('creates one lazily configured pool and reuses it', async () => {
    const module = driver({
      query: () => Promise.resolve([[{ table_name: 'nilm_tenant_config' }], []]),
    })
    const executor = new MysqlExecutor(endpoint, () => Promise.resolve(module))
    await expect(executor.query('SELECT 1', [])).resolves.toEqual([{ table_name: 'nilm_tenant_config' }])
    await expect(executor.query('SELECT 1', [])).resolves.toEqual([{ table_name: 'nilm_tenant_config' }])
    expect(module.options).toHaveLength(1)
    expect(module.options[0]).toMatchObject({ host: 'local', database: 'nilm_system', connectionLimit: 4 })
    await executor.close()
  })

  it('returns no rows when the driver result is not an array', async () => {
    const module = driver({ query: () => Promise.resolve([{ affectedRows: 0 }, []]) })
    const executor = new MysqlExecutor(endpoint, () => Promise.resolve(module))
    await expect(executor.query('SELECT 1', [])).resolves.toEqual([])
    await executor.close()
  })

  it('does not open a pool for an already cancelled query', async () => {
    const executor = new MysqlExecutor(endpoint)
    const controller = new AbortController()
    controller.abort()
    await expect(executor.query('SELECT 1', [], controller.signal)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
    })
    await executor.close()
  })

  it('rejects a pending query when the caller aborts', async () => {
    const module = driver({ query: () => new Promise(() => {}) as Promise<[unknown, unknown]> })
    const executor = new MysqlExecutor(endpoint, () => Promise.resolve(module))
    const controller = new AbortController()
    const pending = executor.query('SELECT 1', [], controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  })

  it('propagates a driver import or query failure for the caller to map', async () => {
    const failure = new Error('driver disconnected')
    const executor = new MysqlExecutor(endpoint, () => Promise.reject(failure))
    await expect(executor.query('SELECT 1', [])).rejects.toBe(failure)
  })

  it('maps an untyped driver failure without exposing connection details', () => {
    const failure = new Error('driver disconnected')
    const mapped = sourceUnavailable(failure)
    expect(mapped.code).toBe('SOURCE_UNAVAILABLE')
    expect(mapped.message).toBe('source query failed')
    expect(mapped.message).not.toContain('driver disconnected')
    expect(mapped.cause).toBe(failure)
    expect(sourceUnavailable('not an error').message).toBe('source query failed')
  })
})
