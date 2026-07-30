import { describe, expect, test } from 'bun:test'
import { publicConfig } from './public-config'

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
