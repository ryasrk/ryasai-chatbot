import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'

const mockFindFirst = mock(async () => null as unknown)

mock.module('@/lib/db', () => ({
  db: {
    vectorStoreConfig: { findFirst: mockFindFirst },
  },
}))

import {
  buildMilvusSearchBody,
  buildQdrantSearchBody,
  buildVectorPoint,
  ensureVectorCollection,
  getVectorStoreRuntimeConfig,
  parseMilvusSearchResponse,
  parseQdrantSearchResponse,
  searchVectorStore,
  upsertVectorPoints,
  vectorPointId,
  type VectorPoint,
  type VectorStoreRuntimeConfig,
} from './vector-stores'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})
beforeEach(() => {
  mockFindFirst.mockImplementation(async () => null)
})

describe('vector store helpers', () => {
  test('builds stable point ids and payloads', () => {
    const point = buildVectorPoint({
      chunkId: 'chunk_1',
      vector: [0.1, 0.2],
      payload: { documentId: 'doc_1' },
    })

    expect(vectorPointId('chunk_1')).toMatch(/^[0-9a-f-]{36}$/)
    expect(point.payload.chunkId).toBe('chunk_1')
  })

  test('vectorPointId is deterministic (same input → same output)', () => {
    expect(vectorPointId('test-chunk')).toBe(vectorPointId('test-chunk'))
  })

  test('vectorPointId differs for different inputs', () => {
    expect(vectorPointId('a')).not.toBe(vectorPointId('b'))
  })

  test('builds Qdrant and Milvus search bodies', () => {
    expect(buildQdrantSearchBody([1, 2], 3)).toEqual({
      vector: [1, 2],
      limit: 3,
      with_payload: true,
    })

    expect(buildMilvusSearchBody('chunks', [1, 2], 3)).toMatchObject({
      collectionName: 'chunks',
      data: [[1, 2]],
      limit: 3,
      outputFields: ['chunkId'],
    })
  })

  test('parses Qdrant search response into chunk scores', () => {
    expect(
      parseQdrantSearchResponse({
        result: [{ score: 0.8, payload: { chunkId: 'chunk_1' } }],
      }),
    ).toEqual([{ chunkId: 'chunk_1', score: 0.8 }])
  })

  test('parses Milvus search response into chunk scores', () => {
    expect(
      parseMilvusSearchResponse({
        data: [{ score: 0.7, entity: { chunkId: 'chunk_2' } }],
      }),
    ).toEqual([{ chunkId: 'chunk_2', score: 0.7 }])
  })
})

describe('parseQdrantSearchResponse — edge cases', () => {
  test('empty result array → empty hits', () => {
    expect(parseQdrantSearchResponse({ result: [] })).toEqual([])
  })

  test('missing result field → empty', () => {
    expect(parseQdrantSearchResponse({})).toEqual([])
  })

  test('null payload → empty', () => {
    expect(parseQdrantSearchResponse(null)).toEqual([])
  })

  test('non-array result → empty', () => {
    expect(parseQdrantSearchResponse({ result: 'not-array' })).toEqual([])
  })

  test('missing chunkId in payload → filtered out', () => {
    expect(
      parseQdrantSearchResponse({
        result: [{ score: 0.9, payload: {} }],
      }),
    ).toEqual([])
  })

  test('missing score → defaults to 0', () => {
    expect(
      parseQdrantSearchResponse({
        result: [{ payload: { chunkId: 'c1' } }],
      }),
    ).toEqual([{ chunkId: 'c1', score: 0 }])
  })

  test('multiple hits → all parsed', () => {
    expect(
      parseQdrantSearchResponse({
        result: [
          { score: 0.9, payload: { chunkId: 'a' } },
          { score: 0.5, payload: { chunkId: 'b' } },
        ],
      }),
    ).toEqual([
      { chunkId: 'a', score: 0.9 },
      { chunkId: 'b', score: 0.5 },
    ])
  })
})

