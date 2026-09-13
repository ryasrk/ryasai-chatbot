import crypto from 'crypto'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  licenseStatusFromResult,
  licenseUpdateFromResult,
  getLockdownReason,
  isWithinGracePeriod,
  generateMachineId,
  type LicenseValidationResult,
} from './license-client'

function result(partial: Partial<LicenseValidationResult>): LicenseValidationResult {
  return {
    valid: false,
    plan: null,
    expiresAt: null,
    message: '',
    signatureVerified: false,
    ...partial,
  }
}

describe('licenseStatusFromResult', () => {
  test('signed + valid → valid', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: true, valid: true }))).toBe('valid')
  })

  test('signed + invalid + message "expired" → expired', () => {
    expect(
      licenseStatusFromResult(result({ signatureVerified: true, valid: false, message: 'License has expired.' })),
    ).toBe('expired')
  })

  test('signed + invalid + message "deactivated" → suspended', () => {
    expect(
      licenseStatusFromResult(
        result({ signatureVerified: true, valid: false, message: 'License has been deactivated.' }),
      ),
    ).toBe('suspended')
  })

  test('signed + invalid + other message → invalid', () => {
    expect(
      licenseStatusFromResult(
        result({ signatureVerified: true, valid: false, message: 'License key not found.' }),
      ),
    ).toBe('invalid')
  })

  test('unsigned (network error) → unreachable', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: false, valid: false }))).toBe('unreachable')
  })

  test('unsigned but valid=true (should not happen, but defensive) → unreachable', () => {
    expect(licenseStatusFromResult(result({ signatureVerified: false, valid: true }))).toBe('unreachable')
  })
})

describe('getLockdownReason', () => {
  test('valid → null (no lockdown)', () => {
    expect(getLockdownReason('valid', null)).toBeNull()
  })

  test('none → null (no lockdown)', () => {
    expect(getLockdownReason('none', null)).toBeNull()
  })

  test('expired → expired', () => {
    expect(getLockdownReason('expired', null)).toBe('expired')
  })

  test('invalid → expired', () => {
    expect(getLockdownReason('invalid', null)).toBe('expired')
  })

  test('suspended → deactivated', () => {
    expect(getLockdownReason('suspended', null)).toBe('deactivated')
  })

  test('unpaid → unpaid (licenseless signup, locked until purchase)', () => {
    expect(getLockdownReason('unpaid', null)).toBe('unpaid')
  })

  test('unreachable + within grace → null', () => {
    const recent = new Date(Date.now() - 60_000)
    expect(getLockdownReason('unreachable', recent)).toBeNull()
  })

  test('unreachable + beyond grace → unreachable', () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) // 8 days > 7-day default grace
    expect(getLockdownReason('unreachable', old)).toBe('unreachable')
  })

  test('unreachable + null validatedAt → unreachable', () => {
    expect(getLockdownReason('unreachable', null)).toBe('unreachable')
  })

  test('unknown status → null (fail open)', () => {
    expect(getLockdownReason('something-weird', null)).toBeNull()
  })
})

describe('isWithinGracePeriod', () => {
  test('null validatedAt → false', () => {
    expect(isWithinGracePeriod(null)).toBe(false)
  })

  test('recent validatedAt → true', () => {
    expect(isWithinGracePeriod(new Date(Date.now() - 60_000))).toBe(true)
  })

  test('old validatedAt → false', () => {
    expect(isWithinGracePeriod(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))).toBe(false)
  })
})

describe('generateMachineId', () => {
  test('slug + hostname → stable composite id', () => {
    const id = generateMachineId('acme')
    expect(id).toMatch(/^acme:/)
  })

  test('same slug + same hostname → same id', () => {
    expect(generateMachineId('acme')).toBe(generateMachineId('acme'))
  })

  test('different slug → different id', () => {
    expect(generateMachineId('acme')).not.toBe(generateMachineId('globex'))
  })
})

// ---------------------------------------------------------------------------
// licenseUpdateFromResult
// ---------------------------------------------------------------------------
// INCIDENT (2026-09): this four-field update payload was copy-pasted across
// four call sites (periodic revalidation, post-issue validation, admin
// revalidate route, retry route). They had already drifted — license-issue.ts
// wrote `result.plan ?? 'flat'`, the other three wrote bare `result.plan` — so
// the same signed response produced different DB writes depending on which code
// path handled it. These tests pin the two rules the helper now owns.
describe('licenseUpdateFromResult — verified+valid is the only path that advances state', () => {
  test('verified + valid sets status, plan, validatedAt and expiry', () => {
    const out = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: 'flat', expiresAt: '2030-01-01T00:00:00.000Z' }),
    )
    expect(out.licenseStatus).toBe('valid')
    expect(out.licensePlan).toBe('flat')
    expect(out.licenseValidatedAt).toBeInstanceOf(Date)
    expect(out.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('unsigned/unreachable NEVER advances licenseValidatedAt', () => {
    // Advancing validatedAt here would silence the 7-day grace window and lock
    // out a paying customer during a validator outage.
    const out = licenseUpdateFromResult(result({ message: 'timeout' }))
    expect(out.licenseStatus).toBe('unreachable')
    expect(out.licenseValidatedAt).toBeUndefined()
  })

  test('unsigned/unreachable NEVER wipes a known expiry', () => {
    // A network blip must not erase expiry metadata — a later grace check would
    // then see no expiry at all.
    const out = licenseUpdateFromResult(result({ message: 'timeout', expiresAt: '2030-01-01T00:00:00.000Z' }))
    expect(out.licenseExpiresAt).toBeUndefined()
    expect(out.licensePlan).toBeUndefined()
  })

  test('signed-but-expired does not advance validatedAt but keeps expiry', () => {
    const out = licenseUpdateFromResult(
      result({ valid: false, signatureVerified: true, message: 'license expired', expiresAt: '2020-01-01T00:00:00.000Z' }),
    )
    expect(out.licenseStatus).toBe('expired')
    expect(out.licenseValidatedAt).toBeUndefined()
    expect(out.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('planFallback applies ONLY when the signed response omits a plan', () => {
    // The drift that motivated the helper: post-issue validation must not lose
    // the plan, and an admin revalidate must not invent one.
    const noPlan = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: null }),
      { planFallback: 'flat' },
    )
    expect(noPlan.licensePlan).toBe('flat')

    const withPlan = licenseUpdateFromResult(
      result({ valid: true, signatureVerified: true, plan: 'enterprise' }),
      { planFallback: 'flat' },
    )
    expect(withPlan.licensePlan).toBe('enterprise')
  })

  test('unsigned responses never write a plan, even with a fallback', () => {
    // An unsigned response is untrusted — it must not be able to set a plan.
    const out = licenseUpdateFromResult(result({ plan: 'enterprise' }), { planFallback: 'flat' })
    expect(out.licensePlan).toBeUndefined()
  })

  test('no planFallback leaves plan untouched when response omits it', () => {
    const out = licenseUpdateFromResult(result({ valid: true, signatureVerified: true, plan: null }))
    expect(out.licensePlan).toBeUndefined()
  })

  test('undefined fields mean "leave previous value" for Prisma update', () => {
    // Prisma ignores `undefined` in update data, which is what makes the
    // conditional spreads safe. Assert we emit undefined, not null.
    const out = licenseUpdateFromResult(result({ message: 'blip' }))
    expect(Object.values(out).filter((v) => v === null)).toHaveLength(0)
  })
})
