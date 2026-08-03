import { describe, expect, test } from 'bun:test'
import { ConnectorRegistry } from './connectors'

describe('ConnectorRegistry', () => {
  test('passes the raw provider id to the connector (for TLS defaults)', () => {
    const reg = new ConnectorRegistry()
    const c = reg.getConnector('supabase-int', 'SUPABASE', {}) as unknown as {
      provider: string
      _providerId?: string
    }
    expect(c.provider).toBe('POSTGRESQL')
    expect(c._providerId).toBe('SUPABASE')
  })

  test('reapIdle drops pools idle longer than timeoutMs', () => {
    const reg = new ConnectorRegistry()
    reg.getConnector('idle-int', 'POSTGRESQL', {})
    ;(reg as unknown as { _lastUsedAt: Map<string, number> })._lastUsedAt.set(
      'idle-int',
      Date.now() - 11 * 60 * 1000,
    )
    expect(reg.reapIdle(10 * 60 * 1000)).toBe(1)
    expect((reg as unknown as { _pools: Map<string, unknown> })._pools.has('idle-int')).toBe(false)
  })

  test('reapIdle keeps recently used pools', () => {
    const reg = new ConnectorRegistry()
    const c = reg.getConnector('recent-int', 'POSTGRESQL', {})
    expect(reg.reapIdle(10 * 60 * 1000)).toBe(0)
    expect((reg as unknown as { _pools: Map<string, unknown> })._pools.has('recent-int')).toBe(true)
    void c.close?.()
  })
})
