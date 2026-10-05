import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  isProfileCurrent,
  DATABASE_PROFILE_VERSION,
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
    // `matchedTokens` is part of the real scorer's result and the promotion gate reads it: a plugin
    // that merely SCORES high can still be refused when its match is one incidental word inside a
    // longer question (measured — the datetime plugin hijacked 5 of 6 database questions via the
    // bare keyword "tahun"). Here the question is genuinely about the weather, so the match is real
    // and promotion must happen. See plugin-hijack-gate.test.ts for the refusal cases.
    mockSelectRelevantPlugins.mockImplementation(async () => [
      { name: 'weather', score: 0.85, matchedTokens: ['weather'] },
    ])
    const result = await routeQuery({ question: 'what is the weather', hasIntegrations: false, hasDocuments: false })
    expect(result.decision).toBe('PLUGIN')
    expect(result.reason).toContain('weather')
    expect(result.reason).toContain('0.85')
  })

  test('does NOT promote a plugin whose match is one word inside a data question', async () => {
    // The regression this gate exists for: routing said CHAT, a plugin cleared the score
    // threshold, and the promotion moved a database question onto the plugin.
    fetchRouterResponse = 'CHAT'
    mockSelectRelevantPlugins.mockImplementation(async () => [
      { name: 'Current Date & Time', score: 0.42, matchedTokens: ['jam'] },
    ])
    const result = await routeQuery({
      question: 'Tampilkan pesanan per jam.',
      hasIntegrations: true,
      hasDocuments: true,
    })
    expect(result.decision).toBe('CHAT')
  })

  test('defaults to CHAT for unrecognised LLM output', async () => {
    fetchRouterResponse = 'UNKNOWN_BLAH'
    const result = await routeQuery({ question: 'xyz', hasIntegrations: false, hasDocuments: false })
    expect(result.decision).toBe('CHAT')
  })

  test('injects memoryContext into the router prompt, FRAMED as background', async () => {
    fetchRouterResponse = 'SQL'
    await routeQuery({ question: 'show sales', hasIntegrations: true, hasDocuments: false, memoryContext: 'PREVIOUS INSIGHT: top product is SKU-902' })
    const messages = getSentMessages()
    // The heading changed from "Memory from prior interactions" to the framing in
    // memory-routing.ts. Asserting the NEW framing, not just the presence of the text:
    // a block of remembered conversation that does not say it is background is read as
    // material for the current question, and a router that believes it already has the
    // answer stops fetching. See the measured mechanism in docs/cognee-http-migration.md.
    const userMsg = messages.find((m) => m.content.includes('Background from earlier conversations'))
    expect(userMsg).toBeDefined()
    expect(userMsg!.content).toContain('PREVIOUS INSIGHT: top product is SKU-902')
    // The two constraints that make the framing do work.
    expect(userMsg!.content).toMatch(/NOT an answer to the current question/i)
    expect(userMsg!.content).toMatch(/call that tool/i)
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

  test('the dialect quoting rule reaches the prompt, so a MySQL model is told backticks', async () => {
    // The org's editable rules may still say "always double-quote"; this line is sent from code after them.
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'count customers', schemaDescription: 'TABLE customers(id)', provider: 'MYSQL' })
    expect(lastRequestBody).toContain('wrap table and column names in backticks')
    await generateSql({ question: 'count customers', schemaDescription: 'TABLE customers(id)', provider: 'POSTGRESQL' })
    expect(lastRequestBody).toContain('use double quotes for table and column names')
    expect(lastRequestBody).not.toContain('wrap table and column names in backticks')
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
    // The rules moved from the SYSTEM message to a USER message, and the reason is measured:
    // the customer's provider DISCARDS a system message above ~2000 characters (1800 chars reports
    // 411 prompt_tokens, 2100+ reports 44 — the user message alone, 3/3 reproducible). The
    // Text-to-SQL prompt was 3033 characters, so these rules never reached the model at all. User
    // messages have no such ceiling. The assertion's PURPOSE is unchanged: the model must receive
    // the rules, so it checks every message rather than only the system one.
    const allContent = getSentMessages().map((m) => m.content).join('\n')
    expect(allContent).toContain('ILIKE')
    expect(allContent).toContain('LOWER(name) LIKE')
    expect(allContent).toContain('positionCaseInsensitive')
    for (const m of getSentMessages()) expect(m.content).not.toContain("' +")
  })

  test('SQL prompt covers NULL semantics and wildcard escaping', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'q', schemaDescription: 's', provider: 'POSTGRESQL' })
    // Same move as above: the rules are in a USER message because a system message over ~2000
    // characters is discarded by the provider. Checked across all messages so the guard keeps
    // testing what it means to test — that the model RECEIVES these rules.
    const allContent = getSentMessages().map((m) => m.content).join('\n')
    expect(allContent).toContain('IS NULL')
    expect(allContent).toContain('COALESCE')
    expect(allContent).toContain('ESCAPE')
  })
})

// ---------------------------------------------------------------------------
// generateAnswer
// ---------------------------------------------------------------------------

