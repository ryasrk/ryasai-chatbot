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
      update: async () => ({}),
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
      create: async () => ({}),
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
  generateSessionSummary: async () => 'Generated summary',
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
  runStreamingChatCompletion: async () => ({
    stream: (async function* () {})(),
    toolRuns: [],
    citations: [],
    chartData: null,
    integrationId: null,
  }),
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
