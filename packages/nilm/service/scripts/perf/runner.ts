/**
 * G4-3 workload driver. One worker per virtual session loops over signed turns
 * until the measurement window closes, then the driver probes cross-tenant
 * access before it evaluates the gate rules.
 *
 * @module @deepseek-ai/dsh-nilm-service/perf/runner
 */

import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { LoadCaller, LoadClient, StreamFrame } from './http.ts'
import { LoadHttpError, SignedHttpClient } from './http.ts'
import {
  evaluateGates,
  gatesPass,
  summarize,
  type DatasetManifest,
  type GateResult,
  type LatencySummary,
  type PromptClassCounts,
} from './metrics.ts'

/** Prompt classes the workload must exercise. */
export type PromptClass = 'simple' | 'single-tool' | 'multi-tool'

/** Prompts expected to answer without a Tool call. */
export const SIMPLE_PROMPTS = [
  '请用一句话概括今天的用电情况。',
  '当前功率因数是否正常？请简短回答。',
  '今天有没有需要我关注的告警？',
] as const

/** Prompts expected to require one Tool call. */
export const SINGLE_TOOL_PROMPTS = [
  '查询当前功率因数并判断是否存在越限隐患。',
  '查询今天的告警数量与最高等级。',
] as const

/** Prompts expected to combine waveform analysis with supporting lookups. */
export const MULTI_TOOL_PROMPTS = [
  '分析最近 4 小时的秒级波形，判断是否存在高频启停冲击隐患，并列出 ΔP 与持续时间等证据。',
  '请结合最近 7 天秒级波形定位启动加速迟滞隐患，并查询设备台账与历史告警后给出排查建议。',
] as const

/** One turn's observations. */
export interface TurnSample {
  readonly tenantId: string
  readonly sessionIndex: number
  readonly warmup: boolean
  readonly promptClass?: PromptClass
  readonly observedTool: boolean
  readonly observedToolCalls: number
  readonly ok: boolean
  readonly error?: string
  readonly firstEventMs?: number
  readonly firstTextMs?: number
  readonly endToEndMs?: number
}

/** Cross-tenant probe outcome. */
export interface IsolationReport {
  readonly probes: number
  readonly failures: number
  readonly details: readonly string[]
}

/** Traffic shape one run must report. */
export interface LoadShape {
  readonly tenants: number
  readonly sessionsPerTenant: number
  readonly durationMs: number
  readonly warmupMs: number
  readonly toolRatio: number
  readonly turnTimeoutMs: number
  readonly thinkTimeMinMs: number
  readonly thinkTimeMaxMs: number
  readonly seed: number
}

/** Inputs to one load run. */
export interface RunLoadOptions {
  readonly baseUrl: string
  readonly callers: readonly LoadCaller[]
  readonly shape: LoadShape
  readonly dataset: DatasetManifest
  readonly mode: 'target' | 'self-check'
  /** Transport override used by the harness self-test; defaults to the signed HTTP client. */
  readonly client?: LoadClient
  readonly onProgress?: (message: string) => void
}

/** Machine-readable result written by the CLI. */
export interface LoadReport {
  readonly schemaVersion: 1
  readonly mode: 'target' | 'self-check'
  readonly target: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMs: number
  readonly warmupMs: number
  readonly dataset: DatasetManifest
  readonly shape: LoadShape
  readonly totals: {
    readonly turnsStarted: number
    readonly turnsCompleted: number
    readonly turnsFailed: number
    readonly warmupTurns: number
    readonly toolPromptedTurns: number
    readonly toolObservedTurns: number
    readonly toolCalls: number
    readonly promptClasses: PromptClassCounts
    readonly qps: number
    readonly turnErrorRate: number
    readonly httpRequests: number
    readonly http5xx: number
    readonly transportErrors: number
  }
  readonly latency: {
    readonly firstEvent: LatencySummary
    readonly noToolFirstText: LatencySummary
    readonly toolEndToEnd: LatencySummary
    readonly noToolEndToEnd: LatencySummary
  }
  readonly isolation: IsolationReport
  readonly gates: readonly GateResult[]
  readonly ok: boolean
  readonly evidence: string
}

