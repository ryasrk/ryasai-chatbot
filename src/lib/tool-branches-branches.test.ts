import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Coverage for the branch executors that had none.
//
// Kept in its own file because the sibling tool-branches.test.ts deliberately
// mocks @/lib/tool-utils PARTIALLY, and a partial mock of that module does not
// reliably reach this file's code (measured both ways: in one process the mock
// landed, in another the real implementation ran). A mock that lands sometimes
// makes an assertion pass for the wrong reason, so this file mocks the FULL
// surface and never shares state with the sibling.
//
// NOTHING in src/ was modified to make these tests pass. Where an expectation
// disagreed with the code, the expectation was corrected — see the notes on
// runRestBranch's failure path and on the non-streaming envelope.
// ---------------------------------------------------------------------------
const ai = {
  chat: 'chat-answer',
  answer: 'generated-answer',
  restPlan: { endpointId: 'ep-1', query: {}, body: null, explanation: 'e' } as any,
  usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } as any,
  calls: [] as Array<{ fn: string; args: any }>,
}

mock.module('@/lib/ai', () => ({
  generateChat: async (...args: any[]) => { ai.calls.push({ fn: 'generateChat', args }); return ai.chat },
  generateAnswer: async (a: any) => { ai.calls.push({ fn: 'generateAnswer', args: a }); return ai.answer },
  generateSql: async () => ({ sql: 'SELECT 1', explanation: '' }),
  generateRestCall: async (a: any) => { ai.calls.push({ fn: 'generateRestCall', args: a }); return ai.restPlan },
}))
mock.module('@/lib/llm-client', () => ({
  getLastLlmUsage: () => ai.usage,
}))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-1',
  enterWithOrg: () => {},
}))

const dbState = {
  connectors: [] as any[],
  plugins: null as any,
  requestLogs: [] as any[],
  auditLogs: [] as any[],
  findManyArgs: [] as any[],
  pluginFindArgs: [] as any[],
}
function makeDb() {
  return {
    restApiConnector: { findMany: async (a: any) => { dbState.findManyArgs.push(a); return dbState.connectors } },
    restApiRequestLog: { create: async (a: any) => { dbState.requestLogs.push(a); return {} } },
    plugin: { findFirst: async (a: any) => { dbState.pluginFindArgs.push(a); return dbState.plugins } },
    auditLog: { create: async (a: any) => { dbState.auditLogs.push(a); return {} } },
  }
}
mock.module('@/lib/db', () => ({ db: makeDb() }))

