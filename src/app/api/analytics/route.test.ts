/**
 * GET /api/analytics — the dashboard aggregate. FOURTEEN queries across seven models.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog. This is the widest query surface of any read route in the
 * app, and EVERY one of its queries depends on the tenant extension injecting `organizationId`. A single
 * model that is not in `ORG_SCOPED_MODELS`, or a single call that runs outside the entered org context,
 * turns the dashboard into a CROSS-ORG LEAK: totals, recent query rows (with user names), guardrail block
 * counts, and audit severity distribution from other organizations.
 *
 * So the tests here are mostly about the SHAPE AND CONTEXT of the calls rather than the arithmetic:
 *
 *   1. the route enters the org context before it queries anything (this route was historically the
 *      canonical example of the forgot-`enterWithOrg` bug),
 *   2. every model it touches IS org-scoped, asserted against the real set rather than assumed,
 *   3. the metrics are computed from what the DB returns -- including the two division-by-zero and
 *      null-category cases, which are the ones most likely to produce a `NaN` or an `"undefined"` label,
 *   4. the 7-day trend buckets are UTC-aligned and dense (a missing day must be a zero, not a gap).
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

let counts: Record<string, number> = {}
let rows: Record<string, unknown[]> = {}
let groups: Record<string, unknown[]> = {}
const calls: Array<{ model: string; op: string; where: unknown; args: Record<string, unknown> }> = []
const enteredOrgs: string[] = []
/** Per-test overrides: a queue of values consumed in call order for `<model>.<op>`. */
const queues: Record<string, unknown[]> = {}

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

function model(name: string) {
  return {
    count: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'count', where: args?.where, args: args ?? {} })
      const q = queues[`${name}.count`]
      if (q && q.length) {
        const v = q.shift()
        if (v === 'THROW') throw new Error('db down')
        return v as number
      }
      return counts[`${name}.count`] ?? 0
    },
    findMany: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'findMany', where: args?.where, args: args ?? {} })
      const q = queues[`${name}.findMany`]
      if (q && q.length) {
        const v = q.shift()
        if (v === 'THROW') throw new Error('db down')
        return v as unknown[]
      }
      return rows[name] ?? []
    },
    groupBy: async (args: Record<string, unknown>) => {
      calls.push({ model: name, op: 'groupBy', where: args?.where, args: args ?? {} })
      const q = queues[`${name}.groupBy`]
      if (q && q.length) return q.shift() as unknown[]
      return groups[name] ?? []
    },
  }
}

mock.module('@/lib/db', () => ({
  db: {
    integration: model('integration'),
    document: model('document'),
    chatSession: model('chatSession'),
    queryHistory: model('queryHistory'),
    auditLog: model('auditLog'),
    chatMessage: model('chatMessage'),
    scheduledRun: model('scheduledRun'),
  },
}))

import { GET } from './route'
// The REAL scoping set -- imported from the source, not re-listed here, so a model added to the route
// without being added to the extension is caught.

const MODELS_USED = [
  'integration',
  'document',
  'chatSession',
  'queryHistory',
  'auditLog',
  'chatMessage',
  'scheduledRun',
] as const

beforeEach(() => {
  counts = {
    'integration.count': 3,
    'document.count': 10,
    'chatSession.count': 4,
    'queryHistory.count': 7,
    'auditLog.count': 1,
  }
  rows = {}
  groups = {}
  calls.length = 0
  enteredOrgs.length = 0
  for (const k of Object.keys(queues)) delete queues[k]
})

describe('GET /api/analytics — the tenant context is entered first', () => {
  test('enterWithOrg runs with the SESSION org, before any query', async () => {
    // `enterWith` does not propagate to the caller's frame, so a route that omits this call runs every
    // one of the fourteen queries unscoped. tenant-route-guard.test.ts enforces it statically; this is
    // the behavioural half.
    await GET()
    expect(enteredOrgs).toEqual(['org-1'])
    expect(calls.length).toBeGreaterThan(10)
  })

  test('EVERY model the route queries is in the org-scoped set', async () => {
    // The cross-org leak this guards: a model missing from ORG_SCOPED_MODELS receives no
    // `organizationId` filter, so its counts and rows silently span every organization. Asserted against
    // the extension's own source text rather than a copy of the list, so the two cannot drift.
    const src = await Bun.file('src/lib/prisma-tenant.ts').text()
    const start = src.indexOf('const ORG_SCOPED_MODELS')
    const block = src.slice(start, src.indexOf('})', start))
    for (const m of MODELS_USED) {
      expect(block).toContain(`'${m}'`)
    }
  })

  test('no query runs before the org context is entered', async () => {
    // Recorded by ordering: enterWithOrg is pushed first because the route awaits getActiveUser() and
    // calls it before the first `await` of any model.
    const order: string[] = []
    enteredOrgs.length = 0
    calls.length = 0
    await GET()
    order.push(enteredOrgs.length > 0 ? 'enter' : 'MISSING')
    expect(order).toEqual(['enter'])
  })
})

