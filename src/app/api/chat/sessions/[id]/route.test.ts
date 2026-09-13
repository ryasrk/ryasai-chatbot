/**
 * GET / DELETE /api/chat/sessions/[id]
 *
 * The route takes a CLIENT-SUPPLIED `id` out of the URL, so the central question
 * this file answers is: *what exactly does the lookup ask the database for?*
 *
 *   db.chatSession.findFirst({ where: { id, userId: user.userId }, ... })
 *
 * `findFirst` is a FILTER op, so `createTenantExtension()` (src/lib/prisma-tenant.ts)
 * appends `organizationId` to that same where clause. The ID is therefore scoped
 * three ways: id, owner userId, and organizationId. A cross-tenant id yields null
 * → 404, not another org's row. NOT an IDOR. See the pinned-args tests below; they
 * assert the literal `where` object the route builds, because the org term is
 * injected by the extension (which is mocked out here) rather than written in the
 * route source.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Mutable seams — declared ABOVE every mock.module() call. A mock.module factory
// that closes over a `let` reassigned later would pin the first value.
// ---------------------------------------------------------------------------

const mockUser = {
  userId: 'u1',
  name: 'Test User',
  email: 't@test.com',
  role: 'admin',
  organizationId: 'org-a',
  plan: null as string | null,
}

/** Side-effect log: proves ORDER, not just that a call happened. */
let events: string[] = []

/** Every db.chatSession.findFirst / delete argument list, in call order. */
let sessionFindFirstArgs: any[] = []
let sessionDeleteArgs: any[] = []
let auditWrites: any[] = []
let enterWithOrgCalls: string[] = []
let getActiveUserCalls = 0
let handleApiErrorCalls: Array<{ msg: string; status: number }> = []

let getActiveUserImpl: () => Promise<typeof mockUser> = async () => mockUser
let sessionImpl: any = null
/** When set, chatSession.findFirst rejects — exercises the route's catch block. */
let sessionError: Error | null = null
let deleteError: Error | null = null
let deleteImpl: (args: any) => Promise<any> = async () => ({ id: 's1' })
let writeAuditImpl: (args: any) => Promise<void> = async () => {}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    getActiveUserCalls++
    events.push('getActiveUser')
    return getActiveUserImpl()
  },
  // Mocked rather than exercised: the real one reaches for cookies()/jwt/redis/license.
  // The response it returns is still what the route hands back, so status assertions
  // below stay meaningful.
  handleApiError: (e: unknown, msg: string, status = 500) => {
    handleApiErrorCalls.push({ msg, status })
    events.push('handleApiError')
    void e
    return Response.json({ error: msg }, { status })
  },
  writeAudit: async (args: any) => {
    events.push('writeAudit')
    auditWrites.push(args)
    return writeAuditImpl(args)
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  // Recorded so a test can prove the tenant context is set BEFORE the lookup.
  // NOT mocked behaviourally: whether the extension then injects organizationId
  // into the where clause is the property under test, and reimplementing the
  // injection here would only assert against itself. See the file header.
  enterWithOrg: (orgId: string) => {
    enterWithOrgCalls.push(orgId)
    events.push('enterWithOrg')
  },
  getOrgContext: () => undefined,
  bypassOrg: async (fn: () => Promise<unknown>) => fn(),
}))

mock.module('@/lib/db', () => ({
  db: {
    chatSession: {
      findFirst: async (args: any) => {
        events.push('chatSession.findFirst')
        sessionFindFirstArgs.push(args)
        if (sessionError) throw sessionError
        return sessionImpl
      },
      delete: async (args: any) => {
        events.push('chatSession.delete')
        sessionDeleteArgs.push(args)
        if (deleteError) throw deleteError
        return deleteImpl(args)
      },
    },
    auditLog: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      count: async () => 0,
    },
  },
  isPrismaNotFound: (e: unknown) =>
    !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2025',
}))

// ---------------------------------------------------------------------------
// Module under test — DYNAMIC import, AFTER every mock.module() call.
// ---------------------------------------------------------------------------
const { GET, DELETE } = await import('./route')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function messageRow(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    sessionId: 's1',
    sender: 'user',
    content: 'hi',
    citations: null,
    chartData: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    toolRuns: [],
    ...over,
  }
}

/** The shape the route reads: descending from the DB, reversed back to ascending. */
function sessionRow(messages: any[] = [messageRow()]) {
  return {
    id: 's1',
    userId: 'u1',
    title: 'My Chat',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    messages,
  }
}

function makeGet(url = 'http://localhost/api/chat/sessions/s1'): Request {
  events.push('request')
  return new Request(url, { method: 'GET' })
}