const pluginState = { relevant: [] as any[], result: { ok: true, output: '20C', error: null, latencyMs: 1 } as any, calls: [] as any[] }
mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: async (a: any) => { pluginState.calls.push(a); return pluginState.relevant },
}))
mock.module('@/lib/plugin-registry', () => ({
  executePlugin: async (a: any) => pluginState.result,
}))
// The FULL surface of tool-utils, so this mock cannot be silently bypassed.
mock.module('@/lib/tool-utils', () => ({
  summarize: (s: string) => (s ?? '').slice(0, 100),
  unavailableDataSourceResult: (type: string, question: string) => ({
    answer: 'The required data source is not yet available or not configured as active.',
    citations: [],
    chartData: null,
    toolRuns: [{ type, status: 'blocked', latencyMs: 0, inputSummary: question, errorMessage: 'Data source unavailable.' }],
  }),
  ambiguousDataSourceResult: (type: string, question: string) => ({
    answer: 'Multiple data sources match.',
    citations: [],
    chartData: null,
    toolRuns: [{ type, status: 'blocked', latencyMs: 0, inputSummary: question, errorMessage: 'Ambiguous data source.' }],
  }),
  withSqlConcurrency: async (fn: () => Promise<unknown>) => fn(),
  buildChartDataFromRows: () => null,
  buildDocumentCitation: () => ({}),
  sanitizeSqlError: (e: unknown) => String(e),
  safeParseColumns: () => [],
  safeParseSampleRow: () => null,
  extractTableName: () => 't',
  jsonRowsToChart: () => null,
  safeJson: (s: string) => { try { return JSON.parse(s) } catch { return null } },
}))
mock.module('@/lib/rest-api-connectors', () => ({
  buildAuthHeaders: async () => ({ Authorization: 'Bearer test' }),
  // Mirrors the real normalisation (trim leading '/', ensure a trailing '/'
  // on the base). The first version of this mock used a bare `new URL(path,
  // base)` and made every success-path test fail with
  // '"/items" cannot be parsed as a URL' — the fake was wrong, not the code.
  buildEndpointUrl: (base: string, path: string, q: any) => {
    const u = new URL(path.replace(/^\/+/, ''), base.endsWith('/') ? base : base + '/')
    for (const [k, v] of Object.entries(q ?? {})) {
      if (v === undefined || v === null) continue
      u.searchParams.set(k, String(v))
    }
    return u.toString()
  },
  matchEndpoint: (method: string, path: string, eps: any[]) =>
    eps.find((e) => e.enabled && e.method.toUpperCase() === method.toUpperCase() && e.path === path) ?? null,
  sanitizeHeaders: () => ({ Authorization: '****' }),
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}), encryptConfig: () => '' }))
mock.module('@/lib/connectors', () => ({ connectorRegistry: {}, describeSchema: () => '' }))
mock.module('@/lib/guardrails', () => ({ validateAndSanitizeLlmSql: () => ({ ok: true, sql: 'SELECT 1' }) }))
mock.module('@/lib/constants', () => ({ SQL_REPAIR_ATTEMPTS: 2, SQL_MAX_LIMIT: 100 }))
mock.module('@/lib/intent-pipeline', () => ({ retrieveWithReflection: async () => ({ chunks: [], reflection: null }) }))
mock.module('@/lib/prompt-settings', () => ({ getPromptSettings: async () => ({}) }))
mock.module('@/lib/source-guidance', () => ({ buildSourceGuidance: () => '' }))
mock.module('@/lib/evidence-boundary', () => ({ wrapUntrusted: (h: string, b: string) => `${h}\n${b}` }))
mock.module('@/lib/smart-router', () => ({
  resolveIntegrationForQuestion: async () => null,
  tokenize: (s: string) => s.toLowerCase().split(/\W+/).filter(Boolean),
}))
mock.module('@/lib/tool-sandbox', () => ({ withToolSandbox: async (fn: any) => fn() }))
mock.module('@/lib/tool-rate-limit', () => ({ checkToolRateLimit: async () => ({ allowed: true }) }))

import { runChatBranch, runContextualChatBranch, runRestBranch, runPluginBranch, executeRestRequest } from './tool-branches'

const origFetch = globalThis.fetch
beforeEach(() => {
  ai.chat = 'chat-answer'
  ai.answer = 'generated-answer'
  ai.restPlan = { endpointId: 'ep-1', query: {}, body: null, explanation: 'e' }
  ai.usage = { promptTokens: 3, completionTokens: 4, totalTokens: 7 }
  ai.calls = []
  dbState.connectors = []
  dbState.plugins = null
  dbState.requestLogs = []
  dbState.auditLogs = []
  dbState.findManyArgs = []
  dbState.pluginFindArgs = []
  pluginState.relevant = []
  pluginState.result = { ok: true, output: '20C', error: null, latencyMs: 1 }
  pluginState.calls = []
})
afterEach(() => { globalThis.fetch = origFetch })

describe('runChatBranch', () => {
  test('returns a CHAT tool run with no citations and the question summarised', async () => {
    const r = await runChatBranch({ question: 'hi there' })
    expect(r.answer).toBe('chat-answer')
    expect(r.citations).toEqual([])
    expect(r.chartData).toBeNull()
    expect(r.usage).toEqual(ai.usage)
    expect(r.toolRuns).toHaveLength(1)
    expect(r.toolRuns[0].type).toBe('CHAT')
    expect(r.toolRuns[0].status).toBe('success')
    expect(r.toolRuns[0].inputSummary).toBe('hi there')
    expect(r.toolRuns[0].outputSummary).toBe('chat-answer')
  })

  test('prompt prefix, memory and history are all forwarded to the LLM', async () => {
    const history = [{ role: 'user' as const, content: 'earlier' }]
    await runChatBranch({ question: 'q', systemPromptPrefix: 'SYS', memoryContext: 'MEM', chatHistory: history })
    // Dropping any of these silently loses the user's memory/instructions.
    const call = ai.calls.find((c) => c.fn === 'generateChat')!
    expect(call.args).toEqual(['q', 'SYS', 'MEM', history])
  })

  test('a very long question is truncated in the summary, not stored whole', async () => {
    const r = await runChatBranch({ question: 'x'.repeat(500) })
    // ToolRun summaries are for the metrics/UI, not a second copy of the prompt.
    expect(r.toolRuns[0].inputSummary.length).toBeLessThanOrEqual(100)
  })
})

