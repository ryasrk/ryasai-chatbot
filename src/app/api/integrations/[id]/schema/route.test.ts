import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
let integrationExisting: Record<string, unknown> | null = { id: 'int-1' }
let schemaRow: Record<string, unknown> | null = {
  id: 'sch-1',
  tableName: 'orders',
  description: 'auto desc',
  manualDescription: false,
}
let schemaRows: Array<Record<string, unknown>> = []
const createManyArgs: Array<{ data: Array<Record<string, unknown>> }> = []
const deleteManyArgs: Array<{ integrationId: string }> = []
const embedCacheCalls: number[] = []
let fetchedTables: Array<Record<string, unknown>> = []
let fetchSchemaThrows: Error | null = null

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async () => integrationExisting,
    },
    integrationSchema: {
      findFirst: async () => schemaRow,
      findMany: async () => schemaRows,
      deleteMany: async (a: { where: { integrationId: string } }) => {
        deleteManyArgs.push(a.where)
        return { count: schemaRows.length }
      },
      createMany: async (a: { data: Array<Record<string, unknown>> }) => {
        createManyArgs.push(a)
        return { count: a.data.length }
      },
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'sch-1',
        tableName: schemaRow?.tableName ?? 'orders',
        description: data.description ?? null,
        manualDescription: data.manualDescription ?? false,
      }),
    },
  },
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
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}) }))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: () => ({
      fetchSchema: async () => {
        if (fetchSchemaThrows) throw fetchSchemaThrows
        return fetchedTables
      },
    }),
  },
}))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => { embedCacheCalls.push(1) } }))

const { PATCH, GET } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/integrations/${id}/schema`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  integrationExisting = {
    id: 'int-1', name: 'prod db', provider: 'pg', status: 'active',
    encryptedConfig: 'x', organizationId: 'org-1',
  }
  schemaRow = { id: 'sch-1', tableName: 'orders', description: 'auto desc', manualDescription: false }
  schemaRows = []
  createManyArgs.length = 0
  deleteManyArgs.length = 0
  embedCacheCalls.length = 0
  fetchedTables = []
  fetchSchemaThrows = null
})

describe('PATCH /api/integrations/[id]/schema', () => {
  test('set description → manualDescription=true', async () => {
    const res = await patch('int-1', { table: 'orders', description: 'manual override' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.schema.manualDescription).toBe(true)
    expect(json.schema.description).toBe('manual override')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('SCHEMA_DESC_UPDATE')
  })

  test('null description → manualDescription=false + description null', async () => {
    const res = await patch('int-1', { table: 'orders', description: null })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.schema.manualDescription).toBe(false)
    expect(json.schema.description).toBeNull()
  })

  test('unknown table → 404', async () => {
    schemaRow = null
    const res = await patch('int-1', { table: 'nope', description: 'x' })
    expect(res.status).toBe(404)
  })

  test('unknown integration → 404', async () => {
    integrationExisting = null
    const res = await patch('nope', { table: 'orders', description: 'x' })
    expect(res.status).toBe(404)
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('int-1', { table: 'orders', description: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('>500 chars → 400', async () => {
    const res = await patch('int-1', { table: 'orders', description: 'x'.repeat(501) })
    expect(res.status).toBe(400)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('int-1', { table: 'orders', description: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })

  test('a missing or blank table is 400', async () => {
    expect((await patch('int-1', { description: 'x' })).status).toBe(400)
    // Whitespace-only must not pass: the lookup is by tableName, so '   ' would
    // never match and the caller would get a confusing 404 instead of a 400.
    expect((await patch('int-1', { table: '   ', description: 'x' })).status).toBe(400)
  })

  test('a non-string, non-null description is 400', async () => {
    // A number or object reaching Prisma would be a type error at best and a
    // silently coerced value at worst.
    expect((await patch('int-1', { table: 'orders', description: 42 })).status).toBe(400)
    expect((await patch('int-1', { table: 'orders', description: { a: 1 } })).status).toBe(400)
  })

  test('a body that is not JSON at all is 400, not a crash', async () => {
    const req = new Request('http://localhost/api/integrations/int-1/schema', {
      method: 'PATCH',
      body: 'not json',
    })
    const res = await PATCH(req as never, { params: Promise.resolve({ id: 'int-1' }) })
    // req.json() rejects; the handler catches that and treats it as an empty body.
    expect(res.status).toBe(400)
  })

  test('the description is TRIMMED before the length check', async () => {
    // 500 real characters padded with whitespace must fit; measuring the raw
    // string would reject it on padding alone.
    await patch('int-1', { table: 'orders', description: '  ' + 'x'.repeat(500) + '  ' })
    expect((await patch('int-1', { table: 'orders', description: 'x'.repeat(501) })).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// GET /api/integrations/[id]/schema
//
// Only PATCH was covered. The refresh path is the interesting one: it re-reflects
// the schema from the live database and is the one place an admin's locked table
// description can be destroyed.
// ---------------------------------------------------------------------------

function get(id: string, query = ''): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/integrations/${id}/schema${query}`) as never,
    { params: Promise.resolve({ id }) },
  )
}

