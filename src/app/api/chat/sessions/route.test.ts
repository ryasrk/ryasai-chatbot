import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockUser = { userId: 'u1', name: 'Test', email: 't@t.com' }

let findManyArgs: any = null
let findManyResult: any[] = []
let createData: any = null
let createResult: any = {}

mock.module('@/lib/session', () => ({
  getActiveUser: async () => mockUser,
  handleApiError: (e: unknown, msg: string, status = 500) => Response.json({ error: msg }, { status }),
  writeAudit: async () => {},
}))

mock.module('@/lib/db', () => ({
  db: {
    chatSession: {
      findMany: async (args: any) => {
        findManyArgs = args
        return findManyResult
      },
      create: async (args: any) => {
        createData = args.data
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
