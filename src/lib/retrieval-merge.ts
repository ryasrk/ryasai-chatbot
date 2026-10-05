/**
 * Merging several retrieval passes (query expansions, a reflection pass, the hops of a compound question) into one
 * candidate list. A leaf: split from `intent-pipeline.ts`, which re-exports it, so the compound-retrieval module can
 * use the same merge without importing the pipeline that calls it.
 */
import type { RetrievedChunk } from '@/lib/rag'

export interface RetrievalResult {
  chunks: RetrievedChunk[]
  queryTokens: string[]
  candidatesScanned: number
  graphContext: string
  citationTrail?: Array<{ entity: string; relation: string; chunkId: string; relevance: number }>
}

/**
 * Union of several retrieval passes, deduped by chunkId keeping the best score.
 *
 * Deliberately UNBOUNDED — callers must apply selectTopRetrievedChunks to the
 * result. 3 query expansions plus an optional second pass at 2x topK used to
 * reach the prompt whole, so a topK of 4 shipped ~20 chunks (~69K chars with
 * parent-doc prefixes): the cost of every RAG turn, and the best chunk buried
 * in the middle where models reliably miss it.
 */
export function mergeRetrievalResults(results: RetrievalResult[]): RetrievalResult {
  // MERGE BY AGREEMENT, NOT BY SCORE ALONE.
  //
  // `score` is per-QUERY, not cross-query: `lexicalFirst` assigns 1/(rank+1), so every pass
  // gives its own rank-1 chunk exactly 1.0. Sorting a merged pool by that number alone
  // therefore compares incomparable values, and every tie is resolved by Map insertion order
  // — which is to say arbitrarily. MEASURED on a compound question ("kapan pelatihan keamanan
  // informasi dilaksanakan dan berapa lama sertifikatnya berlaku?"): the ORIGINAL query
  // ranked 03-panduan-onboarding.md first and correctly, one synonym expansion ranked
  // 09-panduan-pelatihan first, and the merge put a third document (08-kebijakan-perjalanan-
  // dinas, which contains ZERO chunks about training) at rank 4 purely on tie order.
  //
  // So agreement is counted explicitly: a chunk found by more passes ranks above one found by
  // fewer, and the score only breaks ties WITHIN the same agreement count. That is the same
  // consensus principle RRF was reached for, applied where it actually helps.
  const agreement = new Map<string, number>()
  const seen = new Map<string, RetrievedChunk>()
  for (const r of results) {
    for (const chunk of r.chunks) {
      agreement.set(chunk.chunkId, (agreement.get(chunk.chunkId) ?? 0) + 1)
      const existing = seen.get(chunk.chunkId)
      if (!existing || chunk.score > existing.score) {
        seen.set(chunk.chunkId, chunk)
      }
    }
  }
  const chunks = [...seen.values()].sort(
    (a, b) =>
      (agreement.get(b.chunkId) ?? 0) - (agreement.get(a.chunkId) ?? 0) ||
      b.score - a.score ||
      // Final tie-break on chunkId, so the order is TOTAL. Two chunks the same number of
      // passes agreed on, with equal scores, must not depend on Map iteration order or the
      // result drifts between identical requests.
      a.chunkId.localeCompare(b.chunkId),
  )
  const queryTokens = [...new Set(results.flatMap((r) => r.queryTokens))]
  const candidatesScanned = results.reduce((sum, r) => sum + r.candidatesScanned, 0)
  const graphContext = results.map((r) => r.graphContext).filter(Boolean).join('\n\n')
  const citationTrail = results.flatMap((r) => r.citationTrail ?? [])
  return { chunks, queryTokens, candidatesScanned, graphContext, citationTrail: citationTrail.length > 0 ? citationTrail : undefined }
}
