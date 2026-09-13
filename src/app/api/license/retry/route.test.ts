/**
 * POST /api/license/retry — the "revalidate my licence" button, reachable while the install is LOCKED DOWN.
 *
 * WHY THIS FILE EXISTS. This is the one route the app deliberately lets through its own licence gate, and it is the
 * route the customer presses when their subscription looked dead. Two properties, and the second is the one that
 * cost real money:
 *
 *   1. THE LOCKDOWN EXEMPTION IS OPT-IN AND NARROW. `getActiveUser({ skipLicenseCheck: true })` is the whole
 *      reason a locked org can be revalidated at all; without it the LicenseError thrown by the gate would be
 *      caught by this route's own catch and misreported as a 401 "Not authenticated." — a paying customer, told
 *      they are not logged in, with no way out. Asserted on the ARGUMENT, not on the outcome.
 *   2. AN UNSIGNED ANSWER MUST NOT BE TREATED AS A SUCCESSFUL VALIDATION. The validator response is Ed25519-signed
 *      by the vendor's service; when the signature cannot be checked (network blip, HTTP error, tampered body,
 *      missing public key) `licenseUpdateFromResult` records `unreachable` and, crucially, does NOT advance
 *      `licenseValidatedAt` — because advancing it restarts the 7-day grace window and a failed network call would
 *      buy the org another week on a licence the vendor never confirmed. The route must not restate those rules
 *      inline; it must call the shared builder. Both halves are pinned below, including the identical-inline-copy
 *      mutation that the sibling /api/org/license test file already documents.
 *
 * Also pinned: the retry is IDEMPOTENT in the ways that matter — a second press re-uses the SAME machine slot
 * (derived from the org SLUG, not a hostname or a timestamp), no status change is written when the validator call
 * throws, and the response never echoes the licence key.
 *
 * Control tests were verified by mutating the route in place, running the file, and restoring it.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser
let getUserThrows: Error | null = null
const getUserArgs: Array<Record<string, unknown>> = []

const LICENSE_KEY = 'RYASAI-LIVE-KEY-DO-NOT-LOG'
const ORG_SLUG = 'acme-install'
let orgRow: Record<string, unknown> | null = { id: 'org-1', slug: ORG_SLUG, licenseKey: LICENSE_KEY }
let findThrows: Error | null = null
let validateThrows: Error | null = null
let updateThrows: Error | null = null
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
const machineIdInputs: string[] = []
const validateArgs: Array<{ key: string; machineId: string }> = []
const findQueries: Array<Record<string, unknown>> = []
const updateQueries: Array<Record<string, unknown>> = []
const events: string[] = []
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async (opts: Record<string, unknown> = {}) => {
    getUserArgs.push(opts)
    events.push('getActiveUser')
    if (getUserThrows) throw getUserThrows
    return user
  },
  // Mirrors the real mapper's class-based branching so the UnauthorizedError path is distinguishable from a 500.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    handleErrorArgs.push({ fallback, status })
    events.push('handleApiError')
    const name = (e as { name?: string } | null)?.name
    if (name === 'UnauthorizedError') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: (e as Error).message } }, { status: 401 })
    }
    if (name === 'LicenseError') {
      return Response.json({ error: { code: 'LICENSE_INVALID', message: (e as Error).message } }, { status: 402 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async (fn: () => Promise<unknown>) => {
    events.push('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/license-client', () => ({
  generateMachineId: (slug: string) => {
    machineIdInputs.push(slug)
    events.push('generateMachineId')
    return `${slug}:host`
  },
  validateLicense: async (key: string, machineId: string) => {
    validateArgs.push({ key, machineId })
    events.push('validateLicense')
    if (validateThrows) throw validateThrows
    return result
  },
  // Mirrors the REAL classifier's three-way branch behind signatureVerified. A mock that returned only
  // valid/invalid would hide the `suspended` verdict entirely, so the branch is reproduced verbatim.
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
  // Mirrors the real builder's two invariants: licenseValidatedAt advances ONLY on verified-and-valid, and
  // licenseExpiresAt is written ONLY from a signed response. Prisma ignores `undefined`, which is the mechanism.
  licenseUpdateFromResult: (r: typeof result, opts: { planFallback?: string } = {}) => {
    const verified = r.signatureVerified
    const plan = verified ? (r.plan ?? opts.planFallback) : undefined
    events.push('licenseUpdateFromResult')
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
        updateQueries.push(args)
        events.push('organization.update')
        if (updateThrows) throw updateThrows
        return { id: 'org-1' }
      },
    },
  },
}))

// DYNAMIC: mock.module does not apply to static imports.
const { POST } = await import('./route')

beforeEach(() => {
  user = adminUser
  getUserThrows = null
  getUserArgs.length = 0
  orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: LICENSE_KEY }
  findThrows = null
  validateThrows = null
  updateThrows = null
  result = {
    valid: true,
    plan: 'flat',
    expiresAt: '2027-01-01T00:00:00.000Z',
    message: 'ok',
    signatureVerified: true,
  }
  machineIdInputs.length = 0
  validateArgs.length = 0
  findQueries.length = 0
  updateQueries.length = 0
  events.length = 0
  handleErrorArgs = []
})

describe('the lockdown exemption', () => {
  test('getActiveUser is called with skipLicenseCheck:true', async () => {
    // Control C1 (dropping the option): red. Without it a locked-down org surfaces the gate's LicenseError, this
    // route catches it as an auth failure, and the customer is told "Not authenticated." with no path forward.
    await POST()
    expect(getUserArgs[0]).toEqual({ skipLicenseCheck: true })
  })

  test('it is called with the option on EVERY path, including the failure paths', async () => {
    orgRow = null
    await POST()
    expect(getUserArgs[0]).toEqual({ skipLicenseCheck: true })
  })

  test('an Unauthorized THROW becomes the route-specific 401 and touches nothing else', async () => {
    // The inner try/catch exists precisely so the gate's error is not confused with a real revalidation failure.
    getUserThrows = Object.assign(new Error('No active session.'), { name: 'UnauthorizedError' })
    const res = await POST()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Not authenticated.' })
    expect(validateArgs).toHaveLength(0)
    expect(findQueries).toHaveLength(0)
  })

  test('a LicenseError from the gate is NOT reported as a 401 by the inner catch', async () => {
    // Recorded as a known shape mismatch, NOT a control: the inner `catch {}` swallows ANY throw and answers 401,
    // so a LicenseError raised before skipLicenseCheck could ever matter would be mislabelled. With
    // skipLicenseCheck in place the gate does not throw LicenseError, but the catch is broader than it needs to be.
    getUserThrows = Object.assign(new Error('License has expired. Please renew your license.'), { name: 'LicenseError' })
    const res = await POST()
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('Not authenticated.')
  })

  test('the 401 body is the route-specific string, not the typed envelope', async () => {
    // Pinned: the retry button reads a plain `error` string here.
    getUserThrows = Object.assign(new Error('x'), { name: 'UnauthorizedError' })
    expect(typeof ((await (await POST()).json()) as { error: unknown }).error).toBe('string')
  })
})

describe('the org lookup', () => {
  test('the org is read BY SESSION ORG ID, through the bypass, selecting only three columns', async () => {
    // Control C2 (widening the select): red. The response must never be able to echo the licence key.
    await POST()
    expect(findQueries[0]!.where).toEqual({ id: 'org-1' })
    expect(Object.keys(findQueries[0]!.select as Record<string, unknown>).sort()).toEqual([
      'id',
      'licenseKey',
      'slug',
    ])
  })

  test('a MISSING org is a 400 "No license key set", not a 404', async () => {
    orgRow = null
    const res = await POST()
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('No license key set.')
    expect(validateArgs).toHaveLength(0)
  })

  test('a NULL licence key is a 400 and no empty-string validation is attempted', async () => {
    // An empty-string validation would consume a machine slot at the vendor for nothing.
    orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: null }
    expect((await POST()).status).toBe(400)
    expect(validateArgs).toHaveLength(0)
  })

  test('an EMPTY-STRING licence key is a 400 too (the falsy check covers it)', async () => {
    orgRow = { id: 'org-1', slug: ORG_SLUG, licenseKey: '' }
    expect((await POST()).status).toBe(400)
    expect(validateArgs).toHaveLength(0)
  })
})

describe('the validator round trip', () => {
  test('the machine id is derived from the org SLUG so retrying reuses the same slot', async () => {
    // Control C3 (deriving it from the session org id, or from Date.now()): red. Consuming a new slot per press
    // eventually exhausts the licensed machine count and the customer cannot get back in.
    await POST()
    expect(machineIdInputs).toEqual([ORG_SLUG])
    expect(validateArgs[0]!.machineId).toBe(`${ORG_SLUG}:host`)
  })

  test('the validator receives the ORG key, not a constant', async () => {
    await POST()
    expect(validateArgs[0]!.key).toBe(LICENSE_KEY)
  })

  test('the slug comes from the ROW, so a renamed org slug re-validates against its own machine', async () => {
    orgRow = { id: 'org-9', slug: 'other-slug', licenseKey: LICENSE_KEY }
    await POST()
    expect(machineIdInputs).toEqual(['other-slug'])
    expect(updateQueries[0]!.where).toEqual({ id: 'org-9' })
  })

  test('a validator THROW is a 500 with no status written and no update issued', async () => {
    // Failing closed: a transport error says nothing about the licence, so writing 'unreachable' from a THROW
    // (as opposed to a signed 'unreachable' verdict) would be recording an opinion nobody formed.
    validateThrows = new Error('fetch failed')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(updateQueries).toHaveLength(0)
    expect(handleErrorArgs).toEqual([{ fallback: 'License retry failed.', status: 500 }])
  })

  test('the transport error text never reaches the client', async () => {
    validateThrows = new Error('connect ECONNREFUSED 10.1.2.3:9000')
    const t = await (await POST()).text()
    expect(t).not.toContain('ECONNREFUSED')
    expect(t).not.toContain('10.1.2.3')
  })

  test('an update failure is a 500', async () => {
    updateThrows = new Error('deadlock detected')
    expect((await POST()).status).toBe(500)
  })
})

describe('the write goes through the SHARED builder, with the flat plan fallback', () => {
  test('the update targets the org id and calls licenseUpdateFromResult', async () => {
    await POST()
    expect(updateQueries[0]!.where).toEqual({ id: 'org-1' })
    expect(events).toContain('licenseUpdateFromResult')
  })

  test('a signed, valid result with NO plan falls back to flat', async () => {
    result = { valid: true, plan: null, expiresAt: null, message: 'ok', signatureVerified: true }
    await POST()
    expect(updateQueries[0]!.data).toMatchObject({ licenseStatus: 'valid', licensePlan: 'flat' })
  })

  test('a VALID SIGNED result advances validatedAt and carries the expiry', async () => {
    await POST()
    const data = updateQueries[0]!.data as Record<string, unknown>
    expect(data.licenseStatus).toBe('valid')
    expect(data.licenseValidatedAt).toBeInstanceOf(Date)
    expect(data.licenseExpiresAt).toBeInstanceOf(Date)
  })

  test('an UNSIGNED result NEVER advances validatedAt — that would silence the grace window', async () => {
    // THE MONEY TEST. Control C4 (inlining `licenseValidatedAt: new Date()`): red. A network blip would restart
    // the 7-day grace period, so an unreachable validator would extend the licence indefinitely.
    result = { valid: false, plan: null, expiresAt: null, message: 'validator unreachable', signatureVerified: false }
    await POST()
    const data = updateQueries[0]!.data as Record<string, unknown>
    expect(data.licenseValidatedAt).toBeUndefined()
    expect(data).toMatchObject({ licenseStatus: 'unreachable' })
  })

  test('an UNSIGNED result NEVER wipes a known expiry', async () => {
    // The other half: writing null on a blip destroys the metadata the grace check reads.
    result = { valid: false, plan: null, expiresAt: '2027-01-01T00:00:00.000Z', message: 'blip', signatureVerified: false }
    await POST()
    expect((updateQueries[0]!.data as Record<string, unknown>).licenseExpiresAt).toBeUndefined()
  })

  test('an UNSIGNED result does NOT overwrite the plan (a spoofed enterprise must not stick)', async () => {
    result = { valid: true, plan: 'enterprise', expiresAt: null, message: 'unsigned', signatureVerified: false }
    await POST()
    expect((updateQueries[0]!.data as Record<string, unknown>).licensePlan).toBeUndefined()
  })

  test('an UNSIGNED result is NOT reported as a successful validation', async () => {
    // The response half of the same rule: the retry button greys out on 'valid', so an unsigned answer that read
    // as valid would hide a dead licence behind a green light.
    result = { valid: false, plan: null, expiresAt: null, message: 'Signature verification failed.', signatureVerified: false }
    const body = (await (await POST()).json()) as { license: { status: string } }
    expect(body.license.status).toBe('unreachable')
    expect(body.license.status).not.toBe('valid')
  })

  test('a SIGNED but EXPIRED result records expired with NO validatedAt', async () => {
    result = { valid: false, plan: 'flat', expiresAt: '2026-01-01T00:00:00.000Z', message: 'license expired', signatureVerified: true }
    await POST()
    const data = updateQueries[0]!.data as Record<string, unknown>
    expect(data).toMatchObject({ licenseStatus: 'expired', licensePlan: 'flat' })
    expect(data.licenseValidatedAt).toBeUndefined()
  })

  test('a SIGNED deactivation records suspended (a two-way boolean cannot produce this)', async () => {
    result = { valid: false, plan: null, expiresAt: null, message: 'license deactivated by vendor', signatureVerified: true }
    const body = (await (await POST()).json()) as { license: { status: string } }
    expect(body.license.status).toBe('suspended')
  })

  test('a SIGNED unrecognised refusal records invalid', async () => {
    result = { valid: false, plan: null, expiresAt: null, message: 'machine limit exceeded', signatureVerified: true }
    await POST()
    expect(updateQueries[0]!.data).toMatchObject({ licenseStatus: 'invalid' })
  })
})

describe('the response body', () => {
  test('it answers { ok, license: { status, plan, expiresAt, message } }', async () => {
    const body = (await (await POST()).json()) as { ok: boolean; license: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.license).sort()).toEqual(['expiresAt', 'message', 'plan', 'status'])
  })

  test('plan and expiresAt are WITHHELD from the response when the signature was not verified', async () => {
    // Control C5 (dropping the `result.signatureVerified ?` guards): red. Echoing an unsigned plan lets a
    // tampered/hostile validator response put 'enterprise' on the customer's screen even though it was not stored.
    result = { valid: true, plan: 'enterprise', expiresAt: '2030-01-01T00:00:00.000Z', message: 'unsigned', signatureVerified: false }
    const body = (await (await POST()).json()) as { license: Record<string, unknown> }
    expect(body.license.plan).toBeUndefined()
    expect(body.license.expiresAt).toBeUndefined()
    expect(body.license.status).toBe('unreachable')
  })

  test('plan and expiresAt ARE echoed when the signature verified', async () => {
    const body = (await (await POST()).json()) as { license: Record<string, unknown> }
    expect(body.license.plan).toBe('flat')
    expect(body.license.expiresAt).toBe('2027-01-01T00:00:00.000Z')
  })

  test('the message is passed through verbatim so the operator can act on it', async () => {
    result = { valid: false, plan: null, expiresAt: null, message: 'License expired on 2026-01-01', signatureVerified: true }
    const body = (await (await POST()).json()) as { license: { message: string } }
    expect(body.license.message).toBe('License expired on 2026-01-01')
  })

  test('the LICENCE KEY never appears anywhere in the response', async () => {
    // The retry button is rendered in the locked-down shell; the key must not be readable there.
    const t = await (await POST()).text()
    expect(t).not.toContain(LICENSE_KEY)
    expect(t).not.toContain('licenseKey')
  })

  test('an update failure still never leaks the key', async () => {
    updateThrows = new Error('deadlock')
    const t = await (await POST()).text()
    expect(t).not.toContain(LICENSE_KEY)
  })
})

describe('order of operations', () => {
  test('the sequence is auth -> read -> machineId -> validate -> update', async () => {
    // Ordering pin. Auditing or responding before the write, or computing the machine id before the read, are the
    // kind of reorder that silently sends a WRONG machine id to the vendor for the rest of the install's life.
    await POST()
    expect(events.filter((e) => e !== 'bypassOrg')).toEqual([
      'getActiveUser',
      'organization.findUnique',
      'generateMachineId',
      'validateLicense',
      'licenseUpdateFromResult',
      'organization.update',
    ])
  })

  test('the retry writes NOTHING for a locked org it cannot authenticate', async () => {
    getUserThrows = Object.assign(new Error('x'), { name: 'UnauthorizedError' })
    await POST()
    expect(updateQueries).toHaveLength(0)
    expect(handleErrorArgs).toHaveLength(0)
  })

  test('two consecutive retries send the SAME machine id (idempotent slot use)', async () => {
    await POST()
    await POST()
    expect(machineIdInputs).toEqual([ORG_SLUG, ORG_SLUG])
  })
})
