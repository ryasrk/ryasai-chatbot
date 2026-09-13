/**
 * GET /api/traces and GET /api/traces/stats — the in-memory observability ring buffer's HTTP face.
 *
 * WHY THIS FILE EXISTS. Both handlers are thin, so the ONLY behaviour worth pinning is the LIMIT CLAMP on
 * /traces, which is arithmetic on untrusted query input and has two tempting wrong answers:
 *
 *   - `Number(null)` is 0 and `Math.max(0, 1)` is 1, so a MISSING `limit` silently becomes 1 rather than the
 *     documented default of 50. The route avoids that by defaulting the STRING to '50' before coercion.
 *   - `Number('abc')` is NaN, and `Math.min(Math.max(NaN, 1), 100)` is NaN -- which would reach the ring buffer as
 *     a slice bound. NaN there behaves like 0, so a typo'd limit returns an EMPTY list instead of an error.
 *
 * A negative limit clamps to 1 (not 0, and not "from the end"), and an over-large one clamps to 100. The CLAMPED
 * value is what the buffer receives -- asserted on the ARGUMENT, because asserting on the returned array would
 * pass for any limit above the fixture size and prove nothing.
 *
 * Also pinned: the org context is entered on both routes (session-authenticated even though the buffer is
 * process-local), and the envelopes are `{traces}` / `{stats}` rather than a shared `data` key.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const analystUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro',
}

// ---- mutable seams, declared before every mock.module ----
let user: typeof analystUser = analystUser
let traceRows: unknown[] = [{ id: 't1' }]
let statsPayload: Record<string, unknown> = { total: 3, errors: 0 }
let tracesThrow: Error | null = null
const events: string[] = []
const limitArgs: number[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  handleApiError: (_e: unknown, fallback: string, status = 500) =>
    Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/observability', () => ({
  getRecentTraces: (limit: number) => {
    limitArgs.push(limit)
    if (tracesThrow) throw tracesThrow
    return traceRows
  },
  getTraceStats: () => statsPayload,
}))

// DYNAMIC: a static import would be evaluated before the mocks above and bypass every one of them.
const tracesRoute = await import('./route')
const statsRoute = await import('./stats/route')

function get(query = '', which: 'traces' | 'stats' = 'traces') {
  const base = which === 'traces' ? '/api/traces' : '/api/traces/stats'
  const url = `http://localhost${base}${query}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return which === 'traces' ? tracesRoute.GET(req as never) : statsRoute.GET()
}

beforeEach(() => {
  user = analystUser
  traceRows = [{ id: 't1' }]
  statsPayload = { total: 3, errors: 0 }
  tracesThrow = null
  events.length = 0
  limitArgs.length = 0
})

describe('/api/traces — the limit clamp', () => {
  test('an OMITTED limit is 50, NOT 1 (Number(null) would be 0)', async () => {
    // The route defaults the STRING to '50' before coercing; defaulting the NUMBER would make Math.max(0, 1) = 1.
    await get('')
    expect(limitArgs).toEqual([50])
  })

  test('an explicit limit is passed through', async () => {
    await get('?limit=7')
    expect(limitArgs).toEqual([7])
  })

  test('an over-large limit clamps to 100', async () => {
    await get('?limit=5000')
    expect(limitArgs).toEqual([100])
  })

  test('a limit of exactly 100 is allowed', async () => {
    await get('?limit=100')
    expect(limitArgs).toEqual([100])
  })

  test('a limit of exactly 1 is allowed', async () => {
    await get('?limit=1')
    expect(limitArgs).toEqual([1])
  })

  test('ZERO clamps UP to 1, not down to 0', async () => {
    // A zero limit would return an empty list while looking like a successful request.
    await get('?limit=0')
    expect(limitArgs).toEqual([1])
  })

  test('a NEGATIVE limit clamps to 1, not "from the end"', async () => {
    await get('?limit=-20')
    expect(limitArgs).toEqual([1])
  })

  test('a NON-NUMERIC limit yields NaN, which the buffer treats as 0 — recorded as the current behaviour', async () => {
    // `Math.min(Math.max(NaN, 1), 100)` is NaN. The clamp does NOT catch a typo, and NaN is what the ring buffer
    // receives. Pinned so a future fix (e.g. `|| 50` before the clamp) turns this test red deliberately.
    await get('?limit=abc')
    expect(limitArgs).toHaveLength(1)
    expect(Number.isNaN(limitArgs[0]!)).toBe(true)
  })

  test('a FRACTIONAL limit is passed through un-rounded', async () => {
    // Same family as NaN: nothing normalises the value, so 2.5 reaches the buffer and `slice(0, 2.5)` is 2.
    await get('?limit=2.5')
    expect(limitArgs).toEqual([2.5])
  })

  test('an EMPTY limit is coerced to 0 and then clamped to 1', async () => {
    // `?? '50'` does NOT fire for an empty string (it is not nullish), so `Number('')` is 0.
    await get('?limit=')
    expect(limitArgs).toEqual([1])
  })
})

describe('/api/traces — envelope and context', () => {
  test('it answers {ok, traces}', async () => {
    traceRows = [{ id: 'a' }, { id: 'b' }]
    const body = (await (await get('?limit=2')).json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true, traces: [{ id: 'a' }, { id: 'b' }] })
  })

  test('an empty buffer is 200 with an empty array', async () => {
    traceRows = []
    const body = (await (await get('')).json()) as { traces: unknown[] }
    expect(body.traces).toEqual([])
  })

  test('it enters the session org context', async () => {
    await get('')
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test('a buffer read failure is 500 without leaking the error text', async () => {
    tracesThrow = new Error('ring buffer corrupted')
    const res = await get('')
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('ring buffer corrupted')
  })
})

describe('/api/traces/stats', () => {
  test('it answers {ok, stats}', async () => {
    statsPayload = { total: 9, errors: 2, p95Ms: 120 }
    const body = (await (await get('', 'stats')).json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true, stats: { total: 9, errors: 2, p95Ms: 120 } })
  })

  test('it takes NO query parameters (no clamping to pin)', async () => {
    // Explicitly recorded: /stats reports the whole buffer, so a caller cannot narrow it here. The handler takes
    // no argument at all, which is why the call site passes none.
    const res = await get('?limit=1', 'stats')
    const body = (await res.json()) as { stats: unknown }
    expect(body.stats).toEqual(statsPayload)
    expect(limitArgs).toHaveLength(0)
  })

  test('it enters the session org context', async () => {
    await get('', 'stats')
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test('empty stats are a success, not an error', async () => {
    statsPayload = {}
    const body = (await (await get('', 'stats')).json()) as { ok: boolean; stats: unknown }
    expect(body.ok).toBe(true)
    expect(body.stats).toEqual({})
  })
})
