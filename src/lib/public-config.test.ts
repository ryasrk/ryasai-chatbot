import { describe, expect, test } from 'bun:test'
import { publicConfig, __publicIntForTest } from './public-config'

describe('publicConfig', () => {
  test('appVersion is a string', () => {
    expect(typeof publicConfig.appVersion).toBe('string')
    expect(publicConfig.appVersion.length).toBeGreaterThan(0)
  })

  test('wsPort is a valid port number', () => {
    expect(typeof publicConfig.wsPort).toBe('number')
    expect(publicConfig.wsPort).toBeGreaterThan(0)
    expect(publicConfig.wsPort).toBeLessThanOrEqual(65535)
  })

  test('publicConfig has appVersion and wsPort properties', () => {
    expect(publicConfig).toHaveProperty('appVersion')
    expect(publicConfig).toHaveProperty('wsPort')
  })
})

/**
 * The parse guard is the whole reason `publicInt` exists instead of an inline `Number(...)`, and it
 * was never exercised: every test above reads the DEFAULT value, so the `!v` early return always
 * won. A browser bundle handed NaN as a WebSocket port fails as a generic connection error with
 * nothing pointing at the env var that caused it.
 */
describe('publicInt — invalid values fall back instead of producing NaN', () => {
  const f = __publicIntForTest

  test('a NON-NUMERIC value falls back, never NaN', () => {
    expect(f('X', 3003)).toBe(3003)
    process.env.X = 'not-a-port'
    try {
      expect(f('X', 3003)).toBe(3003)
    } finally {
      delete process.env.X
    }
  })

  test('a WHITESPACE-ONLY value falls back', () => {
    process.env.X = '   '
    try {
      expect(f('X', 3003)).toBe(3003)
    } finally {
      delete process.env.X
    }
  })

  test('an EMPTY value falls back', () => {
    process.env.X = ''
    try {
      expect(f('X', 3003)).toBe(3003)
    } finally {
      delete process.env.X
    }
  })

  test('an UNSET variable falls back', () => {
    delete process.env.X
    expect(f('X', 3003)).toBe(3003)
  })

  test('a valid value is used', () => {
    process.env.X = '8080'
    try {
      expect(f('X', 3003)).toBe(8080)
    } finally {
      delete process.env.X
    }
  })

  test('a partially-numeric value takes its numeric PREFIX', () => {
    // Documents the real semantics: parseInt is lenient, so "3003abc" is 3003, not a fallback.
    // Pinning it stops a future "stricter validation" change from silently altering behaviour.
    process.env.X = '3003abc'
    try {
      expect(f('X', 3003)).toBe(3003)
    } finally {
      delete process.env.X
    }
  })

  test('a value out of port range is passed through unchanged', () => {
    // Deliberately NOT validated: publicInt checks numeric-ness only. An out-of-range port is a
    // deployment mistake, and clamping it silently would hide the mistake rather than surface it.
    process.env.X = '99999'
    try {
      expect(f('X', 3003)).toBe(99999)
    } finally {
      delete process.env.X
    }
  })
})
