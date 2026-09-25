import { describe, expect, test } from 'bun:test'
import { extractError } from './extract-error'

describe('extractError', () => {
  test('string error → returned as-is', () => {
    expect(extractError('Something broke', 'fallback')).toBe('Something broke')
  })

  test('object with message → extracts message', () => {
    expect(extractError({ message: 'DB connection failed' }, 'fallback')).toBe('DB connection failed')
  })

  test('object without message → fallback', () => {
    expect(extractError({ code: 500 }, 'fallback')).toBe('fallback')
  })

  test('null → fallback', () => {
    expect(extractError(null, 'fallback')).toBe('fallback')
  })

  test('undefined → fallback', () => {
    expect(extractError(undefined, 'fallback')).toBe('fallback')
  })

  test('number → fallback', () => {
    expect(extractError(42, 'fallback')).toBe('fallback')
  })

  test('typed error with code + hint → message AND hint (the hint is the actionable half)', () => {
    // REVERSED DELIBERATELY. This used to assert `toBe('Invalid credentials')`, i.e. that the hint
    // was DISCARDED — the test codified the bug. `classifyProviderFailure` exists so a BYOK customer
    // is told what to DO about a failed credential, and `toTypedError` already carries the hint to
    // the client; extractError was the last hop and dropped it, so every toast showed the vague
    // half. For a product whose main support burden is customer-supplied keys, that turned
    // self-service fixes into tickets.
    expect(extractError({ code: 'AUTH_FAILED', message: 'Invalid credentials', hint: 'Check password' }, 'fallback'))
      .toBe('Invalid credentials — Check password')
  })

  test('a hint-less error is unchanged (no stray separator)', () => {
    expect(extractError({ message: 'DB connection failed' }, 'fallback')).toBe('DB connection failed')
    expect(extractError({ message: 'x', hint: '   ' }, 'fallback')).toBe('x')
    expect(extractError({ message: 'x', hint: null }, 'fallback')).toBe('x')
  })

  test('the real LLM hint survives the whole path to the string a toast shows', () => {
    // End-to-end for the case that motivated the change: an OpenAI-compatible provider rejecting
    // a key must produce a sentence the customer can act on.
    const typed = {
      code: 'LLM_ERROR',
      message: 'AI provider error: authentication failed',
      hint: 'Your AI provider rejected the API key. Re-enter it in Settings > AI Configuration — it may be revoked, expired, or pasted with a trailing space.',
    }
    const shown = extractError(typed, 'fallback')
    expect(shown).toContain('authentication failed')
    expect(shown).toContain('Re-enter it in Settings')
  })
})
