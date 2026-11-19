/**
 * Pure aggregation and evidence-gate rules for the G4-3 load test. Keeping
 * these functions transport-free lets the same rules judge a real target and
 * the in-process self-check.
 *
 * @module @deepseek-ai/dsh-nilm-service/perf/metrics
 */

/** Dataset coverage the G4-3 target environment must provide. */
export const REQUIRED_MINUTE_DAYS = 90
/** Second-level history the G4-3 target environment must provide. */
export const REQUIRED_SECOND_DAYS = 7
/** Metering points each tenant must expose for the load scenarios. */
export const REQUIRED_METERING_POINTS = 5
/** Minimum samples before a latency gate can claim a percentile. */
export const MINIMUM_GATE_SAMPLES = 20

/** Declared coverage of the seeded load dataset. */
export interface DatasetManifest {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly tenants: number
  readonly minuteDays: number
  readonly secondDays: number
  readonly meteringPointsPerTenant: number
  readonly tenantIds?: readonly string[]
}

/** Percentile summary of one latency class. */
export interface LatencySummary {
  readonly count: number
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
}

/** One gate outcome. `insufficient` is not a pass. */
export interface GateResult {
  readonly id: string
  readonly label: string
  readonly threshold: string
  readonly observed: string
  readonly status: 'pass' | 'fail' | 'insufficient'
}

/** Measured turns in each prompt class. */
export interface PromptClassCounts {
  readonly simple: number
  readonly singleTool: number
  readonly multiTool: number
}

/** Inputs a load report feeds into the G4-3 gate rules. */
export interface GateInput {
  readonly firstEvent: LatencySummary
  readonly noToolFirstText: LatencySummary
  readonly toolEndToEnd: LatencySummary
  readonly httpRequests: number
  readonly http5xx: number
  readonly transportErrors: number
  readonly turnsStarted: number
  readonly turnsCompleted: number
  readonly promptClasses: PromptClassCounts
  readonly isolationProbes: number
  readonly isolationFailures: number
  readonly durationMs: number
  readonly tenants: number
  readonly sessionsPerTenant: number
}

/**
 * Compute a nearest-rank percentile without mutating the caller's array.
 * @param values - observed samples.
 * @param percentileValue - percentile in `[0, 100]`.
 * @returns the percentile, or `undefined` for an empty sample.
 */
export function percentile(values: readonly number[], percentileValue: number): number | undefined {
  if (values.length === 0) return undefined
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 100) {
    throw new TypeError('percentile must be finite and within [0, 100]')
  }
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(1, Math.ceil((percentileValue / 100) * sorted.length))
  return sorted[rank - 1]
}

/**
 * Summarize one latency class.
 * @param values - observed milliseconds; non-finite values are ignored.
 * @returns the summary; `count` is zero when no finite sample exists.
 */
export function summarize(values: readonly number[]): LatencySummary {
  const samples = values.filter(value => Number.isFinite(value) && value >= 0)
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
  const total = samples.reduce((sum, value) => sum + value, 0)
  return {
    count: samples.length,
    p50: percentile(samples, 50) as number,
    p95: percentile(samples, 95) as number,
    p99: percentile(samples, 99) as number,
    max: samples.reduce((largest, value) => value > largest ? value : largest, samples[0] as number),
    mean: total / samples.length,
  }
}

/**
 * Validate a dataset manifest read from a durable file. A short or malformed
 * declaration refuses the run instead of producing unverifiable numbers.
 * @param value - decoded JSON value.
 * @param requiredTenants - tenant count the run will exercise.
 * @param requiredTenantIds - tenant ids the run will exercise, when fixed.
 * @returns the validated manifest and every coverage error.
 */
