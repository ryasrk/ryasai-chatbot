import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockUser = { userId: 'u1', name: 'Test', email: 't@t.com', role: 'admin', organizationId: 'org-default' }

let findManyArgs: any = null
let findManyResult: any[] = []
let createData: any = null
let createResult: any = {}
/** When set, the matching DB call rejects -- exercises the route's catch blocks. */
let listError: Error | null = null
let createError: Error | null = null
const handleApiErrorCalls: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) => {
    // Recorded so a test can prove the route routed its failure through the typed error mapper.
    handleApiErrorCalls.push(msg)
    void e
    return Response.json({ error: msg }, { status })
  },
  writeAudit: async () => {},
}))

mock.module('@/lib/db', () => ({
  db: {
    chatSession: {
      findMany: async (args: any) => {
        findManyArgs = args
        if (listError) throw listError
        return findManyResult
      },
      create: async (args: any) => {
        createData = args.data
        if (createError) throw createError
        return createResult
      },
    },
  },
}))

import { GET, POST } from './route'

beforeEach(() => {
  findManyArgs = null
  findManyResult = []
  createData = null
  createResult = { id: 's1', userId: 'u1', title: 'New Session', createdAt: new Date(), updatedAt: new Date() }
  listError = null
  createError = null
  handleApiErrorCalls.length = 0
})

describe('GET /api/chat/sessions', () => {
  test('returns sessions and filters out [Agent] sessions', async () => {
    findManyResult = [
      { id: 's1', title: 'My Chat', _count: { messages: 5 } },
      { id: 's2', title: 'Another', _count: { messages: 0 } },
    ]
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(2)
    // verify the where clause excludes [Agent] sessions
    expect(findManyArgs.where.title.not.startsWith).toBe('[Agent]')
  })
})

describe('POST /api/chat/sessions', () => {
  test('creates session with provided title', async () => {
    createResult = { id: 's2', userId: 'u1', title: 'My Title', createdAt: new Date(), updatedAt: new Date() }
    const req = new Request('http://localhost/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'My Title' }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(201)
    expect(createData.title).toBe('My Title')
  })

  test('creates session with "New Session" default when title omitted', async () => {
    const req = new Request('http://localhost/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(201)
    expect(createData.title).toBe('New Session')
  })

  test('creates session with default on empty body', async () => {
    const req = new Request('http://localhost/api/chat/sessions', {
      method: 'POST',
    })
    const res = await POST(req as any)
    expect(res.status).toBe(201)
    expect(createData.title).toBe('New Session')
  })
})

describe('chat sessions — the catch blocks', () => {
  test('GET: a DB failure is routed through handleApiError', async () => {
    // Neither catch had ever executed: every existing test produced a successful query. Without the
    // catch the list endpoint rejects instead of returning the route's own message, and the session
    // sidebar renders nothing with no explanation.
    listError = new Error('connection terminated unexpectedly')
    const res = await GET()
    expect(handleApiErrorCalls).toContain('Failed to load chat sessions.')
    expect(res.status).toBe(500)
  })

  test('POST: a DB failure is routed through handleApiError', async () => {
    createError = new Error('deadlock detected')
    const res = await POST(new Request('http://localhost/api/chat/sessions', {
      method: 'POST',
      body: JSON.stringify({ title: 'x' }),
    }) as never)

    expect(handleApiErrorCalls).toContain('Failed to create new chat session.')
    // A create failure must NOT report 201 -- the client would insert a phantom session into its
    // list and then fail to open it.
    expect(res.status).toBe(500)
  })
})