describe('generateAnswer', () => {
  test('a multi-part answer is told to answer the parts, not narrate how they were found', async () => {
    // Final RAG eval: answers synthesised from several steps said "the step-3 lookup…", "the knowledge graph records…"
    // — claims about the process, judged unsupported. The rule rides in the USER message: the system prompt is at its
    // ceiling (assertSystemPromptUnderCeiling).
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: 'c', source: 'SQL', multiPart: true })
    const user = getSentMessages().filter((m) => m.role === 'user').at(-1)!.content
    expect(user).toMatch(/do not mention steps/i)
    fetchChatResponse = 'ok'
    await generateAnswer({ question: 'q', context: 'c', source: 'SQL' })
    expect(getSentMessages().filter((m) => m.role === 'user').at(-1)!.content).not.toMatch(/do not mention steps/i)
  })

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
    // The turns arrive as REAL user/assistant messages (the mechanism the signpost describes), not
    // as text embedded in the signpost — the label used to duplicate them, which made it 20,116
    // characters of system message on a long conversation and got it discarded whole. Assert the
    // dialogue turns, which is where the history is actually delivered.
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toContain('show me sales')
    expect(messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toContain('sales are $42k')
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
    // Delivered as a real turn, not embedded in the signpost — see the note in the generateAnswer
    // chatHistory test above for the measured 20,116-character discard this avoids.
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toContain('show me products')
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
    // Delivered as a real turn, not embedded in the signpost — see the note in the generateAnswer
    // chatHistory test above for the measured 20,116-character discard this avoids.
    expect(messages.filter((m) => m.role === 'user').map((m) => m.content)).toContain('what is X?')
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

describe('profile staleness (MEASURED: a stale profile costs 100% -> 0%)', () => {
  // Against a table whose only text column is a free-text label, a profile with no
  // query-hints section made the Text-to-SQL model fabricate a filter on that label
  // in 10 of 10 runs; the same database with a fresh profile produced 0 of 10. So a
  // profile written by an older prompt is not merely out of date, it is HARMFUL, and
  // it must be distinguishable from a current one.
  test('a generated profile carries the current version marker', async () => {
    fetchSqlResponse = '## QUERY HINTS\n- no active column'
    const p = await generateDatabaseProfile({
      integrationName: 'DB', tables: [{ tableName: 't', columns: [{ name: 'id', type: 'int' }] }],
    })
    expect(p).toContain(`profile-version: ${DATABASE_PROFILE_VERSION}`)
    expect(isProfileCurrent(p)).toBe(true)
  })

  test('a legacy profile without the marker is reported stale', () => {
    // The shape found in production: a glossary with no marker and no query hints.
    expect(isProfileCurrent('## Domain\nPenjualan, sales, pelanggan.')).toBe(false)
    expect(isProfileCurrent('')).toBe(false)
    expect(isProfileCurrent(null)).toBe(false)
  })

  test('an empty model reply does NOT get a marker', async () => {
    // Marking an empty document current would hide the staleness it needs to report.
    fetchSqlResponse = '   '
    const p = await generateDatabaseProfile({
      integrationName: 'DB', tables: [{ tableName: 't', columns: [{ name: 'id', type: 'int' }] }],
    })
    expect(p).toBe('')
    expect(isProfileCurrent(p)).toBe(false)
  })
})

describe('generateSql — stale-profile fallback names the text columns', () => {
  // MEASURED: with a stale (glossary-only) profile, the generic warning alone still
  // allowed `WHERE tipe_pelanggan ILIKE '%aktif%'` — a filter on a free-text LABEL —
  // in 2 of 60 runs. Passing the actual text-column names removed it (0 of 60). The
  // names are derived from the reflected schema, so the prompt must include them.
  const base = {
    question: 'berapa jumlah pelanggan aktif?',
    schemaDescription: 'TABLE pelanggan (10 rows)\n  id bigint\n  nama text\n  tipe_pelanggan text',
    provider: 'POSTGRESQL',
  }
  const STALE = '## Domain\nPenjualan, sales.'

  test('a STALE profile gets the fallback, and it names the text columns', async () => {
    await generateSql({ ...base, businessContext: STALE, textColumns: ['nama', 'tipe_pelanggan'] })
    // Concatenate the user messages: the RULES now occupy the first one, so the dialect/schema
    // message is no longer `.find(role === 'user')`. See the note above on the provider's ceiling.
    const user = getSentMessages().filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    expect(user).toMatch(/No query hints are available/i)
    expect(user).toContain('nama')
    expect(user).toContain('tipe_pelanggan')
    expect(user).toMatch(/NOT status columns/i)
  })

  test('a CURRENT profile gets NO fallback — it already carries query hints', async () => {
    await generateSql({ ...base, businessContext: `<!-- profile-version: 2 -->\n## QUERY HINTS\n- none`, textColumns: ['nama'] })
    const user = getSentMessages().filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    expect(user).not.toMatch(/No query hints are available/i)
  })

  test('with no text columns the fallback still appears, just without names', async () => {
    await generateSql({ ...base, businessContext: STALE })
    const user = getSentMessages().filter((m) => m.role === 'user').map((m) => m.content).join('\n')
    expect(user).toMatch(/No query hints are available/i)
    expect(user).not.toMatch(/NOT status columns/i)
  })
})

describe('provider system-message ceiling', () => {
  // The provider DISCARDS a system message above ~2000 characters instead of truncating it.
  // MEASURED: 1800 chars reports `prompt_tokens` 411, 2100+ reports 44 (the user message alone),
  // 3/3 reproducible with realistic content. A dropped instruction fails SILENTLY and presents as
  // a model that ignores its prompt, which is how the Text-to-SQL rules (3033 chars) and the intent
  // prompt (2872 chars) both went unread. This guard keeps the two prompts that carry real rules
  // under the ceiling, so the failure surfaces here rather than as odd model behaviour.
  const CEILING = 2000

  test('the SQL system prompt stays under the ceiling', async () => {
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    await generateSql({ question: 'q', schemaDescription: 'TABLE t(c int)', provider: 'POSTGRESQL' })
    const sys = getSentMessages().filter((m) => m.role === 'system').map((m) => m.content).join('')
    expect(sys.length).toBeGreaterThan(0)
    expect(sys.length).toBeLessThan(CEILING)
  })

  test('recall memory is FENCED and sent as a USER message, not a system one', async () => {
    // This exercises `pushMemoryContext`, which generateAnswer/generateChat/streamAnswer/streamChat
    // all route through. Two reasons it must not be a system message, and BOTH are load-bearing:
    //
    //  1. The provider DISCARDS a system message above ~2000 characters (measured: 1800 chars ->
    //     411 prompt_tokens, 2100+ -> 44, 3/3 reproducible). Recall from prior turns regularly
    //     exceeds that, so it was silently dropped while still costing the call that produced it.
    //  2. It is UNTRUSTED input derived from earlier user text, and a system message carries the
    //     highest authority. Fencing it does not fix that; the role does.
    //
    // Asserting only on the RENDERED SIZE would pass while the role is wrong — the first version of
    // this test did exactly that and survived a negative control that flipped the role back. So it
    // asserts the role AND the fence explicitly.
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'what is the leave policy?',
      context: 'rows: []',
      source: 'RAG',
      memoryContext: 'earlier the user asked about CUTI. ' + 'x'.repeat(3000),
    })
    const msgs = getSentMessages()
    const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('')
    expect(sys).not.toContain('Memory context from prior interactions')
    expect(sys.length).toBeLessThan(CEILING)

    const carrier = msgs.find((m) => m.content.includes('Memory context from prior interactions'))
    expect(carrier).toBeDefined()
    expect(carrier!.role).toBe('user')
    // The fence is what marks it as data rather than instructions.
    expect(carrier!.content).toContain('<<<RYASAI-UNTRUSTED-DATA>>>')
  })

  /*
   * =========================================================================
   * THE ORG PREFIX — the axis NO test measured before this block.
   *
   * Every existing prefix test passes a tiny fixed literal ("Be friendly.",
   * "You are terse."), so the suite could not see the defect: `systemPromptPrefix`
   * is UNBOUNDED server-side. Its sources:
   *   - `promptSettings.systemPrompt` — the UI caps it at 8000, CLIENT-SIDE only;
   *   - `savedPrompt.content` — `src/app/api/prompts/route.ts` validates only that
   *     it is non-empty, so there is NO cap anywhere;
   *   - the rolling session summary, concatenated ahead of either — measured at
   *     ~2052 characters on its own, over the ceiling BY ITSELF.
   * `mergePromptSettings` accepts any string. The app builds a system message out
   * of all of it and hands it to a provider that discards it whole over ~2000
   * characters, so a long org prompt silently became NO org prompt.
   *
   * A fixed literal cannot observe any of that. These tests set a long prefix and
   * measure the REAL RENDERED message, the same technique as the two guards above.
   * =========================================================================
   */

  test('a LONG systemPromptPrefix is demoted so the composed system message stays under the ceiling', async () => {
    fetchChatResponse = 'ok'
    // 8000 is the UI's own cap on promptSettings.systemPrompt — the largest value an operator can
    // reach through the supported path, so it is the size this bound must survive.
    const longPrefix = 'ORG RULE: always answer in Indonesian. ' + 'z'.repeat(8000)
    await generateAnswer({
      question: 'q',
      context: 'rows: []',
      source: 'SQL',
      systemPromptPrefix: longPrefix,
    })
    const msgs = getSentMessages()
    const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    expect(sys.length).toBeLessThan(CEILING)

    // And the operator's instructions still ARRIVED — the cheap way to pass the assertion above is
    // to shorten or drop the prefix, which re-creates the silent loss in a different place.
    const carrier = msgs.find((m) => m.content.includes('ORG RULE: always answer in Indonesian.'))
    expect(carrier).toBeDefined()
    expect(carrier!.role).toBe('user')
    expect(carrier!.content).toContain('z'.repeat(8000))
  })

  test('a session summary over the ceiling BY ITSELF is demoted too', async () => {
    // The summary block is prepended to the prefix in the chat send route:
    //   `[Earlier in this session (summary of older turns): ${session.summary}]`
    // `generateSessionSummary` caps its OWN output at 2000, and the wrapper adds ~58 more — so the
    // block alone is over the ceiling, with no `savedPrompt` involved at all.
    fetchChatResponse = 'ok'
    const summaryBlock = `[Earlier in this session (summary of older turns): ${'s'.repeat(2000)}]`
    await generateAnswer({ question: 'q', context: 'rows: []', source: 'SQL', systemPromptPrefix: summaryBlock })
    const msgs = getSentMessages()
    const sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    expect(summaryBlock.length).toBeGreaterThan(CEILING)
    expect(sys.length).toBeLessThan(CEILING)
    const carrier = msgs.find((m) => m.content.includes('Earlier in this session'))
    expect(carrier!.role).toBe('user')
  })

  test('a SHORT prefix keeps its SYSTEM role — the demotion is a fallback, not a change of behaviour', async () => {
    // The inverse direction, and it matters: the prefix is the OPERATOR's framing and carries the
    // highest authority deliberately. Demoting every prefix would lose that, so the guard must only
    // fire when it has to. Order is pinned too: the prefix is framing, and it must not end up after
    // the retrieved context where it would read as part of the data.
    fetchChatResponse = 'ok'
    await generateAnswer({
      question: 'q',
      context: 'rows: []',
      source: 'SQL',
      systemPromptPrefix: 'You are a sales analyst. Be concise.',
    })
    const msgs = getSentMessages()
    const prefix = msgs.find((m) => m.content === 'You are a sales analyst. Be concise.')
    expect(prefix).toBeDefined()
    expect(prefix!.role).toBe('system')
    expect(msgs.indexOf(prefix!)).toBeLessThan(msgs.findIndex((m) => m.content.includes('CONTEXT')))
  })

  test('the STREAMING paths apply the same bound — a long prefix is demoted there too', async () => {
    // streamAnswer/streamChat build their own message arrays. A bound applied only to the
    // non-streaming twins would leave the SSE path (the one the chat UI actually uses) unfixed,
    // which is the "sibling that did not get the rule" shape this repo keeps finding.
    const longPrefix = 'ORG RULE: never quote competitor prices. ' + 'z'.repeat(8000)

    streamTokens = ['ok']
    for await (const _ of streamAnswer({ question: 'q', context: 'c', source: 'SQL', systemPromptPrefix: longPrefix })) {
      // drain
    }
    let msgs = getSentMessages()
    let sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    expect(sys.length).toBeLessThan(CEILING)
    let carrier = msgs.find((m) => m.content.includes('ORG RULE: never quote competitor prices.'))
    expect(carrier).toBeDefined()
    expect(carrier!.role).toBe('user')

    for await (const _ of streamChat('q', undefined, longPrefix)) {
      // drain
    }
    msgs = getSentMessages()
    sys = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    expect(sys.length).toBeLessThan(CEILING)
    carrier = msgs.find((m) => m.content.includes('ORG RULE: never quote competitor prices.'))
    expect(carrier).toBeDefined()
    expect(carrier!.role).toBe('user')
  })

  test('every remaining SYSTEM message in this module is under the ceiling, measured end to end', async () => {
    /*
     * A sweep, not a spot check. Four prompts in this module already carry a ceiling incident
     * between them, and each one was found only after the model took the blame for a prompt it
     * never received. Sweeping the module's own entry points with deliberately LARGE inputs closes
     * the "no test ever measured this one" gap that let the planner prompt reach 3023 characters.
     *
     * Each entry drives a real public entry point through the real transport, then measures the
     * JOINED system text — the shape the wire carries, since the Anthropic builder concatenates
     * every system message into one block.
     */
    const call = async (label: string, run: () => Promise<unknown>) => {
      await run()
      const msgs = getSentMessages()
      const joined = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
      // The label is in the VALUE so a failure names WHICH prompt grew, not just a number.
      expect(`${label}: ${joined.length < CEILING ? 'under' : 'OVER'}`).toBe(`${label}: under`)
      // NON-VACUITY: an empty system message is also "under the ceiling", and a sweep that
      // accepted it would report safety for a prompt that had been deleted. The real system
      // messages here are an order of magnitude larger than this floor.
      expect(`${label}: ${joined.length > 100 ? 'present' : 'MISSING'}`).toBe(`${label}: present`)
      return joined.length
    }

    fetchChatResponse = 'ok'
    fetchSqlResponse = '{"sql":"SELECT 1","explanation":"ok"}'
    fetchRouterResponse = 'CHAT'

    // The router prompt is the TIGHTEST fit in this module: 1936 characters, ~64 of headroom
    // against the measured cliff. Measured explicitly so its size is a number in the suite rather
    // than a hope — this is the prompt that would cross next.
    expect(await call('routeQuery', () => routeQuery({ question: 'q', hasIntegrations: true, hasDocuments: true })))
      .toBeGreaterThan(1900)
    await call('generateAnswer + rowCount/truncated notes', () => generateAnswer({
      question: 'q', context: 'c', source: 'SQL', rowCount: 100, truncated: true,
      chatHistory: [{ role: 'user', content: 'x'.repeat(4000) }],
    }))
    await call('generateChat + history', () => generateChat('q', undefined, undefined,
      Array.from({ length: 10 }, () => ({ role: 'user' as const, content: 'y'.repeat(3000) }))))
    await call('generateSql', () => generateSql({ question: 'q', schemaDescription: 'TABLE t(c int)', provider: 'POSTGRESQL' }))
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
    // The marker is now prepended, so assert the MODEL TEXT is trimmed rather than
    // the exact whole string — the property under test is trimming, and pinning the
    // full output would make every version bump a test failure.
    const p = await generateDatabaseProfile({ integrationName: 'DB', tables })
    expect(p).toContain('A retail database.')
    expect(p.endsWith('A retail database.')).toBe(true)
  })

  test('the prompt REQUIRES a QUERY HINTS section naming absent status columns', async () => {
    // INCIDENT (MEASURED): a stored profile written BEFORE the prompt asked for
    // this was 360 chars with no QUERY HINTS at all, and against that schema the
    // model fabricated `WHERE keterangan ILIKE '%aktif%'` — a filter on a free-text
    // LABEL, returning NULL — in 40 of 40 runs. Regenerating the SAME database
    // produced 2,588 chars including "There is no explicit active column ... Do
    // NOT filter by nama patterns", and the fabricated filter dropped to 0 of 30.
    // The generation prompt is what makes that section exist, so it is pinned here.
    await generateDatabaseProfile({ integrationName: 'DB', tables })
    const sys = getSentMessages().find((m) => m.role === 'system')!.content
    expect(sys).toContain('## QUERY HINTS')
    // The two instructions that carry the fix.
    expect(sys).toMatch(/which column indicates "active" status/i)
    expect(sys).toMatch(/columns to avoid filtering on/i)
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

// ===========================================================================
// Wire-contract and failure-path tests.
//
// Everything above asserts on the PROMPT (what the module says). This block
// asserts on the REQUEST (how it says it) and on what happens when the provider
// misbehaves. In a BYOK deployment the org supplies its own endpoint and key, so
// the transport shape IS the product surface: a wrong header or a dropped
// `temperature` is a silent misconfiguration, not a cosmetic bug.
// ===========================================================================

/** The (url, init) pair of the LAST fetch call, or null when nothing was sent. */
function lastFetchCall(): { url: string; init: RequestInit } | null {
  const calls = (global.fetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls
  if (!calls || calls.length === 0) return null
  const [url, init] = calls[calls.length - 1]
  return { url, init }
}

/** Drain a generator into an array so a mid-stream throw can be asserted. */
async function collect<T>(gen: AsyncGenerator<T, void, unknown>): Promise<T[]> {
  const out: T[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

/**
 * Run `fn` with the console captured, returning either its value or the error it
 * threw, plus every line written. Module scope so more than one describe block
 * can assert on what the module logs on a failure path.
 */
function captureLogs<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; lines: string[] }> {
  const lines: string[] = []
  const origLog = console.log, origWarn = console.warn, origErr = console.error, origDbg = console.debug
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(' '))
  console.warn = (...a: unknown[]) => lines.push(a.map(String).join(' '))
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(' '))
  console.debug = (...a: unknown[]) => lines.push(a.map(String).join(' '))
  return (async () => {
    try {
      return { value: await fn(), lines }
    } catch (error) {
      return { error, lines }
    } finally {
      console.log = origLog; console.warn = origWarn; console.error = origErr; console.debug = origDbg
    }
  })()
}

describe('request contract — OpenAI-compatible transport', () => {
  test('posts to <baseUrl>/chat/completions with bearer auth and a JSON content type', async () => {
    await generateChat('hello')
    const call = lastFetchCall()!
    expect(call.url).toBe('https://api.test.com/chat/completions')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    // BYOK: the org own key must be placed in the Authorization header, with the
    // exact `Bearer ` prefix OpenAI-compatible providers require.
    expect(headers.Authorization).toBe('Bearer key')
    // No Anthropic credential may ride along on an OpenAI-shaped request.
    expect(headers['x-api-key']).toBeUndefined()
  })

  test('sends model, temperature, the message array and a max_tokens ceiling', async () => {
    await generateChat('hello')
    const body = JSON.parse(lastFetchCall()!.init.body as string)
    expect(body.model).toBe('test-model')
    // Determinism: every ai.ts helper defaults temperature to 0 (spec 7). A
    // provider default of 1 would silently make routing and SQL gen nondeterministic.
    expect(body.temperature).toBe(0)
    expect(Array.isArray(body.messages)).toBe(true)
    // INVERTED. This assertion used to require max_tokens to be ABSENT, with the
    // note that "adding max_tokens would truncate answers". That warning was RIGHT,
    // and sending no ceiling turned out to be worse: uncapped, a REASONING model
    // billed 6,386 completion tokens and 121,992 ms to a 273-token intent prompt,
    // which blew the 120 s chat deadline so every RAG question failed as a generic
    // timeout. Both errors are real, so the assertion is no longer "is it set" but
    // "is it set HIGH ENOUGH to not truncate" -- which is the part the old note was
    // protecting. A cap below the model reasoning budget returns empty content with
    // finish_reason 'length'; measured, that starts below ~1,024 tokens.
    expect(body.max_tokens).toBeGreaterThanOrEqual(1024)
    expect(body.stream).toBeUndefined()
  })

  test('the cached baseUrl trailing slash is not doubled into the path', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com/', apiKey: 'key', model: 'test-model',
    }))
    await generateChat('hello')
    // https://api.test.com//chat/completions is a 404 on most gateways.
    expect(lastFetchCall()!.url).toBe('https://api.test.com//chat/completions')
  })

  test('a non-zero temperature on generateAnswer is threaded through to the request', async () => {
    // generateAnswer takes no temperature argument today (always 0). This pins
    // that fact so a future caller cannot assume synthesis is tunable.
    await generateAnswer({ question: 'q', context: 'ctx', source: 'SQL' })
    expect(JSON.parse(lastFetchCall()!.init.body as string).temperature).toBe(0)
  })

  test('generateAnswer becomes exactly two messages: a system prompt then the question', async () => {
    await generateAnswer({ question: 'How many orders?', context: 'ROW: 5', source: 'SQL' })
    const body = JSON.parse(lastFetchCall()!.init.body as string)
    expect(body.messages).toHaveLength(2)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].role).toBe('user')
    // The source label is embedded in the user turn, not sent as a separate field.
    expect(body.messages[1].content).toContain('CONTEXT (SQL)')
    expect(body.messages[1].content).toContain('ROW: 5')
    expect(body.messages[1].content).toContain('How many orders?')
  })

  test('provider-specific request shaping stays client-side (no provider field is sent)', async () => {
    // cfg.provider selects the TRANSPORT (see llm-client). Leaking it into the
    // JSON body would be rejected as an unknown parameter by strict gateways.
    await generateChat('hello')
    const body = JSON.parse(lastFetchCall()!.init.body as string)
    expect(body.provider).toBeUndefined()
    expect(body.apiKey).toBeUndefined()
  })
})

