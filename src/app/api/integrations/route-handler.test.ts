import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// POST /api/integrations — the database-connection creation path.
//
// A separate file from route.test.ts, which imports ONLY the pure validator and
// has no mocks. Keeping that file pure lets it prove the validation contract
// without a module graph; this file owns the mocks for the handler itself.
//
// Ordering in this handler is load-bearing and is what most of these tests pin:
// quota is checked BEFORE the connection test, and the connection test runs
// BEFORE the row is written.
// ---------------------------------------------------------------------------
const state = {
  count: 0,
  quota: { allowed: true, limit: 5, current: 0 } as any,
  testDetailed: { ok: true, message: 'ok' } as any,
  hasDetailed: true,
  testThrows: false,
  fetchSchemaThrows: false,
  tables: [] as any[],
  created: [] as any[],
  schemaCreateMany: [] as any[],
  schemaDeleteMany: [] as any[],
  updates: [] as any[],
  audits: [] as any[],
  drops: [] as string[],
  getConnectorCalls: [] as any[],
  listRows: [] as any[],
  roleThrows: null as Error | null,
  user: { userId: 'u1', organizationId: 'org-1', plan: 'flat', role: 'admin' } as any,
  enrichCalls: 0,
  invalidateCalls: 0,
}

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      count: async () => state.count,
      // The route's `select` includes `_count: { select: { schemas: true } }` and
      // maps it, so a fake returning bare rows makes the handler throw — that was
      // this double's bug, not the route's.
      findMany: async () => state.listRows.map((r) => ({ _count: { schemas: 0 }, ...r })),
      create: async (a: any) => {
        state.created.push(a)
        return { id: 'int-1', name: a.data.name, ...a.data }
      },
      update: async (a: any) => { state.updates.push(a); return {} },
    },
    integrationSchema: {
      deleteMany: async (a: any) => { state.schemaDeleteMany.push(a); return {} },
      createMany: async (a: any) => { state.schemaCreateMany.push(a); return { count: a.data.length } },
    },
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => state.user,
  requireRole: () => { if (state.roleThrows) throw state.roleThrows },
  writeAudit: async (a: any) => { state.audits.push(a) },
  handleApiError: (e: any, fallback: string) => ({
    // Mirrors the real shape: status derived from the error, message from it too.
    status: (e as any)?.statusCode ?? 500,
    json: async () => ({ error: { message: (e as any)?.message ?? fallback } }),
  }),
}))
mock.module('@/lib/crypto', () => ({
  // The real AES-256-GCM output does not contain the plaintext. A pass-through
  // fake that stringifies the config would make the "never stored plain" test
  // fail for a reason that exists only in the double, so this fake OPACIFIES too
  // (base64 of a marker), which is what makes the assertion meaningful.
  encryptConfig: (c: any) => `enc:v1:${Buffer.from(JSON.stringify(Object.keys(c))).toString('base64')}`,
}))
mock.module('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: (id: string, provider: string, config: any) => {
      state.getConnectorCalls.push({ id, provider, config })
      return {
        testConnectionDetailed: state.hasDetailed
          ? async () => {
              if (state.testThrows) throw new Error('ECONNREFUSED 10.0.0.1:5432')
              return state.testDetailed
            }
          : undefined,
        testConnection: async () => state.testDetailed.ok,
        fetchSchema: async () => {
          if (state.fetchSchemaThrows) throw new Error('permission denied for schema public')
          return state.tables
        },
      }
    },
    drop: (id: string) => { state.drops.push(id) },
  },
}))
mock.module('@/lib/schema-enrichment', () => ({
  enrichSchemaDescriptions: async () => { state.enrichCalls++; return {} },
}))
mock.module('@/lib/smart-router', () => ({
  invalidateSourceEmbeddingCache: () => { state.invalidateCalls++ },
}))
mock.module('@/lib/logger', () => ({
  logSwallowed: () => () => {},
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => {},
  bypassOrg: (fn: () => unknown) => fn(),
}))
mock.module('@/lib/plan-gating', () => ({
  checkQuota: () => state.quota,
  quotaExceededMessage: (k: string, q: any) => `Quota exceeded: ${k} (${q.limit})`,
}))

import { POST, GET } from './route'

