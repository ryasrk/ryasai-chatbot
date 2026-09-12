import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'

// --- Configurable DB mock ---
const mockLlmConfigFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(async () => null)
const mockDocumentChunkFindMany = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => [])
const mockExecuteRaw = mock<(...args: unknown[]) => Promise<number>>(async () => 1)
const mockQueryRaw = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => [])

// getEmbeddingRuntimeConfig now REFUSES to resolve a config without an org
// context (a context-free `findFirst` returned another tenant's baseUrl/model/
// key — proven at runtime, trial/55). Production always has one: HTTP routes
// call enterWithOrg, and job-processor.ts enters the org before embedding. So
// the test supplies the context production has.
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'test-org',
  enterWithOrg: () => undefined,
  bypassOrg: async (fn: () => unknown) => fn(),
}))

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: { findFirst: mockLlmConfigFindFirst },
    documentChunk: { findMany: mockDocumentChunkFindMany },
    document: { findMany: async () => [] },
    $queryRaw: mockQueryRaw,
    $executeRaw: mockExecuteRaw,
  },
}))

// --- Crypto mock (decryptConfig returns a fake API key) ---
mock.module('@/lib/crypto', () => ({
  decryptConfig: () => ({ apiKey: 'test-key' }),
}))

// --- LLM config mock ---
const mockGetRoleLlmConfig = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(async () => null)
mock.module('@/lib/llm-config', () => ({
  normalizeBaseUrl: (url: string) => url.replace(/\/$/, ''),
  getRoleLlmConfig: mockGetRoleLlmConfig,
}))

// --- LLM client mock ---
const mockChatOnce = mock(async () => 'A summary of the document.')
mock.module('@/lib/llm-client', () => ({
  chatOnce: mockChatOnce,
}))

// --- Vector stores mock (no external vector store) ---
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => null,
  ensureVectorCollection: async () => {},
  buildVectorPoint: (args: unknown) => args,
  upsertVectorPoints: async () => {},
}))

import {
  combineHybridScore,
  cosineSimilarity,
  embedCompanyDocuments,
  embedDocumentChunks,
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
  resetEmbeddingColumnDimension,
  parseEmbeddingResponse,
} from './embeddings'

// Reset mocks to defaults before each test
beforeEach(() => {
  mockLlmConfigFindFirst.mockImplementation(async () => null)
  mockDocumentChunkFindMany.mockImplementation(async () => [])
  mockExecuteRaw.mockImplementation(async () => 1)
  mockQueryRaw.mockImplementation(async () => [])
  mockGetRoleLlmConfig.mockImplementation(async () => null)
  mockChatOnce.mockImplementation(async () => 'A summary of the document.')
})

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

describe('cosineSimilarity', () => {
  test('identical vectors → 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6)
  })

  test('orthogonal vectors → 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  test('opposite vectors → -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
  })

  test('empty vector → 0', () => {
    expect(cosineSimilarity([], [1])).toBe(0)
  })

  test('length mismatch → 0', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0)
  })

  test('zero vector → 0 (avoids div-by-zero)', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })
})

describe('combineHybridScore', () => {
  test('keeps lexical base and adds semantic signal', () => {
    const hybrid = combineHybridScore({ lexicalTotal: 8, semanticSimilarity: 0.75 })
    expect(hybrid.total).toBeGreaterThan(8)
    expect(hybrid.semanticScore).toBeGreaterThan(0)
  })

  test('undefined semantic → 0 semantic score, total = lexical', () => {
    const hybrid = combineHybridScore({ lexicalTotal: 5 })
    expect(hybrid.semanticSimilarity).toBe(0)
    expect(hybrid.semanticScore).toBe(0)
    expect(hybrid.total).toBe(5)
  })

  test('negative semantic clamped to 0', () => {
    const hybrid = combineHybridScore({ lexicalTotal: 3, semanticSimilarity: -0.5 })
    expect(hybrid.semanticSimilarity).toBe(0)
    expect(hybrid.semanticScore).toBe(0)
  })

  test('zero lexical + full semantic → semanticScore only', () => {
    const hybrid = combineHybridScore({ lexicalTotal: 0, semanticSimilarity: 1 })
    expect(hybrid.lexicalTotal).toBe(0)
    expect(hybrid.semanticScore).toBe(12)
    expect(hybrid.total).toBe(12)
  })
})

