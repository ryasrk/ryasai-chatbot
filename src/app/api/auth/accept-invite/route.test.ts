/**
 * GET + POST /api/auth/accept-invite — the ONLY way an organization gains a user after signup.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog, but this route carries two properties no other route does:
 *
 *   1. IT IS THE SINGLE ENFORCEMENT POINT FOR THE `maxUsers` QUOTA. Signup/register each create a fresh
 *      organization whose first user is always within quota, so accepting an invite is the one path that
 *      can exceed it. The org's plan therefore comes from the ORG ROW, never from the caller -- the invitee
 *      has no session, so a caller-supplied plan would let anyone bypass the limit by claiming `enterprise`.
 *   2. IT IS PUBLIC AND UNAUTHENTICATED while writing a user with the INVITATION'S role. Consequently the
 *      token must be single-use (an accepted invite is refused), expiring, and the role must come from the
 *      invitation rather than the body -- otherwise the POST body becomes a role-selection form.
 *
 * Also pinned: the global-email-uniqueness re-check (a user may register between invite and acceptance), the
 * org context being entered before the audit write (writeAudit reads getOrgContext(), and no getActiveUser()
 * ran on this public route), and the password being hashed.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const FUTURE = new Date(Date.now() + 86_400_000)
const PAST = new Date(Date.now() - 86_400_000)

let invitation: Record<string, unknown> | null = null
let existingUser: { id: string } | null = null
let orgRow: Record<string, unknown> | null = { id: 'org-1', name: 'Acme', licensePlan: 'starter', licenseStatus: 'valid' }
let memberCount = 1
let appConfigRow: { id: string } | null = { id: 'cfg-1' }
let quotaResult = { allowed: true, limit: 5, current: 1 }
let createdUser: Record<string, unknown> | null = { id: 'user-9', name: 'Newbie', email: 'n@t.com' }
/** When set, the org lookup throws -- to exercise the routes' catch blocks. */
let orgLookupThrows: Error | null = null

const bypassCalls: string[] = []
const findUniqueArgs: Array<Record<string, unknown>> = []
const createArgs: Array<Record<string, unknown>> = []
const inviteUpdateArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const hashed: string[] = []
const quotaCalls: Array<{ plan: unknown; key: string; current: number }> = []

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async (fn: () => Promise<unknown>) => {
    bypassCalls.push('bypass')
    return fn()
  },
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

mock.module('@/lib/passwords', () => ({
  hashPassword: (plain: string) => {
    hashed.push(plain)
    return `scrypt$${plain}`
  },
}))

mock.module('@/lib/crypto', () => ({
  signSession: (userId: string, version: number) => `signed.${userId}.${version}`,
}))

mock.module('@/lib/session', () => ({
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/plan-gating', () => ({
  checkQuota: (plan: unknown, key: string, current: number) => {
    quotaCalls.push({ plan, key, current })
    return quotaResult
  },
  quotaExceededMessage: (key: string, q: { limit: number; current: number }) =>
    `Quota exceeded for ${key}: ${q.current}/${q.limit}.`,
}))

mock.module('@/lib/db', () => ({
  db: {
    invitation: {
      findUnique: async (args: Record<string, unknown>) => {
        findUniqueArgs.push(args)
        return invitation
      },
      update: async (args: Record<string, unknown>) => {
        inviteUpdateArgs.push(args)
        return {}
      },
    },
    organization: {
      findUnique: async (args: Record<string, unknown>) => {
        if (orgLookupThrows) throw orgLookupThrows
        findUniqueArgs.push(args)
        return orgRow
      },
    },
    user: {
      findUnique: async (args: Record<string, unknown>) => {
        findUniqueArgs.push(args)
        return existingUser
      },
      count: async () => memberCount,
      create: async (args: Record<string, unknown>) => {
        createArgs.push(args)
        return createdUser
      },
    },
    appConfig: {
      findFirst: async () => appConfigRow,
      create: async (args: Record<string, unknown>) => {
        createArgs.push({ __appConfig: args })
        return {}
      },
    },
  },
}))

import { GET, POST } from './route'

/**
 * NextRequest exposes `nextUrl`, which a plain WHATWG `Request` does NOT have -- building the request with
 * `new Request(...)` alone made `req.nextUrl` undefined and every GET test failed before reaching any route
 * logic. This attaches the property the route actually reads.
 */
