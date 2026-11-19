/**
 * Signed HTTP/SSE client for the G4-3 load test. It signs exactly the canonical
 * string the BFF verifies, so a load failure comes from the target rather than
 * from a harness that forgot a header.
 *
 * @module @deepseek-ai/dsh-nilm-service/perf/http
 */

import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { canonicalRequest, createSignature } from '../../src/auth.ts'

/** One authenticated load caller. The secret must match the target deployment. */
export interface LoadCaller {
  readonly tenantId: string
  readonly userRef: string
  readonly secret: string
}

/** Counters shared by every request the harness makes. */
export interface RequestMetrics {
  requests: number
  serverErrors: number
  transportErrors: number
}

/** One decoded SSE frame. `ping` frames carry no payload. */
export interface StreamFrame {
  readonly id?: number
  readonly event: string
  readonly data: unknown
}

/** Accepted turn identity returned by `POST /v1/turns`. */
export interface AcceptedTurn {
  readonly turnId: string
  readonly conversationId: string
  readonly streamUrl: string
}

/** Transport seam shared by the real signed client and the harness self-test. */
export interface LoadClient {
  readonly metrics: RequestMetrics
  createConversation(caller: LoadCaller): Promise<string>
  createTurn(caller: LoadCaller, input: {
    readonly conversationId: string
    readonly clientMessageId: string
    readonly content: string
    readonly mode?: 'auto' | 'reasoner'
  }): Promise<AcceptedTurn>
  stream(
    caller: LoadCaller,
    streamUrl: string,
    onFrame: (frame: StreamFrame, atMs: number) => void,
    signal: AbortSignal,
  ): Promise<number>
  probeMessages(caller: LoadCaller, conversationId: string): Promise<{ status: number; text: string }>
  listConversations(caller: LoadCaller): Promise<{ status: number; text: string }>
}

/** HTTP failure with the status and stable NILM code the target returned. */
export class LoadHttpError extends Error {
  /**
   * @param status - HTTP status, or zero for a transport failure.
   * @param code - stable NILM error code when the body carried one.
   * @param message - caller-safe diagnostic.
   */
  constructor(readonly status: number, readonly code: string | undefined, message: string) {
    super(message)
  }
}

/**
 * Incremental SSE parser. The BFF writes one JSON object per `data:` line and
 * frames end with a blank line, but the parser accepts chunk boundaries
 * anywhere and ignores comments and keepalive frames.
 */
export class SseParser {
  private buffer = ''

  /**
   * Feed one decoded chunk.
   * @param chunk - decoded text from the response body.
   * @returns complete frames in arrival order.
   */
  push(chunk: string): StreamFrame[] {
    this.buffer += chunk
    return this.drain()
  }

  /** Drain a final frame that was not terminated by a blank line. */
  end(): StreamFrame[] {
    const frames = this.drain()
    const trailing = this.buffer.trim()
    this.buffer = ''
    if (trailing === '') return frames
    const frame = parseBlock(trailing)
    if (frame !== undefined) frames.push(frame)
    return frames
  }

  private drain(): StreamFrame[] {
    this.buffer = this.buffer.replaceAll('\r\n', '\n')
    const frames: StreamFrame[] = []
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary < 0) return frames
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const frame = parseBlock(block)
      if (frame !== undefined) frames.push(frame)
    }
  }
}

/**
 * HTTP client that signs every request and records shared counters.
 */
export class SignedHttpClient implements LoadClient {
  private readonly baseUrl: URL

  /**
   * @param baseUrl - target BFF or edge URL.
   * @param metrics - shared request counters.
   * @param timeoutMs - deadline for one request or stream connect.
   */
  constructor(baseUrl: string, readonly metrics: RequestMetrics, private readonly timeoutMs: number) {
    this.baseUrl = new URL(baseUrl)
  }

  /**
   * Create one server-issued conversation.
   * @param caller - signed caller identity.
   * @returns the conversation identity.
   */
  async createConversation(caller: LoadCaller): Promise<string> {
    const response = await this.send(caller, 'POST', '/v1/conversations', Buffer.alloc(0))
    if (response.status !== 201) throw await failure(response)
    const body = await jsonObject(response)
    const conversationId = body.conversationId
    if (typeof conversationId !== 'string') {
      throw new LoadHttpError(response.status, undefined, 'conversation response has no conversationId')
    }
    return conversationId
  }

  /**
   * Submit one turn.
   * @param caller - signed caller identity.
   * @param input - conversation, idempotency key, content, and model mode.
   * @returns the accepted turn identity and stream path.
   */
  async createTurn(caller: LoadCaller, input: {
    readonly conversationId: string
    readonly clientMessageId: string
    readonly content: string
    readonly mode?: 'auto' | 'reasoner'
  }): Promise<AcceptedTurn> {
    const payload: Record<string, string> = {
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      content: input.content,
    }
    if (input.mode !== undefined) payload.mode = input.mode
    const response = await this.send(caller, 'POST', '/v1/turns', Buffer.from(JSON.stringify(payload), 'utf8'))
    if (response.status !== 202) throw await failure(response)
    const body = await jsonObject(response)
    if (typeof body.turnId !== 'string' || typeof body.conversationId !== 'string' || typeof body.streamUrl !== 'string') {
      throw new LoadHttpError(response.status, undefined, 'turn response is missing turnId, conversationId, or streamUrl')
    }
    return { turnId: body.turnId, conversationId: body.conversationId, streamUrl: body.streamUrl }
  }

