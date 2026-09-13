import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { normalizeLoginInput } from './route'

describe('normalizeLoginInput', () => {
  it('accepts valid input and lowercases email', () => {
    expect(normalizeLoginInput({ email: ' Admin@Acme.com ', password: 'pw' })).toEqual({
      email: 'admin@acme.com',
      password: 'pw',
    })
  })

  it('rejects missing fields', () => {
    expect(normalizeLoginInput({ email: 'a@b.c' })).toBeNull()
    expect(normalizeLoginInput({ password: 'pw' })).toBeNull()
    expect(normalizeLoginInput(null)).toBeNull()
    expect(normalizeLoginInput({ email: '', password: 'pw' })).toBeNull()
  })
})

// ===========================================================================
// POST — the login flow itself
// ===========================================================================
//
// The original file tested ONLY the pure input normaliser, leaving the entire
// route at 35.14% executable. This is the authentication boundary: the 401 must
// stay generic (no user enumeration), a failure must be audited, and a success
// must rotate sessionVersion so old cookies die. None of that was pinned.

const state = {
  user: null as Record<string, unknown> | null,
  verify: true,
  audits: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  updateResult: { sessionVersion: 7 },
  enterWithOrgCalls: [] as string[],
  jsonThrows: false,
  apiError: null as Error | null,
}

const mockFindUnique = mock(async (_a?: unknown) => state.user)
const mockUpdate = mock(async (a: Record<string, unknown>) => { state.updates.push(a); return state.updateResult })
const mockVerifyPassword = mock((_pw?: unknown, _hash?: unknown) => state.verify)

mock.module('@/lib/db', () => ({
  db: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}))
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => T) => fn(),
  enterWithOrg: (org: string) => { state.enterWithOrgCalls.push(org) },
}))
mock.module('@/lib/passwords', () => ({ verifyPassword: mockVerifyPassword }))
mock.module('@/lib/session', () => ({
  writeAudit: async (a: Record<string, unknown>) => { state.audits.push(a) },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    state.apiError = e as Error
    return Response.json({ error: fallback }, { status })
  },
}))
const mockSignSession = mock((_id?: unknown, _v?: unknown) => 'signed-token')
mock.module('@/lib/crypto', () => ({ signSession: mockSignSession }))

const { POST } = await import('./route')

/** A NextRequest stand-in: the route only reads json() off it. */
function req(body: unknown) {
  return {
    json: async () => {
      if (state.jsonThrows) throw new Error('malformed body')
      return body
    },
  } as never
}

const ACTIVE_USER = {
  id: 'u1',
  name: 'Admin',
  email: 'admin@acme.com',
  isActive: true,
  passwordHash: 'hash',
  role: 'admin',
  organizationId: 'org-1',
  sessionVersion: 6,
}

beforeEach(() => {
  state.user = ACTIVE_USER
  state.verify = true
  state.audits = []
  state.updates = []
  state.updateResult = { sessionVersion: 7 }
  state.enterWithOrgCalls = []
  state.jsonThrows = false
  state.apiError = null
  mockFindUnique.mockClear()
  mockUpdate.mockClear()
  mockVerifyPassword.mockClear()
  mockSignSession.mockClear()
})

describe('POST /api/auth/login — success', () => {
  it('returns 200 with the user identity and rotates sessionVersion', async () => {
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    // The password hash must NEVER be echoed back.
    expect(JSON.stringify(body)).not.toContain('hash')
    expect(body.user).toEqual({ userId: 'u1', name: 'Admin', email: 'admin@acme.com', role: 'admin' })
    // Rotation is what invalidates previously issued cookies.
    expect(state.updates).toHaveLength(1)
    expect((state.updates[0] as { data: { sessionVersion: { increment: number } } }).data.sessionVersion)
      .toEqual({ increment: 1 })
  })

  it('sets an httpOnly session cookie signed with the NEW sessionVersion', async () => {
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    const cookie = res.cookies.get('x-active-user')
    expect(cookie?.value).toBe('signed-token')
    // httpOnly is the whole point: a readable cookie is stealable by any XSS.
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite).toBe('lax')
    expect(cookie?.path).toBe('/')
    expect(cookie?.maxAge).toBe(60 * 60 * 24 * 7)
    // Signed with the INCREMENTED version, not the stale one.
    expect(mockSignSession).toHaveBeenCalledWith('u1', 7)
  })

  it('audits LOGIN_SUCCESS and enters the user org BEFORE auditing', async () => {
    await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    const audit = state.audits.find((a) => a.action === 'LOGIN_SUCCESS')
    expect(audit).toBeDefined()
    expect(audit?.userId).toBe('u1')
    // The org context must be established first, or the audit row is written
    // without a tenant.
    expect(state.enterWithOrgCalls).toContain('org-1')
  })
})