const body = (over: Record<string, unknown> = {}) => ({
  name: 'Analytics', type: 'DATABASE', provider: 'POSTGRESQL',
  config: { host: 'db.internal', port: 5432, database: 'app', user: 'ro', password: 'pw' },
  ...over,
})

const post = (b: unknown) =>
  POST({ json: async () => b } as any) as unknown as Promise<{ status: number; json: () => Promise<any> }>

beforeEach(() => {
  state.count = 0
  state.quota = { allowed: true, limit: 5, current: 0 }
  state.testDetailed = { ok: true, message: 'ok' }
  state.hasDetailed = true
  state.testThrows = false
  state.fetchSchemaThrows = false
  state.tables = []
  state.created = []
  state.schemaCreateMany = []
  state.schemaDeleteMany = []
  state.updates = []
  state.audits = []
  state.drops = []
  state.getConnectorCalls = []
  state.listRows = []
  state.roleThrows = null
  state.user = { userId: 'u1', organizationId: 'org-1', plan: 'flat', role: 'admin' }
  state.enrichCalls = 0
  state.invalidateCalls = 0
})

describe('POST /api/integrations — happy path', () => {
  test('creates the integration and reports the reflected table count', async () => {
    state.tables = [{ tableName: 'orders', columns: [{ name: 'id', type: 'int' }], rowCount: 3 }]
    const res = await post(body())
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.tableCount).toBe(1)
  })

  test('the config is ENCRYPTED before persisting, never stored plain', async () => {
    await post(body())
    const stored = state.created[0].data.encryptedConfig
    expect(stored).toContain('enc:')
    // The plaintext password must not survive into the stored column.
    expect(stored).not.toContain('pw')
    expect(stored).not.toContain('db.internal')
    // And the raw config object must never be stored by reference.
    expect(stored).not.toBe(body().config)
  })

  test('the row is scoped to the calling org', async () => {
    await post(body())
    expect(state.created[0].data.organizationId).toBe('org-1')
  })

  test('the create is audited', async () => {
    await post(body())
    expect(state.audits.some((a) => a.action === 'INTEGRATION_CREATE')).toBe(true)
  })

  test('the temp connector is always dropped, on success too', async () => {
    await post(body())
    // A leaked registry entry holds a live pool.
    expect(state.drops.some((d) => d.startsWith('temp_'))).toBe(true)
  })
})

describe('POST /api/integrations — ordering is the contract', () => {
  test('QUOTA is checked BEFORE the connection test', async () => {
    state.quota = { allowed: false, limit: 0, current: 0 }
    const res = await post(body())
    expect(res.status).toBe(402)
    // The real point: no round-trip to the customer DB was attempted, so a plan
    // ceiling cannot masquerade as "Connection failed".
    expect(state.getConnectorCalls).toHaveLength(0)
    expect(state.created).toHaveLength(0)
  })

  test('a plan refusal is 402 with QUOTA_EXCEEDED, not a generic 400', async () => {
    state.quota = { allowed: false, limit: 0, current: 0 }
    const json = await (await post(body())).json()
    expect(json.code).toBe('QUOTA_EXCEEDED')
  })

  test('the connection is tested BEFORE the row is written', async () => {
    state.testDetailed = { ok: false, message: 'password authentication failed', reason: 'auth' }
    const res = await post(body())
    expect(res.status).toBe(400)
    // No orphan row when the connection never worked.
    expect(state.created).toHaveLength(0)
  })
})

describe('POST /api/integrations — connection failures', () => {
  test('a classified reason reaches the client (not one opaque string)', async () => {
    state.testDetailed = { ok: false, message: 'certificate verify failed', reason: 'ssl' }
    const json = await (await post(body())).json()
    // Wrong password vs TLS mismatch vs blocked IP must not collapse together.
    expect(json.reason).toBe('ssl')
    expect(json.error).toContain('certificate')
  })

  test('a thrown connection error does NOT leak driver detail to the client', async () => {
    state.testThrows = true
    const json = await (await post(body())).json()
    // The thrown message names a host; the client must see the generic string.
    expect(JSON.stringify(json)).not.toContain('10.0.0.1')
    expect(json.error).toBe('Connection failed. Check credentials and network.')
  })

  test('a schema reflection failure creates no row and no schema cache', async () => {
    state.fetchSchemaThrows = true
    const res = await post(body())
    expect(res.status).toBe(400)
    expect(state.created).toHaveLength(0)
    expect(state.schemaCreateMany).toHaveLength(0)
  })

  test('the temp connector is dropped on every failure path', async () => {
    state.testThrows = true
    await post(body())
    expect(state.drops.some((d) => d.startsWith('temp_'))).toBe(true)
  })
})

