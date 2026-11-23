/**
 * Application-level SELECT-only query guard for the upstream MySQL adapter.
 * @module @deepseek-ai/dsh-nilm-source/sql-guard
 */

import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'

/** Project-owned tables created by `sql/init-nilm-system.sql`. */
export const NILM_LOCAL_TABLES = [
  'nilm_tenant_config',
  'nilm_asset_snapshot',
  'nilm_source_tenant_map',
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

/** Write, administrative, and MySQL 8.0.19+ `TABLE t` / `VALUES ROW(...)` query-expression keywords. */
const FORBIDDEN_KEYWORDS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'RENAME', 'GRANT', 'REVOKE',
  'CALL', 'MERGE', 'LOAD', 'HANDLER', 'LOCK', 'UNLOCK', 'SET', 'USE', 'EXECUTE', 'PREPARE', 'DEALLOCATE',
  'TABLE', 'VALUES',
])
/** Clause words for `INTO`, locking reads (`FOR UPDATE`, `FOR SHARE`, `NOWAIT`, `SKIP LOCKED`). */
const FORBIDDEN_CLAUSE_WORDS = new Set(['INTO', 'OUTFILE', 'DUMPFILE', 'FOR', 'NOWAIT', 'LOCKED'])
/** Built-ins that read server files, take locks, or block; matched as bare or backtick-quoted names before `(`. */
const FORBIDDEN_FUNCTIONS = new Set([
  'SLEEP', 'BENCHMARK', 'LOAD_FILE',
  'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'IS_FREE_LOCK', 'IS_USED_LOCK',
  'SOURCE_POS_WAIT', 'MASTER_POS_WAIT', 'WAIT_FOR_EXECUTED_GTID_SET', 'WAIT_UNTIL_SQL_THREAD_AFTER_GTIDS',
])
const FROM_TERMINATORS = new Set([
  'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT',
  'WINDOW', 'PROCEDURE', 'FOR', 'LOCK',
])
/** Keywords whose next token is a table source in MySQL SELECT grammar. */
const TABLE_SOURCE_KEYWORDS = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN'])

/** Minimal lexical token; strings and comments are rejected before tokenizing. */
type SqlToken =
  | { readonly kind: 'word', readonly value: string }
  | { readonly kind: 'quoted', readonly value: string }
  | { readonly kind: 'punct', readonly value: string }

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
  if (body.includes("'") || body.includes('"')) throw reject('literal strings are forbidden; bind values as parameters')

  const tokens = tokenize(body)
  assertNoForbiddenWords(tokens)
  if (body.includes('@')) throw reject('user and system variables are forbidden')
  if (hasCommaJoin(tokens)) throw reject('comma joins are forbidden; use explicit JOIN clauses')
  const referenced = collectTableReferences(tokens)
  if (referenced.length === 0 && !/^SELECT\s+(?:1|\?)$/i.test(body)) {
    throw reject('query does not reference a whitelisted table')
  }
  const tables = new Set(allowedTables)
  for (const table of referenced) {
    if (!tables.has(table)) throw reject(`table '${table}' is not whitelisted`)
  }
  return trimmed
}

/**
 * Reject forbidden keywords and clause words among bare words only, so a
 * backtick-quoted column such as `` `values` `` stays legal, and reject
 * forbidden built-ins whether the name is bare or backtick-quoted.
 * @param tokens - token stream of the SELECT body.
 * @throws NilmSourceError with `UNAUTHORIZED_SQL_OPERATION` on the first violation.
 */
function assertNoForbiddenWords(tokens: readonly SqlToken[]): void {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind === 'punct') continue
    const upper = token.value.toUpperCase()
    if (token.kind === 'word' && FORBIDDEN_KEYWORDS.has(upper)) throw reject('statement contains a write or administrative keyword')
    if (token.kind === 'word' && FORBIDDEN_CLAUSE_WORDS.has(upper)) throw reject('statement uses a forbidden SELECT clause')
    if (FORBIDDEN_FUNCTIONS.has(upper) && isPunct(tokens[index + 1], '(')) throw reject('statement uses a forbidden SELECT clause: built-in function')
  }
}

/**
 * Split SQL into words, backtick identifiers, and single-character punctuation.
 * Only ASCII whitespace separates tokens and every non-ASCII character is an
 * identifier character, so look-alike suffixes cannot shorten a table name.
 * @param sql - SELECT body without comments or quoted literals.
 * @returns the token stream.
 */
