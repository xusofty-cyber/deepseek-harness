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
/** Clause words for `INTO`, locking reads (`FOR UPDATE`, `FOR SHARE`, `NOWAIT`, `SKIP LOCKED`), and the reserved `PROCEDURE` clause. */
const FORBIDDEN_CLAUSE_WORDS = new Set(['INTO', 'OUTFILE', 'DUMPFILE', 'FOR', 'NOWAIT', 'LOCKED', 'PROCEDURE'])
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
/** Set operators that only end a FROM clause when a query expression follows. */
const SET_OPERATOR_STARTS = new Set(['SELECT', 'ALL', 'DISTINCT'])
/** Words that open a parenthesized query expression after a set operator. */
const QUERY_EXPRESSION_STARTS = new Set(['SELECT', 'WITH'])
/** Non-reserved words that end FROM only in operator shape and are aliases after `AS`. */
const FROM_ALIAS_KEYWORDS = new Set(['INTERSECT', 'EXCEPT', 'WINDOW'])
/** Keywords whose next token is a table source in MySQL SELECT grammar. */
const TABLE_SOURCE_KEYWORDS = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN'])
/**
 * Reserved words that may directly precede the `STRAIGHT_JOIN` select modifier
 * (`SELECT [ALL|DISTINCT|DISTINCTROW] [HIGH_PRIORITY] STRAIGHT_JOIN ...`). None
 * can end a table reference, so `STRAIGHT_JOIN` after them is never a join.
 */
const SELECT_MODIFIER_PREFIXES = new Set(['SELECT', 'ALL', 'DISTINCT', 'DISTINCTROW', 'HIGH_PRIORITY'])

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
  if (!/^(?:SELECT|WITH)\b/i.test(body)) throw reject('only SELECT statements are allowed')
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
  // Per nesting level: inside a FROM clause, inside a WINDOW clause, or neither.
  const clause: Array<'from' | 'window' | 'none'> = ['none']
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind === 'punct') {
      if (token.value === '(') {
        clause.push('none')
      } else if (token.value === ')') {
        if (clause.length === 1) throw reject('unbalanced parentheses')
        clause.pop()
      } else if (token.value === ',') {
        const current = clause[clause.length - 1]
        if (current === 'from') return true
        // `WINDOW w AS (...), w2 AS (...)`: every later member must itself be a
        // window definition; anything else is malformed and rejected here.
        if (current === 'window' && !isWindowDefinition(tokens, index + 1)) {
          throw reject('WINDOW clause commas must separate window definitions')
        }
      }
      continue
    }
    if (token.kind !== 'word') continue
    const word = token.value.toUpperCase()
    const level = clause.length - 1
    if (word === 'FROM') clause[level] = 'from'
    else if (endsFromClause(tokens, index, word, clause[level] === 'from')) clause[level] = word === 'WINDOW' ? 'window' : 'none'
  }
  if (clause.length !== 1) throw reject('unbalanced parentheses')
  return false
}

/**
 * Decide whether a bare word ends the current FROM clause. `INTERSECT`,
 * `EXCEPT`, and `WINDOW` are non-reserved before MySQL 8.0.31 / 8.0.2, so
 * `FROM t intersect, secret` aliases `t` and keeps the comma join live. They
 * end the clause only in their operator shape: `INTERSECT|EXCEPT` before
 * `SELECT` / `ALL` / `DISTINCT` / `(SELECT` / `(WITH` / `((`, and
 * `WINDOW name AS (`. After `AS` they are always aliases, and
 * `intersect (c), secret` is an alias with a derived-table column list.
 * @param tokens - token stream.
 * @param index - position of the word.
 * @param word - upper-cased word value.
 * @returns true when the word terminates the FROM clause.
 */
