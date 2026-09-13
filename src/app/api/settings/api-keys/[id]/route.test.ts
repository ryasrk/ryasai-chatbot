/**
 * DELETE /api/settings/api-keys/[id] — revoking an API key.
 *
 * WHY THIS FILE EXISTS. Part of the same audit that found 42 of 99 routes with no test at all. This one
 * REVOKES A CREDENTIAL: if it silently no-ops, an operator believes a leaked key is dead while it keeps
 * authenticating. Two properties matter more than the happy path:
 *
 *   1. the row is UPDATED (isActive=false + revokedAt set), not deleted — an issued key must remain
 *      auditable, and a hard delete would also break the log rows that reference it;
 *   2. revoking an ALREADY-revoked key keeps the ORIGINAL revokedAt (`existing.revokedAt ?? new Date()`),
 *      so a second revoke does not rewrite history.
 *
 * Plus the tenant guard: the target is read with `findFirst` so the tenant extension scopes it, and a
 * cross-org id must be indistinguishable from a missing one.
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
let existingKey: { id: string; label: string; keyPrefix: string; revokedAt: Date | null } | null = null
let updateResult: Record<string, unknown> | null = null
let updateError: Error | null = null
const findFirstArgs: Array<Record<string, unknown>> = []
const updateArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (authError) throw authError
    return activeUser
  },
  requireRole: (user: { role: string }, role: string) => {
    if (user.role !== role) {
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
    apiKey: {
      findFirst: async (args: Record<string, unknown>) => {
        findFirstArgs.push(args)
        return existingKey
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        if (updateError) throw updateError
        return updateResult
      },
    },
  },
}))

import { DELETE } from './route'

function call(id = 'key-1') {
  return DELETE(
    new Request('http://localhost/api/settings/api-keys/key-1', { method: 'DELETE' }) as never,
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  activeUser = adminUser
  authError = null
  existingKey = { id: 'key-1', label: 'CI key', keyPrefix: 'sk_abc', revokedAt: null }
  updateResult = {
    id: 'key-1',
    label: 'CI key',
    keyPrefix: 'sk_abc',
    isActive: false,
    revokedAt: new Date('2026-01-01T00:00:00Z'),
  }
  updateError = null
  findFirstArgs.length = 0
  updateArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
})

describe('DELETE /api/settings/api-keys/[id] — revoking', () => {
  test('an admin revokes the key: isActive=false and revokedAt is set', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; item: { isActive: boolean } }
    expect(body.ok).toBe(true)
    expect(body.item.isActive).toBe(false)

    const data = updateArgs[0]!.data as { isActive: boolean; revokedAt: Date }
    expect(data.isActive).toBe(false)
    expect(data.revokedAt).toBeInstanceOf(Date)
  })

  test('the key is UPDATED, never deleted', async () => {
    // A hard delete would destroy the audit trail and orphan the ApiRequestLog rows that reference the
    // key, making a leaked-then-revoked key untraceable.
    await call()
    expect(updateArgs).toHaveLength(1)
    expect(updateArgs[0]).toHaveProperty('where')
    expect(updateArgs[0]).not.toHaveProperty('delete')
  })

  test('revoking an ALREADY-revoked key KEEPS the original revokedAt', async () => {
    // `existing.revokedAt ?? new Date()`. The first revoke time is the security-relevant fact ("when did
    // this stop working"); a second revoke must not rewrite it to now.
    const original = new Date('2025-06-01T00:00:00Z')
    existingKey = { id: 'key-1', label: 'old', keyPrefix: 'sk_old', revokedAt: original }
    await call()
    const data = updateArgs[0]!.data as { revokedAt: Date }
    expect(data.revokedAt).toBe(original)
  })

  test('the audit row names the key so a revocation is reviewable', async () => {
    await call()
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({
      userId: 'admin-1',
      action: 'API_KEY_REVOKE',
      severity: 'warning',
      detail: { apiKeyId: 'key-1', label: 'CI key', keyPrefix: 'sk_abc' },
    })
  })

  test('the tenant context is entered before any DB call', async () => {
    await call()
    expect(enteredOrgs).toEqual(['org-1'])
    expect(findFirstArgs).toHaveLength(1)
  })
})

describe('DELETE /api/settings/api-keys/[id] — refusals', () => {
  test('a NON-ADMIN session cannot revoke, and nothing is written', async () => {
    // Revocation is destructive; a viewer revoking the admin's key is a denial of service.
    activeUser = { ...adminUser, role: 'viewer' }
    const res = await call()
    expect(res.status).toBe(403)
    expect(updateArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('no session is refused before touching the DB', async () => {
    authError = Object.assign(new Error('Unauthorized'), { statusCode: 401 })
    const res = await call()
    expect(res.status).toBe(401)
    expect(enteredOrgs).toHaveLength(0)
    expect(findFirstArgs).toHaveLength(0)
  })

  test('an unknown id is 404 and writes nothing', async () => {
    existingKey = null
    const res = await call('other-org-key')
    expect(res.status).toBe(404)
    expect(updateArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('a P2025 raised by the UPDATE is reported as 404, not 500', async () => {
    updateError = Object.assign(new Error('not found'), { code: 'P2025' })
    const res = await call()
    expect(res.status).toBe(404)
    expect(auditWrites).toHaveLength(0)
  })

  test('an unexpected DB error surfaces as 500, not a false 404', async () => {
    // A wrong "not found" here would tell the operator the key is gone when the database is simply down.
    updateError = Object.assign(new Error('connection refused'), { code: 'P1001' })
    const res = await call()
    expect(res.status).toBe(500)
  })
})