describe('response parsing — the shapes that are not a normal completion', () => {
  test('an empty choices array yields an empty string rather than throwing', async () => {
    // A provider that returns 200 with `{"choices":[]}` (seen on filtered
    // responses) must not crash the pipeline; callers treat '' as no answer.
    global.fetch = mock(async () => jsonResponse({ choices: [] })) as unknown as typeof fetch
    expect(await generateChat('q')).toBe('')
  })

  test('content null yields an empty string (not the string "null")', async () => {
    global.fetch = mock(async () => jsonResponse({ choices: [{ message: { content: null } }] })) as unknown as typeof fetch
    const out = await generateChat('q')
    expect(out).toBe('')
    expect(out).not.toBe('null')
  })

  test('a missing message object yields an empty string', async () => {
    global.fetch = mock(async () => jsonResponse({ choices: [{}] })) as unknown as typeof fetch
    expect(await generateChat('q')).toBe('')
  })

  test('whitespace-only content is trimmed to the empty string', async () => {
    global.fetch = mock(async () => jsonResponse({ choices: [{ message: { content: '   \n\t  ' } }] })) as unknown as typeof fetch
    expect(await generateChat('q')).toBe('')
  })

  test('HTTP 500 surfaces as a provider error and is NOT silently swallowed into an empty answer', async () => {
    // The dangerous failure mode: treating a 500 as "the model said nothing" and
    // proceeding to synthesize an answer from an empty context.
    global.fetch = mock(async () => ({
      ok: false, status: 500, text: () => Promise.resolve('{"error":{"message":"internal"}}'),
    } as Response)) as unknown as typeof fetch
    await expect(generateChat('q')).rejects.toThrow()
  })

  test('HTTP 429 surfaces as a provider error rather than a retry-forever loop', async () => {
    global.fetch = mock(async () => ({
      ok: false, status: 429, text: () => Promise.resolve('{"error":{"message":"rate limited"}}'),
    } as Response)) as unknown as typeof fetch
    await expect(generateChat('q')).rejects.toThrow()
  })

  test('a network throw propagates instead of being converted to an empty answer', async () => {
    global.fetch = mock(async () => { throw new TypeError('fetch failed: ECONNREFUSED') }) as unknown as typeof fetch
    await expect(generateChat('q')).rejects.toThrow()
  })

  test('a malformed JSON body propagates rather than being read as empty text', async () => {
    global.fetch = mock(async () => ({
      ok: true, status: 200, json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    } as unknown as Response)) as unknown as typeof fetch
    await expect(generateChat('q')).rejects.toThrow()
  })
})

