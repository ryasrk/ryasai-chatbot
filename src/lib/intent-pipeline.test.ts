import { describe, expect, test, mock, beforeEach } from 'bun:test'
import type { RetrievedChunk } from './rag'

// --- Mocks (must be before imports of modules under test) ---

const mockChatOnce = mock(async () => '')
const mockGetLlmRuntimeConfig = mock(async (): Promise<unknown> => null)
// ponytail: role config uses the same mock — tests set implementations on mockGetLlmRuntimeConfig
// and mockGetRoleLlmConfig mirrors it. Avoids updating 20+ mockImplementation callsites.
const mockGetRoleLlmConfig = mockGetLlmRuntimeConfig
const mockRetrieveRelevantChunks = mock(async (_args: { query: string; topK: number }) => ({
  chunks: [] as RetrievedChunk[],
  queryTokens: [] as string[],
  candidatesScanned: 0,
  graphContext: '',
}))

mock.module('@/lib/db', () => ({ db: {} }))
mock.module('@/lib/rag-fts', () => ({ searchFtsChunkIds: async () => [] }))
mock.module('@/lib/cognee', () => ({
  recallContext: async () => '',
  recallKnowledgeGraph: async () => '',
}))
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: mockGetLlmRuntimeConfig,
  getRoleLlmConfig: mockGetRoleLlmConfig,
}))
mock.module('@/lib/rag', () => ({ retrieveRelevantChunks: mockRetrieveRelevantChunks }))

// --- Imports ---

import {
  analyzeIntent,
  rewriteQuery,
  evaluateEvidenceSufficiency,
  expandQuery,
  mergeRetrievalResults,
  retrieveWithReflection,
} from './intent-pipeline'

// --- Helpers ---

const MOCK_CONFIG = {
  id: 'cfg-1',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'http://localhost:11434',
  apiKey: 'test-key',
  model: 'test-model',
}

function makeChunk(overrides: Partial<RetrievedChunk> & { chunkId: string }): RetrievedChunk {
  return {
    documentId: 'doc-1',
    documentName: 'doc.txt',
    chunkIndex: 0,
    content: 'A'.repeat(100),
    score: 1,
    scoreBreakdown: {
      total: 1,
      lexicalTotal: 1,
      contentHits: 0,
      keywordHits: 0,
      phraseHits: 0,
      semanticSimilarity: 0,
      semanticScore: 0,
    },
    ...overrides,
  }
}

type RetrievalResult = Parameters<typeof mergeRetrievalResults>[0][number]

function makeResult(overrides: Partial<RetrievalResult> & { chunks?: RetrievedChunk[] }): RetrievalResult {
  return {
    chunks: [],
    queryTokens: [],
    candidatesScanned: 0,
    graphContext: '',
    ...overrides,
  }
}

// --- Setup / teardown ---

beforeEach(() => {
  mockChatOnce.mockClear()
  mockGetLlmRuntimeConfig.mockClear()
  mockRetrieveRelevantChunks.mockClear()
  mockChatOnce.mockImplementation(async () => '')
  mockGetLlmRuntimeConfig.mockImplementation(async () => null)
  mockRetrieveRelevantChunks.mockImplementation(async () => ({
    chunks: [],
    queryTokens: [],
    candidatesScanned: 0,
    graphContext: '',
  }))
})

// --- Pure function tests: expandQuery ---

describe('expandQuery', () => {
  test('returns original query when no synonyms match', () => {
    const result = expandQuery('hello world')
    expect(result).toEqual(['hello world'])
  })

  test('expands "leave" with synonyms (vacation, cuti, cuti tahunan, time off)', () => {
    const result = expandQuery('leave')
    expect(result[0]).toBe('leave')
    expect(result).toContain('annual leave')
    expect(result).toContain('vacation')
    expect(result).toContain('cuti')
    expect(result).toContain('cuti tahunan')
    expect(result).toContain('time off')
  })

  test('expands "invoice" with synonyms (bill, faktur, tagihan)', () => {
    const result = expandQuery('invoice')
    expect(result[0]).toBe('invoice')
    expect(result).toContain('bill')
    expect(result).toContain('faktur')
    expect(result).toContain('tagihan')
  })

  test('expands "policy" with synonyms (procedure, guideline, kebijakan, prosedur)', () => {
    const result = expandQuery('policy')
    expect(result[0]).toBe('policy')
    expect(result).toContain('procedure')
    expect(result).toContain('guideline')
    expect(result).toContain('kebijakan')
    expect(result).toContain('prosedur')
  })

  test('handles multi-word queries with multiple synonym tokens', () => {
    const result = expandQuery('leave invoice')
    expect(result[0]).toBe('leave invoice')
    // leave synonyms applied to the lowercased query
    expect(result).toContain('annual leave invoice')
    expect(result).toContain('vacation invoice')
    expect(result).toContain('cuti invoice')
    // invoice synonyms applied to the lowercased query
    expect(result).toContain('leave bill')
    expect(result).toContain('leave faktur')
    expect(result).toContain('leave tagihan')
  })

  test('returns at least the original query for empty string', () => {
    const result = expandQuery('')
    expect(result.length).toBeGreaterThanOrEqual(1)
    expect(result[0]).toBe('')
  })

  test('does not duplicate when no synonym matches', () => {
    const result = expandQuery('hello world')
    expect(result).toEqual(['hello world'])
    expect(result.length).toBe(1)
  })

  test('handles Indonesian terms (cuti is a synonym value, not a key — not expanded)', () => {
    const result = expandQuery('cuti')
    expect(result).toEqual(['cuti'])
  })
})