describe('POST /api/integrations — schema caching', () => {
  test('reflected tables are cached and the statement cache invalidated', async () => {
    state.tables = [
      { tableName: 'a', columns: [{ name: 'x', type: 'int' }], rowCount: 1, sampleRow: { x: 1 } },
      { tableName: 'b', columns: [], rowCount: null },
    ]
    await post(body())
    expect(state.schemaCreateMany[0].data).toHaveLength(2)
    // Without the invalidation the router keeps scoring against a stale schema.
    expect(state.invalidateCalls).toBeGreaterThan(0)
  })

  test('columns and sampleRow are stored as JSON strings', async () => {
    state.tables = [{ tableName: 'a', columns: [{ name: 'x', type: 'int' }], sampleRow: { x: 1 } }]
    await post(body())
    const row = state.schemaCreateMany[0].data[0]
    expect(typeof row.columns).toBe('string')
    expect(typeof row.sampleRow).toBe('string')
  })

  test('a table with no sample row stores null, not "null"', async () => {
    state.tables = [{ tableName: 'a', columns: [], sampleRow: null }]
    await post(body())
    expect(state.schemaCreateMany[0].data[0].sampleRow).toBeNull()
  })

  test('zero reflected tables still succeeds without writing a schema cache', async () => {
    state.tables = []
    const res = await post(body())
    expect(res.status).toBe(201)
    expect(state.schemaCreateMany).toHaveLength(0)
  })

  test('the integration is marked tested and OK after success', async () => {
    await post(body())
    expect(state.updates[0].data.lastTestOk).toBe(true)
    expect(state.updates[0].data.lastTestedAt).toBeInstanceOf(Date)
  })
})

describe('POST /api/integrations — input validation', () => {
  test('a REST provider is refused with a pointer to the right endpoint', async () => {
    const res = await post(body({ type: 'API', provider: 'REST_API' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('/api/data-sources/rest-connectors')
  })

  test('an empty name is refused', async () => {
    expect((await post(body({ name: '   ' }))).status).toBe(400)
  })

  test('an unknown provider is refused and the allowed set is listed', async () => {
    const json = await (await post(body({ provider: 'ORACLE' }))).json()
    expect(json.error).toContain('POSTGRESQL')
    expect(json.error).toContain('Options')
  })

  test('every allow-listed database provider is accepted', async () => {
    for (const provider of ['POSTGRESQL', 'MYSQL', 'MSSQL', 'CLICKHOUSE', 'SUPABASE', 'NEON', 'PLANETSCALE', 'TIDB', 'COCKROACHDB']) {
      state.created = []
      const res = await post(body({ provider }))
      expect(state.created).toHaveLength(1)
      expect(res.status).toBe(201)
    }
  })

  test('a body that is not JSON at all is treated as empty and refused', async () => {
    const res = await POST({ json: async () => { throw new Error('bad json') } } as any) as unknown as { status: number }
    // The handler must not 500 on a malformed body.
    expect(res.status).toBe(400)
  })

  test('a non-admin caller is refused', async () => {
    state.roleThrows = Object.assign(new Error('Insufficient permissions.'), { statusCode: 403 })
    const res = await post(body())
    expect(res.status).toBe(403)
    expect(state.created).toHaveLength(0)
  })
})

describe('GET /api/integrations', () => {
  test('lists integrations without exposing the encrypted config', async () => {
    state.listRows = [{ id: 'i1', name: 'A', type: 'DATABASE', provider: 'POSTGRESQL', status: 'active' }]
    const res = await GET({} as any) as unknown as { status: number; json: () => Promise<any> }
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.data ?? json).toBeDefined()
    // A config column in the payload would hand every credential to the browser.
    expect(JSON.stringify(json)).not.toContain('encryptedConfig')
  })
})
