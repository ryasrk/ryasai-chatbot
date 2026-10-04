import { getOrgContext } from './prisma-tenant'

/**
 * Lexical ranking (Okapi BM25) + rank fusion (Reciprocal Rank Fusion).
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * Retrieval used to rank with:
 *
 *   lexical = contentHits + keywordHits*2 + phraseHits*3      // unbounded count
 *   total   = lexical + cosineSimilarity*12                   // capped at 12
 *
 * Two things are wrong with that. Raw term counts have no IDF (a hit on "the
 * policy" counts the same as a hit on "npwp") and no length normalisation (a
 * long chunk wins by volume). And adding an unbounded integer to a 0-12 float
 * means the lexical leg dominates: for a 4-token query, phrase hits alone can
 * contribute 18, so cosine similarity is a tiebreaker rather than a ranking
 * signal — "hybrid search" that is really keyword search with a nudge.
 *
 * BM25 fixes the first. RRF fixes the second by fusing on RANK instead of
 * score, so retrievers with incommensurable scales combine without any
 * hand-tuned weight. Both are pure functions over ids, which also makes adding
 * a fourth retriever a one-line change at the call site.
 */

interface CorpusStats {
  df: Map<string, number>
  n: { total: number }
}
// Each org owns its statistics. Limit retained corpora; eviction falls back to
// pool-local IDF and never changes the ownership of another org's statistics.
const corpora = new Map<string, CorpusStats>()
export function getCorpusStats(): CorpusStats {
  const orgId = getOrgContext()
  if (!orgId) return { df: new Map(), n: { total: 0 } }
  let stats = corpora.get(orgId)
  if (!stats) {
    if (corpora.size >= 100) corpora.delete(corpora.keys().next().value!)
    stats = { df: new Map(), n: { total: 0 } }
    corpora.set(orgId, stats)
  }
  return stats
}

export function resetCorpusStats(): void {
  corpora.clear()
}

// Standard Okapi parameters. k1 controls term-frequency saturation, b controls
// how strongly length normalisation applies.
const K1 = 1.2
const B = 0.75

export interface Bm25Doc {
  id: string
  /** Tokenised text, already lowercased/stopworded by rag.tokenize. Duplicates matter. */
  tokens: string[]
}

export interface RankedId {
  id: string
  score: number
}

/**
 * Score `docs` against `queryTokens` with Okapi BM25, best first.
 *
 * ponytail: IDF is computed over the CANDIDATE POOL, not the whole corpus — no
 * extra query, no df bookkeeping, and within a pool the relative rarity of a
 * term is what decides the ordering anyway. Ceiling: a term common in the pool
 * but rare corpus-wide gets under-weighted. Upgrade to real corpus df (one
 * grouped count query per search, or a maintained stats table) if evaluation
 * shows pool-local IDF mis-ranking.
 */
export function bm25Rank(queryTokens: string[], docs: Bm25Doc[]): RankedId[] {
  if (queryTokens.length === 0 || docs.length === 0) return []

  const n = docs.length
  const lengths = docs.map((doc) => doc.tokens.length)
  const avgdl = lengths.reduce((sum, len) => sum + len, 0) / n || 1

  // Term frequency per doc + document frequency per query term, in one pass.
  const uniqueQueryTokens = [...new Set(queryTokens)]
  const termFreqs: Array<Map<string, number>> = docs.map((doc) => {
    const freq = new Map<string, number>()
    for (const token of doc.tokens) freq.set(token, (freq.get(token) ?? 0) + 1)
    return freq
  })

  // Corpus-level df when we have it (populated by the FTS rebuild from ts_stat);
  // pool-local otherwise. Corpus stats see the whole org's corpus, so a term
  // that is rare overall but happens to be in every pool document keeps its
  // discriminating weight instead of collapsing toward 0.
  const { df: CORPUS_DF, n: CORPUS_N } = getCorpusStats()
  const corpusAvailable = CORPUS_DF.size > 0 && CORPUS_N.total > n
  const resolveCorpusDf = (token: string, poolDf: number): { df: number; n: number } =>
    corpusAvailable && CORPUS_DF.has(token)
      ? { df: CORPUS_DF.get(token) ?? 0, n: CORPUS_N.total }
      : { df: poolDf, n }

  const poolDocFreq = new Map<string, number>()
  for (const token of uniqueQueryTokens) {
    let df = 0
    for (const freq of termFreqs) if (freq.has(token)) df += 1
    poolDocFreq.set(token, df)
  }

  const scored: RankedId[] = docs.map((doc, index) => {
    const freq = termFreqs[index]
    const docLength = lengths[index] || 1
    let score = 0
    for (const token of uniqueQueryTokens) {
      const tf = freq.get(token) ?? 0
      if (tf === 0) continue
      const { df, n: nEff } = resolveCorpusDf(token, poolDocFreq.get(token) ?? 0)
      if (df <= 0) continue
      // Smoothed IDF — the +0.5 terms keep it positive even when every doc in
      // the pool contains the term (the unsmoothed form goes negative there).
      const idf = Math.log(1 + (nEff - df + 0.5) / (df + 0.5))
      const denom = tf + K1 * (1 - B + (B * docLength) / avgdl)
      score += idf * ((tf * (K1 + 1)) / denom)
    }
    return { id: doc.id, score }
  })

  return scored.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score)
}