  /**
   * Read one turn's SSE stream until `done`, abort, or timeout.
   * @param caller - signed caller identity.
   * @param streamUrl - absolute or BFF-relative stream path.
   * @param onFrame - receives each frame with its monotonic arrival time.
   * @param signal - caller-owned abort signal.
   * @returns the HTTP status that opened the stream.
   */
  async stream(
    caller: LoadCaller,
    streamUrl: string,
    onFrame: (frame: StreamFrame, atMs: number) => void,
    signal: AbortSignal,
  ): Promise<number> {
    const url = new URL(streamUrl, this.baseUrl)
    const response = await this.sendWithSignal(caller, 'GET', url.pathname, Buffer.alloc(0), signal)
    if (response.status !== 200) {
      await response.arrayBuffer().catch(() => undefined)
      return response.status
    }
    if (response.body === null) throw new LoadHttpError(response.status, undefined, 'SSE response has no body')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        for (const frame of parser.push(decoder.decode(next.value, { stream: true }))) {
          onFrame(frame, performance.now())
        }
      }
      for (const frame of parser.end()) onFrame(frame, performance.now())
    } finally {
      reader.releaseLock()
    }
    return response.status
  }

  /**
   * Read one conversation's messages with an attacker identity.
   * @param caller - attacker caller identity.
   * @param conversationId - victim conversation id.
   * @returns the HTTP status and decoded messages when the target returned 200.
   */
  async probeMessages(caller: LoadCaller, conversationId: string): Promise<{ status: number; text: string }> {
    const response = await this.send(caller, 'GET', `/v1/conversations/${conversationId}/messages`, Buffer.alloc(0))
    const text = await safeText(response)
    return { status: response.status, text }
  }

  /**
   * List the attacker's own conversations to check it never sees a victim id.
   * @param caller - attacker caller identity.
   * @returns the HTTP status and the raw response body.
   */
  async listConversations(caller: LoadCaller): Promise<{ status: number; text: string }> {
    const response = await this.send(caller, 'GET', '/v1/conversations', Buffer.alloc(0))
    return { status: response.status, text: await safeText(response) }
  }

  private async send(
    caller: LoadCaller,
    method: 'GET' | 'POST',
    path: string,
    body: Buffer,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.sendWithSignal(caller, method, path, body, signal ?? AbortSignal.timeout(this.timeoutMs))
  }

  private async sendWithSignal(
    caller: LoadCaller,
    method: 'GET' | 'POST',
    path: string,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<Response> {
    const headers = signedHeaders(method, path, body, caller, Date.now())
    this.metrics.requests += 1
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        ...(method === 'POST' ? { body: new Uint8Array(body) } : {}),
        signal,
      })
      if (response.status >= 500) this.metrics.serverErrors += 1
      return response
    } catch (error) {
      this.metrics.transportErrors += 1
      throw new LoadHttpError(0, undefined, `request failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Build the exact headers the BFF verifies.
 * @param method - HTTP method.
 * @param path - absolute request path without a query string.
 * @param body - raw request body.
 * @param caller - tenant, user, and secret.
 * @param nowMs - current epoch milliseconds.
 * @returns lower-case header names and signed values.
 */
export function signedHeaders(
  method: string,
  path: string,
  body: Buffer,
  caller: LoadCaller,
  nowMs: number,
): Record<string, string> {
  const timestamp = String(nowMs)
  const nonce = randomBytes(12).toString('hex')
  const requestId = `load_${randomBytes(10).toString('hex')}`
  const canonical = canonicalRequest(method, path, body, caller.tenantId, caller.userRef, '', requestId, timestamp, nonce)
  return {
    'content-type': 'application/json',
    'x-nilm-tenant-id': caller.tenantId,
    'x-nilm-user-ref': caller.userRef,
    'x-nilm-request-id': requestId,
    'x-nilm-timestamp': timestamp,
    'x-nilm-nonce': nonce,
    'x-nilm-signature': createSignature(caller.secret, canonical),
  }
}

function parseBlock(block: string): StreamFrame | undefined {
  let event = 'message'
  let id: number | undefined
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
    else if (field === 'id') {
      const parsed = Number(value)
      if (Number.isSafeInteger(parsed) && parsed > 0) id = parsed
    }
  }
  if (data.length === 0 && event === 'message') return undefined
  return {
    ...(id === undefined ? {} : { id }),
    event,
    data: decodeData(data.join('\n')),
  }
}

function decodeData(text: string): unknown {
  if (text === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function failure(response: Response): Promise<LoadHttpError> {
  const text = await safeText(response)
  let code: string | undefined
  try {
    const body = JSON.parse(text) as { code?: unknown }
    if (typeof body.code === 'string') code = body.code
  } catch {
    // The diagnostic below already carries the status and raw text.
  }
  return new LoadHttpError(response.status, code, `${String(response.status)} ${text.slice(0, 300)}`)
}

async function jsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await safeText(response)
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    // Fall through to the protocol error below.
  }
  throw new LoadHttpError(response.status, undefined, 'response body is not a JSON object')
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
