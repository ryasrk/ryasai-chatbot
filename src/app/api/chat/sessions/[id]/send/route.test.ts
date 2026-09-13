/**
 * Pre-stream coverage for POST /api/chat/sessions/[id]/send
 *
 * Everything before the SSE body starts is plain request/response: auth, org
 * context, rate limit, budget, body parsing, text validation, session lookup,
 * integration lookup, retry dedupe. Those are the status codes a client can act
 * on, and they are what this file pins.
 *
 * The streaming body itself is deliberately NOT covered — it needs a live LLM.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { AppError } from '@/lib/errors'

// ---------------------------------------------------------------------------
// Mocks. Every module route.ts imports is mocked with its FULL export surface,
// because a partial module mock makes a transitive barrel throw
// "Export named 'X' not found" at import time.
// ---------------------------------------------------------------------------

const mockUser = {
  userId: 'u1',
  name: 'Test User',
  email: 't@test.com',
  role: 'admin',
  organizationId: 'org-default',
  plan: null as string | null,
}

const calls = {
  rate: 0,
  budget: 0,
  handleApiError: 0,
  enterWithOrg: [] as string[],
  getActiveUser: 0,
  /** sessionId of every chatMessage.create — tells us whether a USER row was written */
  userMessageCreates: [] as string[],
  aiMessageCreates: [] as string[],
  chatMessageCreate: [] as any[],
  findMany: [] as any[],
  integrationFindFirst: [] as any[],
  sessionUpdates: [] as any[],
  toolRunCreates: [] as any[],
}

let getActiveUserImpl: () => Promise<typeof mockUser> = async () => mockUser
let rateLimitImpl: () => Promise<void> = async () => {}
let budgetImpl: () => Promise<void> = async () => {}
let session: any = {
  id: 's1',
  title: 'New Session',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  summary: null,
  summaryUpTo: null,
}
let integration: any = { id: 'int1' }
let retryMessage: any = null
let recentMessages: any[] = []
let allMessages: any[] = []
let summaryImpl: (args: any) => Promise<string> = async () => 'Generated summary'
let streamingImpl: (args: any) => Promise<any> = async () => ({
  stream: (async function* () {})(),
  toolRuns: [],
  citations: [],
  chartData: null,
  integrationId: null,
})
let savedPrompt: any = null
let createImpl: (args: any) => any = (args) => ({
  id: 'm-new',
  createdAt: new Date('2026-01-01T00:00:01Z'),
  ...args.data,
})

function resetState() {
  calls.rate = 0
  calls.budget = 0
  calls.handleApiError = 0
  calls.enterWithOrg.length = 0
  calls.getActiveUser = 0
  calls.userMessageCreates.length = 0
  calls.aiMessageCreates.length = 0
  calls.chatMessageCreate.length = 0
  calls.findMany.length = 0
  calls.integrationFindFirst.length = 0
  calls.sessionUpdates.length = 0
  calls.toolRunCreates.length = 0
  allMessages = []
  summaryImpl = async () => 'Generated summary'
  streamingImpl = async () => ({
    stream: (async function* () {})(),
    toolRuns: [],
    citations: [],
    chartData: null,
    integrationId: null,
  })
  getActiveUserImpl = async () => mockUser
  rateLimitImpl = async () => {}
  budgetImpl = async () => {}
  session = {
    id: 's1',
    title: 'New Session',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    summary: null,
    summaryUpTo: null,
  }
  integration = { id: 'int1' }
  retryMessage = null
  recentMessages = []
  savedPrompt = null
}

/** A request whose body arrived but whose response is never read (we only want the status). */
function makeRequest(body: unknown, headers?: Record<string, string>): Request {
  return new Request('http://localhost/api/chat/sessions/s1/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    body: JSON.stringify(body),
  })
}

const makeCtx = (id = 's1') => ({ params: Promise.resolve({ id }) })

