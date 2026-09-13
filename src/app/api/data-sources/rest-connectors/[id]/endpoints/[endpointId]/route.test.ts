/**
 * DELETE /api/data-sources/rest-connectors/[id]/endpoints/[endpointId] — remove one whitelist entry.
 *
 * WHY THIS FILE EXISTS. A delete with TWO client-supplied ids, where the two ids must be proven to belong to
 * each other. Three properties are the whole point of the route:
 *
 *   1. BOTH LOADS ARE `findFirst`, NEVER `findUnique`. The connector is loaded by the path id, and the
 *      endpoint is loaded with `{ id: endpointId, connectorId: connector.id }` — the second term is what stops
 *      a caller from deleting an endpoint that belongs to a DIFFERENT connector. Both reads are org-scoped by
 *      the tenant extension; `findUnique` could not be. Asserted on the exact `where` clauses.
 *   2. THE DELETE USES THE **RESOLVED** ROW ID, not the raw path segment. `delete({ where: { id: endpoint.id } })`
 *      means the row that was just ownership-checked is the row that is removed, so a race that swapped the
 *      row cannot redirect the delete. Asserted as an argument check.
 *   3. NO ADMIN GATE. This route calls `getActiveUser()` only — unlike the sibling POST/PATCH paths — so a
 *      VIEWER can delete executable whitelist entries, including ones that make an agent's saved workflow
 *      stop working. Recorded by assertion (with the consequence spelled out) so that adding
 *      `requireRole(user, 'admin')` is a deliberate, visible change.
 *
 * Also pinned: the audit is `warning` severity and records the connector NAME plus the endpoint method/path
 * from the resolved rows, and a failing delete writes NO audit row.
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

let connector: Record<string, unknown> | null = null
let endpoint: Record<string, unknown> | null = null
let deleteThrows: Error | null = null
let connectorLoadThrows: Error | null = null

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const roleChecks: string[] = []

class UnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
}
class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN'
  readonly statusCode = 403
}
class LicenseError extends Error {
  readonly code = 'LICENSE_INVALID'
}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (!user) throw new UnauthorizedError('No active session.')
    return user
  },
  // Records the call so a test can prove the route asks for NO role at all.
  requireRole: (u: { role: string }, role: string) => {
    roleChecks.push(role)
    if (u.role !== role) throw new ForbiddenError(`Requires ${role} role. You have ${u.role}.`)
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof UnauthorizedError)
      return Response.json({ error: { code: 'UNAUTHORIZED', message: e.message } }, { status: 401 })
    if (e instanceof ForbiddenError)
      return Response.json({ error: { code: 'FORBIDDEN', message: e.message } }, { status: 403 })
    if (e instanceof LicenseError)
      return Response.json({ error: { code: 'LICENSE_INVALID', message: e.message } }, { status: 402 })
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: msg } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    restApiConnector: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findFirst', args })
        events.push('restApiConnector.findFirst')
        if (connectorLoadThrows) throw connectorLoadThrows
        return connector
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiConnector', op: 'findUnique', args })
        events.push('restApiConnector.findUnique')
        return connector
      },
    },
    restApiEndpoint: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'findFirst', args })
        events.push('restApiEndpoint.findFirst')
        return endpoint
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'findUnique', args })
        events.push('restApiEndpoint.findUnique')
        return endpoint
      },
      delete: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'delete', args })
        events.push('restApiEndpoint.delete')
        if (deleteThrows) throw deleteThrows
        return endpoint
      },
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'restApiEndpoint', op: 'deleteMany', args })
        events.push('restApiEndpoint.deleteMany')
        return { count: 1 }
      },
    },
  },
}))

const { DELETE } = await import('./route')

const ctx = (id = 'c1', endpointId = 'e1') => ({ params: Promise.resolve({ id, endpointId }) })

function del(id = 'c1', endpointId = 'e1') {
  const url = `http://localhost/api/data-sources/rest-connectors/${id}/endpoints/${endpointId}`
  const r = new Request(url, { method: 'DELETE' }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return DELETE(r as never, ctx(id, endpointId))
}

async function readBody(res: Response) {
  return JSON.parse(await res.text()) as Record<string, any>
}

const find = (model: string, op: string) => calls.filter((c) => c.model === model && c.op === op)

beforeEach(() => {
  user = adminUser
  connector = { id: 'c1', name: 'CRM' }
  endpoint = { id: 'e1', method: 'GET', path: '/customers' }
  deleteThrows = null
  connectorLoadThrows = null
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  roleChecks.length = 0
})

describe('org context and the missing admin gate', () => {
  test('it enters the session org before the first query', async () => {
    await del()
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'restApiConnector.findFirst'])
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-Q' }
    await del()
    expect(events[0]).toBe('enterWithOrg:org-Q')
  })

  test('NO ROLE IS EVER REQUESTED — the handler calls getActiveUser only', async () => {
    // The sibling `[id]` route (PATCH/DELETE on connectors) and the POST endpoints handler are the same
    // family; this one is not gated. Reported as the current behaviour so the difference is visible.
    await del()
    expect(roleChecks).toEqual([])
  })

  test('DOCUMENTED: a viewer can delete a whitelist entry (no admin gate, non-control)', async () => {
    // This is NOT a control asserting the behaviour is correct — it pins the ABSENCE of a gate. A viewer (the
    // lowest rank) successfully removes an endpoint the REST tool selects from, so an agent workflow that
    // relied on it starts answering "no whitelisted endpoint matched" with no owner-visible reason. Adding
    // requireRole(user, 'admin') to the route makes this test fail, which is the point.
    user = { ...adminUser, role: 'viewer' }
    const res = await del()
    expect(res.status).toBe(200)
    expect(find('restApiEndpoint', 'delete')).toHaveLength(1)
    expect(roleChecks).toEqual([])
  })

  test('an unauthenticated caller deletes nothing', async () => {
    user = null as unknown as typeof adminUser
    const res = await del()
    expect(res.status).toBe(401)
    expect(events).toEqual([])
  })
})

describe('ownership checks', () => {
  test('an unknown connector is 404 and the endpoint is never even looked up', async () => {
    connector = null
    const res = await del()
    expect(res.status).toBe(404)
    expect(await readBody(res)).toEqual({ ok: false, error: 'REST connector not found.' })
    expect(find('restApiEndpoint', 'findFirst')).toHaveLength(0)
    expect(find('restApiEndpoint', 'delete')).toHaveLength(0)
  })

  test('an unknown endpoint is 404 and nothing is deleted', async () => {
    endpoint = null
    const res = await del()
    expect(res.status).toBe(404)
    expect(await readBody(res)).toEqual({ ok: false, error: 'Endpoint not found.' })
    expect(find('restApiEndpoint', 'delete')).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('the endpoint lookup is scoped BY CONNECTOR as well as by id', async () => {
    // The second term is what prevents deleting an endpoint that lives on a different connector. Both terms
    // are asserted, along with the fact that the query is a findFirst (org-scoped) and not a findUnique.
    await del('c1', 'e1')
    const load = find('restApiEndpoint', 'findFirst')[0]!
    expect(load.args.where).toEqual({ id: 'e1', connectorId: 'c1' })
    expect(load.args.select).toEqual({ id: true, method: true, path: true })
  })

  test('the connector lookup filters by the path id and not by anything else', async () => {
    await del('c1')
    expect(find('restApiConnector', 'findFirst')[0]!.args.where).toEqual({ id: 'c1' })
  })

  test('NEITHER load uses findUnique (the cross-tenant IDOR class)', async () => {
    await del()
    expect(find('restApiConnector', 'findUnique')).toHaveLength(0)
    expect(find('restApiEndpoint', 'findUnique')).toHaveLength(0)
  })

  test('the endpoint is scoped to the CONNECTOR RESOLVED by the first read, not by the raw path id', async () => {
    // If the route echoed the path id here instead of `connector.id`, an id that resolved differently under
    // the org filter would still be used for the endpoint lookup.
    await del('c-span', 'e1')
    expect(find('restApiEndpoint', 'findFirst')[0]!.args.where).toEqual({ id: 'e1', connectorId: 'c1' })
  })

  test('a path id that resolves to a connector in another org yields 404 (the scoped read returned null)', async () => {
    // Models the tenant extension: the org filter makes the cross-org row invisible, so connector is null.
    connector = null
    const res = await del('c-other-org', 'e1')
    expect(res.status).toBe(404)
    expect(find('restApiEndpoint', 'delete')).toHaveLength(0)
  })

  test('an empty endpoint query result writes no audit row', async () => {
    endpoint = null
    await del()
    expect(auditWrites).toHaveLength(0)
  })
})

describe('the delete itself', () => {
  test('it deletes by the RESOLVED endpoint id, not the raw path segment', async () => {
    // `delete({ where: { id: endpoint.id } })`. A delete keyed on the path segment would skip the ownership
    // check's result entirely.
    await del('c1', 'e-from-url')
    expect(find('restApiEndpoint', 'delete')[0]!.args.where).toEqual({ id: 'e1' })
  })

  test('it deletes ONE row (no deleteMany, no cascade shortcut)', async () => {
    await del()
    expect(find('restApiEndpoint', 'delete')).toHaveLength(1)
    expect(find('restApiEndpoint', 'deleteMany')).toHaveLength(0)
  })

  test('the delete happens AFTER both ownership reads', async () => {
    await del()
    expect(events).toEqual([
      'enterWithOrg:org-1',
      'restApiConnector.findFirst',
      'restApiEndpoint.findFirst',
      'restApiEndpoint.delete',
      'audit',
    ])
  })

  test('the delete has no organizationId in its where clause — the extension injects it', async () => {
    // Documented: the tenant extension adds organizationId to MUTATE_WHERE_OPS, so the route passes only the
    // id. Removing enterWithOrg would make this delete unscoped, which is why the assertion above on the
    // org-context ORDER is security-relevant.
    await del()
    const where = find('restApiEndpoint', 'delete')[0]!.args.where as Record<string, unknown>
    expect(Object.keys(where)).toEqual(['id'])
  })

  test('the success body echoes the id and a deleted flag', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({ ok: true, data: { id: 'e1', deleted: true } })
  })

  test('a P2025-style delete failure is 500 and writes NO audit row', async () => {
    deleteThrows = Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' })
    const res = await del()
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })

  test('a delete failure does not claim success', async () => {
    deleteThrows = new Error('foreign key violation')
    const res = await del()
    const body = await readBody(res)
    expect(body.ok).not.toBe(true)
    expect(body).not.toHaveProperty('data')
  })

  test('a connector load failure is 500 with no leaked DB text', async () => {
    connectorLoadThrows = new Error('timeout on replica-7 while reading RestApiConnector')
    const res = await del()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('replica-7')
  })
})

describe('audit', () => {
  test('the audit is WARNING and records both rows resolved by the handler', async () => {
    await del()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'REST_ENDPOINT_DELETE',
      severity: 'warning',
      detail: {
        connectorId: 'c1',
        connectorName: 'CRM',
        endpointId: 'e1',
        method: 'GET',
        path: '/customers',
      },
    })
  })

  test('the audit is written AFTER the delete, never before', async () => {
    deleteThrows = new Error('boom')
    await del()
    expect(events).not.toContain('audit')
  })

  test('a second delete of the same id produces a second audit row only if it succeeds', async () => {
    await del()
    endpoint = null
    await del()
    expect(auditWrites).toHaveLength(1)
  })

  test('the severity is warning, not info, because the endpoint disappears from the whitelist', async () => {
    await del()
    expect(auditWrites[0]!.severity).toBe('warning')
  })
})
