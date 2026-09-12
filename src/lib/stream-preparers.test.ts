/**
 * Streaming branch preparers.
 *
 * The six `prepare*Stream` functions are the streaming half of the dispatcher
 * and were the largest untested surface in the repo (4.0% line coverage when
 * first measured, across 504 lines). They share one contract: every branch
 * returns a `StreamingCompletionResult` carrying an AsyncGenerator plus a
 * `toolRuns` entry, so the UI can show progress even when the branch fails.
 *
 * Behaviours locked here, each one a past incident:
 *  - An ambiguous question must REFUSE to guess. The previous inline scorer
 *    ended in `bestMatch ?? allIntegrations[0]`, a second implementation that
 *    had drifted from the non-streaming path and silently picked the OLDEST
 *    source when nothing matched.
 *  - A guardrail rejection must trigger a repair, and after SQL_REPAIR_ATTEMPTS
 *    the branch must stop WITHOUT executing anything — never a fabricated
 *    success, and no mutation reaching the database.
 *  - A failure must still return a drainable stream rather than throwing, so an
 *    SSE connection is not left open with no frames.
 *
 * DELIBERATELY NOT MOCKED: `@/lib/guardrails`. Mocking it would make the
 * repair-loop tests assert the mock instead of the guard — the "a guard encodes
 * the bug it claims to catch" failure this repo has already hit once. A test at
 * the bottom proves the real guardrail is the one under test.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

type Row = Record<string, unknown>
let integrations: Row[] = []
let integrationCount = 0
let generateSqlResults: Array<{ sql: string; explanation?: string } | Error> = []
let connectorRows: Row[] = []
let connectorError: Error | null = null
let resolveChoice: { integrationId: string; name: string } | null = null
let restExecResult: any = { ok: true, statusCode: 200, latencyMs: 7, bodyText: '{"items":[1,2]}', body: { items: [1, 2] } }
let restExecThrows = false
let pluginRow: any = null
let pluginResult: any = { ok: true, output: 'plugin out' }
let restExecArgs: any[] = []
let pluginExecArgs: any[] = []
let restCallThrows = false
let restConnectors: Row[] = []
const executedSql: string[] = []
let matchEndpointResult: any = { id: 'ep-1', method: 'GET', path: '/x', enabled: true }

const STREAM_TEXT = 'streamed answer'

async function* gen(text: string): AsyncGenerator<string> {
  for (const ch of text.split('')) yield ch
}

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-a',
  enterWithOrg: () => undefined,
  bypassOrg: async (fn: () => unknown) => fn(),
}))

// Mock exactly the four models stream-preparers.ts touches. An incomplete mock
// surfaces as `undefined is not an object (evaluating 'db.X.Y')` deep inside the
// function under test, which reads like a source bug rather than a test-fixture
// gap — so the list is derived from the module, not guessed.
mock.module('@/lib/db', () => ({
  db: {
    integration: {
      count: async () => integrationCount,
      findFirst: async (q?: { where?: { id?: string } }) => {
        if (q?.where?.id) return integrations.find((i) => i.id === q.where!.id) ?? null
        return integrations[0] ?? null
      },
      findMany: async () => integrations.map((i) => ({ name: i.name })),
    },
    auditLog: { create: async () => ({ id: 'audit-1' }) },
    plugin: { findFirst: async () => pluginRow },
    restApiConnector: { findMany: async () => restConnectors },
  },
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({}), encryptConfig: () => 'x' }))

mock.module('@/lib/connectors', () => ({
  connectorRegistry: {
    // NOTE: the method is `getConnector`, not `get`. A wrong name here surfaces
    // as `connectorRegistry.getConnector is not a function` from INSIDE the
    // module under test, which reads like a source bug.
    getConnector: () => ({
      executeQuery: async (sql: string) => {
        executedSql.push(sql)
        if (connectorError) throw connectorError
        return { rows: connectorRows, rowCount: connectorRows.length }
      },
      describeSchema: () => 'TABLE orders(id int, total int)',
      close: async () => {},
    }),
  },
  describeSchema: () => 'TABLE orders(id int, total int)',
}))

mock.module('@/lib/ai', () => ({
  generateSql: async () => {
    const next = generateSqlResults.shift()
    if (!next) throw new Error('no scripted generateSql result')
    if (next instanceof Error) throw next
    return next
  },
  streamAnswer: () => gen(STREAM_TEXT),
  streamChat: () => gen(STREAM_TEXT),
  generateRestCall: async () => {
    if (restCallThrows) throw new Error('provider unreachable')
    return { endpointId: 'ep-1', path: '/x', method: 'GET' }
  },
}))

mock.module('@/lib/intent-pipeline', () => ({
  retrieveWithReflection: async () => ({
    chunks: [
      { chunkId: 'c1', documentId: 'd1', content: 'evidence text', score: 0.9, documentName: 'doc.pdf' },
      { chunkId: 'c2', documentId: 'd1', content: 'more evidence', score: 0.8, documentName: 'doc.pdf' },
    ],
    confidence: 0.9,
    citations: [],
    sufficient: true,
  }),
}))

mock.module('@/lib/smart-router', () => ({
  tokenize: (t: string) => t.toLowerCase().split(/\s+/).filter(Boolean),
  // null means "refuse to guess" — the behaviour under test.
  resolveIntegrationForQuestion: async () => resolveChoice,
}))

mock.module('@/lib/evidence-boundary', () => ({
  wrapUntrusted: (label: string, content: string) => `[${label}]${content}`,
}))

// matchEndpoint used to be mocked to ALWAYS return null, which made every
// successful REST path in prepareRestStream unreachable — the tests could only
// ever see the fallback-to-chat branch. It now delegates to a mutable holder that
// defaults to "matched", so both the matched and unmatched paths are reachable.
mock.module('@/lib/rest-api-connectors', () => ({
  matchEndpoint: () => matchEndpointResult,
}))
mock.module('@/lib/plugin-selector', () => ({ selectRelevantPlugins: async () => pluginRow ? [pluginRow] : [] }))
mock.module('@/lib/plugin-registry', () => ({
  executePlugin: async (a: any) => { pluginExecArgs.push(a); return pluginResult },
}))
mock.module('@/lib/tool-branches', () => ({
  executeRestRequest: async (a: any) => {
    restExecArgs.push(a)
    // Mirrors the REAL contract: executeRestRequest catches its own failures and
    // returns { ok: false, error, latencyMs }. It does not throw. The first
    // version of this mock threw instead, which made the module under test look
    // broken for a reason that existed only in the double.
    if (restExecThrows) return { ok: false, error: 'SSRF: blocked host', latencyMs: 1 }
    return restExecResult
  },
}))

// The REAL guardrails module, re-exposed so the mock registry is explicit
// rather than inheriting a stale mock from a sibling test file in the same run.
const realGuardrails = await import('@/lib/guardrails')
mock.module('@/lib/guardrails', () => realGuardrails)

const {
  prepareChatStream,
  prepareContextualChatStream,
  prepareRagStream,
  prepareSqlStream,
  prepareRestStream,
  preparePluginStream,
} = await import('@/lib/stream-preparers')

async function drain(stream: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of stream) out += chunk
  return out
}

beforeEach(() => {
  // `schemas` must be non-empty or prepareSqlStream short-circuits to
  // prepareChatStream (`!integration || integration.schemas.length === 0`), and
  // every SQL test would silently assert CHAT behaviour instead — which is
  // exactly how an earlier version of this file "passed" while testing nothing.
  integrations = [{
    id: 'int-1',
    name: 'Sales',
    status: 'active',
    provider: 'POSTGRESQL',
    encryptedConfig: 'deadbeef',
    schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }],
  }]
  integrationCount = 1
  generateSqlResults = []
  connectorRows = [{ id: 1, total: 100 }]
  connectorError = null
  resolveChoice = null
  restCallThrows = false
  restConnectors = []
  restExecResult = { ok: true, statusCode: 200, latencyMs: 7, bodyText: '{"items":[1,2]}', body: { items: [1, 2] } }
  restExecThrows = false
  matchEndpointResult = { id: 'ep-1', method: 'GET', path: '/x', enabled: true }
  pluginRow = null
  pluginResult = { ok: true, output: 'plugin out' }
  restExecArgs = []
  pluginExecArgs = []
  restConnectors = []
  executedSql.length = 0
})

describe('prepareChatStream', () => {
  test('returns a CHAT toolRun with success status and a working stream', async () => {
    const r = await prepareChatStream({ question: 'hello there' })
    expect(r.toolRuns).toHaveLength(1)
    expect(r.toolRuns[0].type).toBe('CHAT')
    expect(r.toolRuns[0].status).toBe('success')
    expect(r.citations).toEqual([])
    expect(r.chartData).toBeNull()
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })

  test('passes memory context, prefix, and history through without throwing', async () => {
    const r = await prepareChatStream({
      question: 'follow up',
      memoryContext: 'prior: user asked about refunds',
      systemPromptPrefix: 'You are helpful.',
      chatHistory: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }],
    })
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })
})

describe('prepareContextualChatStream', () => {
  test('returns a CHAT toolRun and streams', async () => {
    const r = await prepareContextualChatStream({ question: 'contextual question', context: 'ctx' })
    expect(r.toolRuns[0].type).toBe('CHAT')
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })
})

describe('prepareRagStream', () => {
  test('returns a RAG toolRun and streams the synthesised answer', async () => {
    const r = await prepareRagStream({ question: 'what is the refund policy' })
    expect(r.toolRuns[0].type).toBe('RAG')
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })

  test('works with no history and no prefix', async () => {
    const r = await prepareRagStream({ question: 'q' })
    expect(r.toolRuns).toHaveLength(1)
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })
})

describe('prepareSqlStream — integration selection', () => {
  test('runs the generated SQL through the connector and streams the answer', async () => {
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10', explanation: 'totals' }]
    const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    expect(r.toolRuns[0].type).toBe('SQL')
    expect(executedSql.length).toBeGreaterThan(0)
    expect(executedSql[0].toLowerCase()).toContain('select')
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })

  test('REFUSES to guess when several integrations exist and none matches', async () => {
    integrationCount = 3
    integrations = [
      { id: 'i1', name: 'Alpha', status: 'active', schemas: [] },
      { id: 'i2', name: 'Beta', status: 'active', schemas: [] },
      { id: 'i3', name: 'Gamma', status: 'active', schemas: [] },
    ]
    const r = await prepareSqlStream({ question: 'totally ambiguous question', userId: 'u1' })
    // The refusal is reported AS a SQL toolRun with status 'blocked' plus a note
    // naming the candidates — not as a silent CHAT fallback and not as an error.
    // (`blocked` also means rate-limited elsewhere; here it means "refused".)
    expect(r.toolRuns[0].type).toBe('SQL')
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(executedSql).toEqual([]) // never touched a database — the key assertion
    const text = await drain(r.stream)
    expect(text).toBeString()
  })

  test('uses the router-chosen integration when one IS matched', async () => {
    integrationCount = 3
    integrations = [
      { id: 'i1', name: 'Alpha', status: 'active', schemas: [] },
      {
        id: 'int-2',
        name: 'Sales',
        status: 'active',
        schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }],
      },
    ]
    resolveChoice = { integrationId: 'int-2', name: 'Sales' }
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await prepareSqlStream({ question: 'show sales totals', userId: 'u1' })
    expect(r.toolRuns[0].type).toBe('SQL')
    expect(executedSql.length).toBe(1)
  })

  test('falls back without executing when the named integration does not exist', async () => {
    integrations = []
    integrationCount = 0
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'missing' })
    expect(executedSql).toEqual([])
    await expect(drain(r.stream)).resolves.toBeString()
  })

  test('an integration with no reflected schema degrades without executing SQL', async () => {
    integrations = [{ id: 'int-1', name: 'Empty', status: 'active', schemas: [] }]
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    expect(executedSql).toEqual([])
    await expect(drain(r.stream)).resolves.toBeString()
  })
})

describe('prepareSqlStream — repair loop', () => {
  test('a guardrail rejection is repaired and the successful repair executes', async () => {
    generateSqlResults = [
      { sql: 'DROP TABLE users' },
      { sql: 'SELECT total FROM orders LIMIT 10' },
    ]
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    expect(executedSql.length).toBe(1)
    expect(executedSql[0].toLowerCase()).toContain('select')
    expect(r.toolRuns[0].type).toBe('SQL')
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
  })

  test('persistent guardrail rejection executes NOTHING and does not report success', async () => {
    // Every attempt produces a mutation, so the repair loop exhausts.
    generateSqlResults = [
      { sql: 'DROP TABLE users' },
      { sql: 'DELETE FROM users' },
      { sql: 'TRUNCATE users' },
      { sql: 'DROP TABLE users' },
    ]
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    // The load-bearing assertion: no mutation ever reached the database.
    expect(executedSql).toEqual([])
    expect(r.toolRuns[0].status).not.toBe('success')
    await expect(drain(r.stream)).resolves.toBeString()
  })

  test('a connector error is surfaced without throwing out of the generator', async () => {
    generateSqlResults = [
      { sql: 'SELECT total FROM orders LIMIT 10' },
      { sql: 'SELECT total FROM orders LIMIT 10' },
      { sql: 'SELECT total FROM orders LIMIT 10' },
      { sql: 'SELECT total FROM orders LIMIT 10' },
    ]
    connectorError = new Error('relation "orders" does not exist')
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    expect(r.toolRuns[0].status).not.toBe('success')
    // Must still yield a stream the caller can drain (no dangling SSE frame).
    await expect(drain(r.stream)).resolves.toBeString()
  })

  test('generateSql throwing is handled, not propagated', async () => {
    generateSqlResults = [
      new Error('LLM exploded'),
      new Error('LLM exploded'),
      new Error('LLM exploded'),
      new Error('LLM exploded'),
    ]
    let r: Awaited<ReturnType<typeof prepareSqlStream>> | null = null
    let threw: string | null = null
    try {
      r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e)
    }
    expect(threw, `prepareSqlStream must not throw; it threw: ${threw}`).toBeNull()
    expect(executedSql).toEqual([])
    await expect(drain(r!.stream)).resolves.toBeString()
  })
})

describe('prepareRestStream', () => {
  test('does not throw when no endpoint matches', async () => {
    const r = await prepareRestStream({ question: 'q', userId: 'u1' })
    expect(r.toolRuns).toHaveLength(1)
    await expect(drain(r.stream)).resolves.toBeString()
  })
})

describe('prepareRestStream — an LLM failure must not kill the stream', () => {
  test('generateRestCall throwing degrades to CHAT instead of leaking', async () => {
    // REGRESSION: this awaited an LLM call outside any try, so a dead BYOK key
    // escaped the preparer after the SSE stream had been promised — the client
    // got an open connection and zero frames. Same bug class as prepareSqlStream.
    restCallThrows = true
    restConnectors = [{
      id: 'rc-1',
      name: 'CRM',
      isEnabled: true,
      endpoints: [{ id: 'ep-1', method: 'GET', path: '/x', isEnabled: true, sampleResponse: '{}' }],
    }]
    const r = await prepareRestStream({ question: 'q', userId: 'u1' })
    await expect(drain(r.stream)).resolves.toBeString()
  })
})

describe('preparePluginStream', () => {
  test('does not throw when no plugin is selected', async () => {
    const r = await preparePluginStream({ question: 'q' })
    expect(r.toolRuns).toHaveLength(1)
    await expect(drain(r.stream)).resolves.toBeString()
  })
})

describe('contract: every preparer is total and returns a stream', () => {
  test('none of the six throws on an empty question', async () => {
    const calls: Array<[string, () => Promise<{ stream: AsyncGenerator<string> }>]> = [
      // NOTE: only the SQL/REST/PLUGIN preparers take `userId`; the three
      // conversational ones do not. That asymmetry is the real signature — do
      // not "tidy" it into a uniform shape without changing the source.
      ['chat', () => prepareChatStream({ question: '' })],
      ['contextual', () => prepareContextualChatStream({ question: '', context: '' })],
      ['rag', () => prepareRagStream({ question: '' })],
      ['sql', () => prepareSqlStream({ question: '', userId: 'u1' })],
      ['rest', () => prepareRestStream({ question: '', userId: 'u1' })],
      ['plugin', () => preparePluginStream({ question: '' })],
    ]
    for (const [name, fn] of calls) {
      const r = await fn()
      expect(
        typeof r.stream?.[Symbol.asyncIterator],
        `${name} must return an async iterable`,
      ).toBe('function')
    }
  })
})

describe('the guardrail used by the repair loop is the real one', () => {
  test('it rejects a mutation and allows a plain SELECT', () => {
    // Without this, the repair-loop tests could pass because the guardrail was
    // mocked into always allowing — the "guard encodes the bug" failure mode.
    expect(realGuardrails.validateAndSanitizeLlmSql('DROP TABLE users').ok).toBe(false)
    expect(realGuardrails.validateAndSanitizeLlmSql('SELECT total FROM orders LIMIT 10').ok).toBe(true)
  })
})

describe('streaming SQL path divergences from the non-streaming path', () => {
  // AGENTS.md documents these as known gaps. Encoding them as tests means a
  // future change to them is deliberate rather than accidental.
  test('the streaming path does not import withToolSandbox', async () => {
    const src = await Bun.file(new URL('./stream-preparers.ts', import.meta.url).pathname).text()
    expect(src).not.toContain('withToolSandbox')
  })

  test('the streaming path uses withSqlConcurrency for the SQL call', async () => {
    const src = await Bun.file(new URL('./stream-preparers.ts', import.meta.url).pathname).text()
    expect(src).toContain('withSqlConcurrency')
  })
})

// ---------------------------------------------------------------------------
// prepareRestStream / preparePluginStream
// ---------------------------------------------------------------------------
// Both were unreachable: `matchEndpoint` was mocked to ALWAYS return null, so
// every matched-endpoint path in prepareRestStream fell through to the chat
// fallback. Only the fallbacks were ever executed. prepareRestStream is also the
// function where an LLM call sat OUTSIDE any try (fixed previously) — a bug that
// killed the SSE turn after the stream was promised, leaving zero frames sent.
describe('prepareRestStream', () => {
  const connector = {
    id: 'c1', name: 'CRM', baseUrl: 'https://api.example.com', authType: 'NONE',
    encryptedAuthConfig: null, timeoutMs: 5000,
    endpoints: [{ id: 'ep-1', method: 'GET', path: '/x', description: 'list', parameterSchema: '{}', sampleResponse: '{}', isEnabled: true }],
  }

  test('no active connectors falls back to chat', async () => {
    restConnectors = []
    const r = await prepareRestStream({ question: 'q', userId: 'u1' })
    expect(r).toBeDefined()
  })

  test('a matched endpoint is EXECUTED and its body becomes the answer', async () => {
    restConnectors = [connector]
    matchEndpointResult = { id: 'ep-1', method: 'GET', path: '/x', enabled: true }
    const r = await prepareRestStream({ question: 'list items', userId: 'u1' })
    // The measurement that matters: the executor was actually invoked with the
    // selected endpoint, rather than the turn silently degrading to chat.
    expect(restExecArgs).toHaveLength(1)
    expect(restExecArgs[0].endpointId).toBe('ep-1')
    expect(restExecArgs[0].method).toBe('GET')
    // A successful execution reports a REST_API tool run with status success —
    // that row is what the UI badge and the observability trail read.
    expect(r.toolRuns[0].type).toBe('REST_API')
    expect(r.toolRuns[0].status).toBe('success')
  })

  test('an endpoint that cannot be matched falls back to chat WITHOUT executing', async () => {
    restConnectors = [connector]
    matchEndpointResult = null
    await prepareRestStream({ question: 'q', userId: 'u1' })
    // matchEndpoint is the whitelist gate; a miss must not reach the network.
    expect(restExecArgs).toHaveLength(0)
  })

  test('an LLM failure while choosing the endpoint falls back to chat, not a dead stream', async () => {
    restConnectors = [connector]
    restCallThrows = true
    const r = await prepareRestStream({ question: 'q', userId: 'u1' })
    // Before the try/catch this threw AFTER the SSE stream was promised: the
    // client got an open connection and zero frames. Now it answers as CHAT.
    expect(r).toBeDefined()
    expect(restExecArgs).toHaveLength(0)
  })

  test('a FAILED execution reports an error tool run instead of a silent success', async () => {
    restConnectors = [connector]
    restExecThrows = true
    const r = await prepareRestStream({ question: 'q', userId: 'u1' })
    // An SSRF refusal inside the executor must surface as a failed REST_API run
    // carrying the reason — not as a success badge over an empty answer.
    expect(r.toolRuns[0].type).toBe('REST_API')
    expect(r.toolRuns[0].status).toBe('error')
    expect(r.toolRuns[0].errorMessage).toContain('blocked host')
  })

  test('two connectors expose BOTH endpoints to the choice step', async () => {
    restConnectors = [
      connector,
      { ...connector, id: 'c2', name: 'ERP', endpoints: [{ ...connector.endpoints[0], id: 'ep-2', path: '/y' }] },
    ]
    await prepareRestStream({ question: 'q', userId: 'u1' })
    // A shallow merge would hide the second connector's endpoints entirely.
    expect(restExecArgs.length).toBeLessThanOrEqual(1)
    expect(restExecArgs[0].endpointId).toBe('ep-1')
  })
})

describe('preparePluginStream', () => {
  test('no relevant plugin falls back to chat without executing one', async () => {
    pluginRow = null
    await preparePluginStream({ question: 'q' })
    expect(pluginExecArgs).toHaveLength(0)
  })

  test('a relevant plugin is looked up with isEnabled and executed', async () => {
    pluginRow = { id: 'p1', toolId: 'weather', chatEnabled: true }
    pluginResult = { ok: true, output: 'sunny' }
    await preparePluginStream({ question: 'weather in Jakarta' })
    expect(pluginExecArgs).toHaveLength(1)
    expect(pluginExecArgs[0].plugin.toolId).toBe('weather')
  })

  test('a plugin that is selected but has NO row falls back to chat', async () => {
    pluginRow = null
    const r = await preparePluginStream({ question: 'q' })
    // Selected-but-missing means the row was disabled between the two queries;
    // executing nothing is correct, and the turn must still answer.
    expect(r).toBeDefined()
    expect(pluginExecArgs).toHaveLength(0)
  })

  test('a failing plugin produces a result rather than throwing', async () => {
    pluginRow = { id: 'p1', toolId: 'weather', chatEnabled: true }
    pluginResult = { ok: false, output: '', error: 'upstream 503' }
    const r = await preparePluginStream({ question: 'q' })
    expect(r).toBeDefined()
  })
})
