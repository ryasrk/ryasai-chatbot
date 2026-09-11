import { describe, expect, test } from 'bun:test'
import { aggregateHealth, sanitizeHealthError } from './health-status'

describe('health-status — aggregateHealth', () => {
  test('all healthy → ok, no degraded list', () => {
    const r = aggregateHealth({
      db: { ok: true, latencyMs: 3 },
      redis: { ok: true, latencyMs: 1 },
      validator: { ok: true, latencyMs: 12 },
    })
    expect(r).toEqual({ ok: true, degraded: [] })
  })

  test('db down → NOT ok even when everything else is fine', () => {
    const r = aggregateHealth({ db: { ok: false, error: 'x' }, redis: { ok: true } })
    expect(r.ok).toBe(false)
  })

  test('redis down → still ok, listed as degraded', () => {
    const r = aggregateHealth({ db: { ok: true }, redis: { ok: false, error: 'down' } })
    expect(r.ok).toBe(true)
    expect(r.degraded).toEqual(['redis'])
  })

  test('validator down → informational only, never fails the verdict', () => {
    const r = aggregateHealth({ db: { ok: true }, redis: { ok: true }, validator: { ok: false, error: 'unreachable' } })
    expect(r.ok).toBe(true)
    expect(r.degraded).toEqual(['validator'])
  })

  test('db down + optional deps down → not ok AND degraded lists them', () => {
    const r = aggregateHealth({
      db: { ok: false },
      redis: { ok: false },
      validator: { ok: false },
    })
    expect(r.ok).toBe(false)
    expect(r.degraded.sort()).toEqual(['redis', 'validator'])
  })
})

describe('health-status — sanitizeHealthError (anonymous-safe)', () => {
  test('strips parenthesized internals (hosts, SQL, paths)', () => {
    const e = new Error('Connection terminated due to connection timeout (db.internal.prod:5432)')
    expect(sanitizeHealthError(e, 'fallback')).toBe('Connection terminated due to connection timeout')
  })

  test('caps at 120 chars', () => {
    const e = new Error('x'.repeat(500))
    expect(sanitizeHealthError(e, 'fallback').length).toBeLessThanOrEqual(120)
  })

  test('non-Error and empty message → fallback / error name', () => {
    expect(sanitizeHealthError('boom', 'DB query failed')).toBe('DB query failed')
    expect(sanitizeHealthError(new Error(''), 'fallback')).toBe('Error')
  })
})
