/**
 * Read-only projection of upstream unsafe records into deterministic safety facts.
 * Missing upstream values remain null; they are never replaced with zero.
 * @module @deepseek-ai/dsh-nilm-safety
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import {
  NilmError,
  type CallContext,
  type NilmDataQuality,
  type TimeRangeSpec,
} from '@deepseek-ai/dsh-nilm-core'
import type { NilmSourceService } from '@deepseek-ai/dsh-nilm-source'

declare module '@deepseek-ai/cordis' {
  interface Context {
    nilmSafety: NilmSafetyService
  }
}

/** Normalized severity; `unknown` means the upstream type has no confirmed mapping. */
export type SafetySeverity = 'info' | 'warning' | 'critical' | 'unknown'

/** One projected safety event. */
export interface SafetyRecord {
  /** Upstream record identifier. */
  recordId: string
  /** Event instant in `Asia/Shanghai` business time. */
  occurredAt: string
  /** Projected asset path when the upstream row supplies one. */
  sitePath: string | null
  /** Terminal identifier or channel tag. */
  terminalId: string | null
  /** Channel identifier when the upstream row supplies one. */
  channelId: string | null
  /** Phase when the upstream row supplies one. */
  phase: 'A' | 'B' | 'C' | null
  /** Raw upstream unsafe type. */
  unsafeType: string
  /** Normalized severity. */
  severity: SafetySeverity
  /** Deterministic description from the upstream record. */
  description: string | null
  /** Observed power in kW, absent when the upstream value is null. */
  powerKw: number | null
  /** Observed current in A, absent when the upstream value is null. */
  currentA: number | null
  /** Appliance name supplied by the upstream record. */
  applianceName: string | null
  /** Threshold text when the upstream row supplies one. */
  threshold: string | null
  /** Duration in seconds when the upstream row supplies one. */
  durationSeconds: number | null
  /** Upstream handling status. */
  status: string | null
}

/** Query filter accepted by the safety service. */
export interface SafetyQueryInput {
  /** Half-open business range. */
  range: TimeRangeSpec
  /** Optional terminal restrictions; an empty list selects no terminal. */
  terminalIds?: readonly string[]
  /** Optional channel restrictions; an empty list selects no channel. */
  channelIds?: readonly string[]
  /** Optional severity restriction. */
  severity?: SafetySeverity
  /** Requested row limit; clamped to the service maximum. */
  limit?: number
}

/** Safety query result with an explicit empty-result reason. */
export interface SafetyQueryResult {
  /** Projected records in descending event time. */
  records: SafetyRecord[]
  /** Coverage and provenance envelope. */
  dataQuality: NilmDataQuality
  /** Non-fatal mapping or limit caveats. */
  warnings: string[]
}

/** Read seam for tests and alternate unsafe-record projections. */
export interface SafetyRepository {
  /**
   * @param window - half-open epoch range.
   * @param limit - maximum rows.
   * @param filter - terminal and channel filters applied in SQL.
   * @param signal - caller cancellation.
   * @returns upstream rows ordered newest first.
   */
  list(
    window: { startMs: number; endMs: number },
    limit: number,
    filter: { terminalIds?: readonly string[]; channelIds?: readonly string[] },
    signal?: AbortSignal,
  ): Promise<UnsafeRow[]>
}

/** Optional dependency overrides. */
export interface NilmSafetyDependencies {
  /** Repository replacing the upstream adapter. */
  repository?: SafetyRepository
}

interface UnsafeRow {
  recordId: string
  recordTime: string | Date
  terminalChannelId: string | null
  assetId: string | null
  unsafeType: string
  unsafeDesc: string | null
  power: string | number | null
  current: string | number | null
  applianceName: string | null
  handlingStatus: string | null
}

const MAX_RECORDS = 500
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/

/** Upstream unsafe-record repository backed by the guarded source adapter. */
export class SourceSafetyRepository implements SafetyRepository {
  /**
   * @param source - lazily resolved source service.
   */
  constructor(private readonly source: () => NilmSourceService) {}

  /**
   * @param window - half-open epoch range.
   * @param limit - maximum rows.
   * @param filter - terminal and channel filters.
   * @param signal - caller cancellation.
   * @returns upstream rows newest first.
   */
  async list(
    window: { startMs: number; endMs: number },
    limit: number,
    filter: { terminalIds?: readonly string[]; channelIds?: readonly string[] },
    signal?: AbortSignal,
  ): Promise<UnsafeRow[]> {
    const params: Array<Date | string> = [new Date(window.startMs), new Date(window.endMs)]
    let clauses = ''
    const terminals = filter.terminalIds ?? []
    const channels = filter.channelIds ?? []
    const allowed = [...new Set([...terminals, ...channels])]
    if (allowed.length > 0) {
      const placeholders = allowed.map(() => '?').join(', ')
      clauses += ` AND (terminal_channel_id IN (${placeholders}) OR asset_id IN (${placeholders}))`
      params.push(...allowed, ...allowed)
    } else {
      clauses += ' AND 1 = 0'
    }
    return this.source().queryUpstreamReadOnly<UnsafeRow>(
      `SELECT record_id AS recordId, record_time AS recordTime,
              terminal_channel_id AS terminalChannelId, asset_id AS assetId,
              unsafe_type AS unsafeType, unsafe_desc AS unsafeDesc,
              power, current, appliance_name AS applianceName, handling_status AS handlingStatus
         FROM nilm_unsafe_record
        WHERE record_time >= ? AND record_time < ? AND unsafe_type <> '10'${clauses}
        ORDER BY record_time DESC
        LIMIT ${String(limit)}`,
      params,
      signal,
    )
  }
}

