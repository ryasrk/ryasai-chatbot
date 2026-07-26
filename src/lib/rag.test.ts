import { describe, expect, test } from 'bun:test'
import {
  applySemanticScore,
  chunkText,
  scoreChunk,
  selectTopRetrievedChunks,
  sortRetrievedChunks,
  tokenize,
} from './rag'

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
