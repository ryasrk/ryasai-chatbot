import { describe, expect, test } from 'bun:test'
import { readResponseBody } from './response-body'

describe('bounded response body', () => {
  test('a large chunk is capped before decoding and the remaining transfer is cancelled', async () => {
    let cancelled = false
    let pulls = 0
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('x'.repeat(100_000))) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const result = await readResponseBody({ body }, 10)
    expect(result).toEqual({ text: 'xxxxxxxxxx', truncated: true })
    expect(cancelled).toBe(true)
    expect(pulls).toBe(1)
  })
  test('an exact-sized body is complete rather than truncated', async () => {
    expect(await readResponseBody(new Response('hello'), 5)).toEqual({ text: 'hello', truncated: false })
  })
  test('UTF-8 characters survive chunk boundaries', async () => {
    const bytes = new TextEncoder().encode('café 日本語')
    let offset = 0
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ pull(controller) {
      if (offset === bytes.length) controller.close()
      else controller.enqueue(bytes.slice(offset, ++offset))
    } })
    expect(await readResponseBody({ body }, 100)).toEqual({ text: 'café 日本語', truncated: false })
  })
  test('a failed body is never turned into a successful empty result', async () => {
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.error(new Error('broken transfer')) } })
    await expect(readResponseBody({ body }, 10)).rejects.toThrow('broken transfer')
  })
  test('absent body and invalid limits', async () => {
    expect(await readResponseBody(new Response(null), 10)).toEqual({ text: '', truncated: false })
    for (const limit of [0, -1, NaN, Infinity, 1.2]) await expect(readResponseBody(new Response('x'), limit)).rejects.toThrow()
  })
})
