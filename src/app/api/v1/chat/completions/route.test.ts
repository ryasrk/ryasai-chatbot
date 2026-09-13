import { describe, expect, test, mock, beforeEach } from 'bun:test'

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
    // organizationId is REQUIRED by the route: tool-run rows are scoped to
    // identity.organizationId, not to getOrgContext(). Omitting it made a tool run
    // persist with organizationId undefined, and my first assertion on 'org1' failed
    // for the right reason — the mock, not the route, was incomplete.
    return { apiKeyId: 'key1', label: 'test', organizationId: 'org1', requestLimitPerMinute: 60 }
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
  toolRunCreateArgs: [] as any[],
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
    toolRun: {
      create: async (a: any) => {
        dbState.toolRunCreates++
        dbState.toolRunCreateArgs.push(a)
        // Mirror what Prisma returns for the `select` in the route. Returning {}
        // made the response's tool_runs render as [{},{}] — the route maps the
        // CREATED row back out, so an empty fake silently empties the API response.
        return {
          id: `tr${dbState.toolRunCreates}`,
          type: a.data.type,
          status: a.data.status,
          latencyMs: a.data.latencyMs,
          restApiEndpointId: a.data.restApiEndpointId,
        }
      },
    },
  },
}))

// Mutable so a test can drive throttling without re-mocking.
const rateLimitState = {
  result: { allowed: true, remaining: 59 } as { allowed: boolean; remaining: number } | null,
  keys: [] as string[],
  limits: [] as number[],
}
mock.module('@/lib/redis', () => ({
  rateLimit: async (key: string, limit: number) => {
    rateLimitState.keys.push(key)
    rateLimitState.limits.push(limit)
    return rateLimitState.result
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: () => {},
  getOrgContext: () => 'org1',
}))
mock.module('@/lib/metrics', () => ({ inc: () => {}, observe: () => {} }))

// Swappable, because the interesting cases are the FAILING completions and the
// ones that return tool runs — neither expressible with a single fixed stub.
const defaultRouter: {
  nonStreaming: (a?: any) => Promise<any>
  streaming: (a?: any) => Promise<any>
} = {
  nonStreaming: async () => ({
    answer: 'mock', citations: [], chartData: null, toolRuns: [], integrationId: null,
  }),
  streaming: async () => ({
    stream: (async function* () { yield 'Hello'; yield ' world' })(),
    citations: [], chartData: null, toolRuns: [], integrationId: null,
  }),
}
const routerState = { ...defaultRouter }
mock.module('@/lib/tool-router', () => ({
  runNonStreamingChatCompletion: (a: any) => routerState.nonStreaming(a),
  runStreamingChatCompletion: (a: any) => routerState.streaming(a),
}))

import { OPTIONS, POST, buildSseDataStream, statusForExternalChatError } from './route'

beforeEach(() => {
  // Every mutable holder back to its default: a leaked 429 or a leaked throwing
  // stub would make the NEXT test measure the wrong thing.
  rateLimitState.result = { allowed: true, remaining: 59 }
  rateLimitState.keys = []
  rateLimitState.limits = []
  routerState.nonStreaming = defaultRouter.nonStreaming
  routerState.streaming = defaultRouter.streaming
  dbState.history = []
  dbState.apiLogs = []
  dbState.toolRunCreates = 0
  dbState.toolRunCreateArgs = []
  dbState.messageCreates = []
})

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

// ---------------------------------------------------------------------------
// The paths an API client actually hits first
//
// Burst rate limiting, the conversation-history hand-off, the streaming failure
// frame, and tool-run persistence. None of these had run, and each is either the
// very first thing a caller sees (429) or the difference between a reply that
// loses its history and one that keeps it.
// ---------------------------------------------------------------------------

describe('POST /api/v1/chat/completions — burst rate limiting', () => {
  test('a caller over the limit gets 429, an X-RateLimit-Remaining of 0, and a log row', async () => {
    // The limit is per API key, so this is the first wall a runaway client hits —
    // and the header is what tells it how long to back off.
    rateLimitState.result = { allowed: false, remaining: 0 }
    dbState.apiLogs = []
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'Rate limit exceeded' })
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0')
    // CORS must survive the rejection, or a browser caller sees an opaque error
    // instead of the 429 and retries immediately.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy()
    // A throttled request is still an event worth auditing.
    expect(dbState.apiLogs.some((l: any) => l.data.status === 429)).toBe(true)
  })

  test('rate limiting is advisory: a null result (Redis down) does NOT block', async () => {
    // requireExternalApiKey falls back to DB-based limiting, so a Redis outage must
    // degrade to "serve the request", not "reject every request".
    rateLimitState.result = null
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).not.toBe(429)
  })

  test('the limit is keyed per API key and uses the key’s own quota', async () => {
    rateLimitState.result = { allowed: true, remaining: 7 }
    await post({ messages: [{ role: 'user', content: 'hi' }] })
    // The key prefix matters: keying by IP would let one tenant throttle another.
    expect(rateLimitState.keys).toContain('api:key1')
    expect(rateLimitState.limits).toContain(60)
  })
})

