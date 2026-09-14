import { describe, expect, test, mock } from 'bun:test'

// The module reads DB counts; the pure decision logic is what these tests cover, so
// the DB is mocked away and `decideRoute` is exercised through its SOURCES argument.
// The stub must cover every table the REAL modules touch on the paths under test.
// It first omitted `llmConfig`, so `getRoleLlmConfig` threw
// "undefined is not an object" and two tests failed for a reason that had nothing to
// do with the logic being tested. `llmConfig.findFirst` returning null is what makes
// "no classifier configured" the genuine case here.
mock.module('./db', () => ({
  db: {
    document: { count: async () => 0, findMany: async () => [] },
    integration: { count: async () => 0, findMany: async () => [], findFirst: async () => null },
    restApiEndpoint: { count: async () => 0, findMany: async () => [] },
    llmConfig: { findFirst: async () => null },
  },
}))
// A mocked module has to expose EVERY export its consumers import, or the import
// itself fails with "Export named X not found" before any test runs -- `llm-client`
// also pulls getLlmRuntimeConfig and getAgentLlmConfig. Rather than restate a shape I
// would have to keep in step, the real module is used and only the DB is stubbed:
// with no `chat` row configured, `getRoleLlmConfig('keyword')` resolves to null on
// its own, which is exactly the "no classifier available" case under test.

mock.module('./stream-preparers', () => ({
  prepareChatStream: async () => ({ stream: (async function* () {})(), toolRuns: [], citations: [], chartData: null }),
  prepareRagStream: async () => ({ stream: (async function* () {})(), toolRuns: [], citations: [], chartData: null }),
  prepareSqlStream: async () => ({ stream: (async function* () {})(), toolRuns: [], citations: [], chartData: null }),
  prepareRestStream: async () => ({ stream: (async function* () {})(), toolRuns: [], citations: [], chartData: null }),
}))

const { decideRoute, parseSimpleDecision } = await import('./simple-pipeline')

const NO_SOURCES = { documents: 0, integrations: 0, restEndpoints: 0 }

describe('parseSimpleDecision', () => {
  test('plain JSON', () => {
    expect(parseSimpleDecision('{"tool":"RAG","reason":"policy question"}')).toEqual({
      tool: 'RAG',
      reason: 'policy question',
    })
  })

  test('markdown fence', () => {
    expect(parseSimpleDecision('```json\n{"tool":"SQL","reason":"count"}\n```')?.tool).toBe('SQL')
  })

  test('prose surrounding the JSON', () => {
    expect(
      parseSimpleDecision('Berdasarkan pertanyaan, {"tool":"REST","reason":"api"} sudah cocok')?.tool,
    ).toBe('REST')
  })

  test('a lowercase tool is normalised, not rejected', () => {
    expect(parseSimpleDecision('{"tool":"chat","reason":"x"}')?.tool).toBe('CHAT')
  })

  // A classifier that answers with SQL-ish TEXT must never be read as a tool choice.
  test('an unknown tool is rejected rather than guessed', () => {
    expect(parseSimpleDecision('{"tool":"DROP TABLE","reason":"x"}')).toBeNull()
  })

  test('an empty reply is rejected', () => {
    expect(parseSimpleDecision('')).toBeNull()
  })

  test('prose with no JSON is rejected', () => {
    expect(parseSimpleDecision('Saya tidak yakin.')).toBeNull()
  })
})

describe('decideRoute — the deterministic fast paths cost ZERO LLM calls', () => {
  // The whole point of the rewrite: these cases must not reach a model.
  test('no data source connected -> CHAT with no classifier call', async () => {
    const d = await decideRoute({ question: 'Berapa total pesanan?', sources: NO_SOURCES })
    expect(d.route).toBe('CHAT')
    expect(d.classifierCalls).toBe(0)
    expect(d.reason).toContain('no data source')
  })

  test('a greeting -> CHAT with no classifier call, even when sources exist', async () => {
    const d = await decideRoute({
      question: 'Halo, apa kabar?',
      sources: { documents: 3, integrations: 2, restEndpoints: 1 },
    })
    expect(d.route).toBe('CHAT')
    expect(d.classifierCalls).toBe(0)
    expect(d.reason).toBe('greeting or small talk')
  })

  test('"terima kasih" is small talk too', async () => {
    const d = await decideRoute({
      question: 'terima kasih',
      sources: { documents: 3, integrations: 2, restEndpoints: 1 },
    })
    expect(d.route).toBe('CHAT')
    expect(d.classifierCalls).toBe(0)
  })

  // The anchoring matters: a DATA question that opens with a greeting must not be
  // answered as small talk, or every "halo, berapa ...?" would lose its data.
  test('a data question opening with a greeting is NOT treated as small talk', async () => {
    const d = await decideRoute({
      question: 'halo, berapa total pesanan selesai?',
      sources: { documents: 3, integrations: 2, restEndpoints: 1 },
    })
    // With sources present and no classifier configured it falls back to a source,
    // which is the point: it did NOT take the greeting shortcut.
    expect(d.reason).not.toBe('greeting or small talk')
  })

  test('exactly one document and nothing else -> RAG, no classifier call', async () => {
    const d = await decideRoute({ question: 'Apa isi kebijakan cuti?', sources: { documents: 1, integrations: 0, restEndpoints: 0 } })
    expect(d.route).toBe('RAG')
    expect(d.classifierCalls).toBe(0)
    expect(d.reason).toContain('only one data source')
  })

  test('exactly one database and nothing else -> SQL, no classifier call', async () => {
    const d = await decideRoute({ question: 'Berapa jumlah pelanggan?', sources: { documents: 0, integrations: 1, restEndpoints: 0 } })
    expect(d.route).toBe('SQL')
    expect(d.classifierCalls).toBe(0)
  })

  test('exactly one REST endpoint and nothing else -> REST, no classifier call', async () => {
    const d = await decideRoute({ question: 'Ambil data stok', sources: { documents: 0, integrations: 0, restEndpoints: 1 } })
    expect(d.route).toBe('REST')
    expect(d.classifierCalls).toBe(0)
  })

  // Multiple sources with no classifier available must still answer, from a source
  // that EXISTS, rather than failing the request.
  test('ambiguous sources with no classifier configured still returns a usable route', async () => {
    const d = await decideRoute({
      question: 'Bagaimana prosedurnya?',
      sources: { documents: 5, integrations: 0, restEndpoints: 0 },
    })
    expect(['RAG', 'SQL', 'REST']).toContain(d.route)
  })
})
