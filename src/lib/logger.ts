/**
 * Structured logger — JSON-formatted console output with levels.
 * ----------------------------------------------------------------------------
 * ponytail: no Pino/Winston dep — console.log with structure is enough for
 * current scale. Ceiling: no log rotation, no aggregation. Upgrade to Pino
 * when structured log shipping (CloudWatch/Datadog) is needed.
 *
 * Usage: import { logger } from '@/lib/logger'; logger.info('msg', { key: 'val' })
 */
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info'

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return

  const entry = {
    level,
    msg: message,
    ts: new Date().toISOString(),
    ...meta,
  }

  if (level === 'error') console.error(JSON.stringify(entry))
  else if (level === 'warn') console.warn(JSON.stringify(entry))
  else if (level === 'debug') console.debug(JSON.stringify(entry))
  else console.log(JSON.stringify(entry))
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
}

/**
 * Build a `.catch()` handler that records the error instead of discarding it.
 * ----------------------------------------------------------------------------
 * ponytail: this replaces silent `.catch(() => {})` on fire-and-forget writes
 * (usage logs, request logs, schema cache resets). Those swallows were chosen
 * deliberately — a failed observability write must never fail the user request
 * — but they were undebuggable: when ToolRun/LlmUsageLog/ApiRequestLog rows
 * stopped appearing nobody could tell whether the insert threw or never ran.
 *
 * ponytail: this handler must NEVER throw. A catch handler that throws turns
 * the original rejection into an unhandled rejection and can crash the process
 * under Bun — strictly worse than the silent swallow it replaces. Hence the
 * whole body is wrapped, and console output is expected to succeed silently.
 *
 * Usage: `db.toolRun.create(...).catch(logSwallowed('planner: toolRun.create'))`
 */
export function logSwallowed(component: string): (e: unknown) => void {
  return (e: unknown): void => {
    try {
      const message = e instanceof Error ? e.message : String(e)
      const stack = e instanceof Error && e.stack ? e.stack.slice(0, 500) : undefined
      scopedLogger(component).error('swallowed error', { err: message, stack })
    } catch {
      // ponytail: intentionally empty — see never-throw above. Nothing left to
      // do if even logging fails (e.g. a throwing console stub in tests).
    }
  }
}

/** Scoped logger — prefixes all messages with a component name. */
export function scopedLogger(component: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, { component, ...meta }),
    info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, { component, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, { component, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, { component, ...meta }),
  }
}
