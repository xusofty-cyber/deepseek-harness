/**
 * G4-3 load-test entrypoint. `--self-check` exercises the harness against an
 * in-process BFF; a target run needs a seeded dataset manifest, 100 tenant
 * secrets, and a 30-minute window before its gates can pass.
 *
 * @module @deepseek-ai/dsh-nilm-service/perf-load
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { startLoopback } from './perf/loopback.ts'
import { runLoad, type LoadReport } from './perf/runner.ts'
import { validateDatasetManifest, type DatasetManifest, type LatencySummary } from './perf/metrics.ts'

const USAGE = `Usage:
  tsx packages/nilm/service/scripts/perf-load.ts --self-check [--output report.json]
  tsx packages/nilm/service/scripts/perf-load.ts --target <url> --manifest <dataset.json> --output <report.json> [options]

Options:
  --tenants <n>            Tenant count (default 100 on a target, 6 in self-check)
  --sessions <n>           Sessions per tenant (default 5 on a target, 2 in self-check)
  --duration <n|30m>       Measurement window (default 30m on a target, 3s in self-check)
  --warmup <n|60s>         Warm-up window (default 60s on a target, 0 in self-check)
  --tool-ratio <0..1>      Share of tool-analysis prompts (default 0.3)
  --turn-timeout <n|30s>   Per-turn deadline (default 30s)
  --tenants-file <path>    JSON array of tenant ids; the first --tenants entries are used
  --tenant-prefix <text>   Generated tenant prefix (default load-tenant-)
  --seed <n>               Deterministic prompt/think-time seed
  --output <path>          Report path (required for a target run)
`

const MINUTE = 60_000
const BOOLEAN_OPTIONS = new Set(['self-check', 'help'])
const VALUE_OPTIONS = new Set([
  'target',
  'manifest',
  'output',
  'tenants-file',
  'tenant-prefix',
  'tenants',
  'sessions',
  'duration',
  'warmup',
  'tool-ratio',
  'turn-timeout',
  'seed',
])

interface Options {
  readonly selfCheck: boolean
  readonly target?: string
  readonly manifest?: string
  readonly output?: string
  readonly tenantsFile?: string
  readonly tenantPrefix: string
  readonly tenants: number
  readonly sessions: number
  readonly durationMs: number
  readonly warmupMs: number
  readonly toolRatio: number
  readonly turnTimeoutMs: number
  readonly seed: number
}

/** Parse CLI arguments and report a usage error for an unknown or invalid value. */
function parseOptions(argv: readonly string[]): Options {
  const values = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string
    if (argument === '-h') {
      values.set('help', true)
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`unexpected argument ${argument}`)
    const raw = argument.slice(2)
    const separator = raw.indexOf('=')
    const key = separator < 0 ? raw : raw.slice(0, separator)
    if (BOOLEAN_OPTIONS.has(key)) {
      if (separator >= 0) throw new Error(`--${key} does not take a value`)
      values.set(key, true)
    } else if (VALUE_OPTIONS.has(key)) {
      if (separator >= 0) {
        const value = raw.slice(separator + 1)
        if (value === '') throw new Error(`--${key} requires a value`)
        values.set(key, value)
      } else {
        const next = argv[index + 1]
        if (next === undefined || next.startsWith('--')) throw new Error(`--${key} requires a value`)
        values.set(key, next)
        index += 1
      }
    } else {
      throw new Error(`unknown option ${argument}`)
    }
  }
  if (values.get('help') === true) {
    process.stdout.write(USAGE)
    process.exit(0)
  }
  const selfCheck = values.get('self-check') === true
  const target = stringValue(values, 'target')
  if (!selfCheck && target === undefined) throw new Error('either --self-check or --target is required')
  if (selfCheck && target !== undefined) throw new Error('--target cannot be combined with --self-check')
  if (selfCheck && values.has('manifest')) throw new Error('--manifest applies only to a target run; the self-check declares no dataset')
  const tenants = integerValue(values, 'tenants', selfCheck ? 6 : 100)
  const sessions = integerValue(values, 'sessions', selfCheck ? 2 : 5)
  if (tenants < 1) throw new Error('--tenants must be at least 1')
  if (sessions < 1) throw new Error('--sessions must be at least 1')
  const durationMs = durationValue(values, 'duration', selfCheck ? 3_000 : 30 * MINUTE)
  if (durationMs < 1) throw new Error('--duration must be at least 1 ms')
  const warmupMs = durationValue(values, 'warmup', selfCheck ? 0 : MINUTE)
  const toolRatio = numberValue(values, 'tool-ratio', 0.3)
  if (toolRatio < 0 || toolRatio > 1) throw new Error('--tool-ratio must be within [0, 1]')
  const turnTimeoutMs = durationValue(values, 'turn-timeout', 30_000)
  if (turnTimeoutMs < 1) throw new Error('--turn-timeout must be at least 1 ms')
  return {
    selfCheck,
    ...(target === undefined ? {} : { target }),
    ...(stringValue(values, 'manifest') === undefined ? {} : { manifest: stringValue(values, 'manifest') as string }),
    ...(stringValue(values, 'output') === undefined ? {} : { output: stringValue(values, 'output') as string }),
    ...(stringValue(values, 'tenants-file') === undefined ? {} : { tenantsFile: stringValue(values, 'tenants-file') as string }),
    tenantPrefix: stringValue(values, 'tenant-prefix') ?? 'load-tenant-',
    tenants,
    sessions,
    durationMs,
    warmupMs,
    toolRatio,
    turnTimeoutMs,
    seed: integerValue(values, 'seed', Date.now()),
  }
}

