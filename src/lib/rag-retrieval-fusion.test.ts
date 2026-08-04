/**
 * Integration test for the hybrid retrieval path (retrieveAndFuse).
 *
 * Separate file from rag-retrieval.test.ts on purpose: that file stubs
 * scoreChunk to zeros and selectTopRetrievedChunks to identity, which is fine
 * for parseRerankerScores but would hide everything this test is checking.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Chunks the "database" knows about, keyed by id.
const CHUNKS: Record<string, { content: string; keywords: string }> = {
  v1: { content: 'tax identification details for corporate entities', keywords: 'tax,corporate' },
  shared: { content: 'npwp registration and tax filing procedure', keywords: 'npwp,tax' },
  exact: { content: 'npwp npwp npwp number format specification', keywords: 'npwp,format' },
  kgonly: { content: 'related entity billing record', keywords: 'billing' },
}

let vectorRows: Array<{ id: string; similarity: number }> = []
let ftsIds: string[] = []
let kgChunkIds: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    documentChunk: {
      findMany: async (args: any) => {
        const ids: string[] = args.where.id.in
        return ids
          .filter((id) => CHUNKS[id])
          .map((id, index) => ({
            id,
            chunkIndex: index,
            content: CHUNKS[id].content,
            keywords: CHUNKS[id].keywords,
            contextPrefix: null,
            embeddingJson: null,
            embeddingModel: null,
            document: { id: `doc-${id}`, name: `${id}.pdf` },
          }))
      },
    },
    document: { findMany: async () => [] },
    llmConfig: { findFirst: async () => null },
    $queryRaw: async () => vectorRows,
    $executeRawUnsafe: async () => 1,
  },
}))

// A working embedding provider, so the vector leg actually runs. cosineSimilarity
// is only reached for chunks the vector store did not score, which this fixture
// avoids by giving every vector hit an explicit similarity.
mock.module('@/lib/embeddings', () => ({
  getEmbeddingRuntimeConfig: async () => ({
    provider: 'OPENAI_COMPATIBLE',
    baseUrl: 'https://example.test',
    apiKey: 'k',
    model: 'test-embed',
  }),
  embedTexts: async () => [[1, 0, 0]],
  parseEmbeddingJson: () => null,
  cosineSimilarity: () => 0,
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/redis', () => ({
  cacheGet: async () => null,
  cacheSet: async () => {},
  cacheDel: async () => {},
}))
mock.module('@/lib/rag-fts', () => ({ searchFtsChunkIds: async () => ftsIds }))
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({
    localChunks: kgChunkIds,
    globalChunks: [],
    allChunkIds: kgChunkIds,
    matchedEntities: [],
    graphContext: '',
  }),
}))
mock.module('@/lib/cognee', () => ({ recallKnowledgeGraph: async () => '' }))
mock.module('@/lib/citation-trail', () => ({ buildCitationTrail: () => [] }))
mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => null,
  searchVectorStore: async () => [],
}))

import { retrieveRelevantChunks } from './rag-retrieval'
import { enterWithOrg } from '@/lib/prisma-tenant'

const ids = (r: { chunks: Array<{ chunkId: string }> }) => r.chunks.map((c) => c.chunkId)

beforeEach(async () => {
  enterWithOrg('org-fusion-test')
  vectorRows = []
  ftsIds = []
  kgChunkIds = []
})

describe('hybrid retrieval — both legs always run', () => {
  test('a chunk only the lexical leg found is still retrieved', async () => {
    // THE structural fix. Candidates used to be
    //   vectorScores.size > 0 ? vectorCandidates : lexicalCandidates
    // so once pgvector returned anything, FTS never ran and an exact keyword
    // match the embedding ranked poorly was unreachable at any topK.
    vectorRows = [{ id: 'v1', similarity: 0.9 }]
    ftsIds = ['exact']

    const result = await retrieveRelevantChunks({ query: 'npwp registration', topK: 5 })

    expect(ids(result)).toContain('exact')
    expect(ids(result)).toContain('v1')
  })

  test('a chunk only the vector leg found is still retrieved', async () => {
    vectorRows = [{ id: 'v1', similarity: 0.95 }]
    ftsIds = ['exact']

    const result = await retrieveRelevantChunks({ query: 'corporate tax', topK: 5 })
    expect(ids(result)).toContain('v1')
  })

  test('candidatesScanned reflects the union, not one leg', async () => {
    vectorRows = [{ id: 'v1', similarity: 0.9 }]
    ftsIds = ['exact', 'shared']

    const result = await retrieveRelevantChunks({ query: 'npwp tax', topK: 5 })
    expect(result.candidatesScanned).toBe(3)
  })
})

describe('hybrid retrieval — RRF fusion', () => {
  test('a chunk both legs agree on outranks a chunk only one leg found', async () => {
    vectorRows = [
      { id: 'v1', similarity: 0.99 }, // vector's own #1
      { id: 'shared', similarity: 0.7 },
    ]
    ftsIds = ['shared', 'exact']

    const result = await retrieveRelevantChunks({ query: 'npwp tax filing', topK: 5 })

    // 'shared' is rank 2 in vector and rank 1 in lexical; 'v1' is rank 1 in
    // vector and absent from lexical. Consensus wins — under the old additive
    // scoring, whichever leg produced the larger raw number simply took over.
    expect(ids(result)[0]).toBe('shared')
  })

  test('scores are RRF-scale, never raw counts', async () => {
    vectorRows = [{ id: 'shared', similarity: 0.9 }]
    ftsIds = ['shared']

    const result = await retrieveRelevantChunks({ query: 'npwp tax', topK: 5 })
    // Two retrievers both at rank 1 => 2/(60+1) ≈ 0.0328. The old scale was 0-30.
    expect(result.chunks[0].score).toBeGreaterThan(0)
    expect(result.chunks[0].score).toBeLessThan(0.1)
  })

  test('the breakdown still reports lexical + semantic detail for the UI', async () => {
    vectorRows = [{ id: 'shared', similarity: 0.8 }]
    ftsIds = ['shared']

    const result = await retrieveRelevantChunks({ query: 'npwp tax', topK: 5 })
    const breakdown = result.chunks[0].scoreBreakdown
    expect(breakdown.semanticSimilarity).toBeCloseTo(0.8, 5)
    expect(typeof breakdown.bm25).toBe('number')
    expect(breakdown.total).toBe(result.chunks[0].score)
  })
})

describe('hybrid retrieval — knowledge graph as a third retriever', () => {
  test('KG-only chunks enter the pool and are ranked, not bolted on', async () => {
    vectorRows = [{ id: 'v1', similarity: 0.9 }]
    ftsIds = ['exact']
    kgChunkIds = ['kgonly']

    const result = await retrieveRelevantChunks({ query: 'npwp billing', topK: 5 })
    expect(ids(result)).toContain('kgonly')
  })

  test('KG agreement lifts a chunk without a hand-tuned multiplier', async () => {
    // Previously: KG-local hits were multiplied by 1.3 and KG-only chunks scored
    // at lexical*0.8 — constants that only made sense on the old additive scale.
    vectorRows = [
      { id: 'v1', similarity: 0.95 },
      { id: 'shared', similarity: 0.6 },
    ]
    ftsIds = ['v1', 'shared']
    kgChunkIds = ['shared']

    const withKg = await retrieveRelevantChunks({ query: 'npwp tax filing', topK: 5 })
    const sharedScore = withKg.chunks.find((c) => c.chunkId === 'shared')!.score

    kgChunkIds = []
    const withoutKg = await retrieveRelevantChunks({ query: 'npwp tax filing again', topK: 5 })
    const sharedBaseline = withoutKg.chunks.find((c) => c.chunkId === 'shared')!.score

    expect(sharedScore).toBeGreaterThan(sharedBaseline)
  })
})

describe('hybrid retrieval — degenerate inputs', () => {
  test('stopword-only query returns nothing and scans nothing', async () => {
    vectorRows = [{ id: 'v1', similarity: 0.9 }]
    ftsIds = ['exact']

    const result = await retrieveRelevantChunks({ query: 'what is the', topK: 5 })
    expect(result.chunks).toEqual([])
    expect(result.candidatesScanned).toBe(0)
  })

  test('neither leg returns anything → empty, no crash', async () => {
    const result = await retrieveRelevantChunks({ query: 'nonexistent terminology', topK: 5 })
    expect(result.chunks).toEqual([])
  })
})
