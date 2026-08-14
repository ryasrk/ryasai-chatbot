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

// ponytail: bilingual comparison markers. The old regexes were English-only
// ("and|vs|compared to|difference between") while the product's eval set and
// users are Indonesian — "selisih pendapatan Q1 dan Q2" never decomposed.
// Order matters in DIFF_PATTERNS: longer phrases first so "perbedaan antara"
// wins over a bare conjunction.
const DIFF_PATTERNS: RegExp[] = [
  /difference between (.+?) and (.+)/i,
  /perbedaan (?:antara |dari )?(.+?) (?:dengan|dan|terhadap) (.+)/i,
  /selisih (.+?) (?:dengan|dan|terhadap) (.+)/i,
  /(.+?) compared to (.+)/i,
  /(.+?) dibanding(?:kan)? (?:dengan )?(.+)/i,
]

/** Conjunctions a clause split may cut through (bilingual). */
const CLAUSE_SPLIT_RE = /\s+(?:and|dan|serta|vs\.?|versus)\s+/i

export function isComplexQuery(query: string): boolean {
  if (DIFF_PATTERNS.some((re) => re.test(query))) return true
  return CLAUSE_SPLIT_RE.test(query)
}

export function decomposeQuery(query: string): string[] {
  if (!isComplexQuery(query)) return [query]

  for (const re of DIFF_PATTERNS) {
    const m = query.match(re)
    if (m) {
      // >1 char, not >2: "selisih pendapatan Q1 dan Q2" legitimately yields the
      // short token "Q2" as a side — dropping it would lose half the comparison.
      const parts = [m[1], m[2]].map((s) => s.trim()).filter((s) => s.length > 1)
      if (parts.length === 2) return parts
    }
  }

  // vs/versus is an explicit comparison — a bare "A vs B" is exactly the case
  // decomposition is for, so no clause-length requirement here.
  const vsParts = query.split(/\s+(?:vs\.?|versus)\s+/i).map((p) => p.trim()).filter((p) => p.length > 2)
  if (vsParts.length >= 2) return vsParts.slice(0, 3)

  // Conjunction split — every part must be its own clause, not half a noun
  // phrase. "terms and conditions" / "syarat dan ketentuan" stay whole; a bare
  // word on either side means the conjunction was internal to a phrase.
  const parts = query.split(CLAUSE_SPLIT_RE).map((p) => p.trim())
  // ponytail: word count is the cheap proxy for "is this its own question".
  // Ceiling: an LLM splitter would handle "revenue and margin by region"
  // properly; add one when decomposition demonstrably beats single retrieval.
  if (parts.length >= 2 && parts.every(isStandaloneClause)) return parts.slice(0, 3)

  return [query]
}

/**
 * A sub-query worth its own retrieval pass. Two words is the line that separates
 * a real second question ("sales revenue and marketing spend") from half of a
 * noun phrase ("terms and conditions", "profit and loss statement",
 * "research and development budget") — in the latter, at least one side is a
 * single bare word.
 */
function isStandaloneClause(part: string): boolean {
  return part.split(/\s+/).filter(Boolean).length >= 2
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