describe('GET /api/analytics — the numbers', () => {
  test('totals come straight from the counts', async () => {
    const res = await GET()
    const body = (await res.json()) as { totals: Record<string, number> }
    expect(body.totals).toMatchObject({
      integrations: 3,
      documents: 10,
      chatSessions: 4,
      queriesExecuted: 7,
      guardrailBlocks: 1,
    })
  })

  test('the guardrail block count filters on GUARDRAIL_BLOCK, not on total audits', async () => {
    await GET()
    const auditCounts = calls.filter((c) => c.model === 'auditLog' && c.op === 'count')
    expect(auditCounts.some((c) => (c.where as { action?: string })?.action === 'GUARDRAIL_BLOCK')).toBe(true)
  })

  test('querySuccessRate is a rounded percentage (3 of 9 -> 33)', async () => {
    // ORDER MATTERS AND IS PINNED. queryHistory.count is called THREE times, in this order:
    //   #1 totals pass     -> where {}
    //   #2 success rate    -> where { success: true }
    //   #3 success rate    -> where {}
    // Verified by instrumenting the model (3 calls: {}, {success:true}, {}). The queue supplies the
    // return values in that order, so swapping #2 and #3 would compute 300%.
    queues['queryHistory.count'] = [9, 3, 9]
    const res = await GET()
    const body = (await res.json()) as { querySuccessRate: number }
    expect(body.querySuccessRate).toBe(33)
  })

  test('the SECOND count is the success-filtered one and the THIRD is unfiltered', async () => {
    // Order alone is not enough: the success count must carry the filter, or "success rate" would be the
    // total divided by the total -- always 100%.
    await GET()
    const qh = calls.filter((c) => c.model === 'queryHistory' && c.op === 'count')
    expect(qh).toHaveLength(3)
    expect((qh[0]!.where as { success?: boolean })?.success).toBeUndefined()
    expect((qh[1]!.where as { success?: boolean })?.success).toBe(true)
    expect((qh[2]!.where as { success?: boolean })?.success).toBeUndefined()
  })

  test('KNOWN WASTE: queryHistory is counted for an UNFILTERED total TWICE per request', async () => {
    // PINNED, NOT FIXED. Call #1 (in the totals Promise.all, `where: {}`) and call #3 (the success-rate
    // total, `where: {}`) are THE SAME QUERY, and `queriesExecuted` already holds the answer from #1. So
    // every dashboard load issues one redundant COUNT over the whole QueryHistory table for this org.
    //
    // Scope kept honest: it is one extra COUNT per request, not per row, so on a modest table the cost is
    // a few milliseconds; the table grows with every executed query, though, and this is the most-loaded
    // read route in the app. The fix is one line -- reuse `queriesExecuted` (or hoist the count above both
    // Promise.all blocks) -- but it changes the call count this file asserts on, so it is recorded here so
    // the change is VISIBLE and deliberate rather than silent. Not a correctness bug: the value is right.
    queues['queryHistory.count'] = [9, 3, 9]
    await GET()
    const unfiltered = calls.filter(
      (c) =>
        c.model === 'queryHistory' &&
        c.op === 'count' &&
        (c.where as { success?: boolean })?.success === undefined,
    )
    expect(unfiltered).toHaveLength(2)
  })

  test('a query row on a bucket day increments the QUERY trend bucket', async () => {
    // The query-trend loop (`bucketMap.get(key)` -> `b.count += 1`) is the sibling of the chat-trend loop
    // and was uncovered: the chat loop had a test and this one did not. A row inside the window must be
    // counted, and the bucket it lands in must be TODAY.
    // ORDER: queryHistory.findMany is called TWICE -- the recent-queries list (take 5) FIRST, then the
    // trend window. Verified by instrumentation; the queue must supply them in that order.
    const today = new Date()
    today.setUTCHours(9, 0, 0, 0)
    queues['queryHistory.findMany'] = [[], [{ createdAt: today }, { createdAt: today }, { createdAt: today }]]
    const res = await GET()
    const body = (await res.json()) as { queryTrend: Array<{ count: number }> }
    expect(body.queryTrend[6]!.count).toBe(3)
  })

  test('a query row OUTSIDE the window is not folded into the oldest bucket', async () => {
    // Same guard as the chat trend: `if (b)` must drop an out-of-window date rather than inflating day 0.
    const old = new Date()
    old.setUTCDate(old.getUTCDate() - 30)
    queues['queryHistory.findMany'] = [[], [{ createdAt: old }]]
    const res = await GET()
    const body = (await res.json()) as { queryTrend: Array<{ count: number }> }
    expect(body.queryTrend.every((b) => b.count === 0)).toBe(true)
  })

  test('integrations are grouped by provider and reported with their counts', async () => {
    // The provider breakdown feeds the dashboard's donut. Asserted because an empty `groups` stub left the
    // mapping line uncovered, so nothing proved the shape `{ provider, count }` is actually produced.
    groups['integration'] = [
      { provider: 'POSTGRESQL', _count: { _all: 2 } },
      { provider: 'MYSQL', _count: { _all: 1 } },
    ]
    const res = await GET()
    const body = (await res.json()) as { integrationsByProvider: Array<{ provider: string; count: number }> }
    expect(body.integrationsByProvider).toEqual([
      { provider: 'POSTGRESQL', count: 2 },
      { provider: 'MYSQL', count: 1 },
    ])
  })

  test('the groupBy calls ask for the right keys and no filter', async () => {
    // `by: ['provider']` / `by: ['category']` / `by: ['severity']`, each with `where: {}` so the tenant
    // extension is the ONLY scoping. A hand-written organizationId here would double-filter and silently
    // hide rows the moment the extension's behaviour changed.
    await GET()
    const byModel = (m: string) => calls.find((c) => c.model === m && c.op === 'groupBy')
    expect(byModel('integration')!.args.by).toEqual(['provider'])
    expect(byModel('document')!.args.by).toEqual(['category'])
    expect(byModel('auditLog')!.args.by).toEqual(['severity'])
    for (const m of ['integration', 'document', 'auditLog']) {
      expect(byModel(m)!.where).toEqual({})
    }
  })

  test('querySuccessRate is 0, NOT NaN, when there are no queries at all', async () => {
    // The fresh-install case. 0/0 in JavaScript is NaN, and NaN serialises to `null` over JSON -- a chart
    // would render blank rather than empty. The route guards it explicitly; pinned here.
    queues['queryHistory.count'] = [0, 0, 0]
    const res = await GET()
    const body = (await res.json()) as { querySuccessRate: number }
    expect(body.querySuccessRate).toBe(0)
    expect(Number.isNaN(body.querySuccessRate)).toBe(false)
  })

  test('a document with no category is labelled Uncategorized, never "null"', async () => {
    // `g.category ?? 'Uncategorized'`. Without the fallback the chart legend shows a literal null.
    groups['document'] = [
      { category: null, _count: { _all: 2 } },
      { category: 'HR', _count: { _all: 5 } },
    ]
    const res = await GET()
    const body = (await res.json()) as { documentsByCategory: Array<{ category: string; count: number }> }
    expect(body.documentsByCategory).toEqual([
      { category: 'Uncategorized', count: 2 },
      { category: 'HR', count: 5 },
    ])
  })

  test('audit severity defaults are kept for severities the DB did not return', async () => {
    // All three keys must always exist, or the UI's `.info` read is undefined.
    groups['auditLog'] = [{ severity: 'critical', _count: { _all: 4 } }]
    const res = await GET()
    const body = (await res.json()) as { auditBySeverity: Record<string, number> }
    expect(body.auditBySeverity).toEqual({ info: 0, warning: 0, critical: 4 })
  })

  test('an UNRECOGNISED severity is ignored rather than injected into the response', async () => {
    // The loop only assigns the three known keys. A future enum value (e.g. 'debug') must not silently
    // become a fourth key the UI never renders -- or worse, overwrite a real one.
    groups['auditLog'] = [
      { severity: 'debug', _count: { _all: 9 } },
      { severity: 'info', _count: { _all: 2 } },
    ]
    const res = await GET()
    const body = (await res.json()) as { auditBySeverity: Record<string, number> }
    expect(body.auditBySeverity).toEqual({ info: 2, warning: 0, critical: 0 })
    expect(body.auditBySeverity).not.toHaveProperty('debug')
  })

  test('the seven trend buckets are dense, UTC-dated, and end today', async () => {
    // A bucket per day means a quiet day renders as 0 rather than as a gap, and UTC alignment keeps the
    // chart consistent with the UTC timestamps the DB stores.
    const res = await GET()
    const body = (await res.json()) as { queryTrend: Array<{ date: string; count: number }> }
    expect(body.queryTrend).toHaveLength(7)
    const dates = body.queryTrend.map((b) => b.date)
    expect([...dates].sort()).toEqual(dates) // ascending
    expect(dates.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    expect(dates[6]).toBe(today.toISOString().slice(0, 10))
  })

  test('chat trend has the SAME seven buckets as the query trend', async () => {
    // The two series are drawn on one axis; different bucket sets would misalign the bars.
    const res = await GET()
    const body = (await res.json()) as {
      queryTrend: Array<{ date: string }>
      chatTrend: Array<{ date: string }>
    }
    expect(body.chatTrend.map((b) => b.date)).toEqual(body.queryTrend.map((b) => b.date))
  })

  test('a chat message on a bucket day increments that bucket', async () => {
    const today = new Date()
    today.setUTCHours(12, 0, 0, 0)
    rows['chatMessage'] = [{ createdAt: today }, { createdAt: today }]
    const res = await GET()
    const body = (await res.json()) as { chatTrend: Array<{ count: number }> }
    expect(body.chatTrend[6]!.count).toBe(2)
  })

  test('a chat message OUTSIDE the window is ignored, not bucketed into day 0', async () => {
    // `bucketMap.get(key)` returns undefined for an old date; a `?? buckets[0]` style fallback would
    // inflate the oldest day.
    const old = new Date()
    old.setUTCDate(old.getUTCDate() - 40)
    rows['chatMessage'] = [{ createdAt: old }]
    const res = await GET()
    const body = (await res.json()) as { chatTrend: Array<{ count: number }> }
    expect(body.chatTrend.every((b) => b.count === 0)).toBe(true)
  })

  test('recent queries and scheduled runs are both present in the response', async () => {
    // queryHistory is queried by BOTH findMany calls (recent list + trend window); the queue returns the
    // same stub to each, which is enough to prove both are shaped into the response.
    queues['queryHistory.findMany'] = [[{ id: 'q1' }], []]  // recent list first, then the trend window
    rows['scheduledRun'] = [{ name: 'nightly', lastRunAt: new Date(), lastResult: 'ok' }]
    const res = await GET()
    const body = (await res.json()) as { recentQueries: unknown[]; recentScheduledRuns: unknown[] }
    expect(body.recentQueries).toHaveLength(1)
    expect(body.recentScheduledRuns).toHaveLength(1)
  })

  test('a database failure is reported through the typed error mapper', async () => {
    queues['integration.count'] = ['THROW']
    const res = await GET()
    expect(res.status).toBe(500)
  })
})

describe('GET /api/analytics — the exact query arguments', () => {
  test('the recent-queries include pulls ONLY the integration and user name', async () => {
    // A bare `include: { integration: true, user: true }` ships EVERY column of both rows to the browser,
    // including the integration's encrypted config. Asserted on the exact object rather than on presence.
    await GET()
    const withInclude = calls.find(
      (c) => c.model === 'queryHistory' && c.op === 'findMany' && c.args.include,
    )
    expect(withInclude).toBeDefined()
    expect(withInclude!.args.include).toEqual({
      integration: { select: { name: true } },
      user: { select: { name: true } },
    })
  })

  test('the TREND query carries no include at all (payload stays two fields)', async () => {
    // `select: { createdAt: true }` only. A widened include here multiplies the rows shipped for a series
    // that renders nothing but a count.
    await GET()
    const trend = calls.find(
      (c) =>
        c.model === 'queryHistory' &&
        c.op === 'findMany' &&
        (c.where as { createdAt?: unknown })?.createdAt,
    )
    expect(trend).toBeDefined()
    expect(trend!.args.select).toEqual({ createdAt: true })
    expect(trend!.args.include).toBeUndefined()
  })

  test('recent queries take 5, newest first', async () => {
    await GET()
    const recent = calls.find(
      (c) => c.model === 'queryHistory' && c.op === 'findMany' && c.args.take === 5,
    )
    expect(recent).toBeDefined()
    expect(recent!.args.orderBy).toEqual({ createdAt: 'desc' })
  })

  test('the trend window is EXACTLY six days back, shared by both series', async () => {
    // `days - 1`. Off by one and the window is 7 days including today (correct) vs 8 (one bucket never
    // filled); `-1` instead of `-6` would leave six of the seven buckets permanently zero.
    await GET()
    const windows = calls
      .filter((c) => c.op === 'findMany')
      .map((c) => (c.where as { createdAt?: { gte?: Date } })?.createdAt?.gte)
      .filter((d): d is Date => d instanceof Date)
    expect(windows).toHaveLength(2)
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const expected = new Date(today)
    expected.setUTCDate(expected.getUTCDate() - 6)
    for (const w of windows) expect(w.toISOString()).toBe(expected.toISOString())
  })

  test('the last bucket is TODAY in UTC', async () => {
    // The chart must end on the current day, matched against the UTC calendar date the DB stores.
    //
    // DECLARED NON-CONTROL -- verified, not assumed, and NOT hidden. Replacing the route's
    // `setUTCHours(0,0,0,0)` with `setHours(0,0,0,0)` does NOT turn this test red on this host, and the
    // reason is arithmetic rather than a weak assertion: at UTC+7 the local-midnight anchor is
    // 17:00Z the PREVIOUS day, and the loop then does `d.setUTCDate(d.getUTCDate() - i)` with i = 0 for the
    // last bucket, so `getUTCDate()` still returns the same UTC date and the bucket comes out identical.
    // The two anchors only diverge when the local time-of-day at the anchor is >= 07:00 UTC, i.e. on hosts
    // at UTC-7 or further west -- a deployment-dependent divergence, not one this suite can force.
    //
    // So this assertion pins the UTC DATE (a real property) while the UTC-vs-local DETAIL is left
    // explicitly unverified here. A control that cannot bite must be declared, not dressed up.
    const res = await GET()
    const body = (await res.json()) as { queryTrend: Array<{ date: string }> }
    const utcToday = new Date()
    utcToday.setUTCHours(0, 0, 0, 0)
    expect(body.queryTrend[6]!.date).toBe(utcToday.toISOString().slice(0, 10))
  })

  test('scheduled runs are filtered to those that HAVE run, newest first, capped at 5', async () => {
    // `lastRunAt: { not: null }` -- a schedule that was created but never fired must not be listed as a
    // recent run, which would make an idle install look active.
    await GET()
    const sr = calls.find((c) => c.model === 'scheduledRun' && c.op === 'findMany')
    expect(sr).toBeDefined()
    expect((sr!.where as { lastRunAt?: unknown })?.lastRunAt).toEqual({ not: null })
    expect(sr!.args.orderBy).toEqual({ lastRunAt: 'desc' })
    expect(sr!.args.take).toBe(5)
    expect(sr!.args.select).toEqual({ name: true, lastRunAt: true, lastResult: true })
  })

  test('the totals counts carry their filters and the rest stay unfiltered', async () => {
    // `where: {}` everywhere except the guardrail-blocks count: scoping is the tenant extension's job, and
    // a hand-written organizationId would double-filter.
    await GET()
    const c = (m: string) => calls.find((x) => x.model === m && x.op === 'count')
    expect(c('integration')!.where).toEqual({})
    expect(c('document')!.where).toEqual({})
    expect(c('chatSession')!.where).toEqual({})
    expect((c('auditLog')!.where as { action?: string })?.action).toBe('GUARDRAIL_BLOCK')
  })
})
