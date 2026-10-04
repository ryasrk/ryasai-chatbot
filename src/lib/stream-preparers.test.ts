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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

type Row = Record<string, unknown>
let integrations: Row[] = []
let integrationCount = 0
let generateSqlResults: Array<{ sql: string; explanation?: string } | Error> = []
let connectorRows: Row[] = []
let connectorError: Error | null = null
let connectorErrors: Error[] = []
let connectorAttempts = 0
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

/**
 * Rows returned by `db.document.findMany` for the RAG source-guidance block.
 *
 * Empty by default, so every pre-existing assertion sees the context EXACTLY as
 * it was before the parity fix — no guidance block, no reflection note. A test
 * that wants the block opts in by setting this.
 */
let documentRows: Array<{ id: string; name: string; contextPrompt: string | null }> = []
/** How many ready documents exist, for the SQL→documents fallback. 0 by default, so no earlier test sees it. */
let readyDocumentCount = 0

/**
 * What `streamAnswer` received, so the RAG context can be asserted at all.
 *
 * The RAG branch's whole behaviour is "what text did we put in front of the model",
 * and until this existed the tests only asserted the toolRun type and that the
 * stream drained — which is how the missing reflection note survived a UAT round.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let streamAnswerArgs: any = null

/**
 * Stubbed `AppConfig` row for prompt settings.
 *
 * `prepareSqlStream` reads the org's Text-to-SQL rules before generating SQL, so an admin's edit
 * applies to the interactive chat and not only to scheduled runs. `null` here → the parser returns
 * defaults → `resolveSqlRulesPrompt('')` → the built-in rules, which is what every assertion in this
 * file expected before the field existed. Tests that care about a CUSTOM value set this first.
 */
let promptSettingsRow: { promptSettings: string | null } | null = null

/**
 * What `generateSql` received, so a test can assert the rules actually travelled.
 *
 * Typed `any` deliberately: with `Record<string, unknown> | null`, TypeScript narrows the variable to
 * `never` (control-flow analysis sees only the `= null` assignments in the tests), which makes
 * `generateSqlArgs?.sqlRules` a compile error and would force a cast at every use.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let generateSqlArgs: any = null
let auditActions: string[] = []
let queryHistorySuccess: boolean[] = []
let sqlRateLimitAllowed = true

mock.module('@/lib/tool-rate-limit', () => ({
  checkToolRateLimit: async () => ({ allowed: sqlRateLimitAllowed, remaining: sqlRateLimitAllowed ? 9 : 0 }),
}))

async function* gen(text: string): AsyncGenerator<string> {
  for (const ch of text.split('')) yield ch
}

// `requireOrgContext` must be in the mock: the module under test imports it (the fail-fast org read used by
// its audit-log writes), and a partial mock that omits it makes the import itself fail at collection time.
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-a',
  requireOrgContext: () => 'org-a',
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
    auditLog: {
      create: async (q: { data: { action: string; severity: string } }) => {
        auditActions.push(`${q.data.action}:${q.data.severity}`)
        return { id: 'audit-1' }
      },
    },
    // Read by the SQL pipeline to resolve the caller's role; admin = unrestricted (per-role tests live elsewhere).
    user: { findFirst: async () => ({ role: 'admin' }) },
    // Written by the shared SQL pipeline. This transport wrote NONE before the pipeline was unified, which is the
    // drift the audit assertions below pin.
    queryHistory: {
      create: async (q: { data: { success: boolean } }) => {
        queryHistorySuccess.push(q.data.success)
        return { id: 'qh-1' }
      },
    },
    plugin: { findFirst: async () => pluginRow },
    restApiConnector: { findMany: async () => restConnectors },
    // Read by prepareSqlStream for the org's editable Text-to-SQL rules (see promptSettingsRow).
    appConfig: { findFirst: async () => promptSettingsRow },
    // Read by prepareRagStream to fetch the per-document contextPrompts that
    // contributed evidence. Absent from this mock until the source-guidance
    // parity fix, which is why the missing injection went unnoticed: the call
    // was never made at all, so no fixture gap could have surfaced it.
    document: { findMany: async () => documentRows, count: async () => readyDocumentCount },
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
        connectorAttempts++
        // A QUEUE, so a test can make the first attempt fail and the retry succeed —
        // which is the only way to observe the retry rather than the failure.
        const next = connectorErrors.shift()
        if (next) throw next
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
  generateSql: async (args: Record<string, unknown>) => {
    // Capture what the preparer passed, so a test can prove the editable rules travelled rather
    // than trusting that the plumbing exists.
    generateSqlArgs = args
    const next = generateSqlResults.shift()
    if (!next) throw new Error('no scripted generateSql result')
    if (next instanceof Error) throw next
    return next
  },
  streamAnswer: (args: Record<string, unknown>) => {
    streamAnswerArgs = args
    return gen(STREAM_TEXT)
  },
  streamChat: () => gen(STREAM_TEXT),
  generateRestCall: async () => {
    if (restCallThrows) throw new Error('provider unreachable')
    return { endpointId: 'ep-1', path: '/x', method: 'GET' }
  },
}))

// Swappable, because the interesting case is the retriever FAILING: RAG is
// best-effort and must degrade to plain chat rather than kill the stream.
let retrievalError: Error | null = null
/**
 * What the sufficiency judge reported, and how many passes it took.
 *
 * The REAL `retrieveWithReflection` always returns both; the mock omitted them
 * until the transport-parity fix, which is precisely why the fix was needed and
 * why its absence was invisible: `prepareRagStream` never read them, so no test
 * could fail. Defaults describe the SUFFICIENT, single-pass case — the gate for
 * the note is `!sufficient && passes >= 2`, so nothing is injected by default.
 */
