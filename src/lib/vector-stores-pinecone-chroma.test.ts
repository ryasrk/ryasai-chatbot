import { describe, expect, test, mock, afterEach, beforeEach } from 'bun:test'

const mockFindFirst = mock(async () => null as unknown)

mock.module('@/lib/db', () => ({
  db: {
    vectorStoreConfig: { findFirst: mockFindFirst },
  },
}))

import {
  buildChromaSearchBody,
  buildPineconeSearchBody,
  buildVectorPoint,
  ensureVectorCollection,
  parseChromaSearchResponse,
  parsePineconeSearchResponse,
  resetEnsuredCollections,
  searchVectorStore,
  upsertVectorPoints,
  type VectorStoreRuntimeConfig,
} from './vector-stores'

const originalFetch = global.fetch
let lastFetch: { url: string; init: RequestInit } | null = null

function fakeFetch(status = 200, body: unknown = {}) {
  lastFetch = null
  global.fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
    lastFetch = { url: String(url), init }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

afterEach(() => { global.fetch = originalFetch })
beforeEach(() => {
  mockFindFirst.mockImplementation(async () => null)
  resetEnsuredCollections()
})

const pineconeConfig: VectorStoreRuntimeConfig = {
  provider: 'PINECONE',
  baseUrl: 'https://my-index-myproj.svc.us-east1-aws.pinecone.io',
  apiKey: 'pc-secret',
  collectionName: 'ryasai_chunks',
  vectorSize: 1536,
  distance: 'Cosine',
}

const chromaConfig: VectorStoreRuntimeConfig = {
  provider: 'CHROMA',
  baseUrl: 'http://localhost:8000',
  apiKey: 'chroma-token',
  collectionName: 'ryasai_chunks',
  vectorSize: 1536,
  distance: 'Cosine',
}

// ---------------------------------------------------------------------------
// request/response shape helpers
// ---------------------------------------------------------------------------

describe('Pinecone request builders + parsers', () => {
  test('builds query body with metadata include', () => {
    expect(buildPineconeSearchBody([0.1, 0.2], 5)).toEqual({
      vector: [0.1, 0.2],
      topK: 5,
      includeMetadata: true,
    })
  })

  test('parses matches with metadata.chunkId', () => {
    const hits = parsePineconeSearchResponse({
      matches: [
        { id: 'abc', score: 0.91, metadata: { chunkId: 'chunk_1' } },
        { id: 'def', score: 0.4, metadata: { chunkId: 'chunk_2' } },
      ],
    })
    expect(hits).toEqual([
      { chunkId: 'chunk_1', score: 0.91 },
      { chunkId: 'chunk_2', score: 0.4 },
    ])
  })

  test('drops hits without chunkId metadata', () => {
    const hits = parsePineconeSearchResponse({
      matches: [
        { id: 'abc', score: 0.9, metadata: {} },
        { id: 'def', score: 0.4 },
      ],
    })
    expect(hits).toEqual([])
  })

  test('handles empty/missing matches', () => {
    expect(parsePineconeSearchResponse({ matches: [] })).toEqual([])
    expect(parsePineconeSearchResponse({})).toEqual([])
    expect(parsePineconeSearchResponse(null)).toEqual([])
  })
})

describe('Chroma request builders + parsers', () => {
  test('builds query body with plural embeddings + include', () => {
    expect(buildChromaSearchBody([0.5, 0.6], 3)).toEqual({
      query_embeddings: [[0.5, 0.6]],
      n_results: 3,
      include: ['metadatas', 'documents', 'distances'],
    })
  })

  test('parses columnar response and converts distance → similarity', () => {
    // distances: 0.0 (identical) → 1.0 similarity; 0.4 → 0.6
    const hits = parseChromaSearchResponse({
      ids: [['c1', 'c2']],
      metadatas: [[{ chunkId: 'chunk_1' }, { chunkId: 'chunk_2' }]],
      distances: [[0.0, 0.4]],
    })
    expect(hits).toEqual([
      { chunkId: 'chunk_1', score: 1 },
      { chunkId: 'chunk_2', score: 0.6 },
    ])
  })

  test('falls back to the raw id when metadata lacks chunkId', () => {
    const hits = parseChromaSearchResponse({
      ids: [['c1']],
      metadatas: [[{}]],
      distances: [[0.1]],
    })
    expect(hits).toEqual([{ chunkId: 'c1', score: 0.9 }])
  })

  test('handles empty/missing columnar arrays', () => {
    expect(parseChromaSearchResponse({ ids: [] })).toEqual([])
    expect(parseChromaSearchResponse({ ids: [[]] })).toEqual([])
    expect(parseChromaSearchResponse({})).toEqual([])
    expect(parseChromaSearchResponse(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// transport — auth headers, URLs, upsert shapes (mocked fetch)
// ---------------------------------------------------------------------------

describe('Pinecone transport', () => {
  test('search uses Api-Key header (not Bearer) and /query path', async () => {
    fakeFetch(200, { matches: [{ id: 'x', score: 0.9, metadata: { chunkId: 'chunk_9' } }] })
    const hits = await searchVectorStore({ config: pineconeConfig, vector: [0.1], limit: 4 })

    expect(hits).toEqual([{ chunkId: 'chunk_9', score: 0.9 }])
    expect(lastFetch!.url).toBe('https://my-index-myproj.svc.us-east1-aws.pinecone.io/query')
    const headers = lastFetch!.init.headers as Record<string, string>
    expect(headers['Api-Key']).toBe('pc-secret')
    expect(headers.Authorization).toBeUndefined()
  })

  test('upsert sends vectors array with values + metadata', async () => {
    fakeFetch(200, { upsertedCount: 2 })
    await upsertVectorPoints(pineconeConfig, [
      buildVectorPoint({ chunkId: 'c1', vector: [1, 2], payload: { documentId: 'd1', category: null } }),
    ])

    expect(lastFetch!.url).toContain('/vectors/upsert')
    const body = JSON.parse(String(lastFetch!.init.body))
    expect(body.vectors).toHaveLength(1)
    expect(body.vectors[0]).toMatchObject({
      id: expect.any(String),
      values: [1, 2],
      metadata: expect.objectContaining({ chunkId: 'c1' }),
    })
  })

  test('ensure: existing index (describe 200) does not throw', async () => {
    fakeFetch(200, { namespaces: {} })
    await ensureVectorCollection(pineconeConfig)
    expect(lastFetch!.url).toContain('/describe_index_stats')
  })

  test('ensure: 404 gives the actionable create-index error', async () => {
    fakeFetch(404, {})
    await expect(ensureVectorCollection(pineconeConfig)).rejects.toThrow(/Create the index/)
  })

  test('ensure is memoized — second call does not fetch', async () => {
    fakeFetch(200, { namespaces: {} })
    await ensureVectorCollection(pineconeConfig)
    fakeFetch(200, { namespaces: {} })
    await ensureVectorCollection(pineconeConfig)
    // memoized: fetch was replaced but never invoked
    expect(lastFetch).toBeNull()
  })
})

describe('Chroma transport', () => {
  test('search uses X-Chroma-Token and the v1 query path', async () => {
    fakeFetch(200, { ids: [['c1']], metadatas: [[{ chunkId: 'chunk_1' }]], distances: [[0.1]] })
    const hits = await searchVectorStore({ config: chromaConfig, vector: [0.2], limit: 2 })

    expect(hits).toEqual([{ chunkId: 'chunk_1', score: 0.9 }])
    expect(lastFetch!.url).toBe('http://localhost:8000/api/v1/collections/ryasai_chunks/query')
    const headers = lastFetch!.init.headers as Record<string, string>
    expect(headers['X-Chroma-Token']).toBe('chroma-token')
  })

  test('upsert strips null payload values (Chroma rejects null metadata)', async () => {
    fakeFetch(200, {})
    await upsertVectorPoints(chromaConfig, [
      buildVectorPoint({ chunkId: 'c1', vector: [0.3], payload: { documentId: 'd1', category: null as unknown as string } }),
    ])

    expect(lastFetch!.url).toContain('/api/v1/collections/ryasai_chunks/upsert')
    const body = JSON.parse(String(lastFetch!.init.body))
    expect(body.metadatas[0]).toEqual({ chunkId: 'c1', documentId: 'd1' })
    expect('category' in body.metadatas[0]).toBe(false)
  })

  test('ensure creates the collection with get_or_create + cosine space', async () => {
    fakeFetch(200, { name: 'ryasai_chunks' })
    await ensureVectorCollection(chromaConfig)

    expect(lastFetch!.url).toBe('http://localhost:8000/api/v1/collections/ryasai_chunks')
    expect(lastFetch!.init.method).toBe('POST')
    const body = JSON.parse(String(lastFetch!.init.body))
    expect(body.get_or_create).toBe(true)
    expect(body.metadata.hnsw.space).toBe('cosine')
  })

  test('euclidean distance maps to l2 space', async () => {
    fakeFetch(200, { name: 'x' })
    await ensureVectorCollection({ ...chromaConfig, distance: 'Euclidean' })
    const body = JSON.parse(String(lastFetch!.init.body))
    expect(body.metadata.hnsw.space).toBe('l2')
  })
})
