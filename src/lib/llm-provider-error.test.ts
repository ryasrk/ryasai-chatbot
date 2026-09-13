import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyProviderFailure,
  LlmProviderError,
  redactProviderBody,
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


// ---------------------------------------------------------------------------
// The message is PERSISTED, so the body must be redacted (not just un-displayed)
//
// The typed error deliberately carries only a category + hint to the browser, and the user-facing
// paths are indeed redacted. The MESSAGE, however, is not thrown away: `logLlmUsage` stores it in
// `LlmUsageLog`, the observability ring buffer keeps it for `GET /api/traces`, and
// `ApiLog.errorMessage` keeps it too. A BYOK provider commonly echoes the submitted key in a 401
// body, so an unredacted message writes the CUSTOMER's secret into a trace buffer, a log line, and
// every OTel export or bug report that carries them.
// ---------------------------------------------------------------------------
describe('redactProviderBody — the persisted message must not carry the key', () => {
  test('credential-shaped substrings are removed, for the shapes providers actually echo', () => {
    // Each case is a real provider error shape. The secret is asserted to be ABSENT as a substring of
    // the whole output, which is the property that matters -- matching on the replacement marker
    // instead would pass for a redactor that dropped the body entirely.
    const cases: Array<[string, string]> = [
      ['{"error":"Incorrect API key provided: sk-proj-abc123XYZ789def456"}', 'sk-proj-abc123XYZ789def456'],
      ['{"error":"invalid api_key: key-9f8e7d6c5b4a3210"}', 'key-9f8e7d6c5b4a3210'],
      ['{"message":"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc"}', 'eyJhbGciOiJIUzI1NiJ9'],
      ['{"error":{"api_key":"abc123def456ghi789"}}', 'abc123def456ghi789'],
      ['{"error":"token deadbeefdeadbeefdeadbeefdeadbeef"}', 'deadbeefdeadbeefdeadbeefdeadbeef'],
      ['{"error":"bad access_token=ghp_0123456789abcdef"}', 'ghp_0123456789abcdef'],
    ]
    for (const [body, secret] of cases) {
      expect([body, redactProviderBody(body).includes(secret)], body).toEqual([body, false])
    }
  })

  test('LlmProviderError.message is redacted while the classification still works', () => {
    // Both halves in one assertion: a redactor that broke classification would trade a leak for a
    // useless error, and the hint is the ONLY thing the user gets.
    const e = new LlmProviderError(401, '{"error":"Incorrect API key provided: sk-proj-SUPERSECRET1234"}')
    expect(e.message).not.toContain('SUPERSECRET1234')
    expect(e.message).toContain('LLM error (HTTP 401)')
    expect(e.failure.kind).toBe('auth')
    expect(e.failure.hint.length).toBeGreaterThan(10)
  })

  test('the stream variant is redacted too — a second construction site is easy to miss', () => {
    const e = new LlmProviderError(403, '{"error":"key-abcdef123456 rejected"}', true)
    expect(e.message).toContain('LLM stream error (HTTP 403)')
    expect(e.message).not.toContain('key-abcdef123456')
  })

  test('NON-control: a body with no credential is preserved, so the message stays diagnosable', () => {
    // Without this, a redactor that returned '[REDACTED]' for everything would pass every test above
    // and destroy the diagnostic value the message exists for.
    const out = redactProviderBody('{"error":{"message":"model gpt-9 does not exist"}}')
    expect(out).toContain('model gpt-9 does not exist')
    const short = redactProviderBody('{"error":"context length exceeded"}')
    expect(short).toBe('{"error":"context length exceeded"}')
  })

  test('redaction happens BEFORE the 200-char slice', () => {
    // A key straddling the boundary would leave a fragment behind if the slice came first.
    const body = `${'x'.repeat(190)} sk-proj-STRADDLINGKEY1234567890`
    const out = redactProviderBody(body).slice(0, 200)
    expect(out).not.toContain('STRADDLINGKEY1234567890')
    // Source fact, because the runtime assertion above cannot distinguish the two orderings when the
    // key happens to sit fully inside the window.
    const src = readFileSync(join(import.meta.dir, 'llm-client-utils.ts'), 'utf8')
    expect(src).toMatch(/redactProviderBody\(body\)\.slice\(0, 200\)/)
  })
})