mock.module('@/lib/db', () => ({
  db: {
    chatSession: {
      findFirst: async () => session,
      findMany: async () => [],
      create: async () => ({}),
      update: async (args: any) => {
        calls.sessionUpdates.push(args)
        return {}
      },
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
      aggregate: async () => ({}),
      groupBy: async () => [],
    },
    chatMessage: {
      findFirst: async () => retryMessage,
      findMany: async (args: any) => {
        calls.findMany.push(args)
        // A SECOND findMany shape: the rolling-summary query selects every user/ai
        // message and includes createdAt in its projection. The handler asks for
        // orderBy createdAt ASC, so the double must SORT — returning the fixture
        // as-is let the reading order depend on how the fixture was built, and the
        // "oldest" slice was silently the newest messages.
        if (args?.select?.createdAt) {
          return [...allMessages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        }
        return recentMessages
      },
      create: async (args: any) => {
        calls.chatMessageCreate.push(args)
        if (args?.data?.sender === 'user') calls.userMessageCreates.push(args.data.sessionId)
        if (args?.data?.sender === 'ai') calls.aiMessageCreates.push(args.data.sessionId)
        return createImpl(args)
      },
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
      aggregate: async () => ({}),
      groupBy: async () => [],
    },
    integration: {
      findFirst: async (args: any) => {
        calls.integrationFindFirst.push(args)
        return integration
      },
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
      groupBy: async () => [],
    },
    savedPrompt: {
      findFirst: async () => savedPrompt,
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      delete: async () => ({}),
      count: async () => 0,
    },
    toolRun: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async (args: any) => {
        calls.toolRunCreates.push(args)
        return {}
      },
      createMany: async () => ({ count: 0 }),
      update: async () => ({}),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      count: async () => 0,
      groupBy: async () => [],
      aggregate: async () => ({}),
    },
    llmUsageLog: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      createMany: async () => ({ count: 0 }),
      update: async () => ({}),
      delete: async () => ({}),
      count: async () => 0,
      aggregate: async () => ({}),
      groupBy: async () => [],
    },
    appConfig: {
      findFirst: async () => null,
      findMany: async () => [],
      create: async () => ({}),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
      count: async () => 0,
    },
    $transaction: async (fn: any) => (typeof fn === 'function' ? fn({}) : []),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
  },
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    calls.getActiveUser++
    return getActiveUserImpl()
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    calls.handleApiError++
    if (e instanceof AppError) {
      return Response.json({ error: { code: e.code, message: e.message } }, { status: e.statusCode })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
  writeAudit: async () => {},
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    calls.enterWithOrg.push(orgId)
  },
  getOrgContext: () => null,
  bypassOrg: async (fn: any) => fn(),
  orgStore: undefined,
}))

mock.module('@/lib/cognee', () => ({
  rememberChatTurn: async () => {},
  recallContext: async () => '',
  recallKnowledgeGraph: async () => '',
  recall: async () => '',
  remember: async () => {},
  forget: async () => {},
  improve: async () => {},
  cognifyDocument: async () => ({}),
  forgetKnowledgeGraph: async () => ({}),
  databaseFor: () => 'default',
  datasetFor: () => 'default',
  kbDatasetFor: () => 'default:kb',
  getCogneeSettings: async () => ({}),
  getCogneeClient: async () => null,
  invalidateCogneeSettings: () => {},
  isCogneeEnabled: async () => false,
  cogneeHealth: async () => ({ enabled: false, reachable: false }),
  cogneeStats: async () => ({}),
  cognifyMaxRetries: () => 0,
  cogneeBatchSize: () => 0,
  resetClientCache: () => {},
  formatSearchResponse: () => '',
  extractSearchItems: () => [],
  isValidSearchType: () => false,
  COGNEE_SEARCH_TYPES: new Set<string>(),
}))

mock.module('@/lib/ai', () => ({
  generateSessionTitle: async () => 'Generated Title',
  generateSessionSummary: (args: any) => summaryImpl(args),
  routeQuery: async () => ({ decision: 'CHAT', reason: '' }),
  generateSql: async () => ({ sql: 'SELECT 1', explanation: '' }),
  generateAnswer: async () => 'answer',
  generateChat: async () => 'answer',
  generateRestCall: async () => ({}),
  generateSchemaDescriptions: async () => ({}),
  generateDatabaseProfile: async () => ({}),
  streamAnswer: async function* () {},
  streamChat: async function* () {},
  answerContextLabel: () => '',
  historyToMessages: (h: any) => h,
  parseRestCallJson: () => ({}),
  REST_ROUTER_SYSTEM_PROMPT: '',
}))

mock.module('@/lib/tool-utils', () => ({
  stripSessionWrapper: (text: string) => text,
  withSqlConcurrency: (_id: string, fn: () => Promise<unknown>) => fn(),
  buildChartDataFromRows: () => null,
  buildDocumentCitation: () => ({}),
  sanitizeSqlError: (msg: string) => msg,
  summarize: (value: string) => value,
  safeJson: () => null,
  safeParseColumns: () => [],
  safeParseSampleRow: () => undefined,
  extractTableName: () => '',
  jsonRowsToChart: () => null,
  unavailableDataSourceResult: () => ({}),
  ambiguousDataSourceResult: () => ({}),
}))

