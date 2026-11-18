/**
 * Source configuration and environment loading with no embedded credentials.
 * @module @deepseek-ai/dsh-nilm-source/config
 */

import z from '@deepseek-ai/schemastery'
import { NilmSourceError } from '@deepseek-ai/dsh-nilm-core'

/** One MySQL endpoint used by the source adapter. */
export interface MysqlEndpointConfig {
  /** Host name or address. */
  host: string
  /** TCP port. */
  port: number
  /** Login account. */
  user: string
  /** Login password supplied by the deployment secret. */
  password: string
  /** Database name. */
  database: string
}

/** Complete source-adapter configuration, normally supplied by a profile patch. */
export interface Config {
  /** Project-owned `nilm_system` database. */
  localMysql: MysqlEndpointConfig
  /** Read-only upstream business database. */
  upstreamMysql: MysqlEndpointConfig
  /** TDengine REST endpoint for the hot database. */
  tdengineHotUrl: string
  /** TDengine REST endpoint for day/hour statistics. */
  tdengineStatsUrl: string
  /** Cold-warehouse read-only proxy base URL. */
  coldProxyUrl: string
  /** Optional TDengine REST account. */
  tdengineUser?: string
  /** Optional TDengine REST password. */
  tdenginePassword?: string
  /** Maximum concurrent MySQL connections per pool. */
  mysqlConnectionLimit: number
  /** TDengine request timeout. */
  tdengineTimeoutMs: number
  /** Cold-proxy request timeout; the design contract fixes five seconds. */
  coldProxyTimeoutMs: number
  /** Connectivity gate budget for the complete probe. */
  probeTimeoutMs: number
}

const mysqlEndpoint = z.object({
  host: z.string().required(),
  port: z.natural().min(1).max(65535).default(3306),
  user: z.string().required(),
  password: z.string().required(),
  database: z.string().required(),
})

/** Cordis configuration schema for {@link Config}. */
export const Config: z<Config> = z.object({
  localMysql: mysqlEndpoint.required(),
  upstreamMysql: mysqlEndpoint.required(),
  tdengineHotUrl: z.string().required(),
  tdengineStatsUrl: z.string().required(),
  coldProxyUrl: z.string().required(),
  tdengineUser: z.string(),
  tdenginePassword: z.string(),
  mysqlConnectionLimit: z.natural().min(1).default(10),
  tdengineTimeoutMs: z.natural().min(1).default(3000),
  coldProxyTimeoutMs: z.natural().min(1).default(5000),
  probeTimeoutMs: z.natural().min(1).default(1000),
})

/** Environment variable names read by {@link loadSourceConfigFromEnv}. */
export const SOURCE_ENV = {
  localMysqlHost: 'NILM_LOCAL_MYSQL_HOST',
  localMysqlPort: 'NILM_LOCAL_MYSQL_PORT',
  localMysqlUser: 'NILM_LOCAL_MYSQL_USER',
  localMysqlPassword: 'NILM_LOCAL_MYSQL_PASSWORD',
  localMysqlDatabase: 'NILM_LOCAL_MYSQL_DATABASE',
  upstreamMysqlHost: 'NILM_UPSTREAM_MYSQL_HOST',
  upstreamMysqlPort: 'NILM_UPSTREAM_MYSQL_PORT',
  upstreamMysqlUser: 'NILM_UPSTREAM_MYSQL_USER',
  upstreamMysqlPassword: 'NILM_UPSTREAM_MYSQL_PASSWORD',
  upstreamMysqlDatabase: 'NILM_UPSTREAM_MYSQL_DATABASE',
  tdengineHotUrl: 'NILM_UPSTREAM_TDENGINE_HOT_URL',
  tdengineStatsUrl: 'NILM_UPSTREAM_TDENGINE_STATS_URL',
  tdengineUser: 'NILM_UPSTREAM_TDENGINE_USER',
  tdenginePassword: 'NILM_UPSTREAM_TDENGINE_PASSWORD',
  coldProxyUrl: 'NILM_COLD_PROXY_URL',
} as const

/**
 * Read one required environment variable.
 * @param env - environment map.
 * @param name - variable name.
 * @returns the non-empty value.
 * @throws NilmSourceError with `INVALID_SOURCE_CONFIG` when absent or empty.
 */
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new NilmSourceError('INVALID_SOURCE_CONFIG', `missing required environment variable ${name}`)
  }
  return value
}

/**
 * Read a port number from the environment.
 * @param env - environment map.
 * @param name - variable name.
 * @param fallback - default port when the variable is absent.
 * @returns a valid TCP port.
 */
function port(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new NilmSourceError('INVALID_SOURCE_CONFIG', `${name} must be an integer TCP port`)
  }
  return parsed
}

/**
 * Build the complete source configuration from deployment environment variables.
 * @param env - environment map; defaults to `process.env`.
 * @returns validated source configuration with no embedded secret values.
 * @throws NilmSourceError with `INVALID_SOURCE_CONFIG` for any missing or invalid required value.
 */
export function loadSourceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const config: Config = {
    localMysql: {
      host: required(env, SOURCE_ENV.localMysqlHost),
      port: port(env, SOURCE_ENV.localMysqlPort, 3306),
      user: required(env, SOURCE_ENV.localMysqlUser),
      password: required(env, SOURCE_ENV.localMysqlPassword),
      database: required(env, SOURCE_ENV.localMysqlDatabase),
    },
    upstreamMysql: {
      host: required(env, SOURCE_ENV.upstreamMysqlHost),
      port: port(env, SOURCE_ENV.upstreamMysqlPort, 3306),
      user: required(env, SOURCE_ENV.upstreamMysqlUser),
      password: required(env, SOURCE_ENV.upstreamMysqlPassword),
      database: required(env, SOURCE_ENV.upstreamMysqlDatabase),
    },
    tdengineHotUrl: required(env, SOURCE_ENV.tdengineHotUrl),
    tdengineStatsUrl: required(env, SOURCE_ENV.tdengineStatsUrl),
    coldProxyUrl: required(env, SOURCE_ENV.coldProxyUrl),
    mysqlConnectionLimit: 10,
    tdengineTimeoutMs: 3000,
    coldProxyTimeoutMs: 5000,
    probeTimeoutMs: 1000,
  }
  const tdengineUser = env[SOURCE_ENV.tdengineUser]
  if (tdengineUser !== undefined) config.tdengineUser = tdengineUser
  const tdenginePassword = env[SOURCE_ENV.tdenginePassword]
  if (tdenginePassword !== undefined) config.tdenginePassword = tdenginePassword
  return config
}
