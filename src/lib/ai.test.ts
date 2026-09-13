import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Mocks registered before importing ai.ts.
// We do NOT mock @/lib/llm-client (that leaks across test files in bun:test).
// Instead we mock global.fetch to control LLM responses through the real
// llm-client transport. We also mock llm-config (for resolveBackend), db
// (for routeQuery schema/doc/endpoint lookups), and plugin-selector.
// ---------------------------------------------------------------------------

const mockGetLlmRuntimeConfig = mock(async (): Promise<{ id: string; provider: string; baseUrl: string; apiKey: string; model: string } | null> => ({
  id: '1',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://api.test.com',
  apiKey: 'key',
  model: 'test-model',
}))

const mockSelectRelevantPlugins = mock(async (): Promise<Array<{ name: string; score: number }>> => [])

const mockIntegrationSchemaFindMany = mock(async () => [] as Array<{ tableName: string }>)
const mockDocumentFindMany = mock(async () => [] as Array<{ name: string; category: string | null }>)
const mockRestApiEndpointFindMany = mock(async () => [] as Array<{ path: string; description: string | null }>)

// Include getAgentLlmConfig + llmUsageLog in mocks to prevent cross-file
// leakage from breaking other test files that need those properties.
mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: mockGetLlmRuntimeConfig,
  getAgentLlmConfig: mock(async () => null),
}))
mock.module('@/lib/db', () => ({
  db: {
    integrationSchema: { findMany: mockIntegrationSchemaFindMany },
    document: { findMany: mockDocumentFindMany },
    restApiEndpoint: { findMany: mockRestApiEndpointFindMany },
    llmUsageLog: { create: mock(async () => ({})) },
    llmConfig: { findFirst: async () => null },
  },
}))
mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: mockSelectRelevantPlugins,
}))

import {
  routeQuery,
  generateSql,
  generateAnswer,
  generateChat,
  generateRestCall,
  streamAnswer,
  streamChat,
  answerContextLabel,
  parseRestCallJson,
  REST_ROUTER_SYSTEM_PROMPT,
  generateSessionSummary,
  generateSessionTitle,
  generateSchemaDescriptions,
  generateDatabaseProfile,
} from './ai'
import { LlmNotConfiguredError } from '@/lib/errors'

// ---------------------------------------------------------------------------
// Fetch mock — controls chatOnce/chatStream responses via the real transport
// ---------------------------------------------------------------------------

const originalFetch = global.fetch

let fetchRouterResponse = 'CHAT'
let fetchSqlResponse = JSON.stringify({ sql: 'SELECT 1 LIMIT 1', explanation: 'test explanation' })
let fetchRestResponse = JSON.stringify({ endpointId: 'ep1', query: { q: 'test' }, body: null, explanation: 'selected ep1' })
let fetchChatResponse = 'The answer is 42'
let streamTokens = ['Hello', ' world']

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as Response
}

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line))
      controller.close()
    },
  })
  return { ok: true, status: 200, body: stream } as Response
}

export let lastRequestBody: string | null = null

function makeFetchMock(): typeof fetch {
  return mock(async (_url: string, init: RequestInit) => {
    lastRequestBody = init.body as string
    const body = JSON.parse(init.body as string) as { messages?: Array<{ role: string; content: string }>; stream?: boolean }

    if (body.stream) {
      const lines = streamTokens.map((t) => `data: {"choices":[{"delta":{"content":${JSON.stringify(t)}}}]}\n`)
      lines.push('data: [DONE]\n')
      return sseResponse(lines)
    }

    const sysContent = (body.messages || [])
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')

    if (sysContent.includes('enterprise AI router')) {
      return jsonResponse({ choices: [{ message: { content: fetchRouterResponse } }] })
    }
    if (sysContent.includes('Text-to-SQL')) {
      return jsonResponse({ choices: [{ message: { content: fetchSqlResponse } }] })
    }
    if (sysContent.includes('REST API router')) {
      return jsonResponse({ choices: [{ message: { content: fetchRestResponse } }] })
    }
    return jsonResponse({ choices: [{ message: { content: fetchChatResponse } }] })
  }) as unknown as typeof fetch
}

