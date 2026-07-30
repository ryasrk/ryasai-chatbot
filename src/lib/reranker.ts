import { scopedLogger } from '@/lib/logger'
import type { RetrievedChunk } from '@/lib/rag'
const log = scopedLogger('reranker')

/**
 * Pluggable cross-encoder reranker (e.g. bge-reranker, Jina, Cohere rerank).
 * Env-configured: RERANKER_URL points to an HTTP /rerank endpoint.
 * When unset or on error, returns null so the caller falls back to the LLM reranker.
 *
 * Expected request:  { query, documents: [{ text }] }
 * Expected response: { scores: [number] } or [number]  (one float per document)
 */
export async function crossEncoderRerank(
  query: string,
  chunks: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[] | null> {
  const url = process.env.RERANKER_URL
  if (!url) return null
  if (chunks.length === 0) return chunks

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        documents: chunks.map((c) => ({ text: c.content.slice(0, 512) })),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      log.warn('cross-encoder rerank HTTP error', { status: res.status })
      return null
    }
    const data = (await res.json()) as { scores?: number[] } | number[]
    const scores = Array.isArray(data) ? data : data.scores
    if (!Array.isArray(scores) || scores.length === 0) return null

    const scored = chunks
      .map((chunk, i) => ({ chunk, score: typeof scores[i] === 'number' ? scores[i] : -Infinity }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s) => s.chunk)

    return scored.length > 0 ? scored : null
  } catch (e) {
    log.warn('cross-encoder rerank failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}
