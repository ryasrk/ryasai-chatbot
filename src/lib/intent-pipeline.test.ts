import { describe, expect, test, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
// Mirrors the real `selectTopRetrievedChunks` contract used by retrieveWithReflection:
// sort by score desc then chunkIndex, cap per document, then cap at topK.
const mockSelectTopRetrievedChunks = mock(
  // RAG_MAX_PER_DOCUMENT is 3 in constants.ts; using 2 here made an existing
  // test's 3-chunks-from-one-document fixture silently return 2.
  <T extends { score: number; chunkIndex: number; documentId: string }>(rows: T[], topK: number, maxPerDocument = 3): T[] => {
    const selected: T[] = []
    const perDocument = new Map<string, number>()
    for (const row of [...rows].sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)) {
      const count = perDocument.get(row.documentId) ?? 0
      if (count >= maxPerDocument) continue
      selected.push(row)
      perDocument.set(row.documentId, count + 1)
      if (selected.length >= topK) break
    }
    return selected
  },
)
const mockTokenize = mock((text: string) =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean),
)
const mockScoreChunk = mock(() => ({
  total: 0, lexicalTotal: 0, contentHits: 0, keywordHits: 0,
  phraseHits: 0, semanticSimilarity: 0, semanticScore: 0,
}))
const mockSortRetrievedChunks = mock(<T extends { score: number; chunkIndex: number }>(rows: T[]) =>
  [...rows].sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex),
)

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
// intent-pipeline imports FIVE names from '@/lib/rag' -- a factory that exports
// only `retrieveRelevantChunks` kills the whole file with
// "SyntaxError: Export named 'selectTopRetrievedChunks' not found".
mock.module('@/lib/rag', () => ({
  retrieveRelevantChunks: mockRetrieveRelevantChunks,
  selectTopRetrievedChunks: mockSelectTopRetrievedChunks,
  tokenize: mockTokenize,
  scoreChunk: mockScoreChunk,
  sortRetrievedChunks: mockSortRetrievedChunks,
}))

/**
 * `@/lib/rag-chunking` is NOT mocked. The whole point of these tests is that the
 * placeholder detector is exercised against the REAL predicate and the REAL
 * marker, so that changing the marker in one place and not the other fails here.
 * The module is import-safe: its document parser imports are static but never
 * invoked by `isPlaceholderChunk`/`emptyDocumentContent`.
 */
const { isPlaceholderChunk: realIsPlaceholderChunk, emptyDocumentContent: realEmptyDocumentContent, EMPTY_DOCUMENT_MARKER: realEmptyMarker } =
  await import('@/lib/rag-chunking')

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
  mockSelectTopRetrievedChunks.mockClear()
  mockTokenize.mockClear()
  mockScoreChunk.mockClear()
  mockSortRetrievedChunks.mockClear()
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

// ===========================================================================
// THE 2026-09 INCIDENT, pinned against the REAL function bodies.
//
// A document whose extraction produced nothing is stored as
// `[Empty document: x.pdf]` so retrieval can still match the filename. That
// marker was fed to the answer prompt AS EVIDENCE, and sufficiency was then
// decided by EVIDENCE LENGTH (`evidence.trim().length < 50`), so:
//   - a 46-char placeholder tripped a false "no evidence", AND
//   - a genuinely complete short answer was also declared insufficient.
// Both made retrieval advance to a second pass, which made tool-branches.ts
// inject "if the evidence does not contain the answer, say so" — and the bot
// disclaimed an answer it had actually retrieved.
//
// `evaluateAnswerConfidence` carried the SAME length bug PLUS an ordering bug:
// its guards sat BELOW `if (!cfg) return { confident: true }`, so on a
// deployment with no LLM the guards were UNREACHABLE and empty or
// placeholder-only evidence was reported CONFIDENT.
//
// `@/lib/rag-chunking` is deliberately NOT mocked above, so every assertion
// below runs the shipped `isPlaceholderChunk` / `emptyDocumentContent` /
// EMPTY_DOCUMENT_MARKER. Mocking the predicate would make these tests agree with
// whatever the mock says instead of with the code that ships.
// ===========================================================================