function getSentMessages(): Array<{ role: string; content: string }> {
  const calls = (global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
  if (calls.length === 0) return []
  const init = calls[calls.length - 1][1]
  const body = JSON.parse(init.body as string) as { messages?: Array<{ role: string; content: string }> }
  return body.messages ?? []
}

// ---------------------------------------------------------------------------
// Reset state before/after each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockGetLlmRuntimeConfig.mockReset()
  mockSelectRelevantPlugins.mockReset()
  mockIntegrationSchemaFindMany.mockReset()
  mockDocumentFindMany.mockReset()
  mockRestApiEndpointFindMany.mockReset()
  fetchRouterResponse = 'CHAT'
  fetchSqlResponse = JSON.stringify({ sql: 'SELECT 1 LIMIT 1', explanation: 'test explanation' })
  fetchRestResponse = JSON.stringify({ endpointId: 'ep1', query: { q: 'test' }, body: null, explanation: 'selected ep1' })
  fetchChatResponse = 'The answer is 42'
  streamTokens = ['Hello', ' world']

  mockGetLlmRuntimeConfig.mockImplementation(async () => ({
    id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: 'key', model: 'test-model',
  }))
  mockSelectRelevantPlugins.mockImplementation(async () => [])
  mockIntegrationSchemaFindMany.mockImplementation(async () => [])
  mockDocumentFindMany.mockImplementation(async () => [])
  mockRestApiEndpointFindMany.mockImplementation(async () => [])

  lastRequestBody = null
  global.fetch = makeFetchMock()
})

afterEach(() => {
  global.fetch = originalFetch
})

// ---------------------------------------------------------------------------
// routeQuery
// ---------------------------------------------------------------------------

