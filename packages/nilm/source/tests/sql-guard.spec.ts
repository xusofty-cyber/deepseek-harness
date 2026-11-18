import { describe, expect, it } from 'vitest'
import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import { assertReadOnlySql, NILM_LOCAL_TABLES, NILM_UPSTREAM_TABLES } from '../src/index.ts'

const allowed = [...NILM_LOCAL_TABLES, ...NILM_UPSTREAM_TABLES]

describe('assertReadOnlySql', () => {
  it('accepts one parameterized SELECT over whitelisted tables', () => {
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config WHERE tenant_id = ?', allowed))
      .toBe('SELECT tenant_id FROM nilm_tenant_config WHERE tenant_id = ?')
    expect(assertReadOnlySql('SELECT a.node_id FROM nilm_alert_event a JOIN nilm_alert_rule r ON a.rule_id = r.rule_id', allowed))
      .toContain('JOIN')
    expect(assertReadOnlySql('SELECT 1', [])).toBe('SELECT 1')
  })

  it.each([
    ['INSERT INTO nilm_tenant_config VALUES (?)'],
    ['UPDATE nilm_tenant_config SET status = ?'],
    ['DELETE FROM nilm_tenant_config WHERE tenant_id = ?'],
    ['DROP TABLE nilm_tenant_config'],
    ['TRUNCATE nilm_tenant_config'],
    ['ALTER TABLE nilm_tenant_config ADD COLUMN x INT'],
  ])('rejects write statement %s', (sql: string) => {
    let thrown: unknown
    try { assertReadOnlySql(sql, allowed) } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(NilmSourceError)
    expect((thrown as NilmSourceError).code).toBe('UNAUTHORIZED_SQL_OPERATION')
  })

  it('rejects multiple statements, comments, literals, and non-whitelisted tables', () => {
    expect(() => assertReadOnlySql('SELECT 1; DROP TABLE nilm_tenant_config', allowed)).toThrow('multiple statements')
    expect(() => assertReadOnlySql('SELECT 1 -- comment', allowed)).toThrow('comments')
    expect(() => assertReadOnlySql("SELECT tenant_id FROM nilm_tenant_config WHERE tenant_id = 'tenant-a'", allowed)).toThrow('literal strings')
    expect(() => assertReadOnlySql('SELECT * FROM secret_table', allowed)).toThrow('not whitelisted')
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config INTO OUTFILE ?', allowed)).toThrow('forbidden SELECT')
  })

  it('rejects empty SQL and queries without a table reference', () => {
    expect(() => assertReadOnlySql('   ', allowed)).toThrow('empty SQL')
    expect(() => assertReadOnlySql('SELECT NOW()', allowed)).toThrow('does not reference')
  })
})
