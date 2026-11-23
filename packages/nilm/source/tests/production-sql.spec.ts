import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { assertReadOnlySql, INFORMATION_SCHEMA_TABLES, NILM_LOCAL_TABLES, NILM_UPSTREAM_TABLES } from '../src/index.ts'

const NILM_ROOT = fileURLToPath(new URL('../../', import.meta.url))
/** Loose match for every call or declaration; the first argument is classified afterwards. */
const CALL_SITE = /\b(queryLocalReadOnly|queryUpstreamReadOnly)\s*(?:<[^()]*>)?\s*\(\s*/g
/** Method declarations (`queryLocalReadOnly(sql: string, ...)`) are not call sites. */
const DECLARATION = /^\w+\s*\??\s*:/

interface UnparsedCall {
  readonly where: string
  readonly head: string
}

interface ProductionQuery {
  readonly where: string
  readonly kind: 'queryLocalReadOnly' | 'queryUpstreamReadOnly'
  readonly sql: string
}

/** @returns every `src/**` TypeScript file under `packages/nilm`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'lib' && entry.name !== 'tests') out.push(...sourceFiles(path))
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && path.includes(`${join('', 'src')}`)) {
      out.push(path)
    }
  }
  return out
}

/** Resolve `${helper()}` interpolations to the template the helper returns in the same file. */
function helperTemplate(source: string, name: string): string {
  const match = new RegExp(`function ${name}\\(\\)[^{]*\\{\\s*return\\s*\`([^\`]*)\``).exec(source)
  if (match === null) throw new Error(`cannot resolve SQL helper ${name}()`)
  return match[1]!
}

/**
 * Replace interpolations with what they render at runtime: placeholder lists,
 * numeric LIMIT/OFFSET, optional predicates, and same-file SQL helpers.
 */
function render(sql: string, source: string): string {
  let text = sql
  for (let depth = 0; depth < 4 && text.includes('${'); depth += 1) {
    text = text.replace(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_whole, expr: string) => {
      const helper = /^\s*(\w+)\(\)\s*$/.exec(expr)
      if (helper !== null) return helperTemplate(source, helper[1]!)
      if (/placeholders/.test(expr)) return '?, ?'
      if (/^\s*String\(/.test(expr)) return '10'
      const optional = /\?\s*''\s*:\s*'([^']*)'/.exec(expr) ?? /\?\s*'([^']*)'\s*:\s*''/.exec(expr)
      if (optional !== null) return optional[1]!
      if (/^\s*clauses\s*$/.test(expr)) return ' AND (terminal_channel_id IN (?, ?) OR asset_id IN (?, ?))'
      throw new Error(`unrecognised SQL interpolation \${${expr}}`)
    })
  }
  return text
}

/** Read a string literal (`, ', ") starting at `index`; returns null for anything else. */
function literalAt(source: string, index: number): string | null {
  const quote = source[index]
  if (quote !== '`' && quote !== "'" && quote !== '"') return null
  const close = source.indexOf(quote, index + 1)
  if (close < 0) return null
  return source.slice(index + 1, close)
}

function scanProduction(): { queries: ProductionQuery[], unparsed: UnparsedCall[] } {
  const queries: ProductionQuery[] = []
  const unparsed: UnparsedCall[] = []
  for (const file of sourceFiles(NILM_ROOT)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(CALL_SITE)) {
      const argStart = match.index + match[0].length
      const rest = source.slice(argStart)
      if (DECLARATION.test(rest)) continue
      const line = source.slice(0, match.index).split('\n').length
      const where = `${file.slice(NILM_ROOT.length)}:${String(line)}`
      const literal = literalAt(source, argStart)
      if (literal === null) {
        unparsed.push({ where, head: rest.slice(0, 40) })
        continue
      }
      queries.push({ where, kind: match[1] as ProductionQuery['kind'], sql: render(literal, source) })
    }
  }
  return { queries, unparsed }
}

const { queries, unparsed } = scanProduction()

describe('production read-only SQL', () => {
  it('finds the production query templates to check', () => {
    expect(queries.length).toBeGreaterThanOrEqual(25)
    expect(queries.some(query => query.kind === 'queryUpstreamReadOnly')).toBe(true)
  })

  it('parses every call site; SQL must be an inline literal', () => {
    expect(unparsed).toEqual([])
  })

  it.each(queries.map(query => [query.where, query] as const))('passes the read-only guard: %s', (_where, query) => {
    const allowed = query.kind === 'queryUpstreamReadOnly'
      ? NILM_UPSTREAM_TABLES
      : [...NILM_LOCAL_TABLES, INFORMATION_SCHEMA_TABLES]
    expect(() => assertReadOnlySql(query.sql, allowed)).not.toThrow()
  })
})
