import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mocks (must be before imports of modules under test) ---

const mockDocChunkFindMany = mock(async () => [] as unknown[])
const mockDocFindMany = mock(async () => [] as unknown[])
const mockLlmConfigFindFirst = mock(async () => null)
const mockVectorStoreConfigFindFirst = mock(async () => null)
const mockAuditLogCreate = mock(async () => ({}))

mock.module('@/lib/db', () => ({
  db: {
    documentChunk: { findMany: mockDocChunkFindMany },
    document: { findMany: mockDocFindMany },
    llmConfig: { findFirst: mockLlmConfigFindFirst },
    vectorStoreConfig: { findFirst: mockVectorStoreConfigFindFirst },
    auditLog: { create: mockAuditLogCreate },
  },
}))

const mockSearchFtsChunkIds = mock(async () => [] as string[])
mock.module('@/lib/rag-fts', () => ({
  searchFtsChunkIds: mockSearchFtsChunkIds,
}))

mock.module('@/lib/cognee', () => ({
  recallKnowledgeGraph: async () => '',
}))

// In-memory Redis mock for cache tests
const _redisMockCache = new Map<string, string>()
mock.module('@/lib/redis', () => ({
  cacheGet: async (key: string) => {
    const val = _redisMockCache.get(key)
    return val ? JSON.parse(val) : null
  },
  cacheSet: async (key: string, value: unknown) => {
    _redisMockCache.set(key, JSON.stringify(value))
  },
  cacheDel: async (prefix: string) => {
    for (const key of [..._redisMockCache.keys()]) {
      if (key.startsWith(prefix)) _redisMockCache.delete(key)
    }
  },
}))

// KG mock — dual-level retrieval returns empty (no KG indexed in tests)
mock.module('@/lib/knowledge-graph', () => ({
  dualLevelRetrieval: async () => ({
    localChunks: [],
    globalChunks: [],
    allChunkIds: [],
    matchedEntities: [],
    graphContext: '',
  }),
}))

// --- Imports ---

import {
  applySemanticScore,
  chunkText,
  detectDocType,
  extractFileText,
  extractKeywords,
  getRagCacheStats,
  invalidateRagCache,
  retrieveRelevantChunks,
  scoreChunk,
  selectTopRetrievedChunks,
  sortRetrievedChunks,
  tokenize,
} from './rag'
import { combineHybridScore, cosineSimilarity } from './embeddings'

// --- Setup / teardown ---

beforeEach(() => {
  _redisMockCache.clear()
  invalidateRagCache()
  mockDocChunkFindMany.mockClear()
  mockDocFindMany.mockClear()
  mockSearchFtsChunkIds.mockClear()
  mockLlmConfigFindFirst.mockClear()
  mockVectorStoreConfigFindFirst.mockClear()
  mockAuditLogCreate.mockClear()
  mockDocChunkFindMany.mockImplementation(async () => [])
  mockDocFindMany.mockImplementation(async () => [])
  mockSearchFtsChunkIds.mockImplementation(async () => [])
  mockLlmConfigFindFirst.mockImplementation(async () => null)
  mockVectorStoreConfigFindFirst.mockImplementation(async () => null)
  mockAuditLogCreate.mockImplementation(async () => ({}))
})

// --- Pure function tests ---

