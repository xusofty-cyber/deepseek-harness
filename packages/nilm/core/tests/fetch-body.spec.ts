import { describe, expect, it } from 'vitest'
import { assertHttpEndpoint, readBoundedResponseText, ResponseLimitError } from '../src/index.ts'

describe('bounded HTTP responses', () => {
  it('accepts only absolute credential-free http endpoint URLs', () => {
    expect(assertHttpEndpoint('https://gateway.test/send', 'gateway')).toBe('https://gateway.test/send')
    expect(() => assertHttpEndpoint('/relative', 'gateway')).toThrow('absolute http(s) URL')
    expect(() => assertHttpEndpoint('ftp://gateway.test/send', 'gateway')).toThrow('http or https')
    expect(() => assertHttpEndpoint('https://user:secret@gateway.test/send', 'gateway')).toThrow('must not embed credentials')
  })

  it('reads a body below the byte ceiling', async () => {
    await expect(readBoundedResponseText(new Response('hello'), 5)).resolves.toBe('hello')
  })

  it('rejects a declared content length above the ceiling before reading', async () => {
    const response = new Response('hello', { headers: { 'content-length': '5' } })
    await expect(readBoundedResponseText(response, 4)).rejects.toBeInstanceOf(ResponseLimitError)
  })

  it('rejects a streamed body that exceeds the ceiling', async () => {
    const chunks = [new TextEncoder().encode('abcd'), new TextEncoder().encode('efgh')]
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift()
        if (chunk === undefined) controller.close()
        else controller.enqueue(chunk)
      },
    })
    await expect(readBoundedResponseText(new Response(body), 4)).rejects.toMatchObject({ maxBytes: 4 })
  })

  it('rejects a malformed content length', async () => {
    const response = new Response('hello', { headers: { 'content-length': 'not-a-number' } })
    await expect(readBoundedResponseText(response, 100)).rejects.toThrow('content-length is malformed')
  })
})