function tokenize(sql: string): SqlToken[] {
  const tokens: SqlToken[] = []
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    if (/[ \t\r\n\f\v]/.test(char)) {
      index += 1
      continue
    }
    if (char === '`') {
      const end = sql.indexOf('`', index + 1)
      if (end < 0) throw reject('unterminated quoted identifier')
      if (sql[end + 1] === '`') throw reject('escaped backticks in identifiers are forbidden')
      tokens.push({ kind: 'quoted', value: sql.slice(index + 1, end) })
      index = end + 1
      continue
    }
    if (isWordPart(char)) {
      let end = index + 1
      while (end < sql.length && isWordPart(sql[end]!)) end += 1
      tokens.push({ kind: 'word', value: sql.slice(index, end) })
      index = end
      continue
    }
    tokens.push({ kind: 'punct', value: char })
    index += 1
  }
  return tokens
}

/**
 * Detect a comma-separated table source in any FROM clause, including those of
 * subqueries and UNION branches, while allowing commas in parenthesized lists.
 * @param tokens - token stream of the SELECT body.
 * @returns true when some FROM clause contains a comma at its own nesting level.
 * @throws NilmSourceError when parentheses are unbalanced.
 */
function hasCommaJoin(tokens: readonly SqlToken[]): boolean {
  const inFrom: boolean[] = [false]
  for (const token of tokens) {
    if (token.kind === 'punct') {
      if (token.value === '(') {
        inFrom.push(false)
      } else if (token.value === ')') {
        if (inFrom.length === 1) throw reject('unbalanced parentheses')
        inFrom.pop()
      } else if (token.value === ',' && inFrom[inFrom.length - 1] === true) {
        return true
      }
      continue
    }
    if (token.kind !== 'word') continue
    const word = token.value.toUpperCase()
    if (word === 'FROM') inFrom[inFrom.length - 1] = true
    else if (FROM_TERMINATORS.has(word)) inFrom[inFrom.length - 1] = false
  }
  if (inFrom.length !== 1) throw reject('unbalanced parentheses')
  return false
}

/**
 * Collect every table named after FROM / JOIN / STRAIGHT_JOIN. A parenthesized
 * source must be a derived-table subquery, whose own FROM is collected in turn.
 * @param tokens - token stream of the SELECT body.
 * @returns fully qualified table names as written (`schema.table` or `table`).
 * @throws NilmSourceError for parenthesized table lists or non-identifier sources.
 */
function collectTableReferences(tokens: readonly SqlToken[]): string[] {
  const referenced: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind !== 'word' || !TABLE_SOURCE_KEYWORDS.has(token.value.toUpperCase())) continue
    let cursor = index + 1
    let parens = 0
    while (isPunct(tokens[cursor], '(')) {
      cursor += 1
      parens += 1
    }
    if (parens > 0) {
      const next = tokens[cursor]
      if (next?.kind === 'word' && next.value.toUpperCase() === 'SELECT') continue
      throw reject('parenthesized table references are forbidden')
    }
    referenced.push(readQualifiedName(tokens, cursor))
  }
  return referenced
}

/**
 * Read `ident(.ident)*` starting at a table-source position.
 * @param tokens - token stream.
 * @param start - index of the first name part.
 * @returns dot-joined name parts.
 * @throws NilmSourceError when the source is not an identifier.
 */
function readQualifiedName(tokens: readonly SqlToken[], start: number): string {
  const parts: string[] = []
  let cursor = start
  for (;;) {
    const token = tokens[cursor]
    if (token === undefined || token.kind === 'punct') throw reject('unsupported table source')
    if (token.kind === 'quoted' && token.value.includes('.')) throw reject('quoted identifiers must not contain dots')
    parts.push(token.value)
    if (!isPunct(tokens[cursor + 1], '.')) return parts.join('.')
    cursor += 2
  }
}

/** @param token - candidate token. @param value - punctuation. @returns true on match. */
function isPunct(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === 'punct' && token.value === value
}

/** @param char - candidate character. @returns true for an identifier character (MySQL allows `$` and non-ASCII). */
function isWordPart(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) >= 0x80
}

/**
 * Create a stable unauthorized-SQL error.
 * @param reason - diagnostic detail without the original SQL.
 * @returns the typed error.
 */
function reject(reason: string): NilmSourceError {
  return new NilmSourceError('UNAUTHORIZED_SQL_OPERATION', reason)
}
