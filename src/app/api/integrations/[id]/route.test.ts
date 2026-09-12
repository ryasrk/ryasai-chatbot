import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
const deleteManyCalls: Array<{ id: string }> = []
const dropCalls: string[] = []
let deleteManyCount = 1
let updateThrows: Error | null = null
const effects: string[] = []
let schemaRows: Array<Record<string, unknown>> = []
let integrationExisting: Record<string, unknown> | null = { id: 'int-1', name: 'prod db', status: 'active', contextPrompt: null }

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => integrationExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (updateThrows) throw updateThrows
        return {
          id: 'int-1',
          name: typeof data.name === 'string' ? data.name : 'prod db',
          status: typeof data.status === 'string' ? data.status : 'active',
          contextPrompt: typeof data.contextPrompt === 'string' ? data.contextPrompt : null,
          updatedAt: 't',
        }
      },
      deleteMany: async ({ where }: { where: { id: string } }) => {
        deleteManyCalls.push(where)
        effects.push('deleteMany:' + where.id)
        return { count: deleteManyCount }
      },
    },
  },
  isPrismaNotFound: (e: unknown) => e instanceof Error && /P2025/.test(e.message),
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => getActiveUserImpl(),
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) throw new Error('Forbidden')
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditCalls.push(args)
  },
  handleApiError: (e: unknown, fallback: string) =>
    new Response(
      JSON.stringify({ error: { code: 'FORBIDDEN', message: e instanceof Error ? e.message : fallback } }),
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 },
    ),
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}), maskConfig: () => ({ apiKey: '***' }) }))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: {
    drop: (id: string) => {
      dropCalls.push(id)
      // Shared ordering tape: both this and the delete mock append to `effects`,
      // which is the ONLY way to assert which ran first.
      effects.push('drop:' + id)
    },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))

const { PATCH, GET, DELETE } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/integrations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  // `schemas` is REQUIRED by the GET handler (it maps over it). The original
  // fixture was written for PATCH and omitted it, so the default carries an empty
  // array — otherwise a GET test that does not set its own fixture throws on
  // `integration.schemas.map` and surfaces as a 500 that looks like a server bug.
  integrationExisting = { id: 'int-1', name: 'prod db', status: 'active', contextPrompt: null, schemas: [] }
  deleteManyCalls.length = 0
  dropCalls.length = 0
  deleteManyCount = 1
  schemaRows = []
  effects.length = 0
  updateThrows = null
})

