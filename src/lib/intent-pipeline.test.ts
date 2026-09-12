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
  evaluateAnswerConfidence,
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

  // REGRESSION (2026-09 cross-lingual trial): this test previously certified the
  // BUG as correct —
  //   expandQuery('cuti') -> ['cuti']   "not a key — not expanded"
  // Documents are routinely English while users ask Indonesian, and `tokenize`
  // is exact-match, so an Indonesian query could never reach an English corpus.
  // Measured impact: 5 of 11 Indonesian questions retrieved ZERO chunks with the
  // answer sitting in the corpus (58% overall vs 100% for English phrasing).
  // A query already in the target language must NOT be "expanded" (that would
  // just add noise), but the reverse direction must work.
  test('leaves an English token out of the REVERSE map (forward expansion still applies)', () => {
    // 'leave' IS an English key, so forward expansion to its Indonesian synonyms
    // is the original intended behaviour and must be preserved. What must NOT
    // happen is the reverse index treating an English key as an Indonesian term
    // and translating it into itself/other concept keys.
    const r = expandQuery('leave')
    expect(r).toContain('annual leave')
    expect(r).toContain('cuti')
  })

  test('expands an Indonesian term to the English concept the corpus contains', () => {
    const result = expandQuery('cuti')
    expect(result).toContain('leave')
    expect(result[0]).toBe('cuti')
  })

  test('translates a whole Indonesian query so English content words dominate', () => {
    // Single-token substitution alone produces mixed-language strings
    // ("berapa tarif lembur pada day kerja?") that still match nothing, so the
    // translator emits one FULLY translated variant.
    const result = expandQuery('Berapa tarif lembur pada hari kerja?')
    const translated = result.find((r) => r.includes('overtime') && r.includes('rate'))
    expect(translated).toBeDefined()
    expect(translated).not.toMatch(/lembur|tarif/)
  })

  test('resolves an ambiguous word to its primary concept, not a phrase member', () => {
    // "hari" is the exact synonym of `day`, but also occurs inside "hari libur"
    // (= holiday). Sub-splitting the phrase once made "Berapa hari proses
    // refund…" translate to "…holiday processing refund…", which retrieved
    // nothing — a measured regression (refund-processing hit -> miss).
    const translated = expandQuery('Berapa hari proses refund setelah retur disetujui?')
      .find((r) => r.includes('processing'))
    expect(translated).toBeDefined()
    expect(translated).toContain('day')
    expect(translated).not.toContain('holiday')
  })

  test('never returns duplicates or the original query twice', () => {
    for (const q of ['Berapa tarif lembur pada hari kerja?', 'cuti tahunan', 'leave policy']) {
      const r = expandQuery(q)
      expect(new Set(r).size).toBe(r.length)
      expect(r.filter((x) => x === q).length).toBe(1)
    }
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

  // ponytail: this prompt once accumulated literal ' + / \n' + string-concat
  // artifacts (from a pasted template) that were sent to the LLM verbatim,
  // garbling follow-up intent detection. Keep the prompt text clean.
  test('system prompt contains no string-concatenation artifacts', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ needsRetrieval: true, needsClarification: false, confidence: 0.9 }),
    )

    await analyzeIntent({
      question: 'what is the leave policy?',
      hasDocuments: true,
      hasIntegrations: true,
    })

    const firstCall = (mockChatOnce.mock.calls as unknown as Array<
      [unknown, Array<{ role: string; content: string }>]
    >)[0]
    const sysMsg = firstCall?.[1]?.find((m) => m.role === 'system')
    expect(sysMsg).toBeDefined()
    expect(sysMsg!.content).toContain('schema summaries')
    expect(sysMsg!.content).not.toContain("' +")
    expect(sysMsg!.content).not.toContain("\\n' +")
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

  // --- the anti-nag guard ------------------------------------------------
  // This is the fix for the "chatbot asks endless clarification" bug, and only
  // its NEGATIVE case was covered: the test above uses a question with no query
  // indicator to prove the guard does NOT fire. The branch where it DOES fire —
  // the actual fix — had never executed.
  test('a QUERY INDICATOR overrides a clarification request when data sources exist', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({
        needsRetrieval: true,
        needsClarification: true,
        clarificationQuestion: 'Which database?',
        confidence: 0.9,
      }),
    )
    const result = await analyzeIntent({
      question: 'how many invoices are there?',
      hasDocuments: false,
      hasIntegrations: true,
    })
    // The model wanted to ask "which database?" even though the system
    // auto-selects an integration. Asking anyway is the nag; the guard drops it.
    expect(result.needsClarification).toBe(false)
    expect(result.clarificationQuestion).toBeUndefined()
  })

  test('an Indonesian query indicator overrides it too', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ needsRetrieval: true, needsClarification: true, clarificationQuestion: 'DB mana?', confidence: 0.9 }),
    )
    // The indicator list carries Indonesian words ('berapa', 'jumlah', 'daftar').
    // A Latin-only check would have missed the primary user language.
    const result = await analyzeIntent({ question: 'berapa jumlah invoice?', hasDocuments: false, hasIntegrations: true })
    expect(result.needsClarification).toBe(false)
  })

  test('a SCHEMA TERM overrides it even with no query indicator word', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ needsRetrieval: true, needsClarification: true, clarificationQuestion: 'which table?', confidence: 0.9 }),
    )
    const result = await analyzeIntent({
      question: 'give me the outstanding_balance',
      hasDocuments: false,
      hasIntegrations: true,
      schemaSummaries: ['invoices(id, outstanding_balance)'],
    })
    // Naming a real column is a data query even without 'show'/'count' in it.
    expect(result.needsClarification).toBe(false)
  })

  test('with NO data sources the clarification is RESPECTED', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () =>
      JSON.stringify({ needsRetrieval: true, needsClarification: true, clarificationQuestion: 'Which database?', confidence: 0.9 }),
    )
    const result = await analyzeIntent({
      question: 'how many invoices are there?',
      hasDocuments: false,
      hasIntegrations: false,
    })
    // The guard must not swallow a genuine question when there is nothing to
    // query: with no data source, "which database?" is not a nag, it is the only
    // sensible thing to say.
    expect(result.needsClarification).toBe(true)
    expect(result.clarificationQuestion).toBe('Which database?')
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

  // REGRESSION (2026-09 trial): this block used to assert
  //   evidence: 'A'.repeat(49) -> insufficient, reason 'Evidence too short'
  // i.e. it certified a length-based verdict as correct. Measured against a real
  // knowledge base that heuristic produced FALSE NEGATIVES — "Tarif lembur hari
  // kerja 1,5x upah per jam." (41 chars) is a complete answer, yet was judged
  // insufficient, which advanced retrieval to a second pass and made
  // tool-branches.ts inject "if the evidence doesn't contain the answer, say
  // so". The bot then disclaimed an answer it had actually retrieved. Length is
  // not a proxy for sufficiency; the model decides, and only a content-free
  // string is short-circuited.
  test('does NOT reject short-but-substantive evidence (the false negative)', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)

    const result = await evaluateEvidenceSufficiency({
      question: 'berapa tarif lembur?',
      evidence: 'Tarif lembur hari kerja 1,5x upah per jam.',
    })

    // With no LLM the gate assumes sufficient — the point is that it did NOT
    // short-circuit to insufficient on length alone.
    expect(result.sufficient).toBe(true)
    expect(result.reason).not.toBe('Evidence too short')
  })

  test('returns insufficient when evidence is a placeholder (no document text)', async () => {
    const result = await evaluateEvidenceSufficiency({
      question: 'isi kontrak vendor',
      evidence: '[Empty document: Scan Kontrak Vendor 2024.pdf]',
    })

    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('Only placeholder content retrieved')
  })

  test('returns insufficient when evidence has no substantive content at all', async () => {
    const result = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: '... --- ...',
    })

    expect(result.sufficient).toBe(false)
    expect(result.reason).toBe('Evidence has no substantive content')
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

