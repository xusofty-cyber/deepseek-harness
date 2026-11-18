import { describe, expect, it } from 'vitest'
import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'
import { loadSourceConfigFromEnv } from '../src/index.ts'

const REQUIRED = {
  NILM_LOCAL_MYSQL_HOST: 'local-db',
  NILM_LOCAL_MYSQL_USER: 'local-user',
  NILM_LOCAL_MYSQL_PASSWORD: 'local-secret',
  NILM_LOCAL_MYSQL_DATABASE: 'nilm_system',
  NILM_UPSTREAM_MYSQL_HOST: 'upstream-db',
  NILM_UPSTREAM_MYSQL_USER: 'readonly-user',
  NILM_UPSTREAM_MYSQL_PASSWORD: 'upstream-secret',
  NILM_UPSTREAM_MYSQL_DATABASE: 'tpim_system',
  NILM_UPSTREAM_TDENGINE_HOT_URL: 'http://hot:6041/rest/sql/tpim_system',
  NILM_UPSTREAM_TDENGINE_STATS_URL: 'http://stats:6041/rest/sql/tpim_system',
  NILM_COLD_PROXY_URL: 'http://cold-proxy:8080/query',
}

describe('loadSourceConfigFromEnv', () => {
  it('loads every endpoint from the environment', () => {
    const config = loadSourceConfigFromEnv(REQUIRED)
    expect(config.localMysql.database).toBe('nilm_system')
    expect(config.localMysql.port).toBe(3306)
    expect(config.upstreamMysql.user).toBe('readonly-user')
    expect(config.coldProxyTimeoutMs).toBe(5000)
    expect(config.probeTimeoutMs).toBe(1000)
    expect(config.tdengineUser).toBeUndefined()
  })

  it('rejects a missing required endpoint', () => {
    const env = { ...REQUIRED }
    delete (env as Partial<typeof REQUIRED>).NILM_COLD_PROXY_URL
    expect(() => loadSourceConfigFromEnv(env)).toThrow(NilmSourceError)
    expect(() => loadSourceConfigFromEnv(env)).toThrow('NILM_COLD_PROXY_URL')
  })

  it('rejects an invalid port', () => {
    expect(() => loadSourceConfigFromEnv({ ...REQUIRED, NILM_LOCAL_MYSQL_PORT: '70000' })).toThrow('integer TCP port')
    expect(() => loadSourceConfigFromEnv({ ...REQUIRED, NILM_LOCAL_MYSQL_PORT: 'abc' })).toThrow('integer TCP port')
  })

  it('keeps optional TDengine credentials when both are supplied', () => {
    const config = loadSourceConfigFromEnv({
      ...REQUIRED,
      NILM_UPSTREAM_TDENGINE_USER: 'td-user',
      NILM_UPSTREAM_TDENGINE_PASSWORD: 'td-secret',
    })
    expect(config.tdengineUser).toBe('td-user')
    expect(config.tdenginePassword).toBe('td-secret')
  })
})
