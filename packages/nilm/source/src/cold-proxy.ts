/**
 * Cold-warehouse proxy client accepting fixed templates and bounded parameters only.
 * @module @deepseek-ai/dsh-nilm-source/cold-proxy
 */

import {
  assertHttpEndpoint,
  NilmSourceError,
  readBoundedResponseText,
  ResponseLimitError,
} from '@deepseek-ai/dsh-nilm-core'

/** Cold templates are bounded; larger proxy responses are rejected. */
const MAX_COLD_RESPONSE_BYTES = 8 * 1024 * 1024

/** One templated cold query. */
export interface ColdQueryRequest {
  /** Server-owned template identifier. */
  template: string
  /** Bound template parameters; never raw SQL. */
  params: Record<string, string | number | boolean | null>
}

/** Transport seam so timeout and error mapping can be tested without a live proxy. */
export interface ColdProxyTransport {
  /**
   * Send one request.
   * @param request - templated query.
   * @param signal - caller and timeout cancellation.
   * @returns proxy response body.
   */
  request(request: ColdQueryRequest, signal: AbortSignal): Promise<unknown>
}

/** Fetch-based proxy transport. */
export class HttpColdProxyTransport implements ColdProxyTransport {
  /**
   * @param baseUrl - proxy base URL.
   */
  constructor(private readonly baseUrl: string) {}

  /**
   * POST one templated query to the proxy.
   * @param request - templated query.
   * @param signal - cancellation signal.
   * @returns parsed JSON response.
   */
  async request(request: ColdQueryRequest, signal: AbortSignal): Promise<unknown> {
    try {
      assertHttpEndpoint(this.baseUrl, 'cold proxy URL')
    } catch (error) {
      throw new NilmSourceError('INVALID_SOURCE_CONFIG', error instanceof Error ? error.message : 'cold proxy URL is invalid', { cause: error })
    }
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal,
      redirect: 'manual',
    })
    if (!response.ok) {
      throw new NilmSourceError('COLD_LINK_UNAVAILABLE', `cold proxy returned HTTP ${response.status}`)
    }
    let text: string
    try {
      text = await readBoundedResponseText(response, MAX_COLD_RESPONSE_BYTES)
    } catch (error) {
      if (error instanceof ResponseLimitError) {
        throw new NilmSourceError('COLD_LINK_UNAVAILABLE', 'cold proxy response exceeds the configured size limit', { cause: error })
      }
      throw new NilmSourceError('COLD_LINK_UNAVAILABLE', 'cold proxy response could not be read', { cause: error })
    }
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (error) {
      throw new NilmSourceError('COLD_LINK_UNAVAILABLE', 'cold proxy returned invalid JSON', { cause: error })
    }
  }
}

/** Cold proxy client with a fixed request timeout and stable failure mapping. */
export class ColdProxyClient {
  /**
   * @param transport - proxy transport.
   * @param timeoutMs - request budget; the design contract defaults to five seconds.
   */
  constructor(
    private readonly transport: ColdProxyTransport,
    private readonly timeoutMs = 5000,
  ) {}

  /**
   * Execute one templated cold query.
   * @param template - server-owned template identifier.
   * @param params - bound parameters.
   * @param callerSignal - optional caller cancellation.
   * @returns proxy response body.
   * @throws NilmSourceError `COLD_LINK_UNAVAILABLE` on timeout or transport failure.
   */
  async query(template: string, params: ColdQueryRequest['params'], callerSignal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])
    try {
      return await this.transport.request({ template, params }, signal)
    } catch (error) {
      if (timeout.aborted) {
        throw new NilmSourceError('COLD_LINK_UNAVAILABLE', `cold proxy exceeded ${this.timeoutMs} ms`, { cause: error })
      }
      if (callerSignal?.aborted === true) {
        throw new NilmSourceError('COLD_LINK_UNAVAILABLE', 'cold proxy request was cancelled', { cause: error })
      }
      if (error instanceof NilmSourceError) throw error
      throw new NilmSourceError('COLD_LINK_UNAVAILABLE', 'cold proxy request failed', { cause: error })
    }
  }

  /**
   * Probe the proxy with the health template.
   * @param signal - optional caller cancellation.
   * @returns true when the proxy answered successfully.
   */
  async probe(signal?: AbortSignal): Promise<boolean> {
    await this.query('health_check', {}, signal)
    return true
  }
}