describe('parseMilvusSearchResponse — edge cases', () => {
  test('empty data → empty hits', () => {
    expect(parseMilvusSearchResponse({ data: [] })).toEqual([])
  })

  test('missing data field → empty', () => {
    expect(parseMilvusSearchResponse({})).toEqual([])
  })

  test('null → empty', () => {
    expect(parseMilvusSearchResponse(null)).toEqual([])
  })

  test('missing chunkId → filtered out', () => {
    expect(
      parseMilvusSearchResponse({
        data: [{ score: 0.9, entity: {} }],
      }),
    ).toEqual([])
  })

  test('uses distance field as score when score absent', () => {
    expect(
      parseMilvusSearchResponse({
        data: [{ distance: 0.85, entity: { chunkId: 'c1' } }],
      }),
    ).toEqual([{ chunkId: 'c1', score: 0.85 }])
  })

  test('entity fallback to row itself', () => {
    expect(
      parseMilvusSearchResponse({
        data: [{ score: 0.5, chunkId: 'c2' }],
      }),
    ).toEqual([{ chunkId: 'c2', score: 0.5 }])
  })
})

const qdrantConfig: VectorStoreRuntimeConfig = {
  provider: 'QDRANT',
  baseUrl: 'https://q.example.com',
  apiKey: 'q-key',
  collectionName: 'test-col',
  vectorSize: 1536,
  distance: 'Cosine',
}

const milvusConfig: VectorStoreRuntimeConfig = {
  provider: 'MILVUS',
  baseUrl: 'https://m.example.com',
  apiKey: 'm-key',
  collectionName: 'milvus-col',
  vectorSize: 1536,
  distance: 'Cosine',
}

describe('getVectorStoreRuntimeConfig', () => {
  test('no config in DB → returns null', async () => {
    mockFindFirst.mockImplementationOnce(async () => null)
    expect(await getVectorStoreRuntimeConfig()).toBeNull()
  })

  test('INTERNAL provider → returns null', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'INTERNAL',
      baseUrl: '',
      collectionName: '',
      vectorSize: 1536,
      distance: 'Cosine',
      encryptedApiKey: null,
    }))
    expect(await getVectorStoreRuntimeConfig()).toBeNull()
  })

  test('QDRANT provider → returns config with decrypted apiKey', async () => {
    const { encryptConfig } = await import('./crypto')
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'QDRANT',
      baseUrl: 'https://q.example.com',
      collectionName: 'my-col',
      vectorSize: 1536,
      distance: 'Cosine',
      encryptedApiKey: encryptConfig({ apiKey: 'secret-key' }),
    }))

    const cfg = await getVectorStoreRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('QDRANT')
    expect(cfg!.apiKey).toBe('secret-key')
    expect(cfg!.collectionName).toBe('my-col')
  })

  test('QDRANT_CLOUD provider → normalized to QDRANT', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'QDRANT_CLOUD',
      baseUrl: 'https://q.cloud.com',
      collectionName: 'cloud-col',
      vectorSize: 768,
      distance: 'Cosine',
      encryptedApiKey: null,
    }))

    const cfg = await getVectorStoreRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('QDRANT')
  })

  test('MILVUS provider → returns config', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'MILVUS',
      baseUrl: 'https://m.example.com',
      collectionName: 'milvus-col',
      vectorSize: 1536,
      distance: 'IP',
      encryptedApiKey: null,
    }))

    const cfg = await getVectorStoreRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.provider).toBe('MILVUS')
  })

  test('missing baseUrl → returns null', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'QDRANT',
      baseUrl: '',
      collectionName: 'col',
      vectorSize: 1536,
      distance: 'Cosine',
      encryptedApiKey: null,
    }))
    expect(await getVectorStoreRuntimeConfig()).toBeNull()
  })

  test('missing collectionName → returns null', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'QDRANT',
      baseUrl: 'https://q.example.com',
      collectionName: '',
      vectorSize: 1536,
      distance: 'Cosine',
      encryptedApiKey: null,
    }))
    expect(await getVectorStoreRuntimeConfig()).toBeNull()
  })

  test('decryption failure → apiKey defaults to empty string', async () => {
    mockFindFirst.mockImplementationOnce(async () => ({
      provider: 'QDRANT',
      baseUrl: 'https://q.example.com',
      collectionName: 'col',
      vectorSize: 1536,
      distance: 'Cosine',
      encryptedApiKey: 'not-valid-hex',
    }))

    const cfg = await getVectorStoreRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(cfg!.apiKey).toBe('')
  })
})

