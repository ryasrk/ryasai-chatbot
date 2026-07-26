import { test, expect, describe, mock, afterEach } from 'bun:test'
import { traceLlmCall, getRecentTraces, getTraceStats } from '@/lib/observability'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  delete process.env.LANGFUSE_PUBLIC_KEY
  delete process.env.LANGFUSE_SECRET_KEY
  delete process.env.LANGFUSE_BASEURL
  delete process.env.HELICONE_API_KEY
})

describe('observability — in-memory ring buffer + stats', () => {
  test('traceLlmCall records a trace retrievable via getRecentTraces', () => {
    const purpose = `test-unique-${Date.now()}-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'OPENAI_COMPATIBLE',
      model: 'test-model',
      inputPreview: 'hello',
      outputPreview: 'world',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      latencyMs: 42,
    })
    const recent = getRecentTraces(1)
    expect(recent.length).toBe(1)
    expect(recent[0].purpose).toBe(purpose)
    expect(recent[0].model).toBe('test-model')
    expect(recent[0].latencyMs).toBe(42)
    expect(recent[0].id).toBeTruthy()
    expect(recent[0].timestamp).toBeInstanceOf(Date)
  })

  test('getRecentTraces returns most-recent-first', () => {
    const a = `first-${Math.random()}`
    const b = `second-${Math.random()}`
    traceLlmCall({ purpose: a, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 1 })
    traceLlmCall({ purpose: b, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 2 })
    const recent = getRecentTraces(2)
    expect(recent[0].purpose).toBe(b)
    expect(recent[1].purpose).toBe(a)
  })

  test('getTraceStats reflects additions (delta-based, order-independent)', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `stats-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      latencyMs: 200,
      error: undefined,
    })
    const after = getTraceStats()
    expect(after.totalCalls).toBe(before.totalCalls + 1)
    expect(after.totalTokens).toBeGreaterThanOrEqual(before.totalTokens + 150)
  })

  test('getTraceStats counts error rate from errored traces', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `err-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
      error: 'boom',
    })
    const after = getTraceStats()
    expect(after.totalCalls).toBe(before.totalCalls + 1)
    expect(after.errorRate).toBeGreaterThan(0)
  })

  test('ring buffer caps at 100 entries', () => {
    for (let i = 0; i < 150; i++) {
      traceLlmCall({
        purpose: `cap-${i}`,
        provider: 'x',
        model: 'm',
        inputPreview: '',
        outputPreview: '',
        latencyMs: i,
      })
    }
    const recent = getRecentTraces(500)
    expect(recent.length).toBeLessThanOrEqual(100)
    expect(recent[0].purpose).toBe('cap-149')
  })
})

describe('observability — trace fields', () => {
  test('records toolCalls field', () => {
    const purpose = `tools-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      toolCalls: [{ name: 'sql', arguments: '{"q":"test"}' }],
    })
    const recent = getRecentTraces(1)
    expect(recent[0].toolCalls).toEqual([{ name: 'sql', arguments: '{"q":"test"}' }])
  })

  test('records error field when present', () => {
    const purpose = `errfield-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      error: 'timeout',
    })
    const recent = getRecentTraces(1)
    expect(recent[0].error).toBe('timeout')
  })

  test('usage undefined → totalTokens not incremented', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `notok-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
    })
    const after = getTraceStats()
    expect(after.totalTokens).toBe(before.totalTokens)
  })

  test('getRecentTraces with limit larger than buffer returns all', () => {
    const purpose = `large-${Math.random()}`
    traceLlmCall({ purpose, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 1 })
    const recent = getRecentTraces(10000)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent.length).toBeLessThanOrEqual(100)
  })

  test('avgLatencyMs is a positive number', () => {
    const stats = getTraceStats()
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0)
    expect(typeof stats.avgLatencyMs).toBe('number')
  })
})

describe('observability — forwardTrace (fire-and-forget)', () => {
  test('Langfuse env vars set → calls fetch to langfuse endpoint', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    process.env.LANGFUSE_BASEURL = 'https://lf.example.com'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const purpose = `lf-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'OPENAI_COMPATIBLE',
      model: 'm',
      inputPreview: 'in',
      outputPreview: 'out',
      latencyMs: 100,
    })

    // fire-and-forget — wait for microtask queue to flush
    await new Promise((r) => setTimeout(r, 50))

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const langfuseCalls = calls.filter(
      (c) => c[0].includes('lf.example.com'),
    )
    expect(langfuseCalls.length).toBeGreaterThan(0)
  })

  test('Helicone env var set → calls fetch to helicone endpoint', async () => {
    process.env.HELICONE_API_KEY = 'hc-test'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    traceLlmCall({
      purpose: `hc-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const hcCalls = calls.filter(
      (c) => c[0].includes('hconeai.com'),
    )
    expect(hcCalls.length).toBeGreaterThan(0)
  })

  test('no env vars → no fetch calls', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    traceLlmCall({
      purpose: `noenv-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  test('forward failure does not throw (swallowed)', async () => {
    process.env.HELICONE_API_KEY = 'hc-test'
    global.fetch = mock(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch

    // should not throw — fire-and-forget with .catch(() => {})
    traceLlmCall({
      purpose: `fail-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))
    // trace still recorded in buffer
    const recent = getRecentTraces(1)
    expect(recent[0].purpose).toMatch(/^fail-/)
  })
})