describe('parseEmbeddingResponse', () => {
  test('parses OpenAI-compatible response', () => {
    expect(
      parseEmbeddingResponse('OPENAI_COMPATIBLE', {
        data: [{ embedding: [0.1, 0.2] }],
      }),
    ).toEqual([[0.1, 0.2]])
  })

  test('parses OPENAI provider response', () => {
    expect(
      parseEmbeddingResponse('OPENAI', {
        data: [{ embedding: [0.5, 0.6, 0.7] }],
      }),
    ).toEqual([[0.5, 0.6, 0.7]])
  })

  test('parses Ollama embeddings array format', () => {
    expect(
      parseEmbeddingResponse('OLLAMA', {
        embeddings: [[0.3, 0.4]],
      }),
    ).toEqual([[0.3, 0.4]])
  })

  test('parses Ollama single embedding format', () => {
    expect(
      parseEmbeddingResponse('OLLAMA', {
        embedding: [0.1, 0.2, 0.3],
      }),
    ).toEqual([[0.1, 0.2, 0.3]])
  })

  test('missing data array → empty', () => {
    expect(parseEmbeddingResponse('OPENAI_COMPATIBLE', {})).toEqual([])
  })

  test('filters out empty embeddings', () => {
    expect(
      parseEmbeddingResponse('OPENAI_COMPATIBLE', {
        data: [{ embedding: [] }, { embedding: [0.1] }],
      }),
    ).toEqual([[0.1]])
  })

  test('non-numeric values filtered from embedding arrays', () => {
    const result = parseEmbeddingResponse('OLLAMA', {
      embeddings: [[0.1, NaN, 'x' as unknown as number]],
    })
    expect(result).toEqual([[0.1]])
  })
})

describe('parseEmbeddingJson', () => {
  test('parses valid JSON array → number[]', () => {
    expect(parseEmbeddingJson('[0.1, 0.2, 0.3]')).toEqual([0.1, 0.2, 0.3])
  })

  test('null → null', () => {
    expect(parseEmbeddingJson(null)).toBeNull()
  })

  test('empty string → null', () => {
    expect(parseEmbeddingJson('')).toBeNull()
  })

  test('invalid JSON → null', () => {
    expect(parseEmbeddingJson('not-json')).toBeNull()
  })

  test('empty array → null (no values)', () => {
    expect(parseEmbeddingJson('[]')).toBeNull()
  })
})