describe('ensureVectorCollection', () => {
  test('QDRANT → PUT /collections/:name', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await ensureVectorCollection(qdrantConfig)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/collections/test-col')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body as string)
    expect(body.vectors.size).toBe(1536)
  })

  test('MILVUS → POST /v2/vectordb/collections/create', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await ensureVectorCollection(milvusConfig)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v2/vectordb/collections/create')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.collectionName).toBe('milvus-col')
    expect(body.dimension).toBe(1536)
  })

  test('MILVUS collection create failure → swallowed (no throw)', async () => {
    global.fetch = mock(() => Promise.reject(new Error('network'))) as unknown as typeof fetch
    await expect(ensureVectorCollection(milvusConfig)).resolves.toBeUndefined()
  })

  test('INTERNAL → no fetch call', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await ensureVectorCollection({ ...qdrantConfig, provider: 'INTERNAL' })
    expect(fetchMock.mock.calls.length).toBe(0)
  })
})

describe('upsertVectorPoints', () => {
  test('empty points → no fetch call', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await upsertVectorPoints(qdrantConfig, [])
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  test('QDRANT → PUT /collections/:name/points with wait=true', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const points: VectorPoint[] = [
      { id: 'pt-1', vector: [0.1], payload: { chunkId: 'c1' } },
    ]
    await upsertVectorPoints(qdrantConfig, points)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/points?wait=true')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body as string)
    expect(body.points).toHaveLength(1)
    expect(body.points[0].id).toBe('pt-1')
  })

  test('MILVUS → POST /v2/vectordb/entities/insert', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => ({}) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const points: VectorPoint[] = [
      { id: 'pt-2', vector: [0.2], payload: { chunkId: 'c2' } },
    ]
    await upsertVectorPoints(milvusConfig, points)

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/v2/vectordb/entities/insert')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].chunkId).toBe('c2')
  })
})

describe('searchVectorStore', () => {
  test('QDRANT → POST search, returns parsed hits', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ result: [{ score: 0.9, payload: { chunkId: 'hit-1' } }] }),
      } as Response),
    ) as unknown as typeof fetch

    const hits = await searchVectorStore({ config: qdrantConfig, vector: [0.1, 0.2], limit: 5 })
    expect(hits).toEqual([{ chunkId: 'hit-1', score: 0.9 }])
  })

  test('MILVUS → POST search, returns parsed hits', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ data: [{ score: 0.8, entity: { chunkId: 'hit-2' } }] }),
      } as Response),
    ) as unknown as typeof fetch

    const hits = await searchVectorStore({ config: milvusConfig, vector: [0.1, 0.2], limit: 3 })
    expect(hits).toEqual([{ chunkId: 'hit-2', score: 0.8 }])
  })

  test('unknown provider → returns empty array', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const hits = await searchVectorStore({
      config: { ...qdrantConfig, provider: 'INTERNAL' },
      vector: [0.1],
      limit: 5,
    })
    expect(hits).toEqual([])
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  test('HTTP error → throws with status code', async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 503 } as Response)) as unknown as typeof fetch

    await expect(
      searchVectorStore({ config: qdrantConfig, vector: [0.1], limit: 5 }),
    ).rejects.toThrow('503')
  })

  test('apiKey → sends Authorization + api-key headers', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, json: async () => ({ result: [] }) } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await searchVectorStore({ config: qdrantConfig, vector: [0.1], limit: 5 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer q-key')
    expect(headers['api-key']).toBe('q-key')
  })
})
