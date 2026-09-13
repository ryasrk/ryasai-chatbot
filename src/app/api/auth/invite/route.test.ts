/**
 * POST /api/auth/invite — admin-only team invitation.
 *
 * WHY THIS FILE EXISTS. The route has one genuinely subtle branch and several that fail quietly in the wrong
 * direction:
 *
 *   1. THE REFRESH BRANCH EXISTS BECAUSE OF A UNIQUE CONSTRAINT. `@@unique([organizationId, email])` means a
 *      second invite for the same org+email cannot be CREATED. A pending, unexpired invite is refused (409), but
 *      an ACCEPTED or EXPIRED one is REFRESHED in place with a new token, role and expiry. Removing that branch
 *      turns "re-invite someone who let it lapse" into a raw unique-constraint 500. Asserted by checking the
 *      resulting row shape and the fact that NO create happens.
 *   2. THE EMAIL-EXISTS CHECK DISTINGUISHES TWO CASES WITH TWO MESSAGES. Same org -> "already in this
 *      organization."; another org -> "already registered.". Collapsing them into one message tells an admin
 *      something false about their own team, and the check runs through `bypassOrg` because email uniqueness is
 *      GLOBAL while the read context is per-org.
 *   3. THE TOKEN IS 32 RANDOM BYTES RENDERED AS HEX. A short or non-random token would be guessable, and the
 *      invite URL is the only credential the invitee receives. Asserted by shape and by two invites differing.
 *   4. THE INVITE URL IS BUILT FROM THE REQUEST ORIGIN, so a deployment behind a different host does not email a
 *      localhost link. The raw token is ALSO returned in the body, which is what a copy-to-clipboard UI uses.
 *
 * Also pinned: the 7-day TTL, email normalization to lowercase, the role default and its allowlist, the
 * created-vs-refreshed field differences (the create carries `organizationId`; the update does NOT, because it is
 * part of the unique key and must not be rewritten), and the audit.
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

// ---- mutable seams, declared before every mock.module ----
let existingUser: Record<string, unknown> | null = null
let existingInvite: Record<string, unknown> | null = null
let createThrows: Error | null = null

const BYPASS_LOOKUPS: Record<string, unknown>[] = []
const invitationCreates: Array<Record<string, unknown>> = []
const invitationUpdates: Array<Record<string, unknown>> = []
const audits: Array<Record<string, unknown>> = []
const events: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    if (!u || u.role !== 'admin') {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
    void required
  },
  writeAudit: async (r: Record<string, unknown>) => {
    audits.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: 'Forbidden' }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
  bypassOrg: async (fn: () => Promise<unknown>) => {
    events.push('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findUnique: async (args: Record<string, unknown>) => {
        BYPASS_LOOKUPS.push({ op: 'user.findUnique', ...args })
        events.push('user.findUnique')
        return existingUser
      },
    },
    invitation: {
      findUnique: async (args: Record<string, unknown>) => {
        BYPASS_LOOKUPS.push({ op: 'invitation.findUnique', ...args })
        events.push('invitation.findUnique')
        return existingInvite
      },
      create: async (args: Record<string, unknown>) => {
        events.push('invitation.create')
        if (createThrows) throw createThrows
        invitationCreates.push(args)
        return { id: 'inv-new', ...(args.data as Record<string, unknown>) }
      },
      update: async (args: Record<string, unknown>) => {
        events.push('invitation.update')
        invitationUpdates.push(args)
        return { ...(existingInvite ?? {}), ...(args.data as Record<string, unknown>) }
      },
    },
  },
}))

// DYNAMIC: a static import would be evaluated before the mocks above and bypass every one of them.
const { POST } = await import('./route')

function post(body: unknown) {
  const url = 'https://chat.acme.example/api/auth/invite'
  const req = new Request(url, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return POST(req as never)
}

const inviteLookup = () =>
  BYPASS_LOOKUPS.find((q) => q.op === 'invitation.findUnique') as Record<string, unknown>

beforeEach(() => {
  user = adminUser
  existingUser = null
  existingInvite = null
  createThrows = null
  BYPASS_LOOKUPS.length = 0
  invitationCreates.length = 0
  invitationUpdates.length = 0
  audits.length = 0
  events.length = 0
})

describe('authorisation and body validation', () => {
  test('an analyst is refused before any lookup', async () => {
    user = { ...adminUser, role: 'analyst' }
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(403)
    expect(BYPASS_LOOKUPS).toHaveLength(0)
  })

  test('the org context is entered first', async () => {
    await post({ email: 'x@y.com' })
    expect(events[0]).toBe('enterWithOrg:org-1')
  })

  test('a missing email is 400', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('A valid email is required.')
  })

  test('a malformed email is 400', async () => {
    for (const bad of ['nope', 'a@b', 'a b@c.com', '@b.com', 'a@.com']) {
      expect((await post({ email: bad })).status).toBe(400)
    }
    expect(BYPASS_LOOKUPS).toHaveLength(0)
  })

  test('a null email is 400 through the optional chain', async () => {
    // `email?.trim()` short-circuits on null/undefined, so these reach the email guard.
    expect((await post({ email: null })).status).toBe(400)
    expect((await post({ email: undefined })).status).toBe(400)
  })

  test('FIXED: a NUMERIC or OBJECT email is 400, not the 500 it used to be', async () => {
    // This test used to PIN the defect. `email?.trim()` guards only null/undefined, so `(42).trim()` and
    // `({}).trim()` threw a TypeError that left the handler and became a 500 -- reporting a client payload error
    // as a server fault, which monitoring counts as an outage. The route now type-checks before calling any
    // method on the value, so every malformed shape takes the SAME 400 path the message promises. Keeping the
    // original injections is what makes this a regression guard.
    for (const bad of [42, {}, true, []]) {
      const res = await post({ email: bad })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('A valid email is required.')
    }
    expect((await post({ email: null })).status).toBe(400)
    expect((await post({ email: undefined })).status).toBe(400)
  })

  test('FIXED: no invitation row and no audit for a non-string email', async () => {
    await post({ email: 42 })
    await post({ email: {} })
    expect(invitationCreates).toHaveLength(0)
    expect(invitationUpdates).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('FIXED: a NON-STRING role is 400 rather than silently coerced', async () => {
    // `role ?? 'viewer'` would pass 42 through to VALID_ROLES.has (false -> 400), but an object or an array
    // would reach the DB write as a non-string. The check is explicit now, so the rejection reason is the same
    // one the caller sees for a typo'd role.
    for (const bad of [42, {}, [], true]) {
      const res = await post({ email: 'x@y.com', role: bad })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('Invalid role.')
    }
    expect(invitationCreates).toHaveLength(0)
    // And an ABSENT role still defaults to the least-privileged one.
    expect((await post({ email: 'x@y.com', role: undefined })).status).toBe(200)
    expect((invitationCreates[0]!.data as { role: string }).role).toBe('viewer')
  })

  test('a malformed JSON body is 400 with the body-specific message', async () => {
    // Distinct from the email message: the request never parsed, so no field can be blamed.
    const res = await post('not json')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Invalid request body.')
  })

  test('a JSON ARRAY body is rejected as an invalid body, not treated as an object', async () => {
    // `typeof [] === 'object'`, so the guard passes an array through -- the email check then rejects it. Pinned
    // so the two-stage behaviour is deliberate.
    const res = await post('[]')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('A valid email is required.')
  })

  test('an unknown role is 400 BEFORE the user lookup', async () => {
    // Validating the role first means a typo cannot cost two DB reads.
    const res = await post({ email: 'x@y.com', role: 'superadmin' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('Invalid role.')
    expect(BYPASS_LOOKUPS).toHaveLength(0)
  })

  test('the three valid roles are accepted', async () => {
    for (const role of ['admin', 'analyst', 'viewer']) {
      expect((await post({ email: 'x@y.com', role })).status).toBe(200)
      invitationCreates.length = 0
      invitationUpdates.length = 0
    }
  })

  test('the email is normalized to LOWERCASE and trimmed before every lookup', async () => {
    await post({ email: '  Mixed.Case@Example.COM  ' })
    expect((BYPASS_LOOKUPS[0] as { where: { email: string } }).where.email).toBe('mixed.case@example.com')
    expect((inviteLookup().where as { organizationId_email: { email: string } }).organizationId_email.email).toBe(
      'mixed.case@example.com',
    )
  })
})

describe('the existing-user check', () => {
  test('a user in THIS org gets the "already in this organization" message', async () => {
    existingUser = { id: 'u9', organizationId: 'org-1' }
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('User already in this organization.')
  })

  test('a user in ANOTHER org gets the "already registered" message', async () => {
    // Two messages for one lookup: collapsing them would tell an admin their teammate is already on the team.
    existingUser = { id: 'u9', organizationId: 'org-2' }
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('Email already registered.')
  })

  test('the user lookup runs through bypassOrg (email uniqueness is GLOBAL, not per-org)', async () => {
    await post({ email: 'x@y.com' })
    expect(events).toContain('bypassOrg')
    expect(events.indexOf('bypassOrg')).toBeLessThan(events.indexOf('user.findUnique'))
  })

  test('the lookup is by the NORMALIZED email', async () => {
    await post({ email: 'X@Y.com' })
    expect((BYPASS_LOOKUPS[0] as { where: { email: string } }).where.email).toBe('x@y.com')
  })

  test('an existing user means NO invitation row is written', async () => {
    existingUser = { id: 'u9', organizationId: 'org-1' }
    await post({ email: 'x@y.com' })
    expect(invitationCreates).toHaveLength(0)
    expect(invitationUpdates).toHaveLength(0)
  })
})

describe('the pending vs refresh vs create branch', () => {
  const pending = () => ({
    id: 'inv-1',
    status: 'pending',
    expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
  })

  test('a PENDING, UNEXPIRED invite is refused with 409 and nothing is rewritten', async () => {
    // Rewriting would invalidate the link already sitting in the invitee's inbox.
    existingInvite = pending()
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe(
      'A pending invitation already exists for this email.',
    )
    expect(invitationUpdates).toHaveLength(0)
    expect(invitationCreates).toHaveLength(0)
  })

  test('an ACCEPTED invite is REFRESHED in place, never re-created', async () => {
    // @@unique([organizationId, email]) makes a create impossible here; the refresh branch is what turns
    // "re-invite someone" into a working action instead of a raw unique-constraint 500.
    existingInvite = { id: 'inv-1', status: 'accepted', expiresAt: new Date(Date.now() + 1000) }
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(200)
    expect(invitationCreates).toHaveLength(0)
    expect(invitationUpdates).toHaveLength(1)
    expect(invitationUpdates[0]!.where).toEqual({ id: 'inv-1' })
  })

  test('an EXPIRED pending invite is REFRESHED too', async () => {
    existingInvite = { id: 'inv-1', status: 'pending', expiresAt: new Date(Date.now() - 1000) }
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(200)
    expect(invitationUpdates).toHaveLength(1)
    expect(invitationCreates).toHaveLength(0)
  })

  test('the refresh resets status to pending and carries the new role, expiry and inviter', async () => {
    existingInvite = { id: 'inv-1', status: 'accepted', expiresAt: new Date(Date.now() + 1000) }
    await post({ email: 'x@y.com', role: 'analyst' })
    const data = invitationUpdates[0]!.data as Record<string, unknown>
    expect(data).toMatchObject({ status: 'pending', role: 'analyst', invitedBy: 'u1' })
    expect(data.expiresAt).toBeInstanceOf(Date)
    expect(typeof data.token).toBe('string')
  })

  test('the refresh does NOT rewrite organizationId or email (they are the unique KEY)', async () => {
    existingInvite = { id: 'inv-1', status: 'accepted', expiresAt: new Date(Date.now() + 1000) }
    await post({ email: 'x@y.com' })
    const data = invitationUpdates[0]!.data as Record<string, unknown>
    expect(data.organizationId).toBeUndefined()
    expect(data.email).toBeUndefined()
  })

  test('with NO existing invite a row IS created, carrying the org', async () => {
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(200)
    expect(invitationCreates).toHaveLength(1)
    expect(invitationCreates[0]!.data).toMatchObject({
      organizationId: 'org-1',
      email: 'x@y.com',
      role: 'viewer',
      invitedBy: 'u1',
    })
  })

  test('the role DEFAULTS to viewer when omitted', async () => {
    // The least-privileged role: an admin who forgets the field must not mint an admin.
    await post({ email: 'x@y.com' })
    expect((invitationCreates[0]!.data as { role: string }).role).toBe('viewer')
  })

  test('the unique-key lookup uses the composite organizationId_email key', async () => {
    await post({ email: 'x@y.com' })
    expect(inviteLookup().where).toEqual({
      organizationId_email: { organizationId: 'org-1', email: 'x@y.com' },
    })
  })

  test('a CREATE failure surfaces as 500 without leaking the constraint text', async () => {
    createThrows = new Error('Unique constraint failed on the fields: (organizationId, email)')
    const res = await post({ email: 'x@y.com' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('Unique constraint')
  })

  test('a failed write writes NO audit row', async () => {
    createThrows = new Error('boom')
    await post({ email: 'x@y.com' })
    expect(audits).toHaveLength(0)
  })
})

describe('the token, the URL and the audit', () => {
  test('the token is 64 hex characters (32 random bytes)', async () => {
    // The invite URL is the only credential the invitee receives; a short token would be guessable.
    await post({ email: 'x@y.com' })
    const token = (invitationCreates[0]!.data as { token: string }).token
    expect(token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('two invitations for different emails get DIFFERENT tokens', async () => {
    await post({ email: 'a@y.com' })
    await post({ email: 'b@y.com' })
    const [t1, t2] = invitationCreates.map((c) => (c.data as { token: string }).token)
    expect(t1).not.toBe(t2)
  })

  test('the expiry is 7 DAYS out', async () => {
    const before = Date.now()
    await post({ email: 'x@y.com' })
    const expiresAt = (invitationCreates[0]!.data as { expiresAt: Date }).expiresAt.getTime()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(expiresAt - before).toBeGreaterThanOrEqual(sevenDays - 5000)
    expect(expiresAt - before).toBeLessThanOrEqual(sevenDays + 5000)
  })

  test('the invite URL uses the REQUEST ORIGIN, not a hardcoded host', async () => {
    // A hardcoded localhost would email a dead link from any real deployment.
    const body = (await (await post({ email: 'x@y.com' })).json()) as { inviteUrl: string; token: string }
    expect(body.inviteUrl.startsWith('https://chat.acme.example/api/auth/accept-invite?token=')).toBe(true)
    expect(body.inviteUrl).toContain(body.token)
  })

  test('the raw token is ALSO returned for a copy-to-clipboard UI', async () => {
    const body = (await (await post({ email: 'x@y.com' })).json()) as { ok: boolean; token: string }
    expect(body.ok).toBe(true)
    expect(body.token).toMatch(/^[0-9a-f]{64}$/)
  })

  test('the URL token and the STORED token are the same value', async () => {
    const body = (await (await post({ email: 'x@y.com' })).json()) as { token: string }
    expect((invitationCreates[0]!.data as { token: string }).token).toBe(body.token)
  })

  test('the audit records the normalized email and the role', async () => {
    await post({ email: '  X@Y.COM  ', role: 'analyst' })
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'USER_INVITED',
      detail: { email: 'x@y.com', role: 'analyst' },
    })
  })

  test('the audit records NO token — a logged token is a usable invitation', async () => {
    await post({ email: 'x@y.com' })
    const logged = JSON.stringify(audits[0])
    expect(logged).not.toMatch(/[0-9a-f]{64}/)
  })

  test('the audit happens AFTER the write', async () => {
    await post({ email: 'x@y.com' })
    expect(events.indexOf('invitation.create')).toBeLessThan(events.indexOf('audit'))
  })
})