/**
 * Drive the workload and build the G4-3 report.
 * @param options - target, callers, shape, dataset manifest, and run mode.
 * @returns the complete report; it never throws for a failing target.
 */
export async function runLoad(options: RunLoadOptions): Promise<LoadReport> {
  const { shape } = options
  const client = options.client ?? new SignedHttpClient(
    options.baseUrl,
    { requests: 0, serverErrors: 0, transportErrors: 0 },
    Math.max(shape.turnTimeoutMs, 5_000),
  )
  const metrics = client.metrics
  const samples: TurnSample[] = []
  const conversations = new Map<string, string>()
  const startedAt = new Date()
  const started = performance.now()
  const warmupEnd = started + shape.warmupMs
  const measurementEnd = warmupEnd + shape.durationMs
  const runId = randomBytes(6).toString('hex')
  let lastProgress = started

  const workers: Promise<void>[] = []
  for (const [tenantIndex, caller] of options.callers.entries()) {
    for (let sessionIndex = 0; sessionIndex < shape.sessionsPerTenant; sessionIndex++) {
      workers.push(runSession({
        client,
        caller,
        tenantIndex,
        sessionIndex,
        runId,
        shape,
        warmupEnd,
        measurementEnd,
        samples,
        conversations,
        progress: message => {
          const now = performance.now()
          if (now - lastProgress >= 15_000) {
            lastProgress = now
            options.onProgress?.(message)
          }
        },
      }))
    }
  }
  await Promise.all(workers)
  const measuredEnd = performance.now()
  const finishedAt = new Date()
  const measured = samples.filter(sample => !sample.warmup)
  const completed = measured.filter(sample => sample.ok)
  const isolation = await probeIsolation(client, conversations, options.callers)

  const firstEvent = summarize(completed.flatMap(sample => sample.firstEventMs === undefined ? [] : [sample.firstEventMs]))
  const noToolFirstText = summarize(completed.flatMap(sample =>
    sample.observedTool || sample.firstTextMs === undefined ? [] : [sample.firstTextMs]))
  const toolEndToEnd = summarize(completed.flatMap(sample =>
    !sample.observedTool || sample.endToEndMs === undefined ? [] : [sample.endToEndMs]))
  const noToolEndToEnd = summarize(completed.flatMap(sample =>
    sample.observedTool || sample.endToEndMs === undefined ? [] : [sample.endToEndMs]))
  const promptClasses: PromptClassCounts = {
    simple: measured.filter(sample => sample.promptClass === 'simple').length,
    singleTool: measured.filter(sample => sample.promptClass === 'single-tool').length,
    multiTool: measured.filter(sample => sample.promptClass === 'multi-tool').length,
  }
  const durationMs = Math.max(0, measuredEnd - warmupEnd)
  const gates = options.mode === 'target'
    ? evaluateGates({
      firstEvent,
      noToolFirstText,
      toolEndToEnd,
      httpRequests: metrics.requests,
      http5xx: metrics.serverErrors,
      transportErrors: metrics.transportErrors,
      turnsStarted: measured.length,
      turnsCompleted: completed.length,
      promptClasses,
      isolationProbes: isolation.probes,
      isolationFailures: isolation.failures,
      durationMs,
      tenants: shape.tenants,
      sessionsPerTenant: shape.sessionsPerTenant,
    })
    : []
  const ok = options.mode === 'target'
    ? gatesPass(gates)
    : completed.length > 0 && measured.length === completed.length && isolation.failures === 0 && metrics.transportErrors === 0

  return {
    schemaVersion: 1,
    mode: options.mode,
    target: options.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    warmupMs: shape.warmupMs,
    dataset: options.dataset,
    shape,
    totals: {
      turnsStarted: measured.length,
      turnsCompleted: completed.length,
      turnsFailed: measured.length - completed.length,
      warmupTurns: samples.length - measured.length,
      toolPromptedTurns: measured.filter(sample => sample.promptClass !== undefined && sample.promptClass !== 'simple').length,
      toolObservedTurns: completed.filter(sample => sample.observedTool).length,
      toolCalls: completed.reduce((sum, sample) => sum + sample.observedToolCalls, 0),
      promptClasses,
      qps: completed.length / (Math.max(durationMs, 1) / 1000),
      turnErrorRate: measured.length === 0 ? 1 : (measured.length - completed.length) / measured.length,
      httpRequests: metrics.requests,
      http5xx: metrics.serverErrors,
      transportErrors: metrics.transportErrors,
    },
    latency: { firstEvent, noToolFirstText, toolEndToEnd, noToolEndToEnd },
    isolation,
    gates,
    ok,
    evidence: options.mode === 'target'
      ? 'G4-3 target run; gate status is meaningful only with a 30-minute 100x5 window and a seeded dataset.'
      : 'Self-check of the harness only; this is not G4-3 evidence.',
  }
}