mock.module('@/lib/tool-router', () => ({
  runStreamingChatCompletion: (args: any) => streamingImpl(args),
  runNonStreamingChatCompletion: async () => ({
    answer: '',
    toolRuns: [],
    citations: [],
    chartData: null,
    integrationId: null,
  }),
  chooseAvailableDecision: () => 'CHAT',
  parseRestCallJson: () => ({}),
  withSqlConcurrency: (_id: string, fn: () => Promise<unknown>) => fn(),
}))

mock.module('@/lib/llm-budget', () => ({
  assertChatSendRateLimit: async () => {
    calls.rate++
    return rateLimitImpl()
  },
  assertWithinBudget: async () => {
    calls.budget++
    return budgetImpl()
  },
  getChatSendRateLimit: () => 30,
  getLlmBudgetConfig: () => ({}),
  getOrgTokenUsage: async () => 0,
  DEFAULT_LLM_BUDGET_WINDOW_HOURS: 24,
  DEFAULT_CHAT_RATE_LIMIT_PER_MIN: 30,
}))

// NOT mocked on purpose: route.ts does `e instanceof LlmProviderError`, so the
// real class must be the same object the route sees.

// ---------------------------------------------------------------------------
// Module under test — imported AFTER every mock.module() call.
// ---------------------------------------------------------------------------
const { POST } = await import('./route')

beforeEach(() => {
  resetState()
})