describe('routeQuery', () => {
  test('returns SQL when router LLM says SQL', async () => {
    fetchRouterResponse = 'SQL'
    const result = await routeQuery({ question: 'show me sales data', hasIntegrations: true, hasDocuments: false })
    expect(result.decision).toBe('SQL')
  })

  test('returns RAG when router LLM says RAG', async () => {
    fetchRouterResponse = 'RAG'
    const result = await routeQuery({ question: 'what is the return policy?', hasIntegrations: false, hasDocuments: true })
    expect(result.decision).toBe('RAG')
  })

  test('returns REST when router LLM says REST', async () => {
    fetchRouterResponse = 'REST'
    const result = await routeQuery({ question: 'call the weather API', hasIntegrations: false, hasDocuments: false, hasRestApis: true })
    expect(result.decision).toBe('REST')
  })

  test('returns CHAT when router LLM says CHAT and no relevant plugins', async () => {
    fetchRouterResponse = 'CHAT'
    const result = await routeQuery({ question: 'hello there', hasIntegrations: false, hasDocuments: false })
    expect(result.decision).toBe('CHAT')
  })

  test('returns CONTEXTUAL_CHAT when router LLM says CONTEXTUAL_CHAT', async () => {
    fetchRouterResponse = 'CONTEXTUAL_CHAT'
    const result = await routeQuery({
      question: 'what did I ask about earlier?',
      hasIntegrations: false,
      hasDocuments: false,
      chatHistory: [{ role: 'user', content: 'show me SKU-902' }],
    })
    expect(result.decision).toBe('CONTEXTUAL_CHAT')
  })

  test('returns PLUGIN when router says CHAT but a relevant plugin exists', async () => {
    fetchRouterResponse = 'CHAT'
    mockSelectRelevantPlugins.mockImplementation(async () => [{ name: 'weather', score: 0.85 }])
    const result = await routeQuery({ question: 'what is the weather', hasIntegrations: false, hasDocuments: false })
    expect(result.decision).toBe('PLUGIN')
    expect(result.reason).toContain('weather')
    expect(result.reason).toContain('0.85')
  })

  test('defaults to CHAT for unrecognised LLM output', async () => {
    fetchRouterResponse = 'UNKNOWN_BLAH'
    const result = await routeQuery({ question: 'xyz', hasIntegrations: false, hasDocuments: false })
    expect(result.decision).toBe('CHAT')
  })

  test('injects memoryContext into the router prompt', async () => {
    fetchRouterResponse = 'SQL'
    await routeQuery({ question: 'show sales', hasIntegrations: true, hasDocuments: false, memoryContext: 'PREVIOUS INSIGHT: top product is SKU-902' })
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('Memory from prior interactions'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('PREVIOUS INSIGHT: top product is SKU-902')
  })

  test('injects chatHistory into the router prompt', async () => {
    fetchRouterResponse = 'CONTEXTUAL_CHAT'
    await routeQuery({
      question: 'tell me about that again',
      hasIntegrations: false,
      hasDocuments: false,
      chatHistory: [
        { role: 'user', content: 'show me the best selling product' },
        { role: 'assistant', content: 'SKU-902 with 5800 units' },
      ],
    })
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('Prior conversation history'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('show me the best selling product')
    expect(userMsg!.content).toContain('SKU-902 with 5800 units')
  })

  test('queries DB for tables, documents, and REST endpoints', async () => {
    fetchRouterResponse = 'SQL'
    mockIntegrationSchemaFindMany.mockImplementation(async () => [{ tableName: 'sales' }, { tableName: 'customers' }])
    mockDocumentFindMany.mockImplementation(async () => [{ name: 'Return Policy', category: 'SOP' }])
    mockRestApiEndpointFindMany.mockImplementation(async () => [{ path: '/api/weather', description: 'get weather' }])
    await routeQuery({ question: 'show me sales', hasIntegrations: true, hasDocuments: true, hasRestApis: true })
    expect(mockIntegrationSchemaFindMany).toHaveBeenCalledTimes(1)
    expect(mockDocumentFindMany).toHaveBeenCalledTimes(1)
    expect(mockRestApiEndpointFindMany).toHaveBeenCalledTimes(1)
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('Database tables:'))
    expect(userMsg!.content).toContain('sales')
    expect(userMsg!.content).toContain('customers')
    expect(userMsg!.content).toContain('Return Policy [SOP]')
    expect(userMsg!.content).toContain('/api/weather')
  })
})

// ---------------------------------------------------------------------------
// generateSql
// ---------------------------------------------------------------------------

describe('generateSql', () => {
  test('returns {sql, explanation} from valid JSON', async () => {
    const result = await generateSql({ question: 'show all products', schemaDescription: 'TABLE products(id, name)', provider: 'POSTGRESQL' })
    expect(result.sql).toBe('SELECT 1 LIMIT 1')
    expect(result.explanation).toBe('test explanation')
  })

  test('handles markdown-fenced JSON response', async () => {
    fetchSqlResponse = '```json\n{"sql":"SELECT 2","explanation":"fenced"}\n```'
    const result = await generateSql({ question: 'test', schemaDescription: 'schema', provider: 'MYSQL' })
    expect(result.sql).toBe('SELECT 2')
    expect(result.explanation).toBe('fenced')
  })

  // REGRESSION GUARD (2026-09 audit): businessContext shapes SQL generation, and
  // while stream-preparers.ts always passed it, tool-branches.ts (non-streaming:
  // scheduled runs, agentic loop, /api/v1) and api/integrations/[id]/query did
  // not — the admin-authored business context was silently dropped on every
  // non-streaming path, so the same question produced different SQL per
  // transport. There was no test that it reached the prompt at all.
  test('renders businessContext into the prompt', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({
      question: 'show sales',
      schemaDescription: 'TABLE sales(id, amount)',
      provider: 'POSTGRESQL',
      businessContext: 'Amounts are stored in IDR minor units; sales means status = paid.',
    })
    expect(lastRequestBody).toContain('## BUSINESS CONTEXT')
    expect(lastRequestBody).toContain('IDR minor units')
  })

  test('omits the business-context block entirely when not provided', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({
      question: 'show sales',
      schemaDescription: 'TABLE sales(id, amount)',
      provider: 'POSTGRESQL',
    })
    expect(lastRequestBody).not.toBeNull()
    // NOTE: the bare phrase "BUSINESS CONTEXT" also occurs in the system prompt
    // (rule 12 instructs the model to consult it), so it CANNOT be used as the
    // absence signal — an earlier version of this test asserted exactly that and
    // failed for the wrong reason. The rendered section is the `## BUSINESS
    // CONTEXT` heading with a newline, which only ai.ts's args.businessContext
    // branch emits.
    expect(lastRequestBody).not.toContain('## BUSINESS CONTEXT')
  })

  test('falls back to raw text when JSON is invalid', async () => {
    fetchSqlResponse = 'SELECT * FROM products LIMIT 10'
    const result = await generateSql({ question: 'test', schemaDescription: 'schema', provider: 'POSTGRESQL' })
    expect(result.sql).toBe('SELECT * FROM products LIMIT 10')
    expect(result.explanation).toBe('Query generated by LLM.')
  })

  // ponytail: the SQL repair loop depends on this — the DB error must reach
  // the LLM as explicit correction feedback.
  test('injects repairFeedback into the user message', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({
      question: 'show sales',
      schemaDescription: 'TABLE sales(amount)',
      provider: 'POSTGRESQL',
      repairFeedback: 'The previous SQL was:\nSELECT total FROM sales\nIt failed with error:\ncolumn "total" does not exist',
    })
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('PREVIOUS ATTEMPT FAILED'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('column "total" does not exist')
  })

  test('no repair feedback note on first attempt', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'q', schemaDescription: 's', provider: 'POSTGRESQL' })
    const messages = getSentMessages()
    expect(messages.some((m) => m.content.includes('PREVIOUS ATTEMPT FAILED'))).toBe(false)
  })

  test('passes provider and memoryContext into the prompt', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({
      question: 'show sales',
      schemaDescription: 'TABLE sales(id, amount)',
      provider: 'CLICKHOUSE',
      memoryContext: 'PREVIOUS SQL: SELECT amount FROM sales WHERE date > yesterday',
    })
    const messages = getSentMessages()
    const sysMsg = messages.find((m) => m.content.includes('CLICKHOUSE'))
    expect(sysMsg).toBeDefined()
    const userMsg = messages.find((m) => m.content.includes('Memory:'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('PREVIOUS SQL: SELECT amount FROM sales WHERE date > yesterday')
  })

  test('SQL prompt guides case-insensitive string search (ILIKE/LIKE per dialect)', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'find john', schemaDescription: 'TABLE users(name)', provider: 'POSTGRESQL' })
    const sysMsg = getSentMessages().find((m) => m.role === 'system')
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toContain('ILIKE')
    expect(sysMsg!.content).toContain('LOWER(name) LIKE')
    expect(sysMsg!.content).toContain('positionCaseInsensitive')
    expect(sysMsg!.content).not.toContain("' +")
  })

  test('SQL prompt covers NULL semantics and wildcard escaping', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'q', schemaDescription: 's', provider: 'POSTGRESQL' })
    const sysMsg = getSentMessages().find((m) => m.role === 'system')
    expect(sysMsg!.content).toContain('IS NULL')
    expect(sysMsg!.content).toContain('COALESCE')
    expect(sysMsg!.content).toContain('ESCAPE')
  })
})