// ---------------------------------------------------------------------------
// evaluateAnswerConfidence had NO tests before this block, which is why a
// second copy of the length heuristic survived in it while the same bug was
// fixed in evaluateEvidenceSufficiency. It matters MORE here: this verdict drives
// the agentic loop's "call another tool" decision.
// ---------------------------------------------------------------------------
describe('evaluateAnswerConfidence', () => {
  beforeEach(() => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
  })

  test('does NOT reject a short-but-complete answer on length', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'berapa tarif lembur?',
      evidence: 'Tarif lembur hari kerja 1,5x upah per jam.',
    })

    expect(r.reason).not.toBe('insufficient evidence')
  })

  test('returns unconfident for a placeholder', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'isi kontrak',
      evidence: '[Empty document: Scan Kontrak.pdf]',
    })

    expect(r.confident).toBe(false)
    expect(r.reason).toBe('only placeholder content')
  })

  test('returns unconfident for empty evidence', async () => {
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: '' })
    expect(r.confident).toBe(false)
  })

  test('returns unconfident for content-free evidence', async () => {
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: '... --- ...' })
    expect(r.confident).toBe(false)
    expect(r.reason).toBe('insufficient evidence')
  })

  // --- the LLM path -------------------------------------------------------
  // Every test above sets the role config to null, so this function's REAL body
  // (the LLM call, the JSON parse, the error fallback) had never executed. The
  // short-circuits were tested; the thing they short-circuit PAST was not.
  const VERDICT = '{"confident":true,"reason":"answers it","nextToolHint":null,"confidence":0.9}'

  test('an LLM verdict is parsed into a ConfidenceResult', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => VERDICT)
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    expect(r.confident).toBe(true)
    expect(r.reason).toBe('answers it')
    expect(r.confidence).toBe(0.9)
  })

  test('a JSON fenced in markdown is still parsed', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    // Models routinely wrap JSON in a fence despite being told not to; failing on
    // that would fall into the catch and report a bogus confident verdict.
    mockChatOnce.mockImplementation(async () => '```json\n' + VERDICT + '\n```')
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    expect(r.confident).toBe(true)
    expect(r.reason).toBe('answers it')
  })

  test('a not-confident verdict carries its tool hint through', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () =>
      '{"confident":false,"reason":"needs data","nextToolHint":"SQL","confidence":0.3}')
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    // The hint is what makes the agentic loop call a DIFFERENT tool next round.
    expect(r.confident).toBe(false)
    expect(r.nextToolHint).toBe('SQL')
  })

  test('an unparseable answer falls back to CONFIDENT rather than blocking', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => 'I think this is probably good enough?')
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    // Deliberate: failing open means a broken evaluator costs an extra loop, not a
    // withheld answer. Failing closed would strand the user with nothing.
    expect(r.confident).toBe(true)
    expect(r.reason).toContain('evaluation failed')
  })

  test('an LLM that throws falls back to CONFIDENT too', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => { throw new Error('provider 503') })
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    expect(r.confident).toBe(true)
    expect(r.reason).toContain('evaluation failed')
  })

  test('the evidence is TRUNCATED before it reaches the prompt', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => VERDICT)
    await evaluateAnswerConfidence({ question: 'q', evidence: 'z'.repeat(9000) })
    const messages = (mockChatOnce.mock.calls.at(-1) as unknown as [unknown, Array<{ content: string }>])[1]
    const userContent = messages[1].content
    // Unbounded evidence would blow the context window on a large document set.
    // 4000 characters of evidence plus the question line.
    expect(userContent.length).toBeLessThan(4200)
    expect(userContent).toContain('Question: q')
  })

  test('the verdict is requested for the CONFIDENCE purpose, not a generic one', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => VERDICT)
    await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    const lastCall = mockChatOnce.mock.calls.at(-1) as unknown as [unknown, unknown, number, string]
    // A stub or BYOK config that routes by purpose would otherwise send this to
    // the wrong model — the fourth argument must stay the role name.
    expect(lastCall[3]).toBe('confidence-evaluation')
  })

  test('evidence-emptiness is checked BEFORE the LLM is consulted', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => ({
      id: '1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm',
    }))
    mockChatOnce.mockImplementation(async () => VERDICT)
    // Measure the DELTA. An absolute not.toHaveBeenCalled() couples this test to
    // the harness's call bookkeeping; a delta measures only what this test did.
    const before = mockChatOnce.mock.calls.length
    await evaluateAnswerConfidence({ question: 'q', evidence: '' })
    // INCIDENT: these checks used to sit BELOW the config gate, so on a deployment
    // with no LLM configured, empty evidence was reported as confident — the one
    // verdict that is least trustworthy. Pinned by asserting no LLM call happened.
    expect(mockChatOnce.mock.calls.length - before).toBe(0)
  })
})
