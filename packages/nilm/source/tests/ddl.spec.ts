import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { NILM_LOCAL_TABLES } from '../src/index.ts'

const ddl = readFileSync(new URL('../sql/init-nilm-system.sql', import.meta.url), 'utf8')

describe('init-nilm-system.sql', () => {
  it('creates exactly the nineteen design tables', () => {
    const tables = [...ddl.matchAll(/CREATE TABLE `([^`]+)`/g)].map(match => match[1])
    expect(tables).toHaveLength(19)
    expect(new Set(tables)).toEqual(new Set(NILM_LOCAL_TABLES))
  })

  it('keeps tenant-scoped lookup indexes on the conversational tables', () => {
    expect(ddl).toContain('uk_tenant_user_conv')
    expect(ddl).toContain('uk_client_msg')
    expect(ddl).toContain('uk_tenant_dedupe')
    expect(ddl).toContain('uk_tenant_notification_user_channel')
    expect(ddl).toContain('uk_tenant_dedupe_user_channel')
    expect(ddl).toContain('uk_tenant_plan_period')
    expect(ddl).toContain('uk_source_tenant')
  })
})
