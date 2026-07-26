import { describe, expect, test, mock } from 'bun:test'

// --- Mocks so errors.ts → session.ts → db/crypto/headers chain loads cleanly ---
mock.module('@/lib/db', () => ({
  db: {
    user: { findUnique: mock(async () => null), findFirst: mock(async () => null) },
    auditLog: { create: mock(async () => ({})) },
  },
}))
mock.module('@/lib/crypto', () => ({
  verifySession: mock(() => null),
  extractSessionVersion: () => 0,
}))
mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

import { AppError, LlmNotConfiguredError, toTypedError, type ErrorCode } from './errors'
import { UnauthorizedError } from './session'

describe('AppError', () => {
  test('constructor with all params (code, message, hint, statusCode, cause)', () => {
    const cause = new Error('root cause')
    const err = new AppError('SQL_ERROR', 'bad query', { hint: 'check syntax', statusCode: 422, cause })
    expect(err.code).toBe('SQL_ERROR')
    expect(err.message).toBe('bad query')
    expect(err.hint).toBe('check syntax')
    expect(err.statusCode).toBe(422)
    expect(err.name).toBe('AppError')
    expect((err as any).cause).toBe(cause)
    expect(err instanceof Error).toBe(true)
  })

  test('without statusCode uses defaultStatusForCode', () => {
    const err = new AppError('NOT_FOUND', 'missing')
    expect(err.statusCode).toBe(404)
  })

  test('without hint → hint is undefined', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad input')
    expect(err.hint).toBeUndefined()
  })

  test('without opts at all → defaults for hint and statusCode', () => {
    const err = new AppError('CONFIG_ERROR', 'boom')
    expect(err.hint).toBeUndefined()
    expect(err.statusCode).toBe(500)
  })

  test('cause not set when omitted', () => {
    const err = new AppError('LLM_ERROR', 'fail', { hint: 'retry' })
    expect((err as any).cause).toBeUndefined()
  })

  test('statusCode explicit overrides default', () => {
    const err = new AppError('NOT_FOUND', 'missing', { statusCode: 410 })
    expect(err.statusCode).toBe(410)
  })
})

describe('defaultStatusForCode — all 16 error codes', () => {
  const cases: Array<[ErrorCode, number]> = [
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['VALIDATION_ERROR', 400],
    ['RATE_LIMITED', 429],
    ['LLM_NOT_CONFIGURED', 503],
    ['LLM_ERROR', 502],
    ['LLM_TIMEOUT', 502],
    ['GUARDRAIL_BLOCK', 403],
    ['SQL_ERROR', 502],
    ['REST_ERROR', 502],
    ['PLUGIN_ERROR', 502],
    ['MCP_ERROR', 502],
    ['CONFIG_ERROR', 500],
    ['SETUP_REQUIRED', 503],
    ['INTERNAL_ERROR', 500],
  ]
  for (const [code, expected] of cases) {
    test(`${code} → ${expected}`, () => {
      const err = new AppError(code, 'msg')
      expect(err.statusCode).toBe(expected)
    })
  }
})

describe('LlmNotConfiguredError', () => {
  test('has correct name and message', () => {
    const err = new LlmNotConfiguredError()
    expect(err.name).toBe('LlmNotConfiguredError')
    expect(err.message).toContain('LLM is not configured')
    expect(err instanceof Error).toBe(true)
  })
})

describe('toTypedError', () => {
  test('AppError → preserves code, message, hint, statusCode', () => {
    const err = new AppError('SQL_ERROR', 'bad', { hint: 'fix it', statusCode: 422 })
    const typed = toTypedError(err)
    expect(typed.code).toBe('SQL_ERROR')
    expect(typed.message).toBe('bad')
    expect(typed.hint).toBe('fix it')
    expect(typed.statusCode).toBe(422)
  })

  test('AppError without hint → no hint in result', () => {
    const err = new AppError('NOT_FOUND', 'missing')
    const typed = toTypedError(err)
    expect(typed.hint).toBeUndefined()
    expect(typed.code).toBe('NOT_FOUND')
    expect(typed.statusCode).toBe(404)
  })

  test('UnauthorizedError → UNAUTHORIZED + 401', () => {
    const err = new UnauthorizedError('no session')
    const typed = toTypedError(err)
    expect(typed.code).toBe('UNAUTHORIZED')
    expect(typed.message).toBe('no session')
    expect(typed.statusCode).toBe(401)
    expect(typed.hint).toBeUndefined()
  })

  test('UnauthorizedError default message', () => {
    const err = new UnauthorizedError()
    const typed = toTypedError(err)
    expect(typed.code).toBe('UNAUTHORIZED')
    expect(typed.statusCode).toBe(401)
    expect(typed.message).toBe('No active session.')
  })

  test('LlmNotConfiguredError → LLM_NOT_CONFIGURED + 503', () => {
    const err = new LlmNotConfiguredError()
    const typed = toTypedError(err)
    expect(typed.code).toBe('LLM_NOT_CONFIGURED')
    expect(typed.message).toContain('LLM is not configured')
    expect(typed.statusCode).toBe(503)
    expect(typed.hint).toBeUndefined()
  })

  test('generic Error → INTERNAL_ERROR + 500 + message preserved', () => {
    const err = new Error('boom')
    const typed = toTypedError(err)
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('boom')
    expect(typed.statusCode).toBe(500)
  })

  test('string → INTERNAL_ERROR + 500 + String(e) as message', () => {
    const typed = toTypedError('something broke')
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('something broke')
    expect(typed.statusCode).toBe(500)
  })

  test('unknown (object) → INTERNAL_ERROR + 500 + String(e)', () => {
    const typed = toTypedError({ weird: true })
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('[object Object]')
    expect(typed.statusCode).toBe(500)
  })

  test('null → INTERNAL_ERROR + 500 + "null"', () => {
    const typed = toTypedError(null)
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('null')
    expect(typed.statusCode).toBe(500)
  })

  test('undefined → INTERNAL_ERROR + 500 + "undefined"', () => {
    const typed = toTypedError(undefined)
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('undefined')
    expect(typed.statusCode).toBe(500)
  })

  test('number → INTERNAL_ERROR + 500 + stringified number', () => {
    const typed = toTypedError(42)
    expect(typed.code).toBe('INTERNAL_ERROR')
    expect(typed.message).toBe('42')
    expect(typed.statusCode).toBe(500)
  })
})