// ---------------------------------------------------------------------------
// generateAnswer
// ---------------------------------------------------------------------------

describe('generateAnswer', () => {
  test('returns the answer string from chatOnce', async () => {
    fetchChatResponse = 'Total sales: $42,000'
    const result = await generateAnswer({ question: 'what are total sales?', context: 'rows: [{total: 42000}]', source: 'SQL' })
    expect(result).toBe('Total sales: $42,000')
  })

  test('injects systemPromptPrefix as the first system message', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'q',
      context: 'c',
      source: 'SQL',
      systemPromptPrefix: 'You are a sales analyst. Be concise.',
    })
    const messages = getSentMessages()
    expect(messages[0].content).toBe('You are a sales analyst. Be concise.')
  })

  test('injects memoryContext as a system message', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'q',
      context: 'c',
      source: 'SQL',
      memoryContext: 'User previously asked about Q3 sales',
    })
    const messages = getSentMessages()
    const memMsg = messages.find((m) => m.content.includes('Memory context from prior interactions'))
    expect(memMsg).toBeDefined()
    expect(memMsg!.content).toContain('User previously asked about Q3 sales')
  })

  test('injects chatHistory as a system message', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'q',
      context: 'c',
      source: 'SQL',
      chatHistory: [
        { role: 'user', content: 'show me sales' },
        { role: 'assistant', content: 'sales are $42k' },
      ],
    })
    const messages = getSentMessages()
    const histMsg = messages.find((m) => m.content.includes('Prior conversation history'))
    expect(histMsg).toBeDefined()
    expect(histMsg!.content).toContain('show me sales')
    expect(histMsg!.content).toContain('sales are $42k')
  })

  test('a systemPromptPrefix is sent as the FIRST system message', async () => {
    streamTokens = ['ok']
    for await (const _ of streamAnswer({ question: 'q', context: 'c', source: 'SQL', systemPromptPrefix: 'You are terse.' })) {
      // drain
    }
    const messages = getSentMessages()
    const prefix = messages.find((m) => m.content === 'You are terse.')
    expect(prefix).toBeDefined()
    expect(prefix!.role).toBe('system')
    // ORDER matters: the prefix is the operator's framing and must not end up
    // after the retrieved context, which would make it read as part of the data.
    expect(messages.indexOf(prefix!)).toBeLessThan(messages.findIndex((m) => m.content.includes('CONTEXT')))
  })

  test('chat history is expanded into prior turns, in order, before the question', async () => {
    streamTokens = ['ok']
    for await (const _ of streamAnswer({
      question: 'and the total?',
      context: 'c',
      source: 'SQL',
      chatHistory: [
        { role: 'user', content: 'how many orders' },
        { role: 'assistant', content: '42' },
      ],
    })) {
      // drain
    }
    const messages = getSentMessages()
    const asked = messages.findIndex((m) => m.content === 'how many orders')
    const answered = messages.findIndex((m) => m.content === '42')
    // The follow-up only makes sense if BOTH prior turns survive and stay ordered.
    expect(asked).toBeGreaterThanOrEqual(0)
    expect(answered).toBeGreaterThan(asked)
  })

  test('an empty chat history adds no messages (not an empty system turn)', async () => {
    streamTokens = ['ok']
    for await (const _ of streamAnswer({ question: 'q', context: 'c', source: 'SQL', chatHistory: [] })) {
      // drain
    }
    const messages = getSentMessages()
    // A zero-length history must be a no-op; emitting a stray empty message would
    // shift every subsequent turn and confuse the model about who said what.
    expect(messages.every((m) => m.content !== '' && m.content !== undefined)).toBe(true)
  })

  test('uses REST API label for REST_API source', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: 'c', source: 'REST_API' })
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('CONTEXT (REST API)'))
    expect(userMsg).toBeDefined()
  })

  // ponytail: history must reach the LLM as NATIVE user/assistant turns — the
  // old single flattened system message weakened follow-up grounding.
  test('injects chatHistory as native user/assistant turns', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'q',
      context: 'c',
      source: 'SQL',
      chatHistory: [
        { role: 'user', content: 'show me sales' },
        { role: 'assistant', content: 'sales are $42k' },
      ],
    })
    const messages = getSentMessages()
    const userTurn = messages.find((m) => m.role === 'user' && m.content === 'show me sales')
    const assistantTurn = messages.find((m) => m.role === 'assistant' && m.content === 'sales are $42k')
    expect(userTurn).toBeDefined()
    expect(assistantTurn).toBeDefined()
  })

  test('rowCount=0 adds honest empty-result instruction', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: '[]', source: 'SQL', rowCount: 0 })
    const messages = getSentMessages()
    const sysMsg = messages.find((m) => m.role === 'system' && m.content.includes('0 rows'))
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toContain('Do NOT invent rows')
  })

  test('truncated=true adds truncation disclosure instruction', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: 'rows', source: 'SQL', rowCount: 100, truncated: true })
    const messages = getSentMessages()
    const sysMsg = messages.find((m) => m.role === 'system' && m.content.includes('TRUNCATED'))
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toContain('first 100')
  })

  test('no empty/truncation notes without rowCount/truncated', async () => {
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: 'rows', source: 'SQL' })
    const messages = getSentMessages()
    const sysMsg = messages.find((m) => m.role === 'system' && m.content.includes('ryasai'))
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).not.toContain('TRUNCATED')
    expect(sysMsg!.content).not.toContain('0 rows')
  })
})