interface SessionInput {
  readonly client: LoadClient
  readonly caller: LoadCaller
  readonly tenantIndex: number
  readonly sessionIndex: number
  readonly runId: string
  readonly shape: LoadShape
  readonly warmupEnd: number
  readonly measurementEnd: number
  readonly samples: TurnSample[]
  readonly conversations: Map<string, string>
  readonly progress: (message: string) => void
}

async function runSession(input: SessionInput): Promise<void> {
  const { client, caller, shape } = input
  const random = mulberry32(shape.seed ^ (input.tenantIndex * 7919) ^ (input.sessionIndex * 104_729))
  let conversationId: string
  try {
    conversationId = await client.createConversation(caller)
  } catch (error) {
    input.samples.push({
      tenantId: caller.tenantId,
      sessionIndex: input.sessionIndex,
      warmup: false,
      observedTool: false,
      observedToolCalls: 0,
      ok: false,
      error: `conversation-create: ${describe(error)}`,
    })
    return
  }
  if (!input.conversations.has(caller.tenantId)) input.conversations.set(caller.tenantId, conversationId)
  let sequence = 0
  while (performance.now() < input.measurementEnd) {
    const promptClass = choosePromptClass(random, shape.toolRatio)
    const prompt = pick(promptClass === 'simple'
      ? SIMPLE_PROMPTS
      : promptClass === 'single-tool' ? SINGLE_TOOL_PROMPTS : MULTI_TOOL_PROMPTS, random)
    const at = performance.now()
    const sample = await runTurn({
      client,
      caller,
      conversationId,
      clientMessageId: `load_${input.runId}_${String(input.tenantIndex)}_${String(input.sessionIndex)}_${String(sequence)}`,
      prompt,
      promptClass,
      sessionIndex: input.sessionIndex,
      turnTimeoutMs: shape.turnTimeoutMs,
      warmup: at < input.warmupEnd,
    })
    input.samples.push(sample)
    sequence += 1
    input.progress(`${caller.tenantId}/${String(input.sessionIndex)} completed ${String(input.samples.length)} turns`)
    const think = shape.thinkTimeMinMs + Math.floor(random() * Math.max(1, shape.thinkTimeMaxMs - shape.thinkTimeMinMs + 1))
    if (performance.now() + think < input.measurementEnd) await sleep(think)
  }
}

interface TurnInput {
  readonly client: LoadClient
  readonly caller: LoadCaller
  readonly conversationId: string
  readonly clientMessageId: string
  readonly prompt: string
  readonly promptClass: PromptClass
  readonly sessionIndex: number
  readonly turnTimeoutMs: number
  readonly warmup: boolean
}