async function main(): Promise<void> {
  let options: Options
  try {
    options = parseOptions(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`perf-load: ${describe(error)}\n\n${USAGE}`)
    process.exitCode = 2
    return
  }
  try {
    const tenantIds = resolveTenantIds(options)
    if (options.selfCheck) await runSelfCheck(options, tenantIds)
    else await runTarget(options, tenantIds)
  } catch (error) {
    process.stderr.write(`perf-load: ${describe(error)}\n`)
    process.exitCode = 2
  }
}

async function runTarget(options: Options, tenantIds: readonly string[]): Promise<void> {
  if (options.target === undefined) throw new Error('--target is required for a target run')
  if (options.manifest === undefined) throw new Error('--manifest is required for a target run')
  if (options.output === undefined) throw new Error('--output is required for a target run so the evidence survives')
  const manifest = readManifest(options.manifest, options.tenants, options.tenantsFile === undefined ? undefined : tenantIds)
  const secrets = readSecrets()
  const callers = tenantIds.map(tenantId => ({
    tenantId,
    userRef: `load-user-${tenantId}`,
    secret: secretFor(secrets, tenantId),
  }))
  const report = await runLoad({
    baseUrl: options.target,
    callers,
    dataset: manifest,
    mode: 'target',
    shape: {
      tenants: options.tenants,
      sessionsPerTenant: options.sessions,
      durationMs: options.durationMs,
      warmupMs: options.warmupMs,
      toolRatio: options.toolRatio,
      turnTimeoutMs: options.turnTimeoutMs,
      thinkTimeMinMs: 250,
      thinkTimeMaxMs: 1_000,
      seed: options.seed,
    },
    onProgress: message => { process.stderr.write(`perf-load: ${message}\n`) },
  })
  writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  printReport(report, options.output)
  process.exitCode = report.ok ? 0 : 1
}

async function runSelfCheck(options: Options, tenantIds: readonly string[]): Promise<void> {
  const target = await startLoopback(tenantIds)
  try {
    const report = await runLoad({
      baseUrl: target.url,
      callers: tenantIds.map(tenantId => ({
        tenantId,
        userRef: `load-user-${tenantId}`,
        secret: secretFor(target.secrets, tenantId),
      })),
      dataset: syntheticManifest(tenantIds),
      mode: 'self-check',
      shape: {
        tenants: options.tenants,
        sessionsPerTenant: options.sessions,
        durationMs: options.durationMs,
        warmupMs: options.warmupMs,
        toolRatio: options.toolRatio,
        turnTimeoutMs: options.turnTimeoutMs,
        thinkTimeMinMs: 5,
        thinkTimeMaxMs: 20,
        seed: options.seed,
      },
    })
    if (options.output !== undefined) writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    printReport(report, options.output)
    process.exitCode = report.ok ? 0 : 1
  } finally {
    await target.close()
  }
}

function resolveTenantIds(options: Options): readonly string[] {
  if (options.tenantsFile !== undefined) {
    const value = JSON.parse(readFileSync(options.tenantsFile, 'utf8')) as unknown
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string' || entry === '')) {
      throw new Error('--tenants-file must contain a JSON array of non-empty tenant ids')
    }
    if (value.length < options.tenants) {
      throw new Error(`--tenants-file has ${String(value.length)} ids; ${String(options.tenants)} required`)
    }
    const tenantIds = (value as string[]).slice(0, options.tenants)
    if (new Set(tenantIds).size !== tenantIds.length) throw new Error('--tenants-file contains duplicate tenant ids')
    return tenantIds
  }
  return Array.from({ length: options.tenants }, (_, index) => `${options.tenantPrefix}${String(index).padStart(3, '0')}`)
}

function readManifest(path: string, tenants: number, tenantIds: readonly string[] | undefined): DatasetManifest {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  const parsed = validateDatasetManifest(value, tenants, tenantIds)
  if (parsed.manifest === undefined) throw new Error(`dataset manifest rejected:\n  ${parsed.errors.join('\n  ')}`)
  return parsed.manifest
}