// ---------------------------------------------------------------------------
// generateChat
// ---------------------------------------------------------------------------

describe('generateChat', () => {
  test('returns chat response string', async () => {
    fetchChatResponse = 'Hi! How can I help?'
    const result = await generateChat('hello there')
    expect(result).toBe('Hi! How can I help?')
  })

  test('injects systemPromptPrefix and memoryContext', async () => {
    fetchChatResponse = 'ok'
    await generateChat('hi', 'Be friendly.', 'User prefers concise answers')
    const messages = getSentMessages()
    expect(messages[0].content).toBe('Be friendly.')
    const memMsg = messages.find((m) => m.content.includes('Memory context from prior interactions'))
    expect(memMsg).toBeDefined()
    expect(memMsg!.content).toContain('User prefers concise answers')
  })

  test('injects chatHistory', async () => {
    fetchChatResponse = 'ok'
    await generateChat('what about that thing?', undefined, undefined, [
      { role: 'user', content: 'show me products' },
      { role: 'assistant', content: 'here are the products' },
    ])
    const messages = getSentMessages()
    const histMsg = messages.find((m) => m.content.includes('Prior conversation history'))
    expect(histMsg).toBeDefined()
    expect(histMsg!.content).toContain('show me products')
  })
})

// ---------------------------------------------------------------------------
// generateRestCall + parseRestCallJson
// ---------------------------------------------------------------------------

