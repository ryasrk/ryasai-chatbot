import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { RetrievedChunk } from '@/lib/rag'

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))

import { crossEncoderRerank } from './reranker'

const originalFetch = global.fetch

function makeChunk(id: string, content: string, score = 1): RetrievedChunk {
  return {
    chunkId: id, documentId: 'doc', documentName: 'doc.txt', chunkIndex: 0,
    content, score,
    scoreBreakdown: { total: 1, lexicalTotal: 1, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 },
  }
}

function jsonRes(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  delete process.env.RERANKER_URL
})

afterEach(() => {
  global.fetch = originalFetch
  delete process.env.RERANKER_URL
})

describe('crossEncoderRerank', () => {
  test('returns null when RERANKER_URL not configured', async () => {
    const result = await crossEncoderRerank('q', [makeChunk('c1', 'text')], 5)
    expect(result).toBeNull()
  })

  test('returns [] for empty chunks (short-circuit)', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    const result = await crossEncoderRerank('q', [], 5)
    expect(result).toEqual([])
  })

  test('calls HTTP endpoint and sorts by scores object', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    const fetchMock = mock(() => Promise.resolve(jsonRes({ scores: [0.1, 0.9, 0.5] })))
    global.fetch = fetchMock as unknown as typeof global.fetch

    const chunks = [makeChunk('a', 'alpha'), makeChunk('b', 'beta'), makeChunk('c', 'gamma')]
    const result = await crossEncoderRerank('query', chunks, 2)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://rerank.local/rerank')
    const body = JSON.parse(init.body as string)
    expect(body.query).toBe('query')
    expect(body.documents).toHaveLength(3)
    expect(body.documents[1].text).toBe('beta')
    expect(result!.map((c) => c.chunkId)).toEqual(['b', 'c']) // 0.9 then 0.5
  })

  test('handles bare array response shape', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    global.fetch = mock(() => Promise.resolve(jsonRes([0.8, 0.2]))) as unknown as typeof global.fetch

    const chunks = [makeChunk('a', 'alpha'), makeChunk('b', 'beta')]
    const result = await crossEncoderRerank('query', chunks, 2)
    expect(result!.map((c) => c.chunkId)).toEqual(['a', 'b'])
  })

  test('respects topK limit', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    global.fetch = mock(() => Promise.resolve(jsonRes({ scores: [0.9, 0.8, 0.7, 0.6] }))) as unknown as typeof global.fetch

    const chunks = ['a', 'b', 'c', 'd'].map((id) => makeChunk(id, id))
    const result = await crossEncoderRerank('query', chunks, 2)
    expect(result).toHaveLength(2)
    expect(result![0].chunkId).toBe('a')
  })

  test('returns null on HTTP error', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    global.fetch = mock(() => Promise.resolve(new Response('err', { status: 500 }))) as unknown as typeof global.fetch
    const result = await crossEncoderRerank('q', [makeChunk('a', 't')], 5)
    expect(result).toBeNull()
  })

  test('returns null on fetch throw', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    global.fetch = mock(() => Promise.reject(new Error('timeout'))) as unknown as typeof global.fetch
    const result = await crossEncoderRerank('q', [makeChunk('a', 't')], 5)
    expect(result).toBeNull()
  })

  test('returns null on malformed response (no scores)', async () => {
    process.env.RERANKER_URL = 'http://rerank.local/rerank'
    global.fetch = mock(() => Promise.resolve(jsonRes({ unrelated: true }))) as unknown as typeof global.fetch
    const result = await crossEncoderRerank('q', [makeChunk('a', 't')], 5)
    expect(result).toBeNull()
  })
})