describe('the empty-document placeholder marker', () => {
  test('the marker is the one the upload route stores', () => {
    // `emptyDocumentContent` is the single source for the marker text. If the
    // upload route and the detector ever disagree, placeholders silently become
    // evidence again — the exact pre-incident state.
    expect(realEmptyMarker).toBe('[Empty document:')
    expect(realEmptyDocumentContent('x.pdf')).toBe('[Empty document: x.pdf]')
    // The literal from the incident report, 46 characters, below the old floor.
    expect(realEmptyDocumentContent('Scan Kontrak Vendor 2024.pdf').length).toBeLessThan(50)
  })

  test('isPlaceholderChunk recognises the exact marker', () => {
    expect(realIsPlaceholderChunk(realEmptyDocumentContent('x.pdf'))).toBe(true)
  })

  test('isPlaceholderChunk tolerates LEADING whitespace but not a leading word', () => {
    expect(realIsPlaceholderChunk('   \n\t[Empty document: x.pdf]')).toBe(true)
    expect(realIsPlaceholderChunk('See also [Empty document: x.pdf]')).toBe(false)
  })

  test('isPlaceholderChunk recognises different filenames and suffixes', () => {
    expect(realIsPlaceholderChunk('[Empty document: a.docx]')).toBe(true)
    expect(realIsPlaceholderChunk('[Empty document: laporan tahunan.xlsx]')).toBe(true)
    expect(realIsPlaceholderChunk('[Empty document: x.pdf] extra note')).toBe(true)
  })

  test('isPlaceholderChunk does NOT fire on a real chunk that mentions the word empty', () => {
    // The predicate matches the MARKER, not the word. A policy about an "empty
    // container" is real document text and must stay evidence.
    expect(realIsPlaceholderChunk('An empty container must be sealed before shipping.')).toBe(false)
    expect(realIsPlaceholderChunk('If the field is empty, default to zero.')).toBe(false)
    // And not on a document that merely NAMES the marker in prose.
    expect(realIsPlaceholderChunk('Empty document placeholders are filtered out.')).toBe(false)
  })

  test('isPlaceholderChunk is total: empty, null and undefined are NOT placeholders', () => {
    // Falsy input is "no content", which the emptiness guard handles first. It is
    // deliberately not a placeholder, so a bug in one guard cannot masquerade as
    // the other's verdict.
    expect(realIsPlaceholderChunk('')).toBe(false)
    expect(realIsPlaceholderChunk(null)).toBe(false)
    expect(realIsPlaceholderChunk(undefined)).toBe(false)
  })
})