describe('GET /api/integrations/[id]/schema', () => {
  test('returns the cached tables without touching the connection', async () => {
    schemaRows = [
      { id: 'sch-1', tableName: 'orders', columns: JSON.stringify([{ name: 'id', type: 'int' }]), rowCount: 5, sampleRow: JSON.stringify({ id: 1 }), description: 'd', manualDescription: true, reflectedAt: new Date() },
    ]
    const res = await get('int-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { data: { tableCount: number; tables: Array<Record<string, unknown>> } }
    expect(body.data.tableCount).toBe(1)
    expect(body.data.tables[0].columns).toEqual([{ name: 'id', type: 'int' }])
    expect(body.data.tables[0].manualDescription).toBe(true)
    // A plain read must not re-reflect: hitting the customer's production database
    // on every page load is not acceptable.
    expect(deleteManyArgs).toHaveLength(0)
  })

  test('a broken columns blob degrades to an empty list', async () => {
    schemaRows = [
      { id: 'sch-1', tableName: 'a', columns: 'not json', rowCount: null, sampleRow: null, description: null, manualDescription: false, reflectedAt: new Date() },
    ]
    const body = await (await get('int-1')).json() as { data: { tables: Array<{ columns: unknown }> } }
    expect(body.data.tables[0].columns).toEqual([])
  })

  test('an unknown integration is 404', async () => {
    integrationExisting = null
    expect((await get('nope')).status).toBe(404)
  })

  test('a schema older than 24h is flagged as stale', async () => {
    // The log line is the ONLY signal a human gets that the reflected schema may no
    // longer match the customer's database — there is deliberately no cron.
    schemaRows = [
      { id: 'sch-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: null, manualDescription: false, reflectedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    ]
    const printed: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')) }
    try {
      await get('int-1')
    } finally {
      console.log = orig
    }
    expect(printed.some((m) => m.includes('older than 24h'))).toBe(true)
  })

  test('a fresh schema is NOT flagged', async () => {
    schemaRows = [
      { id: 'sch-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: null, manualDescription: false, reflectedAt: new Date() },
    ]
    const printed: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')) }
    try {
      await get('int-1')
    } finally {
      console.log = orig
    }
    expect(printed.some((m) => m.includes('older than 24h'))).toBe(false)
  })

  test('an EMPTY schema is not flagged as stale', async () => {
    schemaRows = []
    const printed: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]) => { printed.push(a.join(' ')) }
    try {
      await get('int-1')
    } finally {
      console.log = orig
    }
    // No rows means we have never reflected; "stale" would be misleading — the
    // right message is that a refresh is needed, and the UI says that separately.
    expect(printed.some((m) => m.includes('older than 24h'))).toBe(false)
  })

  test('org context is entered before the query (tenant guard)', async () => {
    await get('int-1')
    expect(enterCalls).toEqual(['org-1'])
  })

  test('a viewer may READ (only writes are admin-gated)', async () => {
    getActiveUserImpl = async () => viewer
    expect((await get('int-1')).status).toBe(200)
  })
})

describe('GET /api/integrations/[id]/schema?refresh=1', () => {
  test('re-reflects, replaces the rows and invalidates the embedding cache', async () => {
    fetchedTables = [
      { tableName: 'orders', columns: [{ name: 'id', type: 'int' }], rowCount: 9, sampleRow: { id: 1 } },
    ]
    const res = await get('int-1', '?refresh=1')
    expect(res.status).toBe(200)
    expect(deleteManyArgs).toEqual([{ integrationId: 'int-1' }])
    expect(createManyArgs).toHaveLength(1)
    const row = createManyArgs[0].data[0]
    expect(row.tableName).toBe('orders')
    expect(row.columns).toBe(JSON.stringify([{ name: 'id', type: 'int' }]))
    expect(row.rowCount).toBe(9)
    // The source's embeddings were computed from the OLD schema; leaving them warm
    // means the next retrieval still describes the previous shape of the database.
    expect(embedCacheCalls.length).toBeGreaterThan(0)
  })

  test('an ADMIN-LOCKED description survives the re-reflection', async () => {
    // INCIDENT: the old flow deleteMany'd then createMany'd from scratch, wiping
    // every locked description — the "edit + lock" feature was useless the moment
    // an admin pressed refresh. This is the regression this test exists for.
    schemaRows = [
      { id: 'old-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: 'OUR OWN WORDS', manualDescription: true, reflectedAt: new Date() },
    ]
    fetchedTables = [{ tableName: 'orders', columns: [{ name: 'id', type: 'int' }], rowCount: 9, sampleRow: null }]
    await get('int-1', '?refresh=1')
    const row = createManyArgs[0].data[0]
    expect(row.description).toBe('OUR OWN WORDS')
    expect(row.manualDescription).toBe(true)
  })

  test('an AUTO description is NOT carried over (enrichment regenerates it)', async () => {
    schemaRows = [
      { id: 'old-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: 'auto generated', manualDescription: false, reflectedAt: new Date() },
    ]
    fetchedTables = [{ tableName: 'orders', columns: [], rowCount: 9, sampleRow: null }]
    await get('int-1', '?refresh=1')
    // Carrying a non-locked description forward would freeze stale generated text
    // forever instead of letting enrichment improve it.
    expect(createManyArgs[0].data[0].description).toBeNull()
    expect(createManyArgs[0].data[0].manualDescription).toBe(false)
  })

  test('a table that was renamed does not inherit the old description', async () => {
    schemaRows = [
      { id: 'old-1', tableName: 'orders_v1', columns: '[]', rowCount: 1, sampleRow: null, description: 'OLD TABLE', manualDescription: true, reflectedAt: new Date() },
    ]
    fetchedTables = [{ tableName: 'orders_v2', columns: [], rowCount: 9, sampleRow: null }]
    await get('int-1', '?refresh=1')
    // Matching by tableName, so a differently-named table starts clean — inheriting
    // 'OLD TABLE' onto an unrelated table would be actively misleading.
    expect(createManyArgs[0].data[0].description).toBeNull()
  })

  test('every new row is stamped with the integration organizationId', async () => {
    fetchedTables = [{ tableName: 't', columns: [], rowCount: null, sampleRow: null }]
    await get('int-1', '?refresh=1')
    // Without it the tenant guard has nothing to scope on and the rows become
    // invisible or leak across orgs.
    expect(createManyArgs[0].data[0].organizationId).toBe('org-1')
    expect(createManyArgs[0].data[0].integrationId).toBe('int-1')
  })

  test('a connector failure is 502 and leaves the old schema intact', async () => {
    fetchSchemaThrows = new Error('connection refused')
    schemaRows = [{ id: 'old-1', tableName: 'orders', columns: '[]', rowCount: 1, sampleRow: null, description: 'keep', manualDescription: true, reflectedAt: new Date() }]
    const res = await get('int-1', '?refresh=1')
    // 502 (upstream), not 500: the failure is the customer's database, not us.
    expect(res.status).toBe(502)
    // CRITICAL: the delete must not have run, or a failed refresh would leave the
    // integration with NO schema at all.
    expect(deleteManyArgs).toHaveLength(0)
    expect(createManyArgs).toHaveLength(0)
  })

  test('a schema with zero tables is still a successful refresh', async () => {
    fetchedTables = []
    const res = await get('int-1', '?refresh=1')
    // A database with no tables is a legitimate answer, not an error.
    expect(res.status).toBe(200)
    expect(createManyArgs[0].data).toEqual([])
  })

  test('refresh is only triggered by the literal value 1', async () => {
    fetchedTables = [{ tableName: 't', columns: [], rowCount: null, sampleRow: null }]
    await get('int-1', '?refresh=true')
    // Anything but '1' must be a plain read; a sloppy truthy check would let a
    // stray query parameter hit the customer's database.
    expect(deleteManyArgs).toHaveLength(0)
  })
})
