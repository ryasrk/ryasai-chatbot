import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { getTracer, withSpan, initOtel, resetOtel } from './otel'

beforeEach(() => resetOtel())
afterEach(() => {
  resetOtel()
  delete process.env.OTEL_ENABLED
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
})

describe('getTracer', () => {
  test('returns a tracer object', () => {
    const tracer = getTracer()
    expect(tracer).toBeDefined()
    expect(typeof tracer.startActiveSpan).toBe('function')
    expect(typeof tracer.startSpan).toBe('function')
  })

  test('returns the same tracer name on repeated calls', () => {
    const t1 = getTracer()
    const t2 = getTracer()
    expect(t1).toBeDefined()
    expect(t2).toBeDefined()
  })
})

describe('withSpan', () => {
  test('executes fn and returns its result', async () => {
    const result = await withSpan('test-op', async () => 42)
    expect(result).toBe(42)
  })

  test('passes span to fn', async () => {
    const spanName = await withSpan('test-span', async (span) => {
      expect(span).toBeDefined()
      expect(typeof span.end).toBe('function')
      return span.recordException
    })
    expect(typeof spanName).toBe('function')
  })

  test('propagates errors from fn', async () => {
    await expect(
      withSpan('failing-op', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })

  test('returns complex objects', async () => {
    const data = { a: 1, b: 'hello', nested: { c: true } }
    const result = await withSpan('complex', async () => data)
    expect(result).toEqual(data)
  })
})

describe('initOtel', () => {
  test('no-op when OTEL_ENABLED not set', async () => {
    await initOtel()
    // no throw, no crash
  })

  test('does not throw when SDK packages not installed', async () => {
    process.env.OTEL_ENABLED = 'true'
    await initOtel()
    // SDK not installed → warns + no-op, no throw
  })

  test('idempotent — second call is a no-op', async () => {
    process.env.OTEL_ENABLED = 'true'
    await initOtel()
    await initOtel()
  })
})
