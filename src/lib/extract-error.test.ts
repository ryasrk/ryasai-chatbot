import { describe, expect, test } from 'bun:test'
import { extractError } from './extract-error'

describe('extractError', () => {
  test('string error → returned as-is', () => {
    expect(extractError('Something broke', 'fallback')).toBe('Something broke')
  })

  test('object with message → extracts message', () => {
    expect(extractError({ message: 'DB connection failed' }, 'fallback')).toBe('DB connection failed')
  })

  test('object without message → fallback', () => {
    expect(extractError({ code: 500 }, 'fallback')).toBe('fallback')
  })

  test('null → fallback', () => {
    expect(extractError(null, 'fallback')).toBe('fallback')
  })

  test('undefined → fallback', () => {
    expect(extractError(undefined, 'fallback')).toBe('fallback')
  })

  test('number → fallback', () => {
    expect(extractError(42, 'fallback')).toBe('fallback')
  })

  test('typed error with code + hint → extracts message', () => {
    expect(extractError({ code: 'AUTH_FAILED', message: 'Invalid credentials', hint: 'Check password' }, 'fallback')).toBe('Invalid credentials')
  })
})