describe('embedTexts', () => {
  const cfg = {
    provider: 'OPENAI_COMPATIBLE' as const,
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-test',
    model: 'text-embedding-3-small',
  }

  test('happy path → returns parsed vectors', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
      } as Response),
    ) as unknown as typeof fetch

    const result = await embedTexts(cfg, ['hello'])
    expect(result).toEqual([[0.1, 0.2]])
  })

  test('empty input after trim → returns []', async () => {
    const result = await embedTexts(cfg, ['', '   '])
    expect(result).toEqual([])
  })

  test('a blank input keeps every other vector on its own index', async () => {
    // The landmine: embedDocumentChunks pairs vectors[i] with chunks[i]. This used
    // to .filter(Boolean) the input, so one blank chunk shifted every later vector
    // up by one and silently attached the wrong embedding to the rest of the
    // document — permanently, with no error anywhere.
    let sentInputs: string[] = []
    global.fetch = mock((_url: string, init: RequestInit) => {
      sentInputs = JSON.parse(String(init.body)).input
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [1, 1] }, { embedding: [3, 3] }] }),
      } as Response)
    }) as unknown as typeof fetch

    const result = await embedTexts(cfg, ['first', '   ', 'third'])

    // The blank was never sent to the API...
    expect(sentInputs).toEqual(['first', 'third'])
    // ...and the vectors still line up with the ORIGINAL positions.
    expect(result).toEqual([[1, 1], [3, 3]].flatMap((v, i) => (i === 0 ? [v, []] : [v])))
    expect(result[0]).toEqual([1, 1])
    expect(result[1]).toEqual([]) // blank → empty, callers skip it
    expect(result[2]).toEqual([3, 3])
  })

  test('output length always matches input length', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.5] }] }),
      } as Response),
    ) as unknown as typeof fetch

    const result = await embedTexts(cfg, ['  ', 'only real one', ''])
    expect(result).toHaveLength(3)
    expect(result[1]).toEqual([0.5])
  })

  test('HTTP error → throws with status code', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 } as Response),
    ) as unknown as typeof fetch

    await expect(embedTexts(cfg, ['hi'])).rejects.toThrow('500')
  })

  test('429 → retries then succeeds on next attempt', async () => {
    let calls = 0
    global.fetch = mock(() => {
      calls += 1
      if (calls === 1) return Promise.resolve({ ok: false, status: 429 } as Response)
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1] }] }) } as Response)
    }) as unknown as typeof fetch

    const result = await embedTexts(cfg, ['hello'])
    expect(result).toEqual([[0.1]])
    expect(calls).toBe(2)
  })

  test('4xx validation error → no retry (single call)', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: false, status: 400 } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await expect(embedTexts(cfg, ['hi'])).rejects.toThrow('400')
    expect(fetchMock.mock.calls.length).toBe(1)
  })

  test('vector count mismatch → throws clear error instead of misaligning', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }) } as Response),
    ) as unknown as typeof fetch

    await expect(embedTexts(cfg, ['one', 'two'])).rejects.toThrow(/refusing to misalign/)
  })

  test('truncates oversized inputs to 30K chars before POSTing', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [{ embedding: [0.1] }] }) } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await embedTexts(cfg, ['x'.repeat(100_000)])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input[0].length).toBe(30_000)
  })

  test('Ollama provider → uses /api/embed endpoint', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ embedding: [0.5] }),
      } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await embedTexts({ ...cfg, provider: 'OLLAMA' }, ['hi'])
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/embed')
  })

  test('sends Bearer auth header when apiKey set', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await embedTexts(cfg, ['hi'])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  test('no apiKey → no Authorization header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ embedding: [0.1] }] }),
      } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await embedTexts({ ...cfg, apiKey: '' }, ['hi'])
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('getEmbeddingRuntimeConfig', () => {
  test('no LLM config in DB → returns null', async () => {
    const result = await getEmbeddingRuntimeConfig()
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Contextual Retrieval — Anthropic technique (prepend LLM doc summary to chunks)
// ---------------------------------------------------------------------------

const fakeEmbeddingConfig = {
  id: 'cfg-1',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://api.test.com',
  embeddingProvider: 'OPENAI_COMPATIBLE',
  embeddingBaseUrl: 'https://api.test.com',
  embeddingModel: 'text-embedding-3-small',
  encryptedEmbeddingApiKey: 'encrypted',
  encryptedApiKey: 'encrypted',
}

function mockFetchEmbeddings(inputCount?: number) {
  const fetchMock = mock(async (url: string, init?: RequestInit) => {
    let n: number = inputCount ?? 2
    if (inputCount === undefined) {
      try {
        const body = JSON.parse(String(init?.body ?? ''))
        if (Array.isArray(body?.input)) n = body.input.length
      } catch {
        n = 2
      }
    }
    const data = Array.from({ length: n }, (_, i) => ({ embedding: [0.1 + i, 0.2 + i, 0.3 + i] }))
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ data }),
    } as Response)
  })
  global.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

describe('embedDocumentChunks — Contextual Retrieval', () => {
  const originalEnv = process.env.CONTEXTUAL_RETRIEVAL

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CONTEXTUAL_RETRIEVAL
    else process.env.CONTEXTUAL_RETRIEVAL = originalEnv
  })

  test('CONTEXTUAL_RETRIEVAL not set → no LLM call, content unchanged', async () => {
    delete process.env.CONTEXTUAL_RETRIEVAL
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: 'SOP' } },
      { id: 'c2', content: 'chunk two', chunkIndex: 1, document: { id: 'd1', name: 'Doc A', category: 'SOP' } },
    ])
    const fetchMock = mockFetchEmbeddings()

    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(2)
    expect(mockChatOnce).not.toHaveBeenCalled()

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input).toEqual(['chunk one', 'chunk two'])
  })

  test('CONTEXTUAL_RETRIEVAL=true → generates summary, prepends prefix to embedding input', async () => {
    process.env.CONTEXTUAL_RETRIEVAL = 'true'
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    mockGetRoleLlmConfig.mockImplementation(async () => ({
      id: 'cfg-1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: 'sk-test', model: 'gpt-4',
    }))
    mockChatOnce.mockImplementation(async () => 'A policy document about休假 rules.')
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: 'SOP' } },
      { id: 'c2', content: 'chunk two', chunkIndex: 1, document: { id: 'd1', name: 'Doc A', category: 'SOP' } },
    ])
    const fetchMock = mockFetchEmbeddings()

    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(2)
    expect(mockChatOnce).toHaveBeenCalledTimes(1)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input[0]).toContain('From Doc A[SOP]:')
    expect(body.input[0]).toContain('chunk one')
    expect(body.input[1]).toContain('From Doc A[SOP]:')
    expect(body.input[1]).toContain('chunk two')
  })

  test('LLM summary fails → falls back to static prefix without category', async () => {
    process.env.CONTEXTUAL_RETRIEVAL = 'true'
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    mockGetRoleLlmConfig.mockImplementation(async () => ({
      id: 'cfg-1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.test.com', apiKey: 'sk-test', model: 'gpt-4',
    }))
    mockChatOnce.mockImplementation(async () => { throw new Error('LLM unavailable') })
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: null } },
    ])
    const fetchMock = mockFetchEmbeddings()

    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(1)

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.input[0]).toContain('From Doc A:')
    expect(body.input[0]).not.toContain('[null]')
    expect(body.input[0]).toContain('chunk one')
  })
})

