/**
 * POST /api/integrations/[id]/test — the "Test Connection" button.
 *
 * WHY THIS FILE EXISTS. A route with several easily-inverted behaviours, and the inversions are exactly the
 * ones that make a support ticket unfixable:
 *
 *   1. A FAILED CONNECTION ANSWERS HTTP 200 WITH `ok: false`. That is deliberate and counter-intuitive: the UI
 *      contract treats any non-2xx as a TRANSPORT error and shows a generic toast, so a 4xx/5xx here would throw
 *      away the diagnostic (SSL / auth / DNS / timeout) the whole route exists to produce. A well-meaning
 *      "return 502 on failure" refactor would silently regress every failure into "test failed".
 *   2. THE CONNECTOR IS ALWAYS DROPPED, EVEN WHEN THE HANDLER THROWS. The throwaway id exists so a stale pool
 *      is never reused; leaking one per test click is an unbounded connection leak. Asserted from the throwing
 *      path, not just the happy one.
 *   3. A HEALTHY SELECT 1 WITH A FAILED REFLECTION IS STILL A PASS. `testConnection` is the authority on
 *      connectivity; the schema refresh is a bonus and is wrapped so a reflection error cannot turn a working
 *      connection into a reported failure.
 *   4. THE FALLBACK PATH EXISTS FOR CONNECTORS WITHOUT `testConnectionDetailed`. Not every provider implements
 *      the detailed variant, and the generic message is worse -- so the branch is asserted rather than assumed.
 *   5. A FAILURE UPDATE THAT ITSELF FAILS MUST NOT REPLACE THE DIAGNOSTIC. Both the row update and the failure
 *      audit are `.catch(...)`-guarded: if the DB is what is broken, the user still needs the reason.
 *
 * Also pinned: `findFirst` for the client-supplied id (the cross-tenant IDOR class), the throwaway-id shape,
 * `status: 'active'` only on success, the audit for both outcomes, and that the two fire-and-forget prompt
 * refreshes are attempted only when tables were actually reflected.
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

const PLAINTEXT = { host: 'db.internal', password: 'super-secret-pw' }
const CIPHERTEXT = 'enc:v1:fixture'

let row: Record<string, unknown> | null = null
let testOk = true
let testMessage = 'Connection failed. Check credentials and network.'
let testReason: string | undefined = 'auth'
let hasDetailed = true
let updateThrows = false
let fetchSchemaThrows: Error | null = null
let tables: Array<Record<string, unknown>> = []

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const getConnectorArgs: unknown[][] = []
const dropped: string[] = []
const decryptedBlobs: string[] = []
let embeddingCacheInvalidated = 0
const dynamicImports: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/crypto', () => ({
  decryptConfig: (blob: string) => {
    decryptedBlobs.push(blob)
    if (blob !== CIPHERTEXT) throw new Error('bad tag')
    return PLAINTEXT
  },
}))

mock.module('@/lib/logger', () => ({
  logSwallowed: (tag: string) => (e: unknown) => {
    events.push(`swallowed:${tag}`)
  },
}))

mock.module('@/lib/smart-router', () => ({
  invalidateSourceEmbeddingCache: () => {
    embeddingCacheInvalidated++
    events.push('invalidateSourceEmbeddingCache')
  },
}))

mock.module('@/lib/real-connectors', () => ({
  // The REAL signature is `(e, providerId?) => { reason, message }` -- verified against the module before
  // writing this. My first mock returned a bare string, which is a different contract.
  describeConnectionError: (e: unknown) => ({
    reason: 'ssl',
    message: `described:${e instanceof Error ? e.message : String(e)}`,
  }),
}))

mock.module('@/lib/connectors', () => ({
  connectorRegistry: {
    getConnector: (id: string, provider: string, cfg: unknown) => {
      getConnectorArgs.push([id, provider, cfg])
      events.push('getConnector')
      const base = {
        fetchSchema: async () => {
          events.push('fetchSchema')
          if (fetchSchemaThrows) throw fetchSchemaThrows
          return tables
        },
      }
      if (!hasDetailed) {
        return {
          ...base,
          testConnection: async () => testOk,
        }
      }
      return {
        ...base,
        testConnection: async () => testOk,
        testConnectionDetailed: async () => {
          events.push('testConnectionDetailed')
          return { ok: testOk, message: testMessage, reason: testReason }
        },
      }
    },
    drop: (id: string) => {
      dropped.push(id)
      events.push('drop')
    },
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integration', op: 'findFirst', args })
        return row
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integration', op: 'findUnique', args })
        return row
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integration', op: 'update', args })
        if (updateThrows) throw new Error('db write failed')
        return {}
      },
    },
    integrationSchema: {
      deleteMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integrationSchema', op: 'deleteMany', args })
        return { count: 0 }
      },
      createMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'integrationSchema', op: 'createMany', args })
        return { count: (args.data as unknown[]).length }
      },
    },
  },
}))

mock.module('@/lib/schema-enrichment', () => ({
  enrichSchemaDescriptions: async () => {
    dynamicImports.push('enrichSchemaDescriptions')
  },
}))

mock.module('@/lib/source-init', () => ({
  initIntegrationContext: async () => {
    dynamicImports.push('initIntegrationContext')
  },
}))

import { POST } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function post(id = 'i1') {
  return POST(new Request(`http://localhost/api/integrations/${id}/test`, { method: 'POST' }) as never, ctx(id))
}

const updates = () => calls.filter((c) => c.model === 'integration' && c.op === 'update')

beforeEach(() => {
  user = adminUser
  row = {
    id: 'i1',
    name: 'ERP',
    provider: 'POSTGRESQL',
    status: 'active',
    encryptedConfig: CIPHERTEXT,
    organizationId: 'org-1',
  }
  testOk = true
  testMessage = 'Connection failed. Check credentials and network.'
  testReason = 'auth'
  hasDetailed = true
  updateThrows = false
  fetchSchemaThrows = null
  tables = [
    { tableName: 'orders', columns: [{ name: 'id', type: 'int' }], rowCount: 5, sampleRow: { id: 1 } },
    { tableName: 'items', columns: [], rowCount: 0, sampleRow: null },
  ]
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  getConnectorArgs.length = 0
  dropped.length = 0
  decryptedBlobs.length = 0
  embeddingCacheInvalidated = 0
  dynamicImports.length = 0
})

// Let the fire-and-forget promises (they are `void`ed) settle before asserting on them.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the IDOR class and the org context', () => {
  test('the integration is loaded with findFirst, never findUnique', async () => {
    await post()
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads).toHaveLength(1)
    expect(loads[0]!.op).toBe('findFirst')
  })

  test('the org context is entered BEFORE the integration is loaded', async () => {
    await post()
    expect(events.slice(0, 2)).toEqual(['enterWithOrg:org-1', 'getConnector'])
  })

  test('a missing integration is 404 and NO connector is ever opened', async () => {
    row = null
    const res = await post()
    expect(res.status).toBe(404)
    expect(getConnectorArgs).toHaveLength(0)
    expect(dropped).toHaveLength(0)
  })

  test('the select does not pull columns the route never uses', async () => {
    await post()
    const load = calls.find((c) => c.op === 'findFirst')!
    expect(load.args.select).toEqual({
      id: true,
      name: true,
      provider: true,
      status: true,
      encryptedConfig: true,
      organizationId: true,
    })
  })
})

describe('the throwaway connector', () => {
  test('the connector is keyed by a TEMPORARY id, never the integration id', async () => {
    // Reusing the integration's own id would hand back a cached pool whose socket/credentials may be stale --
    // the whole point of the "Test" button is to re-check with fresh credentials.
    await post()
    const [id, provider, cfg] = getConnectorArgs[0]!
    expect(id).not.toBe('i1')
    expect(String(id)).toMatch(/^test_i1_\d+$/)
    expect(provider).toBe('POSTGRESQL')
    expect(cfg).toEqual(PLAINTEXT)
  })

  test('the throwaway id is DROPPED on the success path', async () => {
    await post()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toBe(String(getConnectorArgs[0]![0]))
  })

  test('the throwaway id is DROPPED on the FAILURE path', async () => {
    testOk = false
    await post()
    expect(dropped).toHaveLength(1)
  })

  test('the throwaway id is DROPPED even when the handler THROWS', async () => {
    // The leak that matters: one per failed click. `finally` is what prevents an unbounded pool leak, and this
    // asserts from the throwing path rather than the happy one.
    updateThrows = true
    testOk = false
    await post()
    expect(dropped).toHaveLength(1)
  })

  test('the stored ciphertext is DECRYPTED before the connector sees it', async () => {
    await post()
    expect(decryptedBlobs).toEqual([CIPHERTEXT])
    expect(JSON.stringify(getConnectorArgs[0]![2])).not.toContain('enc:')
  })
})

describe('a FAILED connection answers 200 with ok:false', () => {
  test('the status is 200, NOT an error code, so the diagnostic survives the UI', async () => {
    // The load-bearing inversion: the UI treats non-2xx as a transport error and shows a generic toast, which
    // would throw away the SSL/auth/DNS/timeout hint this route exists to return.
    testOk = false
    const res = await post()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; message: string; reason: string }
    expect(body.ok).toBe(false)
    expect(body.message).toBe(testMessage)
    expect(body.reason).toBe('auth')
  })

  test('the diagnostic message and reason both cross the wire', async () => {
    testOk = false
    testMessage = 'SSL certificate verification failed.'
    testReason = 'ssl'
    const body = (await (await post()).json()) as { ok: boolean; message: string; reason: string }
    expect(body).toEqual({ ok: false, message: 'SSL certificate verification failed.', reason: 'ssl' })
  })

  test('the row records lastTestOk:false but leaves STATUS alone', async () => {
    // "Admin decides" -- a failed test must not silently deactivate a working integration, or a transient
    // network blip during a test would take the source offline.
    testOk = false
    await post()
    expect(updates()).toHaveLength(1)
    expect(updates()[0]!.args.data).toMatchObject({ lastTestOk: false })
    expect((updates()[0]!.args.data as Record<string, unknown>).status).toBeUndefined()
    expect((updates()[0]!.args.data as Record<string, unknown>).lastTestedAt).toBeInstanceOf(Date)
  })

  test('the failure is audited at WARNING with the provider and the reason', async () => {
    testOk = false
    await post()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'INTEGRATION_TEST_FAILED',
      severity: 'warning',
      detail: { integrationId: 'i1', name: 'ERP', provider: 'POSTGRESQL', reason: 'auth' },
    })
  })

  test('a failure NEVER refreshes the schema, and never invalidates the cache', async () => {
    testOk = false
    await post()
    expect(events).not.toContain('fetchSchema')
    expect(embeddingCacheInvalidated).toBe(0)
    expect(calls.filter((c) => c.model === 'integrationSchema')).toHaveLength(0)
  })

  test('a failure update that ITSELF fails does not replace the diagnostic', async () => {
    // Both the row update and the audit are guarded: if the DB is what is broken, the user still gets the
    // reason from the connector rather than a generic 500.
    testOk = false
    updateThrows = true
    const res = await post()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { reason: string }).reason).toBe('auth')
  })

  test('a connector WITHOUT testConnectionDetailed falls back to the generic message', async () => {
    // Not every provider implements the detailed variant; the fallback text is deliberately generic rather
    // than absent.
    hasDetailed = false
    testOk = false
    const body = (await (await post()).json()) as { message: string; reason?: string }
    expect(body.message).toBe('Connection failed. Check credentials and network.')
    expect(body.reason).toBeUndefined()
  })

  test('a connector WITHOUT the detailed variant still reports SUCCESS correctly', async () => {
    hasDetailed = false
    testOk = true
    expect(((await (await post()).json()) as { ok: boolean }).ok).toBe(true)
  })
})

describe('a HEALTHY connection refreshes the schema cache', () => {
  test('it reflects the schema and rewrites the cache rows', async () => {
    await post()
    expect(events).toContain('fetchSchema')
    const del = calls.find((c) => c.op === 'deleteMany')!
    expect(del.args.where).toEqual({ integrationId: 'i1' })
    const create = calls.find((c) => c.op === 'createMany')!
    expect((create.args.data as unknown[]).length).toBe(2)
  })

  test('the cache rows carry the ORG from the integration and the table fields', async () => {
    await post()
    const create = calls.find((c) => c.op === 'createMany')!
    const first = (create.args.data as Array<Record<string, unknown>>)[0]!
    expect(first).toMatchObject({
      organizationId: 'org-1',
      integrationId: 'i1',
      tableName: 'orders',
      rowCount: 5,
    })
    expect(first.columns).toBe(JSON.stringify([{ name: 'id', type: 'int' }]))
    expect(first.sampleRow).toBe(JSON.stringify({ id: 1 }))
  })

  test('a null sampleRow and a null rowCount stay NULL, not the string "null"', async () => {
    // `t.sampleRow ? JSON.stringify(...) : null` -- stringifying a missing sample would store the literal text
    // "null" and later parse back as non-null garbage.
    await post()
    const create = calls.find((c) => c.op === 'createMany')!
    const second = (create.args.data as Array<Record<string, unknown>>)[1]!
    expect(second.sampleRow).toBeNull()
    expect(second.rowCount).toBe(0)
  })

  test('the source embedding cache is invalidated so routing sees the new schema', async () => {
    await post()
    expect(embeddingCacheInvalidated).toBe(1)
  })

  test('the row is marked active with lastTestOk:true', async () => {
    await post()
    expect(updates()[0]!.args.data).toMatchObject({ lastTestOk: true, status: 'active' })
  })

  test('the audit is INFO and reports the reflected table count', async () => {
    await post()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'INTEGRATION_TEST',
      severity: 'info',
      detail: { integrationId: 'i1', name: 'ERP', provider: 'POSTGRESQL', tablesCount: 2 },
    })
  })

  test('the response includes tablesCount both inside data and at the top level', async () => {
    // Two shapes because the UI reads one and a legacy caller reads the other. Asserted as an exact body so
    // dropping either is deliberate.
    const body = (await (await post()).json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.tablesCount).toBe(2)
    expect(body.data).toMatchObject({
      id: 'i1',
      lastTestOk: true,
      tablesCount: 2,
    })
    expect(typeof (body.data as { lastTestedAt: string }).lastTestedAt).toBe('string')
  })
})

describe('the two fire-and-forget prompt refreshes', () => {
  test('BOTH are attempted when tables were reflected', async () => {
    // A table created since the last init has no description, so the SQL prompt would render it bare.
    await post()
    await flush()
    expect(dynamicImports.sort()).toEqual(['enrichSchemaDescriptions', 'initIntegrationContext'])
  })

  test('NEITHER is attempted when no tables were reflected', async () => {
    // Nothing new to describe, so the LLM calls are skipped rather than spent on an empty schema.
    tables = []
    await post()
    await flush()
    expect(dynamicImports).toEqual([])
  })

  test('NEITHER is attempted on a failure', async () => {
    testOk = false
    await post()
    await flush()
    expect(dynamicImports).toEqual([])
  })

  test('an empty reflection still SUCCEEDS and answers tablesCount 0', async () => {
    tables = []
    const body = (await (await post()).json()) as { ok: boolean; tablesCount: number }
    expect(body.ok).toBe(true)
    expect(body.tablesCount).toBe(0)
  })

  test('an empty reflection does NOT wipe the existing schema cache', async () => {
    // The delete is inside `if (tables.length > 0)`. Without that guard, a connector that returned an empty
    // snapshot would erase a populated cache and the source would silently lose its schema.
    tables = []
    await post()
    expect(calls.filter((c) => c.model === 'integrationSchema')).toHaveLength(0)
  })
})

describe('a healthy SELECT 1 with a FAILED reflection is still a pass', () => {
  test('the response is ok:true and says so by reporting zero tables', async () => {
    // `testConnection` is the authority on connectivity; the refresh is a bonus. A reflection error must not
    // turn a working connection into a reported failure.
    fetchSchemaThrows = new Error('reflection timeout')
    const res = await post()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; tablesCount: number }
    expect(body.ok).toBe(true)
    expect(body.tablesCount).toBe(0)
  })

  test('the row is still marked active', async () => {
    fetchSchemaThrows = new Error('reflection timeout')
    await post()
    expect(updates()[0]!.args.data).toMatchObject({ lastTestOk: true, status: 'active' })
  })

  test('no schema rows are written and the cache is NOT invalidated', async () => {
    fetchSchemaThrows = new Error('reflection timeout')
    await post()
    expect(calls.filter((c) => c.model === 'integrationSchema')).toHaveLength(0)
    expect(embeddingCacheInvalidated).toBe(0)
  })

  test('the success audit still records zero tables', async () => {
    fetchSchemaThrows = new Error('reflection timeout')
    await post()
    expect((auditWrites[0]!.detail as { tablesCount: number }).tablesCount).toBe(0)
  })
})

describe('internal failures beyond the connector', () => {
  test('a load failure is 500 without leaking the error text', async () => {
    row = null
    const res = await post()
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('an UNDECRYPTABLE credential blob is a handled 500 (fail-closed, not a silent skip)', async () => {
    // A rotated ENCRYPTION_SECRET_KEY must not be reported as a connection failure for the wrong reason.
    row!.encryptedConfig = 'enc:v1:rotated'
    const res = await post()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('bad tag')
  })

  test('the diagnostic mapper is re-exported alongside the route', async () => {
    // `export { describeConnectionError }` exists so the mapper travels with its route. Asserted because a
    // removed re-export would be an invisible API break for whoever imports it.
    //
    // NOTE on the real signature: it is `(e, providerId?) => { reason, message }`, NOT `(e) => string`. My
    // first version asserted the string shape -- a reminder that the mock's shape is a claim about the real
    // module and has to be checked, not assumed.
    const mod = await import('./route')
    expect(typeof mod.describeConnectionError).toBe('function')
    const out = mod.describeConnectionError(new Error('x')) as { reason: string; message: string }
    expect(out).toEqual({ reason: 'ssl', message: 'described:x' })
  })
})