export function validateDatasetManifest(
  value: unknown,
  requiredTenants: number,
  requiredTenantIds?: readonly string[],
): { readonly manifest?: DatasetManifest; readonly errors: readonly string[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { errors: ['dataset manifest must be a JSON object'] }
  }
  const record = value as Record<string, unknown>
  const errors: string[] = []
  if (record.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (typeof record.generatedAt !== 'string' || record.generatedAt === '') errors.push('generatedAt must be a non-empty string')
  const tenants = numberField(record.tenants, 'tenants', errors)
  const minuteDays = numberField(record.minuteDays, 'minuteDays', errors)
  const secondDays = numberField(record.secondDays, 'secondDays', errors)
  const meteringPointsPerTenant = numberField(record.meteringPointsPerTenant, 'meteringPointsPerTenant', errors)
  if (tenants !== undefined && tenants < requiredTenants) {
    errors.push(`tenants is ${String(tenants)}; the run needs ${String(requiredTenants)}`)
  }
  if (minuteDays !== undefined && minuteDays < REQUIRED_MINUTE_DAYS) {
    errors.push(`minuteDays is ${String(minuteDays)}; G4-3 needs ${String(REQUIRED_MINUTE_DAYS)}`)
  }
  if (secondDays !== undefined && secondDays < REQUIRED_SECOND_DAYS) {
    errors.push(`secondDays is ${String(secondDays)}; G4-3 needs ${String(REQUIRED_SECOND_DAYS)}`)
  }
  if (meteringPointsPerTenant !== undefined && meteringPointsPerTenant < REQUIRED_METERING_POINTS) {
    errors.push(`meteringPointsPerTenant is ${String(meteringPointsPerTenant)}; G4-3 needs ${String(REQUIRED_METERING_POINTS)}`)
  }
  let tenantIds: readonly string[] | undefined
  if (record.tenantIds !== undefined) {
    if (!Array.isArray(record.tenantIds) || record.tenantIds.some(entry => typeof entry !== 'string' || entry === '')) {
      errors.push('tenantIds must be an array of non-empty strings')
    } else {
      tenantIds = [...record.tenantIds] as string[]
      if (requiredTenantIds !== undefined) {
        const declared = new Set(tenantIds)
        for (const tenantId of requiredTenantIds) {
          if (!declared.has(tenantId)) errors.push(`tenantIds does not declare ${tenantId}`)
        }
      }
    }
  } else if (requiredTenantIds !== undefined) {
    errors.push('tenantIds is required when the run uses fixed tenant ids')
  }
  if (errors.length > 0) return { errors }
  return {
    manifest: {
      schemaVersion: 1,
      generatedAt: record.generatedAt as string,
      tenants: tenants as number,
      minuteDays: minuteDays as number,
      secondDays: secondDays as number,
      meteringPointsPerTenant: meteringPointsPerTenant as number,
      ...(tenantIds === undefined ? {} : { tenantIds }),
    },
    errors,
  }
}

/**
 * Apply the G4-3 thresholds to one report's observations.
 * @param input - latency summaries, HTTP counts, and isolation probes.
 * @returns one result per gate, in report order.
 */
export function evaluateGates(input: GateInput): readonly GateResult[] {
  const errorRate = input.httpRequests === 0 ? 1 : input.http5xx / input.httpRequests
  const turnErrorRate = input.turnsStarted === 0 ? 1 : (input.turnsStarted - input.turnsCompleted) / input.turnsStarted
  return [
    {
      id: 'load-shape',
      label: 'Load shape',
      threshold: '>= 100 tenants x 5 sessions',
      observed: `${String(input.tenants)} tenants x ${String(input.sessionsPerTenant)} sessions`,
      status: input.tenants >= 100 && input.sessionsPerTenant >= 5 ? 'pass' : 'fail',
    },
    {
      id: 'soak-duration',
      label: 'Measurement window',
      threshold: '>= 30 minutes',
      observed: `${(input.durationMs / 60_000).toFixed(1)} minutes`,
      status: input.durationMs >= 1_800_000 ? 'pass' : 'fail',
    },
    {
      id: 'scenario-coverage',
      label: 'Prompt scenario coverage',
      threshold: 'simple, single-tool, and multi-tool each >= 20 turns',
      observed: `simple ${String(input.promptClasses.simple)}, single-tool ${String(input.promptClasses.singleTool)}, multi-tool ${String(input.promptClasses.multiTool)}`,
      status: input.promptClasses.simple >= MINIMUM_GATE_SAMPLES
        && input.promptClasses.singleTool >= MINIMUM_GATE_SAMPLES
        && input.promptClasses.multiTool >= MINIMUM_GATE_SAMPLES ? 'pass' : 'fail',
    },
    latencyGate('first-stream-p95', 'First stream event p95', '< 300 ms', input.firstEvent, 300, 'p95'),
    latencyGate('simple-first-token-p95', 'No-tool first token p95', '< 1500 ms', input.noToolFirstText, 1500, 'p95'),
    latencyGate('tool-e2e-p95', 'Tool analysis end-to-end p95', '< 8000 ms', input.toolEndToEnd, 8000, 'p95'),
    latencyGate('tool-e2e-p99', 'Tool analysis end-to-end p99', '< 12000 ms', input.toolEndToEnd, 12000, 'p99'),
    {
      id: 'http-5xx-rate',
      label: 'HTTP 5xx rate',
      threshold: '< 0.5%',
      observed: `${(errorRate * 100).toFixed(3)}% of ${String(input.httpRequests)} requests`,
      status: input.httpRequests > 0 && errorRate < 0.005 ? 'pass' : 'fail',
    },
    {
      id: 'turn-error-rate',
      label: 'Turn error rate',
      threshold: '< 0.5%',
      observed: `${(turnErrorRate * 100).toFixed(3)}% of ${String(input.turnsStarted)} measured turns`,
      status: input.turnsStarted > 0 && turnErrorRate < 0.005 ? 'pass' : 'fail',
    },
    {
      id: 'transport-errors',
      label: 'Transport failures',
      threshold: '0',
      observed: String(input.transportErrors),
      status: input.transportErrors === 0 ? 'pass' : 'fail',
    },
    {
      id: 'tenant-isolation',
      label: 'Tenant isolation',
      threshold: '0 leaks; >= 2 probes per tenant',
      observed: `${String(input.isolationFailures)} failures in ${String(input.isolationProbes)} probes`,
      status: input.isolationProbes >= input.tenants * 2 && input.isolationFailures === 0 ? 'pass' : 'fail',
    },
  ]
}

/** Whether every gate passed; `insufficient` never counts as a pass. */
export function gatesPass(gates: readonly GateResult[]): boolean {
  return gates.every(gate => gate.status === 'pass')
}

function latencyGate(
  id: string,
  label: string,
  threshold: string,
  summary: LatencySummary,
  limit: number,
  statistic: 'p95' | 'p99',
): GateResult {
  if (summary.count < MINIMUM_GATE_SAMPLES) {
    return {
      id,
      label,
      threshold,
      observed: `${String(summary.count)} samples; at least ${String(MINIMUM_GATE_SAMPLES)} required`,
      status: 'insufficient',
    }
  }
  const observed = summary[statistic]
  return {
    id,
    label,
    threshold,
    observed: `${observed.toFixed(1)} ms`,
    status: observed < limit ? 'pass' : 'fail',
  }
}

function numberField(value: unknown, name: string, errors: string[]): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    errors.push(`${name} must be a non-negative integer`)
    return undefined
  }
  return value
}