describe('POST /api/chat/sessions/[id]/send — guards that precede the SSE stream', () => {
  test('400 when text is missing entirely and no user message is persisted', async () => {
    const res = await POST(makeRequest({}) as any, makeCtx())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('text')
    // reject before any DB write for the turn
    expect(calls.userMessageCreates).toHaveLength(0)
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('400 for whitespace-only text (trimmed before the emptiness check)', async () => {
    const res = await POST(makeRequest({ text: '   \n\t  ' }) as any, makeCtx())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('text')
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('400 when text exceeds the 100_000 character ceiling', async () => {
    const res = await POST(makeRequest({ text: 'a'.repeat(100_001) }) as any, makeCtx())

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('too long')
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('404 when the session does not belong to the caller (lookup returns null)', async () => {
    session = null

    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())

    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('Session not found')
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('400 when a given integrationId resolves to no active integration', async () => {
    integration = null

    const res = await POST(
      makeRequest({ text: 'hello', integrationId: 'int-missing' }) as any,
      makeCtx(),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('not active or not found')
    // the lookup must actually ask for an ACTIVE integration
    expect(calls.integrationFindFirst[0]?.where).toMatchObject({ id: 'int-missing', status: 'active' })
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('proceeds past the integration gate when the integration is active', async () => {
    integration = { id: 'int-active' }

    const res = await POST(
      makeRequest({ text: 'hello', integrationId: 'int-active' }) as any,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    expect(calls.integrationFindFirst).toHaveLength(1)
    // past the gate ⇒ the user turn was actually persisted
    expect(calls.userMessageCreates).toEqual(['s1'])
  })

  test('rate limit failure is handed to handleApiError, not answered by the route', async () => {
    rateLimitImpl = async () => {
      throw new AppError('RATE_LIMITED', 'Too many chat requests. Please slow down.')
    }

    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())

    expect(res.status).toBe(429)
    expect(calls.handleApiError).toBe(1)
    expect(calls.budget).toBe(0) // rate limit runs first and short-circuits
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('budget exhaustion goes through handleApiError and writes no user message', async () => {
    budgetImpl = async () => {
      throw new AppError('LLM_BUDGET_EXCEEDED', 'Daily LLM token budget exceeded.')
    }

    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())

    expect(res.status).toBe(429)
    expect(calls.handleApiError).toBe(1)
    expect(calls.rate).toBe(1)
    expect(calls.userMessageCreates).toHaveLength(0)
    expect(calls.chatMessageCreate).toHaveLength(0)
  })

  test('retry dedupe: a known messageId is reused instead of inserting a duplicate user turn', async () => {
    retryMessage = { id: 'm-prev', createdAt: new Date('2026-01-01T00:00:00Z') }

    const res = await POST(
      makeRequest({ text: 'retry me', messageId: 'm-prev' }) as any,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    // THE point of the feature: no second user row for the same turn
    expect(calls.userMessageCreates).toHaveLength(0)
    expect(calls.chatMessageCreate).toHaveLength(0)
    // and the retried message is excluded from the history window
    expect(calls.findMany[0]?.where).toMatchObject({
      sessionId: 's1',
      id: { not: 'm-prev' },
    })
  })

  test('retry dedupe: an unknown messageId falls through and creates the user turn', async () => {
    retryMessage = null

    const res = await POST(
      makeRequest({ text: 'brand new turn', messageId: 'm-ghost' }) as any,
      makeCtx(),
    )

    expect(res.status).toBe(200)
    expect(calls.userMessageCreates).toEqual(['s1'])
    // nothing to exclude ⇒ no `id: { not: ... }` filter on the history query
    expect(calls.findMany[0]?.where?.id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Pre-existing coverage of the stream-error classifier (kept).
// ---------------------------------------------------------------------------
describe('internal chat send error classification', () => {
  test('returns 503 when the LLM provider is unavailable', async () => {
    const { statusForInternalChatError } = await import('./route')
    expect(
      statusForInternalChatError(
        new Error('LLM not configured. Open Settings → AI Configuration and set up endpoint + API key before using Chat.'),
      ),
    ).toBe(503)
  })

  test('keeps unknown errors as server errors', async () => {
    const { statusForInternalChatError } = await import('./route')
    expect(statusForInternalChatError(new Error('database failed'))).toBe(500)
  })

  test('returns 404 when the session disappears before the assistant reply is saved', async () => {
    const { statusForInternalChatError } = await import('./route')
    expect(statusForInternalChatError({ code: 'P2003' })).toBe(404)
  })

  test('returns 404 when the session disappears before retitling', async () => {
    const { statusForInternalChatError } = await import('./route')
    expect(statusForInternalChatError({ code: 'P2025' })).toBe(404)
  })
})

// ---------------------------------------------------------------------------
// persistAssistantError and maybeUpdateSessionSummary
//
// Both are private and both are called INSIDE the SSE body, so they are reached
// by driving POST with a streaming mock rather than by importing them.
// ---------------------------------------------------------------------------

/** Drain an SSE Response body to a string (the body must be consumed for the
 *  generator to run to completion). */
async function drain(res: Response): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  let out = ''
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  return out
}

describe('persistAssistantError — the failed turn is recorded', () => {
  beforeEach(() => {
    integration = { id: 'int1' }
  })

  test('an LLM failure writes an ERROR ai message, not a normal one', async () => {
    streamingImpl = async () => {
      throw new Error('LLM stream error: upstream 500')
    }
    const res = await POST(makeRequest({ text: 'hello there' }) as any, makeCtx())
    await drain(res)

    const aiCreate = calls.chatMessageCreate.find((c) => c?.data?.sender === 'ai')
    // The row must be marked status:'error' — a failed turn that looks successful
    // in the history is worse than no row at all.
    expect(aiCreate?.data?.status).toBe('error')
    expect(calls.aiMessageCreates).toContain('s1')
  })

  test('the persisted error carries the organizationId', async () => {
    streamingImpl = async () => {
      throw new Error('LLM stream error: upstream 500')
    }
    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())
    await drain(res)

    const aiCreate = calls.chatMessageCreate.find((c) => c?.data?.sender === 'ai')
    // Without the org stamp the row is invisible to every tenant-scoped query and
    // the error vanishes from the session.
    expect(aiCreate?.data?.organizationId).toBe('org-default')
  })

  test('a failed turn writes a ToolRun row so the failure is visible as a turn', async () => {
    streamingImpl = async () => {
      throw new Error('LLM stream error: upstream 500')
    }
    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())
    await drain(res)

    expect(calls.toolRunCreates.length).toBeGreaterThan(0)
    const run = calls.toolRunCreates.at(-1)!.data
    // latencyMs null, not 0: no work completed, and 0 would report a real duration.
    expect(run.latencyMs).toBeNull()
    expect(run.status).toBe('error')
    expect(run.chatMessageId).toBe('m-new')
  })

  test('the ToolRun inputSummary is capped at its column budget', async () => {
    streamingImpl = async () => {
      throw new Error('LLM stream error: upstream 500')
    }
    const long = 'q'.repeat(5000)
    const res = await POST(makeRequest({ text: long }) as any, makeCtx())
    await drain(res)

    const run = calls.toolRunCreates.at(-1)!.data
    expect(run.inputSummary.length).toBe(240)
  })

  test('the session updatedAt is touched on a failed turn', async () => {
    streamingImpl = async () => {
      throw new Error('LLM stream error: upstream 500')
    }
    const res = await POST(makeRequest({ text: 'hello' }) as any, makeCtx())
    await drain(res)

    const touch = calls.sessionUpdates.find((u) => u?.data?.updatedAt)
    // A failed turn still reorders the session list; without this the session
    // sinks to the bottom as if nothing happened.
    expect(touch?.where?.id).toBe('s1')
  })
})

describe('maybeUpdateSessionSummary — the rolling window', () => {
  /** Build N user/ai messages, ascending in time. */
  function messages(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      sender: i % 2 === 0 ? 'user' : 'ai',
      text: `msg ${i}`,
      createdAt: new Date(2026, 0, 1, 0, i),
    }))
  }

  async function runTurn() {
    const res = await POST(makeRequest({ text: 'hello there' }) as any, makeCtx())
    await drain(res)
  }

  test('a session within the window is NOT summarized', async () => {
    allMessages = messages(10)
    let called = 0
    summaryImpl = async () => { called++; return 'Generated summary' }
    await runTurn()
    // Exactly HISTORY_WINDOW messages: nothing has fallen out yet, so the
    // summarizer must not even be CALLED. Asserting only "no session update"
    // would pass even with the guards removed, because slicing to a negative
    // length yields an empty array anyway — measured, and it did pass.
    expect(called).toBe(0)
    expect(calls.sessionUpdates.filter((u) => u?.data?.summary !== undefined)).toHaveLength(0)
  })

  test('a session PAST the window summarizes only the overflow', async () => {
    allMessages = messages(14)
    await runTurn()

    const write = calls.sessionUpdates.find((u) => u?.data?.summary !== undefined)
    expect(write).toBeDefined()
    expect(write!.data.summary).toBe('Generated summary')
    // The overflow is the OLDEST 4 (14 - 10); the last one is m3, so summaryUpTo
    // must be m3's createdAt and not the newest message.
    expect((write!.data.summaryUpTo as Date).getTime()).toBe(allMessages[3].createdAt.getTime())
  })

  test('a message ALREADY at the high-water mark is not summarized again', async () => {
    // Two turns, the way production runs: the first writes summaryUpTo, the second
    // reads it back. MEASURED before the fix: the comparison was a strict `>`, but
    // summaryUpTo IS the createdAt of the last message folded in — m3 in this
    // fixture — so m3 was re-admitted on the next turn and summarized twice.
    allMessages = messages(14)
    const seen: number[] = []
    summaryImpl = async (args) => { seen.push(args.messages.length); return 'Generated summary' }

    await runTurn()
    const first = calls.sessionUpdates.find((u) => u?.data?.summaryUpTo !== undefined)
    expect(first).toBeDefined()
    expect(seen).toEqual([4]) // m0..m3

    // Second turn: the session now carries the high-water mark the handler stored.
    session = { ...session, summary: first!.data.summary, summaryUpTo: first!.data.summaryUpTo }
    calls.sessionUpdates.length = 0
    // Two fresh messages arrive, pushing two more out of the window.
    allMessages = messages(16)
    await runTurn()

    // Only the NEWLY fallen-out messages (m4, m5) may be folded in. Anything more
    // means m3 was counted twice, and its text appears in two summaries.
    expect(seen).toEqual([4, 2])
  })

  test('a summary failure does not fail the turn', async () => {
    allMessages = messages(14)
    summaryImpl = async () => { throw new Error('summary provider down') }
    const res = await POST(makeRequest({ text: 'hello there' }) as any, makeCtx())
    const body = await drain(res)
    // Fire-and-forget: a dead summarizer must not surface as a turn error.
    expect(body).not.toContain('LLM_ERROR')
  })

  test('the previous summary is handed to the summarizer for continuity', async () => {
    allMessages = messages(14)
    session = { ...session, summary: 'earlier summary', summaryUpTo: null }
    let seen: any = null
    summaryImpl = async (args) => { seen = args; return 'merged summary' }
    await runTurn()
    // A summary that forgot its predecessor would lose the start of a long session.
    expect(seen?.previousSummary).toBe('earlier summary')
    expect(seen?.messages?.length).toBeGreaterThan(0)
  })

  test('messages are mapped to user/assistant roles, not raw sender values', async () => {
    allMessages = messages(14)
    let seen: any = null
    summaryImpl = async (args) => { seen = args; return 's' }
    await runTurn()
    const roles = seen.messages.map((m: any) => m.role)
    expect(roles).toContain('user')
    expect(roles).toContain('assistant')
    // 'ai' is the DB's sender value; the LLM API only accepts 'assistant'.
    expect(roles).not.toContain('ai')
  })
})