// ---------------------------------------------------------------------------
// embedCompanyDocuments — the batch entry point used by the re-index job
//
// Never executed by any test before this: document.findMany defaulted to [] so
// the loop body, the aggregation of per-document counts, and the provider/model
// "last non-null wins" rule were all unreachable.
// ---------------------------------------------------------------------------

describe('embedCompanyDocuments', () => {
  test('embeds every ready document when no documentId is given', async () => {
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    const dbMod = await import('@/lib/db')
    const seen: Array<Record<string, unknown>> = []
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async (args: Record<string, unknown>) => {
      seen.push(args)
      return [{ id: 'd1' }, { id: 'd2' }]
    }
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: null } },
    ])
    mockFetchEmbeddings()

    const result = await embedCompanyDocuments({})
    // Two documents, one chunk each → 2 embedded.
    expect(result.documents).toBe(2)
    expect(result.embedded).toBe(2)
    expect(result.skipped).toBe(0)
    // The query must be limited to ready documents: embedding a half-ingested
    // document would index a partial text.
    expect(seen[0].where).toEqual({ status: 'ready' })
    expect(seen[0].orderBy).toEqual({ createdAt: 'desc' })
  })

  test('a documentId narrows the query to that ONE document', async () => {
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    const dbMod = await import('@/lib/db')
    const seen: Array<Record<string, unknown>> = []
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async (args: Record<string, unknown>) => {
      seen.push(args)
      return [{ id: 'd9' }]
    }
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd9', name: 'Doc Z', category: null } },
    ])
    mockFetchEmbeddings()

    const result = await embedCompanyDocuments({ documentId: 'd9' })
    expect(result.documents).toBe(1)
    // Scoping matters: re-embedding one document must not re-embed the corpus.
    expect(seen[0].where).toEqual({ status: 'ready', id: 'd9' })
  })

  test('no ready documents reports zeros rather than throwing', async () => {
    const dbMod = await import('@/lib/db')
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async () => []
    const result = await embedCompanyDocuments({})
    expect(result).toEqual({ documents: 0, embedded: 0, skipped: 0, provider: null, model: null })
  })

  test('provider and model come back from the embedded documents', async () => {
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    const dbMod = await import('@/lib/db')
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async () => [{ id: 'd1' }]
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: null } },
    ])
    mockFetchEmbeddings()

    const result = await embedCompanyDocuments({})
    // The job reports which provider/model actually ran, so an operator can tell
    // which endpoint produced the vectors.
    //
    // MEASURED: these come from the DEDICATED embedding fields
    // (embeddingProvider / embeddingModel), NOT the generic provider/model on the
    // same config row. A deployment can embed through a different endpoint than
    // the one used for chat, so reporting the generic pair would misattribute
    // where the vectors came from.
    expect(result.provider).toBe(fakeEmbeddingConfig.embeddingProvider)
    expect(result.model).toBe(fakeEmbeddingConfig.embeddingModel)

  })

  test('a document with NO chunks counts as a document but embeds nothing', async () => {
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    const dbMod = await import('@/lib/db')
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async () => [{ id: 'd1' }]
    mockDocumentChunkFindMany.mockImplementation(async () => [])
    const result = await embedCompanyDocuments({})
    // documents reflects what was SCANNED, embedded what was written; conflating
    // them would hide a document whose chunks were never created.
    expect(result.documents).toBe(1)
    expect(result.embedded).toBe(0)
  })

  test('ONE failing chunk write does not abort the remaining chunks', async () => {
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    const dbMod = await import('@/lib/db')
    ;(dbMod.db.document as unknown as { findMany: unknown }).findMany = async () => [{ id: 'd1' }]
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: null } },
      { id: 'c2', content: 'chunk two', chunkIndex: 1, document: { id: 'd1', name: 'Doc A', category: null } },
      { id: 'c3', content: 'chunk three', chunkIndex: 2, document: { id: 'd1', name: 'Doc A', category: null } },
    ])
    mockFetchEmbeddings()
    let call = 0
    mockExecuteRaw.mockImplementation(async () => {
      call += 1
      // Second chunk fails to persist. Before allSettled this rejected the whole
      // ingestion and left every LATER chunk unembedded.
      if (call === 2) throw new Error('deadlock detected')
      return 1
    })

    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// canWriteVectorColumn / getEmbeddingColumnDimension — the dimension gate