describe('POST /api/v1/chat/completions — prior turns are handed to the router', () => {
  test('the last 10 messages are reversed into oldest-first, with roles mapped', async () => {
    dbState.history = [
      { sender: 'ai', text: 'second answer' },
      { sender: 'user', text: 'second question' },
      { sender: 'ai', text: 'first answer' },
      { sender: 'user', text: 'first question' },
    ]
    const seen: any[] = []
    routerState.nonStreaming = async (a: any) => {
      seen.push(a)
      return { answer: 'ok', citations: [], chartData: null, toolRuns: [], integrationId: null }
    }
    await post({ messages: [{ role: 'user', content: 'follow up' }] })
    // The DB query is newest-first, so the reversal is what makes the model read the
    // conversation in the order it happened. Getting this wrong inverts every answer.
    expect(seen[0].chatHistory.map((h: any) => h.content)).toEqual([
      'first question', 'first answer', 'second question', 'second answer',
    ])
    // 'ai' rows must arrive as the 'assistant' role the LLM APIs expect, not 'ai'.
    expect(seen[0].chatHistory.map((h: any) => h.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ])
  })

  test('blank and whitespace-only history rows are dropped, not sent as empty turns', async () => {
    dbState.history = [
      { sender: 'ai', text: '   ' },
      { sender: 'user', text: '' },
      { sender: 'ai', text: 'real answer' },
    ]
    const seen: any[] = []
    routerState.nonStreaming = async (a: any) => {
      seen.push(a)
      return { answer: 'ok', citations: [], chartData: null, toolRuns: [], integrationId: null }
    }
    await post({ messages: [{ role: 'user', content: 'hi' }] })
    // An empty content block is rejected outright by some providers; dropping the
    // row is better than failing the whole request.
    expect(seen[0].chatHistory).toHaveLength(1)
    expect(seen[0].chatHistory[0].content).toBe('real answer')
  })
})

