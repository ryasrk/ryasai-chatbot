import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { logger, scopedLogger, logSwallowed } from './logger'

const originalConsole = { ...console }
const logs: string[] = []

beforeEach(() => {
  logs.length = 0
  console.log = (...args: unknown[]) => logs.push(String(args[0]))
  console.warn = (...args: unknown[]) => logs.push(String(args[0]))
  console.error = (...args: unknown[]) => logs.push(String(args[0]))
  console.debug = (...args: unknown[]) => logs.push(String(args[0]))
})

afterEach(() => {
  Object.assign(console, originalConsole)
})

describe('logger — basic logging', () => {
  test('info writes JSON with level + msg', () => {
    logger.info('test message')
    const parsed = JSON.parse(logs[0])
    expect(parsed.level).toBe('info')
    expect(parsed.msg).toBe('test message')
    expect(parsed.ts).toBeDefined()
  })

  test('error writes to console.error', () => {
    logger.error('something broke')
    const parsed = JSON.parse(logs[0])
    expect(parsed.level).toBe('error')
    expect(parsed.msg).toBe('something broke')
  })

  test('warn writes to console.warn', () => {
    logger.warn('careful')
    const parsed = JSON.parse(logs[0])
    expect(parsed.level).toBe('warn')
  })

  test('metadata is merged into entry', () => {
    logger.info('with meta', { userId: 'u123', action: 'login' })
    const parsed = JSON.parse(logs[0])
    expect(parsed.userId).toBe('u123')
    expect(parsed.action).toBe('login')
  })

  test('no metadata → just level + msg + ts', () => {
    logger.info('plain')
    const parsed = JSON.parse(logs[0])
    expect(Object.keys(parsed).sort()).toEqual(['level', 'msg', 'ts'])
  })
})

describe('scopedLogger — component prefix', () => {
  test('adds component to metadata', () => {
    const scoped = scopedLogger('test-component')
    scoped.info('scoped message')
    const parsed = JSON.parse(logs[0])
    expect(parsed.component).toBe('test-component')
    expect(parsed.msg).toBe('scoped message')
  })

  test('component + custom metadata merged', () => {
    const scoped = scopedLogger('api')
    scoped.error('failed', { code: 500, path: '/api/test' })
    const parsed = JSON.parse(logs[0])
    expect(parsed.component).toBe('api')
    expect(parsed.code).toBe(500)
    expect(parsed.path).toBe('/api/test')
  })

  test('all 4 levels work on scoped logger', () => {
    const scoped = scopedLogger('all-levels')
    scoped.info('i')
    scoped.warn('w')
    scoped.error('e')
    expect(logs).toHaveLength(3)
    for (const log of logs) {
      expect(JSON.parse(log).component).toBe('all-levels')
    }
  })

  test('scoped logger info has level info', () => {
    const scoped = scopedLogger('verify-level')
    scoped.info('check')
    const parsed = JSON.parse(logs[0])
    expect(parsed.level).toBe('info')
    expect(parsed.component).toBe('verify-level')
  })
})

describe('logSwallowed — never-throw catch handler', () => {
  test('logs one error entry with the right component', () => {
    logSwallowed('planner: toolRun.create')(new Error('insert failed'))

    expect(logs).toHaveLength(1)
    const parsed = JSON.parse(logs[0])
    expect(parsed.level).toBe('error')
    expect(parsed.component).toBe('planner: toolRun.create')
    expect(parsed.msg).toBe('swallowed error')
    expect(parsed.err).toBe('insert failed')
  })

  test('works as a direct .catch() argument', async () => {
    await Promise.reject(new Error('fire and forget failed'))
      .catch(logSwallowed('llm-client: llmUsageLog.create'))

    const parsed = JSON.parse(logs[0])
    expect(parsed.component).toBe('llm-client: llmUsageLog.create')
    expect(parsed.err).toBe('fire and forget failed')
  })

  test('non-Error values do not throw and still log', () => {
    const handler = logSwallowed('non-error')

    for (const value of ['boom', undefined, null, { a: 1 }]) {
      expect(() => handler(value)).not.toThrow()
    }

    expect(logs).toHaveLength(4)
    expect(logs.map((l) => JSON.parse(l).err)).toEqual([
      'boom',
      'undefined',
      'null',
      '[object Object]',
    ])
    for (const line of logs) {
      expect(JSON.parse(line).level).toBe('error')
      expect(JSON.parse(line).component).toBe('non-error')
    }
  })

  test('does not throw when console.error is replaced by a throwing stub', () => {
    console.error = () => {
      throw new Error('console exploded')
    }

    const handler = logSwallowed('throwing-console')
    expect(() => handler(new Error('original failure'))).not.toThrow()
    expect(() => handler('boom')).not.toThrow()
  })

  test('truncates a very long stack to <= 500 chars', () => {
    const err = new Error('deep')
    err.stack = `Error: deep\n${'at frame()\n'.repeat(500)}`

    logSwallowed('long-stack')(err)

    const parsed = JSON.parse(logs[0])
    expect(parsed.stack.length).toBe(500)
    expect(parsed.err).toBe('deep')
  })

  test('omits stack for non-Error values', () => {
    logSwallowed('no-stack')({ message: 'not an error' })
    const parsed = JSON.parse(logs[0])
    expect(parsed.stack).toBeUndefined()
    expect(parsed.err).toBe('[object Object]')
  })
})
