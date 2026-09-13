import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { parseAuditPagination } from './route'

describe('audit pagination', () => {
  test('caps page size at 20 events per page', () => {
    const pagination = parseAuditPagination(new URLSearchParams('page=1&pageSize=50'))

    expect(pagination).toEqual({ page: 1, pageSize: 20 })
  })
})

// ===========================================================================
// GET — the audit-log read path
// ===========================================================================
//
// One test of parseAuditPagination left the whole handler at 38.24% executable.
// This is the AUDIT LOG: who did what, when. An unscoped or unfiltered read is a
// compliance problem, and the tenant scoping depends entirely on enterWithOrg
// running BEFORE the query.

const state = {
  user: { id: 'u1', organizationId: 'org-1', name: 'Admin', email: 'a@b.c', role: 'admin' },
  getActiveUserThrows: null as Error | null,
  items: [] as Array<Record<string, unknown>>,
  total: 0,
  findManyArgs: [] as Array<Record<string, unknown>>,
  countArgs: [] as Array<Record<string, unknown>>,
  enterWithOrgCalls: [] as string[],
  apiError: null as Error | null,
}

mock.module('@/lib/db', () => ({
  db: {
    auditLog: {
      findMany: async (a: Record<string, unknown>) => { state.findManyArgs.push(a); return state.items },
      count: async (a: Record<string, unknown>) => { state.countArgs.push(a); return state.total },
    },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (org: string) => { state.enterWithOrgCalls.push(org) },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    if (state.getActiveUserThrows) throw state.getActiveUserThrows
    return state.user
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    state.apiError = e as Error
    return Response.json({ error: fallback }, { status })
  },
}))

const { GET } = await import('./route')

function req(query = '') {
  return { nextUrl: new URL(`http://x/api/audit${query}`) } as never
}

beforeEach(() => {
  state.user = { id: 'u1', organizationId: 'org-1', name: 'Admin', email: 'a@b.c', role: 'admin' }
  state.getActiveUserThrows = null
  state.items = []
  state.total = 0
  state.findManyArgs = []
  state.countArgs = []
  state.enterWithOrgCalls = []
  state.apiError = null
})

describe('GET /api/audit — tenancy', () => {
  test('enters the ACTIVE USER org before querying', async () => {
    // The whole read is tenant-scoped only because the Prisma extension sees an org
    // context. If enterWithOrg ran after the query -- or not at all -- the audit log
    // would be read unscoped, i.e. another company's events in the response.
    await GET(req())
    expect(state.enterWithOrgCalls).toEqual(['org-1'])
    expect(state.findManyArgs).toHaveLength(1)
  })

  test('an unauthenticated request is routed through handleApiError', async () => {
    // getActiveUser throws UnauthorizedError; the route must not leak it as a 500
    // with a driver message.
    state.getActiveUserThrows = new Error('No active session.')
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Failed to load audit log.' })
    // And NOTHING was queried.
    expect(state.findManyArgs).toHaveLength(0)
    expect(state.enterWithOrgCalls).toEqual([])
  })
})

describe('GET /api/audit — filters', () => {
  test('a valid severity becomes a filter', async () => {
    await GET(req('?severity=critical'))
    expect((state.findManyArgs[0].where as { severity?: string }).severity).toBe('critical')
  })

  test('an UNKNOWN severity is IGNORED, not passed through', async () => {
    // The allow-list matters: forwarding an arbitrary string would let a caller probe
    // for values that happen to exist, and an unexpected enum reaching a Postgres
    // comparison can error rather than return empty.
    await GET(req('?severity=../../etc'))
    expect((state.findManyArgs[0].where as { severity?: string }).severity).toBeUndefined()
  })

  test('an action filter is a substring match', async () => {
    await GET(req('?action=LOGIN'))
    expect((state.findManyArgs[0].where as { action?: { contains: string } }).action)
      .toEqual({ contains: 'LOGIN' })
  })

  test('an empty-string severity and action are treated as absent', async () => {
    await GET(req('?severity=&action='))
    const where = state.findManyArgs[0].where as Record<string, unknown>
    expect(where.severity).toBeUndefined()
    expect(where.action).toBeUndefined()
  })

  test('the SAME filters reach both the page query and the count', async () => {
    // They must agree, or `total` describes a different result set than `items` and
    // the UI paginates past the end.
    await GET(req('?severity=warning&action=LOGIN'))
    expect(state.countArgs[0].where).toEqual(state.findManyArgs[0].where)
  })
})

describe('GET /api/audit — pagination and shape', () => {
  test('skip/take come from the parsed page, and the order is newest-first', async () => {
    await GET(req('?page=3&pageSize=10'))
    const args = state.findManyArgs[0]
    expect(args.skip).toBe(20)
    expect(args.take).toBe(10)
    // An audit log read oldest-first is useless for incident review.
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })

  test('each row carries the ACTOR identity', async () => {
    // Without the user relation the log says what happened but not who -- which is
    // the only reason the table exists.
    await GET(req())
    expect((state.findManyArgs[0].include as { user: unknown }).user).toBeDefined()
  })

  test('the response reports items, total and the EFFECTIVE page/pageSize', async () => {
    state.items = [{ id: 'a1' }]
    state.total = 42
    const res = await GET(req('?page=2&pageSize=999'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ items: [{ id: 'a1' }], total: 42, page: 2, pageSize: 20 })
  })
})
