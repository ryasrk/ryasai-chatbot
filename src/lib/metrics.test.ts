import { describe, expect, test, beforeEach } from 'bun:test'
import {
  counter,
  inc,
  set,
  observe,
  prometheusText,
  resetMetrics,
  initMetrics,
} from './metrics'

beforeEach(() => {
  resetMetrics()
  initMetrics()
})

describe('metrics — counter', () => {
  test('inc increments value', () => {
    inc('http_requests_total', { method: 'GET', path: '/api/health', status: '200' })
    inc('http_requests_total', { method: 'GET', path: '/api/health', status: '200' })
    const text = prometheusText()
    expect(text).toContain('http_requests_total')
    expect(text).toContain('method="GET"')
    expect(text).toContain('path="/api/health"')
    expect(text).toContain('status="200"')
  })

  test('inc with custom value', () => {
    inc('llm_tokens_total', { provider: 'openai' }, 150)
    const text = prometheusText()
    expect(text).toContain('llm_tokens_total')
    expect(text).toContain('150')
  })

  test('counter is idempotent (same name returns same metric)', () => {
    const c1 = counter('test_counter', 'test')
    const c2 = counter('test_counter', 'test')
    expect(c1).toBe(c2)
  })
})

describe('metrics — gauge', () => {
  test('set updates value', () => {
    set('active_sessions', 42)
    const text = prometheusText()
    expect(text).toContain('active_sessions')
    expect(text).toContain('42')
  })

  test('set with labels', () => {
    set('active_sessions', 10, { tenant: 'acme' })
    const text = prometheusText()
    expect(text).toContain('tenant="acme"')
    expect(text).toContain('10')
  })
})

describe('metrics — histogram', () => {
  test('observe records in buckets', () => {
    observe('http_request_duration_seconds', 0.05, { path: '/api/health' })
    observe('http_request_duration_seconds', 0.15, { path: '/api/health' })
    observe('http_request_duration_seconds', 3.0, { path: '/api/health' })
    const text = prometheusText()
    expect(text).toContain('http_request_duration_seconds_bucket')
    expect(text).toContain('le="0.05"')
    expect(text).toContain('le="0.1"')
    expect(text).toContain('le="+Inf"')
    expect(text).toContain('http_request_duration_seconds_sum')
    expect(text).toContain('http_request_duration_seconds_count')
    expect(text).toContain('3')
  })

  test('histogram without labels', () => {
    observe('llm_duration_seconds', 1.5)
    const text = prometheusText()
    expect(text).toContain('llm_duration_seconds_bucket')
    expect(text).toContain('llm_duration_seconds_count')
  })
})

describe('metrics — prometheusText format', () => {
  test('includes HELP and TYPE lines', () => {
    inc('http_requests_total', { method: 'GET' })
    const text = prometheusText()
    expect(text).toContain('# HELP http_requests_total')
    expect(text).toContain('# TYPE http_requests_total counter')
  })

  test('ends with newline', () => {
    inc('http_requests_total')
    const text = prometheusText()
    expect(text.endsWith('\n')).toBe(true)
  })

  test('includes all registered metrics', () => {
    const text = prometheusText()
    expect(text).toContain('http_requests_total')
    expect(text).toContain('llm_calls_total')
    expect(text).toContain('guardrail_blocks_total')
    expect(text).toContain('http_request_duration_seconds')
  })
})

describe('metrics — resetMetrics', () => {
  test('clears all metrics', () => {
    inc('http_requests_total', { method: 'GET' })
    resetMetrics()
    const text = prometheusText()
    expect(text).toBe('\n')
  })
})
