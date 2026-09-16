/**
 * Tool Circuit Breaker — prevents cascading failures and token burn
 * when tools, plugins, or MCP servers become unresponsive or error repeatedly.
 * ----------------------------------------------------------------------------
 * Implements the standard Circuit Breaker state machine (Closed -> Open -> Half-Open)
 * with capability-aware fallback recommendations.
 */

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitMetrics {
  state: CircuitState
  consecutiveFailures: number
  totalFailures: number
  totalSuccesses: number
  lastFailureTime: number | null
  lastStateChange: number
}

export interface CircuitBreakerConfig {
  failureThreshold?: number // Default: 3 consecutive failures
  cooldownMs?: number // Default: 30,000 ms before half-open probe
}

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 30_000

class ToolCircuitBreakerManager {
  private circuits = new Map<string, CircuitMetrics>()
  private failureThreshold: number
  private cooldownMs: number

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = config?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD
    this.cooldownMs = config?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  public getMetrics(toolKey: string): CircuitMetrics {
    let metrics = this.circuits.get(toolKey)
    if (!metrics) {
      metrics = {
        state: 'closed',
        consecutiveFailures: 0,
        totalFailures: 0,
        totalSuccesses: 0,
        lastFailureTime: null,
        lastStateChange: Date.now(),
      }
      this.circuits.set(toolKey, metrics)
    }

    // Check if cooldown has elapsed to transition from open -> half_open
    if (metrics.state === 'open' && metrics.lastFailureTime) {
      if (Date.now() - metrics.lastFailureTime >= this.cooldownMs) {
        metrics.state = 'half_open'
        metrics.lastStateChange = Date.now()
      }
    }

    return metrics
  }

  public isExecutionAllowed(toolKey: string): { allowed: boolean; reason?: string } {
    const metrics = this.getMetrics(toolKey)
    if (metrics.state === 'closed' || metrics.state === 'half_open') {
      return { allowed: true }
    }
    const waitSec = Math.ceil((this.cooldownMs - (Date.now() - (metrics.lastFailureTime ?? 0))) / 1000)
    return {
      allowed: false,
      reason: `Tool "${toolKey}" is temporarily unavailable due to ${metrics.consecutiveFailures} consecutive failures (circuit open). Cooldown expires in ${Math.max(1, waitSec)}s.`,
    }
  }

  public recordSuccess(toolKey: string): void {
    const metrics = this.getMetrics(toolKey)
    metrics.consecutiveFailures = 0
    metrics.totalSuccesses += 1
    if (metrics.state === 'half_open' || metrics.state === 'open') {
      metrics.state = 'closed'
      metrics.lastStateChange = Date.now()
    }
  }

  public recordFailure(toolKey: string, error?: unknown): void {
    const metrics = this.getMetrics(toolKey)
    metrics.consecutiveFailures += 1
    metrics.totalFailures += 1
    metrics.lastFailureTime = Date.now()

    if (metrics.state === 'closed' && metrics.consecutiveFailures >= this.failureThreshold) {
      metrics.state = 'open'
      metrics.lastStateChange = Date.now()
    } else if (metrics.state === 'half_open') {
      metrics.state = 'open'
      metrics.lastStateChange = Date.now()
    }
  }

  public reset(toolKey?: string): void {
    if (toolKey) {
      this.circuits.delete(toolKey)
    } else {
      this.circuits.clear()
    }
  }
}

export const toolCircuitBreaker = new ToolCircuitBreakerManager()
