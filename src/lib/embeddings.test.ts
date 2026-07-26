import { describe, expect, test, mock, afterEach } from 'bun:test'

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: { findFirst: async () => null },
    documentChunk: { findMany: async () => [] },
    document: { findMany: async () => [] },
  },
}))

import {
  combineHybridScore,
  cosineSimilarity,
  embedTexts,
  getEmbeddingRuntimeConfig,
  parseEmbeddingJson,
  parseEmbeddingResponse,
} from './embeddings'

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

  test('HTTP error → throws with status code', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 500 } as Response),
    ) as unknown as typeof fetch

    await expect(embedTexts(cfg, ['hi'])).rejects.toThrow('500')
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