// --- Pure function tests: mergeRetrievalResults ---

describe('mergeRetrievalResults', () => {
  test('merges chunks from multiple results, dedupes by chunkId keeping highest score', () => {
    const c1low = makeChunk({ chunkId: 'c1', score: 3 })
    const c1high = makeChunk({ chunkId: 'c1', score: 7 })
    const c2 = makeChunk({ chunkId: 'c2', score: 5 })

    const merged = mergeRetrievalResults([
      makeResult({ chunks: [c1low, c2] }),
      makeResult({ chunks: [c1high] }),
    ])

    const ids = merged.chunks.map((c) => c.chunkId)
    expect(ids).toEqual(['c1', 'c2'])
    expect(merged.chunks[0].score).toBe(7) // c1 keeps highest score
    expect(merged.chunks[1].score).toBe(5)
  })

  test('combines queryTokens from all results (deduped)', () => {
    const merged = mergeRetrievalResults([
      makeResult({ queryTokens: ['leave', 'policy'] }),
      makeResult({ queryTokens: ['policy', 'vacation'] }),
    ])

    expect(merged.queryTokens.sort()).toEqual(['leave', 'policy', 'vacation'])
  })

  test('sums candidatesScanned across results', () => {
    const merged = mergeRetrievalResults([
      makeResult({ candidatesScanned: 10 }),
      makeResult({ candidatesScanned: 20 }),
      makeResult({ candidatesScanned: 5 }),
    ])

    expect(merged.candidatesScanned).toBe(35)
  })

  test('concatenates graphContext from all results', () => {
    const merged = mergeRetrievalResults([
      makeResult({ graphContext: 'graph-alpha' }),
      makeResult({ graphContext: 'graph-beta' }),
    ])

    expect(merged.graphContext).toBe('graph-alpha\n\ngraph-beta')
  })

  test('handles empty results array', () => {
    const merged = mergeRetrievalResults([])

    expect(merged.chunks).toEqual([])
    expect(merged.queryTokens).toEqual([])
    expect(merged.candidatesScanned).toBe(0)
    expect(merged.graphContext).toBe('')
  })

  test('handles results with empty chunks arrays', () => {
    const merged = mergeRetrievalResults([
      makeResult({ chunks: [], queryTokens: ['a'], candidatesScanned: 5 }),
      makeResult({ chunks: [], queryTokens: ['b'], candidatesScanned: 3 }),
    ])

    expect(merged.chunks).toEqual([])
    expect(merged.queryTokens.sort()).toEqual(['a', 'b'])
    expect(merged.candidatesScanned).toBe(8)
  })

  test('preserves chunk order by score (highest first)', () => {
    const merged = mergeRetrievalResults([
      makeResult({ chunks: [makeChunk({ chunkId: 'low', score: 1 })] }),
      makeResult({ chunks: [makeChunk({ chunkId: 'high', score: 9 })] }),
      makeResult({ chunks: [makeChunk({ chunkId: 'mid', score: 5 })] }),
    ])

    expect(merged.chunks.map((c) => c.chunkId)).toEqual(['high', 'mid', 'low'])
  })
})

// --- Async tests: analyzeIntent ---