describe('credential safety on the error path', () => {
  // BYOK: the API key belongs to the customer. A key that reaches a log line or
  // an Error message is a credential exposure, not a cosmetic problem.
  test('a provider that echoes the submitted key does NOT put it into the thrown Error message', async () => {
    // WHAT: the OpenAI transport throws `providerError(status, body)` and
    //       LlmProviderError builds its message as
    //       `LLM error (HTTP ${status}): ${body}` from the RAW provider body.
    //       Providers are not required to redact the credential they rejected --
    //       OpenAI replies `Incorrect API key provided: sk-...` -- so the
    //       customer's key lands in Error.message, which is exactly what the API
    //       layer serializes into `{ error: { message } }` and what gets logged.
    // WHY IT MATTERS: this app is BYOK. That key IS the customer's credential
    //       (its own provider account, its own billed quota, its own data
    //       retention). An error path that renders a provider error to a browser
    //       or ships it to log aggregation exposes it.
    // CONSEQUENCE AN ATTACKER GAINS: read access to the org's LLM provider
    //       account, from a low-privilege position -- they only need to trigger
    //       one failing request (e.g. exceed the org quota) and then read the
    //       error text. It is not remote code execution; it is credential theft.
    // FIX DIRECTION: redact `cfg.apiKey` out of the body before it enters the
    //       message (the body stays useful for diagnosis), or keep the body
    //       server-side and expose only classifyProviderFailure()'s category.
    // This test does NOT pin the leak as desirable: it asserts the leak is
    // PRESENT today, so the defect is visible rather than silently green.
    const LEAKY_KEY = 'sk-super-secret-byok-key'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    global.fetch = mock(async () => ({
      ok: false, status: 401, text: () => Promise.resolve(`{"error":{"message":"Incorrect API key provided: ${LEAKY_KEY}"}}`),
    } as Response)) as unknown as typeof fetch

    const { error } = await captureLogs(() => generateChat('q'))
    const message = error instanceof Error ? error.message : String(error)
    // The status must be reported -- that part is correct and must keep working.
    expect(message).toContain('401')
    // INVERTED WHEN FIXED (this round): `redactProviderBody()` in llm-client-utils.ts now strips
    // credential-shaped substrings BEFORE the body enters the message, so the leak asserted here no
    // longer happens. The assertion is the negated form, which is what the old comment asked for --
    // and it is the load-bearing half, because the status check above proves the error is still the
    // real classified one rather than a redactor that swallowed everything.
    expect(message).not.toContain(LEAKY_KEY)
    // The redaction marker is present, so this is a redaction and not a dropped body.
    expect(message).toContain('[REDACTED')
  })

  test('the key does not ALSO reach a console log on the 401 path', async () => {
    // Same request, different sink. Today the body rides only in the Error
    // message; the console line carries `error: <message>`. If the message is
    // ever logged verbatim this fails, which is the correct tripwire.
    const LEAKY_KEY = 'sk-log-check-key'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    global.fetch = mock(async () => ({
      ok: false, status: 401, text: () => Promise.resolve(`{"error":{"message":"Invalid key ${LEAKY_KEY}"}}`),
    } as Response)) as unknown as typeof fetch
    const { lines } = await captureLogs(() => generateChat('q'))
    expect(lines.join('\n')).not.toContain(LEAKY_KEY)
  })

  test('a network failure does not include the API key in the thrown message or logs', async () => {
    const LEAKY_KEY = 'sk-another-secret'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    global.fetch = mock(async (url: string) => { throw new TypeError(`fetch failed for ${String(url)}`) }) as unknown as typeof fetch
    const { error, lines } = await captureLogs(() => generateChat('q'))
    const message = error instanceof Error ? error.message : String(error)
    expect(message).not.toContain(LEAKY_KEY)
    expect(lines.join('\n')).not.toContain(LEAKY_KEY)
  })

  test('the LlmNotConfiguredError names the fix, not the (absent) credential', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    const { error } = await captureLogs(() => generateChat('q'))
    expect(error).toBeInstanceOf(LlmNotConfiguredError)
    const message = (error as Error).message
    // This message is shown directly in the chat UI, so it must be actionable.
    expect(message).toContain('AI Configuration')
    expect(message.toLowerCase()).not.toContain('undefined')
    expect(message.toLowerCase()).not.toContain('null')
  })

  test('apiKey never appears in a successful response object or its logs', async () => {
    const LEAKY_KEY = 'sk-in-response'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    const { value, lines } = await captureLogs(() => routeQuery({
      question: 'hi', hasIntegrations: false, hasDocuments: false,
    }))
    expect(JSON.stringify(value)).not.toContain(LEAKY_KEY)
    expect(lines.join('\n')).not.toContain(LEAKY_KEY)
  })
})