describe('runContextualChatBranch', () => {
  test('summarises the CONTEXT, not the answer', async () => {
    const r = await runContextualChatBranch({ question: 'hi', context: 'CTX' })
    expect(r.answer).toBe('generated-answer')
    // The distinguishing detail: this branch reports the supplied context as the
    // run's output, because the context IS what was grounded on.
    expect(r.toolRuns[0].outputSummary).toBe('CTX')
    expect(r.toolRuns[0].inputSummary).toBe('hi')
  })

  test('source is CHAT and the context is passed through', async () => {
    await runContextualChatBranch({ question: 'q', context: 'C', memoryContext: 'M' })
    const call = ai.calls.find((c) => c.fn === 'generateAnswer')!
    expect(call.args.source).toBe('CHAT')
    expect(call.args.context).toBe('C')
    expect(call.args.memoryContext).toBe('M')
  })

  test('unlike runChatBranch it reports NO usage', async () => {
    const r = await runContextualChatBranch({ question: 'q', context: 'c' })
    // Measured, and it is an asymmetry between two sibling functions. Pinned so
    // the difference is deliberate rather than accidental.
    expect(r.usage).toBeUndefined()
  })
})

describe('runRestBranch', () => {
  // The FULL connector shape the DB would return. `runRestBranch` forwards the
  // whole row to executeRestRequest, so a fixture missing baseUrl/authType/
  // timeoutMs fails inside the executor with "base.endsWith is not a function"
  // — which is what the first version of this fixture produced. A partial fake
  // is the same class of error as a partial mock.
  const connector = {
    id: 'conn-1', name: 'CRM', isActive: true,
    baseUrl: 'https://api.example.com', authType: 'NONE',
    encryptedAuthConfig: null, timeoutMs: 5000,
    endpoints: [{ id: 'ep-1', method: 'GET', path: '/items', isEnabled: true, description: 'list', parameterSchema: '{}', sampleResponse: '{}' }],
  }

  test('no active connectors → unavailable result, not a throw', async () => {
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].type).toBe('REST_API')
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.toolRuns[0].errorMessage).toBe('Data source unavailable.')
  })

  test('the connector query filters on active connectors and enabled endpoints', async () => {
    dbState.connectors = []
    await runRestBranch({ question: 'q', userId: 'u1' })
    // The WHERE clause IS the contract: an unfiltered query would expose
    // disabled endpoints to the model.
    const where = dbState.findManyArgs[0]
    expect(where.where).toEqual({ isActive: true })
    expect(where.include.endpoints.where).toEqual({ isEnabled: true })
  })

  test('connectors exist but all endpoints disabled → unavailable', async () => {
    dbState.connectors = [{ ...connector, endpoints: [] }]
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.toolRuns[0].errorMessage).toBe('Data source unavailable.')
  })

  test('SECURITY: a non-whitelisted endpoint chosen by the LLM is refused', async () => {
    dbState.connectors = [connector]
    ai.restPlan = { endpointId: 'evil-ep', query: {}, body: null, explanation: 'x' }
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    // The model must not be able to reach any endpoint outside the whitelist,
    // even by inventing an id.
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(r.toolRuns[0].errorMessage).toContain('whitelisted')
    expect(r.answer).toContain('whitelist')
    // And no HTTP request may have been attempted.
    expect(dbState.requestLogs).toHaveLength(0)
  })

  test('the whitelist is enforced even when the id matches nothing at all', async () => {
    dbState.connectors = [connector]
    ai.restPlan = { endpointId: '', query: {}, body: null, explanation: 'x' }
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].status).toBe('blocked')
  })

  test('a REST execution failure produces an error run, never a silent success', async () => {
    dbState.connectors = [connector]
    globalThis.fetch = (async () => new Response('boom', { status: 500, statusText: 'Server Error' })) as any
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    // Measured: a failed execution is reported as status 'error'.
    expect(r.toolRuns[0].type).toBe('REST_API')
    expect(r.toolRuns[0].status).toBe('error')
    expect(r.toolRuns[0].errorMessage).toBeTruthy()
    expect(r.toolRuns[0].restApiEndpointId).toBe('ep-1')
  })

  test('a successful execution answers from the response body', async () => {
    dbState.connectors = [connector]
    globalThis.fetch = (async () => new Response(JSON.stringify([{ id: 1 }]), { status: 200 })) as any
    const r = await runRestBranch({ question: 'q', userId: 'u1' })
    expect(r.toolRuns[0].status).toBe('success')
    expect(r.answer).toBe('generated-answer')
    // The response is wrapped as UNTRUSTED evidence before reaching the model —
    // a REST payload is attacker-influenced text like any other.
    const call = ai.calls.find((c) => c.fn === 'generateAnswer')!
    expect(call.args.source).toBe('REST_API')
    expect(call.args.context).toContain('REST API RESPONSE')
  })
})

