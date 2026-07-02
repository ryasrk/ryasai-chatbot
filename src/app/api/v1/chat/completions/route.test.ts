import { describe, expect, test } from 'bun:test'
import { buildSseDataStream, statusForExternalChatError } from './route'

describe('external chat completion error classification', () => {
  test('returns 503 when no LLM provider is configured', () => {
    expect(
      statusForExternalChatError(
        new Error('Configuration file not found or invalid. Please create .z-ai-config.'),
      ),
    ).toBe(503)
  })

  test('builds an SSE stream ending with DONE', () => {
    const stream = buildSseDataStream([
      { id: 'chunk_1', choices: [{ delta: { content: 'Halo' } }] },
    ])

    expect(stream).toContain('data: {"id":"chunk_1"')
    expect(stream.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})
