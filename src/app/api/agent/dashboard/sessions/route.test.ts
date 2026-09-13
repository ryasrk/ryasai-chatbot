/**
 * GET/POST /api/agent/dashboard/sessions — the agentic session list, transcript reader, and session creator.
 *
 * WHY THIS FILE EXISTS. This route reads chat transcripts, and three things about it are easy to get wrong:
 *
 *   1. THE TWO QUERIES FILTER ON DIFFERENT SENDER SETS, ON PURPOSE. The session LIST counts `['user','agent']`,
 *      while the DASHBOARD's own history loader uses `['user','ai']`. The agent dashboard persists its answers
 *      as `agent`, so counting `ai` here would make every agentic session look empty.
 *   2. THE LIST IS FILTERED BY TITLE PREFIX `[Agent]`. That prefix is the ONLY thing separating agentic
 *      sessions from ordinary chat sessions, so dropping the filter silently merges two product surfaces.
 *   3. `sessionId` SWITCHES THE RESPONSE SHAPE. `?sessionId=` returns `{messages}`; without it the route returns
 *      `{sessions}`. A caller reading `.sessions` from the transcript branch gets undefined rather than an error.
 *
 * Also pinned: `requireRole(user, 'analyst')` on BOTH methods, the org context entered before any DB access, the
 * `createdAt: 'asc'` transcript ordering, the nested `_count` filter, the title fallback, and that the session
 * is created with the SESSION's org and user rather than values from the body.
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
let user: typeof analystUser = analystUser

let messages: Array<Record<string, unknown>> = []
let sessions: Array<Record<string, unknown>> = []
let createResult: Record<string, unknown> = { id: 's-new', title: '[Agent] x' }

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const roleChecks: Array<{ required: string }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    roleChecks.push({ required })
    if (!u || (u.role !== 'admin' && u.role !== 'analyst')) {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ ok: false, error: { code: 'FORBIDDEN' } }, { status: 403 })
    }
    return Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    chatMessage: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'chatMessage', op: 'findMany', args })
        return messages
      },
    },
    chatSession: {
      findMany: async (args: Record<string, unknown>) => {
        calls.push({ model: 'chatSession', op: 'findMany', args })
        return sessions
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'chatSession', op: 'create', args })
        events.push('chatSession.create')
        return { ...createResult, ...(args.data as Record<string, unknown>) }
      },
    },
  },
}))

import { GET, POST } from './route'

function get(query = '') {
  const url = `http://localhost/api/agent/dashboard/sessions${query}`
  const req = new Request(url) as Request & { nextUrl: URL }
  req.nextUrl = new URL(url)
  return GET(req as never)
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/agent/dashboard/sessions', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const q = () => calls[0]!

beforeEach(() => {
  user = analystUser
  messages = []
  sessions = []
  createResult = { id: 's-new', title: '[Agent] x' }
  events.length = 0
  calls.length = 0
  roleChecks.length = 0
})

describe('GET — the transcript branch', () => {
  test('an explicit sessionId reads MESSAGES, not sessions', async () => {
    await get('?sessionId=s1')
    expect(q().model).toBe('chatMessage')
    expect(calls.filter((c) => c.model === 'chatSession')).toHaveLength(0)
  })

  test('the transcript contains user and AGENT messages, never ai', async () => {
    // The dashboard persists its answers under sender 'agent'. Selecting 'ai' here would return a transcript
    // with every agentic answer missing.
    await get('?sessionId=s1')
    expect(q().args.where).toEqual({ sessionId: 's1', sender: { in: ['user', 'agent'] } })
  })

  test('the transcript is ordered OLDEST FIRST', async () => {
    // A transcript read newest-first would render the conversation backwards.
    await get('?sessionId=s1')
    expect(q().args.orderBy).toEqual({ createdAt: 'asc' })
  })

  test('the transcript selects the render fields, including citations and chartData', async () => {
    await get('?sessionId=s1')
    expect(q().args.select).toEqual({
      id: true,
      sender: true,
      text: true,
      status: true,
      citations: true,
      chartData: true,
      createdAt: true,
    })
  })

  test('it answers {messages} and does NOT also carry a sessions key', async () => {
    messages = [{ id: 'm1', sender: 'user', text: 'hi' }]
    const body = (await (await get('?sessionId=s1')).json()) as Record<string, unknown>
    expect(body).toEqual({ ok: true, messages })
    expect('sessions' in body).toBe(false)
  })

  test('an EMPTY sessionId falls through to the list branch', async () => {
    // `searchParams.get` returns '' for `?sessionId=`, and an empty string is falsy -- so the list is returned
    // rather than querying messages for session ''.
    await get('?sessionId=')
    expect(calls.filter((c) => c.model === 'chatMessage')).toHaveLength(0)
    expect(calls.filter((c) => c.model === 'chatSession')).toHaveLength(1)
  })

  test('an empty transcript is still 200 with an empty array', async () => {
    const body = (await (await get('?sessionId=none')).json()) as { messages: unknown[] }
    expect(body.messages).toEqual([])
  })
})

describe('GET — the session list branch', () => {
  test('the list is filtered by the [Agent] title prefix', async () => {
    // That prefix is the only thing separating agentic sessions from ordinary chat sessions.
    await get()
    expect(q().model).toBe('chatSession')
    expect(q().args.where).toEqual({ title: { startsWith: '[Agent]' } })
  })

  test('the list is ordered by updatedAt DESC', async () => {
    await get()
    expect(q().args.orderBy).toEqual({ updatedAt: 'desc' })
  })

  test('the message count filters on user and AGENT, matching the transcript branch', async () => {
    // A count that used 'ai' would show 0 for every session whose answers were stored as 'agent', which is
    // exactly the kind of off-by-one-sender mismatch that makes a dashboard look broken.
    await get()
    const select = q().args.select as Record<string, unknown>
    expect(select._count).toEqual({
      select: { messages: { where: { sender: { in: ['user', 'agent'] } } } },
    })
  })

  test('the list selects the summary fields', async () => {
    await get()
    expect(Object.keys(q().args.select as Record<string, unknown>).sort()).toEqual([
      '_count',
      'createdAt',
      'id',
      'title',
      'updatedAt',
    ])
  })

  test('it answers {sessions} and never returns the message text', async () => {
    sessions = [{ id: 's1', title: '[Agent] A', _count: { messages: 3 } }]
    const raw = await (await get()).text()
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(body).toEqual({ ok: true, sessions })
    expect(raw).not.toContain('chatMessage')
  })

  test('an empty list is 200 with an empty array', async () => {
    const body = (await (await get()).json()) as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })
})

describe('authorisation and context', () => {
  test('GET requires the analyst role', async () => {
    await get()
    expect(roleChecks).toEqual([{ required: 'analyst' }])
  })

  test('POST requires the analyst role', async () => {
    await post({ title: 'x' })
    expect(roleChecks).toEqual([{ required: 'analyst' }])
  })

  test('a viewer is refused on GET and no query runs', async () => {
    user = { ...analystUser, role: 'viewer' }
    const res = await get()
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  test('a viewer is refused on POST and no session is created', async () => {
    user = { ...analystUser, role: 'viewer' }
    const res = await post({ title: 'x' })
    expect(res.status).toBe(403)
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(0)
  })

  test('GET enters the org context before reading anything', async () => {
    await get()
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('POST enters the org context before creating anything', async () => {
    await post({ title: 'x' })
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('chatSession.create'))
  })
})

describe('POST — session creation', () => {
  test('the title is trimmed', async () => {
    await post({ title: '  My Session  ' })
    expect(calls[0]!.args.data).toMatchObject({ title: 'My Session' })
  })

  test('a missing title falls back to an [Agent]-prefixed default', async () => {
    // The default MUST keep the prefix, or the session would not appear in the list this same route serves.
    await post({})
    const title = (calls[0]!.args.data as { title: string }).title
    expect(title.startsWith('[Agent] ')).toBe(true)
  })

  test('a WHITESPACE-only title also falls back to the default', async () => {
    await post({ title: '   ' })
    const title = (calls[0]!.args.data as { title: string }).title
    expect(title.startsWith('[Agent] ')).toBe(true)
  })

  test('the org and user come from the SESSION, never from the body', async () => {
    // A body-supplied organizationId would be a tenant-confusion hole; the route ignores it entirely.
    await post({ title: 'x', organizationId: 'org-evil', userId: 'u-evil' })
    expect(calls[0]!.args.data).toMatchObject({ organizationId: 'org-1', userId: 'u1' })
  })

  test('it answers ok:true with the created session', async () => {
    const body = (await (await post({ title: 'x' })).json()) as { ok: boolean; session: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.session.id).toBe('s-new')
  })

  test('a malformed JSON body still creates a session with the default title', async () => {
    // Pinned as-is: the body parse is caught to {}, so a broken client payload produces a valid session rather
    // than a 400. Consistent with the rest of the surface, and worth knowing.
    const res = await post('not json')
    expect(res.status).toBe(200)
    const title = (calls[0]!.args.data as { title: string }).title
    expect(title.startsWith('[Agent] ')).toBe(true)
  })
})
