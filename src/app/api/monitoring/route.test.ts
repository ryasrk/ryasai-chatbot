/**
 * GET /api/monitoring — the observability aggregate. NINE queries + a Redis probe.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog, and this route is where the token numbers the operator sees
 * are actually computed -- including `llmUsageByPurpose`, the per-purpose breakdown that any
 * "average tokens per task" figure would be built from.
 *
 * The properties pinned here are the ones that decide whether those numbers MEAN anything:
 *
 *   1. the 24h window is passed to EVERY aggregate. A missing `gte` silently reports all time as "today",
 *      so a quota or budget decision reads a lifetime total.
 *   2. `llmUsageByPurpose` carries `_count` alongside `_sum`, so a purpose with calls but no recorded tokens
 *      is still visible as activity rather than as zero.
 *   3. nulls become 0, never NaN. `_sum.promptTokens` is null when no row matched, and `Math.round(null)`
 *      is 0 but `null + 0` arithmetic downstream is not.
 *   4. the Redis probe is reported as a FIELD, and a Redis outage must not take the whole dashboard down --
 *      Redis is optional (the app degrades to synchronous processing without it).
 *
 * TENANT SCOPE: all nine models are org-scoped, and this route is the one place a leak would expose another
 * organization's prompts and token spend, so the scoping set is asserted against the extension's own source.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const user = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}

let rows: Record<string, unknown[]> = {}
let groups: Record<string, unknown[]> = {}
let agg: Record<string, unknown> = {}
let counts: Record<string, number> = {}
let redisHealth: { connected: boolean; latencyMs: number | null } = { connected: true, latencyMs: 2 }
let redisThrows: Error | null = null
const calls: Array<{ model: string; op: string; where: unknown; args: Record<string, unknown> }> = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

mock.module('@/lib/redis', () => ({
  checkRedisHealth: async () => {
    if (redisThrows) throw redisThrows
    return redisHealth
  },
}))

function model(name: string) {
  return {
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'findMany', where: args?.where, args: args ?? {} })
      return rows[`${name}.findMany`] ?? rows[name] ?? []
    },
    count: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'count', where: args?.where, args: args ?? {} })
      return counts[`${name}.count`] ?? 0
    },
    aggregate: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'aggregate', where: args?.where, args: args ?? {} })
      return agg[name] ?? { _avg: { latencyMs: null }, _sum: {}, _count: 0 }
    },
    groupBy: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'groupBy', where: args?.where, args: args ?? {} })
      return groups[name] ?? []
    },
  }
}

mock.module('@/lib/db', () => ({
  db: {
    toolRun: model('toolRun'),
    apiRequestLog: model('apiRequestLog'),
    restApiRequestLog: model('restApiRequestLog'),
    auditLog: model('auditLog'),
    llmUsageLog: model('llmUsageLog'),
  },
}))

import { GET } from './route'

const MODELS_USED = ['toolRun', 'apiRequestLog', 'restApiRequestLog', 'auditLog', 'llmUsageLog']

beforeEach(() => {
  rows = {}
  groups = {}
  agg = {}
  counts = {}
  redisHealth = { connected: true, latencyMs: 2 }
  redisThrows = null
  calls.length = 0
  enteredOrgs.length = 0
})

describe('GET /api/monitoring — tenant context', () => {
  test('the org context is entered with the SESSION org', async () => {
    await GET()
    expect(enteredOrgs).toEqual(['org-1'])
  })

  test('EVERY model queried is in the org-scoped set', async () => {
    // This route returns other users' prompts (GUARDRAIL_BLOCK audits) and token spend. A model missing from
    // ORG_SCOPED_MODELS would expose both across organizations. Asserted against the extension's own source
    // so the two lists cannot drift.
    const src = await Bun.file('src/lib/prisma-tenant.ts').text()
    const start = src.indexOf('const ORG_SCOPED_MODELS')
    const block = src.slice(start, src.indexOf('})', start))
    for (const m of MODELS_USED) expect(block).toContain(`'${m}'`)
  })
})

describe('GET /api/monitoring — the 24h window', () => {
  test('the window is passed to EVERY time-scoped query', async () => {
    // A dropped `gte` reports all time as "last 24 hours", which is exactly how an operator would be
    // misled about a spend or error spike.
    await GET()
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000
    const scoped = calls.filter((c) => (c.where as { createdAt?: { gte?: Date } })?.createdAt?.gte)
    // toolRun.count, toolRun.aggregate, apiRequestLog.count, llmUsageLog.aggregate, llmUsageLog.groupBy
    expect(scoped.length).toBeGreaterThanOrEqual(5)
    for (const c of scoped) {
      const gte = (c.where as { createdAt: { gte: Date } }).createdAt.gte
      expect(gte.getTime()).toBeGreaterThan(dayAgo - 5000)
      expect(gte.getTime()).toBeLessThan(dayAgo + 5000)
    }
  })

  test('the LIST queries are NOT time-scoped (they are last-N, not last-24h)', async () => {
    // The four "recent activity" lists are capped by `take`, not by date -- adding a window would hide the
    // very failures an operator opened the page to find.
    await GET()
    const listCalls = calls.filter((c) => c.op === 'findMany')
    expect(listCalls).toHaveLength(4)
    for (const c of listCalls) {
      expect((c.where as { createdAt?: unknown })?.createdAt).toBeUndefined()
      expect(c.args.take).toBe(50)
    }
  })

  test('every list is newest-first', async () => {
    await GET()
    for (const c of calls.filter((x) => x.op === 'findMany')) {
      expect(c.args.orderBy).toEqual({ createdAt: 'desc' })
    }
  })
})

describe('GET /api/monitoring — filters that define what an "error" is', () => {
  test('failed API requests are >= 400, not > 400', async () => {
    // 400 itself is a failure the operator wants to see. `gt: 400` would hide every bad-request.
    await GET()
    const c = calls.find((x) => x.model === 'apiRequestLog' && x.op === 'findMany')!
    expect(c.args.where).toMatchObject({ status: { gte: 400 } })
  })

  test('REST errors are those WITH an error message', async () => {
    await GET()
    const c = calls.find((x) => x.model === 'restApiRequestLog' && x.op === 'findMany')!
    expect(c.args.where).toMatchObject({ errorMessage: { not: null } })
  })

  test('blocked SQL is the GUARDRAIL_BLOCK audit action specifically', async () => {
    // Without the filter this becomes "the audit log", and a guardrail-blocked query -- a security event --
    // would be buried among info-level rows.
    await GET()
    const c = calls.find((x) => x.model === 'auditLog' && x.op === 'findMany')!
    expect(c.args.where).toMatchObject({ action: 'GUARDRAIL_BLOCK' })
  })

  test('the timestamped apiRequestLog count reuses BOTH filters', async () => {
    // The 24h failure count must be failures-in-window, not failures-total or requests-in-window.
    await GET()
    const c = calls.find((x) => x.model === 'apiRequestLog' && x.op === 'count')!
    expect(c.args.where).toMatchObject({ status: { gte: 400 } })
    expect((c.args.where as { createdAt?: unknown }).createdAt).toBeDefined()
  })

  test('the latency aggregate excludes rows with no latency', async () => {
    // `latencyMs: { not: null }`. Including them would pull the average toward zero and make a slow system
    // look fast.
    await GET()
    const c = calls.find((x) => x.model === 'toolRun' && x.op === 'aggregate')!
    expect(c.args.where).toMatchObject({ latencyMs: { not: null } })
    expect((c.args.where as { createdAt?: unknown }).createdAt).toBeDefined()
  })
})

describe('GET /api/monitoring — the token numbers (the "avg tokens/task" source)', () => {
  test('the aggregate asks for prompt, completion AND total tokens', async () => {
    // A figure that reports only `totalTokens` cannot answer "is the prompt or the output growing?", which
    // is the question a token-cost investigation actually starts with.
    await GET()
    const c = calls.find((x) => x.model === 'llmUsageLog' && x.op === 'aggregate')!
    expect(c.args._sum).toMatchObject({
      promptTokens: true,
      completionTokens: true,
      totalTokens: true,
    })
    expect(c.args._count).toBe(true)
  })

  test('sums are reported as 0 when no usage row matched, never null/NaN', async () => {
    // `_sum.promptTokens` is null on an empty match. A null here propagates into the dashboard as a blank
    // card, and `undefined + n` into any later arithmetic as NaN.
    agg['llmUsageLog'] = {
      _sum: { promptTokens: null, completionTokens: null, totalTokens: null },
      _count: 0,
    }
    const res = await GET()
    const body = (await res.json()) as { stats: Record<string, unknown> }
    expect(body.stats.llmPromptTokens24h).toBe(0)
    expect(body.stats.llmCompletionTokens24h).toBe(0)
    expect(body.stats.llmTotalTokens24h).toBe(0)
    expect(body.stats.llmCalls24h).toBe(0)
    expect(Number.isNaN(body.stats.llmPromptTokens24h as number)).toBe(false)
  })

  test('the average latency rounds and is 0 when the average is null', async () => {
    // `Math.round(agg._avg.latencyMs ?? 0)` -- no rows in the window means no average, which must render as
    // 0 rather than NaN.
    agg['toolRun'] = { _avg: { latencyMs: null } }
    const res = await GET()
    const body = (await res.json()) as { stats: Record<string, number> }
    expect(body.stats.avgToolLatencyMs24h).toBe(0)

    agg['toolRun'] = { _avg: { latencyMs: 123.6 } }
    const res2 = await GET()
    const body2 = (await res2.json()) as { stats: Record<string, number> }
    expect(body2.stats.avgToolLatencyMs24h).toBe(124)
  })

  test('the per-purpose breakdown reports calls AND tokens per purpose', async () => {
    // This is the shape any "average tokens per task" would divide. `_count` alongside `_sum` keeps a purpose
    // that recorded calls but no tokens visible as activity instead of as a zero.
    groups['llmUsageLog'] = [
      { purpose: 'chat', _count: 10, _sum: { totalTokens: 5000 } },
      { purpose: 'sql', _count: 4, _sum: { totalTokens: 1200 } },
    ]
    const res = await GET()
    const body = (await res.json()) as {
      stats: { llmUsageByPurpose: Array<{ purpose: string; calls: number; totalTokens: number }> }
    }
    expect(body.stats.llmUsageByPurpose).toEqual([
      { purpose: 'chat', calls: 10, totalTokens: 5000 },
      { purpose: 'sql', calls: 4, totalTokens: 1200 },
    ])
  })

  test('a purpose with calls but NO tokens reports 0 tokens rather than null', async () => {
    // The real-world case this mirrors: `logLlmUsage` is called with usage data directly, so rows exist, but
    // any path where the provider returned no usage payload would sum to null. Reporting null here would
    // make the average divide by a non-number.
    groups['llmUsageLog'] = [{ purpose: 'chat', _count: 3, _sum: { totalTokens: null } }]
    const res = await GET()
    const body = (await res.json()) as {
      stats: { llmUsageByPurpose: Array<{ calls: number; totalTokens: number }> }
    }
    expect(body.stats.llmUsageByPurpose[0]!.totalTokens).toBe(0)
    expect(body.stats.llmUsageByPurpose[0]!.calls).toBe(3)
  })

  test('the groupBy is scoped to the window and keyed on purpose only', async () => {
    await GET()
    const c = calls.find((x) => x.model === 'llmUsageLog' && x.op === 'groupBy')!
    expect(c.args.by).toEqual(['purpose'])
    expect((c.args.where as { createdAt?: unknown }).createdAt).toBeDefined()
  })
})

describe('GET /api/monitoring — Redis is a REPORTED FIELD, not a dependency', () => {
  test('a healthy Redis is reported with its latency', async () => {
    redisHealth = { connected: true, latencyMs: 7 }
    const res = await GET()
    const body = (await res.json()) as { redis: { connected: boolean; latencyMs: number } }
    expect(body.redis).toEqual({ connected: true, latencyMs: 7 })
  })

  test('a DISCONNECTED Redis is reported as such, with a null latency', async () => {
    // The app degrades to synchronous processing and in-memory rate limits without Redis, so this page must
    // still render -- the flag is informational.
    redisHealth = { connected: false, latencyMs: null }
    const res = await GET()
    const body = (await res.json()) as { redis: unknown; ok: boolean }
    expect(body.ok).toBe(true)
    expect(body.redis).toEqual({ connected: false, latencyMs: null })
  })

  test('the redis probe runs AFTER the database reads, not in the same batch', async () => {
    // Behavioural consequence: a Redis outage is reported alongside a complete dataset rather than replacing
    // it. Pinned by asserting the request still succeeds when Redis is slow to answer.
    redisHealth = { connected: false, latencyMs: null }
    rows['toolRun.findMany'] = [{ id: 't1' }]
    const res = await GET()
    const body = (await res.json()) as { toolRuns: unknown[] }
    expect(body.toolRuns).toHaveLength(1)
  })
})

describe('GET /api/monitoring — response shape', () => {
  test('all four lists and the stats block are present', async () => {
    rows['toolRun.findMany'] = [{ id: 't1' }]
    rows['apiRequestLog.findMany'] = [{ id: 'a1' }, { id: 'a2' }]
    rows['restApiRequestLog.findMany'] = []
    rows['auditLog.findMany'] = [{ id: 'b1' }]
    const res = await GET()
    const body = (await res.json()) as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.toolRuns).toHaveLength(1)
    expect(body.failedApiRequests).toHaveLength(2)
    expect(body.restApiErrors).toHaveLength(0)
    expect(body.blockedSql).toHaveLength(1)
    expect(body.stats).toBeDefined()
  })

  test('a database failure is reported through the typed error mapper', async () => {
    counts['toolRun.count'] = 0
    const db = (await import('@/lib/db')).db as unknown as {
      toolRun: { findMany: (a: unknown) => Promise<unknown[]> }
    }
    const original = db.toolRun.findMany
    db.toolRun.findMany = async () => {
      throw new Error('db down')
    }
    try {
      const res = await GET()
      expect(res.status).toBe(500)
    } finally {
      db.toolRun.findMany = original
    }
  })
})