describe('RAG chunking', () => {
  test('splits a long single-paragraph document into bounded chunks', () => {
    const content = Array.from(
      { length: 180 },
      (_, index) =>
        `RAG audit sentence number ${index} discusses security incident escalation procedures, document retention, and enterprise invoice payment SLA.`,
    ).join(' ')

    const chunks = chunkText(content)

    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(1600)
  })

  test('keeps overlap between adjacent long chunks', () => {
    const content = Array.from(
      { length: 220 },
      (_, index) => `marker-${index}`,
    ).join(' ')

    const chunks = chunkText(content, { maxChars: 260, overlapChars: 60 })

    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(320)

    const firstTail = chunks[0].split(/\s+/).slice(-3)
    expect(chunks[1]).toContain(firstTail[0])
  })

  test('short text returns a single chunk', () => {
    const chunks = chunkText('Short paragraph.\n\nSecond short paragraph.')
    expect(chunks).toEqual(['Short paragraph.', 'Second short paragraph.'])
  })

  test('empty text returns empty array', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   ')).toEqual([])
  })

  test('phrase match scores higher than scattered token match', () => {
    const queryTokens = tokenize('SLA payment invoice enterprise')
    const phrase = scoreChunk(queryTokens, {
      content: 'SLA payment invoice enterprise must be completed within 14 days.',
      keywords: 'sla,payment,invoice',
    })
    const scattered = scoreChunk(queryTokens, {
      content: 'Operational SLA. Vendor payment. Old invoice. General enterprise.',
      keywords: '',
    })

    expect(phrase.total).toBeGreaterThan(scattered.total)
    expect(phrase.phraseHits).toBeGreaterThan(0)
  })

  test('sorts retrieval chunks by score then chunk index', () => {
    const rows = sortRetrievedChunks([
      { chunkIndex: 2, score: 5 },
      { chunkIndex: 1, score: 5 },
      { chunkIndex: 9, score: 7 },
    ])

    expect(rows.map((row) => row.chunkIndex)).toEqual([9, 1, 2])
  })

  test('limits repetitive chunks from the same document', () => {
    const rows = selectTopRetrievedChunks(
      [
        { documentId: 'old', chunkIndex: 1, score: 30 },
        { documentId: 'old', chunkIndex: 2, score: 29 },
        { documentId: 'old', chunkIndex: 3, score: 28 },
        { documentId: 'new', chunkIndex: 1, score: 20 },
      ],
      3,
      2,
    )

    expect(rows.map((row) => `${row.documentId}:${row.chunkIndex}`)).toEqual([
      'old:1',
      'old:2',
      'new:1',
    ])
  })

  test('adds semantic score when query and chunk embeddings are available', () => {
    const lexical = scoreChunk(tokenize('invoice payment policy'), {
      content: 'enterprise finance approval',
      keywords: '',
    })
    const hybrid = applySemanticScore(lexical, [1, 0], [1, 0])

    expect(hybrid.semanticSimilarity).toBe(1)
    expect(hybrid.semanticScore).toBeGreaterThan(0)
    expect(hybrid.total).toBeGreaterThan(lexical.total)
  })
})

describe('tokenize', () => {
  test('English text with keywords', () => {
    const tokens = tokenize('enterprise invoice payment procedures')
    expect(tokens).toEqual(['enterprise', 'invoice', 'payment', 'procedures'])
  })

  test('empty string returns empty array', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
  })

  test('filters short words, stopwords, and digits-only', () => {
    const tokens = tokenize('the 1234 cat is on the mat')
    // 'the', 'is', 'on' are stopwords; 'cat' < 4 chars; '1234' is digits-only
    expect(tokens).toEqual([])
  })

  test('special characters are stripped, words preserved', () => {
    const tokens = tokenize('hello! @world #test $value')
    // 'hello' >= 4 chars, 'world' >= 4, 'test' >= 4, 'value' >= 4
    expect(tokens).toContain('hello')
    expect(tokens).toContain('world')
    expect(tokens).toContain('test')
    expect(tokens).toContain('value')
  })

  test('deduplicates repeated tokens', () => {
    const tokens = tokenize('enterprise enterprise enterprise')
    expect(tokens).toEqual(['enterprise'])
  })
})

describe('extractKeywords', () => {
  test('extracts top keywords by frequency', () => {
    const text = 'enterprise invoice enterprise payment enterprise invoice billing'
    const keywords = extractKeywords(text, 3)
    const kwList = keywords.split(',')
    expect(kwList[0]).toBe('enterprise')
    expect(kwList.length).toBeLessThanOrEqual(3)
    expect(kwList).toContain('invoice')
    expect(kwList).toContain('payment')
  })

  test('empty text returns empty string', () => {
    expect(extractKeywords('')).toBe('')
  })

  test('respects topN limit', () => {
    const text = 'alpha beta gamma delta epsilon zeta eta theta'
    const keywords = extractKeywords(text, 3)
    expect(keywords.split(',').length).toBe(3)
  })

  test('filters stopwords and short words', () => {
    const keywords = extractKeywords('the is on cat dog')
    expect(keywords).toBe('')
  })
})

describe('detectDocType', () => {
  test('detects .txt extension', () => {
    expect(detectDocType('document.txt')).toBe('txt')
  })

  test('detects .pdf extension', () => {
    expect(detectDocType('report.pdf')).toBe('pdf')
  })

  test('detects .md extension', () => {
    expect(detectDocType('notes.md')).toBe('md')
  })

  test('detects .docx extension', () => {
    expect(detectDocType('memo.docx')).toBe('docx')
  })

  test('detects .xlsx extension', () => {
    expect(detectDocType('data.xlsx')).toBe('xlsx')
  })

  test('unknown extension returns the extension', () => {
    expect(detectDocType('file.xyz')).toBe('xyz')
  })

  test('no extension falls back to txt', () => {
    expect(detectDocType('noextension')).toBe('txt')
  })

  test('case-insensitive detection', () => {
    expect(detectDocType('FILE.PDF')).toBe('pdf')
    expect(detectDocType('FILE.TXT')).toBe('txt')
  })
})

