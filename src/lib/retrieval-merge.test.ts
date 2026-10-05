import { describe, expect, test } from 'bun:test'
import type { RetrievedChunk } from '@/lib/rag'
import { mergeRetrievalResults } from '@/lib/retrieval-merge'
import * as pipeline from '@/lib/intent-pipeline'

const chunk = (id: string, score: number) => ({ chunkId: id, score } as unknown as RetrievedChunk)
const result = (chunks: RetrievedChunk[], q: string) => ({ chunks, queryTokens: [q], candidatesScanned: chunks.length, graphContext: '' })

describe('mergeRetrievalResults (leaf module)', () => {
  test('a chunk more passes agree on ranks first; score breaks ties; the order is total', () => {
    const merged = mergeRetrievalResults([
      result([chunk('a', 1), chunk('shared', 0.5)], 'x'),
      result([chunk('b', 1), chunk('shared', 0.4)], 'y'),
    ])
    expect(merged.chunks.map((c) => c.chunkId)).toEqual(['shared', 'a', 'b'])
    expect(merged.queryTokens).toEqual(['x', 'y'])
    expect(merged.candidatesScanned).toBe(4)
  })

  test('intent-pipeline still exports the same function (public surface kept)', () => {
    expect(pipeline.mergeRetrievalResults).toBe(mergeRetrievalResults)
  })
})