async function runTurn(input: TurnInput): Promise<TurnSample> {
  const { client, caller } = input
  const started = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, input.turnTimeoutMs)
  let firstEventMs: number | undefined
  let firstTextMs: number | undefined
  let endToEndMs: number | undefined
  let observedToolCalls = 0
  let streamError: string | undefined
  let done = false
  try {
    const accepted = await client.createTurn(caller, {
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      content: input.prompt,
    })
    const status = await client.stream(caller, accepted.streamUrl, (frame, at) => {
      const elapsed = at - started
      if (frame.event !== 'ping' && firstEventMs === undefined) firstEventMs = elapsed
      if (frame.event === 'tool.start') observedToolCalls += 1
      if ((frame.event === 'text.delta' || frame.event === 'text.done') && firstTextMs === undefined) {
        firstTextMs = elapsed
      }
      if (frame.event === 'error') streamError = errorCodeOf(frame)
      if (frame.event === 'done') {
        done = true
        endToEndMs = elapsed
      }
    }, controller.signal)
    if (status !== 200 && streamError === undefined) streamError = `stream status ${String(status)}`
    else if (!done && streamError === undefined) streamError = 'stream ended without done'
  } catch (error) {
    streamError = describe(error)
  } finally {
    clearTimeout(timer)
  }
  const ok = done && streamError === undefined && endToEndMs !== undefined
  return {
    tenantId: caller.tenantId,
    sessionIndex: input.sessionIndex,
    warmup: input.warmup,
    promptClass: input.promptClass,
    observedTool: observedToolCalls > 0,
    observedToolCalls,
    ok,
    ...(streamError === undefined ? {} : { error: streamError }),
    ...(firstEventMs === undefined ? {} : { firstEventMs }),
    ...(firstTextMs === undefined ? {} : { firstTextMs }),
    ...(endToEndMs === undefined ? {} : { endToEndMs }),
  }
}

async function probeIsolation(
  client: LoadClient,
  conversations: ReadonlyMap<string, string>,
  callers: readonly LoadCaller[],
): Promise<IsolationReport> {
  const details: string[] = []
  let probes = 0
  const entries = [...conversations]
  for (const [victimTenant, conversationId] of entries) {
    const attacker = callers.find(caller => caller.tenantId !== victimTenant)
    if (attacker === undefined) continue
    probes += 1
    try {
      const messages = await client.probeMessages(attacker, conversationId)
      if (messages.status === 200) details.push(`${attacker.tenantId} read ${victimTenant}'s conversation`)
      else if (![401, 403, 404].includes(messages.status)) {
        details.push(`${attacker.tenantId} probe returned ${String(messages.status)} for ${victimTenant}`)
      }
    } catch (error) {
      details.push(`${attacker.tenantId} message probe failed: ${describe(error)}`)
    }
    probes += 1
    try {
      const listed = await client.listConversations(attacker)
      if (listed.status !== 200) details.push(`${attacker.tenantId} list returned ${String(listed.status)}`)
      else if (listed.text.includes(conversationId)) details.push(`${attacker.tenantId} listed ${victimTenant}'s conversation`)
    } catch (error) {
      details.push(`${attacker.tenantId} list probe failed: ${describe(error)}`)
    }
  }
  return { probes, failures: details.length, details }
}

function errorCodeOf(frame: StreamFrame): string {
  if (typeof frame.data === 'object' && frame.data !== null) {
    const code = (frame.data as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return 'stream error'
}

function describe(error: unknown): string {
  if (error instanceof LoadHttpError) return `${String(error.status)} ${error.code ?? error.message}`
  return error instanceof Error ? error.message : String(error)
}

function pick<T>(values: readonly T[], random: () => number): T {
  const index = Math.floor(random() * values.length)
  return values[Math.min(index, values.length - 1)] as T
}

function choosePromptClass(random: () => number, toolRatio: number): PromptClass {
  if (random() >= toolRatio) return 'simple'
  return random() < 0.5 ? 'single-tool' : 'multi-tool'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}