/**
 * Reciprocal Rank Fusion (Cormack et al. 2009).
 *
 *   fused(d) = Σ over retrievers  1 / (k + rank(d))
 *
 * `rankings` is a list of ordered id lists, best first. A document missing from
 * a retriever simply contributes nothing for it — no imputation, no penalty.
 *
 * k dampens the head so a single retriever's #1 cannot run away with the result;
 * 60 is the value from the paper and the de-facto default in Elasticsearch and
 * Vespa. Absolute fused scores are tiny (~0.016 for a lone rank-1 hit) and only
 * meaningful relative to each other — never mix them with a raw score.
 */
export const RRF_K = 60

export function fuseRankings(rankings: string[][], k: number = RRF_K): RankedId[] {
  const fused = new Map<string, number>()
  for (const ranking of rankings) {
    ranking.forEach((id, index) => {
      // rank is 1-based; index 0 is the top hit.
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + index + 1))
    })
  }
  return [...fused.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Version of the ranking stored in the cache. Bump it whenever the ORDER a query
 * produces changes, so entries written by the previous ranking are never served:
 * the cached value is that order, and a TTL-long mix of old and new orders would
 * make a ranking change unmeasurable.
 */
export const RANKING_VERSION = 'lex2' // bump when `lexicalFirst` or its tokens change

/**
 * Lexical-first combination: the BM25 order is kept intact and vector-only hits are
 * appended after it, in similarity order.
 *
 * WHY NOT RRF. Measured on the app's own documents and on the synthetic benchmark
 * (docs/retrieval-production-integration-plan.md §11-12), every RRF variant ranked
 * BELOW BM25 alone — answer@1 0.4628 at the shipped k=60, 0.6364 at the best k, against
 * 0.9504 for BM25 — because fusion lets a weak vector leg (vector alone: answer@1
 * 0.2149) demote the lexical #1. A weighted RRF (lexical ×4) still lost (0.6281).
 * Appending cannot demote a lexical hit, so it is never worse than BM25 on what BM25
 * finds, while the vector leg still recovers documents BM25 misses entirely (a
 * paraphrased question with no shared term).
 *
 * `score` is a descending rank value (1 for the head), NOT a similarity: it exists so
 * callers that sort or merge by score keep this order.
 */
export function lexicalFirst(lexicalRanking: string[], vectorRanking: string[], poolSlots?: number): RankedId[] {
  if (poolSlots !== undefined) {
    return quotaFuse(lexicalRanking.map((id) => ({ id, score: 0 })), vectorRanking, poolSlots)
  }
  const ordered: string[] = []
  const seen = new Set<string>()
  for (const id of [...lexicalRanking, ...vectorRanking]) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered.map((id, index) => ({ id, score: 1 / (index + 1) }))
}

/**
 * Reserve candidate slots for both retrievers before the reranker judges relevance.
 * Lexical order remains first within the selected pool; overlapping hits consume
 * one slot, and an exhausted retriever gives its remaining slots to the other.
 */
export function quotaFuse(
  lexicalScored: RankedId[],
  semanticRanking: string[],
  totalSlots: number,
): RankedId[] {
  const slots = Number.isFinite(totalSlots) ? Math.max(0, Math.floor(totalSlots)) : 0
  if (!slots) return []
  const lexical = [...new Set(lexicalScored.map((entry) => entry.id))]
  const semantic = [...new Set(semanticRanking)]
  const selected = new Set<string>()
  const quota = Math.ceil(slots / 2)
  for (const id of lexical.slice(0, quota)) selected.add(id)
  for (const id of semantic.slice(0, slots - selected.size)) selected.add(id)
  for (const id of lexicalFirst(lexical, semantic).map((entry) => entry.id)) {
    if (selected.size >= slots) break
    selected.add(id)
  }
  return lexicalFirst(lexical, semantic)
    .filter((entry) => selected.has(entry.id))
    .map((entry, index) => ({ id: entry.id, score: 1 / (index + 1) }))
}

/** Ids of a scored list in rank order — the shape fuseRankings consumes. */
export function toRanking(scored: RankedId[]): string[] {
  return scored.map((entry) => entry.id)
}
