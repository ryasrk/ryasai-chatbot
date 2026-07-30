import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { validateEnv, resetEnvValidation } from './env-schema'

const env = process.env as Record<string, string | undefined>

beforeEach(() => {
  resetEnvValidation()
})

afterEach(() => {
  resetEnvValidation()
})

describe('env-schema — validateEnv', () => {
  test('dev mode → no validation (returns empty warnings)', () => {
    const original = env.NODE_ENV
    env.NODE_ENV = 'development'
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    env.NODE_ENV = original
  })

  test('test mode → no validation', () => {
    const original = env.NODE_ENV
    env.NODE_ENV = 'test'
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    env.NODE_ENV = original
  })

  test('production with valid env → no warnings', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    delete env.AUTH_DEMO_FALLBACK
    const { warnings } = validateEnv()
    expect(warnings).toEqual([])
    Object.assign(env, original)
  })

  test('production with short key → warning', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'shortkey'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('shorter than 32'))).toBe(true)
    Object.assign(env, original)
  })

  test('production with placeholder key → warning', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'testkey12345678'
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('placeholder'))).toBe(true)
    Object.assign(env, original)
  })

  test('production with AUTH_DEMO_FALLBACK=true → warning', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    env.ENCRYPTION_SECRET_KEY = 'a'.repeat(64)
    env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    env.AUTH_DEMO_FALLBACK = 'true'
    const { warnings } = validateEnv()
    expect(warnings.some((w) => w.includes('AUTH_DEMO_FALLBACK'))).toBe(true)
    Object.assign(env, original)
  })

  test('production with missing ENCRYPTION_SECRET_KEY → throws', () => {
    const original = { ...env }
    env.NODE_ENV = 'production'
    delete env.ENCRYPTION_SECRET_KEY
    expect(() => validateEnv()).toThrow()
    Object.assign(env, original)
  })

  test('idempotent — calling twice returns same warnings', () => {
    env.NODE_ENV = 'development'
    const r1 = validateEnv()
    const r2 = validateEnv()
    expect(r2.warnings).toEqual(r1.warnings)
  })

  test('resetEnvValidation allows re-validation', () => {
    env.NODE_ENV = 'development'
    validateEnv()
    resetEnvValidation()
    validateEnv()
  })
})