describe('streaming — chunk boundaries, sentinel and truncation', () => {
  test('a JSON object split across two chunks is still parsed into one token', async () => {
    // The classic streaming failure: the reader must buffer until a newline
    // rather than parse each transport chunk as a complete SSE frame.
    const enc = new TextEncoder()
    const whole = 'data: {"choices":[{"delta":{"content":"split-ok"}}]}\n'
    const partA = whole.slice(0, 20)
    const partB = whole.slice(20)
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode(partA)); c.enqueue(enc.encode(partB)); c.enqueue(enc.encode('data: [DONE]\n')); c.close() },
    })
    global.fetch = mock(async () => ({ ok: true, status: 200, body: stream } as Response)) as unknown as typeof fetch
    expect(await collect(streamChat('q'))).toEqual(['split-ok'])
  })

  test('the [DONE] sentinel terminates the stream and is not emitted as a token', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"a"}}]}\n'))
        c.enqueue(enc.encode('data: [DONE]\n'))
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"AFTER-SENTINEL"}}]}\n'))
        c.close()
      },
    })
    global.fetch = mock(async () => ({ ok: true, status: 200, body: stream } as Response)) as unknown as typeof fetch
    const tokens = await collect(streamChat('q'))
    expect(tokens).toEqual(['a'])
    expect(tokens.join('')).not.toContain('AFTER-SENTINEL')
  })

  test('a stream that ends mid-object discards the partial frame rather than emitting garbage', async () => {
    // Truncated SSE: no trailing newline and no sentinel. The reader must not
    // hand a half-parsed object to the UI as a token.
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"complete"}}]}\n'))
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"conten'))
        c.close()
      },
    })
    global.fetch = mock(async () => ({ ok: true, status: 200, body: stream } as Response)) as unknown as typeof fetch
    const tokens = await collect(streamChat('q'))
    expect(tokens).toEqual(['complete'])
  })

  test('a null delta content is skipped instead of yielding the string "null"', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":null}}]}\n'))
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"real"}}]}\n'))
        c.enqueue(enc.encode('data: [DONE]\n'))
        c.close()
      },
    })
    global.fetch = mock(async () => ({ ok: true, status: 200, body: stream } as Response)) as unknown as typeof fetch
    expect(await collect(streamChat('q'))).toEqual(['real'])
  })

  test('NEITHER answer path asks the model to write a source line in the prose', async () => {
    /*
     * REVERSED EXPECTATION, and the reason matters more than the assertion. This test used to read
     * "streamAnswer does not append a data-source attribution line (only generateAnswer does)" — it pinned
     * `generateAnswer` asking for attribution, which was the behaviour at the time.
     *
     * MEASURED: the operator's own system prompt ("Cite sources when using retrieved knowledge") made every reply end
     * with a "Sumber: …" sentence, which the user has to read past while the interface ALREADY renders the same
     * attribution as structured metadata. The requirement is now that the model is told NOT to, on both paths — a rule
     * present in one prompt only is a rule the other path does not have.
     */
    await collect(streamAnswer({ question: 'q', context: 'ctx', source: 'RAG' }))
    const streamed = JSON.parse(lastFetchCall()!.init.body as string)
      .messages.map((m: { content: string }) => m.content).join('\n')
    expect(streamed).not.toContain('Mention the data source naturally')
    expect(streamed).toContain('Do NOT end the answer with a source')

    await generateAnswer({ question: 'q', context: 'ctx', source: 'RAG' })
    const nonStreamed = JSON.parse(lastFetchCall()!.init.body as string)
      .messages.map((m: { content: string }) => m.content).join('\n')
    expect(nonStreamed).not.toContain('Mention the data source naturally')
    expect(nonStreamed).toContain('Do NOT write a source')
  })

  test('a streaming 500 surfaces as an error before any token is yielded', async () => {
    global.fetch = mock(async () => ({
      ok: false, status: 500, text: () => Promise.resolve('{"error":{"message":"boom"}}'),
    } as Response)) as unknown as typeof fetch
    await expect(collect(streamChat('q'))).rejects.toThrow()
  })

  test('the stream request sets stream:true so the provider switches to SSE', async () => {
    await collect(streamChat('q'))
    const body = JSON.parse(lastFetchCall()!.init.body as string)
    expect(body.stream).toBe(true)
  })
})

describe('routeQuery — the model reply is normalised before matching', () => {
  // MUTATION-CONFIRMED GAP: replacing `decisionRaw.toUpperCase().trim()` with
  // `decisionRaw.trim()` turned ZERO tests red. Every existing router test feeds
  // an already-uppercase reply, but a real provider is not obliged to answer in
  // the case the prompt asked for (small models routinely reply "sql", "Sql",
  // or with a leading/trailing newline). Without normalisation those all fall
  // through to the final `else` and route to CHAT -- so a data question would
  // skip SQL/RAG entirely and the bot would answer from pretrained knowledge.
  test('a lowercase "sql" reply still routes to SQL', async () => {
    fetchRouterResponse = 'sql'
    expect((await routeQuery({ question: 'how many orders?', hasIntegrations: true, hasDocuments: false })).decision).toBe('SQL')
  })

  test('a lowercase "rag" reply still routes to RAG', async () => {
    fetchRouterResponse = 'rag'
    expect((await routeQuery({ question: 'what is the SOP?', hasIntegrations: false, hasDocuments: true })).decision).toBe('RAG')
  })

  test('a lowercase "rest" reply still routes to REST', async () => {
    fetchRouterResponse = 'rest'
    expect((await routeQuery({ question: 'check the ticket', hasIntegrations: false, hasDocuments: false })).decision).toBe('REST')
  })

  test('a lowercase "contextual_chat" reply still routes to CONTEXTUAL_CHAT', async () => {
    fetchRouterResponse = 'contextual_chat'
    expect((await routeQuery({ question: 'and that one?', hasIntegrations: false, hasDocuments: false })).decision).toBe('CONTEXTUAL_CHAT')
  })

  test('surrounding whitespace and newlines do not change the decision', async () => {
    fetchRouterResponse = '  Sql\n'
    expect((await routeQuery({ question: 'how many?', hasIntegrations: true, hasDocuments: false })).decision).toBe('SQL')
  })

  test('a reply naming the category in a sentence is still matched by prefix', async () => {
    fetchRouterResponse = 'RAG because it is a policy document'
    expect((await routeQuery({ question: 'policy?', hasIntegrations: false, hasDocuments: true })).decision).toBe('RAG')
  })

  test('an empty reply falls back to CHAT rather than throwing', async () => {
    fetchRouterResponse = ''
    expect((await routeQuery({ question: 'hi', hasIntegrations: false, hasDocuments: false })).decision).toBe('CHAT')
  })
})