describe('analyzeIntent', () => {
  test('returns default needsRetrieval=true when no LLM configured', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)

    const result = await analyzeIntent({
      question: 'what is the leave policy?',
      hasDocuments: true,
      hasIntegrations: false,
    })

    expect(result.needsRetrieval).toBe(true)
    expect(result.needsClarification).toBe(false)
    expect(result.confidence).toBe(0)
  })

  test('parses valid JSON response from LLM correctly', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({
        needsRetrieval: true,
        needsClarification: true,
        clarificationQuestion: 'Which invoice do you mean?',
        rewrittenQuery: 'invoice for acme corp',
        entities: { topic: 'invoice', document_type: 'invoice' },
        confidence: 0.9,
      }),
    )

    // ponytail: use a question without query indicators (show, count, total,
    // list, etc.) so the heuristic guard doesn't override needsClarification.
    const result = await analyzeIntent({
      question: 'xyz ambiguous reference',
      hasDocuments: true,
      hasIntegrations: true,
    })

    expect(result.needsRetrieval).toBe(true)
    expect(result.needsClarification).toBe(true)
    expect(result.clarificationQuestion).toBe('Which invoice do you mean?')
    expect(result.rewrittenQuery).toBe('invoice for acme corp')
    expect(result.entities).toEqual({ topic: 'invoice', document_type: 'invoice' })
    expect(result.confidence).toBe(0.9)
  })

  test('handles markdown code-fenced JSON from LLM', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      '```json\n{"needsRetrieval": false, "needsClarification": false, "confidence": 0.8}\n```',
    )

    const result = await analyzeIntent({
      question: 'hello',
      hasDocuments: true,
      hasIntegrations: true,
    })

    expect(result.needsRetrieval).toBe(false)
    expect(result.needsClarification).toBe(false)
    expect(result.confidence).toBe(0.8)
  })

  test('falls back to default on LLM error', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => {
      throw new Error('LLM connection failed')
    })

    const result = await analyzeIntent({
      question: 'test',
      hasDocuments: true,
      hasIntegrations: false,
    })

    expect(result.needsRetrieval).toBe(true) // hasDocuments || hasIntegrations
    expect(result.needsClarification).toBe(false)
    expect(result.confidence).toBe(0)
  })

  test('falls back to default on malformed JSON', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => 'this is not valid json')

    const result = await analyzeIntent({
      question: 'test',
      hasDocuments: false,
      hasIntegrations: false,
    })

    // parseIntentJson catch returns needsRetrieval: true (always)
    expect(result.needsRetrieval).toBe(true)
    expect(result.needsClarification).toBe(false)
    expect(result.confidence).toBe(0)
  })

  test('uses default confidence=0.5 when JSON missing confidence field', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ needsRetrieval: true, needsClarification: false }),
    )

    const result = await analyzeIntent({
      question: 'test',
      hasDocuments: true,
      hasIntegrations: true,
    })

    expect(result.confidence).toBe(0.5)
  })
})

// --- Async tests: rewriteQuery ---

describe('rewriteQuery', () => {
  test('returns original query when no chat history', async () => {
    const result = await rewriteQuery({ question: 'how do I apply for leave?' })
    expect(result).toBe('how do I apply for leave?')
    expect(mockChatOnce).not.toHaveBeenCalled()
  })

  test('returns original query when no LLM configured', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)

    const result = await rewriteQuery({
      question: 'what is the procedure?',
      chatHistory: [{ role: 'user', content: 'tell me about annual leave' }],
    })

    expect(result).toBe('what is the procedure?')
  })

  test('returns rewritten query from LLM', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => 'procedure for annual leave')

    const result = await rewriteQuery({
      question: 'what is the procedure?',
      chatHistory: [
        { role: 'user', content: 'tell me about annual leave' },
        { role: 'assistant', content: 'annual leave is 12 days per year' },
      ],
    })

    expect(result).toBe('procedure for annual leave')
  })

  test('strips surrounding quotes from rewritten query', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '"procedure for annual leave"')

    const result = await rewriteQuery({
      question: 'what is the procedure?',
      chatHistory: [{ role: 'user', content: 'tell me about annual leave' }],
    })

    expect(result).toBe('procedure for annual leave')
  })

  test('falls back to original on LLM error', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => {
      throw new Error('LLM error')
    })

    const result = await rewriteQuery({
      question: 'what is the procedure?',
      chatHistory: [{ role: 'user', content: 'tell me about annual leave' }],
    })

    expect(result).toBe('what is the procedure?')
  })

  test('falls back to original on empty LLM response', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '   ')

    const result = await rewriteQuery({
      question: 'what is the procedure?',
      chatHistory: [{ role: 'user', content: 'tell me about annual leave' }],
    })

    expect(result).toBe('what is the procedure?')
  })
})

// --- Async tests: evaluateEvidenceSufficiency ---