function readSecrets(): Record<string, string> {
  const source = process.env.NILM_LOAD_SIGNING_SECRETS
  if (source === undefined || source.trim() === '') {
    throw new Error('NILM_LOAD_SIGNING_SECRETS must name a JSON file or hold the tenant-to-secret JSON object')
  }
  const text = source.trimStart().startsWith('{') ? source : readFileSync(source, 'utf8')
  const value = JSON.parse(text) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('NILM_LOAD_SIGNING_SECRETS must decode to an object keyed by tenant id')
  }
  const secrets: Record<string, string> = {}
  for (const [tenantId, secret] of Object.entries(value)) {
    if (typeof secret !== 'string' || secret.length < 16) {
      throw new Error(`signing secret for ${tenantId} must be a string of at least 16 characters`)
    }
    secrets[tenantId] = secret
  }
  return secrets
}

function secretFor(secrets: Readonly<Record<string, string>>, tenantId: string): string {
  const secret = secrets[tenantId]
  if (secret === undefined) throw new Error(`no signing secret is configured for ${tenantId}`)
  return secret
}

/** Self-check manifest; zero coverage makes clear that no seeded dataset exists. */
function syntheticManifest(tenantIds: readonly string[]): DatasetManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    tenants: tenantIds.length,
    minuteDays: 0,
    secondDays: 0,
    meteringPointsPerTenant: 0,
    tenantIds,
  }
}

function printReport(report: LoadReport, output: string | undefined): void {
  const { totals, latency } = report
  process.stdout.write([
    `G4-3 load report (${report.mode})`,
    `target: ${report.target}`,
    `turns: ${String(totals.turnsStarted)} started, ${String(totals.turnsCompleted)} completed, ${String(totals.turnsFailed)} failed, ${String(totals.warmupTurns)} warm-up`,
    `tools: ${String(totals.toolObservedTurns)} observed on ${String(totals.toolPromptedTurns)} tool prompts`,
    `prompts: simple ${String(totals.promptClasses.simple)}, single-tool ${String(totals.promptClasses.singleTool)}, multi-tool ${String(totals.promptClasses.multiTool)}`,
    `throughput: ${totals.qps.toFixed(2)} completed turns/s, ${String(totals.httpRequests)} HTTP requests, ${String(totals.http5xx)} 5xx, ${String(totals.transportErrors)} transport failures`,
    `latency p50/p95/p99: first event ${format(latency.firstEvent)}; no-tool first token ${format(latency.noToolFirstText)}; tool e2e ${format(latency.toolEndToEnd)}`,
    `isolation: ${String(report.isolation.probes)} probes, ${String(report.isolation.failures)} failures`,
    ...report.gates.map(gate => `gate ${gate.id}: ${gate.status.toUpperCase()} (${gate.observed}; threshold ${gate.threshold})`),
    `result: ${report.mode === 'self-check' ? (report.ok ? 'SELF-CHECK OK (not G4-3 evidence)' : 'SELF-CHECK FAILED') : (report.ok ? 'PASS' : 'FAIL')}`,
    ...(output === undefined ? [] : [`report: ${output}`]),
    '',
  ].join('\n'))
  for (const detail of report.isolation.details) process.stdout.write(`isolation detail: ${detail}\n`)
}

function format(summary: LatencySummary): string {
  return summary.count === 0
    ? 'n/a'
    : `${summary.p50.toFixed(0)}/${summary.p95.toFixed(0)}/${summary.p99.toFixed(0)} ms (${String(summary.count)} samples)`
}

function stringValue(values: ReadonlyMap<string, string | true>, key: string): string | undefined {
  const value = values.get(key)
  if (value === undefined) return undefined
  if (value === true) throw new Error(`--${key} requires a value`)
  return value
}

function integerValue(values: ReadonlyMap<string, string | true>, key: string, fallback: number): number {
  const text = stringValue(values, key)
  if (text === undefined) return fallback
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${key} must be a non-negative integer`)
  return value
}

function numberValue(values: ReadonlyMap<string, string | true>, key: string, fallback: number): number {
  const text = stringValue(values, key)
  if (text === undefined) return fallback
  const value = Number(text)
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a finite number`)
  return value
}

/** Parse `<number>` milliseconds, or a number suffixed with `ms`, `s`, `m`, or `h`. */
function durationValue(values: ReadonlyMap<string, string | true>, key: string, fallback: number): number {
  const text = stringValue(values, key)
  if (text === undefined) return fallback
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/u.exec(text)
  if (match === null) throw new Error(`--${key} must be a duration such as 500ms, 30s, or 30m`)
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  const multiplier = unit === 'h' ? 3_600_000 : unit === 'm' ? MINUTE : unit === 's' ? 1_000 : 1
  return Math.round(amount * multiplier)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

void main()
