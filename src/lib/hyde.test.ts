import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockChatOnce = mock(async () => '')
const mockGetRoleLlmConfig = mock(async (): Promise<unknown> => null)

mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: mockGetRoleLlmConfig,
  getLlmRuntimeConfig: mockGetRoleLlmConfig,
}))

import {
  generateHypotheticalDocument,
  isComplexQuery,
  decomposeQuery,
  mergeRetrievedResults,
} from './hyde'
import type { RetrievedChunk } from '@/lib/rag'

const MOCK_CONFIG = { id: 'c', provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://x', apiKey: 'k', model: 'm' }

function makeChunk(id: string, score = 1): RetrievedChunk {
  return {
    chunkId: id, documentId: 'd', documentName: 'd.txt', chunkIndex: 0,
    content: id, score,
    scoreBreakdown: { total: 1, lexicalTotal: 1, contentHits: 0, keywordHits: 0, phraseHits: 0, semanticSimilarity: 0, semanticScore: 0 },
  }
}

beforeEach(() => {
  mockChatOnce.mockClear()
  mockGetRoleLlmConfig.mockClear()
  mockChatOnce.mockImplementation(async () => '')
  mockGetRoleLlmConfig.mockImplementation(async () => null)
})

describe('isComplexQuery', () => {
  test('simple query → false', () => {
    expect(isComplexQuery('what is the leave policy')).toBe(false)
  })
  test('"and" → true', () => {
    expect(isComplexQuery('sales and marketing')).toBe(true)
  })
  test('"vs" → true', () => {
    expect(isComplexQuery('python vs java')).toBe(true)
  })
  test('"compared to" → true', () => {
    expect(isComplexQuery('react compared to vue')).toBe(true)
  })
  test('"difference between" → true', () => {
    expect(isComplexQuery('difference between sql and nosql')).toBe(true)
  })
})

describe('decomposeQuery', () => {
  test('simple query returns single-element array', () => {
    expect(decomposeQuery('what is the leave policy')).toEqual(['what is the leave policy'])
  })

  test('splits "X and Y" into two sub-queries', () => {
    const result = decomposeQuery('sales revenue and marketing spend')
    expect(result).toHaveLength(2)
    expect(result[0]).toBe('sales revenue')
    expect(result[1]).toBe('marketing spend')
  })

  test('caps at 3 sub-queries', () => {
    const result = decomposeQuery('alpha and beta and gamma and delta')
    expect(result.length).toBeLessThanOrEqual(3)
  })

  test('"difference between X and Y" → [X, Y]', () => {
    const result = decomposeQuery('difference between annual leave and sick leave')
    expect(result).toEqual(['annual leave', 'sick leave'])
  })

  test('"X compared to Y" → [X, Y]', () => {
    const result = decomposeQuery('aws compared to gcloud pricing')
    expect(result).toEqual(['aws', 'gcloud pricing'])
  })

  test('"X vs Y" → [X, Y]', () => {
    const result = decomposeQuery('postgres vs mysql performance')
    expect(result).toEqual(['postgres', 'mysql performance'])
  })

  test('filters out very short fragments', () => {
    const result = decomposeQuery('a and real query here')
    expect(result.every((r) => r.length > 2)).toBe(true)
  })
})

describe('generateHypotheticalDocument', () => {
  test('returns original query when no LLM configured', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => null)
    const result = await generateHypotheticalDocument('what is the policy')
    expect(result).toBe('what is the policy')
    expect(mockChatOnce).not.toHaveBeenCalled()
  })

  test('returns LLM-generated hypothetical answer', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => 'The leave policy allows 12 days annual leave per year.')
    const result = await generateHypotheticalDocument('what is the leave policy')
    expect(result).toBe('The leave policy allows 12 days annual leave per year.')
  })

  test('falls back to query on LLM error', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => { throw new Error('boom') })
    const result = await generateHypotheticalDocument('what is the leave policy')
    expect(result).toBe('what is the leave policy')
  })

  test('falls back to query on empty LLM response', async () => {
    mockGetRoleLlmConfig.mockImplementation(async () => MOCK_CONFIG)
    mockChatOnce.mockImplementation(async () => '   ')
    const result = await generateHypotheticalDocument('what is the leave policy')
    expect(result).toBe('what is the leave policy')
  })
})

describe('mergeRetrievedResults', () => {
  test('dedupes by chunkId keeping highest score', () => {
    const merged = mergeRetrievedResults([
      { chunks: [makeChunk('c1', 3), makeChunk('c2', 5)], queryTokens: ['a'], candidatesScanned: 10, graphContext: 'g1' },
      { chunks: [makeChunk('c1', 7)], queryTokens: ['b'], candidatesScanned: 5, graphContext: 'g2' },
    ])
    expect(merged.chunks.map((c) => c.chunkId)).toEqual(['c1', 'c2'])
    expect(merged.chunks[0].score).toBe(7)
    expect(merged.queryTokens.sort()).toEqual(['a', 'b'])
    expect(merged.candidatesScanned).toBe(15)
    expect(merged.graphContext).toBe('g1\n\ng2')
  })

  test('handles empty input', () => {
    const merged = mergeRetrievedResults([])
    expect(merged.chunks).toEqual([])
    expect(merged.candidatesScanned).toBe(0)
  })
})
