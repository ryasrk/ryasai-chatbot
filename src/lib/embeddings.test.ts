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
// Swappable so a test can simulate the NO-context case, which is the whole point
// of the refusal on lines 99-102. Hardcoding 'test-org' here left that guard --
// a tenant-isolation gate -- permanently unexecuted.
const orgContext = { value: 'test-org' as string | undefined }
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => orgContext.value,
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
// Swappable: a version that always succeeds left the catch on lines 120-121
// unexecuted, so a rotated key's degradation path was never proven.
const decryptBehaviour = { mode: 'ok' as 'ok' | 'throw' }
mock.module('@/lib/crypto', () => ({
  decryptConfig: () => {
    if (decryptBehaviour.mode === 'throw') throw new Error('bad ciphertext')
    return { apiKey: 'test-key' }
  },
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
  orgContext.value = 'test-org'
  decryptBehaviour.mode = 'ok'
  // mockImplementation does NOT clear the recorded call list, so an assertion like
  // `not.toHaveBeenCalled()` would otherwise see a previous test's calls.
  mockLlmConfigFindFirst.mockClear()
  mockGetRoleLlmConfig.mockClear()
  mockChatOnce.mockClear()
  // The write mocks accumulate across tests too, so a helper reading
  // .mock.calls would see a PREVIOUS test's prefix and assert on the wrong value.
  mockExecuteRaw.mockClear()
  mockQueryRaw.mockClear()
})

// The prefix written to DocumentChunk.contextPrefix, extracted from the mocked
// $executeRaw tagged-template call (bound values follow the template strings).
function writtenPrefixes(): string[] {
  const out: string[] = []
  for (const call of mockExecuteRaw.mock.calls as unknown as unknown[][]) {
    for (const arg of call.slice(1)) {
      if (typeof arg === 'string' && arg.startsWith('From ')) out.push(arg)
    }
  }
  return out
}

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

describe('getEmbeddingRuntimeConfig — the tenant-isolation refusal', () => {
  // Lines 99-102. This guard was added after a real incident (trial/55): a
  // context-free findFirst resolved ANOTHER tenant's baseUrl/model/key. It had
  // never been executed because the test mocked getOrgContext to a constant. A
  // security guard with no test is a guard that can be deleted without anything
  // going red.

  test('WITHOUT an org context the config is REFUSED, not silently borrowed', async () => {
    orgContext.value = undefined
    // A row IS present. This is the dangerous case: if the guard were dropped, the
    // caller would happily embed using this tenant's credentials.
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.openai.com/v1',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingModel: 'text-embedding-3-small',
      encryptedEmbeddingApiKey: 'enc',
    }))
    const cfg = await getEmbeddingRuntimeConfig()
    // null, not someone's config. Callers already treat null as "cannot embed".
    expect(cfg).toBeNull()
    // And the DB was never even consulted for that row.
    expect(mockLlmConfigFindFirst).not.toHaveBeenCalled()
  })

  test('WITH an org context the same row IS resolved (the guard is not a blanket deny)', async () => {
    // The inverse, so the test above cannot pass merely because resolution is
    // broken for every input.
    orgContext.value = 'test-org'
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.openai.com/v1',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingModel: 'text-embedding-3-small',
      encryptedEmbeddingApiKey: 'enc',
    }))
    const cfg = await getEmbeddingRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg?.model).toBe('text-embedding-3-small')
  })
})

describe('getEmbeddingRuntimeConfig — an undecryptable key does not crash the caller', () => {
  test('a DECRYPT failure leaves the key empty and the config is refused, not thrown', async () => {
    // Line 120-121. A rotated or corrupt ENCRYPTION_SECRET_KEY must not take down
    // every embedding call with an unhandled throw; it degrades to "cannot embed",
    // which the caller already handles, and logs the cause.
    orgContext.value = 'test-org'
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.openai.com/v1',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.openai.com/v1',
      embeddingModel: 'text-embedding-3-small',
      encryptedEmbeddingApiKey: 'garbage',
    }))
    decryptBehaviour.mode = 'throw'
    try {
      const cfg = await getEmbeddingRuntimeConfig()
      // No key on a non-OLLAMA provider means null (line 125), NOT a throw.
      expect(cfg).toBeNull()
    } finally {
      decryptBehaviour.mode = 'ok'
    }
  })
})

