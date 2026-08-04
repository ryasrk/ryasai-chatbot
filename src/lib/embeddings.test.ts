import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'

// --- Configurable DB mock ---
const mockLlmConfigFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(async () => null)
const mockDocumentChunkFindMany = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(async () => [])
const mockExecuteRaw = mock<(...args: unknown[]) => Promise<number>>(async () => 1)

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: { findFirst: mockLlmConfigFindFirst },
    documentChunk: { findMany: mockDocumentChunkFindMany },
    document: { findMany: async () => [] },
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
  embedDocumentChunks,
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
  parseEmbeddingResponse,
} from './embeddings'

// Reset mocks to defaults before each test
beforeEach(() => {
  mockLlmConfigFindFirst.mockImplementation(async () => null)
  mockDocumentChunkFindMany.mockImplementation(async () => [])
  mockExecuteRaw.mockImplementation(async () => 1)
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
