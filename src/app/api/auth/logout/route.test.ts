/**
 * POST /api/auth/logout
 *
 * WHY THIS FILE EXISTS. The endpoint is tiny, which is exactly why it is easy to
 * break silently: its contract is that it ALWAYS answers 200 with the session
 * cookie cleared, and that it writes a LOGOUT audit row only when a session was
 * actually present. Two failure modes matter to a user:
 *
 *   1. A session that cannot be cleared. If the cookie is not cleared the browser
 *      keeps sending a signed token, and every subsequent request still resolves
 *      an identity -- "log out" visibly does nothing.
 *   2. A session that cannot be REVOKED. getActiveUser() internally throws
 *      UnauthorizedError when there is no session; the route deliberately swallows
 *      that so the call stays idempotent. The risk of that blanket catch is that a
 *      real failure (DB down while resolving the user, audit write throwing) is
 *      swallowed too, so the tests below pin WHICH failures are swallowed and
 *      which must surface.
 *
 *   3. Tenant context. LOGOUT is an org-scoped audit write, so `enterWithOrg` must
 *      run BEFORE writeAudit and with the RESOLVED user org -- otherwise
 *      AuditLog.organizationId is undefined, the FK rejects the row, and the
 *      'info'-severity writeAudit swallows the failure: the user sees a successful
 *      logout and the audit trail silently loses the event.
 *
 * NOTE ON THE SOURCE. The route body carries hand-edited indentation on the
 * enterWithOrg line (it is not indented with its siblings). That is cosmetic, but
 * it is exactly the shape a broken automated edit leaves behind, and it made an
 * earlier reader of this file (and of `grep -A` output) conclude the call was
 * missing. The static test at the bottom pins the call INSIDE the inner try, so a
 * future edit that lifts it out of the block -- or that a formatter reflows into a
 * different scope -- is caught rather than silently accepted.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams -- declared ABOVE every mock.module() call, because a module
// factory that closes over a `let` reassigned later pins the first value.
// ---------------------------------------------------------------------------

const mockUser = {
  userId: 'u1',
  name: 'Test User',
  email: 't@test.com',
  role: 'admin',
  organizationId: 'org-a',
  plan: null as string | null,
}

/** Side-effect log -- proves ORDER of the effects, not merely that they ran. */
let events: string[] = []

let userImpl: () => Promise<typeof mockUser> = async () => mockUser
let writeAuditImpl: (args: any) => Promise<void> = async () => {}
let auditCalls: any[] = []
let enterWithOrgCalls: string[] = []
let handleApiErrorCalls: Array<{ msg: string; status: number }> = []

