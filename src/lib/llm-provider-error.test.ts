import { describe, expect, test } from 'bun:test'
import {
  classifyProviderFailure,
  LlmProviderError,
} from './llm-client-utils'
import { toTypedError } from './errors'

// BYOK: the key belongs to the CUSTOMER, so when their provider rejects a call
// the user — not the operator — must fix it. These tests pin the guidance,
// because the previously shipped behaviour told every one of these cases
// "your provider is not configured", which sends the user to re-check a setting
// that is already correct, and (for non-chat routes) returned the raw provider
// body to the browser.

describe('classifyProviderFailure', () => {
  test('revoked key -> auth', () => {
    const f = classifyProviderFailure(401, '{"error":{"message":"Incorrect API key provided: sk-abc"}}')
    expect(f.kind).toBe('auth')
    expect(f.hint).toMatch(/API key/i)
  })

  test('exhausted credit -> quota, and says the provider bills them', () => {
    const f = classifyProviderFailure(402, '{"error":{"message":"Insufficient credits"}}')
    expect(f.kind).toBe('quota')
    expect(f.hint).toMatch(/credit|quota/i)
    // A customer must not think WE recharge them.
    expect(f.hint).toMatch(/provider/i)
  })

  test('unknown model -> model_missing', () => {
    const f = classifyProviderFailure(404, '{"error":{"message":"The model `gpt-9` does not exist"}}')
    expect(f.kind).toBe('model_missing')
    expect(f.hint).toMatch(/model/i)
  })

  test('model without tool support -> model_unsupported', () => {
    const f = classifyProviderFailure(400, '{"error":{"message":"This model does not support tools"}}')
    expect(f.kind).toBe('model_unsupported')
  })

  test('network failure -> unreachable, points at the base URL', () => {
    const f = classifyProviderFailure(null, 'fetch failed')
    expect(f.kind).toBe('unreachable')
    expect(f.hint).toMatch(/base URL/i)
  })

  test('rate limit -> quota (with a wait, not a top-up)', () => {
    const f = classifyProviderFailure(429, '{"error":{"message":"rate_limit_exceeded"}}')
    expect(f.kind).toBe('quota')
    expect(f.hint).toMatch(/rate-limit|wait/i)
  })

  test('unrecognised failure is reported as unknown, never guessed', () => {
    expect(classifyProviderFailure(500, 'internal server error').kind).toBe('unknown')
  })

  test('the four most common BYOK failures stay distinguishable', () => {
    const kinds = [
      classifyProviderFailure(401, 'invalid_api_key').kind,
      classifyProviderFailure(402, 'insufficient_quota').kind,
      classifyProviderFailure(404, 'unknown model').kind,
      classifyProviderFailure(400, 'does not support').kind,
    ]
    expect(new Set(kinds).size).toBe(4)
  })
})

describe('LlmProviderError', () => {
  test('carries the classification alongside the legacy message shape', () => {
    const e = new LlmProviderError(401, 'invalid_api_key')
    expect(e).toBeInstanceOf(Error)
    // Existing callers/tests match on this prefix — keep it stable.
    expect(e.message).toStartWith('LLM error (HTTP 401):')
    expect(e.failure.kind).toBe('auth')
    expect(e.status).toBe(401)
  })

  test('streaming variant preserves the stream prefix', () => {
    const e = new LlmProviderError(429, 'rate_limit', true)
    expect(e.message).toStartWith('LLM stream error (HTTP 429):')
  })
})

describe('toTypedError — BYOK provider failures reach the user as guidance', () => {
  test('reports a useful hint and never echoes the provider body', () => {
    const secret = 'sk-proj-SUPERSECRETKEYMATERIAL'
    const typed = toTypedError(new LlmProviderError(401, `{"error":{"message":"Incorrect API key provided: ${secret}"}}`))
    expect(typed.hint).toBeTruthy()
    expect(typed.hint).toMatch(/API key/i)
    // The key must not travel to the client in ANY field.
    expect(typed.message).not.toContain(secret)
    expect(typed.hint).not.toContain(secret)
    expect(JSON.stringify(typed)).not.toContain(secret)
  })

  test('maps to 502 (upstream), not 500 (our fault)', () => {
    expect(toTypedError(new LlmProviderError(401, 'invalid_api_key')).statusCode).toBe(502)
  })

  test('quota exhaustion is distinguishable from a bad key in the message', () => {
    const auth = toTypedError(new LlmProviderError(401, 'invalid_api_key')).message
    const quota = toTypedError(new LlmProviderError(402, 'insufficient_quota')).message
    expect(auth).not.toBe(quota)
    expect(quota).toMatch(/quota|credit/i)
  })
})