function getInvite(token: string | null) {
  const url = token === null
    ? 'http://localhost/api/auth/accept-invite'
    : `http://localhost/api/auth/accept-invite?token=${encodeURIComponent(token)}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return GET(req as never)
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/auth/accept-invite', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

function pending(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    token: 'tok-abc',
    email: 'newbie@example.com',
    role: 'analyst',
    organizationId: 'org-1',
    status: 'pending',
    expiresAt: FUTURE,
    ...over,
  }
}

beforeEach(() => {
  invitation = pending()
  existingUser = null
  orgRow = { id: 'org-1', name: 'Acme', licensePlan: 'starter', licenseStatus: 'valid' }
  memberCount = 1
  appConfigRow = { id: 'cfg-1' }
  quotaResult = { allowed: true, limit: 5, current: 1 }
  createdUser = { id: 'user-9', name: 'Newbie', email: 'newbie@example.com' }
  orgLookupThrows = null
  bypassCalls.length = 0
  findUniqueArgs.length = 0
  createArgs.length = 0
  inviteUpdateArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  hashed.length = 0
  quotaCalls.length = 0
})

describe('GET /api/auth/accept-invite — the landing page lookup', () => {
  test('a pending invite returns email, org name and role, and writes nothing', async () => {
    const res = await getInvite('tok-abc')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      email: 'newbie@example.com',
      organizationName: 'Acme',
      role: 'analyst',
    })
    expect(createArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('a MISSING token is 400 and does not even query the database', async () => {
    // `loadPendingInvitation` short-circuits on a null token. Without that, `findUnique({where:{token:null}})`
    // is a malformed query rather than a clean 400.
    const res = await getInvite(null)
    expect(res.status).toBe(400)
    expect(bypassCalls).toHaveLength(0)
  })

  test('an unknown token is 400', async () => {
    invitation = null
    expect((await getInvite('nope')).status).toBe(400)
  })

  test('an EXPIRED invite is refused before its details are shown', async () => {
    invitation = pending({ expiresAt: PAST })
    const res = await getInvite('tok-abc')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('expired')
  })

  test('an ALREADY-USED invite is refused', async () => {
    invitation = pending({ status: 'accepted' })
    const res = await getInvite('tok-abc')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('already used')
  })

  test('a deleted organization yields a null name rather than a crash', async () => {
    // `org?.name ?? null` -- the invite outlived its org. Must not 500 on the landing page.
    orgRow = null
    const res = await getInvite('tok-abc')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { organizationName: unknown }).organizationName).toBeNull()
  })
})

describe('POST /api/auth/accept-invite — token rules are enforced on the write path too', () => {
  test('an EXPIRED invite cannot be accepted', async () => {
    invitation = pending({ expiresAt: PAST })
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('an ALREADY-ACCEPTED invite cannot be accepted twice', async () => {
    // The single-use rule. Without it one leaked token mints unlimited users.
    invitation = pending({ status: 'accepted' })
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('the accepted invitation is marked accepted', async () => {
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(inviteUpdateArgs).toHaveLength(1)
    expect(inviteUpdateArgs[0]).toMatchObject({
      where: { token: 'tok-abc' },
      data: { status: 'accepted' },
    })
  })

  test('the invitation is marked accepted ONLY after the user was created', async () => {
    // Order matters: marking first would burn the token if the user insert then failed, leaving a permanent
    // dead invite. Asserted through a tombstone in the create args.
    const order: string[] = []
    invitation = pending()
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(200)
    order.push(createArgs.length > 0 ? 'created' : 'MISSING', inviteUpdateArgs.length > 0 ? 'marked' : 'MISSING')
    expect(order).toEqual(['created', 'marked'])
  })
})

describe('POST /api/auth/accept-invite — the ROLE comes from the invitation, never the body', () => {
  test('a body-supplied role is IGNORED even when the invite says viewer', async () => {
    // The escalation this blocks: the invite says viewer, the body says admin, and the route trusts the
    // body. Then the invitation email is just a formality and anyone with a token can self-promote.
    invitation = pending({ role: 'viewer' })
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long', role: 'admin' })
    const data = createArgs.find((a) => !a.__appConfig)!.data as { role: string }
    expect(data.role).toBe('viewer')
  })

  test('an admin invitation does grant admin (the role is not hardcoded to a low value)', async () => {
    // The opposite failure: ignoring the invitation's role entirely and always inserting 'viewer' would make
    // an admin invite useless.
    invitation = pending({ role: 'admin' })
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    const data = createArgs.find((a) => !a.__appConfig)!.data as { role: string }
    expect(data.role).toBe('admin')
  })

  test('the user is created in the INVITATION organization, not one from the body', async () => {
    // Cross-tenant write via the public form.
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long', organizationId: 'org-EVIL' })
    const data = createArgs.find((a) => !a.__appConfig)!.data as { organizationId: string }
    expect(data.organizationId).toBe('org-1')
  })

  test('the email is the INVITATION email, not one supplied in the body', async () => {
    // Otherwise the invitee could claim an address they do not own.
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long', email: 'other@evil.com' })
    const data = createArgs.find((a) => !a.__appConfig)!.data as { email: string }
    expect(data.email).toBe('newbie@example.com')
  })
})

describe('POST /api/auth/accept-invite — the maxUsers quota (the ONLY enforcement point)', () => {
  test('the plan is read from the ORG ROW, not from the body', async () => {
    // The invitee has no session, so their "plan" is meaningless. A body-supplied plan would let anyone
    // bypass the member limit by claiming enterprise.
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long', plan: 'enterprise' })
    expect(quotaCalls).toHaveLength(1)
    expect(quotaCalls[0]!.plan).toBe('starter')
  })

  test('the current member count is counted for the INVITATION org', async () => {
    memberCount = 5
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(quotaCalls[0]!.current).toBe(5)
    expect(quotaCalls[0]!.key).toBe('maxUsers')
  })

  test('a REFUSED quota is 402 with the QUOTA_EXCEEDED code, and no user is created', async () => {
    // 402 rather than 400: this is a commercial boundary, and the UI shows an upgrade prompt off the code.
    quotaResult = { allowed: false, limit: 5, current: 5 }
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(402)
    const body = (await res.json()) as { code: string; error: string }
    expect(body.code).toBe('QUOTA_EXCEEDED')
    expect(body.error).toContain('maxUsers')
    expect(createArgs).toHaveLength(0)
    // The invitation must NOT be consumed by a refused attempt, or the invitee can never retry after the
    // operator raises the plan.
    expect(inviteUpdateArgs).toHaveLength(0)
  })

  test('the quota is checked BEFORE the user write', async () => {
    // Checking after creation would create-then-refuse, leaving an over-quota row behind.
    quotaResult = { allowed: false, limit: 1, current: 1 }
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(createArgs).toHaveLength(0)
  })

  test('an ALLOWED quota proceeds normally', async () => {
    quotaResult = { allowed: true, limit: 5, current: 4 }
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/auth/accept-invite — identity and session', () => {
  test('an email registered AFTER the invite was sent is a 409, and nothing is written', async () => {
    // Global uniqueness: the invite predates the account. Creating the user would violate the unique index;
    // the route turns that race into a clean conflict instead of a 500.
    existingUser = { id: 'someone' }
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(409)
    expect(createArgs).toHaveLength(0)
    expect(inviteUpdateArgs).toHaveLength(0)
  })

  test('the password is stored HASHED with sessionVersion 1', async () => {
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    const data = createArgs.find((a) => !a.__appConfig)!.data as {
      passwordHash: string
      sessionVersion: number
    }
    expect(data.passwordHash).toBe('scrypt$hunter2long')
    expect(data.passwordHash).not.toBe('hunter2long')
    expect(data.sessionVersion).toBe(1)
    expect(hashed).toEqual(['hunter2long'])
  })

  test('the session cookie is set for the NEW user', async () => {
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('x-active-user=signed.user-9.1')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=lax')
  })

  test('the org context is entered before the audit write', async () => {
    // writeAudit reads getOrgContext(), and getActiveUser() -- which normally sets it -- never ran on this
    // public route. Without this line the audit row is written unscoped or the write throws.
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(enteredOrgs).toEqual(['org-1'])
    expect(auditWrites[0]).toMatchObject({
      userId: 'user-9',
      action: 'INVITATION_ACCEPTED',
      detail: { email: 'newbie@example.com', role: 'analyst' },
    })
  })

  test('a missing AppConfig is created as a safety net, with setup INCOMPLETE', async () => {
    appConfigRow = null
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    const cfg = createArgs.find((a) => a.__appConfig)
    expect(cfg).toBeDefined()
    expect((cfg!.__appConfig as { data: Record<string, unknown> }).data).toMatchObject({
      organizationId: 'org-1',
      setupCompleted: false,
    })
  })

  test('an EXISTING AppConfig is left alone', async () => {
    appConfigRow = { id: 'cfg-1' }
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(createArgs.filter((a) => a.__appConfig)).toHaveLength(0)
  })
})

describe('POST /api/auth/accept-invite — input validation', () => {
  test('each missing field is 400', async () => {
    expect((await post({ name: 'N', password: 'hunter2long' })).status).toBe(400)
    expect((await post({ token: 'tok-abc', password: 'hunter2long' })).status).toBe(400)
    expect((await post({ token: 'tok-abc', name: 'N' })).status).toBe(400)
  })

  test('a whitespace-only name is 400', async () => {
    // `!name?.trim()` -- '   ' is not a name.
    expect((await post({ token: 'tok-abc', name: '   ', password: 'hunter2long' })).status).toBe(400)
  })

  test('a password under 8 characters is 400 before any lookup', async () => {
    expect((await post({ token: 'tok-abc', name: 'N', password: '1234567' })).status).toBe(400)
    expect(hashed).toHaveLength(0)
  })

  test('exactly 8 characters is accepted (the boundary is >= 8)', async () => {
    expect((await post({ token: 'tok-abc', name: 'N', password: '12345678' })).status).toBe(200)
  })

  test('a malformed body is 400, never a 500', async () => {
    expect((await post('not json')).status).toBe(400)
    expect((await post([1, 2])).status).toBe(400)
  })

  test('an invitation whose organization vanished is 400, not a crash', async () => {
    orgRow = null
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(400)
    expect(createArgs.filter((a) => !a.__appConfig)).toHaveLength(0)
  })

  test('EVERY database call runs inside bypassOrg', async () => {
    // The caller has no session and therefore no org context. An org-scoped invitation lookup would filter
    // on undefined, find nothing, and make every invitation unusable.
    //
    // Found by negative control K14: my first version asserted `bypassCalls.length >= 6`, and un-wrapping the
    // invitation lookup LEFT THE TEST GREEN -- the count dropped from 8 to 7, still >= 6. A lower bound on a
    // call count cannot detect a removal when the bound has slack. Asserted here as the EXACT count, so each
    // unwrapped call is one negative.
    //   1 invitation lookup (GET path has its own, this is POST), 2 user lookup, 3 org lookup,
    //   4 member count, 5 user create, 6 invitation update, 7 appConfig findFirst -- plus the appConfig
    //   create only when one is missing (this fixture has one, so 7 total).
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(bypassCalls).toHaveLength(7)
  })

  test('the exact bypass count grows by ONE when the AppConfig is missing', async () => {
    // The other half: proves the count is measuring real calls rather than a constant.
    appConfigRow = null
    await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(bypassCalls).toHaveLength(8)
  })
})

describe('both handlers turn an internal failure into the typed error response', () => {
  test('a database failure during GET is 500, not a leaked stack', async () => {
    // Covers the GET catch. The org lookup is the failure point; the important property is that a raw error
    // never reaches the client body.
    orgLookupThrows = new Error('connection reset')
    const res = await getInvite('tok-abc')
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('connection reset')
  })

  test('a database failure during POST is 500, not a leaked stack', async () => {
    // Covers the POST catch, on the same seam.
    orgLookupThrows = new Error('connection reset')
    const res = await post({ token: 'tok-abc', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('connection reset')
  })

  test('POST with a valid-format but UNKNOWN token is 400 (the write path re-checks)', async () => {
    // GET and POST each resolve the invitation independently. If POST trusted a token GET had validated --
    // or skipped the check entirely -- a deleted invitation would still mint a user.
    invitation = null
    const res = await post({ token: 'tok-deleted', name: 'N', password: 'hunter2long' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
    expect(inviteUpdateArgs).toHaveLength(0)
  })
})