/** Tenant-scoped unsafe-record retrieval service. */
export class NilmSafetyService extends Service {
  private readonly repository: SafetyRepository

  /**
   * @param ctx - owning plugin context.
   * @param dependencies - repository override for tests.
   */
  constructor(ctx: Context, dependencies: NilmSafetyDependencies = {}) {
    super(ctx, 'nilmSafety')
    this.repository = dependencies.repository ?? new SourceSafetyRepository(() => ctx.get('nilmSource')!)
  }

  /**
   * Retrieve and project unsafe records inside one verified tenant.
   * @param callContext - verified caller identity.
   * @param input - range and optional filters.
   * @param signal - optional caller cancellation.
   * @returns projected records, warnings, and quality metadata.
   */
  async queryUnsafeRecords(
    callContext: CallContext,
    input: SafetyQueryInput,
    signal?: AbortSignal,
  ): Promise<SafetyQueryResult> {
    if (callContext.tenantId.length === 0) throw new NilmError('UNAUTHORIZED_TENANT', 'call context tenant is required')
    const window = parseRange(input.range)
    const limit = clampLimit(input.limit)
    const terminalIds = safeFilters(input.terminalIds, 'terminal')
    const channelIds = safeFilters(input.channelIds, 'channel')
    if (terminalIds.length === 0 && channelIds.length === 0) {
      const warnings = ['no authorized terminal or channel is available for the requested scope']
      return {
        records: [],
        dataQuality: {
          coverage: 1,
          provisional: false,
          gaps: [],
          source: 'raw',
          warnings: [...warnings, 'event queries report row completeness, not sample coverage'],
        },
        warnings,
      }
    }
    const rows = await this.repository.list(window, limit, {
      terminalIds,
      channelIds,
    }, signal)
    const warnings: string[] = []
    if (rows.length === limit) warnings.push(`result reached the ${String(limit)}-row limit; narrow the range for completeness`)
    const records = rows.flatMap(row => {
      const project = projectRow(row, input, terminalIds, channelIds)
      return project === undefined ? [] : [project]
    })
    if (records.length === 0) warnings.push('no matching unsafe records')
    const dataQuality: NilmDataQuality = {
      coverage: 1,
      provisional: false,
      gaps: [],
      source: 'raw',
      warnings: ['event queries report row completeness, not sample coverage'],
    }
    return { records, dataQuality, warnings }
  }
}

function projectRow(row: UnsafeRow, input: SafetyQueryInput, terminalIds: readonly string[], channelIds: readonly string[]): SafetyRecord | undefined {
  const terminal = row.terminalChannelId
  const channel = row.assetId
  const allowed = terminalIds.includes(terminal ?? '')
    || terminalIds.includes(channel ?? '')
    || channelIds.includes(terminal ?? '')
    || channelIds.includes(channel ?? '')
  if (!allowed) return undefined
  const severity = severityOf(row.unsafeType)
  if (input.severity !== undefined && severity !== input.severity) return undefined
  const occurred = row.recordTime instanceof Date ? row.recordTime.getTime() : Date.parse(row.recordTime)
  if (!Number.isFinite(occurred)) throw new NilmError('DATA_UNAVAILABLE', `unsafe record ${row.recordId} has an invalid time`)
  return {
    recordId: row.recordId,
    occurredAt: businessIso(occurred),
    sitePath: null,
    terminalId: terminal,
    channelId: channel,
    phase: null,
    unsafeType: row.unsafeType,
    severity,
    description: row.unsafeDesc,
    powerKw: nullableNumber(row.power),
    currentA: nullableNumber(row.current),
    applianceName: row.applianceName,
    threshold: null,
    durationSeconds: null,
    status: row.handlingStatus,
  }
}

function safeFilters(ids: readonly string[] | undefined, label: string): string[] {
  if (ids === undefined) return []
  const unique = [...new Set(ids)]
  if (unique.length > 500) throw new NilmError('INVALID_ARGUMENT', `${label} filter exceeds 500 identifiers`)
  for (const id of unique) {
    if (!SAFE_ID.test(id)) throw new NilmError('INVALID_ARGUMENT', `${label} filter is not a safe identifier`)
  }
  return unique
}

function severityOf(type: string): SafetySeverity {
  const normalized = type.trim().toLowerCase()
  if (['overload_single_power', 'three_phase_unbalance', 'voltage_deviation', 'over_voltage', 'under_voltage'].includes(normalized)) return 'warning'
  if (['transient', 'electric_shock', 'arc_fault'].includes(normalized)) return 'critical'
  if (normalized.length === 0) return 'unknown'
  return 'unknown'
}

function nullableNumber(value: string | number | null): number | null {
  if (value === null) return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1) throw new NilmError('INVALID_ARGUMENT', 'limit must be a positive integer')
  return Math.min(limit, MAX_RECORDS)
}

function parseRange(range: TimeRangeSpec): { startMs: number; endMs: number } {
  const startMs = Date.parse(range.start)
  const endMs = Date.parse(range.end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    throw new NilmError('INVALID_ARGUMENT', 'time range must contain two ordered ISO instants')
  }
  if (range.timeZone !== 'Asia/Shanghai') throw new NilmError('INVALID_ARGUMENT', 'only Asia/Shanghai business time is supported')
  return { startMs, endMs }
}

function businessIso(ms: number): string {
  return `${new Date(ms + SHANGHAI_OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, 'Z').slice(0, -1)}+08:00`
}

export default NilmSafetyService
