import { describe, expect, test, mock } from 'bun:test'

class MockUnauthorizedError extends Error {
  readonly code = 'UNAUTHORIZED'
  constructor(msg = 'No active session.') {
    super(msg)
    this.name = 'UnauthorizedError'
  }
}

mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, msg: string, status = 500) => {
    if (e instanceof MockUnauthorizedError) return Response.json({ error: e.message }, { status: 401 })
    return Response.json({ error: msg }, { status })
  },
  UnauthorizedError: MockUnauthorizedError,
}))

mock.module('@/lib/api-keys', () => ({
  requireExternalApiKey: async (req: Request) => {
    const raw = req.headers.get('authorization') ?? ''
    const token = raw.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
    if (!token) throw new MockUnauthorizedError('API key must be sent as Bearer token.')
    return { apiKeyId: 'key1', label: 'test' }
  },
  getBearerToken: (req: Request) => {
    const raw = req.headers.get('authorization') ?? ''
    return raw.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || null
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    apiRequestLog: { create: async () => ({}), count: async () => 0 },
  },
}))

mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: async () => ({
    answer: 'mock',
    citations: [],
    chartData: null,
    toolRuns: [],
    integrationId: null,
  }),
}))

import { OPTIONS, POST, buildSseDataStream, statusForExternalChatError } from './route'

describe('external chat completion error classification', () => {
  test('returns 503 when no LLM provider is configured', () => {
    expect(
      statusForExternalChatError(
        new Error('LLM not configured. Open Settings → AI Configuration and set up endpoint + API key before using Chat.'),
      ),
    ).toBe(503)
  })

  test('builds an SSE stream ending with DONE', () => {
    const stream = buildSseDataStream([
      { id: 'chunk_1', choices: [{ delta: { content: 'Halo' } }] },
    ])

    expect(stream).toContain('data: {"id":"chunk_1"')
    expect(stream.endsWith('data: [DONE]\n\n')).toBe(true)
  })
})

describe('OPTIONS /api/v1/chat/completions', () => {
  test('returns 204 with CORS headers', async () => {
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS')
    expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Authorization')
  })
})

describe('POST /api/v1/chat/completions', () => {
  test('returns 401 without API key', async () => {
    const req = new Request('http://localhost/api/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(401)
  })

  test('returns 400 with missing messages and includes CORS headers', async () => {
    const req = new Request('http://localhost/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({}),
    })
    const res = await POST(req as any)
    expect(res.status).toBe(400)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