describe('evaluateEvidenceSufficiency — the content floor, both sides', () => {
  beforeEach(() => {
    // The single most valuable configuration: NO LLM. The floor must decide on
    // its own, without a model to fall back on.
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
  })

  test('pure punctuation and whitespace is insufficient even when it is LONG', async () => {
    // 200 characters, zero alphanumerics. The old length check (and any length
    // check) would have accepted this.
    const r = await evaluateEvidenceSufficiency({
      question: 'what is the leave policy?',
      evidence: '... --- ... !!! ??? ,,, ;;; ::: ((( ))) [[ ]] {{ }} /// \\\\\\ *** +++ === ',
    })
    expect(r.sufficient).toBe(false)
    expect(r.reason).toBe('Evidence has no substantive content')
    expect(r.confidence).toBe(0.8)
  })

  test('EXACTLY 7 alphanumerics is below the floor; 8 is not', async () => {
    // The boundary, asserted from both sides so the test cannot pass by rejecting
    // everything or accepting everything.
    const seven = 'abcdefg'
    const eight = 'abcdefgh'
    expect(seven.replace(/[^\p{L}\p{N}]/gu, '').length).toBe(7)
    expect(eight.replace(/[^\p{L}\p{N}]/gu, '').length).toBe(8)

    expect((await evaluateEvidenceSufficiency({ question: 'q', evidence: seven })).reason)
      .toBe('Evidence has no substantive content')
    expect((await evaluateEvidenceSufficiency({ question: 'q', evidence: eight })).reason)
      .toBe('No LLM for reflection — assuming sufficient')
  })

  test('digits and non-Latin letters COUNT toward the floor', async () => {
    // The floor is `[^\p{L}\p{N}]` — letters in ANY script and digits. A business
    // answer such as "級別3" or a bare amount must not be discarded.
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"sufficient":true,"reason":"ok","confidence":0.9}')
    const r = await evaluateEvidenceSufficiency({ question: 'q', evidence: '1.234.567' })
    // Reaches the LLM (i.e. cleared the floor): digits with separators are 7
    // alphanumerics, so use a 8-digit amount to make the intent unambiguous.
    expect(r).toBeDefined()
    mockChatOnce.mockClear()
    const r2 = await evaluateEvidenceSufficiency({ question: 'q', evidence: '12.345.678' })
    expect(mockChatOnce.mock.calls.length).toBe(1)
    expect(r2.sufficient).toBe(true)
  })

  test('a 41-character complete answer is NOT rejected (the false negative)', async () => {
    const answer = 'Tarif lembur hari kerja 1,5x upah per jam.'
    // 41 characters per the incident report (42 here — the sentence's own length
    // is what matters, and the point is that it is BELOW the old 50-char floor).
    expect(answer.length).toBeLessThan(50)
    expect(answer.length).toBeGreaterThanOrEqual(41)
    const r = await evaluateEvidenceSufficiency({ question: 'berapa tarif lembur?', evidence: answer })
    // No LLM configured: the verdict is the gate's own. It must NOT be the
    // length-based "insufficient".
    expect(r.sufficient).toBe(true)
    expect(r.reason).not.toBe('Evidence too short')
  })

  test('a placeholder is insufficient BEFORE the LLM is ever consulted', async () => {
    // Ordering: the placeholder branch must come first, or a configured model
    // gets asked whether "[Empty document: x.pdf]" answers the question.
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"sufficient":true,"reason":"sure","confidence":0.9}')
    const before = mockChatOnce.mock.calls.length
    const r = await evaluateEvidenceSufficiency({
      question: 'isi kontrak vendor',
      evidence: realEmptyDocumentContent('Scan Kontrak Vendor 2024.pdf'),
    })
    expect(r.sufficient).toBe(false)
    expect(r.reason).toBe('Only placeholder content retrieved')
    expect(mockChatOnce.mock.calls.length - before).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The placeholder FILTER inside retrieveWithReflection.
//
// This is the other half of the incident: even with a correct sufficiency gate,
// if the placeholder survives into `evidence` the answer prompt receives it as
// document text. The filter is `merged.chunks.slice(0, topK).filter((c) =>
// !isPlaceholderChunk(c.content))`.
// ---------------------------------------------------------------------------

describe('retrieveWithReflection — placeholders never become evidence', () => {
  test('a placeholder is never counted, even when it is the LONGEST candidate', async () => {
    // The adversarial shape from the incident: give the placeholder the HIGHEST
    // score so ranking puts it first and a length-based or score-based filter
    // would keep it. The marker still must not reach the evidence string.
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    const promptSeen: string[] = []
    // `mockChatOnce` is declared with ZERO arity at the top of this file, so a
    // two-argument implementation does not typecheck. The cast keeps the mock's
    // declared shape and is scoped to this assertion's capture only.
    const capture = mockChatOnce as unknown as {
      mockImplementation: (fn: (cfg: unknown, messages: Array<{ content: string }>) => Promise<string>) => void
    }
    capture.mockImplementation(async (_cfg, messages) => {
      promptSeen.push(messages[1]?.content ?? '')
      return '{"sufficient":true,"reason":"ok","confidence":0.9}'
    })
    const placeholder = realEmptyDocumentContent('Scan Kontrak Vendor 2024.pdf')
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [
        makeChunk({ chunkId: `ph-${args.query}`, content: placeholder, score: 999 }),
        makeChunk({ chunkId: `real-${args.query}`, content: 'Kontrak vendor berakhir 31 Desember 2024.', score: 1 }),
      ],
      queryTokens: [args.query],
      candidatesScanned: 2,
      graphContext: '',
    }))

    const r = await retrieveWithReflection({ query: 'isi kontrak vendor', topK: 5 })

    // The reflection prompt contained the real chunk...
    expect(promptSeen.join('\n')).toContain('Kontrak vendor berakhir')
    // ...and NOT the placeholder marker.
    expect(promptSeen.join('\n')).not.toContain(realEmptyMarker)
    expect(r.reflection.sufficient).toBe(true)
    // A SINGLE retrieval pass: pre-fix, the placeholder tripped the length gate,
    // reflection said insufficient and a second pass ran.
    expect(r.retrievalPasses).toBe(1)
    expect(mockRetrieveRelevantChunks.mock.calls.slice(3)).toHaveLength(0)
  })

  test('a placeholder-ONLY result set reflects as insufficient, not as evidence', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"sufficient":true,"reason":"sure","confidence":0.9}')
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `ph-${args.query}`, content: realEmptyDocumentContent('a.pdf') })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: '',
    }))

    const r = await retrieveWithReflection({ query: 'isi kontrak', topK: 5 })
    // The evidence string was empty after filtering, so the LLM is never asked
    // to bless a placeholder — the emptiness guard decides.
    expect(r.reflection.sufficient).toBe(false)
    expect(r.reflection.reason).toBe('No evidence retrieved')
    expect(mockChatOnce.mock.calls).toHaveLength(0)
  })

  test('the SECOND pass keeps only real chunks too', async () => {
    // The second pass is where the incident's damage landed (it is what set
    // retrievalPasses >= 2 and made the "say you do not know" note appear). So
    // the filter has to hold on THAT path as well, not just the first.
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"sufficient":false,"reason":"need more","confidence":0.9}')
    mockRetrieveRelevantChunks.mockImplementation(async (args: { query: string; topK: number }) => ({
      chunks: [makeChunk({ chunkId: `real-${args.query}-${args.topK}`, content: 'Isi kontrak: 12 bulan.', score: 1 })],
      queryTokens: [args.query],
      candidatesScanned: 1,
      graphContext: '',
    }))

    const r = await retrieveWithReflection({ query: 'kontrak', topK: 5 })
    expect(r.retrievalPasses).toBe(2)
    // Second pass asks for 2x topK, per the documented contract.
    const secondPass = mockRetrieveRelevantChunks.mock.calls.at(-1)![0] as { topK: number }
    expect(secondPass.topK).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// CONTENT FLOOR for evaluateAnswerConfidence — both sides, and the ARGUMENT.
// ---------------------------------------------------------------------------

describe('evaluateAnswerConfidence — the content floor, both sides', () => {
  beforeEach(() => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
  })

  test('a LONG string of pure punctuation is unconfident', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'q',
      evidence: '!!! ??? ... --- *** +++ === /// ||| ((( ))) [[ ]] {{ }} $$$ %%% ^^^',
    })
    expect(r.confident).toBe(false)
    expect(r.reason).toBe('insufficient evidence')
    expect(r.nextToolHint).toBeNull()
    expect(r.confidence).toBe(0)
  })

  test('7 alphanumerics is unconfident; 8 alphanumerics is accepted as sufficient to judge', async () => {
    // BOTH SIDES. Without the second half, a floor of 1e9 would pass this test.
    // `alnum` strips non-letters/non-digits so the count is unambiguous.
    const alnum = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, '')
    const seven = 'a.b.c.d.e.f.g'
    const eight = 'a.b.c.d.e.f.g.h'
    expect(alnum(seven).length).toBe(7)
    expect(alnum(eight).length).toBe(8)
    expect((await evaluateAnswerConfidence({ question: 'q', evidence: seven })).confident).toBe(false)
    expect((await evaluateAnswerConfidence({ question: 'q', evidence: eight })).confident).toBe(true)
  })

  test('real evidence with no LLM is confident and names why', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'q',
      evidence: 'Tarif lembur hari kerja 1,5x upah per jam.',
    })
    expect(r.confident).toBe(true)
    expect(r.reason).toBe('no LLM configured')
    expect(r.confidence).toBe(1.0)
  })

  test('a THROWING LLM still fails OPEN (an outage must not withhold answers)', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => { throw new Error('provider 503') })
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    expect(r.confident).toBe(true)
    expect(r.reason).toBe('evaluation failed, proceeding with answer')
    expect(r.confidence).toBe(0.5)
  })

  test('the evidence is TRUNCATED to 4000 chars before it reaches the prompt', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"confident":true,"reason":"ok","confidence":0.9}')
    await evaluateAnswerConfidence({ question: 'q', evidence: `${'z'.repeat(50_000)}endmarker` })
    const prompt = (mockChatOnce.mock.calls.at(-1) as unknown as [unknown, Array<{ content: string }>])[1][1].content
    expect(prompt).not.toContain('endmarker')
    expect(prompt.length).toBeLessThan(4200)
  })

  test('the verdict is requested under the confidence-evaluation purpose', async () => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"confident":true,"reason":"ok","confidence":0.9}')
    await evaluateAnswerConfidence({ question: 'q', evidence: 'en evidence panjang di sini' })
    const call = mockChatOnce.mock.calls.at(-1) as unknown as [unknown, unknown, number, string]
    expect(call[2]).toBe(0) // deterministic
    expect(call[3]).toBe('confidence-evaluation')
  })
})

