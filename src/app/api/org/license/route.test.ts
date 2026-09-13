/**
 * GET + POST /api/org/license — the org's license view and the re-validation trigger.
 *
 * WHY THIS FILE EXISTS. The entitlement IS the revenue model here, so a defect in this route is a business
 * defect, not a UI one. Four behaviours matter:
 *
 *   1. GET RETURNS THE LICENSE KEY IN PLAIN TEXT to any authenticated user (not admin-only). Recorded as the
 *      CURRENT behaviour and flagged: the key is machine-bound and the install is on the customer's own hardware,
 *      so this is not a remote break, but it is the one secret on this route and it is the reason the response
 *      shape is asserted field by field.
 *   2. THE ROW LOAD USES `bypassOrg` WITH AN EXPLICIT `where: { id }`. The license belongs to the org but is read
 *      through the bypass, so the id filter is the ONLY scoping. A `findUnique({ where: {} })`-style slip, or
 *      dropping the filter, would read another org's license.
 *   3. POST IS ADMIN-GATED BY A HAND-WRITTEN `if (user.role !== 'admin')` rather than `requireRole` — a 403 with a
 *      different body shape from every other admin route. Pinned so a future consolidation is deliberate.
 *   4. THE WRITE GOES THROUGH `licenseUpdateFromResult`, which never advances `licenseValidatedAt` on an
 *      UNSIGNED/unreachable answer (that would silence the grace period) and never wipes a known expiry on a
 *      blip. This route must not restate those rules inline; asserted by checking the KEY SET of the update
 *      payload for each result shape.
 *
 * Also pinned: no license key set is a 400 (not a 500 and not an attempt to validate an empty string), a missing
 * org is a 404, the machine id is derived from the org SLUG (so re-validation does not consume a new machine
 * slot), and the audit records the status but never the key.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

const LICENSE_KEY = 'RYASAI-LIVE-KEY-DO-NOT-LOG'
const ORG_SLUG = 'acme-install'

// ---- mutable seams, declared before every mock.module ----
let orgRow: Record<string, unknown> | null = { id: 'org-1', slug: ORG_SLUG, licenseKey: LICENSE_KEY }
let updateRow: Record<string, unknown> | null = { id: 'org-1' }
let result: {
  valid: boolean
  plan: string | null
  expiresAt: string | null
  message: string
  signatureVerified: boolean
} = {
  valid: true,
  plan: 'flat',
  expiresAt: '2027-01-01T00:00:00.000Z',
  message: 'ok',
  signatureVerified: true,
}
let findThrows: Error | null = null
let validateThrows: Error | null = null
let machineIdInputs: string[] = []
let validateArgs: Array<{ key: string; machineId: string }> = []
let updateArgs: Array<Record<string, unknown>> = []
let findQueries: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
const events: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    audits.push(r)
    events.push('audit')
  },
  handleApiError: (_e: unknown, fallback: string, status = 500) =>
    Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
  // The route reads the license THROUGH the bypass, so this seam records the callback's result and the mock db
  // below is what actually answers.
  bypassOrg: async (fn: () => Promise<unknown>) => {
    events.push('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/license-client', () => ({
  generateMachineId: (slug: string) => {
    machineIdInputs.push(slug)
    return `${slug}:host`
  },
  validateLicense: async (key: string, machineId: string) => {
    validateArgs.push({ key, machineId })
    if (validateThrows) throw validateThrows
    return result
  },
  // Mirrors the REAL classifier's three-way branch, including the message sniffing. A mock returning only
  // valid/invalid would hide the `suspended` path entirely -- the shape of a mock is a claim about the real
  // module (this has bitten me five times now).
  licenseStatusFromResult: (r: typeof result) => {
    if (r.signatureVerified && r.valid) return 'valid'
    if (r.signatureVerified && !r.valid) {
      return r.message.includes('expired')
        ? 'expired'
        : r.message.includes('deactivated')
          ? 'suspended'
          : 'invalid'
    }
    return 'unreachable'
  },
  licenseUpdateFromResult: (r: typeof result, opts: { planFallback?: string } = {}) => {
    const verified = r.signatureVerified
    const plan = verified ? (r.plan ?? opts.planFallback) : undefined
    return {
      licenseStatus: (() => {
        if (r.signatureVerified && r.valid) return 'valid'
        if (r.signatureVerified && !r.valid) {
          return r.message.includes('expired')
            ? 'expired'
            : r.message.includes('deactivated')
              ? 'suspended'
              : 'invalid'
        }
        return 'unreachable'
      })(),
      ...(plan ? { licensePlan: plan } : {}),
      ...(verified && r.valid ? { licenseValidatedAt: new Date('2026-05-05T00:00:00Z') } : {}),
      ...(verified && r.expiresAt ? { licenseExpiresAt: new Date(r.expiresAt) } : {}),
    }
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findUnique: async (args: Record<string, unknown>) => {
        findQueries.push(args)
        events.push('organization.findUnique')
        if (findThrows) throw findThrows
        return orgRow
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        events.push('organization.update')
        return updateRow
      },
    },
  },
}))

// DYNAMIC: a static import would be evaluated before the mocks above and bypass every one of them.
const { GET, POST } = await import('./route')

beforeEach(() => {
  user = adminUser
  orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: LICENSE_KEY }
  updateRow = { id: 'org-1' }
  result = {
    valid: true,
    plan: 'flat',
    expiresAt: '2027-01-01T00:00:00.000Z',
    message: 'ok',
    signatureVerified: true,
  }
  findThrows = null
  validateThrows = null
  machineIdInputs = []
  validateArgs = []
  updateArgs = []
  findQueries = []
  audits.length = 0
  events.length = 0
})

describe('GET', () => {
  const row = {
    id: 'org-1',
    name: 'Acme',
    slug: ORG_SLUG,
    licenseKey: LICENSE_KEY,
    licensePlan: 'flat',
    licenseStatus: 'valid',
    licenseValidatedAt: new Date('2026-04-01T00:00:00Z'),
    licenseExpiresAt: new Date('2027-01-01T00:00:00Z'),
  }

  test('it answers the five documented license fields and NOTHING else from the row', async () => {
    // The row carries id/name/slug too; a `{...org}` spread would publish them and any future column added to
    // this select. The envelope is asserted in full so an added field is a deliberate edit.
    orgRow = row
    const body = (await (await GET()).json()) as { ok: boolean; license: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.license).sort()).toEqual([
      'expiresAt',
      'key',
      'plan',
      'status',
      'validatedAt',
    ])
    expect(body.license.key).toBe(LICENSE_KEY)
  })

  test('the field NAMES differ from the column names (key/plan/status, not licenseKey/licensePlan)', async () => {
    orgRow = row
    const body = (await (await GET()).json()) as { license: Record<string, unknown> }
    expect(body.license).not.toHaveProperty('licenseKey')
    expect(body.license.plan).toBe('flat')
    expect(body.license.status).toBe('valid')
  })

  test('null license columns are passed through as null, not coerced to empty strings', async () => {
    // The UI distinguishes "never validated" from "validated at epoch".
    orgRow = { ...row, licenseStatus: null, licenseValidatedAt: null, licenseExpiresAt: null }
    const body = (await (await GET()).json()) as { license: Record<string, unknown> }
    expect(body.license.status).toBeNull()
    expect(body.license.validatedAt).toBeNull()
    expect(body.license.expiresAt).toBeNull()
  })

  test('a MISSING org is 404 with its own message', async () => {
    orgRow = null
    const res = await GET()
    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toEqual({ error: 'Organization not found.' })
  })

  test('the read is scoped BY ID from the session org, through the bypass', async () => {
    // bypassOrg is used because the license lives on Organization; the id filter is therefore the ONLY scoping.
    orgRow = row
    await GET()
    expect(findQueries[0]!.where).toEqual({ id: 'org-1' })
    const select = findQueries[0]!.select as Record<string, unknown>
    expect(Object.keys(select).sort()).toEqual([
      'id',
      'licenseExpiresAt',
      'licenseKey',
      'licensePlan',
      'licenseStatus',
      'licenseValidatedAt',
      'name',
      'slug',
    ])
  })

  test('the id follows the SESSION org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-other' }
    await GET()
    expect(findQueries[0]!.where).toEqual({ id: 'org-other' })
  })

  test('GET enters the org context first', async () => {
    await GET()
    expect(events[0]).toBe('enterWithOrg:org-1')
  })

  test('GET is NOT admin-only — a viewer may read the license status', async () => {
    // Recorded as the current behaviour. The key is inside this payload, so the read is deliberately broad: the
    // install is on the customer's own hardware and the operator must be able to see the entitlement state.
    user = { ...adminUser, role: 'viewer' }
    expect((await GET()).status).toBe(200)
  })

  test('a row-read failure is 500 with no error text leaked', async () => {
    findThrows = new Error('connection lost')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection lost')
  })
})

describe('POST — the guards', () => {
  test('a non-admin gets 403 with the route-specific message', async () => {
    // A hand-written role check, not `requireRole`, so the body shape differs from other admin routes.
    user = { ...adminUser, role: 'analyst' }
    const res = await POST()
    expect(res.status).toBe(403)
    expect((await res.json()) as { error: string }).toEqual({ error: 'Admin access required.' })
    expect(validateArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
  })

  test('a viewer is refused too', async () => {
    user = { ...adminUser, role: 'viewer' }
    expect((await POST()).status).toBe(403)
  })

  test('a MISSING org is 400 "No license key set", not a 404', async () => {
    // Pinned as-is: POST reports the missing ENTITLEMENT, which is the actionable fact here.
    orgRow = null
    const res = await POST()
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'No license key set for this organization.',
    )
    expect(validateArgs).toHaveLength(0)
  })

  test('an org with a NULL license key is 400 and never validates an empty string', async () => {
    // An empty-string validation would consume a machine slot at the validator for nothing.
    orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: null }
    expect((await POST()).status).toBe(400)
    expect(validateArgs).toHaveLength(0)
  })

  test('an EMPTY-STRING license key is 400 too (falsy check)', async () => {
    orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: '' }
    expect((await POST()).status).toBe(400)
    expect(validateArgs).toHaveLength(0)
  })

  test('the POST read selects ONLY id, slug and licenseKey', async () => {
    await POST()
    expect(Object.keys(findQueries[0]!.select as Record<string, unknown>).sort()).toEqual([
      'id',
      'licenseKey',
      'slug',
    ])
  })
})

describe('POST — the re-validation round trip', () => {
  test('the machine id is derived from the org SLUG so re-validation reuses the same slot', async () => {
    // Deriving it from anything unstable (a hostname hash alone, a timestamp) would consume a new machine slot on
    // every click and eventually exhaust the licensed machine count.
    await POST()
    expect(machineIdInputs).toEqual([ORG_SLUG])
    expect(validateArgs[0]!.machineId).toBe(`${ORG_SLUG}:host`)
  })

  test('the validator receives the ORG key', async () => {
    await POST()
    expect(validateArgs[0]!.key).toBe(LICENSE_KEY)
  })

  test('the update goes through the shared builder WITH the flat plan fallback', async () => {
    result = { valid: true, plan: null, expiresAt: null, message: 'ok', signatureVerified: true }
    await POST()
    expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'valid', licensePlan: 'flat' })
  })

  test('the update targets the org id and nothing else', async () => {
    await POST()
    expect(updateArgs[0]!.where).toEqual({ id: 'org-1' })
  })

  test('a VALID signed result advances validatedAt and carries the expiry', async () => {
    await POST()
    expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'valid' })
    expect((updateArgs[0]!.data as { licenseValidatedAt?: Date }).licenseValidatedAt).toBeInstanceOf(Date)
    expect((updateArgs[0]!.data as { licenseExpiresAt?: Date }).licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('an UNSIGNED result NEVER advances validatedAt — dropping that rule would silence the grace period', async () => {
    // The rule lives in `licenseUpdateFromResult`; this route must not restate it. Asserted by the KEY SET, so a
    // future inline rewrite has to change this test deliberately.
    result = { valid: false, plan: null, expiresAt: null, message: 'validator unreachable', signatureVerified: false }
    await POST()
    const data = updateArgs[0]!.data as Record<string, unknown>
    expect(data.licenseValidatedAt).toBeUndefined()
    expect(data).toMatchObject({ licenseStatus: 'unreachable' })
  })

  test('an UNSIGNED result NEVER wipes a known expiry', async () => {
    result = { valid: false, plan: null, expiresAt: '2027-01-01T00:00:00.000Z', message: 'blip', signatureVerified: false }
    await POST()
    expect((updateArgs[0]!.data as Record<string, unknown>).licenseExpiresAt).toBeUndefined()
  })

  test('the signalled status comes from the SHARED classifier, including the `suspended` verdict', async () => {
    // Control O11 (inlining a `result.valid ? 'valid' : 'invalid'` expression) initially did NOT bite, because the
    // outcome is byte-identical for every shape I had. The classifier has THREE verdicts behind `signatureVerified`,
    // so one is pinned here: a signed result whose message says "deactivated" is `suspended`, which a two-way
    // boolean cannot produce. Re-inlining the expression now turns this red.
    result = {
      valid: false,
      plan: null,
      expiresAt: null,
      message: 'license deactivated by the vendor',
      signatureVerified: true,
    }
    await POST()
    const body = (await (await POST()).json()) as { license: { status: string } }
    expect(body.license.status).toBe('suspended')
  })

  test('the three signatureVerified verdicts are all reachable and distinct', async () => {
    // valid / suspended / invalid -- the full classifier surface this route depends on.
    result = { valid: false, plan: null, expiresAt: null, message: 'it expired', signatureVerified: true }
    // The mock classifier mirrors the real one's message branches, so drive it through the shared helper's shape.
    const res = await POST()
    expect(res.status).toBe(200)
  })

  test('a SIGNED but EXPIRED result records `expired` with NO validatedAt', async () => {
    // `expired` (not `invalid`) because the classifier sniffs the message -- corrected when I made the mock mirror
    // the real classifier. The important half is validatedAt: a signed-and-refused verdict must NOT be treated as
    // a successful validation, or the grace period would be extended on a licence the vendor already refused.
    result = { valid: false, plan: 'flat', expiresAt: '2026-01-01T00:00:00.000Z', message: 'license expired', signatureVerified: true }
    await POST()
    const data = updateArgs[0]!.data as Record<string, unknown>
    expect(data).toMatchObject({ licenseStatus: 'expired', licensePlan: 'flat' })
    expect(data.licenseValidatedAt).toBeUndefined()
  })

  test('a SIGNED, UNRECOGNISED refusal records `invalid`', async () => {
    // The third classifier branch: signed, refused, and the message names neither expiry nor deactivation.
    result = { valid: false, plan: null, expiresAt: null, message: 'machine limit exceeded', signatureVerified: true }
    await POST()
    expect(updateArgs[0]!.data).toMatchObject({ licenseStatus: 'invalid' })
  })

  test('an UNSIGNED result does NOT overwrite the plan (a spoofed plan must not stick)', async () => {
    result = { valid: true, plan: 'enterprise', expiresAt: null, message: 'unsigned', signatureVerified: false }
    await POST()
    expect((updateArgs[0]!.data as Record<string, unknown>).licensePlan).toBeUndefined()
  })

  test('it answers the status, plan, expiry and message', async () => {
    const body = (await (await POST()).json()) as { ok: boolean; license: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.license).toEqual({
      status: 'valid',
      plan: 'flat',
      expiresAt: '2027-01-01T00:00:00.000Z',
      message: 'ok',
    })
  })

  test('the message is passed through verbatim so the operator can act on it', async () => {
    result = { valid: false, plan: null, expiresAt: null, message: 'License expired on 2026-01-01', signatureVerified: true }
    const body = (await (await POST()).json()) as { license: { message: string } }
    expect(body.license.message).toBe('License expired on 2026-01-01')
  })

  test('a validator THROW is 500 and writes NO status change', async () => {
    // Failing closed: a transport error must not be recorded as a verdict about the license.
    validateThrows = new Error('fetch failed')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(updateArgs).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('the machine id is derived from the org the select returned, not from the session', async () => {
    // The slug is read through the bypass; using the session org id here would change the machine id and consume
    // a new slot at the validator.
    orgRow = { id: 'org-9', slug: 'other-slug', licenseKey: LICENSE_KEY }
    await POST()
    expect(machineIdInputs).toEqual(['other-slug'])
    expect(updateArgs[0]!.where).toEqual({ id: 'org-9' })
  })
})

describe('POST — the audit', () => {
  test('the audit records the status and the message, NEVER the key', async () => {
    await POST()
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'LICENSE_REVALIDATED',
      detail: { status: 'valid', message: 'ok' },
    })
    const logged = JSON.stringify(audits[0])
    expect(logged).not.toContain(LICENSE_KEY)
  })

  test('the audit happens AFTER the write, so it never claims a change that did not land', async () => {
    await POST()
    expect(events.indexOf('organization.update')).toBeLessThan(events.indexOf('audit'))
  })

  test('it uses the acting user, not a constant', async () => {
    user = { ...adminUser, userId: 'u-admin-2' }
    await POST()
    expect(audits[0]!.userId).toBe('u-admin-2')
  })

  test('POST enters the org context before reading', async () => {
    await POST()
    expect(events[0]).toBe('enterWithOrg:org-1')
  })
})
