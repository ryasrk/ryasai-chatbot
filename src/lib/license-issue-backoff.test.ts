import { describe, expect, test, mock } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks). Only the pure backoff
// math is under test — every side-effectful dep is stubbed out.
mock.module('./db', () => ({ db: {} }))
mock.module('./prisma-tenant', () => ({ bypassOrg: async <T,>(fn: () => T) => fn() }))
mock.module('./license-client', () => ({
  validateLicense: async () => ({ valid: true }),
  generateMachineId: () => 'm',
  licenseStatusFromResult: () => 'valid',
  // ponytail: license-issue.ts builds its Organization update via this shared
  // helper (extracted from 4 duplicated call sites), so the mock must expose it.
  licenseUpdateFromResult: () => ({ licenseStatus: 'valid' }),
}))
mock.module('./redis', () => ({
  jobQueue: { add: async () => ({}) },
  redis: {},
}))
mock.module('./logger', () => ({
  scopedLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

const { LICENSE_ISSUE_MAX_ATTEMPTS, licenseIssueBackoffDelayMs } = await import('./license-issue')

const MIN15 = 15 * 60 * 1000

describe('licenseIssueBackoffDelayMs — capped exponential', () => {
  test('starts at 30s and grows exponentially', () => {
    expect(licenseIssueBackoffDelayMs(1)).toBe(30_000)
    expect(licenseIssueBackoffDelayMs(2)).toBe(60_000)
    expect(licenseIssueBackoffDelayMs(3)).toBe(120_000)
  })

  test('caps at ~15 minutes so long validator outages stay retryable', () => {
    // 30s * 2^4 = 8min still under the cap; the cap first binds at attempt 6.
    expect(licenseIssueBackoffDelayMs(5)).toBe(480_000)
    expect(licenseIssueBackoffDelayMs(6)).toBe(MIN15)
    expect(licenseIssueBackoffDelayMs(10)).toBe(MIN15)
  })

  test('budget covers 10 attempts spanning roughly two hours', () => {
    expect(LICENSE_ISSUE_MAX_ATTEMPTS).toBe(10)
    const total = Array.from({ length: LICENSE_ISSUE_MAX_ATTEMPTS }, (_, i) =>
      licenseIssueBackoffDelayMs(i + 1),
    ).reduce((a, b) => a + b, 0)
    // 30s+60s+2m+4m+8m+15m×5 ≈ 94 min of backoff wall-clock
    expect(total).toBeGreaterThan(90 * 60 * 1000)
    expect(total).toBeLessThan(2 * 60 * 60 * 1000)
  })
})
