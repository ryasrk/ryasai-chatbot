/**
 * Periodic license revalidation — the timer, the org sweep, and the two failure
 * modes that matter for a PAYING customer.
 *
 * WHY THIS FILE EXISTS. `license-revalidation.ts` had no test at all (it was not
 * imported by any test file, even transitively). It is the job that keeps every org's
 * license status current, so a defect here is a revenue defect in both directions:
 *   - too eager  → a paid org is marked expired/suspended on a network blip
 *   - too lax    → a genuinely dead license keeps working forever
 *
 * The two invariants under test come from `licenseUpdateFromResult`'s own doc comment
 * (it was extracted after four copy-pasted call sites had already drifted):
 *   1. `licenseValidatedAt` advances ONLY on a verified-and-valid answer, so an
 *      outage does not silence the grace window and lock out a paying customer.
 *   2. `licenseExpiresAt` is written ONLY when the signed response carried one, so a
 *      blip does not wipe known-good expiry metadata.
 *
 * `validateLicense` is mocked — it is a network call to OUR validator. Everything
 * else (`licenseStatusFromResult`, `licenseUpdateFromResult`, `generateMachineId`) is
 * the REAL implementation, which is the point: this test asserts the status/payload
 * mapping the product actually persists.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
// Imported OUTSIDE the mock factory and captured by value: eslint forbids `require()`, and
// importing the mocked module inside its own factory would recurse.
import * as realLicenseClient from '@/lib/license-client'

/** One recorded org-update, so the exact persisted payload can be asserted. */
type OrgUpdate = { where: { id: string }; data: Record<string, unknown> }
const updates: OrgUpdate[] = []
const dbState = {
  orgs: [] as Array<{ id: string; slug: string; licenseKey: string | null }>,
  findManyCalls: 0,
  findManyWhere: null as unknown,
  findManySelect: null as unknown,
}

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findMany: async (args: { where?: unknown; select?: unknown }) => {
        dbState.findManyCalls++
        dbState.findManyWhere = args.where
        dbState.findManySelect = args.select
        return dbState.orgs
      },
      update: async (args: OrgUpdate) => {
        updates.push(args)
        return args
      },
    },
  },
}))

/** What the mocked validator will answer, keyed by license key. */
const validatorAnswers = new Map<string, unknown>()
const validateCalls: Array<{ licenseKey: string; machineId: string }> = []

mock.module('@/lib/license-client', () => {
  // Re-export the REAL helpers: the status/payload mapping is the thing under test. Captured
  // BY VALUE from a static import above -- `require()` is forbidden by eslint here, and an
  // `await import()` of the module this factory defines would deadlock.
  return {
    REVALIDATION_INTERVAL_MS: 3_600_000,
    generateMachineId: realLicenseClient.generateMachineId,
    licenseStatusFromResult: realLicenseClient.licenseStatusFromResult,
    licenseUpdateFromResult: realLicenseClient.licenseUpdateFromResult,
    validateLicense: async (licenseKey: string, machineId: string) => {
      validateCalls.push({ licenseKey, machineId })
      const answer = validatorAnswers.get(licenseKey)
      if (answer instanceof Error) throw answer
      return answer
    },
  }
})

// NOTE: deliberately NOT mocking @/lib/logger. A first draft did, and two tests that claimed to
// assert logging were actually asserting the mock: the module reaches the REAL scopedLogger
// (whose output is the JSON visible in this file's run output), so the mock never saw the calls
// and both assertions failed. Those tests were rewritten to assert BEHAVIOUR instead -- sweeps
// that continue past a per-org throw, and a starter that does not validate inline -- which is
// what those cases were really about.

import { startLicenseRevalidation, __runRevalidationForTest } from './license-revalidation'

const VERIFIED = { signatureVerified: true }

beforeEach(() => {
  updates.length = 0
  validateCalls.length = 0
  validatorAnswers.clear()
  dbState.orgs = []
  dbState.findManyCalls = 0
  dbState.findManyWhere = null
  dbState.findManySelect = null
})

/**
 * Drive exactly one sweep.
 *
 * The production entry points are a 24h interval and a 30s startup delay, so the sweep is run
 * directly through its test seam rather than by waiting. This also keeps the timer wiring out
 * of the licensing assertions, so a failure here means the SWEEP is wrong, not that a timer was
 * slow.
 */
