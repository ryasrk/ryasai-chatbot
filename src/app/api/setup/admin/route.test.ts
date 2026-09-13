/**
 * POST /api/setup/admin — first-run admin creation. PUBLIC, and it can WRITE an existing user's password.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog. This is the highest-leverage unauthenticated route in the
 * app: it is the one call that can mint an admin on a fresh install, and there is no session to check
 * because no session can exist yet.
 *
 * The property that carries the most weight is the 409. This route UPSERTS on email
 * (`db.user.upsert({ where: { email } })`), so without the `setupCompleted` guard a completed install
 * would let anyone who knows an admin's email REPLACE THAT ADMIN'S PASSWORD and receive a session. The
 * guard is therefore not a nicety -- it is the only thing standing between "installer" and "remote
 * password reset". It is pinned here in both directions: blocked when setup is done, and still allowed
 * when setup is NOT done (otherwise a half-finished install could never be completed).
 *
 * Also pinned: the whole handler runs with the tenant extension bypassed (no org exists yet), the admin
 * password is stored hashed, and the first organization is created explicitly.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

let setupState: { setupCompleted: boolean; hasAdmin: boolean } = {
  setupCompleted: false,
  hasAdmin: false,
}
let existingOrg: { id: string } | null = null
let existingConfig: { id: string } | null = null
let upsertResult: Record<string, unknown> | null = null
let throwOn: 'orgCreate' | 'configCreate' | 'upsert' | null = null

const bypassCalls: string[] = []
const orgCreateArgs: Array<Record<string, unknown>> = []
const configCreateArgs: Array<Record<string, unknown>> = []
const upsertArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const hashed: string[] = []

function fail(kind: NonNullable<typeof throwOn>) {
  if (throwOn === kind) throw Object.assign(new Error('db down'), { code: 'P1001' })
}

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async (fn: () => Promise<unknown>) => {
    bypassCalls.push('bypass')
    return fn()
  },
}))

mock.module('@/lib/setup', () => ({
  getSetupState: async () => setupState,
  normalizeSetupAdminInput: (body: unknown) => {
    if (!body || typeof body !== 'object') return null
    const b = body as Record<string, unknown>
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
    const password = typeof b.password === 'string' ? b.password : ''
    if (!name || !email || password.length < 8) return null
    return { name, email, password }
  },
}))

mock.module('@/lib/passwords', () => ({
  hashPassword: (plain: string) => {
    hashed.push(plain)
    return `scrypt$${plain}`
  },
}))

mock.module('@/lib/crypto', () => ({
  signSession: (userId: string) => `signed.${userId}`,
}))

mock.module('@/lib/session', () => ({
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/db', () => ({
  db: {
    organization: {
      findFirst: async () => existingOrg,
      create: async (args: Record<string, unknown>) => {
        orgCreateArgs.push(args)
        fail('orgCreate')
        return { id: 'org-new', name: 'Default Organization', slug: 'default' }
      },
    },
    appConfig: {
      findFirst: async () => existingConfig,
      create: async (args: Record<string, unknown>) => {
        configCreateArgs.push(args)
        fail('configCreate')
        return { id: 'cfg-1' }
      },
    },
    user: {
      upsert: async (args: Record<string, unknown>) => {
        upsertArgs.push(args)
        fail('upsert')
        return upsertResult
      },
    },
  },
}))

import { POST } from './route'

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/setup/admin', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

beforeEach(() => {
  setupState = { setupCompleted: false, hasAdmin: false }
  existingOrg = { id: 'org-1' }
  existingConfig = { id: 'cfg-1' }
  upsertResult = { id: 'user-1', email: 'admin@example.com' }
  throwOn = null
  bypassCalls.length = 0
  orgCreateArgs.length = 0
  configCreateArgs.length = 0
  upsertArgs.length = 0
  auditWrites.length = 0
  hashed.length = 0
})

describe('POST /api/setup/admin — the setupCompleted guard is the security boundary', () => {
  test('a COMPLETED install returns 409 and writes NOTHING', async () => {
    // The load-bearing test. This route upserts on email, so on a completed install an unauthenticated
    // caller who knows an admin's address could replace that admin's password and get a session.
    setupState = { setupCompleted: true, hasAdmin: true }
    const res = await call({ name: 'Mallory', email: 'admin@example.com', password: 'newpass123' })
    expect(res.status).toBe(409)
    expect(upsertArgs).toHaveLength(0)
    expect(hashed).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('an INCOMPLETE install is still allowed through', async () => {
    // The other direction: if the guard were inverted or over-eager, no install could ever be finished.
    setupState = { setupCompleted: false, hasAdmin: false }
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(201)
    expect(upsertArgs).toHaveLength(1)
  })

  test('the setup state is read with the tenant extension bypassed', async () => {
    // `bypassOrg(() => getSetupState(db))` -- the check itself queries the user table, and there is no org
    // context yet. An org-scoped read here would filter on undefined and report "setup not done"
    // FOREVER, turning the guard above into a permanent open door.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(bypassCalls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('POST /api/setup/admin — the happy path', () => {
  test('creates the admin, stores a HASH, audits, and auto-logs-in with a cookie', async () => {
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(201)

    const create = upsertArgs[0]!.create as { passwordHash: string; isActive: boolean }
    expect(create.passwordHash).toBe('scrypt$hunter2long')
    expect(create.passwordHash).not.toBe('hunter2long')
    expect(create.isActive).toBe(true)
    // TWO calls, not one -- see the KNOWN WASTE test below for why.
    expect(hashed).toEqual(['hunter2long', 'hunter2long'])

    expect(auditWrites[0]).toMatchObject({
      userId: 'user-1',
      action: 'SETUP_ADMIN_CREATED',
      detail: { email: 'admin@example.com' },
    })

    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('x-active-user=signed.user-1')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
  })

  test('KNOWN WASTE: hashPassword runs TWICE per call (once per upsert branch)', async () => {
    // PINNED, NOT FIXED. `hashPassword(input.password)` is written inline in BOTH the `create` and the
    // `update` branch of the upsert, so only ONE of the two hashes is ever stored and the other is
    // discarded. Measured on this machine: scrypt at N=16384, r=8, p=1 costs ~53 ms, so every first-run
    // setup burns ~107 ms instead of ~53 ms -- about 53 ms wasted plus a second full scrypt working-set
    // allocation, on a route that runs once per install.
    //
    // Recorded so a fix (hoist the hash above the upsert and use it in both branches -- safe, the same
    // password feeds both) is a VISIBLE deliberate change rather than an accidental one. It is NOT a
    // correctness bug: the stored hash on either path is correct.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(hashed).toHaveLength(2)
  })

  test('the UPDATE branch of the upsert also re-hashes the password', async () => {
    // The upsert path is what makes a re-run dangerous; both branches must hash.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    const update = upsertArgs[0]!.update as { passwordHash: string }
    expect(update.passwordHash).toBe('scrypt$hunter2long')
    expect(update.passwordHash).not.toBe('hunter2long')
  })

  test('the created admin is ACTIVE -- a created-but-inactive admin cannot log in', async () => {
    // Found by negative control K6: setting `isActive: false` left every other test green, because they
    // assert on the HASH and the cookie rather than on the flag. An inactive admin is exactly the silent
    // first-run failure this route must not have: setup reports success, issues a session, and the account
    // is disabled at the next request.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect((upsertArgs[0]!.create as { isActive: boolean }).isActive).toBe(true)
    // BOTH branches: the upsert's `update` path is the one a re-run takes, and it must not deactivate an
    // existing admin either.
    expect((upsertArgs[0]!.update as { isActive: boolean }).isActive).toBe(true)
  })

  test('the email is normalised for BOTH the lookup and the write', async () => {
    await call({ name: '  Ada  ', email: '  Ada@Example.COM  ', password: 'hunter2long' })
    expect(upsertArgs[0]!.where).toEqual({ email: 'ada@example.com' })
    expect((upsertArgs[0]!.create as { name: string }).name).toBe('Ada')
  })

  test('the first Organization is created only when none exists', async () => {
    existingOrg = null
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(orgCreateArgs).toHaveLength(1)
    expect(orgCreateArgs[0]!.data).toMatchObject({ slug: 'default' })
    expect((upsertArgs[0]!.create as { organizationId: string }).organizationId).toBe('org-new')
  })

  test('no second Organization is created when one already exists', async () => {
    existingOrg = { id: 'org-1' }
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(orgCreateArgs).toHaveLength(0)
    expect((upsertArgs[0]!.create as { organizationId: string }).organizationId).toBe('org-1')
  })

  test('AppConfig is created only when missing', async () => {
    existingConfig = { id: 'cfg-1' }
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(configCreateArgs).toHaveLength(0)

    existingConfig = null
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(configCreateArgs).toHaveLength(1)
    expect(configCreateArgs[0]!.data).toMatchObject({ organizationId: 'org-1' })
  })
})

describe('POST /api/setup/admin — refusals', () => {
  test('a short password is 400 and nothing is written', async () => {
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'short12' })
    expect(res.status).toBe(400)
    expect(upsertArgs).toHaveLength(0)
  })

  test('a missing field is 400', async () => {
    expect((await call({ email: 'a@b.com', password: 'hunter2long' })).status).toBe(400)
    expect((await call({ name: 'Ada', password: 'hunter2long' })).status).toBe(400)
    expect((await call({ name: 'Ada', email: 'a@b.com' })).status).toBe(400)
  })

  test('a malformed body is 400, never a 500', async () => {
    expect((await call('not json')).status).toBe(400)
    expect((await call([1, 2])).status).toBe(400)
  })

  test('a database failure surfaces as 500 and sets no cookie', async () => {
    throwOn = 'upsert'
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(500)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(auditWrites).toHaveLength(0)
  })

  test('a failure while creating the organization does not proceed to the user write', async () => {
    existingOrg = null
    throwOn = 'orgCreate'
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(500)
    expect(upsertArgs).toHaveLength(0)
  })
})