describe('POST /api/v1/chat/completions — tool runs are persisted', () => {
  test('each tool run becomes a row linked to the assistant message', async () => {
    dbState.toolRunCreates = 0
    const seen: any[] = []
    dbState.toolRunCreateArgs = seen
    routerState.nonStreaming = async () => ({
      answer: 'ok',
      citations: [],
      chartData: null,
      integrationId: null,
      toolRuns: [
        { type: 'SQL', status: 'success', latencyMs: 12, inputSummary: 'select', outputSummary: '1 row', restApiEndpointId: null },
        { type: 'RAG', status: 'error', inputSummary: 'q', errorMessage: 'boom', restApiEndpointId: null },
      ],
    })
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(200)
    // Two tool runs in, two audit rows out — the observability trail is part of the
    // contract, not a side effect.
    expect(dbState.toolRunCreates).toBe(2)
    // The row must be tied to the tenant and the assistant message, or the run is
    // unattributable and invisible in the per-message history.
    expect(seen[0].data.organizationId).toBe('org1')
    // The assistant message is the SECOND row created (user first, then assistant),
    // so the tool runs hang off msg2. Guessing msg1 here measured nothing.
    expect(seen[0].data.chatMessageId).toBe('msg2')
    expect(seen[0].data.latencyMs).toBe(12)
    // The SECOND run reports no latency, so it must inherit the REQUEST latency.
    // MEASURED: my first fixture gave BOTH runs a latencyMs, so replacing the
    // `?? latencyMs` fallback with `?? 0` failed 0 tests — the fallback was never
    // exercised. A tool run reported as 0ms looks like a caching bug to an operator.
    // The contract stated right above is that the value is NOT NULL: `null` means
    // "we never measured", 0 means "it was fast". Asserting `.toBe(0)` contradicted
    // that sentence and made the test clock-dependent: the request completes in
    // under a millisecond normally, but under load it takes 1ms, so the suite failed
    // with `Expected: 0, Received: 1`. THIS WAS A REAL FLAKE, reproduced in the
    // 8-process runner, and the fix is to assert the CONTRACT rather than the clock.
    expect(seen[1].data.latencyMs).not.toBeNull()
    // Still distinct from the first run's own latency, which the fixture sets to 12.
    expect(seen[1].data.latencyMs).not.toBe(12)
    // The response echoes the PERSISTED rows, not the router's in-memory objects —
    // so the client can correlate a tool run with the audit row it created.
    const body = await res.json()
    await Bun.write('/tmp/r2.txt', JSON.stringify({ body, args: seen.map((x: any) => x.data) }))
    expect(body.tool_runs).toHaveLength(2)
    expect(body.tool_runs[0]).toMatchObject({ id: 'tr1', type: 'SQL', status: 'success', latency_ms: 12 })
    // The fallback surfaces on the wire too, not just in the audit row. Same trap as
    // the audit-row assertion above: `.toBe(0)` MEASURES THE CLOCK. Under load the
    // request takes 1ms and the suite failed with `Expected: 0, Received: 1`. The
    // contract is the non-null echo of the request latency, so assert that instead.
    expect(body.tool_runs[1].latency_ms).not.toBeNull()
    expect(body.tool_runs[1].latency_ms).not.toBe(12)
  })
})

describe('POST /api/v1/chat/completions — a streaming failure mid-flight', () => {
  test('an error inside the generator emits an error frame, [DONE], and logs 502', async () => {
    dbState.apiLogs = []
    routerState.streaming = async () => ({
      stream: (async function* () {
        yield 'partial'
        throw new Error('provider dropped the connection')
      })(),
      citations: [],
      chartData: null,
      toolRuns: [],
      integrationId: null,
    })
    const res = await post({ messages: [{ role: 'user', content: 'hi' }], stream: true })
    const text = await res.text()
    // The status line is already sent once streaming starts, so the failure can only
    // be reported IN-BAND — a client that receives no error frame sees a truncated
    // answer and has no way to know it was truncated.
    expect(text).toContain('partial')
    expect(text).toContain('LLM_ERROR')
    expect(text).toContain('provider dropped the connection')
    // The sentinel must still arrive, or OpenAI-compatible clients hang waiting.
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
    expect(dbState.apiLogs.some((l: any) => l.data.status === 502)).toBe(true)
  })

  test('the error frame is still valid SSE and parseable as JSON', async () => {
    routerState.streaming = async () => ({
      stream: (async function* () { throw new Error('nope') })(),
      citations: [], chartData: null, toolRuns: [], integrationId: null,
    })
    const res = await post({ messages: [{ role: 'user', content: 'hi' }], stream: true })
    const text = await res.text()
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: ')).map((f) => f.slice(6))
    // A malformed frame is worse than no frame: the client's JSON.parse throws and
    // the UI shows a parser error instead of the provider failure.
    for (const frame of frames) {
      if (frame === '[DONE]') continue
      expect(() => JSON.parse(frame)).not.toThrow()
    }
    const errFrame = frames.map((f) => { try { return JSON.parse(f) } catch { return null } })
      .find((f) => f?.error?.code === 'LLM_ERROR')
    expect(errFrame).toBeTruthy()
  })
})