describe('homepage documentation routes', () => {
  // The table description join is the only place routeQuery reaches through a
  // relation (`t.integration.name`). A malformed row would throw inside the
  // router and take down every chat turn, so the mapping is pinned here.
  test('table descriptions are rendered as integration.table: description', async () => {
    fetchRouterResponse = 'SQL'
    mockIntegrationSchemaFindMany.mockImplementation(async () => [
      { tableName: 'sales', description: 'Sales facts', integration: { name: 'ERP' } },
      { tableName: 'empty', description: null, integration: { name: 'ERP' } },
    ])
    await routeQuery({ question: 'how many sales?', hasIntegrations: true, hasDocuments: false })
    const userMsg = getSentMessages().find((m) => m.content.includes('Table descriptions'))
    expect(userMsg!.content).toContain('ERP.sales: Sales facts')
    // A null description must be SKIPPED in the descriptions block, not rendered
    // as "ERP.empty: null". Scope the check to that block: `empty` legitimately
    // still appears in the `Database tables:` list above it.
    const descriptionsBlock = userMsg!.content.split('Table descriptions:\n')[1].split('\nAnswer only')[0]
    expect(descriptionsBlock).not.toContain('empty')
    expect(descriptionsBlock).not.toContain('null')
  })

  test('documents with a category are labelled, and category-less ones are not', async () => {
    fetchRouterResponse = 'RAG'
    mockDocumentFindMany.mockImplementation(async () => [
      { name: 'SOP.pdf', category: 'Policy' },
      { name: 'notes.txt', category: null },
    ])
    await routeQuery({ question: 'policy?', hasIntegrations: false, hasDocuments: true })
    const userMsg = getSentMessages().find((m) => m.content.includes('Documents:'))
    expect(userMsg!.content).toContain('SOP.pdf [Policy]')
    expect(userMsg!.content).toContain('notes.txt')
    expect(userMsg!.content).not.toContain('notes.txt [')
  })

  test('the REST-API flag is printed as a boolean, defaulting to false when omitted', async () => {
    fetchRouterResponse = 'CHAT'
    await routeQuery({ question: 'hi', hasIntegrations: false, hasDocuments: false })
    const userMsg = getSentMessages().find((m) => m.content.includes('Context:'))
    // `undefined` interpolated into the prompt would read as "REST APIs available=undefined".
    expect(userMsg!.content).toContain('REST APIs available=false')
  })
})

describe('historyToMessages — the window and the blank-turn filter', () => {
  /*
   * MUTATION-CONFIRMED GAP: widening the window from `slice(-10)` to `slice(-100)` turned ZERO tests red, which is
   * why this test exists. The window is a real BUDGET: history is re-sent on every request, on the customer's BYOK
   * key, so a silent widening inflates every prompt. The 10 x 2000 window was reduced to 6 x 800 — see
   * `HISTORY_MAX_TURNS` in `ai.ts` for the measurement — and this test pins the NEW budget in both dimensions.
   */
  test('at most the last 6 turns are carried, in chronological order', async () => {
    const { historyToMessages } = await import('./ai')
    const history = Array.from({ length: 12 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `msg${i}`,
    }))
    const out = historyToMessages(history)
    // 1 system label + exactly 6 turns.
    expect(out).toHaveLength(7)
    expect(out[0].role).toBe('system')
    // The six OLDEST turns are dropped, the newest survives. Membership must be tested on whole strings:
    // 'msg0' is a SUBSTRING of 'msg10'/'msg11', so a naive toContain('msg0') fails even when msg0 was dropped.
    const bodies = out.slice(1).map((m) => m.content)
    expect(bodies).not.toContain('msg0')
    expect(bodies).not.toContain('msg5')
    expect(bodies.at(-1)).toBe('msg11')
    expect(bodies).toEqual(['msg6', 'msg7', 'msg8', 'msg9', 'msg10', 'msg11'])
  })

  test('the window is the DECLARED budget, not a magic number in the slice', async () => {
    // The caps are exported so callers and this test read ONE source. A change to the budget must be a change to
    // the named constants, or the send route and this test disagree about what the window is.
    const { HISTORY_MAX_TURNS, HISTORY_TURN_MAX_CHARS } = await import('./ai')
    expect(HISTORY_MAX_TURNS).toBe(6)
    expect(HISTORY_TURN_MAX_CHARS).toBe(800)
  })

  test('the system label precedes the turns but never appears as a dialogue turn', async () => {
    const { historyToMessages } = await import('./ai')
    const out = historyToMessages([{ role: 'user', content: 'hello' }])
    expect(out[0].role).toBe('system')
    expect(out[0].content).toContain('Prior conversation history')
    expect(out[1]).toEqual({ role: 'user', content: 'hello' })
  })

  test('blank and whitespace-only turns are dropped from the dialogue', async () => {
    // An empty user turn would produce a degenerate "user: " message pair that
    // some providers reject outright (Anthropic requires non-empty content).
    const { historyToMessages } = await import('./ai')
    const out = historyToMessages([
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: '' },
      { role: 'user', content: '   \n  ' },
      { role: 'assistant', content: 'real answer' },
    ])
    const bodies = out.slice(1).map((m) => m.content)
    expect(bodies).toEqual(['real question', 'real answer'])
  })

  test('a long turn is truncated to 800 characters in the dialogue turn', async () => {
    const { historyToMessages } = await import('./ai')
    const out = historyToMessages([{ role: 'user', content: 'x'.repeat(5000) }])
    // The dialogue turn itself carries exactly the 800-char window.
    expect(out[1].content).toHaveLength(800)
    expect(out[1].content).toBe('x'.repeat(800))
    // The dropped characters never reach the prompt.
    expect(out[1].content).not.toContain('x'.repeat(801))
  })

  test('the system label does NOT duplicate the history — it was 20116 chars and got discarded', async () => {
    /*
     * MEASURED DEFECT this pins, with the number: the label used to EMBED the whole history a
     * second time (`Prior conversation history (most recent last):\n${formatHistory(recent)}`).
     * With ten realistic 2000-character turns that is 20,116 characters in ONE system message,
     * and the provider DISCARDS a system message above ~2000 whole — so on any long conversation
     * the label never arrived, while the same text was sent AND PAID FOR twice.
     *
     * The previous version of the test above asserted the duplication as CORRECT
     * (`expect(/^x+$/.exec(afterPrefix)![0]).toHaveLength(2000)`), which is how it survived: a
     * test pinning a lossy stage entrenches it. The assertion is now inverted on purpose.
     */
    const { historyToMessages } = await import('./ai')
    // Ten full-length turns, because the OLD budget (10 x 2000) is what produced the 20,116-char label. The
    // new window keeps six of them; the label still carries none of the payload either way.
    const tenFullTurns = Array.from({ length: 10 }, (_, i) => ({
      role: 'user' as const,
      content: `turn ${i} ` + 'y'.repeat(2000),
    }))
    const out = historyToMessages(tenFullTurns)
    const label = out[0]
    expect(label.role).toBe('system')
    // The label carries the SIGNAL — that these are prior turns — and none of the payload.
    expect(label.content).toContain('Prior conversation history')
    expect(label.content).not.toContain('y'.repeat(50))
    // And the NEW window really is smaller: 6 turns, not 10, is what keeps this defect un-reachable at the new cap.
    expect(out).toHaveLength(7)
    // Measured against the real ceiling, not a vibe: the joined system text must fit.
    const joinedSystem = out.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    expect(joinedSystem.length).toBeLessThan(2000)
    // The payload itself is still delivered — in the TURNS, which is the whole point. The sixth-newest turn
    // is the oldest that survives the window, and it carries its full 800-character share.
    expect(out).toHaveLength(7)
    expect(out[6].content).toContain('y'.repeat(500))
  })

  test('an assistant turn stays assistant (not relabelled user)', async () => {
    const { historyToMessages } = await import('./ai')
    const out = historyToMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ])
    expect(out.slice(1).map((m) => m.role)).toEqual(['user', 'assistant'])
  })
})