let reflectionSufficient = true
let retrievalPasses = 1
/**
 * The chunks the retriever hands back. Swappable so a test can supply the ranks the REAL
 * `retrieveWithReflection` stamps after merging its expansions — the defaults carry NO rank,
 * which is the shape every earlier assertion was written against.
 */
let retrievalChunks: Array<{
  chunkId: string
  documentId: string
  content: string
  score: number
  documentName: string
  rank?: number
}> = defaultRetrievalChunks()
function defaultRetrievalChunks() {
  return [
    { chunkId: 'c1', documentId: 'd1', content: 'evidence text', score: 0.9, documentName: 'doc.pdf' },
    { chunkId: 'c2', documentId: 'd1', content: 'more evidence', score: 0.8, documentName: 'doc.pdf' },
  ]
}
mock.module('@/lib/intent-pipeline', () => ({
  retrieveWithReflection: async () => {
    if (retrievalError) throw retrievalError
    return {
      chunks: retrievalChunks,
      confidence: 0.9,
      citations: [],
      sufficient: true,
      reflection: {
        sufficient: reflectionSufficient,
        reason: reflectionSufficient ? 'mock: evidence addresses the question' : 'mock: evidence may not address the question',
        confidence: reflectionSufficient ? 1 : 0.2,
      },
      retrievalPasses,
    }
  },
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
  auditActions = []
  queryHistorySuccess = []
  sqlRateLimitAllowed = true
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
  readyDocumentCount = 0
  generateSqlResults = []
  connectorRows = [{ id: 1, total: 100 }]
  connectorError = null
  connectorErrors = []
  connectorAttempts = 0
  retrievalError = null
  reflectionSufficient = true
  retrievalPasses = 1
  retrievalChunks = defaultRetrievalChunks()
  documentRows = []
  streamAnswerArgs = null
  promptSettingsRow = null
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

/**
 * TRANSPORT PARITY — the streaming RAG branch must send what its non-streaming twin sends.
 *
 * WHY THIS BLOCK EXISTS. In UAT the customer asked "Bagaimana prosedur mengembalikan uang ke
 * pelanggan yang komplain?" and was told there is NO refund procedure — while chunk #2 of
 * `02-sop-layanan-pelanggan.md` contains that procedure verbatim. The fix (a reflection note that
 * forbids turning a retrieval miss into a claim of absence, plus per-document and org source
 * guidance) was applied to `runRagBranch` only. The web chat streams through `prepareRagStream`,
 * so the fix shipped to a transport the customer's question never travelled on, and the assertion
 * that would have caught it could not exist: the tests here checked the toolRun TYPE and that the
 * stream drained, never the context string.
 *
 * Each test below fails if the corresponding block is removed from `prepareRagStream` — verified by
 * negative control (delete the block, watch this file fail, restore byte-identical).
 */
describe('prepareRagStream — parity with the non-streaming RAG branch', () => {
  /**
   * The context handed to `streamAnswer`, and a HARD FAILURE if it was never called.
   *
   * This indirection is load-bearing: most assertions below are `not.toContain`, which an
   * empty string satisfies. If the RAG branch ever degrades to plain chat (retriever error,
   * no chunks, no graph context) then `streamAnswerArgs` stays `null`, every `not.toContain`
   * passes, and the suite reports safety for a prompt nobody sent — silent-failure class #17,
   * "a guard that cannot fail". Throwing here makes that failure mode impossible to miss.
   */
  function sentContext(): string {
    if (!streamAnswerArgs) {
      throw new Error(
        'streamAnswer was never called — prepareRagStream degraded to chat, so this assertion proves nothing',
      )
    }
    return String(streamAnswerArgs.context ?? '')
  }

  test('sends the retrieved evidence to the model as the context', async () => {
    const r = await prepareRagStream({ question: 'what is the refund policy' })
    expect(await drain(r.stream)).toBe(STREAM_TEXT)
    const sent = sentContext()
    expect(sent).toContain('evidence text')
    expect(sent).toContain('more evidence')
    expect(sent).toContain('[CONTEXT (DOCUMENTS):]')
    expect(streamAnswerArgs?.source).toBe('RAG')
  })

  test('injects NO guidance and NO note when every prompt is empty', async () => {
    await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('evidence text')
    expect(sent).not.toContain('[Source guidance]')
    expect(sent).not.toContain('saya tidak menemukan ini dalam dokumen yang terambil')
  })

  test('injects the contributing documents per-document contextPrompt', async () => {
    documentRows = [{ id: 'd1', name: 'doc.pdf', contextPrompt: 'Always answer in formal Indonesian.' }]
    await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('[Source guidance]')
    expect(sent).toContain('Always answer in formal Indonesian.')
    // The guidance must come BEFORE the evidence, not after it — the model reads
    // the instructions first and the untrusted text last.
    expect(sent.indexOf('[Source guidance]')).toBeLessThan(sent.indexOf('evidence text'))
  })

  test('injects the org-wide ragContextPrompt', async () => {
    promptSettingsRow = { promptSettings: JSON.stringify({ ragContextPrompt: 'Cite the document name.' }) }
    documentRows = [{ id: 'd1', name: 'doc.pdf', contextPrompt: null }]
    await prepareRagStream({ question: 'q' })
    expect(sentContext()).toContain('Cite the document name.')
  })

  test('a document with no contextPrompt contributes nothing', async () => {
    documentRows = [
      { id: 'd1', name: 'doc.pdf', contextPrompt: null },
      { id: 'd9', name: 'unused.pdf', contextPrompt: 'SHOULD NOT APPEAR' },
    ]
    await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('evidence text')
    expect(sent).not.toContain('SHOULD NOT APPEAR')
    expect(sent).not.toContain('[Source guidance]')
  })

  test('adds the reflection note when evidence stayed insufficient after a second pass', async () => {
    reflectionSufficient = false
    retrievalPasses = 2
    await prepareRagStream({ question: 'prosedur refund' })
    const sent = sentContext()
    // The whole point of the note: name the LIMIT OF THE SEARCH, never the
    // absence of a policy. A knowledge officer acting on "there is no refund
    // procedure" would tell a customer so.
    expect(sent).toContain('saya tidak menemukan ini dalam dokumen yang terambil')
    expect(sent).toContain('do NOT claim the document or policy does not exist')
    expect(sent).toContain('state only what you did not find')
    // Still answers, and still refuses to invent.
    expect(sent).toContain('Answer based only on the evidence above.')
  })

  test('does NOT add the note when the judge was satisfied', async () => {
    reflectionSufficient = true
    retrievalPasses = 2
    await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('evidence text')
    expect(sent).not.toContain('saya tidak menemukan ini')
  })

  test('does NOT add the note when the retriever found it on the first pass', async () => {
    // The gate is `!sufficient && passes >= 2`. A single pass that came back
    // insufficient is the ordinary "weak evidence" case, not the multi-pass
    // miss the note was written for.
    reflectionSufficient = false
    retrievalPasses = 1
    await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('evidence text')
    expect(sent).not.toContain('saya tidak menemukan ini')
  })

  test('the note travels ALONGSIDE guidance, and both are absent from the audit summary', async () => {
    reflectionSufficient = false
    retrievalPasses = 2
    documentRows = [{ id: 'd1', name: 'doc.pdf', contextPrompt: 'Formal Indonesian only.' }]
    const r = await prepareRagStream({ question: 'q' })
    const sent = sentContext()
    expect(sent).toContain('Formal Indonesian only.')
    expect(sent).toContain('saya tidak menemukan ini')
    // `outputSummary` is what the UI and the audit row show; it carries the
    // EVIDENCE, matching runRagBranch, so the two transports agree on both the
    // prompt and the summary they report.
    expect(r.toolRuns[0].outputSummary).not.toContain('saya tidak menemukan ini')
    expect(r.toolRuns[0].outputSummary).not.toContain('Formal Indonesian only.')
  })
})

describe('prepareRagStream — the citation rank travels on the streaming transport too', () => {
  /**
   * `prepareRagStream` and `runRagBranch` build citations from the same retriever, so the rank must
   * reach the model the same way through both. This file deliberately does NOT mock `@/lib/tool-utils`
   * (only `@/lib/tool-branches`, and only for `executeRestRequest`), so the REAL `buildDocumentCitation`
   * runs here — the assertions below exercise the shipped helper, not a stand-in that could accept a
   * field the helper would drop.
   */
  test('carries the retriever rank onto each citation', async () => {
    retrievalChunks = [
      { chunkId: 'c1', documentId: 'd1', content: 'evidence text', score: 0.9, documentName: 'doc.pdf', rank: 2 },
      { chunkId: 'c2', documentId: 'd1', content: 'more evidence', score: 0.8, documentName: 'doc.pdf', rank: 1 },
    ]
    const r = await prepareRagStream({ question: 'q' })

    expect(r.citations.map((c) => c.rank)).toEqual([2, 1])
  })

  test('omits the key entirely when the retriever stamped no rank', async () => {
    const r = await prepareRagStream({ question: 'q' })

    expect(r.citations).toHaveLength(2)
    // `in`, not `toBeUndefined()`: the citation is JSON-serialised into the session
    // message, and a present-but-undefined key serialises away while a present-but-null
    // one would let a consumer read "no match position" as position 0.
    for (const c of r.citations) expect('rank' in (c as object)).toBe(false)
  })
})

describe('prepareRagStream — a citation snippet shows the passage, not the document summary', () => {
  test('uses the chunk\'s own text when the retriever supplied it', async () => {
    retrievalChunks = [
      { chunkId: 'c1', documentId: 'd1', content: 'From doc.pdf: SUMMARY\n\nthe matching passage', ownContent: 'the matching passage', score: 0.9, documentName: 'doc.pdf' },
    ] as never
    const r = await prepareRagStream({ question: 'q' })
    expect(r.citations[0].snippet).toBe('the matching passage')
    expect(r.citations[0].snippet).not.toContain('SUMMARY')
  })
  test('falls back to content when there is no ownContent', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentId: 'd1', content: 'plain evidence', score: 0.9, documentName: 'doc.pdf' }] as never
    const r = await prepareRagStream({ question: 'q' })
    expect(r.citations[0].snippet).toBe('plain evidence')
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

  /*
   * THE CROSS-SOURCE NOTE ON THE STREAMING TRANSPORT — it did not exist here at all.
   *
   * The non-streaming twin has carried a `crossSourceNote` for a while; this transport never did, and this is the one
   * the web chat uses. MEASURED with three databases connected: "Berapa banyak data yang tersimpan di sistem?" was
   * answered "total 45 baris data ... di empat tabel utama" from ONE database while the three hold 104 rows across 12
   * tables — a confident strict subset presented as the whole. These tests fail if the note is dropped again.
   */
  test('the answer prompt names the OTHER sources and forbids presenting a subset as the whole', async () => {
    integrationCount = 1
    integrations = [{ id: 'int-1', name: 'ZZ Sales', status: 'active', schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }] }]
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    await prepareSqlStream({
      question: 'Berapa banyak data yang tersimpan di sistem?',
      userId: 'u1',
      integrationId: 'int-1',
      integrationNames: ['ZZ Sales', 'ZZ HR', 'ZZ Logistics'],
    })
    const prefix = String(streamAnswerArgs?.systemPromptPrefix ?? '')
    // The chosen source is named...
    expect(prefix).toContain('ZZ Sales ONLY')
    // ...the others are named as NOT included...
    expect(prefix).toContain('ZZ HR')
    expect(prefix).toContain('ZZ Logistics')
    /*
     * RULE 2 IS ASSERTED BY ITS CONSEQUENCE, not by two words that survive a crude cut. A negative control showed an
     * earlier version of these assertions was VACUOUS for rule 2: deleting the whole rule still passed, because
     * "Never" also appears in rule 1. Rule 2 is the one the defect needed — a question about the workspace answered
     * from one source — so it is pinned by the claims that only it makes: the source CANNOT answer alone, the others
     * were NOT included, and the answer should offer a per-source run.
     */
    expect(prefix).toContain('TOTAL amount of data')
    expect(prefix).toContain('CANNOT answer it alone')
    expect(prefix).toContain('were NOT included')
    expect(prefix).toContain('offer to run it per source')
  })

  test('a SINGLE source gets no note — there is nothing to disambiguate', async () => {
    integrationCount = 1
    integrations = [{ id: 'int-1', name: 'Only One', status: 'active', schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }] }]
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1', integrationNames: ['Only One'] })
    expect(String(streamAnswerArgs?.systemPromptPrefix ?? '')).not.toContain('Other connected data sources')
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

  describe('prepareSqlStream — editable Text-to-SQL rules', () => {
    /**
     * The rules are an EDITABLE setting. Before this, the streaming path read no prompt settings at
     * all, so an admin editing them would see the change apply to scheduled runs and /api/v1 (which
     * use `runSqlBranch`) while the interactive chat — the very place they tested it — kept the old
     * behaviour. These two tests pin both directions: a custom value travels, and an empty value falls
     * back to the built-in rules rather than sending nothing.
     */
    test('passes the org custom rules through to generateSql', async () => {
      promptSettingsRow = { promptSettings: JSON.stringify({ sqlRulesPrompt: 'CUSTOM RULE XYZ' }) }
      generateSqlArgs = null
      generateSqlResults = [{ sql: 'SELECT 1 LIMIT 1', explanation: 'x' }]
      const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
      await drain(r.stream)
      expect(generateSqlArgs?.sqlRules).toBe('CUSTOM RULE XYZ')
    })

    test('falls back to the built-in rules when the org has not set any', async () => {
      promptSettingsRow = { promptSettings: JSON.stringify({}) }
      generateSqlArgs = null
      generateSqlResults = [{ sql: 'SELECT 1 LIMIT 1', explanation: 'x' }]
      const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
      await drain(r.stream)
      const rules = String(generateSqlArgs?.sqlRules ?? '')
      // The DEFAULT must actually be the rules, not an empty string: sending no rules would produce a
      // Text-to-SQL prompt with no constraints, and the failure would look like a model problem.
      expect(rules).toContain('ONLY SELECT')
      expect(rules.length).toBeGreaterThan(1000)
    })

    test('treats whitespace-only rules as unset', async () => {
      // A stray newline in the editor must not replace the rules with nothing.
      promptSettingsRow = { promptSettings: JSON.stringify({ sqlRulesPrompt: '   \n  ' }) }
      generateSqlArgs = null
      generateSqlResults = [{ sql: 'SELECT 1 LIMIT 1', explanation: 'x' }]
      const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
      await drain(r.stream)
      expect(String(generateSqlArgs?.sqlRules ?? '')).toContain('ONLY SELECT')
    })
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

describe('the streaming SQL path records and limits exactly like the non-streaming one', () => {
  /*
   * MEASURED 2026-10-04: this transport — the one the web chat uses — wrote no GUARDRAIL_BLOCK / SQL_EXECUTE audit
   * rows and no queryHistory, had no SQL tool rate limit and dropped the integration's contextPrompt. The tests that
   * stood here pinned those gaps as "known divergences". Both transports now run `runSqlPipeline`, so the behaviour
   * is asserted instead.
   */
  test('a guardrail rejection is audited as critical, and the repaired query is recorded', async () => {
    generateSqlResults = [{ sql: 'DROP TABLE orders' }, { sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    expect(r.toolRuns[0].status).toBe('success')
    expect(auditActions).toEqual(['GUARDRAIL_BLOCK:critical', 'SQL_EXECUTE:info'])
    expect(queryHistorySuccess).toEqual([true])
  })

  test('a failed execution is recorded in queryHistory and audited as a warning', async () => {
    generateSqlResults = [{ sql: 'SELECT nope FROM orders LIMIT 10' }, { sql: 'SELECT total FROM orders LIMIT 10' }]
    connectorErrors = [new Error('column "nope" does not exist')]
    const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    expect(r.toolRuns[0].status).toBe('success')
    expect(queryHistorySuccess).toEqual([false, true])
    expect(auditActions).toContain('SQL_EXECUTE_ERROR:warning')
  })

  test('the SQL tool rate limit applies before any SQL is generated', async () => {
    sqlRateLimitAllowed = false
    generateSqlArgs = null
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    expect(r.toolRuns[0].status).toBe('blocked')
    expect(generateSqlArgs).toBeNull()
    expect(executedSql).toEqual([])
  })

  test("the integration's admin contextPrompt reaches SQL generation", async () => {
    integrations = integrations.map((i) => ({ ...i, contextPrompt: 'Fiscal year starts in April.' }))
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    expect(String(generateSqlArgs?.systemPromptPrefix)).toContain('Fiscal year starts in April.')
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

describe('streaming failure paths that had never run', () => {
  test('a retriever failure DEGRADES to plain chat instead of failing the stream', async () => {
    // RAG is best-effort: the knowledge backend being down must not kill the turn.
    // Returning a rejected promise would surface as a dead SSE stream — the user sees
    // nothing at all, which is strictly worse than a plain answer with no citations.
    retrievalError = new Error('vector store unavailable')
    const r = await prepareRagStream({ question: 'what is the refund policy' })
    // No RAG tool run: nothing was retrieved, and claiming otherwise would be a lie
    // in the audit trail.
    expect(r.toolRuns.some((t) => t.type === 'RAG')).toBe(false)
    // A drainable stream is still returned, so the caller can always finish the SSE.
    await expect(drain(r.stream)).resolves.toBeString()
  })

  test('a transient ECONNRESET is retried ONCE and can still succeed', async () => {
    // Remote databases drop connections under load; one retry recovers most of them.
    // The 1000ms backoff is real, so this test takes about a second — worth it,
    // because without the retry a single reset becomes a failed question.
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    // A queue of failures, consumed one per attempt: the first call resets, the
    // second succeeds. Driving this from a counter (rather than a timer flipping a
    // shared flag) is what makes the assertion about the RETRY and nothing else.
    connectorErrors.length = 0
    connectorErrors.push(new Error('read ECONNRESET'))

    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    // The retry is what turns a transient reset into a successful answer.
    expect(connectorAttempts).toBe(2)
    expect(r.toolRuns[0].status).toBe('success')
    await expect(drain(r.stream)).resolves.toBeString()
  })

  test('a NON-transient error is not retried — it fails on the first attempt', async () => {
    // Retrying a syntax or permission error costs a full second and cannot succeed.
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    connectorErrors.length = 0
    connectorErrors.push(new Error('permission denied for table orders'))
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    expect(connectorAttempts).toBe(1)
    expect(r.toolRuns[0].status).not.toBe('success')
  })

  test('the retry gives up after one attempt when the reset repeats', async () => {
    // A permanently unreachable host must surface as an error, not an endless loop.
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    connectorErrors.length = 0
    connectorErrors.push(new Error('socket hang up'), new Error('socket hang up'))
    const r = await prepareSqlStream({ question: 'q', userId: 'u1', integrationId: 'int-1' })
    expect(connectorAttempts).toBe(2)
    expect(r.toolRuns[0].status).not.toBe('success')
  })
})

describe('the streaming SQL path must forward the generator\'s stated QUERY SCOPE', () => {
  /**
   * MEASURED IN UAT, and the reason this test exists in THIS file: `/send` — the path the chat UI actually uses —
   * streams through `stream-preparers.ts`, NOT through `tool-branches.ts`. A fix applied only to the non-streaming
   * branch changed nothing a user could see, which a probe confirmed (the branch's log line never fired while the chat
   * kept answering). Only `candidate.sql` was used; `explanation` was dropped.
   *
   * WHY IT MATTERS: rule 17 tells the SQL generator to name the population it measured, because two questions in one
   * session silently used different filters and reported Rp 1.240.000 vs Rp 1.620.000 for the same customer with
   * neither answer mentioning it. The rule writes that into `explanation` — so dropping the field discards the rule's
   * entire output.
   *
   * Verified end to end after the fix: the same question now answers "dihitung dari pesanan berstatus 'selesai' saja".
   */
  const src = readFileSync(join(import.meta.dir, 'stream-preparers.ts'), 'utf8')

  test('the explanation is captured from the SQL candidate and reaches the answer', async () => {
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10', explanation: 'completed orders only' }]
    const r = await prepareSqlStream({ question: 'show totals', userId: 'u1', integrationId: 'int-1' })
    await drain(r.stream)
    expect(String(streamAnswerArgs?.context)).toContain('QUERY SCOPE (what the SQL measured): completed orders only')
  })

  test('it reaches the answer context as QUERY SCOPE, inside the untrusted wrapper', () => {
    // The label must be present so the model can tell scope from rows...
    expect(src).toMatch(/QUERY SCOPE \(what the SQL measured\)/)
    // ...and it must be concatenated BEFORE the wrapped rows, so it cannot be mistaken for data.
    expect(src).toMatch(/sqlExplanation \? `QUERY SCOPE/)
  })

  test('the NON-streaming path carries it too, so the two transports cannot diverge', () => {
    // The explanation is captured once, in the shared pipeline; both adapters render it as QUERY SCOPE.
    const branches = readFileSync(join(import.meta.dir, 'tool-branches.ts'), 'utf8')
    const pipeline = readFileSync(join(import.meta.dir, 'pipelines/sql-pipeline.ts'), 'utf8')
    expect(branches).toMatch(/QUERY SCOPE \(what the SQL measured\)/)
    expect(pipeline).toMatch(/sqlExplanation = typeof candidate\.explanation === 'string'/)
})
})

describe('prepareSqlStream — the documents fallback when the database did not answer', () => {
  /*
   * MEASURED CAUSE. 5.7% of document questions in an eval were routed to the database, concentrated on phrasings that
   * LOOK like a data query ("berapa jam pelatihan per tahun … masa kerja di atas 3 tahun") whose answer is a policy
   * figure. Once in this branch there was no way back: the user got "cannot be computed" or a confident wrong number.
   * The verdict is read off the ROWS, never off the answer's wording, and the documents are only a SECOND attempt.
   */
  const run = (extra: Record<string, unknown> = {}) =>
    prepareSqlStream({ question: 'Berapa jam pelatihan per tahun?', userId: 'u1', ...extra } as never)

  test('rows that answer are KEPT — the fallback never replaces a real database answer', async () => {
    readyDocumentCount = 3
    connectorRows = [{ jumlah_karyawan: '3' }]
    generateSqlResults = [{ sql: 'SELECT COUNT(*) AS jumlah_karyawan FROM karyawan LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => true })
    expect(r.citations[0]?.type).toBe('DATABASE')
    expect(r.toolRuns.map((t) => t.type)).toEqual(['SQL'])
  })

  test('EMPTY rows fall back to the documents, and BOTH attempts are on the audit trail', async () => {
    readyDocumentCount = 3
    connectorRows = []
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => true })
    expect(r.citations[0]?.type).toBe('DOCUMENT')
    expect(r.toolRuns[0]).toMatchObject({ type: 'SQL', outputSummary: 'not used: no-rows' })
    expect(r.toolRuns.length).toBeGreaterThan(1)
  })

  test('an all-NULL aggregate (one row of NULL) is NOT an answer, though the row count is 1', async () => {
    readyDocumentCount = 3
    connectorRows = [{ total: null }]
    generateSqlResults = [{ sql: 'SELECT SUM(total) AS total FROM orders LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => true })
    expect(r.citations[0]?.type).toBe('DOCUMENT')
    expect(r.toolRuns[0]?.outputSummary).toBe('not used: all-null')
  })

  test("the generator's improvised 'cannot answer' row is NOT an answer", async () => {
    // MEASURED: the generator has no sanctioned way to say the schema cannot answer, so it emitted
    // `SELECT 'TIDAK DAPAT DIJAWAB' AS status, …` — which SUCCEEDS and returns one row.
    readyDocumentCount = 3
    connectorRows = [{ status: 'TIDAK DAPAT DIJAWAB', keterangan: 'Tidak tersedia: skema tidak punya tabel pelatihan' }]
    generateSqlResults = [{ sql: 'SELECT total AS status FROM orders LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => true })
    expect(r.citations[0]?.type).toBe('DOCUMENT')
    expect(r.toolRuns[0]?.outputSummary).toBe('not used: placeholder')
  })

  test('populated rows the judge calls irrelevant fall back, and a judge OUTAGE keeps the rows', async () => {
    readyDocumentCount = 3
    connectorRows = [{ id: 1, nama: 'Andi', jabatan: 'Engineer' }]
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }, { sql: 'SELECT total FROM orders LIMIT 10' }]
    const irrelevant = await run({ relevanceJudge: async () => false })
    expect(irrelevant.citations[0]?.type).toBe('DOCUMENT')
    expect(irrelevant.toolRuns[0]?.outputSummary).toBe('not used: judged-irrelevant')

    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const outage = await run({ relevanceJudge: async () => { throw new Error('provider down') } })
    expect(outage.citations[0]?.type).toBe('DATABASE')
  })

  test('NO documents means no fallback — the database answer stands', async () => {
    readyDocumentCount = 0
    connectorRows = []
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => false })
    expect(r.citations[0]?.type).toBe('DATABASE')
    expect(r.toolRuns.map((t) => t.type)).toEqual(['SQL'])
  })

  test('a database the USER pinned is never second-guessed', async () => {
    readyDocumentCount = 3
    connectorRows = []
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await run({ userPinnedIntegration: true, relevanceJudge: async () => false })
    expect(r.citations[0]?.type).toBe('DATABASE')
  })

  test('when the documents ALSO find nothing, the database answer is kept, not a general-knowledge chat reply', async () => {
    // prepareRagStream degrades to plain CHAT with no citations when retrieval is empty. Accepting that would
    // swap a truthful "no data" for an answer from nowhere.
    readyDocumentCount = 3
    retrievalChunks = []
    connectorRows = []
    generateSqlResults = [{ sql: 'SELECT total FROM orders LIMIT 10' }]
    const r = await run({ relevanceJudge: async () => true })
    expect(r.citations[0]?.type).toBe('DATABASE')
    retrievalChunks = defaultRetrievalChunks()
  })
})

describe('prepareSqlStream — the repair loop respects the time budget', () => {
  test('a retry DOES run when the budget allows it (the control direction)', async () => {
    integrations = [{
      id: 'int-1', name: 'Sales', status: 'active', provider: 'POSTGRESQL', encryptedConfig: 'deadbeef',
      schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }],
    }]
    integrationCount = 1
    connectorRows = [{ total: 7 }]
    // The FIRST attempt must FAIL, or there is nothing to repair: an execution error is the trigger. Two
    // scripted results: attempt 1 errors, attempt 2 succeeds — a repair in the budget must consume both.
    connectorErrors = [new Error('relation "nope" does not exist')]
    generateSqlResults = [{ sql: 'SELECT total FROM nope LIMIT 10' }, { sql: 'SELECT total FROM orders LIMIT 5' }]
    const r = await prepareSqlStream({ question: 'repairable', userId: 'u1' })
    let text = ''
    for await (const c of r.stream) text += c
    expect(generateSqlResults.length, 'the retry consumed the second scripted result').toBe(0)
    expect(r.citations[0]?.type).toBe('DATABASE')
  })


  /*
   * VERIFIED-VALID WEAKNESS (external review #4, narrow form): one attempt is an LLM call plus a query, each
   * ~30s worst case, and the loop counted ATTEMPTS, never elapsed time — so attempt 3 could start at t=100s on
   * a turn whose 120s deadline was gone. The check breaks the loop BEFORE a retry that cannot finish.
   *
   * The budget is injected by rewinding `started`: the branch records it once at entry, so backdating it past
   * the total budget makes the check see an exhausted clock without sleeping.
   */
  test('a retry is NOT started when the clock is already spent, and the recorded failure is what the answer gets', async () => {
    integrations = [{
      id: 'int-1', name: 'Sales', status: 'active', provider: 'POSTGRESQL', encryptedConfig: 'deadbeef',
      schemas: [{ tableName: 'orders', columns: '[]', sampleRow: null, description: null }],
    }]
    integrationCount = 1
    connectorRows = [{ total: 7 }]
    // The first attempt must FAIL on EXECUTION, or no repair is ever attempted and the test measures
    // nothing (MEASURED: with a succeeding first attempt it stayed green with the check deleted).
    connectorErrors = [new Error('relation "nope" does not exist')]
    generateSqlResults = [{ sql: 'SELECT total FROM nope LIMIT 10' }, { sql: 'SELECT total FROM orders LIMIT 5' }]
    // Budget of 1ms: any elapsed time exceeds it, so the retry must be refused.
    process.env.SQL_REPAIR_TOTAL_BUDGET_MS = '1'
    try {
      const r = await prepareSqlStream({ question: 'late turn', userId: 'u1' })
      let text = ''
      for await (const c of r.stream) text += c
      /*
       * The loop STOPPED after attempt 0. The queue was loaded with TWO results; attempt 0 shifted one,
       * so exactly ONE remains — a full repair would have consumed both. (The first version of this
       * assertion expected 0 and failed on the WORKING code, which is how the arithmetic error surfaced:
       * the budget check was doing its job while the test demanded the impossible.)
       */
      expect(generateSqlResults.length, 'the retry was refused — its scripted result is still queued').toBe(1)
      expect(r.toolRuns.length).toBeGreaterThan(0)
    } finally {
      process.env.SQL_REPAIR_TOTAL_BUDGET_MS = undefined
    }
  })
})

describe('prepareRagStream — a failed retrieval leaves a DEGRADED trace', () => {
  /*
   * The streaming twin of tool-branches' marker. The chat UI is THIS transport, so without the marker
   * here the fix would exist only on the path nothing calls — the transport-drift class this repo has
   * recorded three times.
   */
  test('a retrieval ERROR marks the tool run DEGRADED from RAG with the reason', async () => {
    retrievalError = new Error('cognee http 503')
    const r = await prepareRagStream({ question: 'what is the policy?' })
    const chatRun = r.toolRuns.find((t) => t.type === 'CHAT')
    expect(chatRun?.outputSummary ?? '').toContain('DEGRADED from RAG')
    expect(chatRun?.outputSummary ?? '').toContain('cognee http 503')
    expect(r.citations).toEqual([])
  })

  test('an EMPTY retrieval is not degraded', async () => {
    retrievalChunks = []
    const r = await prepareRagStream({ question: 'hello' })
    const chatRun = r.toolRuns.find((t) => t.type === 'CHAT')
    expect(chatRun?.outputSummary ?? '').not.toContain('DEGRADED')
    retrievalChunks = defaultRetrievalChunks()
  })
})
