import { describe, expect, test } from 'bun:test'
import { statusForInternalChatError } from './route'

describe('internal chat send error classification', () => {
  test('returns 503 when the LLM provider is unavailable', () => {
    expect(
      statusForInternalChatError(
        new Error('LLM not configured. Open Settings → AI Configuration and set up endpoint + API key before using Chat.'),
      ),
    ).toBe(503)
  })

  test('keeps unknown errors as server errors', () => {
    expect(statusForInternalChatError(new Error('database failed'))).toBe(500)
  })

  test('returns 404 when the session disappears before the assistant reply is saved', () => {
    expect(statusForInternalChatError({ code: 'P2003' })).toBe(404)
  })

  test('returns 404 when the session disappears before retitling', () => {
    expect(statusForInternalChatError({ code: 'P2025' })).toBe(404)
  })
})
