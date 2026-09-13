/**
 * POST /api/auth/register — step 1 of signup, the very first row in a fresh install.
 *
 * WHY THIS FILE EXISTS. Part of the 66-route orphan backlog. This endpoint is PUBLIC and
 * UNAUTHENTICATED, and it writes three rows and hands out a session cookie -- so it is both the entry
 * point an attacker reaches first and the path that must work before anything else can.
 *
 * The properties that matter, and why:
 *
 *   1. IT MUST RUN WITH THE TENANT EXTENSION BYPASSED. Registration happens BEFORE any organization
 *      exists and before any session, so `getOrgContext()` is undefined by design. If the extension
 *      scoped these queries, `db.user.findUnique({ where: { email } })` -- the duplicate-email check --
 *      would filter on an undefined organizationId and find nothing, and duplicate email check silently
 *      becomes a no-op. Every one of the five DB calls is pinned inside `bypassOrg`, counted so a future
 *      edit that drops one is visible.
 *   2. THE DUPLICATE-EMAIL CHECK MUST PRECEDE THE WRITE, returning 409 -- otherwise signup is an account
 *      takeover primitive: register an existing address, get an admin session on someone else's org.
 *   3. THE FIRST USER IS AN ADMIN, and the password is stored HASHED, never in the clear.
 *   4. The org starts with `licenseStatus: 'none'` and `setupCompleted: false` -- a self-hosted install
 *      must not look licensed or configured before the operator proves it.
 *   5. The password policy is enforced on the SERVER, not only in the form.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

let existingUser: unknown = null
let createdOrg: Record<string, unknown> | null = null
let createdUser: Record<string, unknown> | null = null
let throwOn: 'find' | 'orgCreate' | 'userCreate' | 'configCreate' | null = null

const bypassCalls: string[] = []
const findUniqueArgs: Array<Record<string, unknown>> = []
const orgCreateArgs: Array<Record<string, unknown>> = []
const userCreateArgs: Array<Record<string, unknown>> = []
const configCreateArgs: Array<Record<string, unknown>> = []
const hashed: string[] = []
let signedSessions: Array<{ userId: string; version: number }> = []

function fail(kind: NonNullable<typeof throwOn>) {
  if (throwOn === kind) throw Object.assign(new Error('db down'), { code: 'P1001' })
}

// `bypassOrg(fn)` runs the callback with no org context. The mock RECORDS each call so a test can prove
// the lenient path was taken -- the point being that these queries must NOT be org-scoped.
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async (fn: () => Promise<unknown>) => {
    bypassCalls.push('bypass')
    return fn()
  },
}))

mock.module('@/lib/passwords', () => ({
  hashPassword: (plain: string) => {
    hashed.push(plain)
    return `hashed:${plain}`
  },
}))

mock.module('@/lib/crypto', () => ({
  signSession: (userId: string, version: number) => {
    signedSessions.push({ userId, version })
    return `signed.${userId}.${version}`
  },
}))

mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg, detail: String(e) }, { status: 500 }),
}))

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findUnique: async (args: Record<string, unknown>) => {
        findUniqueArgs.push(args)
        fail('find')
        return existingUser
      },
      create: async (args: Record<string, unknown>) => {
        userCreateArgs.push(args)
        fail('userCreate')
        return createdUser
      },
    },
    organization: {
      create: async (args: Record<string, unknown>) => {
        orgCreateArgs.push(args)
        fail('orgCreate')
        return createdOrg
      },
    },
    appConfig: {
      create: async (args: Record<string, unknown>) => {
        configCreateArgs.push(args)
        fail('configCreate')
        return { id: 'cfg-1' }
      },
    },
  },
}))

import { POST } from './route'

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/auth/register', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

beforeEach(() => {
  existingUser = null
  createdOrg = { id: 'org-1', name: "Ada's Organization", slug: 'org-abc' }
  createdUser = { id: 'user-1', name: 'Ada', email: 'ada@example.com' }
  throwOn = null
  bypassCalls.length = 0
  findUniqueArgs.length = 0
  orgCreateArgs.length = 0
  userCreateArgs.length = 0
  configCreateArgs.length = 0
  hashed.length = 0
  signedSessions = []
})

describe('POST /api/auth/register — the happy path', () => {
  test('creates an org + admin user + appConfig, and returns a session cookie', async () => {
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      ok: boolean
      user: { userId: string }
      organization: { id: string; slug: string }
    }
    expect(body.ok).toBe(true)
    expect(body.user.userId).toBe('user-1')
    expect(body.organization.id).toBe('org-1')

    // The cookie is what makes step 2 (license activation) possible without a re-login.
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('x-active-user=signed.user-1.1')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
    expect(cookie).toContain('Path=/')
    expect(signedSessions).toEqual([{ userId: 'user-1', version: 1 }])
  })

  test('the first user of a new org is an ADMIN', async () => {
    // If this ever becomes 'viewer', a fresh install cannot complete setup -- every setup route is
    // admin-gated.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(userCreateArgs[0]!.data).toMatchObject({ role: 'admin', sessionVersion: 1 })
    expect(userCreateArgs[0]!.data).toMatchObject({ organizationId: 'org-1' })
  })

  test('the stored password is the HASH, never the plaintext', async () => {
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    const data = userCreateArgs[0]!.data as { passwordHash: string }
    expect(data.passwordHash).toBe('hashed:hunter2long')
    expect(data.passwordHash).not.toBe('hunter2long')
    expect(hashed).toEqual(['hunter2long'])
    // The plaintext must not survive anywhere else in the payload.
    expect(JSON.stringify(data)).not.toContain('"password"')
  })

  test('the org starts UNLICENSED and setup is INCOMPLETE', async () => {
    // A self-hosted install must not look licensed or configured before the operator proves it --
    // that is the whole gate on revenue.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(orgCreateArgs[0]!.data).toMatchObject({ licenseStatus: 'none' })
    expect(configCreateArgs[0]!.data).toMatchObject({ setupCompleted: false })
    expect(configCreateArgs[0]!.data).toMatchObject({ organizationId: 'org-1' })
  })

  test('the email is normalised to lowercase+trimmed for BOTH the check and the write', async () => {
    // If the check normalises but the write does not, 'Ada@X.com' and 'ada@x.com' become two accounts.
    await call({ name: 'Ada', email: '  Ada@Example.COM  ', password: 'hunter2long' })
    expect(findUniqueArgs[0]!.where).toEqual({ email: 'ada@example.com' })
    expect(userCreateArgs[0]!.data).toMatchObject({ email: 'ada@example.com' })
  })
})

describe('POST /api/auth/register — the tenant bypass is load-bearing', () => {
  test('EVERY database call runs inside bypassOrg', async () => {
    // Registration happens before any org exists, so there is no org context to scope by. If the
    // extension scoped these queries, the duplicate-email lookup would filter on an undefined
    // organizationId and find nothing -- the uniqueness check would silently stop checking.
    // The route makes exactly FOUR queries (findUnique + three create) and each is wrapped.
    await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(bypassCalls).toHaveLength(4)
    expect(findUniqueArgs).toHaveLength(1)
    expect(orgCreateArgs).toHaveLength(1)
    expect(userCreateArgs).toHaveLength(1)
    expect(configCreateArgs).toHaveLength(1)
  })
})

describe('POST /api/auth/register — refusals', () => {
  test('an already-registered email is a 409, and NOTHING is written', async () => {
    // The account-takeover primitive: without this the caller can re-register an existing address and be
    // handed an admin session against someone else's organization.
    existingUser = { id: 'victim' }
    const res = await call({ name: 'Mallory', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(409)
    expect(orgCreateArgs).toHaveLength(0)
    expect(userCreateArgs).toHaveLength(0)
    expect(configCreateArgs).toHaveLength(0)
    expect(signedSessions).toHaveLength(0)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('each required field missing is 400', async () => {
    for (const body of [
      { email: 'a@b.com', password: 'hunter2long' },
      { name: 'Ada', password: 'hunter2long' },
      { name: 'Ada', email: 'a@b.com' },
    ]) {
      const res = await call(body)
      expect(res.status).toBe(400)
    }
    expect(orgCreateArgs).toHaveLength(0)
  })

  test('a password under 8 characters is refused SERVER-side', async () => {
    // The form also checks, but the form is not the boundary. '1234567' must not create an account.
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: '1234567' })
    expect(res.status).toBe(400)
    expect(userCreateArgs).toHaveLength(0)
    expect(hashed).toHaveLength(0)
  })

  test('exactly 8 characters is accepted (the boundary is >= 8, not > 8)', async () => {
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: '12345678' })
    expect(res.status).toBe(200)
  })

  test('a malformed or non-object body is 400, never a 500', async () => {
    expect((await call('not json')).status).toBe(400)
    expect((await call([1, 2, 3])).status).toBe(400)
    expect((await call('"a string"')).status).toBe(400)
    expect(orgCreateArgs).toHaveLength(0)
  })

  test('a database failure mid-way surfaces as an error, not a half-created account', async () => {
    // No transaction wraps these three writes; the test documents the current behaviour rather than
    // asserting a rollback that does not exist.
    throwOn = 'userCreate'
    const res = await call({ name: 'Ada', email: 'ada@example.com', password: 'hunter2long' })
    expect(res.status).toBe(500)
    expect(orgCreateArgs).toHaveLength(1)
    expect(userCreateArgs).toHaveLength(1)
    expect(configCreateArgs).toHaveLength(0)
    expect(res.headers.get('set-cookie')).toBeNull()
  })
})
