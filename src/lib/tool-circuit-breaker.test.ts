import { describe, test, expect, beforeEach } from 'bun:test'
import { toolCircuitBreaker } from './tool-circuit-breaker'

describe('toolCircuitBreaker — state machine & resilience', () => {
  beforeEach(() => {
    toolCircuitBreaker.reset()
  })

  test('initial state is closed and allows execution', () => {
    const check = toolCircuitBreaker.isExecutionAllowed('test_tool')
    expect(check.allowed).toBe(true)
    const metrics = toolCircuitBreaker.getMetrics('test_tool')
    expect(metrics.state).toBe('closed')
    expect(metrics.consecutiveFailures).toBe(0)
  })

  test('success resets consecutive failures', () => {
    toolCircuitBreaker.recordFailure('test_tool', new Error('fail 1'))
    toolCircuitBreaker.recordFailure('test_tool', new Error('fail 2'))
    expect(toolCircuitBreaker.getMetrics('test_tool').consecutiveFailures).toBe(2)

    toolCircuitBreaker.recordSuccess('test_tool')
    expect(toolCircuitBreaker.getMetrics('test_tool').consecutiveFailures).toBe(0)
    expect(toolCircuitBreaker.getMetrics('test_tool').state).toBe('closed')
    expect(toolCircuitBreaker.getMetrics('test_tool').totalSuccesses).toBe(1)
  })

  test('flips to open after failure threshold (3 failures by default)', () => {
    toolCircuitBreaker.recordFailure('test_tool', new Error('fail 1'))
    toolCircuitBreaker.recordFailure('test_tool', new Error('fail 2'))
    expect(toolCircuitBreaker.isExecutionAllowed('test_tool').allowed).toBe(true)

    toolCircuitBreaker.recordFailure('test_tool', new Error('fail 3'))
    const check = toolCircuitBreaker.isExecutionAllowed('test_tool')
    expect(check.allowed).toBe(false)
    expect(check.reason).toContain('temporarily unavailable due to 3 consecutive failures')
    expect(toolCircuitBreaker.getMetrics('test_tool').state).toBe('open')
  })

  test('transitions from open to half_open after cooldown', () => {
    toolCircuitBreaker.recordFailure('tool_cd', new Error('1'))
    toolCircuitBreaker.recordFailure('tool_cd', new Error('2'))
    toolCircuitBreaker.recordFailure('tool_cd', new Error('3'))
    expect(toolCircuitBreaker.getMetrics('tool_cd').state).toBe('open')

    // Simulate cooldown elapsed
    const metrics = toolCircuitBreaker.getMetrics('tool_cd')
    metrics.lastFailureTime = Date.now() - 35000 // 35s ago (>30s cooldown)

    const check = toolCircuitBreaker.isExecutionAllowed('tool_cd')
    expect(check.allowed).toBe(true)
    expect(toolCircuitBreaker.getMetrics('tool_cd').state).toBe('half_open')
  })

  test('half_open success closes the circuit, failure re-opens it', () => {
    // 1. Open and elapse cooldown
    toolCircuitBreaker.recordFailure('tool_trial', new Error('1'))
    toolCircuitBreaker.recordFailure('tool_trial', new Error('2'))
    toolCircuitBreaker.recordFailure('tool_trial', new Error('3'))
    const m = toolCircuitBreaker.getMetrics('tool_trial')
    m.lastFailureTime = Date.now() - 35000

    expect(toolCircuitBreaker.isExecutionAllowed('tool_trial').allowed).toBe(true)
    expect(toolCircuitBreaker.getMetrics('tool_trial').state).toBe('half_open')

    // Probe succeeds -> closed
    toolCircuitBreaker.recordSuccess('tool_trial')
    expect(toolCircuitBreaker.getMetrics('tool_trial').state).toBe('closed')
    expect(toolCircuitBreaker.getMetrics('tool_trial').consecutiveFailures).toBe(0)

    // Re-trigger failures -> open
    toolCircuitBreaker.recordFailure('tool_trial', new Error('1'))
    toolCircuitBreaker.recordFailure('tool_trial', new Error('2'))
    toolCircuitBreaker.recordFailure('tool_trial', new Error('3'))
    m.lastFailureTime = Date.now() - 35000
    toolCircuitBreaker.isExecutionAllowed('tool_trial') // now half_open

    // Probe fails -> immediately open
    toolCircuitBreaker.recordFailure('tool_trial', new Error('probe failed'))
    expect(toolCircuitBreaker.getMetrics('tool_trial').state).toBe('open')
    expect(toolCircuitBreaker.isExecutionAllowed('tool_trial').allowed).toBe(false)
  })

  test('isolated per tool key', () => {
    toolCircuitBreaker.recordFailure('tool_a', new Error('1'))
    toolCircuitBreaker.recordFailure('tool_a', new Error('2'))
    toolCircuitBreaker.recordFailure('tool_a', new Error('3'))

    expect(toolCircuitBreaker.isExecutionAllowed('tool_a').allowed).toBe(false)
    expect(toolCircuitBreaker.isExecutionAllowed('tool_b').allowed).toBe(true)
  })

  test('reset clears metrics', () => {
    toolCircuitBreaker.recordFailure('tool_x', new Error('1'))
    toolCircuitBreaker.reset('tool_x')
    expect(toolCircuitBreaker.getMetrics('tool_x').consecutiveFailures).toBe(0)
    expect(toolCircuitBreaker.getMetrics('tool_x').state).toBe('closed')
  })
})