describe('DEFECT: provider body carrying the API key reaches GET /api/traces', () => {
  // CHAIN (all measured, not inferred):
  //   ai.ts resolveBackend() -> llm-client chatOnce -> !res.ok ->
  //   readErrorBody(res) = res.text()                       [RAW provider body]
  //   -> new LlmProviderError(status, body)
  //        message = `LLM error (HTTP ${status}): ${body.slice(0,200)}`   <- KEY HERE
  //   -> chatOnce's catch: logLlmUsage(..., { error: e.message })
  //   -> logLlmUsage -> traceLlmCall({ ..., error })        [observability.ts:47]
  //   -> pushes { error } into the module-level ring buffer
  //   -> getRecentTraces(limit)                             [observability.ts:44]
  //   -> src/app/api/traces/route.ts:10
  //        NextResponse.json({ ok: true, traces: getRecentTraces(limit) })
  //   => the customer's provider key is in an HTTP JSON response body.
  //
  // WHAT IS *NOT* BROKEN (checked, so this is not overstated):
  //   - src/lib/errors.ts toTypedError() has an explicit `instanceof
  //     LlmProviderError` branch that DISCARDS e.message and returns a canned
  //     "AI provider error: authentication failed" + failure.hint.
  //   - src/app/api/chat/sessions/[id]/send/route.ts builds its SSE error frame
  //     from PROVIDER_ERROR_TEXT + failure.hint, never e.message, and comments
  //     "Never pass raw error text to the client".
  //   So the SSE chat path and the typed-error path do NOT leak. The leak is
  //   the observability trace surface (and whatever log shipper consumes it).
  //
  // CONSEQUENCE: /api/traces requires a session, so the reader is an authenticated
  //   user of the same install -- but `traces` is a debug surface the security view
  //   renders, and the ring buffer is process-global (NOT org-filtered), so any
  //   authenticated user sees every org's captured payloads in that process. Today
  //   that yields the org's own provider key; a shared/forwarded log or an
  //   OTel exporter (forwardTrace) widens it further.
  // FIX DIRECTION: redact cfg.apiKey from `body` in readErrorBody/LlmProviderError
  //   before it is stored anywhere; the classified category already carries all the
  //   diagnostic value the trace view needs.
  test('the key is REDACTED in the trace error string the traces API serialises', async () => {
    const LEAKY_KEY = 'sk-trace-exposed-key'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    global.fetch = mock(async () => ({
      ok: false, status: 401, text: () => Promise.resolve(`{"error":{"message":"Incorrect API key provided: ${LEAKY_KEY}"}}`),
    } as Response)) as unknown as typeof fetch

    const { getRecentTraces } = await import('@/lib/observability')
    await captureLogs(() => generateChat('q'))

    // The ring buffer is capped at 100 and shared with every other test in this
    // file, so scope the assertion to THIS call's trace rather than to the whole
    // buffer (a positional read is order-dependent and flaky).
    // INVERTED WHEN FIXED (this round): `redactProviderBody()` strips the credential before the message
    // is stored, so the trace now carries the DIAGNOSTIC VALUE without the secret. Scope the assertion to
    // the trace for THIS call, found by the redaction marker, because the ring buffer is shared with every
    // other test in this file.
    const mine = getRecentTraces(100).filter((t) => t.error && t.error.includes('[REDACTED'))
    expect(mine.length).toBeGreaterThan(0)
    // The status is still reported, so this is redaction and not a dropped body.
    expect(mine[0].error).toContain('401')
    expect(JSON.stringify(mine)).not.toContain(LEAKY_KEY)
    // And the key is absent from the WHOLE buffer, i.e. no trace anywhere retained it.
    expect(JSON.stringify({ ok: true, traces: getRecentTraces(100) })).not.toContain(LEAKY_KEY)
  })

  test('the classified error the USER sees is sanitised, even though the trace is not', async () => {
    // The counterweight that keeps the finding honest: the browser-facing typed
    // error is already redacted, so this is not a "key in the UI" bug.
    const LEAKY_KEY = 'sk-user-facing-check'
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: LEAKY_KEY, model: 'm',
    }))
    global.fetch = mock(async () => ({
      ok: false, status: 401, text: () => Promise.resolve(`{"error":{"message":"Incorrect API key provided: ${LEAKY_KEY}"}}`),
    } as Response)) as unknown as typeof fetch

    const { error } = await captureLogs(() => generateChat('q'))
    const { toTypedError } = await import('@/lib/errors')
    const typed = toTypedError(error)
    expect(typed.code).toBe('LLM_ERROR')
    expect(typed.statusCode).toBe(502)
    expect(typed.message).not.toContain(LEAKY_KEY)
    expect(typed.message).toContain('authentication failed')
    // The hint must be actionable for a BYOK customer.
    expect(typed.hint).toContain('AI Configuration')
  })
})

describe('the answer prompts must never invite a FABRICATED CAUSE or a one-sided comparison', () => {
  /**
   * MEASURED IN UAT, two findings on the same prompt:
   *
   * 1. Asked about support tickets — a topic with no connected source and NO tool call at all — the answer asserted
   *    "Permintaan ke sistem (REST API) gagal karena kendala jaringan, endpoint mengarah ke host internal yang
   *    diblokir", then told the user to whitelist a host at their firewall. There was no request, no endpoint and no
   *    failure. A fabricated CAUSE is worse than a fabricated number: the number is checkable, while an invented
   *    infrastructure fault reads as diagnosis and sends people to the wrong team.
   *
   * 2. "Bandingkan jumlah pengiriman dengan jumlah pesanan" returned ONE source and relabelled its shipment counts as
   *    "pesanan" — reporting "8 pesanan" when Sales held 12 orders. The second half of the comparison vanished and the
   *    first half was renamed, so a reader compares the wrong things entirely.
   *
   * Both prompts are asserted, because `generateAnswer` and `streamAnswer` diverge silently otherwise — this file
   * already documents that class of drift.
   */
  const src = readFileSync(join(import.meta.dir, 'ai.ts'), 'utf8')

  test('both prompts forbid inventing a cause for a failure', () => {
    const hits = src.match(/Never invent a REASON for a failure/g) ?? []
    expect(hits.length).toBe(2)
    // The specific lies the model told must be named, so the rule cannot read as generic caution.
    expect(src).toMatch(/blocked host/)
    expect(src).toMatch(/never tell the user to change firewall/)
  })

  test('both prompts require a comparison to state which side was missing', () => {
    const hits = src.match(/never relabel one source/g) ?? []
    expect(hits.length).toBe(2)
    expect(src).toMatch(/COMPARE/)
  })

  test('the pre-existing honesty rule survives — this is an append, not a rewrite', () => {
    // "Never invent data" was already there and caught neither defect, but removing it would be a regression.
    expect((src.match(/Never invent data/g) ?? []).length).toBe(2)
  })
})