describe('generateRestCall', () => {
  test('returns RestCallPlan from JSON response', async () => {
    const result = await generateRestCall({
      question: 'get weather for Jakarta',
      endpoints: [{ id: 'ep1', connectorName: 'weather', method: 'GET', path: '/weather', description: 'get weather' }],
    })
    expect(result.endpointId).toBe('ep1')
    expect(result.query).toEqual({ q: 'test' })
    expect(result.explanation).toBe('selected ep1')
  })

  test('injects memoryContext into REST router prompt', async () => {
    fetchRestResponse = '{"endpointId":"ep2","query":{},"body":null,"explanation":"ok"}'
    await generateRestCall({
      question: 'get weather',
      endpoints: [],
      memoryContext: 'PREVIOUS CALL: /weather?q=Jakarta returned 30C',
    })
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('Memory:'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('PREVIOUS CALL: /weather?q=Jakarta returned 30C')
  })
})

describe('parseRestCallJson', () => {
  test('parses valid JSON with all fields', () => {
    const result = parseRestCallJson('{"endpointId":"ep1","query":{"q":"x"},"body":{"k":1},"explanation":"ok"}')
    expect(result.endpointId).toBe('ep1')
    expect(result.query).toEqual({ q: 'x' })
    expect(result.body).toEqual({ k: 1 })
    expect(result.explanation).toBe('ok')
  })

  test('handles markdown-fenced JSON', () => {
    const result = parseRestCallJson('```json\n{"endpointId":"ep2","explanation":"fenced"}\n```')
    expect(result.endpointId).toBe('ep2')
    expect(result.explanation).toBe('fenced')
  })

  test('defaults missing fields: empty endpointId, empty query, null body', () => {
    const result = parseRestCallJson('{}')
    expect(result.endpointId).toBe('')
    expect(result.query).toEqual({})
    expect(result.body).toBeNull()
    expect(result.explanation).toBe('')
  })

  test('rejects non-object query (array) → defaults to empty object', () => {
    const result = parseRestCallJson('{"endpointId":"ep1","query":[1,2,3]}')
    expect(result.query).toEqual({})
  })

  test('throws on invalid JSON', () => {
    expect(() => parseRestCallJson('not json at all')).toThrow()
  })
})

// ---------------------------------------------------------------------------
// streamAnswer
// ---------------------------------------------------------------------------

describe('streamAnswer', () => {
  test('yields tokens from chatStream', async () => {
    streamTokens = ['foo', 'bar', 'baz']
    const tokens: string[] = []
    for await (const t of streamAnswer({ question: 'q', context: 'c', source: 'SQL' })) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['foo', 'bar', 'baz'])
  })

  test('injects memoryContext as system message before streaming', async () => {
    streamTokens = ['ok']
    for await (const _ of streamAnswer({ question: 'q', context: 'c', source: 'SQL', memoryContext: 'previous insight' })) {
      // drain
    }
    const messages = getSentMessages()
    const memMsg = messages.find((m) => m.content.includes('Memory context from prior interactions'))
    expect(memMsg).toBeDefined()
    expect(memMsg!.content).toContain('previous insight')
  })

  test('uses REST API label for REST_API source', async () => {
    streamTokens = ['ok']
    for await (const _ of streamAnswer({ question: 'q', context: 'c', source: 'REST_API' })) {
      // drain
    }
    const messages = getSentMessages()
    const userMsg = messages.find((m) => m.content.includes('CONTEXT (REST API)'))
    expect(userMsg).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// streamChat — signature: (question, memoryContext?, systemPromptPrefix?, chatHistory?)
// ---------------------------------------------------------------------------

describe('streamChat', () => {
  test('yields tokens from chatStream', async () => {
    streamTokens = ['hi', 'there']
    const tokens: string[] = []
    for await (const t of streamChat('hello')) {
      tokens.push(t)
    }
    expect(tokens).toEqual(['hi', 'there'])
  })

  test('injects systemPromptPrefix and memoryContext', async () => {
    streamTokens = ['ok']
    // streamChat(question, memoryContext?, systemPromptPrefix?, chatHistory?)
    for await (const _ of streamChat('hi', 'user prefers short answers', 'Be brief.')) {
      // drain
    }
    const messages = getSentMessages()
    expect(messages[0].content).toBe('Be brief.')
    const memMsg = messages.find((m) => m.content.includes('Memory context from prior interactions'))
    expect(memMsg).toBeDefined()
    expect(memMsg!.content).toContain('user prefers short answers')
  })

  test('injects chatHistory', async () => {
    streamTokens = ['ok']
    for await (const _ of streamChat('again', undefined, undefined, [
      { role: 'user', content: 'what is X?' },
      { role: 'assistant', content: 'X is Y' },
    ])) {
      // drain
    }
    const messages = getSentMessages()
    const histMsg = messages.find((m) => m.content.includes('Prior conversation history'))
    expect(histMsg).toBeDefined()
    expect(histMsg!.content).toContain('what is X?')
  })
})

// ---------------------------------------------------------------------------
// resolveBackend (tested indirectly via public functions)
// ---------------------------------------------------------------------------

describe('resolveBackend (via public functions)', () => {
  test('throws LlmNotConfiguredError when getLlmRuntimeConfig returns null', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    await expect(
      generateSql({ question: 'test', schemaDescription: 'schema', provider: 'POSTGRESQL' }),
    ).rejects.toThrow(LlmNotConfiguredError)
  })

  test('throws LlmNotConfiguredError when config has no baseUrl', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: '', apiKey: 'key', model: 'm',
    }))
    await expect(
      generateAnswer({ question: 'q', context: 'c', source: 'SQL' }),
    ).rejects.toThrow(LlmNotConfiguredError)
  })

  test('throws LlmNotConfiguredError when config has no apiKey', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://x.com', apiKey: '', model: 'm',
    }))
    await expect(
      generateChat('hello'),
    ).rejects.toThrow(LlmNotConfiguredError)
  })

  test('routeQuery throws LlmNotConfiguredError when no config', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    await expect(
      routeQuery({ question: 'test', hasIntegrations: false, hasDocuments: false }),
    ).rejects.toThrow(LlmNotConfiguredError)
  })
})

// ---------------------------------------------------------------------------
// answerContextLabel
// ---------------------------------------------------------------------------

