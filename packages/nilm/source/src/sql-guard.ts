/**
 * Application-level SELECT-only query guard for the upstream MySQL adapter.
 * @module @deepseek-ai/dsh-nilm-source/sql-guard
 */

import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'

/** Project-owned tables created by `sql/init-nilm-system.sql`. */
export const NILM_LOCAL_TABLES = [
  'nilm_tenant_config',
  'nilm_asset_snapshot',
  'nilm_measurement_binding',
  'nilm_conversation',
  'nilm_turn_log',
  'nilm_security_audit',
  'nilm_alert_rule',
  'nilm_alert_event',
  'nilm_alert_transition',
  'nilm_notification_outbox',
  'nilm_notification_record',
  'nilm_sentinel_watermark',
  'nilm_job_run',
  'nilm_report',
  'nilm_tariff_plan',
  'nilm_tariff_period',
  'nilm_calendar_day',
  'nilm_pf_policy',
] as const

/** Upstream MySQL tables explicitly exposed to the source adapter in stage 0. */
export const NILM_UPSTREAM_TABLES = ['nilm_unsafe_record', 'appliance_category'] as const

/** Metadata table used only to assert that migrations landed. */
export const INFORMATION_SCHEMA_TABLES = 'information_schema.tables'

const FORBIDDEN_KEYWORDS = /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|CALL|MERGE|LOAD|HANDLER|LOCK|UNLOCK|SET|USE|EXECUTE|PREPARE|DEALLOCATE)\b/i
const FORBIDDEN_SELECT = /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|SLEEP\s*\(|BENCHMARK\s*\()/i
const TABLE_REFERENCE = /\b(?:FROM|JOIN)\s+`?([A-Za-z0-9_.]+)`?/gi

/**
 * Assert that a query is one parameterized SELECT over whitelisted tables.
 * @param sql - candidate SQL template.
 * @param allowedTables - table names permitted for this adapter.
 * @returns the trimmed SQL accepted for execution.
 * @throws NilmSourceError with `UNAUTHORIZED_SQL_OPERATION` for every rejected form.
 */
export function assertReadOnlySql(sql: string, allowedTables: readonly string[]): string {
  const trimmed = sql.trim()
  if (trimmed.length === 0) throw reject('empty SQL')
  const body = trimmed.endsWith(';') ? trimmed.slice(0, -1) : trimmed
  if (body.includes(';')) throw reject('multiple statements are forbidden')
  if (/--|#|\/\*/.test(body)) throw reject('SQL comments are forbidden')
  if (!/^SELECT\b/i.test(body)) throw reject('only SELECT statements are allowed')
  if (FORBIDDEN_KEYWORDS.test(body)) throw reject('statement contains a write or administrative keyword')
  if (FORBIDDEN_SELECT.test(body)) throw reject('statement uses a forbidden SELECT clause')
  if (body.includes("'")) throw reject('literal strings are forbidden; bind values as parameters')

  const tables = new Set(allowedTables)
  const referenced: string[] = []
  for (const match of body.matchAll(TABLE_REFERENCE)) {
    const table = match[1]
    if (table === undefined) continue
    referenced.push(table)
  }
  if (referenced.length === 0 && !/^SELECT\s+(?:1|\?)\b/i.test(body)) {
    throw reject('query does not reference a whitelisted table')
  }
  for (const table of referenced) {
    if (!tables.has(table)) throw reject(`table '${table}' is not whitelisted`)
  }
  return trimmed
}

/**
 * Create a stable unauthorized-SQL error.
 * @param reason - diagnostic detail without the original SQL.
 * @returns the typed error.
 */
function reject(reason: string): NilmSourceError {
  return new NilmSourceError('UNAUTHORIZED_SQL_OPERATION', reason)
}
