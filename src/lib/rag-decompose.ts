/**
 * Splitting a compound question into standalone sub-questions for retrieval, and keeping every sub-question's evidence.
 *
 * WHY (live eval, 2026-10-05): most wrong multi-hop answers were a false "not found" with the right DOCUMENT cited —
 * one hop's chunk reached the context, the other's did not. Two causes, both here:
 *   - the regex split (hyde.ts) cut sentences into fragments without their subject ("outbound warehouse SOPs?",
 *     "cost center mana yang memiliki anggarannya?") and did not split comparisons at all ("how many days after X
 *     does Y …"), so a sub-retrieval searched for the wrong thing or never ran;
 *   - the union of the sub-retrievals was reranked once against the WHOLE question and cut to top-K, so the chunks of
 *     the hop the reranker liked better could crowd out the other hop entirely.
 * A model writes standalone sub-questions for the questions that need it (one cheap call, only for those), and
 * `coverageMerge` guarantees each sub-question's best chunk survives the cut.
 */
import type { RetrievedChunk } from '@/lib/rag'
import { decomposeQuery, isComplexQuery } from '@/lib/hyde'

/**
 * Comparison and "both" cues the conjunction regex cannot see: a question that relates two facts without an "and"
 * between two clauses ("how many days after X takes effect does Y …", "exceed", "selisih … dengan").
 */
const RELATES_TWO_FACTS = /\b(both|each of|difference|differ|exceed(s|ed)?|longer than|shorter than|more than|less than|after .{3,80}? (takes|took|become|becomes|became) effect|days? (after|before)|selisih|sekaligus|keduanya|kedua (prosedur|kebijakan|sop|dokumen)|masing-masing|dibanding(kan)?|lebih (lama|lambat|cepat|besar|kecil|tinggi|rendah) dari(pada)?)\b/i

export function needsDecomposition(question: string): boolean {
  if (RELATES_TWO_FACTS.test(question)) return true
  // The regex split already decided this is several questions; whether its fragments are usable is what the model
  // fixes. Fragments of 4+ words only: "Apa saja syarat" / "ketentuan pengembalian barang?" is one noun phrase cut in
  // two, and paying a model call to rejoin it buys nothing.
  if (!isComplexQuery(question)) return false
  const parts = decomposeQuery(question)
  return parts.length > 1 && parts.every((p) => p.split(/\s+/).length >= 4)
}

/** A usable reply: 2–3 distinct standalone questions (4+ words each), none just the original repeated. */
export function parseSubQuestions(raw: string, original: string): string[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return []
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>).find(Array.isArray)
      : null
  if (!Array.isArray(list)) return []
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const subs = [...new Set(list.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean))]
  if (subs.length < 2) return []
  if (subs.some((s) => s.split(/\s+/).length < 4 || norm(s) === norm(original))) return []
  return subs.slice(0, 3)
}

const SYSTEM = 'Split the user question into the separate questions that must each be looked up in company documents to answer it. ' +
  'Each must be a complete, standalone question: repeat the subject and the document or policy it is about, never "it" or "both". ' +
  'Keep the language of the user question. Do not answer. Reply ONLY with a JSON array of 2 or 3 strings.'

/**
 * The queries to retrieve for: the question itself when it is simple, else 2–3 standalone sub-questions. The model is
 * asked only when `needsDecomposition` says so; any failure or unusable reply falls back to the heuristic split.
 */
export async function decomposeForRetrieval(question: string): Promise<string[]> {
  // `RAG_MODEL_DECOMPOSE=false` restores the previous path exactly (the regex split inside retrieveRelevantChunks).
  if (process.env.RAG_MODEL_DECOMPOSE === 'false' || !needsDecomposition(question)) return [question]
  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('keyword')
    if (cfg) {
      const raw = await chatOnce(cfg, [{ role: 'system', content: SYSTEM }, { role: 'user', content: question }], 0, 'rag-decompose')
      const subs = parseSubQuestions(String(raw), question)
      if (subs.length > 1) return subs
    }
  } catch {
    // Fall through: retrieval must not fail because a planning call did.
  }
  return decomposeQuery(question)
}

/**
 * The jointly reranked top-K, with each sub-question's best chunk guaranteed a place: a missing one fills free room
 * first, then replaces the weakest chunk that is not itself some sub-question's guaranteed best.
 */
export function coverageMerge(reranked: RetrievedChunk[], perSub: RetrievedChunk[][], topK: number): RetrievedChunk[] {
  const out = reranked.slice(0, topK)
  const has = (id: string) => out.some((c) => c.chunkId === id)
  const guaranteed = new Set<string>()
  for (const sub of perSub) {
    const best = sub[0]
    if (!best) continue
    guaranteed.add(best.chunkId)
    if (has(best.chunkId)) continue
    if (out.length < topK) {
      out.push(best)
      continue
    }
    for (let i = out.length - 1; i >= 0; i--) {
      if (!guaranteed.has(out[i].chunkId)) {
        out[i] = best
        break
      }
    }
  }
  return out
}

/**
 * The rerank pool for a decomposed question: candidates taken round-robin from each sub-question's own ranking, so the
 * pool cap cannot fill up with one hop's chunks before the other hop's best candidate is in. Deduplicated by chunk id.
 */
export function interleavePools(pools: RetrievedChunk[][], cap: number): RetrievedChunk[] {
  const out: RetrievedChunk[] = []
  const seen = new Set<string>()
  for (let i = 0; out.length < cap && pools.some((p) => i < p.length); i++) {
    for (const pool of pools) {
      const c = pool[i]
      if (!c || seen.has(c.chunkId)) continue
      seen.add(c.chunkId)
      out.push(c)
      if (out.length >= cap) break
    }
  }
  return out
}

/**
 * First-pass retrieval for a decomposed question. Each sub-question is expanded (so cross-language matching still
 * works) and retrieved WITHOUT a rerank; the pools meet in one interleaved rerank pool, are reranked once against the
 * whole question, and `coverageMerge` puts back any sub-question's best chunk the joint cut dropped.
 *
 * The retrieval functions are passed in rather than imported: the caller (`retrieveWithReflection`) owns them, and
 * importing them here would close an import cycle.
 */
export async function retrieveCompound<R extends { chunks: RetrievedChunk[] }>(args: {
  question: string
  subQuestions: string[]
  topK: number
  /** One query's candidate pool, un-reranked when `rerank` is given. */
  retrieve: (query: string) => Promise<R>
  expand: (query: string) => string[]
  merge: (results: R[]) => R
  rerank: ((question: string, pool: RetrievedChunk[], topK: number) => Promise<RetrievedChunk[]>) | null
}): Promise<{ merged: R; perSub: RetrievedChunk[][] }> {
  // Two variants per sub-question: the sub-question and its first translation/synonym variant.
  const perSubResults = await Promise.all(
    args.subQuestions.map(async (sq) => args.merge(await Promise.all(args.expand(sq).slice(0, 2).map((q) => args.retrieve(q))))),
  )
  const perSub = perSubResults.map((r) => r.chunks)
  const pool = interleavePools(perSub, args.topK * 3)
  const ranked = args.rerank ? await args.rerank(args.question, pool, args.topK) : pool.slice(0, args.topK)
  const merged = args.merge(perSubResults)
  return { merged: { ...merged, chunks: coverageMerge(ranked, perSub, args.topK) }, perSub }
}
