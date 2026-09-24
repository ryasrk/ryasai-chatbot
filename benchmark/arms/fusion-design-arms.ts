/**
 * Candidate fusion DESIGNS, as opposed to candidate values of one constant.
 *
 * The `k` sweep showed that no RRF dampening makes the hybrid beat BM25 alone on the
 * app's own prose (best hybrid ans@1 0.6364 vs BM25 0.9504), while the synthetic corpus
 * has tiers where lexical matching finds nothing. So the question is structural: how
 * should a vector leg be allowed to change a BM25 ranking?
 *
 *   bm25-only        the control
 *   lex-first        BM25 order unchanged; vector-only hits are appended after it
 *   vec-fallback     BM25 when it finds anything, vector only when BM25 is empty
 *   weighted-w{N}    RRF with the lexical contribution multiplied by N (k = 60)
 *   lex-first-fill   BM25 head (up to its matches), vector fills remaining slots,
 *                    identical to lex-first except it stops BM25's weak tail from
 *                    crowding out strong vector hits: BM25 hits scoring below
 *                    `tailRatio` × the top score are moved behind the vector hits
 */
import type { Arm, ArmContext } from '../arm-types'
import { bm25Rank } from '@/lib/rag-ranking'
import { tokenize, tokenizeForScoring as scoringTokens } from '@/lib/rag'


/**
 * Corpus index: scoring tokens per document, plus unit-scaled vectors.
 *
 * Local to this file rather than shared with the shipped arm, because a comparison
 * harness that imported the shipped arm's index could inherit a bug from the thing it is
 * supposed to be testing. `tokenizeForScoring` is the production tokenizer, so the two
 * sides at least agree on what a term is.
 */
interface Index {
  docs: Array<{ id: string; tokens: string[] }>
  vectors: Map<string, number[]>
}

function unit(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  return norm > 0 && Math.abs(norm - 1) > 1e-9 ? v.map((x) => x / norm) : v
}

const indexes = new WeakMap<ArmContext, Index>()

function buildIndex(ctx: ArmContext): Index {
  const cached = indexes.get(ctx)
  if (cached) return cached
  const docs = ctx.docIds.map((id) => ({ id, tokens: scoringTokens(ctx.texts[id] ?? '') }))
  const vectors = new Map<string, number[]>()
  for (const id of ctx.docIds) {
    const vector = ctx.embeddings?.[id]
    if (vector?.length) vectors.set(id, unit(vector))
  }
  const index: Index = { docs, vectors }
  indexes.set(ctx, index)
  return index
}

/** Cosine top-k in similarity order. */
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

type Designer = (lex: Array<{ id: string; score: number }>, vec: string[], budget: number) => string[]

function dedupeConcat(...lists: string[][]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) for (const id of list) if (!seen.has(id)) { seen.add(id); out.push(id) }
  return out
}

function makeArm(id: string, design: Designer): Arm {
  return {
    id,
    kind: 'hybrid',
    ready: (ctx) =>
      Boolean(ctx.embeddings && Object.keys(ctx.embeddings).length > 0) &&
      Boolean(ctx.queryEmbeddings && Object.keys(ctx.queryEmbeddings).length > 0),
    rank: (question, ctx, budget) => {
      const q = ctx.queryEmbeddings?.[question] ?? ctx.queryEmbeddings?.[question.trim()]
      if (!q) throw new Error(`${id} has no query vector for ${JSON.stringify(question.slice(0, 80))}`)
      const index = buildIndex(ctx)
      const lex = bm25Rank(tokenize(question), index.docs)
      const vec = vectorRanking(index, unit(q), Math.max(budget * 8, 16))
      return design(lex, vec, budget).slice(0, budget)
    },
  }
}

export const lexFirst: Designer = (lex, vec) => dedupeConcat(lex.map((e) => e.id), vec)

export const vecFallback: Designer = (lex, vec) => (lex.length > 0 ? lex.map((e) => e.id) : vec)

export function weighted(w: number, k = 60): Designer {
  return (lex, vec) => {
    const score = new Map<string, number>()
    vec.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1)))
    lex.forEach((e, i) => score.set(e.id, (score.get(e.id) ?? 0) + w / (k + i + 1)))
    return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  }
}

export function lexFirstFill(tailRatio: number): Designer {
  return (lex, vec) => {
    const top = lex[0]?.score ?? 0
    const strong = lex.filter((e) => e.score >= top * tailRatio).map((e) => e.id)
    const weak = lex.filter((e) => e.score < top * tailRatio).map((e) => e.id)
    return dedupeConcat(strong, vec, weak)
  }
}

export const bm25Only: Designer = (lex) => lex.map((e) => e.id)

export const vectorOnly: Designer = (_lex, vec) => vec

export const DESIGN_ARMS: Arm[] = [
  makeArm('bm25-only', bm25Only),
  makeArm('vector-only', vectorOnly),
  makeArm('lex-first', lexFirst),
  makeArm('vec-fallback', vecFallback),
  makeArm('weighted-w2', weighted(2)),
  makeArm('weighted-w4', weighted(4)),
  makeArm('lex-first-fill-0.3', lexFirstFill(0.3)),
  makeArm('lex-first-fill-0.5', lexFirstFill(0.5)),
]
