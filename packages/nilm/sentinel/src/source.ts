/**
 * Incremental upstream unsafe-record reader. Reads stay inside the guarded
 * read-only source adapter; station-level write credentials are never used.
 * @module @deepseek-ai/dsh-nilm-sentinel/source
 */

import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'
import type { Watermark } from './store.ts'
import type { UnsafeRecordRow } from './unsafe.ts'

/** Incremental event source consumed by the scanner. */
export interface IncrementalUnsafeSource {
  /** @returns the current newest record, used once when no watermark exists. */
  head(): Promise<Watermark | undefined>
  /**
   * @param after - last processed record.
   * @param limit - maximum rows.
   * @param offset - rows already examined in a poison prefix.
   * @returns rows ordered by `(record_time, record_id)`.
   */
  readAfter(after: Watermark, limit: number, offset?: number): Promise<UnsafeRecordRow[]>
}

/** Guarded upstream implementation over `nilm_unsafe_record`. */
export class SourceUnsafeIncrementalSource implements IncrementalUnsafeSource {
  /**
   * @param source - lazily resolved read-only source service.
   */
  constructor(private readonly source: () => NilmSourceService) {}

  /** @returns the current newest record, used once when no watermark exists. */
  async head(): Promise<Watermark | undefined> {
    const rows = await this.source().queryUpstreamReadOnly<{ recordTime: string | Date; recordId: string }>(
      `SELECT record_time AS recordTime, record_id AS recordId
         FROM nilm_unsafe_record
        WHERE unsafe_type <> ?
        ORDER BY record_time DESC, record_id DESC
        LIMIT 1`,
      ['10'],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return {
      recordTimeMs: row.recordTime instanceof Date ? row.recordTime.getTime() : Date.parse(row.recordTime),
      recordId: row.recordId,
    }
  }

  /**
   * @param after - exclusive resume point.
   * @param limit - maximum rows.
   * @param offset - rows already examined in a poison prefix.
   * @returns newly inserted unsafe records.
   */
  async readAfter(after: Watermark, limit: number, offset = 0): Promise<UnsafeRecordRow[]> {
    const capped = Math.max(1, Math.min(limit, 1_000))
    const safeOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0
    return this.source().queryUpstreamReadOnly<UnsafeRecordRow>(
      `SELECT record_id AS recordId, record_time AS recordTime,
              terminal_channel_id AS terminalChannelId, asset_id AS assetId,
              unsafe_type AS unsafeType, unsafe_desc AS unsafeDesc,
              power, current, appliance_name AS applianceName,
              handling_status AS handlingStatus
         FROM nilm_unsafe_record
        WHERE unsafe_type <> ?
          AND (record_time > ? OR (record_time = ? AND record_id > ?))
        ORDER BY record_time, record_id
        LIMIT ${String(capped)} OFFSET ${String(safeOffset)}`,
      ['10', new Date(after.recordTimeMs), new Date(after.recordTimeMs), after.recordId],
    )
  }
}