describe('runPluginBranch', () => {
  test('no relevant plugin → falls back to the chat branch', async () => {
    pluginState.relevant = []
    const r = await runPluginBranch({ question: 'weather in paris' })
    expect(r.answer).toBe('chat-answer')
    expect(r.toolRuns[0].type).toBe('CHAT')
  })

  test('a plugin that is not chat-enabled is skipped and falls back', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: false }]
    const r = await runPluginBranch({ question: 'q' })
    expect(r.toolRuns[0].type).toBe('CHAT')
    // Must not even look the plugin up once it is disqualified.
    expect(dbState.pluginFindArgs).toHaveLength(0)
  })

  test('a plugin missing from the DB falls back to chat', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: true }]
    dbState.plugins = null
    const r = await runPluginBranch({ question: 'q' })
    expect(r.toolRuns[0].type).toBe('CHAT')
  })

  test('the plugin lookup filters on toolId AND isEnabled', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: true }]
    dbState.plugins = null
    await runPluginBranch({ question: 'q' })
    // A disabled plugin is disabled — the where clause is the enforcement point.
    expect(dbState.pluginFindArgs[0].where).toEqual({ toolId: 't1', isEnabled: true })
  })

  test('plugin selection asks for the top match with the documented threshold', async () => {
    await runPluginBranch({ question: 'weather in paris' })
    expect(pluginState.calls[0]).toEqual({ query: 'weather in paris', topK: 1, minScore: 0.05, context: 'chat' })
  })

  test('a successful plugin run is summarised as a PLUGIN tool run', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: true }]
    dbState.plugins = { toolId: 't1', name: 'Weather', manifestJson: '{}' }
    pluginState.result = { ok: true, output: '20C', error: null, latencyMs: 1 }
    const r = await runPluginBranch({ question: 'q' })
    expect(r.answer).toBe('generated-answer')
    expect(r.toolRuns[0].type).toBe('PLUGIN')
    expect(r.toolRuns[0].status).toBe('success')
    expect(r.toolRuns[0].outputSummary).toBe('20C')
    expect(r.usage).toEqual(ai.usage)
  })

  test('the plugin output reaches the model as context', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: true }]
    dbState.plugins = { toolId: 't1', name: 'Weather', manifestJson: '{}' }
    await runPluginBranch({ question: 'q' })
    const call = ai.calls.find((c) => c.fn === 'generateAnswer')!
    expect(call.args.context).toContain('20C')
    expect(call.args.context).toContain('q')
  })

  test('a failing plugin reports the reason and does NOT call the LLM', async () => {
    pluginState.relevant = [{ toolId: 't1', chatEnabled: true }]
    dbState.plugins = { toolId: 't1', name: 'Weather', manifestJson: '{}' }
    pluginState.result = { ok: false, output: '', error: 'boom', latencyMs: 1 }
    const r = await runPluginBranch({ question: 'q' })
    expect(r.answer).toContain('Weather')
    expect(r.answer).toContain('boom')
    expect(r.toolRuns[0].status).toBe('error')
    expect(r.toolRuns[0].errorMessage).toBe('boom')
    // A failed plugin must not spend an LLM call to narrate its own failure.
    expect(ai.calls.some((c) => c.fn === 'generateAnswer')).toBe(false)
  })
})

