import { describe, expect, test, mock } from 'bun:test'
import { buildCitationTrail } from './citation-trail'
import type { DualLevelResult } from '@/lib/knowledge-graph'
import type { RetrievedChunk } from '@/lib/rag'

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))

function makeChunk(chunkId: string, content: string, score = 0.8): RetrievedChunk {
  return {
    chunkId, documentId: 'doc', documentName: 'doc.txt', chunkIndex: 0,
    content, score,
    scoreBreakdown: { total: score, lexicalTotal: 0, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 },
  }
}

const EMPTY_KG: DualLevelResult = {
  localChunks: [], globalChunks: [], allChunkIds: [], matchedEntities: [], graphContext: '',
}

describe('buildCitationTrail', () => {
  test('returns empty for empty KG result', () => {
    const trails = buildCitationTrail('query', EMPTY_KG, [makeChunk('c1', 'content')])
    expect(trails).toEqual([])
  })

  test('builds trails from local KG matches', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1'], globalChunks: [], allChunkIds: ['c1'],
      matchedEntities: ['alice'], graphContext: '',
    }
    const chunks = [makeChunk('c1', 'Alice works at the company')]
    const trails = buildCitationTrail('who is alice', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].entity).toBe('alice')
    expect(trails[0].relation).toBe('local entity match')
    expect(trails[0].chunkId).toBe('c1')
    expect(trails[0].relevance).toBeGreaterThan(0)
  })

  test('builds trails from global KG matches with relations', () => {
    const kg: DualLevelResult = {
      localChunks: [], globalChunks: ['c2'], allChunkIds: ['c2'],
      matchedEntities: ['bob'],
      graphContext: 'Knowledge Graph Relations:\n[bob] → manages → [alice]',
    }
    const chunks = [makeChunk('c2', 'Bob manages the team including alice')]
    const trails = buildCitationTrail('who does bob manage', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].entity).toBe('bob')
    expect(trails[0].relation).toBe('manages')
    expect(trails[0].relevance).toBeLessThanOrEqual(0.85)
  })

  test('handles multiple entities and chunks', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1', 'c2'], globalChunks: ['c3'], allChunkIds: ['c1', 'c2', 'c3'],
      matchedEntities: ['alice', 'bob'],
      graphContext: 'Knowledge Graph Relations:\n[alice] → reports to → [bob]',
    }
    const chunks = [
      makeChunk('c1', 'Alice is a developer', 0.9),
      makeChunk('c2', 'Bob is a manager', 0.7),
      makeChunk('c3', 'Alice reports to Bob for reviews', 0.6),
    ]
    const trails = buildCitationTrail('alice bob', kg, chunks)
    expect(trails).toHaveLength(3)
    expect(trails[0].relevance).toBeGreaterThanOrEqual(trails[2].relevance)
  })

  test('skips chunks not in retrieved set', () => {
    const kg: DualLevelResult = {
      localChunks: ['c1', 'c9'], globalChunks: [], allChunkIds: ['c1', 'c9'],
      matchedEntities: ['alice'], graphContext: '',
    }
    const chunks = [makeChunk('c1', 'Alice content')]
    const trails = buildCitationTrail('alice', kg, chunks)
    expect(trails).toHaveLength(1)
    expect(trails[0].chunkId).toBe('c1')
  })
})
