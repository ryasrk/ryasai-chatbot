import { describe, expect, test } from 'bun:test'
import { normalizeRagSearchResponse } from './rag-search-tester'

describe('RAG search tester helpers', () => {
  test('normalizes score breakdown and search metadata from API response', () => {
    const normalized = normalizeRagSearchResponse({
      queryTokens: ['pembayaran', 'invoice'],
      topK: 4,
      candidatesScanned: 12,
      results: [
        {
          chunkId: 'chk_1',
          documentId: 'doc_1',
          documentName: 'SOP.md',
          chunkIndex: 2,
          content: 'SLA pembayaran invoice maksimal 14 hari.',
          score: 11,
          contentHits: 2,
          keywordHits: 1,
          scoreBreakdown: {
            total: 11,
            lexicalTotal: 8,
            contentHits: 2,
            keywordHits: 1,
            phraseHits: 2,
            semanticSimilarity: 0.25,
            semanticScore: 3,
          },
        },
      ],
    })

    expect(normalized.meta).toEqual({
      queryTokens: ['pembayaran', 'invoice'],
      topK: 4,
      candidatesScanned: 12,
    })
    expect(normalized.results[0].scoreBreakdown.phraseHits).toBe(2)
    expect(normalized.results[0].scoreBreakdown.semanticScore).toBe(3)
    expect(normalized.results[0].contentHits).toBe(2)
  })
})