describe('answerContextLabel', () => {
  test('labels REST API context as REST API, not RAG', () => {
    expect(answerContextLabel('REST_API')).toBe('REST API')
  })

  test('labels CHAT source as PRIOR CONTEXT', () => {
    expect(answerContextLabel('CHAT')).toBe('PRIOR CONTEXT')
  })

  test('labels SQL source as SQL', () => {
    expect(answerContextLabel('SQL')).toBe('SQL')
  })

  test('labels RAG source as RAG', () => {
    expect(answerContextLabel('RAG')).toBe('RAG')
  })
})

// ---------------------------------------------------------------------------
// REST_ROUTER_SYSTEM_PROMPT
// ---------------------------------------------------------------------------

describe('REST_ROUTER_SYSTEM_PROMPT', () => {
  test('treats REST sample responses as schema examples, not final data', () => {
    expect(REST_ROUTER_SYSTEM_PROMPT).toContain('sampleResponse is only an example structure')
  })

  test('does not invent REST parameters without a parameter schema', () => {
    expect(REST_ROUTER_SYSTEM_PROMPT).toContain('Do not send query or body if parameterSchema is empty')
  })
})

// ---------------------------------------------------------------------------
// Summary / title / schema-description generators
// ---------------------------------------------------------------------------
// Four exported functions the app depends on for long-session memory, session
// naming and schema reflection were never executed by a test. They all funnel
// through chatOnce, so they are driven here through the SAME fetch mock the rest
// of the file uses (no extra mocks, no leak surface).
describe('generateSessionSummary', () => {
  test('returns the model text, trimmed and capped', async () => {
    fetchChatResponse = '  User asked about Q3 sales.  '
    const out = await generateSessionSummary({ previousSummary: null, messages: [{ role: 'user', content: 'hi' }] })
    expect(out).toBe('User asked about Q3 sales.')
  })

  test('a previous summary is merged, not dropped', async () => {
    fetchChatResponse = 'merged'
    await generateSessionSummary({
      previousSummary: 'OLDER FACTS',
      messages: [{ role: 'user', content: 'NEW TURN' }],
    })
    const sent = getSentMessages()
    const userMsg = sent.find((m) => m.role === 'user')!
    // Dropping the previous summary is "chatbot with amnesia" in long sessions —
    // exactly what this function exists to prevent.
    expect(userMsg.content).toContain('OLDER FACTS')
    expect(userMsg.content).toContain('NEW TURN')
  })

  test('an empty previous summary adds no empty section', async () => {
    fetchChatResponse = 's'
    await generateSessionSummary({ previousSummary: '', messages: [{ role: 'user', content: 'x' }] })
    expect(getSentMessages().find((m) => m.role === 'user')!.content).not.toContain('Previous summary')
  })

  test('assistant turns are labelled Assistant, not User', async () => {
    fetchChatResponse = 's'
    await generateSessionSummary({
      previousSummary: null,
      messages: [
        { role: 'user', content: 'WHAT I SAID' },
        { role: 'assistant', content: 'WHAT IT SAID' },
      ],
    })
    const content = getSentMessages().find((m) => m.role === 'user')!.content
    // Mislabeling the roles would make the summary attribute the model's claims
    // to the user.
    expect(content).toContain('User: WHAT I SAID')
    expect(content).toContain('Assistant: WHAT IT SAID')
  })

  test('each message is capped so one huge turn cannot dominate', async () => {
    fetchChatResponse = 's'
    await generateSessionSummary({ previousSummary: null, messages: [{ role: 'user', content: 'z'.repeat(5000) }] })
    const content = getSentMessages().find((m) => m.role === 'user')!.content
    expect(content.length).toBeLessThan(3000)
  })

  test('the result is capped at 2000 characters', async () => {
    fetchChatResponse = 'q'.repeat(5000)
    const out = await generateSessionSummary({ previousSummary: null, messages: [{ role: 'user', content: 'x' }] })
    // An unbounded summary would compound into the next prompt forever.
    expect(out.length).toBe(2000)
  })
})