describe('POST /api/v1/chat/completions — provider not configured', () => {
  test('an LlmNotConfigured failure becomes a 503 with an actionable message', async () => {
    // MEASURED: classification is by MESSAGE SUBSTRING, not by error class —
    // statusForExternalChatError looks for 'LLM not configured' / 'LLM error' /
    // 'LLM stream error'. My first version set err.name = 'LlmNotConfiguredError',
    // which the route never inspects, so it fell through to a 500. The real class
    // is irrelevant; the message is the contract.
    routerState.nonStreaming = async () => {
      throw new Error('LLM not configured for this organization')
    }
    const res = await post({ messages: [{ role: 'user', content: 'hi' }] })
    expect(res.status).toBe(503)
    const body = await res.json()
    // The operator needs to be told WHERE to fix it, not just that it is broken —
    // this is a BYOK product, so an unconfigured key is the expected first-run state.
    expect(body.error).toContain('AI provider not configured')
    expect(body.error).toContain('AI Configuration')
    // CORS survives the failure so a browser caller can read the message.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// The 120s idle watchdog
//
// A stream that stops producing tokens must not hang the HTTP connection until
// the client's own timeout — a typed LLM_TIMEOUT frame plus a 504 audit row is the
// difference between a diagnosable incident and a silent hang. It had never run.
// ---------------------------------------------------------------------------

describe('POST /api/v1/chat/completions — the idle watchdog', () => {
  test('a stream that stalls emits LLM_TIMEOUT, terminates, and logs 504', async () => {
    // 120s is not waitable in a test, so the timer is shortened by intercepting
    // setTimeout for a delay at or above the real 120_000 and resolving immediately.
    // The ROUTE is untouched: this only compresses the clock it uses.
    const realSetTimeout = globalThis.setTimeout
    dbState.apiLogs = []
    // The upstream HANGS: it yields nothing and never closes, which is the shape the
    // watchdog exists for. This used to be impossible to survive — the loop awaited
    // the next token forever, so the timeout frame went out but the 504 audit row was
    // never written and the socket leaked. The loop now races each token against the
    // deadline, so this exact generator must complete the request.
    routerState.streaming = async () => ({
      stream: (async function* () {
        await new Promise(() => {})
      })(),
      citations: [], chartData: null, toolRuns: [], integrationId: null,
    })
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 120_000) return realSetTimeout(fn, 0)
      return realSetTimeout(fn, ms)
    }) as typeof setTimeout

    try {
      const res = await post({ messages: [{ role: 'user', content: 'hi' }], stream: true })
      const text = await res.text()
      // The audit write happens AFTER the loop exits, which can be a tick after the
      // body finishes — checking synchronously observed `logs: []` and looked like a
      // missing row. MEASURED: it is a race in the test, not a defect in the route.
      await new Promise((r) => realSetTimeout(r, 200))
      expect(text).toContain('LLM_TIMEOUT')
      expect(text).toContain('no data received for 120s')
      // The sentinel still has to arrive, or an OpenAI-compatible client waits
      // forever for a frame that will never come.
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true)
      // A 504 is the operationally correct status: the upstream did not answer.
      expect(dbState.apiLogs.some((l: any) => l.data.status === 504)).toBe(true)
      expect(dbState.apiLogs.some((l: any) => String(l.data.errorMessage).includes('idle timeout'))).toBe(true)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })

  test('a stalled stream produces no assistant message row', async () => {
    const realSetTimeout = globalThis.setTimeout
    dbState.messageCreates = []
    // A hung upstream must also leave NO assistant row behind: persisting a partial
    // answer would show an empty or truncated reply in history with no indication
    // that it timed out.
    routerState.streaming = async () => ({
      stream: (async function* () { await new Promise(() => {}) })(),
      citations: [], chartData: null, toolRuns: [], integrationId: null,
    })
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 120_000) return realSetTimeout(fn, 0)
      return realSetTimeout(fn, ms)
    }) as typeof setTimeout
    try {
      const res = await post({ messages: [{ role: 'user', content: 'hi' }], stream: true })
      await res.text()
      // Persisting a partial answer would show the user an empty or truncated reply
      // in their history with no indication that it timed out.
      expect(dbState.messageCreates.filter((m: any) => m.data?.sender === 'ai')).toHaveLength(0)
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
  })
})