//
// Reached through the public embedDocumentChunks path with a mocked pg_attribute
// probe. This gate decides whether a vector is written to the pgvector column or
// only to embeddingJson; getting it wrong either loses pgvector search silently
// or writes a vector of the wrong width into the column.
// ---------------------------------------------------------------------------

describe('the embedding column dimension gate', () => {
  // A single "current column" value rather than a stack the tests push onto: the
  // cached dimension is module-level state, so a test that pushed onto a shared
  // array leaked its answer into the next test and the gate tests failed only when
  // run after the matching-width one. Setting it here makes each test independent.
  let coltype: string | null = null
  let probeThrows = false

  beforeEach(() => {
    // mockQueryRaw is the mock the mock.module('@/lib/db') factory actually wires
    // in. Overwriting db.$queryRaw on the imported namespace did nothing here —
    // the module under test captured its own binding at import time.
    coltype = null
    probeThrows = false
    mockQueryRaw.mockImplementation(async () => {
      if (probeThrows) throw new Error('relation does not exist')
      return coltype === null ? [] : [{ coltype }]
    })
    resetEmbeddingColumnDimension()
    mockLlmConfigFindFirst.mockImplementation(async () => fakeEmbeddingConfig)
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'chunk one', chunkIndex: 0, document: { id: 'd1', name: 'Doc A', category: null } },
    ])
  })

  const oneChunk = () => mockFetchEmbeddings()

  // The ONLY difference between the two branches is that the vector branch also
  // sets `"embedding" = <literal>::vector`. Both branches set embeddingJson, so
  // asserting on embeddingJson does not tell them apart — my first version of
  // this test did exactly that and a control that disabled the gate stayed green.
  // Counts only the calls made SINCE this point. mockExecuteRaw is shared across
  // the whole file and is never cleared, so scanning all of .calls picked up the
  // earlier embedCompanyDocuments tests and this gate could never read false.
  const vectorWritesSince = (from: number) =>
    mockExecuteRaw.mock.calls.slice(from).some((c) => c.some((a) => String(a).includes('::vector')))
  let callBase = 0

  beforeEach(() => { callBase = mockExecuteRaw.mock.calls.length })

  test('a MATCHING column width writes the vector column', async () => {
    // The mocked embedding vectors are 3-dimensional.
    coltype = 'vector(3)'
    oneChunk()
    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(1)
    expect(vectorWritesSince(callBase)).toBe(true)
  })

  test('a MISMATCHED column width refuses the vector column but still stores JSON', async () => {
    coltype = 'vector(1536)'
    oneChunk()
    const result = await embedDocumentChunks({ documentId: 'd1' })
    // The embedding is still recorded — retrieval falls back to the cosine path —
    // and the row is counted as embedded rather than skipped.
    expect(result.embedded).toBe(1)
    // Crucially the vector column is NOT written: a 3-dim vector into vector(1536)
    // would be rejected by Postgres on every chunk.
    expect(vectorWritesSince(callBase)).toBe(false)
  })

  test('an UNKNOWN column (probe returns no row) refuses the vector column', async () => {
    // No pg_attribute row means the column does not exist; writing to it would
    // fail every single chunk write.
    coltype = null
    oneChunk()
    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(1)
    expect(vectorWritesSince(callBase)).toBe(false)
  })

  test('a DB error during the probe does not disable embedding', async () => {
    probeThrows = true
    oneChunk()
    // A transient probe failure must not lose the vectors: they still land in
    // embeddingJson.
    const result = await embedDocumentChunks({ documentId: 'd1' })
    expect(result.embedded).toBe(1)
    expect(vectorWritesSince(callBase)).toBe(false)
  })
})
