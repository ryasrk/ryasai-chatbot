import { describe, expect, test } from 'bun:test'
import { iterSseStream } from './llm-client-utils'

function jsonToStream(obj: unknown): ReadableStream<Uint8Array> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj)
  return new Response(text).body as ReadableStream<Uint8Array>
}

/**
 * NON-STREAM FALLBACK contract — a server that ignores `stream:true` and
 * answers with a plain JSON body used to produce ZERO tokens downstream: the
 * chat UI rendered an empty answer with success citations. This is the exact
 * production bug the e2e mock surfaced.
 */
describe('iterSseStream — non-SSE JSON fallback', () => {
  test('plain JSON body (chat.completion shape) is yielded whole', async () => {
    const body = {
      choices: [{ message: { content: 'Jawaban uji dari mock LLM.' } }],
      usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
    }
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream(body))) chunks.push(c)
    expect(chunks).toHaveLength(1)
    const parsed = JSON.parse(chunks[0])
    expect(parsed.choices[0].message.content).toBe('Jawaban uji dari mock LLM.')
  })

  test('real SSE stream still works token by token', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: [DONE]',
    ].join('\n')
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream(sse))) chunks.push(c)
    expect(chunks).toEqual(['{"choices":[{"delta":{"content":"Hel"}}]}', '{"choices":[{"delta":{"content":"lo"}}]}'])
  })

  test('mixed: SSE chunks win, trailing non-SSE JSON tail is also yielded', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n{"choices":[{"message":{"content":"b"}}]}'
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream(sse))) chunks.push(c)
    expect(chunks).toHaveLength(2)
    expect(JSON.parse(chunks[1]).choices[0].message.content).toBe('b')
  })

  test('non-JSON garbage tail is not yielded', async () => {
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream('plain text, not json'))) chunks.push(c)
    expect(chunks).toEqual([])
  })

  test('empty body → no chunks, no throw', async () => {
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream(''))) chunks.push(c)
    expect(chunks).toEqual([])
  })

  test('trailing "data:" tail (SSE without newline) is still handled', async () => {
    const chunks: string[] = []
    for await (const c of iterSseStream(jsonToStream('data: {"x":1}'))) chunks.push(c)
    expect(chunks).toEqual(['{"x":1}'])
  })
})