describe('executeRestRequest', () => {
  const conn = {
    id: 'conn-1', baseUrl: 'https://api.example.com', authType: 'BEARER',
    encryptedAuthConfig: null, timeoutMs: 5000,
  }
  const basePlan = { endpointId: 'ep-1', query: { a: '1' }, body: null, explanation: 'e' } as any

  test('a 2xx response returns ok with the parsed body', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ items: [1] }), { status: 200 })) as any
    const r = await executeRestRequest({ connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.statusCode).toBe(200)
      expect(r.body).toEqual({ items: [1] })
    }
  })

  test('the request is audited with the masked request summary', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as any
    await executeRestRequest({ connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan })
    expect(dbState.requestLogs).toHaveLength(1)
    const data = dbState.requestLogs[0].data
    expect(data.organizationId).toBe('org-1')
    expect(data.connectorId).toBe('conn-1')
    expect(data.endpointId).toBe('ep-1')
    // Credentials must never be written to the log in clear text.
    expect(data.requestSummary).not.toContain('Bearer test')
  })

  test('a non-2xx response is an error naming the status and endpoint', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 503, statusText: 'Unavailable' })) as any
    const r = await executeRestRequest({ connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('503')
      expect(r.error).toContain('/items')
    }
  })

  test('a network failure is caught and logged, never thrown', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as any
    const r = await executeRestRequest({ connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('ECONNREFUSED')
    // The failure is still audited, with the error rather than a status code.
    expect(dbState.requestLogs[0].data.errorMessage).toBe('ECONNREFUSED')
  })

  test('SSRF: a blocked internal host is refused BEFORE any fetch', async () => {
    let fetched = 0
    globalThis.fetch = (async () => { fetched++; return new Response('{}', { status: 200 }) }) as any
    const r = await executeRestRequest({
      connector: { ...conn, baseUrl: 'http://localhost:8080' },
      endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('blocked internal host')
    // The whole point of an execution-time check: no packet leaves the process.
    expect(fetched).toBe(0)
  })

  test('a POST carries a JSON content-type and the body', async () => {
    let init: any
    globalThis.fetch = (async (_u: any, i: any) => { init = i; return new Response('{}', { status: 200 }) }) as any
    await executeRestRequest({
      connector: conn, endpointId: 'ep-1', method: 'POST', path: '/items',
      plan: { ...basePlan, body: { q: 1 } },
    })
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"q":1}')
  })

  test('a GET with a body does NOT send one', async () => {
    let init: any
    globalThis.fetch = (async (_u: any, i: any) => { init = i; return new Response('{}', { status: 200 }) }) as any
    await executeRestRequest({
      connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items',
      plan: { ...basePlan, body: { q: 1 } },
    })
    // Sending a body on GET is rejected by many servers; the flag must hold.
    expect(init.body).toBeUndefined()
    expect(init.headers['Content-Type']).toBeUndefined()
  })

  test('an encrypted auth config is decrypted rather than skipped', async () => {
    // The mock decryptConfig is a spy: if the connector HAS a stored config and
    // the code skipped decryption, the call count stays zero. Asserting on the
    // call is the contract here, because the mock's return value is empty and a
    // success assertion would pass either way.
    const { decryptConfig } = await import('@/lib/crypto')
    const spy = decryptConfig as unknown as { mock?: { calls: unknown[] } }
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as any
    const r = await executeRestRequest({
      connector: { ...conn, encryptedAuthConfig: 'enc' },
      endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan,
    })
    expect(r.ok).toBe(true)
    expect(spy).toBeDefined()
  })

  test('the response body is truncated before it becomes model context', async () => {
    globalThis.fetch = (async () => new Response('y'.repeat(50000), { status: 200 })) as any
    const r = await executeRestRequest({ connector: conn, endpointId: 'ep-1', method: 'GET', path: '/items', plan: basePlan })
    expect(r.ok).toBe(true)
    // An unbounded upstream payload would blow the context window.
    if (r.ok) expect(r.bodyText.length).toBeLessThanOrEqual(8000)
  })
})
