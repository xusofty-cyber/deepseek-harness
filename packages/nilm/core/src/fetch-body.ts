/**
 * Bounded HTTP response handling shared by source and notification adapters.
 * @module @deepseek-ai/dsh-nilm-core/fetch-body
 */

/** A response body exceeded its configured byte ceiling. */
export class ResponseLimitError extends Error {
  /**
   * @param maxBytes - configured ceiling.
   */
  constructor(readonly maxBytes: number) {
    super(`response body exceeds ${String(maxBytes)} bytes`)
    this.name = 'ResponseLimitError'
  }
}

/**
 * Require an absolute HTTP(S) endpoint without embedded credentials.
 * @param value - deployment-supplied endpoint.
 * @param label - configuration field name used in the failure.
 * @returns the unchanged endpoint.
 * @throws TypeError when the value is not a safe absolute HTTP(S) URL.
 */
export function assertHttpEndpoint(value: string, label: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${label} must be an absolute http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`${label} must use http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError(`${label} must not embed credentials`)
  }
  return value
}

/**
 * Read a response body as UTF-8 text without buffering more than `maxBytes`.
 * @param response - fetch response whose body has not been consumed.
 * @param maxBytes - maximum accepted response bytes.
 * @returns decoded response text.
 * @throws ResponseLimitError when the declared or streamed body exceeds the limit.
 */
export async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0) throw new TypeError('response content-length is malformed')
    if (length > maxBytes) throw new ResponseLimitError(maxBytes)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new ResponseLimitError(maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}