describe('routeQuery — the router prompt must not NAME sources outside the caller scope', () => {
  /**
   * MEASURED DEFECT this pins: `routeQuery` listed every table, document, table DESCRIPTION and REST path in the
   * install to the router prompt, with no scope applied — while its caller had the scope in hand and applied it to
   * the counts. A key restricted to one integration could not READ the others, but was told their names:
   *
   *     docNames          -> `Documents: Resignation-2026-Q3.xlsx, Salary-Bands.xlsx, …`
   *     tableDescriptions -> `Table descriptions: Finance.payroll: monthly salary per employee …`
   *
   * Naming is the leak. A table description is business content, and a document name is often the most sensitive
   * string in a deployment. The assertions below check the WHERE CLAUSE actually sent to each query, because a
   * scope that is accepted and not applied is the "defence tested while callers bypass it" shape.
   */
  const scoped = {
    question: 'Berapa total gaji bulan ini?',
    hasIntegrations: true,
    hasDocuments: true,
    integrationIds: ['int-allowed'],
    documentIds: ['doc-allowed'],
  }

  /**
   * The `where` of the last call, or undefined.
   *
   * `.mock.calls` holds one entry PER CALL, and each entry is the ARGUMENT LIST — so the argument is `[0]` of that
   * entry. Reading `entry.where` instead returns undefined and the assertion then fails for a reason unrelated to
   * the scope, which is how the first version of this helper was written.
   */
  const lastWhere = (m: { mock: { calls: unknown[] } }): Record<string, unknown> | undefined => {
    const call = m.mock.calls.at(-1) as Array<{ where?: Record<string, unknown> }> | undefined
    return call?.[0]?.where
  }

  test('the document query carries the document scope', async () => {
    mockDocumentFindMany.mockClear()
    await routeQuery(scoped)
    expect(lastWhere(mockDocumentFindMany)).toMatchObject({ id: { in: ['doc-allowed'] } })
  })

  test('the table-schema query carries the integration scope on the RELATION', async () => {
    // The schema rows hang off the integration, so the constraint belongs on `integration`, not on the row.
    mockIntegrationSchemaFindMany.mockClear()
    await routeQuery(scoped)
    expect(lastWhere(mockIntegrationSchemaFindMany)).toMatchObject({
      integration: { status: 'active', id: { in: ['int-allowed'] } },
    })
  })

  test('an ABSENT scope stays unrestricted, so keys predating the axes are not locked out', async () => {
    /*
     * The other half of the rule. `loadDbData` spreads its scope conditionally for exactly this reason: an empty
     * `in: []` matches nothing, so treating "no scope" as "no sources" would break every key created before these
     * axes existed. Both spellings must stay unrestricted.
     */
    for (const ctx of [{ ...scoped, integrationIds: undefined, documentIds: undefined }, { ...scoped, integrationIds: [], documentIds: [] }]) {
      mockDocumentFindMany.mockClear()
      mockIntegrationSchemaFindMany.mockClear()
      await routeQuery(ctx)
      expect(JSON.stringify(lastWhere(mockDocumentFindMany) ?? {})).not.toContain('"in"')
      expect(JSON.stringify(lastWhere(mockIntegrationSchemaFindMany) ?? {})).not.toContain('"in"')
    }
  })
})

describe('routeQuery — a user-pinned source must reach the router PROMPT', () => {
  /**
   * The picker tells the user "other sources are excluded for this turn". MEASURED: the id never reached
   * `routeQuery`, so the router chose from the FULL source list and a pinned-database question could still be routed
   * to documents. The pin only bound AFTER the route was decided (`resolvedIntegrationId`, used only when the route is
   * SQL) — which is not what the UI promises.
   *
   * The assertion reads the PROMPT SENT, not the code path: a pin accepted and not delivered is the "instruction
   * never DELIVERED" class, and that class is invisible from the call site.
   */
  test('the pinned source name appears in the router system prompt', async () => {
    await routeQuery({
      question: 'Berapa jumlah pesanan?',
      hasIntegrations: true,
      hasDocuments: true,
      pinnedSourceName: 'Sales Database',
    })
    // BOTH messages. The pin is in the USER one on purpose — see the ceiling note in ai.ts: a system message above
    // ~2000 characters is DISCARDED by the provider, so the source lists and the pin cannot live there.
    const prompt = getSentMessages().map((m) => m.content).join('\n')
    expect(prompt).toContain('THE USER EXPLICITLY CHOSE THIS SOURCE')
    expect(prompt).toContain('Sales Database')
  })

  test('with no pin the directive is absent, so an auto-routed turn is not biased', async () => {
    await routeQuery({ question: 'Berapa jumlah pesanan?', hasIntegrations: true, hasDocuments: true })
    const prompt = getSentMessages().map((m) => m.content).join('\n')
    expect(prompt).not.toContain('THE USER EXPLICITLY CHOSE THIS SOURCE')
  })
})

describe('generateRestCall — the endpoint list is bounded', () => {
  /*
   * MEASURED SHAPE OF THE RISK: every enabled endpoint of every active connector used to be listed with its FULL
   * `sampleResponse` and `parameterSchema`. Those are operator-entered JSON, so a rich sample payload costs
   * kilobytes per endpoint; nothing in the current install exercises REST, which is exactly why the growth went
   * unnoticed. With 50 endpoints this is tens of thousands of characters on one routing call.
   */
  const eps = (n: number, sampleLen: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `e${i}`, connectorName: 'CRM', method: 'GET', path: `/p${i}`,
      description: 'desc', parameterSchema: '{"q":"string"}',
      sampleResponse: 'x'.repeat(sampleLen),
    }))

  test('a large sampleResponse is cut to a PREFIX, not sent whole', async () => {
    fetchRestResponse = '{"endpointId":"e0","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'q', endpoints: eps(1, 10_000) })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    expect(user).toContain('…[truncated, 10000 chars total]')
    expect(user.length, 'the sample must not be sent whole').toBeLessThan(2_000)
  })

  test('a SHORT sampleResponse is sent as-is (no truncation marker on healthy data)', async () => {
    fetchRestResponse = '{"endpointId":"e0","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'q', endpoints: eps(1, 50) })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    expect(user).toContain('x'.repeat(50))
    expect(user).not.toContain('[truncated')
  })

  test('more than 40 endpoints are not listed, and the model is TOLD how many there are', async () => {
    fetchRestResponse = '{"endpointId":"e0","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'q', endpoints: eps(60, 10) })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    // The notice is the part that keeps the cap honest: without it the model believes it has seen every endpoint.
    expect(user).toContain('[60 endpoints configured; showing the 40 most relevant to the question')
    expect(user).toContain('if none matches, say so rather than guessing')
    // With nothing in the question to rank by, the order is the caller's, so the cap keeps the first 40.
    expect(user).toContain('id=e39;')
    expect(user).not.toContain('id=e40;')
  })

  test('the 40 listed are the most RELEVANT, so an endpoint past the 40th position is still offered', async () => {
    // MEASURED with three APIs and 50 endpoints: the tracking endpoint lay past the 40th position and was never
    // listed, so no model could call it. Relevance, not position, decides who makes the cut.
    const many = [
      ...eps(55, 10),
      { id: 'track', connectorName: 'Shipping', method: 'GET', path: '/ship/track', description: 'Track a shipment', parameterSchema: null, sampleResponse: null },
    ]
    fetchRestResponse = '{"endpointId":"track","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'Track shipment SHP-1001', endpoints: many })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    expect(user).toContain('id=track;')
    expect(user.split('\n').filter((l) => l.startsWith('- id=')).length).toBe(40)
  })

  test('with nothing relevant, every API keeps a share of the 40 slots', async () => {
    const a = Array.from({ length: 45 }, (_, i) => ({ id: `a${i}`, connectorName: 'Big', method: 'GET', path: `/a${i}`, description: null, parameterSchema: null, sampleResponse: null }))
    const b = Array.from({ length: 5 }, (_, i) => ({ id: `b${i}`, connectorName: 'Small', method: 'GET', path: `/b${i}`, description: null, parameterSchema: null, sampleResponse: null }))
    fetchRestResponse = '{"endpointId":"a0","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'q', endpoints: [...a, ...b] })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    // By position, the 45 "Big" endpoints filled all 40 slots and "Small" vanished entirely.
    expect(user).toContain('connector=Small;')
  })

  test('parameterSchema stays FULL — it is the contract the model must not violate', async () => {
    const schema = '{' + '"k":"v",'.repeat(400) + '"last":1}'
    fetchRestResponse = '{"endpointId":"e0","query":{},"body":null,"explanation":"x"}'
    await generateRestCall({ question: 'q', endpoints: [{ id: 'e0', connectorName: 'C', method: 'GET', path: '/p', description: 'd', parameterSchema: schema, sampleResponse: null }] })
    const user = getSentMessages().find((m) => m.role === 'user')!.content
    expect(user).toContain(schema)
  })
})
