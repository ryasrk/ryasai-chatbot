import { test, expect, describe } from 'bun:test'
import { traceLlmCall, getRecentTraces, getTraceStats } from '@/lib/observability'

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
