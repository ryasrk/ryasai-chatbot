/**
 * Arm P2 — the production hybrid retriever: vector leg + BM25 lexical leg, fused
 * with the production RRF. Phase 1 of docs/entity-hop-retrieval-plan.md.
 *
 * WHY THIS EXISTS
 * ----------------------------------------------------------------------------
 * `retrieveAndFuse` (src/lib/rag-retrieval.ts) is what the product actually ships
 * and it has never been measured on this benchmark, so nobody knows whether a new
 * algorithm has room to win. This arm reproduces that ranking offline and imports
 * the production pure functions — `bm25Rank`, `fuseRankings`, `toRanking`, `RRF_K`
 * (src/lib/rag-ranking.ts) and `tokenize` (src/lib/rag.ts) — instead of
 * re-implementing them, so the row measures the product's code, not a copy that
 * can drift.
 *
 * DIFFERENCES FROM PRODUCTION — stated because each one changes the number
 * ----------------------------------------------------------------------------
 * 1. CANDIDATE POOL. Production truncates both legs before fusion: FTS returns
 *    `max(topK*8, 24)` ids, the vector store `max(topK*8, 16)` hits, and
 *    `bm25Rank` scores only that union. Offline there is no FTS table, so the
 *    lexical leg BM25-ranks the WHOLE corpus. This is not automatically the
 *    "bigger pool is stronger" arm it looks like — under RRF a long lexical tail
 *    is nearly inert, and measured on the held-out split the two pool choices sit
 *    within ~0.01 recall@10 (whole corpus 0.2020 vs truncated pool 0.2140).
 *    Whole corpus is used because it is the honest reading of "no FTS table".
 * 2. NO RERANKER. Production re-ranks the fused head by default
 *    (`RAG_LLM_RERANK !== 'false'` → `dispatchRerank`); this arm stops at fusion.
 * 3. NO KNOWLEDGE-GRAPH LEG. Production appends a cognee `kgRanking` when the
 *    graph answers; offline there is no graph, so fusion is two rankings.
 * 4. NO KEYWORD FIELD. Production's BM25 tokens are `tokenize(content)` plus the
 *    chunk's extracted `keywords`; the corpus carries text only.
 * 5. NO PER-DOCUMENT CAP, AND THAT IS A NO-OP HERE. Production's last step is
 *    `selectTopRetrievedChunks(.., maxPerDocument = 2)`, which drops a chunk once
 *    its document already has two selected. Each benchmark document is one
 *    retrieval unit, so a document's second chunk never appears and the cap
 *    cannot fire. Fused order and the cap order are therefore the same list.
 *
 * `ready()` is false unless BOTH document and query vectors are present, so the
 * harness reports NOT COMPUTABLE rather than printing a lexical-only score under
 * a hybrid label. A question missing from the cache throws, never degrades.
 */
import type { Arm, ArmContext } from '../arm-types'
import { RRF_K, bm25Rank, fuseRankings, toRanking } from '@/lib/rag-ranking'
// ponytail: src/lib/rag.ts pulls in @/lib/embeddings, which opens a DB handle on
// import. The import SUCCEEDS, but the process then never exits on its own —
// every script that imports this module must end with process.exit(code).
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

// Keyed on the context object: one corpus per run, one rank() call per question,
// so rebuilding the tokenised index inside rank() would dominate the timing.
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

export const arm: Arm = {
  id: 'hybrid-rrf',
  kind: 'hybrid',

  ready: (ctx) =>
    Boolean(ctx.embeddings && Object.keys(ctx.embeddings).length > 0) &&
    Boolean(ctx.queryEmbeddings && Object.keys(ctx.queryEmbeddings).length > 0),

  rank: (question, ctx, budget) => {
    const queryVector = ctx.queryEmbeddings?.[question] ?? ctx.queryEmbeddings?.[question.trim()]
    if (!queryVector) {
      // Loud, not silent: a hybrid result computed without the vector leg would be
      // reported as P2 and understate the product.
      throw new Error(`hybrid-rrf has no query vector for ${JSON.stringify(question.slice(0, 80))}`)
    }
    const index = buildIndex(ctx)
    // Production's pool depth: the vector store asks for max(topK*8, 16), and
    // topK is the budget here because this arm has no rerank stage widening it.
    const wanted = Math.max(budget * 8, 16)
    const lexicalRanking = toRanking(bm25Rank(tokenize(question), index.docs))
    const fused = fuseRankings([vectorRanking(index, unit(queryVector), wanted), lexicalRanking], RRF_K)
    return fused.slice(0, budget).map((entry) => entry.id)
  },
}
