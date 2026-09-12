import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

const mockChatOnce = mock(async () => '')
const mockGetRoleLlmConfig = mock(async (): Promise<unknown> => null)

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: mockGetRoleLlmConfig,
  getLlmRuntimeConfig: mockGetRoleLlmConfig,
}))

import { checkAlignment, isAlignmentCheckEnabled } from './alignment-check'

const originalFetch = global.fetch
const MOCK_CFG = { id: 'c', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  mockChatOnce.mockClear()
  mockGetRoleLlmConfig.mockClear()
  mockChatOnce.mockImplementation(async () => '')
  mockGetRoleLlmConfig.mockImplementation(async () => null)
})

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.ALIGNMENT_CHECK
  delete process.env.ALIGNMENT_CHECK_URL
})

describe('checkAlignment', () => {
  test('disabled mode returns safe default', async () => {
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('low')
    expect(result.reason).toBe('alignment check disabled')
  })

  test('HTTP mode posts to endpoint and parses response', async () => {
    process.env.ALIGNMENT_CHECK_URL = 'http://localhost:9999/check'
    global.fetch = mock(async () => jsonRes({ aligned: false, risk: 'high', reason: 'goal hijacking detected' })) as never
    const result = await checkAlignment('doing something else', 'original goal')
    expect(result.aligned).toBe(false)
    expect(result.risk).toBe('high')
    expect(result.reason).toBe('goal hijacking detected')
  })

  test('HTTP mode returns safe default on fetch error', async () => {
    process.env.ALIGNMENT_CHECK_URL = 'http://localhost:9999/check'
    global.fetch = mock(async () => { throw new Error('connection refused') }) as never
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('low')
  })

  test('HTTP mode returns safe default on non-200', async () => {
    process.env.ALIGNMENT_CHECK_URL = 'http://localhost:9999/check'
    global.fetch = mock(async () => new Response('error', { status: 500 })) as never
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('low')
  })

  test('LLM mode uses chatOnce and parses JSON response', async () => {
    process.env.ALIGNMENT_CHECK = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CFG)
    mockChatOnce.mockImplementation(async () => JSON.stringify({ aligned: true, risk: 'medium', reason: 'slight deviation' }))
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('medium')
    expect(result.reason).toBe('slight deviation')
  })

  test('LLM mode returns safe default when no LLM configured', async () => {
    process.env.ALIGNMENT_CHECK = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => null)
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('low')
  })

  test('LLM mode handles malformed JSON gracefully', async () => {
    process.env.ALIGNMENT_CHECK = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CFG)
    mockChatOnce.mockImplementation(async () => 'not json')
    const result = await checkAlignment('reasoning', 'goal')
    expect(result.aligned).toBe(true)
    expect(result.risk).toBe('low')
  })

  test('LLM mode handles high risk response', async () => {
    process.env.ALIGNMENT_CHECK = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CFG)
    mockChatOnce.mockImplementation(async () => JSON.stringify({ aligned: false, risk: 'high', reason: 'agent is exfiltrating data' }))
    const result = await checkAlignment('exfiltrating data', 'answer user question')
    expect(result.aligned).toBe(false)
    expect(result.risk).toBe('high')
    expect(result.reason).toBe('agent is exfiltrating data')
  })
})

// ---------------------------------------------------------------------------
// REGRESSION (2026-09 audit): the env contract was never tested, and it was
// broken. `env-schema.ts` declares ALIGNMENT_CHECK as
// z.enum(['http','llm','disabled']) — so `ALIGNMENT_CHECK=llm` is a
// SCHEMA-VALID value an operator can reasonably set to turn the judge on — but
// every call site tested `=== 'true'`. Setting the documented value therefore
// DISABLED the guardrail silently: fail-open in a security control, reachable
// by following the schema. These tests pin the whole enum, not just the one
// spelling that happened to work.
// ---------------------------------------------------------------------------
describe('isAlignmentCheckEnabled (env contract)', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  const cases: Array<[string | undefined, boolean, string]> = [
    ['llm', true, 'llm is the documented way to enable the LLM judge'],
    ['http', true, 'http is a valid enable value'],
    ['true', true, 'legacy truthy spelling must keep working'],
    ['disabled', false, 'explicit off'],
    [undefined, false, 'unset must not enable'],
    ['', false, 'empty must not enable'],
  ]

  for (const [value, expected, why] of cases) {
    test(`ALIGNMENT_CHECK=${JSON.stringify(value)} -> ${expected} (${why})`, () => {
      delete process.env.ALIGNMENT_CHECK
      delete process.env.ALIGNMENT_CHECK_URL
      if (value !== undefined) process.env.ALIGNMENT_CHECK = value
      expect(isAlignmentCheckEnabled()).toBe(expected)
    })
  }

  test('ALIGNMENT_CHECK_URL alone enables the HTTP judge', () => {
    delete process.env.ALIGNMENT_CHECK
    process.env.ALIGNMENT_CHECK_URL = 'http://localhost:9999/check'
    expect(isAlignmentCheckEnabled()).toBe(true)
  })

  test('case and whitespace do not defeat the gate', () => {
    delete process.env.ALIGNMENT_CHECK_URL
    for (const v of ['LLM', ' llm ', 'Http', 'TRUE']) {
      process.env.ALIGNMENT_CHECK = v
      expect(isAlignmentCheckEnabled()).toBe(true)
    }
  })
})
