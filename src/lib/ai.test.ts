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

function makeFetchMock(): typeof fetch {
  return mock(async (_url: string, init: RequestInit) => {
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