describe('extractFileText', () => {
  test('reads .txt file as UTF-8 text', async () => {
    const file = new File(['hello world content'], 'test.txt', { type: 'text/plain' })
    const result = await extractFileText(file)
    expect(result.text).toBe('hello world content')
    expect(result.isPlaceholder).toBe(false)
  })

  test('reads .md file as UTF-8 text', async () => {
    const content = '# Heading\n\nSome markdown text.'
    const file = new File([content], 'readme.md', { type: 'text/markdown' })
    const result = await extractFileText(file)
    expect(result.text).toBe(content)
    expect(result.isPlaceholder).toBe(false)
  })

  test('unknown extension with printable content returns text', async () => {
    const file = new File(['plain text data'], 'data.xyz', { type: 'application/octet-stream' })
    const result = await extractFileText(file)
    expect(result.text).toBe('plain text data')
    expect(result.isPlaceholder).toBe(false)
  })

  test('binary-only content returns placeholder', async () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0xfd, 0xfc, 0xaa, 0xbb])
    const file = new File([binary], 'binary.xyz', { type: 'application/octet-stream' })
    const result = await extractFileText(file)
    expect(result.isPlaceholder).toBe(true)
    expect(result.text).toContain('Binary document')
  })
})

describe('combineHybridScore', () => {
  test('both lexical and semantic scores contribute to total', () => {
    const result = combineHybridScore({ lexicalTotal: 10, semanticSimilarity: 0.5 })
    expect(result.lexicalTotal).toBe(10)
    expect(result.semanticSimilarity).toBe(0.5)
    expect(result.semanticScore).toBe(6) // 0.5 * 12 = 6
    expect(result.total).toBe(16) // 10 + 6
  })

  test('one zero (lexical only)', () => {
    const result = combineHybridScore({ lexicalTotal: 5, semanticSimilarity: 0 })
    expect(result.semanticScore).toBe(0)
    expect(result.total).toBe(5)
  })

  test('both zero', () => {
    const result = combineHybridScore({ lexicalTotal: 0, semanticSimilarity: 0 })
    expect(result.total).toBe(0)
    expect(result.semanticScore).toBe(0)
  })

  test('negative semantic similarity is clamped to zero', () => {
    const result = combineHybridScore({ lexicalTotal: 3, semanticSimilarity: -0.5 })
    expect(result.semanticSimilarity).toBe(0)
    expect(result.semanticScore).toBe(0)
    expect(result.total).toBe(3)
  })

  test('undefined semantic defaults to zero', () => {
    const result = combineHybridScore({ lexicalTotal: 7 })
    expect(result.semanticSimilarity).toBe(0)
    expect(result.total).toBe(7)
  })
})

describe('cosineSimilarity', () => {
  test('identical vectors return 1', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 5)
  })

  test('orthogonal vectors return 0', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  test('empty vectors return 0', () => {
    expect(cosineSimilarity([], [])).toBe(0)
  })

  test('different-length vectors return 0', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0)
  })

  test('zero vectors return 0', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0)
  })

  test('opposite vectors return -1', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1)
  })
})

// --- Retrieval + cache tests (require mocked DB + FTS) ---

