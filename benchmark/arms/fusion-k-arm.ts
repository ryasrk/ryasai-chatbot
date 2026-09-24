/**
 * Arm: the production hybrid at a CHOSEN RRF `k`.
 *
 * WHY THIS EXISTS — row 6 of docs/retrieval-production-integration-plan.md §6b.
 * ----------------------------------------------------------------------------
 * The plan's primary finding is that `RRF_K = 60` is nearly flat, so cross-leg
 * agreement outweighs a strong single-leg rank: offline the shipped pipeline scored
 * BELOW plain keyword search (recall@10 0.1502 vs 0.3148 synthetic; 0.9752 vs 1.0000
 * with a 36% MRR deficit on the app's own prose). That was measured at k=60 against a
 * few hand-picked alternatives; this arm makes `k` a swept parameter so the shape of
 * the tradeoff is visible per tier instead of being argued from two points.
 *
 * WHAT IT IS NOT
 * ----------------------------------------------------------------------------
 * This is an OFFLINE check, never the decision. It inherits every difference
 * `benchmark/arms/hybrid-arm.ts` documents against production — no reranker, no
 * knowledge-graph leg, no `keywords` field, whole-corpus lexical leg — and adding
 * reranking back is exactly what could rescue a mid-ranking hit.
 * `docs/retrieval-production-integration-plan.md` §6a (the product-surface A/B through
 * `/api/rag/evaluate`, three runs) is what decides shipping; this arm only says whether
 * the production result is PLAUSIBLE before eval budget is spent.
 *
 * Import behaviour: `@/lib/rag` opens a DB handle on import, so a script that loads this
 * module never exits on its own. Every runner must end with `process.exit(code)`.
 */
import type { Arm, ArmContext } from '../arm-types'
import { bm25Rank, fuseRankings, toRanking } from '@/lib/rag-ranking'
import { tokenize } from '@/lib/rag'

/** Unit-scale a vector, so cosine similarity is a plain dot product. */
function unit(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  return norm > 0 && Math.abs(norm - 1) > 1e-9 ? v.map((x) => x / norm) : v
}

interface Index {
  docs: Array<{ id: string; tokens: string[] }>
  vectors: Map<string, number[]>
}

// Keyed on the context object: one corpus per run, one rank() call per question, so
// rebuilding the tokenised index inside rank() would dominate the timing.
const indexes = new WeakMap<ArmContext, Index>()

function buildIndex(ctx: ArmContext): Index {
  const cached = indexes.get(ctx)
  if (cached) return cached
  const docs = ctx.docIds.map((id) => ({ id, tokens: tokenize(ctx.texts[id] ?? '') }))
  const vectors = new Map<string, number[]>()
  for (const id of ctx.docIds) {
    const vector = ctx.embeddings?.[id]
    if (vector?.length) vectors.set(id, unit(vector))
  }
  const index: Index = { docs, vectors }
  indexes.set(ctx, index)
  return index
}

/** Cosine top-k. Stable sort: equal scores keep corpus order, so it is reproducible. */
function vectorRanking(index: Index, query: number[], wanted: number): string[] {
  const scored: Array<{ id: string; score: number }> = []
  for (const { id } of index.docs) {
    const doc = index.vectors.get(id)
    if (!doc || doc.length !== query.length) continue
    let dot = 0
    for (let i = 0; i < doc.length; i++) dot += doc[i] * query[i]
    scored.push({ id, score: dot })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, wanted).map((entry) => entry.id)
}

/**
 * A hybrid arm at one `k`. The id names the value so a harness table is self-describing.
 *
 * `k` is passed to `fuseRankings` — the production function, with the production
 * signature — so the sweep measures the real fusion arithmetic and not a copy.
 */
export function makeFusionKArm(k: number): Arm {
  return {
    id: `hybrid-rrf-k${k}`,
    kind: 'hybrid',
    ready: (ctx) =>
      Boolean(ctx.embeddings && Object.keys(ctx.embeddings).length > 0) &&
      Boolean(ctx.queryEmbeddings && Object.keys(ctx.queryEmbeddings).length > 0),
    rank: (question, ctx, budget) => {
      const queryVector = ctx.queryEmbeddings?.[question] ?? ctx.queryEmbeddings?.[question.trim()]
      if (!queryVector) {
        // Loud, not silent: a hybrid result computed without the vector leg would be
        // reported as a hybrid score and understate the comparison.
        throw new Error(`hybrid-rrf-k${k} has no query vector for ${JSON.stringify(question.slice(0, 80))}`)
      }
      const index = buildIndex(ctx)
      // Production's pool depth: the vector store asks for max(topK*8, 16), and topK is
      // the budget here because this arm has no rerank stage widening it.
      const wanted = Math.max(budget * 8, 16)
      const lexicalRanking = toRanking(bm25Rank(tokenize(question), index.docs))
      const fused = fuseRankings([vectorRanking(index, unit(queryVector), wanted), lexicalRanking], k)
      return fused.slice(0, budget).map((entry) => entry.id)
    },
  }
}

/**
 * The swept values.
 *
 * Chosen to bracket the two regimes rather than to search finely: 1 is the lowest legal
 * value (pure `1/rank`), 60 is the shipped default, and 200 is flat enough that the two
 * legs are nearly interchangeable. The middle values exist because the tradeoff was
 * measured to be non-monotonic per tier — the easy tier wants a low k and the hard tier
 * was better at a higher one — so a two-point comparison would have hidden the shape.
 */
export const FUSION_K_CANDIDATES = [1, 5, 10, 20, 40, 60, 100, 200]

/** The shipped value, so a sweep can mark its own baseline. */
export const SHIPPED_K = 60