describe('PATCH /api/integrations/[id] contextPrompt', () => {
  test('contextPrompt accepted alongside existing fields', async () => {
    const res = await patch('int-1', { contextPrompt: 'sales schema only', name: ' sales ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.name).toBe('sales')
    expect(json.data.contextPrompt).toBe('sales schema only')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('INTEGRATION_UPDATE')
  })

  test('>4000 chars → 400', async () => {
    const res = await patch('int-1', { contextPrompt: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  test('whitespace trimmed', async () => {
    const res = await patch('int-1', { contextPrompt: '   hi   ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.contextPrompt).toBe('hi')
  })

  test('404 for unknown id', async () => {
    integrationExisting = null
    const res = await patch('nope', { contextPrompt: 'x' })
    expect(res.status).toBe(404)
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('int-1', { contextPrompt: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('int-1', { contextPrompt: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})

// ---------------------------------------------------------------------------
// GET /api/integrations/[id]
//
// Untested until now: only PATCH had coverage. The read path is where credentials
// are handled, so it is the one place a leak would go unnoticed.
// ---------------------------------------------------------------------------

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/integrations/${id}`) as never, {
    params: Promise.resolve({ id }),
  })
}

function del(id: string): Promise<Response> {
  return DELETE(
    new Request(`http://localhost/api/integrations/${id}`, { method: 'DELETE' }) as never,
    { params: Promise.resolve({ id }) },
  )
}

describe('GET /api/integrations/[id]', () => {
  test('the config is MASKED, never the decrypted values', async () => {
    integrationExisting = {
      id: 'int-1', name: 'prod db', type: 'POSTGRES', provider: 'pg', status: 'active',
      lastTestedAt: 't', lastTestOk: true, createdAt: 'c', updatedAt: 'u',
      encryptedConfig: 'ciphertext-blob', businessContext: 'BC', contextPrompt: 'ctx',
      schemas: [],
    }
    const res = await get('int-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: Record<string, unknown> }
    // maskConfig is the only thing standing between the API and a plaintext
    // credential in an HTTP response body. Assert the MASKED value is what ships.
    expect(body.data.config).toEqual({ apiKey: '***' })
    expect(JSON.stringify(body)).not.toContain('ciphertext-blob')
  })

  test('schema columns are parsed into objects, with a broken one degrading to empty', async () => {
    integrationExisting = {
      id: 'int-1', name: 'prod db', type: 'POSTGRES', provider: 'pg', status: 'active',
      lastTestedAt: 't', lastTestOk: true, createdAt: 'c', updatedAt: 'u',
      encryptedConfig: 'x', businessContext: null, contextPrompt: null,
      schemas: [
        { id: 's1', tableName: 'invoices', columns: JSON.stringify([{ name: 'id', type: 'int', primaryKey: true }]), rowCount: 10, sampleRow: JSON.stringify({ id: 1 }), reflectedAt: 'r' },
        // A schema row whose columns are corrupt must NOT take down the whole
        // response — one bad reflection should degrade to no columns.
        { id: 's2', tableName: 'broken', columns: 'not json', rowCount: null, sampleRow: null, reflectedAt: 'r' },
      ],
    }
    const res = await get('int-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { tables: Array<Record<string, unknown>>; tableCount: number } }
    expect(body.data.tableCount).toBe(2)
    expect(body.data.tables[0].columns).toEqual([{ name: 'id', type: 'int', primaryKey: true }])
    expect(body.data.tables[0].sampleRow).toEqual({ id: 1 })
    expect(body.data.tables[1].columns).toEqual([])
  })

  test('sampleRow is omitted when absent or not a JSON object', async () => {
    integrationExisting = {
      id: 'int-1', name: 'prod db', type: 'POSTGRES', provider: 'pg', status: 'active',
      lastTestedAt: 't', lastTestOk: true, createdAt: 'c', updatedAt: 'u',
      encryptedConfig: 'x', businessContext: null, contextPrompt: null,
      schemas: [
        // An ARRAY is valid JSON but not a row; safeParseJson must reject it.
        { id: 's1', tableName: 'a', columns: '[]', rowCount: 0, sampleRow: '[1,2]', reflectedAt: 'r' },
        { id: 's2', tableName: 'b', columns: '[]', rowCount: 0, sampleRow: null, reflectedAt: 'r' },
      ],
    }
    const body = await (await get('int-1')).json() as { data: { tables: Array<Record<string, unknown>> } }
    expect(body.data.tables[0].sampleRow).toBeUndefined()
    expect(body.data.tables[1].sampleRow).toBeUndefined()
  })

  test('an unknown id is 404 with ok:false', async () => {
    integrationExisting = null
    const res = await get('nope')
    expect(res.status).toBe(404)
    expect((await res.json() as { ok: boolean }).ok).toBe(false)
  })

  test('org context is entered before the query (tenant guard)', async () => {
    await get('int-1')
    expect(enterCalls).toEqual(['org-1'])
  })

  test('a viewer may READ (only writes are admin-gated)', async () => {
    getActiveUserImpl = async () => viewer
    expect((await get('int-1')).status).toBe(200)
  })

  test('a database error is handled, not thrown at the caller', async () => {
    const dbMod = await import('@/lib/db')
    const original = dbMod.db.integration.findFirst
    dbMod.db.integration.findFirst = (async () => { throw new Error('db down') }) as unknown as typeof original
    try {
      expect((await get('int-1')).status).toBe(500)
    } finally {
      dbMod.db.integration.findFirst = original
    }
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/integrations/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/integrations/[id]', () => {
  test('an admin drops the connector pool BEFORE deleting, and audits', async () => {
    integrationExisting = { id: 'int-1', name: 'prod db', provider: 'pg' }
    const res = await del('int-1')
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { deleted: boolean } }).data.deleted).toBe(true)
    // The pool must be released first (spec §3.2): deleting the row while a live
    // pool still holds the connection would leak the connection and let an
    // in-flight query run against a dropped integration.
    expect(dropCalls).toEqual(['int-1'])
    expect(deleteManyCalls).toEqual([{ id: 'int-1' }])
    const row = auditCalls.find((a) => a.action === 'INTEGRATION_DELETE')
    expect(row?.severity).toBe('warning')
    expect((row?.detail as Record<string, unknown>).provider).toBe('pg')
  })

  test('the pool is dropped BEFORE the row is deleted (ordering)', async () => {
    integrationExisting = { id: 'int-1', name: 'prod db', provider: 'pg' }
    await del('int-1')
    // Ordered tape: the drop mock and the deleteMany mock both append to
    // `effects`, so this compares the two events against each other. Asserting
    // only that each happened would pass even with the order reversed — and the
    // order is the point (a live pool holding a connection to a row that is
    // already gone leaks the connection and can serve an in-flight query from a
    // dropped integration).
    expect(effects).toEqual(['drop:int-1', 'deleteMany:int-1'])
  })

  test('a non-admin is refused AND nothing is dropped or deleted', async () => {
    getActiveUserImpl = async () => viewer
    integrationExisting = { id: 'int-1', name: 'prod db', provider: 'pg' }
    const res = await del('int-1')
    expect(res.status).toBe(403)
    // The gate only means something if the side effects did not happen.
    expect(dropCalls).toHaveLength(0)
    expect(deleteManyCalls).toHaveLength(0)
    expect(auditCalls).toHaveLength(0)
  })

  test('the role check runs BEFORE the lookup (no 404-vs-403 oracle)', async () => {
    getActiveUserImpl = async () => viewer
    let lookedUp = false
    const dbMod = await import('@/lib/db')
    const original = dbMod.db.integration.findFirst
    dbMod.db.integration.findFirst = (async () => { lookedUp = true; return integrationExisting }) as typeof original
    try {
      expect((await del('int-1')).status).toBe(403)
      expect(lookedUp).toBe(false)
    } finally {
      dbMod.db.integration.findFirst = original
    }
  })

  test('an unknown id is 404 and drops no pool', async () => {
    integrationExisting = null
    const res = await del('ghost')
    expect(res.status).toBe(404)
    expect(dropCalls).toHaveLength(0)
    expect(deleteManyCalls).toHaveLength(0)
  })

  test('a lookup that succeeds but a delete that matches nothing is still 404', async () => {
    integrationExisting = { id: 'int-1', name: 'prod db', provider: 'pg' }
    deleteManyCount = 0
    const res = await del('int-1')
    // Race: someone else deleted the row between the lookup and the write. The
    // caller must not be told the delete succeeded.
    expect(res.status).toBe(404)
    expect(auditCalls).toHaveLength(0)
  })

  test('org context is entered before any query (tenant guard)', async () => {
    integrationExisting = { id: 'int-1', name: 'prod db', provider: 'pg' }
    await del('int-1')
    expect(enterCalls).toEqual(['org-1'])
  })
})


// ---------------------------------------------------------------------------
// PATCH — field handling, status validation and the update race
// ---------------------------------------------------------------------------

describe('PATCH /api/integrations/[id] — fields and errors', () => {
  test('status is lowercased and validated against the allowed set', async () => {
    const res = await patch('int-1', { status: 'INACTIVE' })
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { status: string } }
    // Stored lowercase: a CHECK constraint or a query on 'active' would otherwise
    // miss a row saved as 'ACTIVE'.
    expect(body.data.status).toBe('inactive')
  })

  test('an unknown status is 400, not silently stored', async () => {
    const res = await patch('int-1', { status: 'broken' })
    expect(res.status).toBe(400)
    expect((await res.json() as { ok: boolean }).ok).toBe(false)
  })

  test('a whitespace-only name is NOT persisted as a name', async () => {
    const res = await patch('int-1', { name: '   ' })
    // Falls through to "no fields provided" rather than writing an empty name.
    expect(res.status).toBe(400)
  })

  test('a name is trimmed before persisting', async () => {
    const res = await patch('int-1', { name: '  prod db  ' })
    expect(res.status).toBe(200)
    expect((await res.json() as { data: { name: string } }).data.name).toBe('prod db')
  })

  test('businessContext is stored verbatim, NOT trimmed', async () => {
    // Unlike name/contextPrompt this is free-form prose where leading whitespace
    // may be meaningful formatting.
    const res = await patch('int-1', { businessContext: '  line one\nline two' })
    expect(res.status).toBe(200)
  })

  test('an oversize contextPrompt is 400', async () => {
    const res = await patch('int-1', { contextPrompt: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  test('an empty body is 400', async () => {
    const res = await patch('int-1', {})
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toContain('No fields provided')
  })

  test('a P2025 on update becomes 404, not a 500', async () => {
    // The row was looked up successfully and then vanished before the write. The
    // handler must translate Prisma's not-found into the same 404 the lookup path
    // returns, instead of leaking a 500.
    updateThrows = new Error('P2025: Record to update not found.')
    const res = await patch('int-1', { name: 'x' })
    expect(res.status).toBe(404)
  })

  test('an unrelated database error still propagates as 500', async () => {
    // The P2025 translation must not swallow every failure: a connection error is
    // not a missing row, and reporting it as 404 would hide a real outage.
    updateThrows = new Error('connection terminated')
    const res = await patch('int-1', { name: 'x' })
    expect(res.status).toBe(500)
  })
})
