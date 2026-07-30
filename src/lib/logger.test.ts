import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { logger, scopedLogger } from './logger'

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