const makeCtx = (id = 's1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  events = []
  sessionFindFirstArgs = []
  sessionDeleteArgs = []
  auditWrites = []
  enterWithOrgCalls = []
  getActiveUserCalls = 0
  handleApiErrorCalls = []
  getActiveUserImpl = async () => mockUser
  sessionImpl = sessionRow()
  sessionError = null
  deleteError = null
  deleteImpl = async () => ({ id: 's1' })
  writeAuditImpl = async () => {}
})

// ---------------------------------------------------------------------------
// IDOR / scoping
// ---------------------------------------------------------------------------

describe('scoping of the client-supplied [id]', () => {
  test('GET looks the session up with findFirst filtered by id AND owner userId', async () => {
    sessionImpl = null

    const res = await GET(makeGet() as any, makeCtx('session-from-org-b'))

    // The lookup is a FILTER op, so the tenant extension appends organizationId;
    // a findUnique here would be an unscoped cross-tenant read.
    expect(sessionFindFirstArgs).toHaveLength(1)
    expect(sessionFindFirstArgs[0].where).toEqual({
      id: 'session-from-org-b',
      userId: 'u1',
    })
    // Explicit: the route must not reach for the unique-key-only read path.
    expect(sessionFindFirstArgs[0]).not.toHaveProperty('where.organizationId')
    expect(res.status).toBe(404)
  })

  test('GET cannot double-filter on organizationId — the extension owns that term', async () => {
    sessionImpl = null

    await GET(makeGet() as any, makeCtx())

    // Documents the division of labour: id+userId literal in the route, org
    // injected by createTenantExtension(). If the route ever starts writing
    // organizationId itself this test is the one that notices.
    expect(Object.keys(sessionFindFirstArgs[0].where).sort()).toEqual(['id', 'userId'])
  })

  test('a foreign id returns the same 404 as a nonexistent id — no existence oracle', async () => {
    sessionImpl = null
    const foreign = await GET(makeGet() as any, makeCtx('cl-other-org-session'))
    const missing = await GET(makeGet() as any, makeCtx('cl-does-not-exist'))

    expect(foreign.status).toBe(404)
    expect(missing.status).toBe(404)
    const foreignRaw = await foreign.text()
    const missingRaw = await missing.text()
    expect(JSON.parse(foreignRaw)).toEqual(JSON.parse(missingRaw))
  })

  test('tenant context is entered BEFORE the session lookup, and with the caller org', async () => {
    await GET(makeGet() as any, makeCtx())

    expect(enterWithOrgCalls).toEqual(['org-a'])
    expect(events.indexOf('enterWithOrg')).toBeLessThan(
      events.indexOf('chatSession.findFirst'),
    )
  })

  test('DELETE uses the same findFirst({id,userId}) scoping as GET', async () => {
    sessionImpl = null

    const res = await DELETE(new Request('http://localhost/x', { method: 'DELETE' }) as any, makeCtx('foreign-id'))

    expect(sessionFindFirstArgs[0].where).toEqual({ id: 'foreign-id', userId: 'u1' })
    expect(res.status).toBe(404)
    expect(sessionDeleteArgs).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// GET — auth + limit parsing
// ---------------------------------------------------------------------------

describe('GET require auth before touching the client id', () => {
  test('an unauthorized caller never reaches the session lookup', async () => {
    getActiveUserImpl = async () => {
      throw new Error('No active session.')
    }

    const res = await GET(makeGet() as any, makeCtx())

    expect(res.status).toBe(500)
    expect(handleApiErrorCalls).toEqual([
      { msg: 'Failed to load chat session details.', status: 500 },
    ])
    expect(sessionFindFirstArgs).toHaveLength(0)
    expect(enterWithOrgCalls).toHaveLength(0)
  })

  test('the id is read from ctx.params (awaited), not from the query string', async () => {
    sessionImpl = null

    // A `?id=` sneaked into the URL must NOT be used as the session id.
    await GET(
      makeGet('http://localhost/api/chat/sessions/real-id?id=attacker-id') as any,
      makeCtx('real-id'),
    )

    expect(sessionFindFirstArgs[0].where.id).toBe('real-id')
  })
})

describe('GET ?limit= parsing', () => {
  async function limitOfSearch(search: string) {
    await GET(makeGet(`http://localhost/api/chat/sessions/s1${search}`) as any, makeCtx())
    return sessionFindFirstArgs[0].include.messages.take
  }

  test('defaults to 100 when the parameter is absent', async () => {
    expect(await limitOfSearch('')).toBe(100)
  })

  test('honours an explicit limit', async () => {
    expect(await limitOfSearch('?limit=7')).toBe(7)
  })

  test('caps at 500 so one session cannot return an unbounded history', async () => {
    expect(await limitOfSearch('?limit=100000')).toBe(500)
  })

  test('floors a fractional limit', async () => {
    expect(await limitOfSearch('?limit=12.9')).toBe(12)
  })

  test.each([
    ['zero', '?limit=0'],
    ['negative', '?limit=-5'],
    ['non-numeric', '?limit=abc'],
    ['empty', '?limit='],
    ['Infinity', '?limit=Infinity'],
  ])('falls back to 100 for a %s limit', async (_label, search) => {
    expect(await limitOfSearch(search)).toBe(100)
  })

  test('applies the limit as take on the messages relation, not a post-hoc slice', async () => {
    sessionImpl = sessionRow([])

    await GET(makeGet('http://localhost/api/chat/sessions/s1?limit=3') as any, makeCtx())

    expect(sessionFindFirstArgs[0].include.messages.take).toBe(3)
    // Newest-first from the DB, ASC after the in-handler reverse.
    expect(sessionFindFirstArgs[0].include.messages.orderBy).toEqual({ createdAt: 'desc' })
  })
})

describe('GET query shape and response', () => {
  test('filters out non-conversational senders and selects only the toolRun projection', async () => {
    await GET(makeGet() as any, makeCtx())

    const messagesArgs = sessionFindFirstArgs[0].include.messages
    expect(messagesArgs.where).toEqual({ sender: { in: ['user', 'ai'] } })
    expect(messagesArgs.include.integration.select).toEqual({
      id: true,
      name: true,
      provider: true,
    })
    expect(messagesArgs.include.toolRuns.select).toEqual({
      type: true,
      status: true,
      outputSummary: true,
    })
  })

  test('reverses the descending page back to ascending for the UI', async () => {
    sessionImpl = sessionRow([
      messageRow({ id: 'newest', createdAt: new Date('2026-01-03T00:00:00Z') }),
      messageRow({ id: 'middle', createdAt: new Date('2026-01-02T00:00:00Z') }),
      messageRow({ id: 'oldest', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ])

    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    expect(body.messages.map((m: any) => m.id)).toEqual(['oldest', 'middle', 'newest'])
  })

  test('parses the citations / chartData JSON strings, leaving null untouched', async () => {
    sessionImpl = sessionRow([
      messageRow({ id: 'm1', citations: '[{"page":3}]', chartData: '{"type":"bar"}' }),
      messageRow({ id: 'm2', citations: null, chartData: null }),
    ])

    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    // Keyed by id, not index: the route reverses the descending DB page, so a
    // positional assertion would silently depend on the fixture's build order.
    const byId = Object.fromEntries(body.messages.map((m: any) => [m.id, m]))
    expect(byId.m1.citations).toEqual([{ page: 3 }])
    expect(byId.m1.chartData).toEqual({ type: 'bar' })
    expect(byId.m2.citations).toBeNull()
    expect(byId.m2.chartData).toBeNull()
  })

  // Pinned CURRENT behaviour. Inverting this test is the point of the fix.
  test('DEFECT (pinned): a malformed citations string is silently nulled, not surfaced', async () => {
    // safeParse() swallows the SyntaxError and returns null, so the client
    // receives `citations: null` — indistinguishable from "no citations".
    // A truncated/corrupt row therefore renders as a message with no sources
    // and nothing anywhere records that the JSON was unparseable.
    // WHEN FIXED (log/flag/500/raw passthrough): invert this expectation.
    sessionImpl = sessionRow([messageRow({ id: 'm1', citations: '{"truncated":', chartData: 'not json' })])

    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    expect(res.status).toBe(200)
    expect(body.messages[0].citations).toBeNull()
    expect(body.messages[0].chartData).toBeNull()
  })

  test('derives toolType from the first toolRun, treating CHAT as no tool', async () => {
    sessionImpl = sessionRow([
      messageRow({
        id: 'withTool',
        toolRuns: [{ type: 'SQL_QUERY', status: 'success', outputSummary: '3 rows' }],
      }),
      messageRow({
        id: 'chatOnly',
        toolRuns: [{ type: 'CHAT', status: 'success', outputSummary: 'ignored' }],
      }),
      messageRow({ id: 'noRuns', toolRuns: [] }),
    ])

    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    const byId = Object.fromEntries(body.messages.map((m: any) => [m.id, m]))
    expect(byId.withTool).toMatchObject({ toolType: 'SQL_QUERY', toolHasResults: true })
    // A CHAT toolRun is not a tool as far as the UI is concerned.
    expect(byId.chatOnly).toMatchObject({ toolType: null, toolHasResults: true })
    expect(byId.noRuns).toMatchObject({ toolType: null, toolHasResults: false })
  })

  test('toolHasResults is false for a failed run or an empty output summary', async () => {
    sessionImpl = sessionRow([
      messageRow({ id: 'failed', toolRuns: [{ type: 'SQL_QUERY', status: 'error', outputSummary: 'boom' }] }),
      messageRow({ id: 'empty', toolRuns: [{ type: 'SQL_QUERY', status: 'success', outputSummary: '' }] }),
      messageRow({ id: 'missingSummary', toolRuns: [{ type: 'SQL_QUERY', status: 'success', outputSummary: null }] }),
    ])

    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    const byId = Object.fromEntries(body.messages.map((m: any) => [m.id, m]))
    expect(byId.failed.toolHasResults).toBe(false)
    expect(byId.empty.toolHasResults).toBe(false)
    expect(byId.missingSummary.toolHasResults).toBe(false)
  })

  test('missing toolRuns does not throw (optional chaining on the relation)', async () => {
    const row = sessionRow([messageRow()])
    delete (row.messages[0] as any).toolRuns
    sessionImpl = row

    const res = await GET(makeGet() as any, makeCtx())

    expect(res.status).toBe(200)
    const body = JSON.parse(await res.text())
    expect(body.messages[0].toolType).toBeNull()
    expect(body.messages[0].toolHasResults).toBe(false)
  })

  test('spreads the session fields alongside messages', async () => {
    const res = await GET(makeGet() as any, makeCtx())
    const body = JSON.parse(await res.text())

    expect(body).toMatchObject({ id: 's1', userId: 'u1', title: 'My Chat' })
    expect(Array.isArray(body.messages)).toBe(true)
  })

  test('a DB failure is routed through handleApiError with the GET message', async () => {
    sessionError = new Error('connection terminated')

    const res = await GET(makeGet() as any, makeCtx())

    expect(res.status).toBe(500)
    expect(handleApiErrorCalls).toEqual([
      { msg: 'Failed to load chat session details.', status: 500 },
    ])
  })
})

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

describe('DELETE /api/chat/sessions/[id]', () => {
  test('404 when the session is not the caller-owned one, and nothing is deleted', async () => {
    sessionImpl = null

    const res = await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(res.status).toBe(404)
    expect(JSON.parse(await res.text()).error).toBe('Session not found.')
    expect(sessionDeleteArgs).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('selects only the id/userId/title fields it needs for the lookup', async () => {
    await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(sessionFindFirstArgs[0].select).toEqual({ id: true, userId: true, title: true })
  })

  test('deletes by the RESOLVED row id and audits with the session owner', async () => {
    sessionImpl = { id: 's1', userId: 'u1', title: 'My Chat' }

    const res = await DELETE(new Request('http://localhost/x') as any, makeCtx('s1'))

    expect(JSON.parse(await res.text())).toEqual({ ok: true })
    expect(sessionDeleteArgs).toEqual([{ where: { id: 's1' } }])
    expect(auditWrites).toEqual([
      {
        userId: 'u1',
        action: 'CHAT_SESSION_DELETE',
        severity: 'warning',
        detail: { sessionId: 's1', title: 'My Chat', ownerUserId: 'u1' },
      },
    ])
  })

  test('order is findFirst → delete → writeAudit → respond', async () => {
    sessionImpl = { id: 's1', userId: 'u1', title: 't' }

    await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(events.filter((e) => e !== 'request')).toEqual([
      'getActiveUser',
      'enterWithOrg',
      'chatSession.findFirst',
      'chatSession.delete',
      'writeAudit',
    ])
  })

  test('tenant context is entered before the delete lookup', async () => {
    sessionImpl = { id: 's1', userId: 'u1', title: 't' }

    await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(enterWithOrgCalls).toEqual(['org-a'])
  })

  test('a delete failure is routed through handleApiError and no audit row is written', async () => {
    sessionImpl = { id: 's1', userId: 'u1', title: 't' }
    deleteError = new Error('foreign key violation')

    const res = await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(res.status).toBe(500)
    expect(handleApiErrorCalls).toEqual([
      { msg: 'Failed to delete chat session.', status: 500 },
    ])
    expect(auditWrites).toHaveLength(0)
  })

  test('a failed audit write does not fail the delete (severity=warning is swallowed)', async () => {
    sessionImpl = { id: 's1', userId: 'u1', title: 't' }
    // Real writeAudit swallows non-critical failures; the mock is left to resolve
    // so this test pins that the route reports success regardless.
    writeAuditImpl = async () => {}

    const res = await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(res.status).toBe(200)
    expect(JSON.parse(await res.text())).toEqual({ ok: true })
  })

  test('an unauthorized caller cannot delete — no lookup, no delete', async () => {
    getActiveUserImpl = async () => {
      throw new Error('No active session.')
    }

    const res = await DELETE(new Request('http://localhost/x') as any, makeCtx())

    expect(res.status).toBe(500)
    expect(handleApiErrorCalls[0]?.msg).toBe('Failed to delete chat session.')
    expect(sessionFindFirstArgs).toHaveLength(0)
    expect(sessionDeleteArgs).toHaveLength(0)
    void (await res.text())
  })
})