function endsFromClause(tokens: readonly SqlToken[], index: number, word: string, inFromClause: boolean): boolean {
  const previous = tokens[index - 1]
  // `t AS intersect` / `t AS window`: after AS the word can only be an alias.
  if (FROM_ALIAS_KEYWORDS.has(word) && previous?.kind === 'word' && previous.value.toUpperCase() === 'AS') {
    if (inFromClause && isPunct(tokens[index + 1], '(')) assertDerivedColumnList(tokens[index - 2])
    return false
  }
  if (word === 'INTERSECT' || word === 'EXCEPT') {
    const next = tokens[index + 1]
    if (isPunct(next, '(')) {
      // `intersect (SELECT ...)` / `intersect ((SELECT ...))` is the operator:
      // after every opening parenthesis a query expression must actually start,
      // so `intersect (select)` and `intersect ((c))` are not mistaken for it.
      let cursor = index + 1
      while (isPunct(tokens[cursor], '(')) cursor += 1
      const depth = cursor - index - 1
      const inner = tokens[cursor]
      const after = tokens[cursor + 1]
      if (inner?.kind === 'word' && QUERY_EXPRESSION_STARTS.has(inner.value.toUpperCase())
        && after !== undefined && !isPunct(after, ')') && !isPunct(after, ',')) return true
      // `intersect (c), secret` is a derived-table alias with a column list; a
      // column list is never nested, so `intersect ((c))` is rejected outright.
      if (inFromClause) {
        if (depth > 1) throw reject('malformed set operator operand')
        assertDerivedColumnList(previous)
      }
      return false
    }
    return next?.kind === 'word' && SET_OPERATOR_STARTS.has(next.value.toUpperCase())
  }
  if (word === 'WINDOW') return isWindowDefinition(tokens, index + 1)
  return FROM_TERMINATORS.has(word)
}

/**
 * A column list after an alias is legal only for a derived table, i.e. when
 * the source right before the alias closes a subquery. `FROM t intersect
 * (secret)` is malformed, so it is rejected instead of left for the server.
 * @param source - token right before the alias (or before `AS`).
 * @throws NilmSourceError when the aliased source is not a derived table.
 */
function assertDerivedColumnList(source: SqlToken | undefined): void {
  if (!isPunct(source, ')')) throw reject('derived-table column lists must follow a derived table')
}

/**
 * @param tokens - token stream.
 * @param start - position of the candidate window name.
 * @returns true for `name AS (` starting at `start`.
 */
function isWindowDefinition(tokens: readonly SqlToken[], start: number): boolean {
  const name = tokens[start]
  const as = tokens[start + 1]
  return name !== undefined && name.kind !== 'punct'
    && as?.kind === 'word' && as.value.toUpperCase() === 'AS'
    && isPunct(tokens[start + 2], '(')
}

/**
 * Collect every table named after FROM / JOIN / STRAIGHT_JOIN. A parenthesized
 * source must be a derived-table subquery, whose own FROM is collected in turn.
 * @param tokens - token stream of the SELECT body.
 * @returns fully qualified table names as written (`schema.table` or `table`).
 * @throws NilmSourceError for parenthesized table lists or non-identifier sources.
 */
function collectTableReferences(tokens: readonly SqlToken[]): string[] {
  const cteScopes = collectCteScopes(tokens)
  const referenced: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind !== 'word' || !TABLE_SOURCE_KEYWORDS.has(token.value.toUpperCase())) continue
    if (token.value.toUpperCase() === 'STRAIGHT_JOIN' && isSelectModifierPosition(tokens[index - 1])) continue
    let cursor = index + 1
    let parens = 0
    while (isPunct(tokens[cursor], '(')) {
      cursor += 1
      parens += 1
    }
    if (parens > 0) {
      // Only `( SELECT ...` is a derived table. `((SELECT ...) s, t)` is a
      // parenthesized table-reference list whose later members follow no
      // FROM/JOIN keyword, so any deeper nesting is rejected, not scanned.
      const next = tokens[cursor]
      if (parens === 1 && next?.kind === 'word' && QUERY_EXPRESSION_STARTS.has(next.value.toUpperCase())) continue
      throw reject('parenthesized table references are forbidden')
    }
    const name = readQualifiedName(tokens, cursor)
    // An unqualified name inside a CTE's scope reads the CTE, whose own body
    // was already checked; every other name must be a whitelisted table.
    if (cteScopes.some(scope => scope.name === name && cursor >= scope.from && cursor < scope.to)) continue
    referenced.push(name)
  }
  return referenced
}