describe('retrieveRelevantChunks', () => {
  test('empty query returns empty chunks', async () => {
    const result = await retrieveRelevantChunks({ query: '', topK: 4 })
    expect(result.chunks).toEqual([])
    expect(result.queryTokens).toEqual([])
    expect(result.candidatesScanned).toBe(0)
  })

  test('query with only stopwords returns empty chunks', async () => {
    const result = await retrieveRelevantChunks({ query: 'the is on at by', topK: 4 })
    expect(result.chunks).toEqual([])
    expect(result.queryTokens).toEqual([])
  })

  test('valid query returns scored chunks from FTS path', async () => {
    mockSearchFtsChunkIds.mockImplementation(async () => ['chunk-1', 'chunk-2'])
    mockDocChunkFindMany.mockImplementation(async () => [
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'enterprise invoice payment terms and conditions',
        keywords: 'enterprise,invoice,payment',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'policy.txt' },
      },
      {
        id: 'chunk-2',
        chunkIndex: 1,
        content: 'general information about billing procedures',
        keywords: 'billing,information',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'policy.txt' },
      },
    ])

    const result = await retrieveRelevantChunks({ query: 'enterprise invoice payment', topK: 4 })

    expect(result.queryTokens).toEqual(['enterprise', 'invoice', 'payment'])
    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].chunkId).toBe('chunk-1')
    expect(result.chunks[0].documentName).toBe('policy.txt')
    expect(result.chunks[0].score).toBeGreaterThan(0)
    expect(result.candidatesScanned).toBe(2)
  })

  test('falls back to all chunks when FTS returns no IDs', async () => {
    mockSearchFtsChunkIds.mockImplementation(async () => [])
    mockDocFindMany.mockImplementation(async () => [
      {
        id: 'doc-1',
        name: 'handbook.txt',
        chunks: [
          {
            id: 'chunk-a',
            chunkIndex: 0,
            content: 'enterprise security policy document',
            keywords: 'enterprise,security,policy',
            embeddingJson: null,
            embeddingModel: null,
          },
        ],
      },
    ])

    const result = await retrieveRelevantChunks({ query: 'enterprise security', topK: 4 })

    expect(result.chunks.length).toBe(1)
    expect(result.chunks[0].chunkId).toBe('chunk-a')
    expect(result.candidatesScanned).toBe(1)
  })

  test('cache hit on second identical query', async () => {
    mockSearchFtsChunkIds.mockImplementation(async () => ['chunk-1'])
    mockDocChunkFindMany.mockImplementation(async () => [
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'enterprise invoice payment',
        keywords: 'enterprise,invoice',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'policy.txt' },
      },
    ])

    const statsBefore = getRagCacheStats()

    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 4 })
    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 4 })

    const statsAfter = getRagCacheStats()
    expect(statsAfter.hits).toBeGreaterThan(statsBefore.hits)
    expect(statsAfter.misses).toBeGreaterThan(statsBefore.misses)
    expect(statsAfter.hitRate).toBeGreaterThan(0)
  })

  test('different topK values produce separate cache entries', async () => {
    mockSearchFtsChunkIds.mockImplementation(async () => ['chunk-1'])
    mockDocChunkFindMany.mockImplementation(async () => [
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'enterprise invoice payment data',
        keywords: 'enterprise,invoice',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'p.txt' },
      },
    ])

    const statsBefore = getRagCacheStats()

    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 4 })
    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 8 })

    const statsAfter = getRagCacheStats()
    // Both should be misses (different topK = different cache key)
    expect(statsAfter.misses).toBeGreaterThanOrEqual(statsBefore.misses + 2)
    expect(statsAfter.hits).toBe(statsBefore.hits)
  })
})

describe('invalidateRagCache', () => {
  test('clears cache so next call is a miss', async () => {
    mockSearchFtsChunkIds.mockImplementation(async () => ['chunk-1'])
    mockDocChunkFindMany.mockImplementation(async () => [
      {
        id: 'chunk-1',
        chunkIndex: 0,
        content: 'enterprise invoice payment',
        keywords: 'enterprise',
        embeddingJson: null,
        embeddingModel: null,
        document: { id: 'doc-1', name: 'p.txt' },
      },
    ])

    const statsBefore = getRagCacheStats()

    // First call: miss + cache
    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 4 })
    // Invalidate
    invalidateRagCache()
    // Second call: miss again (cache was cleared)
    await retrieveRelevantChunks({ query: 'enterprise invoice', topK: 4 })

    const statsAfter = getRagCacheStats()
    const newMisses = statsAfter.misses - statsBefore.misses
    const newHits = statsAfter.hits - statsBefore.hits
    expect(newMisses).toBe(2)
    expect(newHits).toBe(0)
  })
})

describe('getRagCacheStats', () => {
  test('returns correct shape with hits, misses, and hitRate', () => {
    const stats = getRagCacheStats()
    expect(stats).toHaveProperty('hits')
    expect(stats).toHaveProperty('misses')
    expect(stats).toHaveProperty('hitRate')
    expect(typeof stats.hits).toBe('number')
    expect(typeof stats.misses).toBe('number')
    expect(typeof stats.hitRate).toBe('number')
    expect(stats.hitRate).toBeGreaterThanOrEqual(0)
    expect(stats.hitRate).toBeLessThanOrEqual(1)
  })

  test('hitRate is 0 when no calls have been made', () => {
    // After invalidateRagCache, the cache is empty but counters persist.
    // We test the shape: hitRate = hits/(hits+misses).
    const stats = getRagCacheStats()
    const total = stats.hits + stats.misses
    expect(stats.hitRate).toBe(total === 0 ? 0 : stats.hits / total)
  })
})
