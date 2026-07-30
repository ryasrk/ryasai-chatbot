import type { RetrievedChunk } from '@/lib/rag'

/**
 * HyDE (Hypothetical Document Embeddings) + sub-query decomposition.
 *
 * HyDE: generate a hypothetical answer to the query, embed THAT instead of the
 * raw query for vector similarity (improves recall — the hypothetical answer is
 * closer in embedding space to real answers than the question is).
 *
 * Sub-query decomposition: split complex multi-part questions into sub-queries,
 * retrieve for each in parallel, merge. Heuristic-based (no LLM cost).
 */

export async function generateHypotheticalDocument(query: string): Promise<string> {
  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('keyword')
    if (!cfg) return query
    const raw = await chatOnce(
      cfg,
      [
        { role: 'system', content: 'Generate a short hypothetical answer (2-3 sentences) to the question. This will be embedded for semantic search. Output only the answer, no preamble.' },
        { role: 'user', content: query },
      ],
      0,
      'hyde',
    )
    return raw.trim() || query
  } catch {
    return query
  }
}

const COMPLEX_RE = /\b(and|vs|versus)\b/i

export function isComplexQuery(query: string): boolean {
  const lower = query.toLowerCase()
  if (/\bcompared to\b/.test(lower)) return true
  if (/difference between/.test(lower)) return true
  return COMPLEX_RE.test(query)
}

export function decomposeQuery(query: string): string[] {
  if (!isComplexQuery(query)) return [query]

  const diffMatch = query.match(/difference between (.+?) and (.+)/i)
  if (diffMatch) return [diffMatch[1].trim(), diffMatch[2].trim()].filter((s) => s.length > 2)

  const cmpMatch = query.match(/(.+?) compared to (.+)/i)
  if (cmpMatch) return [cmpMatch[1].trim(), cmpMatch[2].trim()].filter((s) => s.length > 2)

  if (/\band\b/i.test(query)) {
    const parts = query.split(/\s+and\s+/i).map((p) => p.trim()).filter((p) => p.length > 2)
    if (parts.length >= 2) return parts.slice(0, 3)
  }

  if (/\bvs\b|\bversus\b/i.test(query)) {
    const parts = query.split(/\s+(?:vs|versus)\s+/i).map((p) => p.trim()).filter((p) => p.length > 2)
    if (parts.length >= 2) return parts.slice(0, 3)
  }

  return [query]
}

/** Merge multiple retrieval results — dedupe by chunkId keeping highest score. */
export function mergeRetrievedResults(
  results: Array<{ chunks: RetrievedChunk[]; queryTokens: string[]; candidatesScanned: number; graphContext: string }>,
): { chunks: RetrievedChunk[]; queryTokens: string[]; candidatesScanned: number; graphContext: string } {
  const seen = new Map<string, RetrievedChunk>()
  for (const r of results) {
    for (const chunk of r.chunks) {
      const existing = seen.get(chunk.chunkId)
      if (!existing || chunk.score > existing.score) seen.set(chunk.chunkId, chunk)
    }
  }
  return {
    chunks: [...seen.values()].sort((a, b) => b.score - a.score),
    queryTokens: [...new Set(results.flatMap((r) => r.queryTokens))],
    candidatesScanned: results.reduce((sum, r) => sum + r.candidatesScanned, 0),
    graphContext: results.map((r) => r.graphContext).filter(Boolean).join('\n\n'),
  }
}