/** A CTE name and the token range in which an unqualified reference resolves to it. */
interface CteScope {
  readonly name: string
  readonly from: number
  readonly to: number
}

/**
 * Parse every `WITH name [(cols)] AS (SELECT ...) [, ...] SELECT` clause and
 * record where each name is visible. A WITH clause opens a query expression
 * only at the start of the statement or right after `(`; any other `WITH`
 * (`GROUP BY a WITH ROLLUP`) is ignored here, so names never become CTEs by
 * accident. A name is visible from the end of its own body to the end of the
 * enclosing parenthesis level (or statement): later CTE bodies, the main query,
 * and its subqueries. It is not visible in its own or earlier bodies, where
 * MySQL resolves the name to a base table, so those references stay checked.
 * Names match case-sensitively; a differently cased reference is treated as a
 * table and must be whitelisted. `WITH RECURSIVE` is rejected outright.
 * @param tokens - balanced token stream of the SELECT body.
 * @returns visibility ranges, one per CTE.
 * @throws NilmSourceError for recursive or malformed WITH clauses.
 */
function collectCteScopes(tokens: readonly SqlToken[]): CteScope[] {
  const closeOf = new Map<number, number>()
  const enclosing: number[] = []
  const stack: number[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    enclosing.push(stack[stack.length - 1] ?? -1)
    if (isPunct(tokens[index], '(')) stack.push(index)
    else if (isPunct(tokens[index], ')')) {
      const open = stack.pop()
      if (open !== undefined) closeOf.set(open, index)
    }
  }
  const scopes: CteScope[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isWord(tokens[index], 'WITH') || (index > 0 && !isPunct(tokens[index - 1], '('))) continue
    const open = enclosing[index]!
    const scopeEnd = open < 0 ? tokens.length : closeOf.get(open) ?? tokens.length
    let cursor = index + 1
    if (isWord(tokens[cursor], 'RECURSIVE')) throw reject('recursive CTEs are forbidden')
    for (;;) {
      const name = tokens[cursor]
      if (name === undefined || name.kind === 'punct') throw reject('malformed WITH clause')
      cursor += 1
      if (isPunct(tokens[cursor], '(')) cursor = (closeOf.get(cursor) ?? tokens.length) + 1
      if (!isWord(tokens[cursor], 'AS') || !isPunct(tokens[cursor + 1], '(')) throw reject('malformed WITH clause')
      const bodyOpen = cursor + 1
      if (!isWord(tokens[bodyOpen + 1], 'SELECT')) throw reject('CTE bodies must be plain SELECT queries')
      const bodyClose = closeOf.get(bodyOpen)
      if (bodyClose === undefined) throw reject('malformed WITH clause')
      scopes.push({ name: name.value, from: bodyClose + 1, to: scopeEnd })
      cursor = bodyClose + 1
      if (isPunct(tokens[cursor], ',')) {
        cursor += 1
        continue
      }
      if (!isWord(tokens[cursor], 'SELECT')) throw reject('a WITH clause must be followed by SELECT')
      break
    }
  }
  return scopes
}

/**
 * @param previous - bare word right before a `STRAIGHT_JOIN` token.
 * @returns true when `STRAIGHT_JOIN` is the SELECT modifier, not a join.
 */
function isSelectModifierPosition(previous: SqlToken | undefined): boolean {
  return previous?.kind === 'word' && SELECT_MODIFIER_PREFIXES.has(previous.value.toUpperCase())
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

/** @param token - candidate token. @param value - upper-case keyword. @returns true for that bare word. */
function isWord(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === 'word' && token.value.toUpperCase() === value
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
