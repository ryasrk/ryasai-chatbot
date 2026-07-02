import { describe, expect, test } from 'bun:test'
import {
  combineHybridScore,
  cosineSimilarity,
  parseEmbeddingResponse,
} from './embeddings'

describe('embedding helpers', () => {
  test('computes cosine similarity for normalized ranking', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBe(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0)
  })

  test('parses OpenAI-compatible and Ollama embedding responses', () => {
    expect(
      parseEmbeddingResponse('OPENAI_COMPATIBLE', {
        data: [{ embedding: [0.1, 0.2] }],
      }),
    ).toEqual([[0.1, 0.2]])

    expect(
      parseEmbeddingResponse('OLLAMA', {
        embeddings: [[0.3, 0.4]],
      }),
    ).toEqual([[0.3, 0.4]])
  })

  test('hybrid score keeps lexical base and adds semantic signal', () => {
    const hybrid = combineHybridScore({ lexicalTotal: 8, semanticSimilarity: 0.75 })

    expect(hybrid.total).toBeGreaterThan(8)
    expect(hybrid.semanticScore).toBeGreaterThan(0)
  })
})
