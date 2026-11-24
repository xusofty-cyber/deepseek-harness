import { describe, expect, it } from 'vitest'
import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import { assertReadOnlySql, INFORMATION_SCHEMA_TABLES, NILM_LOCAL_TABLES, NILM_UPSTREAM_TABLES } from '../src/index.ts'

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
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config, secret_table', allowed)).toThrow('comma joins')
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config a, nilm_asset_snapshot b', allowed)).toThrow('comma joins')
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config AS a, nilm_asset_snapshot b', allowed)).toThrow('comma joins')
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config JOIN nilm_asset_snapshot AS b, secret_table', allowed)).toThrow('comma joins')
    expect(() => assertReadOnlySql('SELECT * FROM nilm_tenant_config t JOIN nilm_asset_snapshot s ON t.tenant_id = s.tenant_id, secret_table x', allowed)).toThrow('comma joins')
  })

  it('allows commas inside parenthesized expressions and clause-local lists', () => {
    expect(assertReadOnlySql('SELECT * FROM nilm_tenant_config WHERE tenant_id IN (?, ?) GROUP BY tenant_id, status', allowed))
      .toContain('GROUP BY')
  })

  it('treats STRAIGHT_JOIN right after SELECT as the select modifier, not a join', () => {
    expect(assertReadOnlySql('SELECT STRAIGHT_JOIN tenant_id FROM nilm_tenant_config', allowed))
      .toContain('STRAIGHT_JOIN')
    expect(assertReadOnlySql('SELECT DISTINCT HIGH_PRIORITY STRAIGHT_JOIN t.tenant_id FROM nilm_tenant_config t STRAIGHT_JOIN nilm_asset_snapshot s ON t.tenant_id = s.tenant_id', allowed))
      .toContain('HIGH_PRIORITY')
    expect(() => assertReadOnlySql('SELECT STRAIGHT_JOIN tenant_id FROM secret_table', allowed)).toThrow('not whitelisted')
    expect(() => assertReadOnlySql('SELECT STRAIGHT_JOIN tenant_id FROM nilm_tenant_config STRAIGHT_JOIN secret_table', allowed)).toThrow('not whitelisted')
  })

  it('resolves CTE names inside their scope while still checking every CTE body', () => {
    expect(assertReadOnlySql('WITH s AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM s', allowed))
      .toContain('WITH')
    expect(assertReadOnlySql('WITH a AS (SELECT tenant_id FROM nilm_tenant_config), b (id) AS (SELECT tenant_id FROM a) SELECT id FROM b JOIN `a` ON b.id = a.tenant_id', allowed))
      .toContain('b (id)')
    expect(assertReadOnlySql('SELECT * FROM (WITH s AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM s) d', allowed))
      .toContain('(WITH')
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config INTERSECT (WITH s AS (SELECT tenant_id FROM nilm_asset_snapshot) SELECT tenant_id FROM s)', allowed))
      .toContain('INTERSECT')
    expect(assertReadOnlySql('WITH s AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM nilm_asset_snapshot WHERE tenant_id IN (SELECT tenant_id FROM s)', allowed))
      .toContain('IN (')
    expect(assertReadOnlySql('SELECT tenant_id, COUNT(*) FROM nilm_tenant_config GROUP BY tenant_id WITH ROLLUP', allowed))
      .toContain('ROLLUP')
  })

  it('rejects empty SQL and queries without a table reference', () => {
    expect(() => assertReadOnlySql('   ', allowed)).toThrow('empty SQL')
    expect(() => assertReadOnlySql('SELECT NOW()', allowed)).toThrow('does not reference')
  })

  it.each([
    ['SELECT * FROM nilm_tenant_config STRAIGHT_JOIN secret_table', 'not whitelisted'],
    ['SELECT * FROM nilm_tenant_config straight_join secret_table', 'not whitelisted'],
    ['SELECT * FROM nilm_tenant_config JOIN (secret_table)', 'parenthesized'],
    ['SELECT * FROM nilm_tenant_config JOIN ((nilm_asset_snapshot, secret_table))', 'parenthesized'],
    ['SELECT * FROM ((SELECT tenant_id FROM nilm_tenant_config) s, secret_table)', 'parenthesized'],
    ['SELECT * FROM `nilm_tenant_config`.`secret_table`', 'not whitelisted'],
    ['SELECT * FROM nilm_tenant_config WHERE tenant_id IN (SELECT tenant_id FROM nilm_asset_snapshot, secret_table)', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config UNION SELECT * FROM nilm_asset_snapshot, secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config\u00e9', 'not whitelisted'],
    ['SELECT * FROM "secret_table"', 'literal strings'],
    ['SELECT * FROM nilm_tenant_config WHERE (tenant_id = ?', 'unbalanced'],
    ['SELECT * FROM nilm_unsafe_record UNION TABLE secret_table', 'administrative keyword'],
    ['SELECT * FROM nilm_unsafe_record WHERE EXISTS (TABLE secret_table)', 'administrative keyword'],
    ['SELECT * FROM nilm_unsafe_record UNION VALUES ROW(?)', 'administrative keyword'],
    ['SELECT * FROM nilm_tenant_config intersect, secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config AS intersect, secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config except, secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config window, secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config WHERE EXISTS (SELECT 1 FROM nilm_tenant_config intersect, secret_table)', 'comma joins'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) intersect (c), secret_table', 'comma joins'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) AS except (c), secret_table', 'comma joins'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) except(c),secret_table WHERE 1 = 1', 'comma joins'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) intersect (select), secret_table', 'comma joins'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) intersect ((c)), secret_table', 'set operator operand'],
    ['SELECT * FROM (SELECT record_id FROM nilm_unsafe_record) AS window (c), secret_table', 'comma joins'],
    ['SELECT * FROM nilm_tenant_config intersect (secret_table)', 'column lists'],
    ['SELECT * FROM nilm_tenant_config AS except (secret_table)', 'column lists'],
    ['SELECT * FROM nilm_tenant_config WINDOW w AS (ORDER BY tenant_id), secret_table', 'window definitions'],
    ['SELECT * FROM nilm_tenant_config WINDOW w AS (ORDER BY tenant_id), w2 AS (), secret_table', 'window definitions'],
    ['SELECT * FROM nilm_tenant_config procedure, secret_table', 'forbidden SELECT'],
    ['WITH s AS (SELECT tenant_id FROM secret_table) SELECT tenant_id FROM s', 'not whitelisted'],
    ['SELECT * FROM (WITH secret_table AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM secret_table) d JOIN secret_table', 'not whitelisted'],
    ['WITH a AS (SELECT tenant_id FROM secret_table), secret_table AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM a', 'not whitelisted'],
    ['WITH S AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM s', 'not whitelisted'],
    ['WITH s AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM other_db.s', 'not whitelisted'],
    ['WITH s AS (SELECT tenant_id FROM nilm_tenant_config) SELECT tenant_id FROM s, secret_table', 'comma joins'],
    ['WITH RECURSIVE r AS (SELECT 1 UNION ALL SELECT 1 FROM r) SELECT * FROM r', 'recursive'],
    ['WITH s AS ((SELECT tenant_id FROM nilm_tenant_config)) SELECT tenant_id FROM s', 'CTE bodies'],
  ])('rejects table-source bypass %s', (sql: string, message: string) => {
    expect(() => assertReadOnlySql(sql, allowed)).toThrow(message)
  })

  it('accepts derived-table subqueries and the qualified metadata table', () => {
    expect(assertReadOnlySql('SELECT s.tenant_id FROM (SELECT tenant_id FROM nilm_tenant_config WHERE tenant_id IN (?, ?)) s JOIN nilm_asset_snapshot a ON a.tenant_id = s.tenant_id', allowed))
      .toContain('JOIN')
    expect(assertReadOnlySql('SELECT table_name AS tableName FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [INFORMATION_SCHEMA_TABLES]))
      .toContain('information_schema')
  })

  it.each([
    ['SELECT LOAD_FILE(?) FROM nilm_unsafe_record', 'forbidden SELECT'],
    ['SELECT * FROM nilm_unsafe_record WHERE GET_LOCK(?, 10)', 'forbidden SELECT'],
    ['SELECT * FROM nilm_unsafe_record WHERE RELEASE_LOCK(?)', 'forbidden SELECT'],
    ['SELECT record_id FROM nilm_unsafe_record INTO @x', 'forbidden SELECT'],
    ['SELECT * FROM nilm_unsafe_record WHERE record_id = @@version', 'variables'],
    ['SELECT * FROM nilm_unsafe_record WHERE record_id = @x', 'variables'],
    ['SELECT * FROM nilm_alert_rule WHERE `SLEEP`(?) = 0', 'forbidden SELECT'],
    ['SELECT `BENCHMARK`(?, MD5(rule_id)) FROM nilm_alert_rule', 'forbidden SELECT'],
    ['SELECT `GET_LOCK`(rule_id, ?) FROM nilm_alert_rule', 'forbidden SELECT'],
    ['SELECT `load_file`(rule_id) FROM nilm_alert_rule', 'forbidden SELECT'],
    ['SELECT * FROM nilm_alert_rule WHERE SLEEP\n(?) = 0', 'forbidden SELECT'],
    ['SELECT rule_id FROM nilm_alert_rule FOR SHARE', 'forbidden SELECT'],
    ['SELECT rule_id FROM nilm_alert_rule FOR UPDATE NOWAIT', 'forbidden SELECT'],
    ['SELECT rule_id FROM nilm_alert_rule FOR UPDATE SKIP LOCKED', 'forbidden SELECT'],
    ['SELECT rule_id FROM nilm_alert_rule INTO OUTFILE ?', 'forbidden SELECT'],
    ['SELECT * FROM nilm_alert_rule WHERE SOURCE_POS_WAIT(?, ?, ?) = 0', 'forbidden SELECT'],
    ['SELECT * FROM nilm_alert_rule WHERE MASTER_POS_WAIT(?, ?, ?) = 0', 'forbidden SELECT'],
    ['SELECT * FROM nilm_alert_rule WHERE WAIT_FOR_EXECUTED_GTID_SET(?, ?) = 0', 'forbidden SELECT'],
  ])('rejects dangerous function or variable use %s', (sql: string, message: string) => {
    expect(() => assertReadOnlySql(sql, allowed)).toThrow(message)
  })

  it('still ends FROM at INTERSECT / EXCEPT / WINDOW in their operator shape', () => {
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config INTERSECT SELECT tenant_id FROM nilm_asset_snapshot', allowed))
      .toContain('INTERSECT')
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config EXCEPT ALL (SELECT tenant_id FROM nilm_asset_snapshot)', allowed))
      .toContain('EXCEPT')
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config INTERSECT (SELECT tenant_id FROM nilm_asset_snapshot)', allowed))
      .toContain('INTERSECT')
    expect(assertReadOnlySql('SELECT tenant_id FROM nilm_tenant_config EXCEPT ((SELECT tenant_id FROM nilm_asset_snapshot))', allowed))
      .toContain('EXCEPT')
    expect(assertReadOnlySql('SELECT tenant_id, ROW_NUMBER() OVER w FROM nilm_tenant_config WINDOW w AS (ORDER BY tenant_id, tenant_name)', allowed))
      .toContain('WINDOW')
    expect(assertReadOnlySql('SELECT ROW_NUMBER() OVER w, RANK() OVER w2 FROM nilm_tenant_config WINDOW w AS (ORDER BY tenant_id), w2 AS (PARTITION BY tenant_id) ORDER BY tenant_id, tenant_name', allowed))
      .toContain('w2 AS')
  })

  it('checks keywords on bare words only, so backtick-quoted columns and aliases stay legal', () => {
    expect(assertReadOnlySql('SELECT `values`, rule_id AS `table` FROM nilm_alert_rule WHERE tenant_id = ?', allowed))
      .toContain('`values`')
    expect(assertReadOnlySql('SELECT sleep_minutes FROM nilm_alert_rule WHERE tenant_id = ?', allowed))
      .toContain('sleep_minutes')
  })

  it.each([
    ['SELECT 1, USER(), VERSION(), DATABASE()'],
    ['SELECT ? , CURRENT_USER()'],
    ['SELECT 1 UNION SELECT CURRENT_USER'],
  ])('narrows the table-less probe exemption to SELECT 1 / SELECT ?: rejects %s', (sql: string) => {
    expect(() => assertReadOnlySql(sql, allowed)).toThrow('does not reference')
  })
})
