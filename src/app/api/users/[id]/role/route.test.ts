/**
 * PATCH /api/users/[id]/role — the privilege-escalation surface.
 *
 * WHY THIS FILE EXISTS. An audit of `src/app/api` found 42 of 99 routes with NO test file and no
 * reference from any test. This is one of them, and it is the most sensitive of the set: it is the ONLY
 * endpoint that grants or revokes the `admin` role. A defect here is a privilege bug, not a display bug.
 *
 * Four properties are worth more than line coverage here:
 *   1. an outsider with a valid session but a non-admin role is REFUSED (requireRole),
 *   2. an unknown role string is refused before any write (whitelist, never free-form),
 *   3. the target is looked up with `findFirst`, so the tenant extension scopes it — a cross-org id must
 *      NOT resolve (the repo's Cross-tenant IDOR rule; `findUnique` would skip org scoping),
 *   4. every successful change writes an audit row carrying the OLD and NEW role, so a silent
 *      escalation is impossible to perform without leaving a trace.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'admin-1',
  name: 'Admin',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}

/** Swapped per test to simulate a viewer/analyst session. */
let activeUser: typeof adminUser = adminUser
/** Thrown by getActiveUser() to simulate "no session". */
let authError: Error | null = null
let existingUser: { id: string; role: string } | null = null
let updateResult: Record<string, unknown> | null = null
let updateError: Error | null = null
const findFirstArgs: Array<Record<string, unknown>> = []
const updateArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
let requireRoleRefusals = 0

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authError) throw authError
    return activeUser
  },
  // The real guard throws a 403-shaped error. Counted so a test can prove the route actually
  // CALLED it rather than re-implementing the check inline.
  requireRole: (user: { role: string }, role: string) => {
    if (user.role !== role) {
      requireRoleRefusals += 1
      const e = new Error('Forbidden') as Error & { statusCode?: number }
      e.statusCode = 403
      throw e
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) => {
    const status = (e as { statusCode?: number })?.statusCode ?? 500
    return Response.json({ ok: false, error: msg }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

mock.module('@/lib/db', () => ({
  isPrismaNotFound: (e: unknown) =>
    !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
  db: {
    user: {
      findFirst: async (args: Record<string, unknown>) => {
        findFirstArgs.push(args)
        return existingUser
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        if (updateError) throw updateError
        return updateResult
      },
    },
  },
}))

import { PATCH } from './route'

function call(id = 'target-1', body: unknown = { role: 'analyst' }) {
  return PATCH(
    new Request('http://localhost/api/users/target-1/role', {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  activeUser = adminUser
  authError = null
  existingUser = { id: 'target-1', role: 'viewer' }
  updateResult = { id: 'target-1', name: 'T', email: 't@t.com', role: 'analyst', avatarColor: null, isActive: true }
  updateError = null
  findFirstArgs.length = 0
  updateArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  requireRoleRefusals = 0
})

describe('PATCH /api/users/[id]/role — the happy path', () => {
  test('an admin can change a role, and the response carries the new role', async () => {
    const res = await call('target-1', { role: 'analyst' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; user: { role: string } }
    expect(body.ok).toBe(true)
    expect(body.user.role).toBe('analyst')
    expect(updateArgs[0]!.data).toEqual({ role: 'analyst' })
  })

  test('the tenant context is entered BEFORE any DB call', async () => {
    // `enterWith` does not propagate to the caller's frame, so a route that forgets this call runs
    // every query unscoped. `tenant-route-guard.test.ts` enforces this statically; this is the
    // behavioural half.
    await call()
    expect(enteredOrgs).toEqual(['org-1'])
    expect(findFirstArgs).toHaveLength(1)
  })

  test('the audit row records BOTH the old and the new role', async () => {
    // Without oldRole a reviewer cannot tell an escalation from a no-op. This is the record that makes
    // a privilege change reviewable.
    await call('target-1', { role: 'admin' })
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({
      userId: 'admin-1',
      action: 'USER_ROLE_CHANGED',
      severity: 'warning',
      detail: { userId: 'target-1', oldRole: 'viewer', newRole: 'admin' },
    })
  })
})

describe('PATCH /api/users/[id]/role — the privilege guard', () => {
  test('a VIEWER session is refused, and no write happens', async () => {
    // The escalation this endpoint must never allow: a non-admin granting themselves or anyone else a
    // role. The refusal comes from requireRole, and the assertion on updateArgs proves the route did
    // not write before checking.
    activeUser = { ...adminUser, role: 'viewer' }
    const res = await call()
    expect(res.status).toBe(403)
    expect(requireRoleRefusals).toBe(1)
    expect(updateArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('an ANALYST session is refused too (admin is the only role that may change roles)', async () => {
    activeUser = { ...adminUser, role: 'analyst' }
    const res = await call()
    expect(res.status).toBe(403)
    expect(updateArgs).toHaveLength(0)
  })

  test('no session at all is refused before touching the DB', async () => {
    authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    const res = await call()
    expect(res.status).toBe(401)
    expect(enteredOrgs).toHaveLength(0)
    expect(findFirstArgs).toHaveLength(0)
  })
})

describe('PATCH /api/users/[id]/role — the role whitelist', () => {
  test('an INVALID role is refused with 400 before any lookup or write', async () => {
    // The role string reaches `data: { role: newRole }` unchecked if this guard is lost, which is how a
    // typo ('Admin', 'superuser') either silently no-ops or widens the enum.
    for (const bad of ['superuser', 'Admin', 'owner', '', 'admin ', 'root']) {
      const res = await call('target-1', { role: bad })
      expect(res.status).toBe(400)
    }
    expect(findFirstArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
  })

  test('a MISSING role is refused with 400', async () => {
    const res = await call('target-1', {})
    expect(res.status).toBe(400)
    expect(updateArgs).toHaveLength(0)
  })

  test('all three valid roles are accepted', async () => {
    for (const role of ['admin', 'analyst', 'viewer']) {
      updateArgs.length = 0
      const res = await call('target-1', { role })
      expect(res.status).toBe(200)
      expect(updateArgs[0]!.data).toEqual({ role })
    }
  })

  test('a malformed JSON body is refused rather than crashing', async () => {
    // `req.json().catch(() => ({}))` -- a truncated body must degrade to the 400, not a 500.
    const res = await PATCH(
      new Request('http://localhost/api/users/target-1/role', {
        method: 'PATCH',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: 'target-1' }) },
    )
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/users/[id]/role — the target lookup is org-scoped', () => {
  test('the target is read with findFirst, which the tenant extension can scope', async () => {
    // NOT findUnique: a client-supplied id must go through a query the extension can add
    // `organizationId` to, or an org-A admin can change a role in org B by id.
    await call()
    expect(findFirstArgs[0]).toHaveProperty('where')
    expect(findFirstArgs[0]!.where).toEqual({ id: 'target-1' })
  })

  test('an id that does NOT resolve in this org is a 404, and nothing is written', async () => {
    // A cross-org id reaches the same code path as a missing one -- that is the intended behaviour:
    // indistinguishable from "not found", so the caller learns nothing about the other org.
    existingUser = null
    const res = await call('other-org-user')
    expect(res.status).toBe(404)
    expect(updateArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('a P2025 raised by the UPDATE itself is reported as 404, not 500', async () => {
    // The row can disappear between the read and the write. `isPrismaNotFound` turns that race into the
    // same 404 the caller expects instead of an internal error.
    updateError = Object.assign(new Error('not found'), { code: 'P2025' })
    const res = await call()
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })

  test('an UNEXPECTED DB error is NOT swallowed as a 404', async () => {
    // The other half of the same catch: only P2025 maps to 404. A connection failure must surface as a
    // real error, or a broken database would look like an empty user list.
    updateError = Object.assign(new Error('connection refused'), { code: 'P1001' })
    const res = await call()
    expect(res.status).toBe(500)
  })
})
