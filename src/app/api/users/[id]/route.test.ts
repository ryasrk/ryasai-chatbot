/**
 * PATCH + DELETE /api/users/[id] — profile self-service and account deactivation.
 *
 * WHY THIS FILE EXISTS. Same audit as the role route: 42 of 99 API routes had no test. These two carry
 * two guards that are easy to lose and expensive to lose:
 *
 *   DELETE — an admin cannot deactivate THEIR OWN account. Without that check an install can be left with
 *   ZERO active admins, and since role changes require an admin, nobody can undo it through the product.
 *   That is a self-inflicted lockout, not a normal 400.
 *
 *   PATCH  — any user may edit their OWN profile, but editing SOMEONE ELSE's requires admin. The check is
 *   `if (user.userId !== id) requireRole(user, 'admin')`, so an inverted or dropped condition turns a
 *   viewer into an editor of other people's names/avatars.
 *
 * Both are soft deletes (isActive=false), both look the target up with `findFirst` so the tenant
 * extension scopes it, and both audit.
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

let activeUser: typeof adminUser = adminUser
let authError: Error | null = null
let existingUser: { id: string } | null = null
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

import { PATCH, DELETE } from './route'

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
    { params: Promise.resolve({ id }) },
  )
}

function del(id: string) {
  return DELETE(
    new Request(`http://localhost/api/users/${id}`, { method: 'DELETE' }) as never,
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  activeUser = adminUser
  authError = null
  existingUser = { id: 'target-1' }
  updateResult = { id: 'target-1', name: 'T', email: 't@t.com', role: 'viewer', avatarColor: null, isActive: true }
  updateError = null
  findFirstArgs.length = 0
  updateArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  requireRoleRefusals = 0
})

describe('PATCH /api/users/[id] — self-service vs admin-only', () => {
  test('a user edits their OWN profile without being an admin', async () => {
    // The whole point of the self-service branch: a viewer must be able to rename themselves.
    activeUser = { ...adminUser, userId: 'me-1', role: 'viewer' }
    existingUser = { id: 'me-1' }
    const res = await patch('me-1', { name: 'New Name' })
    expect(res.status).toBe(200)
    expect(requireRoleRefusals).toBe(0)
    expect(updateArgs[0]!.data).toEqual({ name: 'New Name' })
  })

  test('a non-admin editing SOMEONE ELSE is refused, and nothing is written', async () => {
    // The inverted/dropped-condition failure mode: a viewer editing another user.
    activeUser = { ...adminUser, userId: 'me-1', role: 'viewer' }
    const res = await patch('other-1', { name: 'Hacked' })
    expect(res.status).toBe(403)
    expect(requireRoleRefusals).toBe(1)
    expect(updateArgs).toHaveLength(0)
  })

  test('an admin may edit anyone', async () => {
    const res = await patch('other-1', { name: 'Renamed' })
    expect(res.status).toBe(200)
    expect(updateArgs[0]!.data).toEqual({ name: 'Renamed' })
  })

  test('only name and avatarColor are forwarded — unknown fields are dropped', async () => {
    // `data` is built field by field, so a `{ role: 'admin' }` smuggled into a profile PATCH must NOT
    // reach the update. Without this the profile endpoint is a privilege-escalation hole.
    await patch('target-1', { name: 'A', role: 'admin', isActive: false, organizationId: 'org-2' })
    expect(updateArgs[0]!.data).toEqual({ name: 'A' })
  })

  test('an empty or whitespace-only field set is 400, not a pointless write', async () => {
    const res = await patch('target-1', { name: '   ' })
    expect(res.status).toBe(400)
    expect(updateArgs).toHaveLength(0)
  })

  test('a malformed JSON body is 400, not a 500', async () => {
    const res = await PATCH(
      new Request('http://localhost/api/users/target-1', {
        method: 'PATCH',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      }) as never,
      { params: Promise.resolve({ id: 'target-1' }) },
    )
    expect(res.status).toBe(400)
  })

  test('an unknown id is 404 and writes nothing', async () => {
    existingUser = null
    const res = await patch('ghost', { name: 'X' })
    expect(res.status).toBe(404)
    expect(updateArgs).toHaveLength(0)
  })

  test('the audit row records the changed fields', async () => {
    await patch('target-1', { name: 'A', avatarColor: 'red' })
    expect(auditWrites[0]).toMatchObject({
      userId: 'admin-1',
      action: 'USER_PROFILE_UPDATE',
      severity: 'info',
      detail: { userId: 'target-1', changes: { name: 'A', avatarColor: 'red' } },
    })
  })
})

describe('DELETE /api/users/[id] — deactivation cannot lock the install out', () => {
  test('an admin CANNOT deactivate their own account', async () => {
    // The lockout guard. If this is lost, the last admin can disable themselves and -- because role
    // changes require an admin -- no one can restore access through the product.
    const res = await del('admin-1')
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('own account')
    // Refused BEFORE any lookup or write.
    expect(findFirstArgs).toHaveLength(0)
    expect(updateArgs).toHaveLength(0)
  })

  test('the self-check compares the SESSION user, not the URL id alone', async () => {
    // A different admin deactivating the first admin is legitimate and must go through.
    activeUser = { ...adminUser, userId: 'admin-2' }
    const res = await del('admin-1')
    expect(res.status).toBe(200)
    expect(updateArgs[0]!.data).toEqual({ isActive: false })
  })

  test('deactivation is a SOFT delete: isActive=false, never a row delete', async () => {
    const res = await del('target-1')
    expect(res.status).toBe(200)
    expect(updateArgs).toHaveLength(1)
    expect(updateArgs[0]!.data).toEqual({ isActive: false })
    expect(updateArgs[0]).not.toHaveProperty('delete')
  })

  test('a non-admin cannot deactivate anyone', async () => {
    activeUser = { ...adminUser, userId: 'me-1', role: 'analyst' }
    const res = await del('target-1')
    expect(res.status).toBe(403)
    expect(updateArgs).toHaveLength(0)
  })

  test('an unknown id is 404 and writes nothing', async () => {
    existingUser = null
    const res = await del('ghost')
    expect(res.status).toBe(404)
    expect(updateArgs).toHaveLength(0)
  })

  test('the deactivation audit row is recorded at warning severity', async () => {
    await del('target-1')
    expect(auditWrites[0]).toMatchObject({
      userId: 'admin-1',
      action: 'USER_DEACTIVATED',
      severity: 'warning',
      detail: { userId: 'target-1' },
    })
  })

  test('the tenant context is entered before any DB call', async () => {
    await del('target-1')
    expect(enteredOrgs).toEqual(['org-1'])
  })
})

describe('PATCH /api/users/[id] — the lost-update race', () => {
  test('a P2025 raised by the UPDATE is reported as 404, not 500', async () => {
    // The row can be deleted between the read and the write. `isPrismaNotFound` turns that race into the
    // same 404 the caller already understands instead of an internal error.
    updateError = Object.assign(new Error('not found'), { code: 'P2025' })
    const res = await patch('target-1', { name: 'Late' })
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })

  test('an UNEXPECTED DB error on PATCH is NOT swallowed as a 404', async () => {
    // Only P2025 maps to 404. A connection failure must surface, or a broken database looks like a
    // deleted user.
    updateError = Object.assign(new Error('connection refused'), { code: 'P1001' })
    const res = await patch('target-1', { name: 'X' })
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/users/[id] — the lost-update race', () => {
  test('a P2025 raised by the deactivation UPDATE is swallowed, and the audit still runs', async () => {
    // DELETE does not map this case to 404: the row vanished, the desired end state (inactive) is already
    // true, so the route treats it as success and still writes the audit row. Pinned so a future change to
    // error handling is a visible decision.
    updateError = Object.assign(new Error('not found'), { code: 'P2025' })
    const res = await del('target-1')
    expect(res.status).toBe(200)
    expect(auditWrites).toHaveLength(1)
  })

  test('an UNEXPECTED DB error on DELETE is reported through handleApiError', async () => {
    updateError = Object.assign(new Error('connection refused'), { code: 'P1001' })
    const res = await del('target-1')
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})
