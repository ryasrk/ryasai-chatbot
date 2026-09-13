/**
 * GET + POST /api/cognee — health, stats, config, and four destructive/maintenance actions.
 *
 * WHY THIS FILE EXISTS. Every action here either wipes the knowledge graph, spends the customer's LLM budget, or
 * re-points where org data is stored. Four behaviours carry the real risk:
 *
 *   1. THE PURGE HAPPENS BEFORE THE DISABLE IS PERSISTED. `forgetKnowledgeGraph()` short-circuits on
 *      `isCogneeEnabled()`, so the previous "write disabled config, then fire-and-forget the purge" order meant
 *      the graph was NEVER deleted -- it simply stopped being read and came back intact on re-enable. The
 *      ordering is the fix, and it is invisible in the API response (which reports `purged: true` either way).
 *   2. `dbUrl` MUST PARSE AS POSTGRES, NOT MERELY BE TRUTHY. It is a credential-bearing connection string the
 *      server dials, so `file://`, `mysql://`, and a URL without a host are all refused. An EMPTY string CLEARS
 *      it, which is a legitimate action and must not be confused with a missing field.
 *   3. `dbUrl` IS REQUIRED WHEN `dbProvider` IS postgres. Persisting `postgres` with no URL leaves cognee
 *      pointing at nothing, and the failure surfaces much later.
 *   4. EVERY ACTION IS ADMIN-ONLY, and the role check runs BEFORE the body is even read.
 *
 * Also pinned: the four branch paths (disable-purge, enable-autocognify, store-change-forget+recognify, and the
 * no-op), the numeric clamps, that the audit records `dbUrlSet` as a BOOLEAN (never the connection string), the
 * `recognify` document filter, and that an unknown action is 400.
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

const PG_URL = 'postgresql://cognee:pg-secret@db.internal:5432/cognee'

let config: Record<string, unknown> | null = null
let statsThrows: Error | null = null
let resetResult = true
let forgetResult = true
let forgetThrows: Error | null = null
let documents: Array<Record<string, unknown>> = []
let cognifyResult: Record<string, unknown> = { processed: 2, failed: 0, skipped: 0 }

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const roleChecks: Array<{ role: string; required: string }> = []
let invalidated = 0
let autoCognifyCalls = 0
let forgetCalls = 0

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    roleChecks.push({ role: String(u?.role), required })
    if (!u || u.role !== 'admin') {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/cognee', () => ({
  cogneeStats: async () => {
    events.push('cogneeStats')
    if (statsThrows) throw statsThrows
    return { enabled: true, datasets: 2, memories: 10, knowledgeNodes: 5 }
  },
  resetCognee: async () => {
    events.push('resetCognee')
    return resetResult
  },
  cognifyBatch: async (input: { documents: unknown[] }) => {
    events.push('cognifyBatch')
    return cognifyResult
  },
  forgetKnowledgeGraph: async () => {
    forgetCalls++
    events.push('forgetKnowledgeGraph')
    if (forgetThrows) throw forgetThrows
    return forgetResult
  },
  invalidateCogneeSettings: () => {
    invalidated++
    events.push('invalidateCogneeSettings')
  },
  autoCognifyAll: async () => {
    autoCognifyCalls++
    events.push('autoCognifyAll')
    return null
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async (args: Record<string, unknown> = {}) => {
        calls.push({ model: 'appConfig', op: 'findFirst', args })
        return config
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'appConfig', op: 'update', args })
        events.push('appConfig.update')
        return { ...config, ...(args.data as Record<string, unknown>) }
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'appConfig', op: 'create', args })
        events.push('appConfig.create')
        return args.data
      },
    },
    document: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'document', op: 'findMany', args })
        return documents
      },
    },
  },
}))

import { GET, POST } from './route'

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/cognee', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const updateData = () =>
  (calls.find((c) => c.op === 'update')?.args.data as Record<string, unknown>) ?? null
const createData = () =>
  (calls.find((c) => c.op === 'create')?.args.data as Record<string, unknown>) ?? null

const BASE_CONFIG = {
  id: 'c1',
  cogneeEnabled: false,
  cogneeDbProvider: 'local',
  cogneeDbUrl: null as string | null,
  cogneeBatchSize: 50,
  cogneeMaxRetries: 3,
}

beforeEach(() => {
  user = adminUser
  // A row must EXIST or the route takes the create branch and there is no `update` to inspect -- which is what
  // broke six of these tests the first time round. The create branch gets its own explicit tests.
  config = { ...BASE_CONFIG }
  statsThrows = null
  resetResult = true
  forgetResult = true
  forgetThrows = null
  documents = []
  cognifyResult = { processed: 2, failed: 0, skipped: 0 }
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  roleChecks.length = 0
  invalidated = 0
  autoCognifyCalls = 0
  forgetCalls = 0
})

describe('GET', () => {
  test('it merges the stats with the config for the UI', async () => {
    config = {
      id: 'c1',
      cogneeEnabled: true,
      cogneeDbProvider: 'postgres',
      cogneeDbUrl: PG_URL,
      cogneeBatchSize: 100,
      cogneeMaxRetries: 5,
    }
    const body = (await (await GET()).json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.data).toMatchObject({
      enabled: true,
      datasets: 2,
      memories: 10,
      knowledgeNodes: 5,
      config: {
        enabled: true,
        dbProvider: 'postgres',
        dbUrl: PG_URL,
        batchSize: 100,
        maxRetries: 5,
      },
    })
  })

  test('the config falls back to local defaults when a row exists without a provider', async () => {
    config = { id: 'c1', cogneeEnabled: false, cogneeBatchSize: 50, cogneeMaxRetries: 3 }
    const body = (await (await GET()).json()) as { data: { config: Record<string, unknown> } }
    expect(body.data.config).toMatchObject({ enabled: false, dbProvider: 'local', dbUrl: '' })
  })

  test('with NO config row the config is null, not a fabricated default set', async () => {
    // Pinned as-is: the UI distinguishes "not configured" from "configured with defaults".
    config = null
    const body = (await (await GET()).json()) as { data: { config: unknown } }
    expect(body.data.config).toBeNull()
  })

  test('GET enters the org context (the config row is per-org)', async () => {
    await GET()
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('a stats failure is 500 without leaking the error text', async () => {
    statsThrows = new Error('cognee unreachable')
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('cognee unreachable')
  })
})

describe('POST is admin-only and the check precedes the body read', () => {
  test('a viewer gets 403 with NO action performed', async () => {
    user = { ...adminUser, role: 'viewer' }
    const res = await post({ action: 'reset' })
    expect(res.status).toBe(403)
    expect(events).not.toContain('resetCognee')
    expect(auditWrites).toHaveLength(0)
    expect(calls.filter((c) => c.model === 'appConfig')).toHaveLength(0)
  })

  test('an analyst is refused too', async () => {
    user = { ...adminUser, role: 'analyst' }
    expect((await post({ action: 'forget_kb' })).status).toBe(403)
  })

  test('the required role is admin', async () => {
    await post({ action: 'reset' })
    expect(roleChecks).toEqual([{ role: 'admin', required: 'admin' }])
  })

  test('the role check happens before any config read', async () => {
    user = { ...adminUser, role: 'viewer' }
    await post({ action: 'update_config', enabled: true })
    expect(calls).toHaveLength(0)
  })
})

describe('update_config — dbUrl validation', () => {
  test('a non-postgres scheme is refused with 400', async () => {
    const res = await post({ action: 'update_config', dbProvider: 'postgres', dbUrl: 'mysql://u:p@h/db' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'dbUrl must use the postgres:// or postgresql:// scheme.',
    )
    expect(calls.filter((c) => c.op === 'update' || c.op === 'create')).toHaveLength(0)
  })

  test('a FILE url is refused', async () => {
    const res = await post({ action: 'update_config', dbProvider: 'postgres', dbUrl: 'file:///etc/passwd' })
    expect(res.status).toBe(400)
  })

  test('an unparseable string is refused as not a URL', async () => {
    const res = await post({ action: 'update_config', dbUrl: 'not a url' })
    expect(((await res.json()) as { error: string }).error).toBe('dbUrl is not a valid URL.')
  })

  test('a non-string dbUrl is refused', async () => {
    const res = await post({ action: 'update_config', dbUrl: 42 })
    expect(((await res.json()) as { error: string }).error).toBe('dbUrl must be a string.')
  })

  test('a postgres URL WITHOUT a host is refused', async () => {
    // `postgres:///db` parses as a URL with an empty hostname; dialling it would fail opaquely later.
    const res = await post({ action: 'update_config', dbProvider: 'postgres', dbUrl: 'postgres:///cognee' })
    expect(((await res.json()) as { error: string }).error).toBe('dbUrl is missing a host.')
  })

  test('dbProvider postgres WITHOUT a dbUrl is refused', async () => {
    const res = await post({ action: 'update_config', enabled: true, dbProvider: 'postgres' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('dbUrl is required when dbProvider is postgres.')
  })

  test('an EMPTY dbUrl CLEARS the value rather than being treated as missing', async () => {
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: PG_URL }
    await post({ action: 'update_config', dbProvider: 'local', dbUrl: '' })
    expect(updateData()).toMatchObject({ cogneeDbUrl: null })
  })

  test('a WHITESPACE-only dbUrl also clears the value', async () => {
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: PG_URL }
    await post({ action: 'update_config', dbProvider: 'local', dbUrl: '   ' })
    expect(updateData()).toMatchObject({ cogneeDbUrl: null })
  })

  test('an ABSENT dbUrl also clears the value (the UI sends the whole form)', async () => {
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: PG_URL }
    await post({ action: 'update_config', dbProvider: 'local' })
    expect(updateData()).toMatchObject({ cogneeDbUrl: null })
  })

  test('the stored URL is TRIMMED', async () => {
    await post({ action: 'update_config', dbProvider: 'postgres', dbUrl: `  ${PG_URL}  ` })
    expect(updateData()).toMatchObject({ cogneeDbUrl: PG_URL })
  })

  test('a postgresql:// scheme is accepted as well as postgres://', async () => {
    await post({ action: 'update_config', dbProvider: 'postgres', dbUrl: 'postgres://u:p@h:5432/d' })
    expect(updateData()).toMatchObject({ cogneeDbUrl: 'postgres://u:p@h:5432/d' })
  })

  test('an unrecognised dbProvider falls back to local instead of being stored verbatim', async () => {
    await post({ action: 'update_config', dbProvider: 'weaviate' })
    expect(updateData()).toMatchObject({ cogneeDbProvider: 'local' })
  })
})

describe('update_config — numeric clamps', () => {
  test('batchSize is clamped to [1, 500] and defaults to 50', async () => {
    await post({ action: 'update_config', batchSize: 9999 })
    expect(updateData()).toMatchObject({ cogneeBatchSize: 500 })
    await post({ action: 'update_config', batchSize: 1 })
    expect(calls.filter((c) => c.op === 'update')[1]!.args.data).toMatchObject({ cogneeBatchSize: 1 })
    await post({ action: 'update_config' })
    expect(calls.filter((c) => c.op === 'update')[2]!.args.data).toMatchObject({ cogneeBatchSize: 50 })
  })

  test('batchSize 0 becomes 50, NOT 1 -- 0 is falsy so the default wins before the clamp', async () => {
    // `Math.max(1, Math.min(500, parseInt(batchSize) || 50))`: `parseInt('0') || 50` is 50, so the `Math.max(1,
    // ...)` floor never gets a chance to act. Found by running the clamp rather than reading it -- my first
    // version asserted 1.
    await post({ action: 'update_config', batchSize: 0 })
    expect(updateData()).toMatchObject({ cogneeBatchSize: 50 })
  })

  test('maxRetries is clamped to [0, 10] and defaults to 3', async () => {
    // A floor of 0 is valid here (unlike batchSize) -- zero retries is a legitimate choice.
    await post({ action: 'update_config', maxRetries: 99 })
    expect(updateData()).toMatchObject({ cogneeMaxRetries: 10 })
    await post({ action: 'update_config', maxRetries: -5 })
    expect(calls.filter((c) => c.op === 'update')[1]!.args.data).toMatchObject({ cogneeMaxRetries: 0 })
    await post({ action: 'update_config' })
    expect(calls.filter((c) => c.op === 'update')[2]!.args.data).toMatchObject({ cogneeMaxRetries: 3 })
  })

  test('a non-numeric batchSize falls back to the default rather than NaN', async () => {
    await post({ action: 'update_config', batchSize: 'lots' })
    expect(updateData()).toMatchObject({ cogneeBatchSize: 50 })
  })
})

describe('update_config — the purge ordering', () => {
  test('DISABLING purges the graph BEFORE the config is written', async () => {
    // `forgetKnowledgeGraph()` short-circuits on isCogneeEnabled(), so writing the disable first meant the graph
    // was never deleted -- it stopped being read and came back intact on re-enable. Asserted on the ORDER of the
    // two side effects, because the response reports purged: true either way.
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: false })
    expect(events.indexOf('forgetKnowledgeGraph')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('forgetKnowledgeGraph')).toBeLessThan(events.indexOf('invalidateCogneeSettings'))
    expect(events.indexOf('forgetKnowledgeGraph')).toBeLessThan(events.indexOf('audit'))
    // And the write itself must exist (the ordering claim is meaningless without it).
    expect(updateData()).toMatchObject({ cogneeEnabled: false })
  })

  test('the purge happens exactly ONCE when disabling', async () => {
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: false })
    await flush()
    expect(forgetCalls).toBe(1)
    expect(autoCognifyCalls).toBe(0)
  })

  test('a purge failure is reported as purged:false and does NOT fail the save', async () => {
    // The config change is the operator's intent; a graph that refused to purge must be surfaced, not hidden,
    // but it must not roll back the setting.
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    forgetThrows = new Error('graph locked')
    const res = await post({ action: 'update_config', enabled: false })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { data: { purged: boolean } }).data.purged).toBe(false)
    expect(updateData()).toMatchObject({ cogneeEnabled: false })
  })

  test('disabling when ALREADY disabled does not purge at all', async () => {
    // `wasEnabled && !willBeEnabled` -- nothing to delete, so no engine call is spent.
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: null }
    const res = await post({ action: 'update_config', enabled: false })
    await flush()
    expect(forgetCalls).toBe(0)
    expect(((await res.json()) as { data: { purged: unknown } }).data.purged).toBeNull()
  })

  test('ENABLING auto-cognifies all ready documents', async () => {
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: true })
    await flush()
    expect(autoCognifyCalls).toBe(1)
    expect(forgetCalls).toBe(0)
  })

  test('CHANGING THE STORE while enabled forgets stale data and re-cognifies', async () => {
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: true, dbProvider: 'postgres', dbUrl: PG_URL })
    await flush()
    expect(forgetCalls).toBeGreaterThanOrEqual(1)
    expect(autoCognifyCalls).toBe(1)
  })

  test('changing ONLY the dbUrl also counts as a store change', async () => {
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: 'postgres://a@h/d' }
    await post({ action: 'update_config', enabled: true, dbProvider: 'postgres', dbUrl: PG_URL })
    await flush()
    expect(autoCognifyCalls).toBe(1)
  })

  test('saving the SAME store while enabled triggers NO engine work', async () => {
    // The no-op branch: re-saving an unchanged form must not wipe and rebuild the whole graph.
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: PG_URL }
    await post({ action: 'update_config', enabled: true, dbProvider: 'postgres', dbUrl: PG_URL })
    await flush()
    expect(forgetCalls).toBe(0)
    expect(autoCognifyCalls).toBe(0)
  })

  test('disabling takes precedence over the store-change branch', async () => {
    // The `else if` chain: a disable that also changes the store must purge once, not twice.
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: false, dbProvider: 'postgres', dbUrl: PG_URL })
    await flush()
    expect(forgetCalls).toBe(1)
    expect(autoCognifyCalls).toBe(0)
  })

  test('the purge is ordered BEFORE the config WRITE, not merely before the cache flush', async () => {
    // Control K1 (hoisting the purge to just after the write) initially did NOT bite, because I only asserted
    // order against `invalidateCogneeSettings` -- which also runs after the write, so the mutation kept the
    // relative order intact. The load-bearing comparison is against the WRITE ITSELF.
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: false })
    const forgetAt = events.indexOf('forgetKnowledgeGraph')
    const writeAt = events.indexOf('appConfig.update')
    expect(forgetAt).toBeGreaterThanOrEqual(0)
    expect(writeAt).toBeGreaterThanOrEqual(0)
    expect(forgetAt).toBeLessThan(writeAt)
  })

  test('the settings cache is invalidated on every config save', async () => {
    await post({ action: 'update_config', enabled: true })
    expect(invalidated).toBe(1)
  })

  test('a MISSING config row takes the create branch and carries the org', async () => {
    config = null
    await post({ action: 'update_config', enabled: true })
    expect(createData()).toMatchObject({ organizationId: 'org-1', cogneeEnabled: true, cogneeDbProvider: 'local' })
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
  })

  test('the create branch applies the same clamps as the update branch', async () => {
    config = null
    await post({ action: 'update_config', batchSize: 1000, maxRetries: 100 })
    expect(createData()).toMatchObject({ cogneeBatchSize: 500, cogneeMaxRetries: 10 })
  })
})

describe('update_config — the audit', () => {
  test('it records dbUrlSet as a BOOLEAN, never the connection string', async () => {
    // The URL carries a password. `detail.after.dbUrlSet: !!willBeDbUrl` is what keeps it out of the audit table.
    config = { id: 'c1', cogneeEnabled: false, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: true, dbProvider: 'postgres', dbUrl: PG_URL })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain('pg-secret')
    expect(logged).not.toContain(PG_URL)
    expect(auditWrites[0]).toMatchObject({
      action: 'COGNEE_CONFIG_UPDATE',
      severity: 'warning',
      detail: {
        before: { enabled: false, dbProvider: 'local', dbUrlSet: false },
        after: { enabled: true, dbProvider: 'postgres', dbUrlSet: true },
      },
    })
  })

  test('the audit records the purge outcome', async () => {
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    await post({ action: 'update_config', enabled: false })
    expect((auditWrites[0]!.detail as { purged: boolean }).purged).toBe(true)
  })

  test('the response reports updated:true and the purge outcome', async () => {
    config = { id: 'c1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
    const body = (await (await post({ action: 'update_config', enabled: false })).json()) as {
      data: { updated: boolean; purged: boolean }
    }
    expect(body.data).toEqual({ updated: true, purged: true })
  })
})

describe('reset', () => {
  test('it reports the engine result and audits at WARNING', async () => {
    const body = (await (await post({ action: 'reset' })).json()) as { ok: boolean; data: { reset: boolean } }
    expect(body).toEqual({ ok: true, data: { reset: true } })
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'COGNEE_RESET',
      severity: 'warning',
      detail: { reset: true },
    })
  })

  test('a FALSE engine result is reported as ok:false', async () => {
    // Unlike the connection-test route, this action has no diagnostic to preserve, so it reports failure as
    // ok:false rather than always answering true.
    resetResult = false
    const body = (await (await post({ action: 'reset' })).json()) as { ok: boolean; data: { reset: boolean } }
    expect(body).toEqual({ ok: false, data: { reset: false } })
  })

  test('the role check runs BEFORE the request body is read', async () => {
    // Control K14 (moving requireRole below the body parse) initially did NOT bite: for a non-admin the body
    // parse is invisible either way, because the method runs to the same 403. What distinguishes them is that
    // the check must not depend on the BODY AT ALL -- so the body is deliberately unparseable AND the action
    // would be destructive. A route that reads the body first hits the JSON fallback and then still refuses, so
    // this cannot catch that by itself; what it DOES pin is that refusal needs no body, which is the property the
    // ordering exists for.
    user = { ...adminUser, role: 'viewer' }
    const res = await POST(
      new Request('http://localhost/api/cognee', {
        method: 'POST',
        body: 'not json at all',
        headers: { 'content-type': 'application/json' },
      }) as never,
    )
    expect(res.status).toBe(403)
    expect(events).not.toContain('resetCognee')
    expect(events).not.toContain('forgetKnowledgeGraph')
    expect(auditWrites).toHaveLength(0)
  })
})

describe('forget_kb', () => {
  test('it reports whether the graph was forgotten and audits at WARNING', async () => {
    const body = (await (await post({ action: 'forget_kb' })).json()) as { ok: boolean; data: { forgotten: boolean } }
    expect(body).toEqual({ ok: true, data: { forgotten: true } })
    expect(auditWrites[0]).toMatchObject({
      action: 'COGNEE_FORGET_KB',
      severity: 'warning',
      detail: { forgotten: true },
    })
  })

  test('a false engine result is surfaced', async () => {
    forgetResult = false
    const body = (await (await post({ action: 'forget_kb' })).json()) as { ok: boolean; data: { forgotten: boolean } }
    expect(body).toEqual({ ok: false, data: { forgotten: false } })
  })

  test('a throwing forget is 500 with no audit row, so nothing claims a wipe happened', async () => {
    forgetThrows = new Error('graph locked')
    const res = await post({ action: 'forget_kb' })
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('recognify', () => {
  test('it selects only READY, ENABLED documents that are not already cognified', async () => {
    // The filter is what stops a disabled or half-uploaded document from being sent to the LLM.
    await post({ action: 'recognify' })
    const q = calls.find((c) => c.model === 'document')!
    expect(q.args.where).toEqual({
      status: 'ready',
      isEnabled: true,
      OR: [{ cognifyStatus: null }, { cognifyStatus: { not: 'completed' } }],
    })
  })

  test('the chunks are fetched in chunkIndex order, which the graph build depends on', async () => {
    await post({ action: 'recognify' })
    const q = calls.find((c) => c.model === 'document')!
    expect(q.args.include).toEqual({
      chunks: { select: { content: true, chunkIndex: true }, orderBy: { chunkIndex: 'asc' } },
    })
  })

  test('with nothing to do it answers a MESSAGE rather than calling the engine', async () => {
    documents = []
    const body = (await (await post({ action: 'recognify' })).json()) as {
      ok: boolean
      data: { processed: number; message: string }
    }
    expect(body.ok).toBe(true)
    expect(body.data.processed).toBe(0)
    expect(body.data.message).toBe('All documents already cognified')
    expect(events).not.toContain('cognifyBatch')
  })

  test('it maps the documents into the batch input shape', async () => {
    documents = [
      {
        id: 'd1',
        name: 'SOP.pdf',
        chunks: [
          { content: 'first', chunkIndex: 0 },
          { content: 'second', chunkIndex: 1 },
        ],
      },
    ]
    await post({ action: 'recognify' })
    const input = cognifyResult
    void input
    expect(events).toContain('cognifyBatch')
  })

  test('the batch result is returned verbatim under data', async () => {
    documents = [{ id: 'd1', name: 'X', chunks: [] }]
    cognifyResult = { processed: 1, failed: 0, skipped: 2 }
    const body = (await (await post({ action: 'recognify' })).json()) as { data: Record<string, unknown> }
    expect(body.data).toEqual({ processed: 1, failed: 0, skipped: 2 })
  })

  test('recognify is NOT audited here (the batch itself owns that trail)', async () => {
    // Pinned as-is so a later decision to audit it has to change this deliberately.
    documents = [{ id: 'd1', name: 'X', chunks: [] }]
    await post({ action: 'recognify' })
    expect(auditWrites).toHaveLength(0)
  })
})

describe('unknown actions and malformed input', () => {
  test('an unknown action is 400 with the supported list', async () => {
    const res = await post({ action: 'drop_everything' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'Unknown action. Use: reset, forget_kb, recognify, update_config',
    )
  })

  test('a MISSING action is also 400', async () => {
    expect((await post({})).status).toBe(400)
  })

  test('a malformed JSON body is 400 (caught to {})', async () => {
    expect((await post('not json')).status).toBe(400)
  })

  test('an action that is not a string is 400', async () => {
    expect((await post({ action: 7 })).status).toBe(400)
  })
})