describe('evaluateEvidenceSufficiency', () => {
  test('returns insufficient when evidence is empty', async () => {
    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: '',
    })

    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('No evidence retrieved')
    expect(result.confidence).toBe(1.0)
  })

  test('returns insufficient when evidence is very short (<50 chars)', async () => {
    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: 'A'.repeat(49),
    })

    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('Evidence too short')
    expect(result.confidence).toBe(0.8)
  })

  test('returns sufficient when no LLM configured (assumes sufficient)', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)

    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: 'A'.repeat(100),
    })

    expect(result.sufficient).toBe(true)
    expect(result.reason).toBe('No LLM for reflection — assuming sufficient')
    expect(result.confidence).toBe(0)
  })

  test('parses valid JSON response correctly', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ sufficient: false, reason: 'evidence is off-topic', confidence: 0.7 }),
    )

    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: 'A'.repeat(100),
    })

    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('evidence is off-topic')
    expect(result.confidence).toBe(0.7)
  })

  test('falls back to sufficient on LLM error', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => {
      throw new Error('LLM error')
    })

    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: 'A'.repeat(100),
    })

    expect(result.sufficient).toBe(true)
    expect(result.reason).toBe('Reflection failed — assuming sufficient')
    expect(result.confidence).toBe(0)
  })

  test('falls back to sufficient on malformed JSON', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => 'not valid json')

    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: 'A'.repeat(100),
    })

    expect(result.sufficient).toBe(true)
    expect(result.reason).toBe('Reflection failed — assuming sufficient')
    expect(result.confidence).toBe(0)
  })
})

// --- Async tests: retrieveWithReflection ---

describe('retrieveWithReflection', () => {
  test('returns merged chunks from expanded queries', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `chunk-${args.query}`, content: 'C'.repeat(100) })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: `graph-${args.query}`,
    }))

    const result = await retrieveWithReflection({ query: 'leave', topK: 5 })

    // 'leave' expands to 6, sliced to 3: ['leave', 'annual leave', 'vacation']
    expect(result.chunks.length).toBe(3)
    expect(result.chunks.some((c) => c.chunkId === 'chunk-leave')).toBe(true)
    expect(result.chunks.some((c) => c.chunkId === 'chunk-annual leave')).toBe(true)
    expect(result.chunks.some((c) => c.chunkId === 'chunk-vacation')).toBe(true)
    expect(result.retrievalPasses).toBe(1)
  })

  test('does multi-turn retrieval (2 passes) when reflection says insufficient', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ sufficient: false, reason: 'insufficient evidence', confidence: 0.9 }),
    )
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `chunk-${args.query}-${args.topK}`, content: 'D'.repeat(100) })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: '',
    }))

    const result = await retrieveWithReflection({ query: 'leave', topK: 5 })

    expect(result.retrievalPasses).toBe(2)
    // 3 calls (first pass expansions) + 1 call (second pass) = 4 total
    expect(mockRetrieveRelevantChunks.mock.calls.length).toBe(4)
    // Second pass should use 2x topK
    const secondPassCall = mockRetrieveRelevantChunks.mock.calls[3]
    expect(secondPassCall[0].topK).toBe(10)
  })

  test('does single pass when reflection says sufficient', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `chunk-${args.query}`, content: 'E'.repeat(100) })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: '',
    }))

    const result = await retrieveWithReflection({ query: 'leave', topK: 5 })

    expect(result.retrievalPasses).toBe(1)
    expect(mockRetrieveRelevantChunks.mock.calls.length).toBe(3)
  })

  test('returns reflection metadata (sufficient, reason, confidence)', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    mockRetrieveRelevantChunks.mockImplementation(async () => ({
      chunks: [makeChunk({ chunkId: 'c1', content: 'F'.repeat(100) })],
      queryTokens: ['test'],
      candidatesScanned: 1,
      graphContext: '',
    }))

    const result = await retrieveWithReflection({ query: 'leave', topK: 5 })

    expect(result.reflection).toHaveProperty('sufficient')
    expect(result.reflection).toHaveProperty('reason')
    expect(result.reflection).toHaveProperty('confidence')
    expect(typeof result.reflection.sufficient).toBe('boolean')
    expect(typeof result.reflection.reason).toBe('string')
    expect(typeof result.reflection.confidence).toBe('number')
    // No LLM → assumes sufficient
    expect(result.reflection.sufficient).toBe(true)
    expect(result.reflection.reason).toBe('No LLM for reflection — assuming sufficient')
  })

  test('handles empty retrieval results gracefully', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockRetrieveRelevantChunks.mockImplementation(async () => ({
      chunks: [],
      queryTokens: [],
      candidatesScanned: 0,
      graphContext: '',
    }))

    const result = await retrieveWithReflection({ query: 'leave', topK: 5 })

    expect(result.chunks).toEqual([])
    expect(result.retrievalPasses).toBe(1) // no second pass because merged.chunks.length === 0
    expect(result.reflection.sufficient).toBe(false) // empty evidence → insufficient
    expect(result.reflection.reason).toBe('No evidence retrieved')
  })

  test('caps expansions at MAX_EXPANSIONS (3)', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `chunk-${args.query}`, content: 'G'.repeat(100) })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: '',
    }))

    await retrieveWithReflection({ query: 'leave', topK: 5 })

    // 'leave' produces 6 expansions, sliced to MAX_EXPANSIONS=3
    expect(mockRetrieveRelevantChunks.mock.calls.length).toBe(3)
  })
})
