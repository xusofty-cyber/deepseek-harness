import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpTdengineExecutor } from '../src/index.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

function respond(body: unknown, status = 200): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }))))
}

describe('HttpTdengineExecutor', () => {
  it('maps column metadata and data rows to named records', async () => {
    respond({
      code: 0,
      column_meta: [['ts', 'TIMESTAMP', 8], ['value', 'DOUBLE', 8]],
      data: [['2026-11-18T00:00:00Z', 12.5]],
    })
    const executor = new HttpTdengineExecutor('http://tdengine/rest/sql/tpim_system', 100)
    await expect(executor.query('SELECT ts, value FROM nilmdc_realtime_data')).resolves.toEqual([
      { ts: '2026-11-18T00:00:00Z', value: 12.5 },
    ])
  })

  it('lists tables and sends basic authorization when configured', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 0,
      column_meta: [['table_name', 'VARCHAR', 64]],
      data: [['nilmdc_realtime_data'], ['']],
    }))))
    vi.stubGlobal('fetch', fetch)
    const executor = new HttpTdengineExecutor('http://tdengine/rest/sql/tpim_system', 100, 'user', 'secret')
    await expect(executor.listTables()).resolves.toEqual(['nilmdc_realtime_data'])
    const init = fetch.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toMatchObject({
      authorization: `Basic ${Buffer.from('user:secret').toString('base64')}`,
    })
  })

  it('maps HTTP and server-code failures to SOURCE_UNAVAILABLE', async () => {
    respond({}, 503)
    const executor = new HttpTdengineExecutor('http://tdengine/rest/sql/tpim_system', 100)
    await expect(executor.query('SHOW TABLES')).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine returned HTTP 503',
    })

    respond({ code: 1, desc: 'syntax error' })
    await expect(executor.query('SHOW TABLES')).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine error 1: syntax error',
    })

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('not json', { status: 200 }))))
    await expect(executor.query('SHOW TABLES')).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine returned invalid JSON',
    })
  })

  it('maps transport failures, timeouts, and caller cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('socket closed'))))
    const executor = new HttpTdengineExecutor('http://tdengine/rest/sql/tpim_system', 100)
    await expect(executor.query('SHOW TABLES')).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine request failed',
    })

    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })))
    const timed = new HttpTdengineExecutor('http://tdengine/rest/sql/tpim_system', 10)
    await expect(timed.query('SHOW TABLES')).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine exceeded 10 ms',
    })

    const caller = new AbortController()
    const cancelled = timed.query('SHOW TABLES', caller.signal)
    caller.abort()
    await expect(cancelled).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE',
      message: 'TDengine request was cancelled',
    })
  })
})