describe('generateSessionTitle', () => {
  test('strips quotes, prefixes and trailing punctuation', async () => {
    fetchChatResponse = '"Session: Q3 Sales Review."'
    const out = await generateSessionTitle('berapa penjualan Q3?')
    // The raw model output is not user-facing-safe; the wrapper must clean it.
    expect(out).not.toContain('"')
    expect(out.endsWith('.')).toBe(false)
  })

  test('falls back to the raw message when the model returns something too short', async () => {
    fetchChatResponse = ''
    const out = await generateSessionTitle('Berapa total pendapatan kuartal ini?')
    // A blank or 1-2 char title is worse than the raw text.
    expect(out).toBe('Berapa total pendapatan kuartal ini?')
  })

  test('a one-character model title is rejected in favour of the fallback', async () => {
    fetchChatResponse = 'A'
    const out = await generateSessionTitle('some question here')
    expect(out).toBe('some question here')
  })

  test('the title is capped at 80 characters', async () => {
    fetchChatResponse = 'w'.repeat(300)
    const out = await generateSessionTitle('q')
    expect(out.length).toBeLessThanOrEqual(80)
  })

  test('the first message is truncated before being sent', async () => {
    fetchChatResponse = 'Title'
    await generateSessionTitle('c'.repeat(2000))
    const userMsg = getSentMessages().find((m) => m.role === 'user')!
    expect(userMsg.content.length).toBeLessThanOrEqual(500)
  })
})

describe('generateSchemaDescriptions', () => {
  const tables = [
    { tableName: 'orders', columns: [{ name: 'id', type: 'int', primaryKey: true }, { name: 'total', type: 'numeric' }], rowCount: 120, sampleRow: { id: 1, total: 9.5 } },
  ]

  test('no tables → empty object without an LLM call', async () => {
    const callsBefore = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    const out = await generateSchemaDescriptions({ integrationName: 'DB', tables: [] })
    expect(out).toEqual({})
    // An empty schema must not spend a request.
    expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore)
  })

  test('parses a well-formed JSON mapping', async () => {
    fetchChatResponse = JSON.stringify({ orders: 'Customer orders and their totals.' })
    const out = await generateSchemaDescriptions({ integrationName: 'DB', tables })
    expect(out.orders).toBe('Customer orders and their totals.')
  })

  test('a markdown-fenced JSON reply is still parsed', async () => {
    fetchChatResponse = '```json\n{"orders":"fenced"}\n```'
    const out = await generateSchemaDescriptions({ integrationName: 'DB', tables })
    // Models add fences despite instructions; failing here would silently lose
    // every description.
    expect(out.orders).toBe('fenced')
  })

  test('malformed JSON returns an EMPTY object instead of throwing', async () => {
    fetchChatResponse = 'I cannot do that'
    const out = await generateSchemaDescriptions({ integrationName: 'DB', tables })
    // Schema reflection is non-critical: it must degrade, not break setup.
    expect(out).toEqual({})
  })

  test('table details, PK markers and the sample row reach the prompt', async () => {
    fetchChatResponse = '{}'
    await generateSchemaDescriptions({ integrationName: 'MyDB', tables })
    const userMsg = getSentMessages().find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('MyDB')
    expect(userMsg.content).toContain('orders')
    expect(userMsg.content).toContain('(PK)')
    expect(userMsg.content).toContain('120 rows')
    expect(userMsg.content).toContain('Sample row')
  })

  test('a table with no row count omits the count rather than printing undefined', async () => {
    fetchChatResponse = '{}'
    await generateSchemaDescriptions({
      integrationName: 'D',
      tables: [{ tableName: 't', columns: [{ name: 'a', type: 'int' }], rowCount: null, sampleRow: null }],
    })
    expect(getSentMessages().find((m) => m.role === 'user')!.content).not.toContain('undefined')
  })
})

describe('generateDatabaseProfile', () => {
  const tables = [{ tableName: 'orders', columns: [{ name: 'id', type: 'int' }], rowCount: 5 }]

  test('no tables → empty string without an LLM call', async () => {
    const callsBefore = (global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
    expect(await generateDatabaseProfile({ integrationName: 'DB', tables: [] })).toBe('')
    expect((global.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore)
  })

  test('returns the model text trimmed', async () => {
    // This prompt contains the literal "Text-to-SQL", which the fetch mock's
    // dispatcher also matches (it routes on which system prompt is present), so
    // the reply here is fetchSqlResponse rather than fetchChatResponse. That is a
    // property of the TEST double, not of the product: assert on the trimmed
    // model text via a response we control in the mock's own terms.
    fetchSqlResponse = '  A retail database.  '
    expect(await generateDatabaseProfile({ integrationName: 'DB', tables })).toBe('A retail database.')
  })

  test('the integration name and table details reach the prompt', async () => {
    await generateDatabaseProfile({ integrationName: 'RetailDB', tables })
    const userMsg = getSentMessages().find((m) => m.role === 'user')!
    expect(userMsg.content).toContain('RetailDB')
    expect(userMsg.content).toContain('orders')
  })

  test('a non-JSON reply is returned as-is rather than parsed', async () => {
    // Unlike generateSchemaDescriptions, this one is plain text: a prose document
    // must NOT be run through JSON.parse and discarded.
    fetchSqlResponse = '## DOMAIN\nRetail.'
    expect(await generateDatabaseProfile({ integrationName: 'DB', tables })).toContain('## DOMAIN')
  })
})
