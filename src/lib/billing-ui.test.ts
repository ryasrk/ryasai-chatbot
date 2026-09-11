import { describe, expect, test } from 'bun:test'
import {
  daysUntilExpiry,
  expiryCountdownLabel,
  formatIdr,
  isTerminalOrderStatus,
  pollOutcome,
  snapScriptUrl,
} from './billing-ui'

describe('formatIdr', () => {
  test('groups thousands with dots, no decimals', () => {
    expect(formatIdr(100000)).toBe('Rp100.000')
    expect(formatIdr(840000)).toBe('Rp840.000')
    expect(formatIdr(1234567)).toBe('Rp1.234.567')
  })

  test('small and zero amounts stay ungrouped', () => {
    expect(formatIdr(0)).toBe('Rp0')
    expect(formatIdr(999)).toBe('Rp999')
  })

  test('truncates fractional rupiah', () => {
    expect(formatIdr(100050.75)).toBe('Rp100.050')
  })
})

describe('pollOutcome — order status poll state machine', () => {
  test('settlement stops with settled', () => {
    expect(pollOutcome('settlement')).toEqual({ stop: true, result: 'settled' })
  })

  test('every non-settlement terminal status stops with failed', () => {
    for (const s of ['expire', 'deny', 'cancel', 'failure']) {
      expect(pollOutcome(s)).toEqual({ stop: true, result: 'failed' })
    }
  })

  test('pending keeps polling', () => {
    expect(pollOutcome('pending')).toEqual({ stop: false })
  })

  test('unknown status keeps polling (transient API hiccup must not abort payment)', () => {
    expect(pollOutcome('')).toEqual({ stop: false })
    expect(pollOutcome('garbage')).toEqual({ stop: false })
  })

  test('isTerminalOrderStatus agrees with the machine', () => {
    expect(isTerminalOrderStatus('settlement')).toBe(true)
    expect(isTerminalOrderStatus('expire')).toBe(true)
    expect(isTerminalOrderStatus('pending')).toBe(false)
    expect(isTerminalOrderStatus('whatever')).toBe(false)
  })
})

describe('daysUntilExpiry / countdown label', () => {
  const now = new Date('2026-08-26T09:00:00.000Z')

  test('ceils partial days upward', () => {
    // 2.5 days left → 3 whole days
    expect(daysUntilExpiry(new Date('2026-08-28T21:00:00.000Z'), now)).toBe(3)
    expect(daysUntilExpiry(new Date('2026-08-27T00:00:00.000Z'), now)).toBe(1)
  })

  test('past dates are negative', () => {
    expect(daysUntilExpiry(new Date('2026-08-20T00:00:00.000Z'), now)).toBeLessThan(0)
  })

  test('accepts ISO strings too', () => {
    expect(daysUntilExpiry('2026-09-02T00:00:00.000Z', now)).toBe(7)
  })

  test('labels match the reminder thresholds', () => {
    expect(expiryCountdownLabel(new Date('2026-09-02T00:00:00.000Z'), now)).toBe('Expires in 7 days')
    expect(expiryCountdownLabel(new Date('2026-08-27T00:00:00.000Z'), now)).toBe('Expires tomorrow')
    expect(expiryCountdownLabel(new Date('2026-08-20T00:00:00.000Z'), now)).toBe('Expired')
  })
})

describe('snapScriptUrl', () => {
  test('sandbox vs production domains', () => {
    expect(snapScriptUrl(false)).toContain('app.sandbox.midtrans.com')
    expect(snapScriptUrl(true)).toContain('app.midtrans.com')
  })
})