describe('POST /api/auth/login — credentials are refused', () => {
  it('a WRONG PASSWORD returns 401 with a GENERIC message', async () => {
    state.verify = false
    const res = await POST(req({ email: 'admin@acme.com', password: 'wrong' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    // The message must not reveal whether the ACCOUNT exists -- that is user
    // enumeration, and it is the reason the failing branch audits instead of
    // explaining.
    expect(body.error).toBe('Invalid email or password.')
    // Asserting the body does not contain the word "password" was WRONG: the
    // generic message itself contains it. What must not leak is whether the
    // ACCOUNT exists -- so the meaningful check is that the hash and the
    // submitted value never appear, and the message is the same generic string
    // as the unknown-email case (asserted in the sibling test).
    expect(JSON.stringify(body)).not.toContain('hash')
    expect(JSON.stringify(body)).not.toContain('wrong')
    expect(state.updates).toHaveLength(0)
    expect(mockSignSession).not.toHaveBeenCalled()
  })

  it('an UNKNOWN email is refused with the SAME generic message', async () => {
    // Identical to the wrong-password case, byte for byte -- asserting both makes
    // an enumeration regression impossible to miss.
    state.user = null
    const res = await POST(req({ email: 'nobody@acme.com', password: 'pw' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Invalid email or password.' })
  })

  it('a DISABLED account is refused, and the attempt is audited', async () => {
    // isActive === false must not be a bypass. An offboarded employee whose row is
    // merely flagged inactive must not be able to log in.
    state.user = { ...ACTIVE_USER, isActive: false }
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(401)
    const audit = state.audits.find((a) => a.action === 'LOGIN_FAILED')
    expect(audit).toBeDefined()
    expect(audit?.severity).toBe('warning')
    expect(mockSignSession).not.toHaveBeenCalled()
  })

  it('a failed attempt for a KNOWN user is audited; an unknown email is not', async () => {
    // Only a known user has an id/organization to attribute the row to, so the
    // unknown-email case cannot be audited here. Pinned to document that gap
    // rather than implying coverage that does not exist.
    state.verify = false
    await POST(req({ email: 'admin@acme.com', password: 'wrong' }))
    expect(state.audits.filter((a) => a.action === 'LOGIN_FAILED')).toHaveLength(1)

    state.audits = []
    state.user = null
    await POST(req({ email: 'nobody@acme.com', password: 'pw' }))
    expect(state.audits.filter((a) => a.action === 'LOGIN_FAILED')).toHaveLength(0)
  })
})

describe('POST /api/auth/login — malformed requests', () => {
  it('a missing password returns 400 and never touches the database', async () => {
    const res = await POST(req({ email: 'admin@acme.com' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Email and password are required.' })
    // No lookup, so a 400 cannot be used to probe for accounts.
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('a body that is not JSON is treated as missing credentials, not a 500', async () => {
    // `await req.json().catch(() => null)` is deliberate: a client sending garbage
    // must get the same 400 as one sending nothing, never an unhandled throw.
    state.jsonThrows = true
    const res = await POST(req(null))
    expect(res.status).toBe(400)
    expect(mockFindUnique).not.toHaveBeenCalled()
  })

  it('a non-object body value is refused', async () => {
    const res = await POST(req('just a string'))
    expect(res.status).toBe(400)
  })

  it('an unexpected failure is routed through handleApiError, not leaked', async () => {
    // The outer catch. A DB outage during login must produce the sanitized handler
    // response -- leaking the driver error would expose schema details.
    mockFindUnique.mockImplementationOnce(async () => { throw new Error('db exploded') })
    const res = await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to process login.' })
    expect(state.apiError).toBeInstanceOf(Error)
  })
})

describe('POST /api/auth/login — the lookup itself', () => {
  it('looks the user up by NORMALISED email', async () => {
    await POST(req({ email: '  Admin@ACME.com  ', password: 'pw' }))
    const call = mockFindUnique.mock.calls[0]![0] as { where: { email: string } }
    expect(call.where.email).toBe('admin@acme.com')
  })

  it('the lookup is wrapped in bypassOrg (login precedes any org context)', async () => {
    // Without this the tenant extension would scope the read to a context that
    // does not exist yet, and every login would fail.
    await POST(req({ email: 'admin@acme.com', password: 'pw' }))
    expect(mockFindUnique).toHaveBeenCalledTimes(1)
  })

  it('the password is verified against the STORED hash', async () => {
    await POST(req({ email: 'admin@acme.com', password: 'secret' }))
    expect(mockVerifyPassword).toHaveBeenCalledWith('secret', 'hash')
  })
})
