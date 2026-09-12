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

// Mutable state so each test can drive the route without re-mocking.
const dbState = {
  user: { id: 'admin1' } as any,
  session: { id: 'sess1' } as any,
  sessionCreates: 0,
  messageCreates: [] as any[],
  toolRunCreates: 0,
  history: [] as Array<{ sender: string; text: string }>,
  apiLogs: [] as any[],
}

mock.module('@/lib/db', () => ({
  db: {
    apiRequestLog: {
      create: async (a: any) => { dbState.apiLogs.push(a); return {} },
      count: async () => 0,
    },
    user: { findFirst: async () => dbState.user },
    chatSession: {
      findFirst: async () => dbState.session,
      create: async () => { dbState.sessionCreates++; return { id: 'sess-new' } },
      // Derived from the source, not guessed: the route touches
      // chatSession.update to bump updatedAt. A missing method here surfaces as
      // a 500 with the real cause swallowed by handleApiError, which is how the
      // first run of these tests failed.
      update: async () => ({ id: dbState.session?.id ?? 'sess1' }),
    },
    chatMessage: {
      create: async (a: any) => {
        dbState.messageCreates.push(a)
        return { id: `msg${dbState.messageCreates.length}` }
      },
      findMany: async () => dbState.history,
    },
    toolRun: { create: async () => { dbState.toolRunCreates++; return {} } },
  },
}))

mock.module('@/lib/redis', () => ({
  rateLimit: async () => ({ allowed: true, remaining: 59 }),
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => {},
  getOrgContext: () => 'org1',
}))
mock.module('@/lib/metrics', () => ({ inc: () => {}, observe: () => {} }))

mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: async () => ({
    answer: 'mock',
    citations: [],
    chartData: null,
    toolRuns: [],
    integrationId: null,
  }),
  runStreamingChatCompletion: async () => ({
    stream: (async function* () { yield 'Hello'; yield ' world' })(),
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

// ---------------------------------------------------------------------------
// POST pre-stream + SSE body
// ---------------------------------------------------------------------------
// This is the OpenAI-compatible endpoint — the surface a customer's own tooling
// calls with their own key, and the one that made the product "flexible". Its
// validation branches had never been executed (19% lines), so a status-code
// regression here would only surface in a customer's integration.
function post(body: unknown, opts: { auth?: string; } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.auth !== 'none') headers.Authorization = opts.auth ?? 'Bearer test-key'
  return POST(new Request('http://localhost/api/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }) as any)
}

async function drainSse(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe('POST /api/v1/chat/completions — request validation', () => {
  test('a user message with empty content is rejected with 400', async () => {
    const res = await post({ messages: [{ role: 'user', content: '   ' }] })
    // Whitespace-only is the case a naive `!== ''` check lets through.
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('role=user')
    // A rejected request must not create a session or a message.
    expect(dbState.sessionCreates).toBe(0)
    expect(dbState.messageCreates).toHaveLength(0)
  })

  test('messages with only assistant turns is rejected (no user question)', async () => {
    const res = await post({ messages: [{ role: 'assistant', content: 'hi' }] })
    expect(res.status).toBe(400)
  })

  test('an empty messages array is rejected', async () => {
    const res = await post({ messages: [] })
    expect(res.status).toBe(400)
  })

  test('a rejected request is still written to the API request log', async () => {
    dbState.apiLogs = []
    await post({ messages: [] })
    // The log is the customer's only visibility into why a call failed, so a
    // 400 that skips logging is a support ticket waiting to happen.
    expect(dbState.apiLogs.length).toBeGreaterThan(0)
    // writeApiLog wraps the row as { data: {...} } — read the nesting, measured not assumed.
    expect(dbState.apiLogs[0].data.status).toBe(400)
  })

  test('no admin singleton → 500 and it is logged', async () => {
    dbState.user = null
    dbState.apiLogs = []
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('Admin singleton')
    expect(dbState.apiLogs[0].data.status).toBe(500)
    dbState.user = { id: 'admin1' }
  })

  test('an unknown session_id → 404 rather than creating a new session', async () => {
    dbState.session = null
    dbState.sessionCreates = 0
    const res = await post({ session_id: 'does-not-exist', messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(404)
    // Silently creating a session for an id the caller believed existed would
    // scatter one conversation across two ids.
    expect(dbState.sessionCreates).toBe(0)
    dbState.session = { id: 'sess1' }
  })

  test('no session_id creates one', async () => {
    dbState.sessionCreates = 0
    await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(dbState.sessionCreates).toBe(1)
  })

  test('the latest user message is the one asked, not the first', async () => {
    dbState.messageCreates = []
    await post({
      messages: [
        { role: 'user', content: 'FIRST QUESTION' },
        { role: 'assistant', content: 'some answer' },
        { role: 'user', content: 'LATEST QUESTION' },
      ],
    })
    const userRow = dbState.messageCreates.find((m) => m.data.sender === 'user')
    // Multi-turn integrations send the whole thread; picking the first message
    // would answer a stale question and burn tokens doing it.
    expect(userRow.data.text).toBe('LATEST QUESTION')
  })
})

describe('POST /api/v1/chat/completions — non-streaming', () => {
  test('returns the documented envelope (answer / citations / tool_runs)', async () => {
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    const body = await res.json()
    // MEASURED, and it contradicts the endpoint's own label. docs/api-guide.md
    // and docs/PRD.md call this route "OpenAI-compatible" and then document
    // `data.answer` / `data.citations` / `data.tool_runs` — which is what it
    // actually returns. There is NO `choices` array on the non-streaming path,
    // so an OpenAI SDK client pointed at this URL fails with
    // "Cannot read properties of undefined (reading '0')".
    //
    // The STREAMING path does emit `object: 'chat.completion.chunk'` frames, so
    // a client that sets stream:true works and the same client without it does
    // not. Reported as a finding; not changed, because the documented contract
    // is this one and the fix is a product decision (add `choices` for
    // compatibility, or stop calling it OpenAI-compatible).
    expect(body.answer).toBe('mock')
    expect(body.object).toBe('chat.completion')
    expect(body.choices).toBeUndefined()
    expect(Array.isArray(body.citations)).toBe(true)
    expect(Array.isArray(body.tool_runs)).toBe(true)
  })

  test('the assistant reply is persisted with the session', async () => {
    dbState.messageCreates = []
    await post({ messages: [{ role: 'user', content: 'hi' }] })
    // A completion the user cannot see again on reload is half a chat.
    expect(dbState.messageCreates.some((m) => m.data.sender === 'ai')).toBe(true)
  })
})

describe('POST /api/v1/chat/completions — SSE streaming', () => {
  test('stream=true emits OpenAI chunk frames and terminates with [DONE]', async () => {
    const res = await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await drainSse(res)
    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('Hello')
    expect(text).toContain(' world')
    // The terminator is what tells an OpenAI client the stream ended; without it
    // the client hangs open.
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })

  test('each chunk carries a delta and a null finish_reason', async () => {
    const res = await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    const text = await drainSse(res)
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: {'))
    expect(frames.length).toBeGreaterThan(0)
    const first = JSON.parse(frames[0].replace('data: ', ''))
    expect(first.choices[0].delta.content).toBeDefined()
    expect(first.choices[0].finish_reason).toBeNull()
  })

  test('the model is echoed back, defaulting when omitted', async () => {
    const res = await post({ stream: true, model: 'my-model', messages: [{ role: 'user', content: 'hi' }] })
    const text = await drainSse(res)
    const first = JSON.parse(text.split('\n\n').filter((f) => f.startsWith('data: {'))[0].replace('data: ', ''))
    // Clients match on the model name; echoing 'default' for a named model
    // breaks SDK-side routing.
    expect(first.model).toBe('my-model')
  })

  test('the full answer is persisted even though it was streamed', async () => {
    dbState.messageCreates = []
    const res = await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })
    await drainSse(res)
    const ai = dbState.messageCreates.find((m) => m.data.sender === 'ai')
    // Streaming must not cost the transcript: the concatenated chunks are what
    // gets saved, not just the last one.
    expect(ai?.data.text).toBe('Hello world')
  })
})