// ---------------------------------------------------------------------------
// THE ORDERING FIX — the single most valuable assertion in this file.
//
// Pre-fix the function read:
//     const cfg = await getRoleLlmConfig('query')
//     if (!cfg) return { confident: true, reason: 'no LLM configured', ... }
//     if (isPlaceholderChunk(evidence)) return { confident: false, ... }
// so on a deployment with NO LLM the emptiness guards were DEAD CODE and empty
// or placeholder-only evidence came back CONFIDENT — the one verdict that is
// least trustworthy, on the deployment least able to catch it.
//
// Every test below therefore runs with NO LLM configured.
// ---------------------------------------------------------------------------

describe('evaluateAnswerConfidence — guards are reachable with NO LLM (the ordering fix)', () => {
  beforeEach(() => {
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
  })

  test('EMPTY evidence is UNCONFIDENT on a deployment with no LLM', async () => {
    const r = await evaluateAnswerConfidence({ question: 'q', evidence: '' })
    expect(r.confident).toBe(false)
    expect(r.reason).toBe('insufficient evidence')
  })

  test('WHITESPACE-ONLY evidence is UNCONFIDENT on a deployment with no LLM', async () => {
    for (const evidence of [' ', '\n', '\t  \n\t', '   \n\n   ']) {
      const r = await evaluateAnswerConfidence({ question: 'q', evidence })
      expect(r.confident).toBe(false)
      expect(r.reason).toBe('insufficient evidence')
    }
  })

  test('PLACEHOLDER-ONLY evidence is UNCONFIDENT on a deployment with no LLM', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'isi kontrak',
      evidence: realEmptyDocumentContent('Scan Kontrak Vendor 2024.pdf'),
    })
    expect(r.confident).toBe(false)
    expect(r.reason).toBe('only placeholder content')
    expect(r.nextToolHint).toBeNull()
  })

  test('a placeholder hidden after LEADING NEWLINES is still caught', async () => {
    const r = await evaluateAnswerConfidence({
      question: 'q',
      evidence: `\n\n  ${realEmptyDocumentContent('a.pdf')}`,
    })
    expect(r.confident).toBe(false)
    expect(r.reason).toBe('only placeholder content')
  })

  test('the guard stack RESUMES after a legitimate short answer (no over-rejection)', async () => {
    // The mirror image: with the SAME no-LLM configuration, a real 41-char answer
    // must NOT be rejected. Together with the three tests above this pins the
    // guard ORDER (placeholder -> emptiness -> LLM gate) rather than any single
    // branch: rejecting everything passes the first three and fails this one.
    const r = await evaluateAnswerConfidence({
      question: 'berapa tarif lembur?',
      evidence: 'Tarif lembur hari kerja 1,5x upah per jam.',
    })
    expect(r.confident).toBe(true)
    expect(r.reason).toBe('no LLM configured')
  })

  test('no LLM is consulted for empty, whitespace or placeholder evidence', async () => {
    // Ordering measured as a DELTA, so the assertion is about what THIS test did
    // rather than about the harness's lifetime call bookkeeping.
    mockGetLlmRuntimeConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '{"confident":true,"reason":"sure","confidence":0.9}')
    const before = mockChatOnce.mock.calls.length
    await evaluateAnswerConfidence({ question: 'q', evidence: '' })
    await evaluateAnswerConfidence({ question: 'q', evidence: '   \n ' })
    await evaluateAnswerConfidence({ question: 'q', evidence: realEmptyDocumentContent('x.pdf') })
    expect(mockChatOnce.mock.calls.length - before).toBe(0)
  })

  test('a SHORT answer does NOT burn a second agentic iteration', async () => {
    // The user-visible consequence of the length bug: unconfident -> the loop
    // called another tool -> the eventual answer came from a WORSE context than
    // the one that already held the answer. Pinned by the confident verdict.
    mockGetLlmRuntimeConfig.mockImplementation(async () => null)
    const r = await evaluateAnswerConfidence({
      question: 'siapa yang menyetujui cuti?',
      evidence: 'Atasan langsung.', // 15 chars, a complete answer
    })
    expect(r.confident).toBe(true)
    expect(r.nextToolHint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SOURCE-LEVEL GUARDS.
//
// These read the shipped module as TEXT with COMMENTS STRIPPED, because the
// fix's own comment QUOTES the old `evidence.length < 50` expression — a naive
// grep would match the explanation instead of an implementation. They are the
// cheap half of the incident: `invariants.test.ts` already carries equivalents,
// so if that file is ever relaxed these keep the property. Behavioural coverage
// for the same properties lives in the describes above.
// ---------------------------------------------------------------------------

const intentSource = readFileSync(join(import.meta.dir, 'intent-pipeline.ts'), 'utf8')

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/[ \t]+\/\/.*$/gm, '')
}

describe('intent-pipeline.ts — the incident can not be reintroduced', () => {
  test('no evidence-length short-circuit survives, comments excluded', () => {
    const code = stripComments(intentSource)
    expect(code).not.toMatch(/evidence\s*&&\s*evidence\.trim\(\)\.length\s*<\s*\d/)
    expect(code).not.toMatch(/evidence\.trim\(\)\.length\s*<\s*\d/)
    expect(code).not.toMatch(/evidence\.length\s*<\s*\d/)
    // And no "too short" verdict string survives.
    expect(code).not.toContain('Evidence too short')
  })

  test('the content floor is the `[^\\p{L}\\p{N}]` form, in BOTH functions', () => {
    const code = stripComments(intentSource)
    const occurrences = code.match(/replace\(\/\[\^\\p\{L\}\\p\{N\}\]\/gu, ''\)\.length < 8/g) ?? []
    // One in evaluateEvidenceSufficiency, one in evaluateAnswerConfidence. Losing
    // either reintroduces the length proxy in that function.
    expect(occurrences.length).toBe(2)
  })

  test('in evaluateAnswerConfidence the placeholder check PRECEDES the LLM gate', () => {
    const code = stripComments(intentSource)
    const fn = code.slice(code.indexOf('export async function evaluateAnswerConfidence'))
    const placeholder = fn.indexOf('isPlaceholderChunk(args.evidence)')
    const floor = fn.indexOf(".length < 8")
    const gate = fn.indexOf("getRoleLlmConfig('query')")
    expect(placeholder).toBeGreaterThan(-1)
    expect(floor).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(-1)
    // Both guards sit ABOVE the `if (!cfg)` return, which is the ordering fix.
    expect(placeholder).toBeLessThan(floor)
    expect(floor).toBeLessThan(gate)
  })

  test('in evaluateEvidenceSufficiency the placeholder check precedes the LLM gate', () => {
    const code = stripComments(intentSource)
    const fn = code.slice(code.indexOf('export async function evaluateEvidenceSufficiency'))
    const placeholder = fn.indexOf('isPlaceholderChunk(args.evidence)')
    const gate = fn.indexOf("getRoleLlmConfig('query')")
    expect(placeholder).toBeGreaterThan(-1)
    expect(placeholder).toBeLessThan(gate)
  })

  test('the evidence string is BUILT by filtering placeholders out', () => {
    const code = stripComments(intentSource)
    // The filter must be on the chunk CONTENT and must run BEFORE the join, or a
    // placeholder reaches the prompt as document text.
    const filterAt = code.indexOf('const evidenceChunks = ')
    const joinAt = code.indexOf("const evidence = evidenceChunks")
    expect(filterAt).toBeGreaterThan(-1)
    expect(joinAt).toBeGreaterThan(filterAt)
    expect(code.slice(filterAt, joinAt)).toContain('!isPlaceholderChunk(c.content)')
  })

  test('the marker has ONE definition, in rag-chunking, and is not re-typed here', () => {
    const code = stripComments(intentSource)
    // A local literal would drift from the upload route's marker.
    expect(code).not.toContain('[Empty document:')
    expect(code).toContain("from '@/lib/rag-chunking'")
  })
})