mock.module('@/lib/session', () => ({
  // Mirrors the real contract: throws UnauthorizedError (class-identity matters,
  // handleApiError discriminates on `instanceof`) when no session cookie resolves.
  getActiveUser: async () => {
    events.push('getActiveUser')
    return userImpl()
  },
  writeAudit: async (args: any) => {
    events.push('writeAudit')
    auditCalls.push(args)
    return writeAuditImpl(args)
  },
  // Mocked instead of exercised: the real one needs cookies()/jwt/redis/license.
  // The status codes it produces are what the route returns, so asserting on them
  // stays meaningful.
  handleApiError: (e: unknown, msg: string, status = 500) => {
    events.push('handleApiError')
    handleApiErrorCalls.push({ msg, status })
    void e
    return Response.json({ error: msg }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  // Recorded so a test can prove the tenant context is (not) established before
  // the audit write. NOT behavioural: the real enterWithOrg only sets
  // AsyncLocalStorage, and reimplementing that here would assert against itself.
  enterWithOrg: (orgId: string) => {
    events.push('enterWithOrg')
    enterWithOrgCalls.push(orgId)
  },
}))

// ---------------------------------------------------------------------------
// Module under test -- DYNAMIC import AFTER every mock.module() call.
// A static import is hoisted above the mocks and would bind the real modules.
// ---------------------------------------------------------------------------
const { POST } = await import('./route')

beforeEach(() => {
  events = []
  auditCalls = []
  enterWithOrgCalls = []
  handleApiErrorCalls = []
  userImpl = async () => mockUser
  writeAuditImpl = async () => {}
})

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout -- an active session', () => {
  test('returns 200 ok:true and clears the session cookie', async () => {
    const res = await POST()
    expect(res.status).toBe(200)

    // Read the body ONCE: res.text() drains it, so a second read (or res.json())
    // would throw. This is the repo-wide convention.
    const raw = await res.text()
    expect(JSON.parse(raw)).toEqual({ ok: true })

    const cookie = res.cookies.get('x-active-user')
    expect(cookie).toBeDefined()
    // The VALUE must be empty and maxAge 0 -- a cookie that keeps its value with
    // maxAge 0 is still cleared by the browser, but an empty value is what the
    // route contract documents, and maxAge 0 is what makes the clear immediate
    // rather than dependent on the 7-day expiry of the original cookie.
    expect(cookie?.value).toBe('')
    expect(cookie?.maxAge).toBe(0)
  })

  test('the cleared cookie keeps httpOnly and path=/ so the delete actually lands', async () => {
    const res = await POST()
    const cookie = res.cookies.get('x-active-user')
    // A cookie cleared on a DIFFERENT path than the one that set it is a
    // different cookie: the browser would keep the original session intact and
    // logout would appear to do nothing. path must match the login cookie.
    expect(cookie?.path).toBe('/')
    expect(cookie?.httpOnly).toBe(true)
  })

  test('writes a LOGOUT audit row attributed to the resolved user', async () => {
    await POST()

    expect(auditCalls).toHaveLength(1)
    const audit = auditCalls[0]
    expect(audit.action).toBe('LOGOUT')
    expect(audit.userId).toBe('u1')
    expect(audit.detail).toEqual({ email: 't@test.com' })
    // No explicit severity -> defaults to 'info', which is the severity that gets
    // SWALLOWED on failure. Pinned so a future change to 'critical' (fail-closed)
    // is a deliberate, visible decision.
    expect(audit.severity).toBeUndefined()
  })

  test('resolves the session before writing the audit row', async () => {
    await POST()
    // Order matters: the audit row needs the identity out of getActiveUser().
    expect(events.indexOf('getActiveUser')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('never leaks the session token or the password surface into the body', async () => {
    const res = await POST()
    const raw = await res.text()
    // The response is a bare ok flag. Anything richer risks echoing identity
    // material to a caller who may not be the owner of the cookie.
    expect(raw).toBe(JSON.stringify({ ok: true }))
    expect(raw).not.toContain('org-a')
    expect(raw).not.toContain('t@test.com')
  })
})

// ---------------------------------------------------------------------------
// Idempotence -- the documented contract
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout -- no active session (idempotent)', () => {
  test('an unauthenticated call still returns 200 and clears the cookie', async () => {
    userImpl = async () => {
      throw new Error('No active session.')
    }

    const res = await POST()
    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toEqual({ ok: true })
    expect(res.cookies.get('x-active-user')?.maxAge).toBe(0)
  })

  test('no audit row is written when there was no session to attribute it to', async () => {
    userImpl = async () => {
      throw new Error('No active session.')
    }

    await POST()
    // AuditLog.userId is optional but an unattributed LOGOUT row would be noise,
    // and there is no user/organization to scope it to at all.
    expect(auditCalls).toHaveLength(0)
  })

  test('a FAILING audit write is swallowed and the user is still logged out', async () => {
    // This is the deliberate design: the cookie clear must not be held hostage by
    // an audit outage. Verified both ways so the catch is pinned as intentional
    // rather than incidental.
    writeAuditImpl = async () => {
      throw new Error('audit db down')
    }

    const res = await POST()
    expect(res.status).toBe(200)
    expect(res.cookies.get('x-active-user')?.maxAge).toBe(0)
    // The audit path was entered and blew up -- the outer catch did NOT fire.
    expect(events).toContain('writeAudit')
    expect(handleApiErrorCalls).toHaveLength(0)
  })

  test('a DB outage while RESOLVING the user is swallowed the same way', async () => {
    // Documents the seam of the blanket catch: getActiveUser() failing for ANY
    // reason (not just "no session") produces a success response. That is the
    // intended trade-off for an idempotent logout, and it is asserted rather than
    // assumed so the behaviour cannot drift unnoticed.
    userImpl = async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:5432')
    }

    const res = await POST()
    expect(res.status).toBe(200)
    expect(auditCalls).toHaveLength(0)
    expect(handleApiErrorCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// The outer catch
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout -- unexpected failures', () => {
  test('an error in the response construction is routed through handleApiError', async () => {
    // NextResponse.json() is reachable from the outer try; force it to fail so the
    // catch block itself is exercised. Without this the outer catch is dead code
    // in the test suite and a regression there is invisible.
    const nextServer = await import('next/server')
    const original = nextServer.NextResponse.json
    const spy = mock((...args: unknown[]) => {
      throw new Error('response construction failed')
    })
    ;(nextServer.NextResponse as any).json = spy

    try {
      const res = await POST()
      expect(res.status).toBe(500)
      expect(JSON.parse(await res.text())).toEqual({ error: 'Failed to log out.' })
      expect(handleApiErrorCalls).toEqual([{ msg: 'Failed to log out.', status: 500 }])
      expect(events).toContain('handleApiError')
    } finally {
      ;(nextServer.NextResponse as any).json = original
    }
  })
})

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

describe('POST /api/auth/logout -- org context', () => {
  test('enters the tenant context with the RESOLVED user org', async () => {
    await POST()
    // AGENTS.md / prisma-tenant.ts: getActiveUser() calls enterWithOrg() itself,
    // but AsyncLocalStorage.enterWith() does NOT propagate back to the caller
    // frame, so the route must do it. Without this the LOGOUT audit row is written
    // with organizationId undefined -- auditLog is org-scoped and the column is a
    // required FK, so the row is rejected and swallowed by writeAudit's
    // 'info'-severity catch. The user still sees a 200 and the trail loses the event.
    expect(enterWithOrgCalls).toEqual(['org-a'])
  })

  test('establishes the tenant BEFORE the audit write, not after', async () => {
    await POST()
    // Order is the whole point: writeAudit() reads getOrgContext() at call time.
    // Entering the context afterwards would attribute nothing.
    expect(events.indexOf('enterWithOrg')).toBeGreaterThan(events.indexOf('getActiveUser'))
    expect(events.indexOf('enterWithOrg')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('a missing session never enters a tenant context', async () => {
    userImpl = async () => {
      throw new Error('No active session.')
    }

    await POST()
    // There is no org to enter -- and entering one would be worse than skipping it,
    // because it would attribute the NEXT thing on this async context to a tenant
    // this request never authenticated against.
    expect(enterWithOrgCalls).toEqual([])
    expect(events).not.toContain('enterWithOrg')
  })

  test('when the audit write fails AFTER entering the tenant, the tenant entry has still happened', async () => {
    writeAuditImpl = async () => {
      throw new Error('audit db down')
    }

    await POST()
    // The inner catch swallows BOTH the session failure and the audit failure, so
    // the tenant entry is the only trace that the request ever identified a user.
    expect(enterWithOrgCalls).toEqual(['org-a'])
    expect(events).toContain('writeAudit')
  })

  test('static: enterWithOrg must stay INSIDE the inner try, after getActiveUser', async () => {
    // Pins the source shape because the behavioural mocks above accept any org id.
    // If the call is ever hoisted out of the inner try, or moved above the await,
    // this test notices -- and so does a reader, which is the other reason the
    // (mis-indented) line is asserted by position rather than by presence alone.
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')

    // Imported (the route opts into the explicit-entry pattern, not bypassOrg).
    expect(src).toContain("import { enterWithOrg } from '@/lib/prisma-tenant'")
    // Called with the resolved user org -- never a literal or a bypass.
    expect(src).toContain('enterWithOrg(user.organizationId)')
    // ...and positioned between the two awaits it must sit between.
    const resolveIdx = src.indexOf('const user = await getActiveUser()')
    const enterIdx = src.indexOf('enterWithOrg(user.organizationId)')
    const auditIdx = src.indexOf('await writeAudit(')
    expect(resolveIdx).toBeGreaterThan(-1)
    expect(enterIdx).toBeGreaterThan(resolveIdx)
    expect(auditIdx).toBeGreaterThan(enterIdx)
    // The inner try/catch is what keeps this idempotent -- it must still wrap the
    // whole identity+audit block.
    const innerTryIdx = src.indexOf('try {', src.indexOf('export async function POST'))
    expect(innerTryIdx).toBeGreaterThan(-1)
    expect(innerTryIdx).toBeLessThan(resolveIdx)
    expect(src.indexOf('} catch {')).toBeGreaterThan(auditIdx)
  })
})