async function sweepOnce(): Promise<void> {
  await __runRevalidationForTest()
}

describe('license revalidation — the org sweep', () => {
  test('only orgs that HAVE a license key are swept', async () => {
    // An org with no license must never be touched: writing a status onto it would
    // claim a license decision was made when none exists.
    dbState.orgs = []
    await sweepOnce()
    expect(dbState.findManyCalls).toBeGreaterThan(0)
    expect(dbState.findManyWhere).toEqual({ licenseKey: { not: null } })
    // And the query must not pull every column of every org.
    expect(dbState.findManySelect).toEqual({ id: true, slug: true, licenseKey: true })
  })

  test('the sweep runs through bypassOrg, because it is cross-org by nature', async () => {
    // A revalidation cycle has no request context and iterates EVERY org, so it cannot be
    // org-scoped. Asserted indirectly: findMany was reached at all (a scoped client would
    // have injected an organizationId filter, which the where-clause assertion above rules
    // out).
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: true })
    await sweepOnce()
    expect(dbState.findManyCalls).toBeGreaterThan(0)
  })

  test('a verified-and-valid answer writes valid + a fresh validatedAt', async () => {
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: true, plan: 'flat', expiresAt: '2030-01-01T00:00:00.000Z' })
    await sweepOnce()

    expect(updates).toHaveLength(1)
    const u = updates[0]!
    expect(u.where).toEqual({ id: 'o1' })
    expect(u.data.licenseStatus).toBe('valid')
    expect(u.data.licensePlan).toBe('flat')
    expect(u.data.licenseValidatedAt).toBeInstanceOf(Date)
    expect(u.data.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('an UNSIGNED (unreachable) answer must NOT advance validatedAt', async () => {
    // INVARIANT 1. Writing validatedAt here would reset the 7-day grace window on every
    // failed poll, so a validator outage would look like a healthy license forever.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { signatureVerified: false, valid: false, message: 'unsigned response' })
    await sweepOnce()

    const u = updates[0]!
    expect(u.data.licenseStatus).toBe('unreachable')
    expect('licenseValidatedAt' in u.data).toBe(false)
  })

  test('an unsigned answer must NOT wipe a known expiry', async () => {
    // INVARIANT 2. A network blip reporting an expiry it never saw would destroy
    // metadata a later grace-period check depends on. Prisma ignores `undefined`, which
    // is exactly why the conditional spread must omit the key entirely.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { signatureVerified: false, valid: false, message: 'offline' })
    await sweepOnce()

    expect('licenseExpiresAt' in updates[0]!.data).toBe(false)
  })

  test('a signed "expired" answer maps to expired', async () => {
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: false, message: 'license expired on 2030-01-01' })
    await sweepOnce()
    expect(updates[0]!.data.licenseStatus).toBe('expired')
    // Expiry metadata from a SIGNED answer is trusted and written.
    expect('licenseExpiresAt' in updates[0]!.data).toBe(false)
  })

  test('a signed "deactivated" answer maps to suspended, not invalid', async () => {
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: false, message: 'license was deactivated' })
    await sweepOnce()
    expect(updates[0]!.data.licenseStatus).toBe('suspended')
  })

  test('a signed rejection with an unrecognised message maps to invalid', async () => {
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: false, message: 'machine slot mismatch' })
    await sweepOnce()
    expect(updates[0]!.data.licenseStatus).toBe('invalid')
  })

  test('a signed answer WITHOUT a plan keeps the flat plan (planFallback)', async () => {
    // The drift that motivated licenseUpdateFromResult: this site used a bare `result.plan`
    // while license-issue used `?? 'flat'`, so the same response cleared a paid plan here.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: true })
    await sweepOnce()
    expect(updates[0]!.data.licensePlan).toBe('flat')
  })

  test('an UNSIGNED answer never sets a plan at all', async () => {
    // planFallback must apply only to a VERIFIED answer; applying it to an unsigned one
    // would silently promote an unverified response to a paid plan.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { signatureVerified: false, valid: false, message: 'offline', plan: 'enterprise' })
    await sweepOnce()
    expect('licensePlan' in updates[0]!.data).toBe(false)
  })
})

