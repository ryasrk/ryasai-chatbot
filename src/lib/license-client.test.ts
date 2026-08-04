import { describe, expect, test } from 'bun:test'
import {
  licenseStatusFromResult,
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
