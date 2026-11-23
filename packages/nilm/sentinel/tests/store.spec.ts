import { describe, expect, it } from 'vitest'
import type { SqlTransaction } from '@deepseek-ai/dsh-nilm-source'
import { MysqlSentinelStore, type LocalDatabase } from '../src/store.ts'

interface WatermarkRow {
  record_time: number
  record_id: string
  /** Raw column value; drivers may surface DECIMAL-ish text or NULL. */
  scan_offset: number | string | null
}

/**
 * Executes the store's real `INSERT ... ON DUPLICATE KEY UPDATE` text against one
 * in-memory row. Assignments run left to right against the partially updated
 * row, as MySQL does, so the test exercises the statement's semantics rather
 * than its wording.
 */
class WatermarkTable implements LocalDatabase {
  readonly rows = new Map<string, WatermarkRow>()

  async queryLocalReadOnly<T>(_sql: string, params: readonly unknown[] = []): Promise<T[]> {
    const row = this.rows.get(String(params[0]))
    if (row === undefined) return []
    return [{ recordTime: new Date(row.record_time), recordId: row.record_id, scanOffset: row.scan_offset }] as T[]
  }

  async transaction<T>(body: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return body({
      query: <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
        this.upsert(sql, params)
        return Promise.resolve([])
      },
      affected: () => Promise.resolve(0),
    })
  }

  private upsert(sql: string, params: readonly unknown[]): void {
    const values = params.map(value => (value instanceof Date ? value.getTime() : value))
    const [source, time, recordId, scanOffset] = values
    const current = this.rows.get(String(source))
    if (current === undefined) {
      this.rows.set(String(source), { record_time: Number(time), record_id: String(recordId), scan_offset: Number(scanOffset) })
      return
    }
    const update = sql.split(/ON DUPLICATE KEY UPDATE/i)[1]
    if (update === undefined) throw new Error('watermark upsert lost its ON DUPLICATE KEY UPDATE clause')
    if (/VALUES\s*\(/i.test(update)) throw new Error('watermark upsert still uses the deprecated VALUES() function')
    const row = { ...current }
    // Placeholders after the four INSERT values bind left to right through the update clause.
    const cursor = { next: 4 }
    for (const assignment of splitTopLevel(update)) {
      const match = /^\s*(\w+)\s*=([\s\S]+)$/.exec(assignment)
      if (match === null) throw new Error(`unparsed assignment: ${assignment}`)
      ;(row as Record<string, unknown>)[match[1]!] = evaluate(match[2]!, row, values, cursor)
    }
    if (cursor.next !== values.length) throw new Error(`bound ${String(cursor.next)} of ${String(values.length)} parameters`)
    this.rows.set(String(source), row)
  }
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts.filter(part => part.trim() !== '')
}

function evaluate(expression: string, row: WatermarkRow, values: readonly unknown[], cursor: { next: number }): unknown {
  const js = expression
    .replace(/(?<![.\w])(record_time|record_id|scan_offset)\b/g, 'r.$1')
    .replace(/\bOR\b/g, '||')
    .replace(/\bAND\b/g, '&&')
    .replace(/(?<![<>!=])=(?!=)/g, '===')
    .replace(/\?/g, () => `p[${String(cursor.next++)}]`)
  // eslint-disable-next-line no-new-func
  return new Function('IF', 'r', 'p', `return (${js})`)(
    (condition: boolean, whenTrue: unknown, whenFalse: unknown) => (condition ? whenTrue : whenFalse),
    row,
    values,
  )
}

function setup(): { table: WatermarkTable; store: MysqlSentinelStore } {
  const table = new WatermarkTable()
  return { table, store: new MysqlSentinelStore(() => table) }
}

describe('MysqlSentinelStore', () => {
  it('rejects watermark writes that would move backwards', async () => {
    const { table, store } = setup()
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2' })

    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 1_000, recordId: 'r9', scanOffset: 50 })
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r1', scanOffset: 50 })
    expect(table.rows.get('upstream_unsafe')).toEqual({ record_time: 2_000, record_id: 'r2', scan_offset: 0 })

    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r3' })
    expect(table.rows.get('upstream_unsafe')).toEqual({ record_time: 2_000, record_id: 'r3', scan_offset: 0 })
  })

  it('only grows the scan offset while the watermark stays put', async () => {
    const { table, store } = setup()
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 40 })

    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 20 })
    expect(table.rows.get('upstream_unsafe')?.scan_offset).toBe(40)
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 60 })
    expect(table.rows.get('upstream_unsafe')?.scan_offset).toBe(60)
  })

  it('takes the new offset when the watermark advances and ignores stale offsets', async () => {
    const { table, store } = setup()
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 40 })

    // Advancing resets the offset; this fails if record columns were assigned before scan_offset.
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 3_000, recordId: 'r4', scanOffset: 0 })
    expect(table.rows.get('upstream_unsafe')).toEqual({ record_time: 3_000, record_id: 'r4', scan_offset: 0 })

    // An older process cannot plant its larger offset behind the current watermark.
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 99 })
    expect(table.rows.get('upstream_unsafe')).toEqual({ record_time: 3_000, record_id: 'r4', scan_offset: 0 })
    expect(await store.loadWatermark('upstream_unsafe')).toEqual({ recordTimeMs: 3_000, recordId: 'r4', scanOffset: 0 })
  })

  it('compares record ids in byte order, matching the utf8mb4_bin column', async () => {
    const { table, store } = setup()
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'a1' })

    // 'B' (0x42) sorts before 'a' (0x61) in byte order, so this write is stale.
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'B9', scanOffset: 7 })
    expect(table.rows.get('upstream_unsafe')).toEqual({ record_time: 2_000, record_id: 'a1', scan_offset: 0 })
  })

  it('clamps the written scan offset to the INT UNSIGNED column range', async () => {
    const { table, store } = setup()
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 2_000, recordId: 'r2', scanOffset: 2 ** 40 })
    expect(table.rows.get('upstream_unsafe')?.scan_offset).toBe(4_294_967_295)
    await store.saveWatermark('upstream_unsafe', { recordTimeMs: 3_000, recordId: 'r3', scanOffset: -5 })
    expect(table.rows.get('upstream_unsafe')?.scan_offset).toBe(0)
  })

  it('loads the persisted scan offset and clamps invalid values to zero', async () => {
    const { table, store } = setup()

    table.rows.set('upstream_unsafe', { record_time: 2_000, record_id: 'r2', scan_offset: '40' })
    expect(await store.loadWatermark('upstream_unsafe')).toEqual({ recordTimeMs: 2_000, recordId: 'r2', scanOffset: 40 })
    table.rows.set('upstream_unsafe', { record_time: 2_000, record_id: 'r2', scan_offset: null })
    expect((await store.loadWatermark('upstream_unsafe'))?.scanOffset).toBe(0)
    table.rows.set('upstream_unsafe', { record_time: 2_000, record_id: 'r2', scan_offset: -3 })
    expect((await store.loadWatermark('upstream_unsafe'))?.scanOffset).toBe(0)
    expect(await store.loadWatermark('missing')).toBeUndefined()
  })
})