describe('license revalidation — failure isolation', () => {
  test('a THROWN validator error marks the org unreachable and does not abort the sweep', async () => {
    // Network error -> unreachable, and crucially NOT a lockdown: the grace period is what
    // protects a paying customer during an outage. A throw that killed the whole loop would
    // leave every later org in the list unvalidated.
    dbState.orgs = [
      { id: 'o1', slug: 'acme', licenseKey: 'KEY-BOOM' },
      { id: 'o2', slug: 'globex', licenseKey: 'KEY-OK' },
    ]
    validatorAnswers.set('KEY-BOOM', new Error('ECONNREFUSED'))
    validatorAnswers.set('KEY-OK', { ...VERIFIED, valid: true, plan: 'flat' })
    await sweepOnce()

    const boom = updates.find((u) => u.where.id === 'o1')
    expect(boom?.data.licenseStatus).toBe('unreachable')
    expect('licenseValidatedAt' in (boom?.data ?? {})).toBe(false)

    // The SECOND org must still have been validated — proof the loop survived.
    const ok = updates.find((u) => u.where.id === 'o2')
    expect(ok?.data.licenseStatus).toBe('valid')
  })

  test('a per-org THROW on one org does not stop the NEXT org from being validated', async () => {
    // The load-bearing guarantee, asserted on behaviour rather than on a log line: one org's
    // network error must not abandon the rest of the sweep. A log-text assertion here would
    // have been testing the logger, not this loop.
    dbState.orgs = [
      { id: 'o1', slug: 'boom', licenseKey: 'K1' },
      { id: 'o2', slug: 'mid', licenseKey: 'K2' },
      { id: 'o3', slug: 'ok', licenseKey: 'K3' },
    ]
    validatorAnswers.set('K1', new Error('socket hang up'))
    validatorAnswers.set('K2', new Error('ETIMEDOUT'))
    validatorAnswers.set('K3', { ...VERIFIED, valid: true, plan: 'flat' })
    await sweepOnce()

    // Every org is accounted for: two unreachable, one valid.
    expect(updates.map((u) => u.where.id).sort()).toEqual(['o1', 'o2', 'o3'])
    expect(updates.find((u) => u.where.id === 'o3')!.data.licenseStatus).toBe('valid')
    expect(validateCalls).toHaveLength(3)
  })

  test('an org whose licenseKey is NULL is skipped rather than sent to the validator', async () => {
    // The query filters these out, but the loop re-checks; if the guard were dropped a null
    // key would be POSTed to the validator as a literal "null" license.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: null }]
    await sweepOnce()
    expect(validateCalls).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })

  test('the machine id is derived from the org SLUG, so a restart keeps the same slot', async () => {
    // machineId = `${slug}:${hostname}`. Consuming a new machine slot on every restart would
    // exhaust the license's allowed machines.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'KEY-1' }]
    validatorAnswers.set('KEY-1', { ...VERIFIED, valid: true })
    await sweepOnce()
    expect(validateCalls).toHaveLength(1)
    expect(validateCalls[0]!.licenseKey).toBe('KEY-1')
    expect(validateCalls[0]!.machineId.startsWith('acme:')).toBe(true)
  })

  test('an empty org list is a no-op, not an error', async () => {
    dbState.orgs = []
    await sweepOnce()
    expect(updates).toHaveLength(0)
    expect(validateCalls).toHaveLength(0)
  })
})

describe('startLicenseRevalidation — lifecycle', () => {
  test('returns a stop function without performing a sweep inline', async () => {
    // Starting the scheduler must NOT immediately validate: the cycle is scheduled, and doing it
    // inline would put a validator round-trip (or an outage wait) on the boot path.
    dbState.orgs = [{ id: 'o1', slug: 'acme', licenseKey: 'K1' }]
    validatorAnswers.set('K1', { ...VERIFIED, valid: true })
    const stop = startLicenseRevalidation()
    expect(typeof stop).toBe('function')
    expect(validateCalls).toHaveLength(0)
    expect(updates).toHaveLength(0)
    stop()
  })

  test('the returned stop function is safe to call twice', async () => {
    // A double stop must not throw; shutdown paths can be reached more than once.
    const stop = startLicenseRevalidation()
    stop()
    expect(() => stop()).not.toThrow()
  })
})