describe('embedTexts — network failure recovery', () => {
  // Lines 175-177. A fetch-level rejection (DNS, reset, timeout) is transient and
  // must be RETRIED with the last error preserved. Without the retry a single blip
  // fails the whole batch; without preserving the error the throw at the end would
  // be a generic message that hides the real cause.
  const config = {
    provider: 'OPENAI_COMPATIBLE' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'text-embedding-3-small',
    apiKey: 'k',
  }

  test('a network rejection is retried and the LAST error is preserved', async () => {
    let calls = 0
    global.fetch = (async () => {
      calls++
      // A non-Error rejection too: `throw new Error(...)` is not the only shape a
      // host can produce, and the catch must stringify it rather than store
      // undefined (`lastError = e instanceof Error ? e : new Error(String(e))`).
      if (calls === 1) throw 'socket hang up'
      throw new Error('ECONNREFUSED 127.0.0.1:443')
    }) as unknown as typeof fetch

    await expect(embedTexts(config, ['hello'])).rejects.toThrow('ECONNREFUSED')
    // Every attempt was used, not just the first.
    expect(calls).toBeGreaterThan(1)
  })

  test('a transient failure followed by success returns the vectors', async () => {
    // The retry must actually be able to RECOVER, otherwise it only delays the
    // failure. First call rejects at the network level, second returns a payload.
    let calls = 0
    global.fetch = (async () => {
      calls++
      if (calls === 1) throw new Error('socket hang up')
      return new Response(
        JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const out = await embedTexts(config, ['hello'])
    expect(out).toEqual([[1, 2, 3]])
    expect(calls).toBe(2)
  })
})

describe('embedTexts — inconsistent vectors are refused, not returned', () => {
  // Line 218. Downstream pairs vectors[index] with chunk[index], so a ragged
  // response would silently attach the wrong vector to the wrong chunk -- a
  // retrieval bug with no error anywhere.
  const config = {
    provider: 'OPENAI_COMPATIBLE' as const,
    baseUrl: 'https://api.example.com/v1',
    model: 'text-embedding-3-small',
    apiKey: 'k',
  }

  test('a RAGGED dimension is rejected', async () => {
    global.fetch = (async () => new Response(
      JSON.stringify({ data: [{ embedding: [1, 2, 3] }, { embedding: [1, 2] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    await expect(embedTexts(config, ['a', 'b'])).rejects.toThrow('inconsistent dimensions')
  })

  test('an EMPTY vector is rejected — by the COUNT guard, not the dimension one', async () => {
    // Measured, and it surprised me: an empty embedding is dropped by parse-time
    // filtering BEFORE the dimension check, so the response arrives as 1 vector for
    // 2 inputs and the COUNT guard (line 216) fires first. Asserting
    // 'inconsistent dimensions' here failed -- the code was right, my assumption
    // about WHICH layer catches it was wrong. Both layers refuse, which is the
    // behaviour that matters, so the assertion names the count guard explicitly
    // instead of passing for the wrong reason.
    global.fetch = (async () => new Response(
      JSON.stringify({ data: [{ embedding: [1, 2, 3] }, { embedding: [] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    await expect(embedTexts(config, ['a', 'b'])).rejects.toThrow('refusing to misalign')
  })

  test('a CONSISTENT response is accepted (the inverse)', async () => {
    // So the tests above cannot pass merely because every multi-vector response is
    // rejected.
    global.fetch = (async () => new Response(
      JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    const out = await embedTexts(config, ['a', 'b'])
    expect(out).toEqual([[1, 2], [3, 4]])
  })
})

describe('parseEmbeddingResponse — an Ollama response with NO embeddings key', () => {
  test('a model-not-pulled error body yields no vectors instead of throwing', async () => {
    // Line 78. Ollama reports "model not found" as a 200 with an `error` field and
    // no embedding array. Returning [] lets the caller fail on the count guard with
    // a message about the response; throwing a TypeError here would surface as an
    // opaque crash instead of a diagnosable empty result.
    expect(parseEmbeddingResponse('OLLAMA', { error: 'model "x" not found' })).toEqual([])
    expect(parseEmbeddingResponse('OLLAMA', {})).toEqual([])
    expect(parseEmbeddingResponse('OLLAMA', null)).toEqual([])
  })
})

describe('getEmbeddingRuntimeConfig — OLLAMA needs no API key', () => {
  test('an Ollama config with NO key is still usable (the key check is provider-gated)', async () => {
    // The `provider !== 'OLLAMA' && !apiKey.trim()` guard means a keyless local
    // Ollama must NOT be refused; treating it like a hosted provider would make
    // local embeddings impossible.
    orgContext.value = 'test-org'
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OLLAMA',
      baseUrl: 'http://localhost:11434',
      embeddingProvider: 'OLLAMA',
      embeddingBaseUrl: 'http://localhost:11434',
      embeddingModel: 'nomic-embed-text',
      // No encrypted key at all.
    }))
    const cfg = await getEmbeddingRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg?.apiKey).toBe('')
  })
})

describe('embedDocumentChunks — contextual retrieval with no LLM configured', () => {
  // Line 357. This is the branch taken on an install whose query-role LLM is not
  // configured. The prefix must fall back to the static `From <doc>:` form, NOT be
  // skipped -- losing the prefix entirely would strip the document attribution from
  // every chunk and quietly degrade retrieval.
  test('without a query-role config the STATIC prefix is still applied', async () => {
    // CONTEXTUAL_RETRIEVAL must be ON and at least one chunk must exist, or the
    // whole block is skipped and the branch under test never runs. My first version
    // supplied no chunks, so it exercised the outer guard instead -- the missing
    // line stayed uncovered and the test still passed.
    process.env.CONTEXTUAL_RETRIEVAL = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => null)
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'body text', document: { name: 'Handbook', category: 'HR' } },
    ])
    mockQueryRaw.mockImplementation(async () => [])
    // Embeddings resolve so the function gets past its own config guard.
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.example.com/v1',
      embeddingModel: 'text-embedding-3-small',
      encryptedEmbeddingApiKey: 'enc',
    }))
    global.fetch = (async () => new Response(
      JSON.stringify({ data: [{ embedding: [1, 2] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    try {
      await embedDocumentChunks({ documentId: 'doc-1' })
      // No summariser was available, so nothing was asked of the LLM -- and the
      // static prefix path is the one that ran.
      expect(mockChatOnce).not.toHaveBeenCalled()
      // The PREFIX ITSELF must reach the write. Asserting only that the LLM was not
      // called proved nothing about the fallback: deleting the `else` branch kept
      // this test green. $executeRaw is tagged-template, so the bound values are the
      // trailing arguments; the prefix is the string carrying 'From '.
      const written = writtenPrefixes()
      expect(written.length).toBeGreaterThan(0)
      // The static form, with NO summary and NO category suffix.
      expect(written[0]).toBe('From Handbook:' + String.fromCharCode(10, 10))
    } finally {
      delete process.env.CONTEXTUAL_RETRIEVAL
    }
  })

  test('WITH a query-role config the LLM summary IS requested', async () => {
    // The inverse arm, so the test above cannot pass merely because the summariser
    // is never called on any path.
    process.env.CONTEXTUAL_RETRIEVAL = 'true'
    mockGetRoleLlmConfig.mockImplementation(async () => ({ baseUrl: 'https://llm', apiKey: 'k', model: 'm', provider: 'OPENAI_COMPATIBLE' }))
    mockDocumentChunkFindMany.mockImplementation(async () => [
      { id: 'c1', content: 'body text', document: { name: 'Handbook', category: 'HR' } },
    ])
    mockQueryRaw.mockImplementation(async () => [])
    mockLlmConfigFindFirst.mockImplementation(async () => ({
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.example.com/v1',
      embeddingModel: 'text-embedding-3-small',
      encryptedEmbeddingApiKey: 'enc',
    }))
    global.fetch = (async () => new Response(
      JSON.stringify({ data: [{ embedding: [1, 2] }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    try {
      await embedDocumentChunks({ documentId: 'doc-1' })
      expect(mockChatOnce).toHaveBeenCalledTimes(1)
      // The SUMMARISED prefix, including the category, is what gets written.
      const written = writtenPrefixes()
      expect(written[0]).toContain('A summary of the document.')
      expect(written[0]).toContain('[HR]')
    } finally {
      delete process.env.CONTEXTUAL_RETRIEVAL
    }
  })
})
