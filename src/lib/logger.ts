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

/** Scoped logger — prefixes all messages with a component name. */
export function scopedLogger(component: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, { component, ...meta }),
    info: (msg: string, meta?: Record<string, unknown>) => log('info', msg, { component, ...meta }),
    warn: (msg: string, meta?: Record<string, unknown>) => log('warn', msg, { component, ...meta }),
    error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, { component, ...meta }),
  }
}
