/**
 * Phase 3 — the real-prose check (`docs/entity-hop-retrieval-plan.md` §4, gate 3).
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE MAIN HARNESS
 * ----------------------------------------------------------------------------
 * Every number in `benchmark/results/retrieval-arms-decision.md` is measured on a
 * synthetic corpus that is 100% entity-dense: an ID or a `PT ...` name in every one
 * of 1200 documents. Entity-Hop is built for exactly that shape, so the synthetic
 * result cannot say whether the mechanism is useful on a real customer corpus.
 *
 * This runner instead grades the app's OWN document chunks — real Indonesian policy
 * prose from the database, the shape the product actually stores — and reports two
 * things the plan requires:
 *
 *   1. ENTITY COVERAGE: the share of real chunks in which any entity can be found.
 *      A hop is only possible where an entity exists, so this bounds the mechanism's
 *      reach regardless of what any recall number says.
 *   2. SINGLE-HOP RECALL: extractive questions built from real sentences, graded
 *      through the shared harness with the same evidence rule and the same budget.
 *
 * It is deliberately NOT a multi-hop evaluation. `benchmark/golden-set.ts` builds
 * single-document extractive questions, and inventing multi-hop chains over 114 real
 * chunks with no ground-truth relation graph would be a fabricated answer key — the
 * precise defect the earlier benchmark audit found. Gate 3 asks whether the arm is
 * WORSE than production on real data, and a single-hop comparison answers that.
 *
 * IMPORTANT QUESTION-TEMPLATE CONSTRAINT: the extractive question must not name the
 * source document. `golden-set.ts` embeds `${docName}` in every template, which makes
 * the origin document trivially findable and would inflate both arms.
 *
 * Usage:
 *   bun benchmark/real-prose-arm.ts --out=benchmark/results/real-prose-arm.json
 */
import { DESIGN_ARMS } from './arms/fusion-design-arms'
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { buildEntityIndex } from './arms/entity-hop-arm'
import { makeEntityHopArm } from './arms/entity-hop-arm'
import { arm as hybridArm } from './arms/hybrid-arm'
import { bm25BaselineArm, gradeArm } from './arm-harness'
import { ARM_BUDGET } from './arm-types'
import type { Arm, ArmContext, ArmQuestion } from './arm-types'

/** A question is only useful when the sentence states enough to be asked about. */
const MIN_SENTENCE_CHARS = 40
const MAX_SENTENCE_CHARS = 320

/** Bahasa Indonesia interrogatives, so a sentence that is already a question is skipped. */
const QUESTION_START = /^(bagaimana|apa|mengapa|kapan|dimana|di mana|siapa|berapa|how|what|why|when|where|who)\b/i

/** Words too common in this corpus to identify a passage. Kept small and explicit. */
const STOP = new Set([
  'yang', 'untuk', 'dengan', 'dari', 'pada', 'dalam', 'adalah', 'akan', 'tidak', 'atau', 'juga',
  'oleh', 'ini', 'itu', 'dan', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'must', 'shall',
  'setiap', 'harus', 'dapat', 'serta', 'agar', 'jika', 'maka', 'serta', 'lebih', 'sama', 'satu',
])

export interface RealProseInput {
  /** chunkId -> chunk text. */
  chunks: Record<string, string>
}

/**
 * Extractive question from a real sentence.
 *
 * The document name is deliberately NOT included: it would name the answer's own
 * chunk and both arms would score on the filename rather than on retrieval. The
 * question instead quotes the sentence's own leading clause, so it is solvable
 * lexically but not by knowing which file to open.
 */
export function extractiveQuestion(sentence: string, index: number): ArmQuestion | null {
  const clean = sentence.replace(/\s+/g, ' ').trim()
  if (clean.length < MIN_SENTENCE_CHARS || clean.length > MAX_SENTENCE_CHARS) return null
  if (!/[.!?]$/.test(clean)) return null
  if (QUESTION_START.test(clean)) return null

  const words = clean.split(/\s+/)
  if (words.length < 6) return null

  const keywords = words
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}%]/gu, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w))
  if (keywords.length < 2) return null

  // Quote the informative part, capped, so the question shares vocabulary with the
  // chunk without being the whole sentence verbatim.
  const subject = keywords.slice(0, 4).join(' ')
  return {
    id: `real-ext-${String(index).padStart(4, '0')}`,
    tier: 'easy',
    question: `Where is it stated about ${subject}?`,
    answer: keywords[0],
    evidenceDocIds: [],
  }
}

/** Split a chunk into sentences, keeping the ones that can carry a question. */
export function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

/**
 * Build the question set. `evidenceDocIds` is filled in by the caller, because only
 * it knows the chunk ids; this function returns the sentence that produced each
 * question so the mapping stays explicit rather than inferred.
 */
export function buildQuestions(chunks: Record<string, string>): Array<{ q: ArmQuestion; sourceChunkId: string }> {
  const out: Array<{ q: ArmQuestion; sourceChunkId: string }> = []
  let index = 0
  for (const [chunkId, text] of Object.entries(chunks)) {
    for (const sentence of sentencesOf(text)) {
      const q = extractiveQuestion(sentence, index)
      if (!q) continue
      index += 1
      // ONE evidence document: the chunk the sentence came from. Grading therefore
      // asks "did the arm return that chunk in its top-10", the same rule the main
      // harness applies.
      out.push({ q: { ...q, evidenceDocIds: [chunkId] }, sourceChunkId: chunkId })
    }
  }
  return out
}

/** Load the app's real chunks through psql, read-only. */
function loadRealChunks(databaseUrl: string): Record<string, string> {
  const sql = `select "id" || E'\\t' || replace("content", E'\\n', ' ') from "DocumentChunk"`
  const raw = execFileSync('psql', [databaseUrl, '-tAc', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const chunks: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    chunks[line.slice(0, tab)] = line.slice(tab + 1)
  }
  return chunks
}

export interface CoverageReport {
  documents: number
  withEntity: number
  coverageShare: number
  meanEntitiesPerDoc: number
  distinctEntities: number
  bridgingEntities: number
}

/** The share of documents in which a hop is even possible. */
export function coverageOf(texts: Record<string, string>): CoverageReport {
  const index = buildEntityIndex(texts)
  const ids = Object.keys(texts)
  const withEntity = ids.filter((id) => (index.docEntities.get(id) ?? []).length > 0)
  const total = ids.reduce((sum, id) => sum + (index.docEntities.get(id) ?? []).length, 0)
  const bridging = [...index.df.values()].filter((df) => df >= 2).length
  return {
    documents: ids.length,
    withEntity: withEntity.length,
    coverageShare: ids.length ? withEntity.length / ids.length : 0,
    meanEntitiesPerDoc: ids.length ? total / ids.length : 0,
    distinctEntities: index.df.size,
    bridgingEntities: bridging,
  }
}

function argOf(name: string, fallback: string | null = null): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

async function main(): Promise<number> {
  const out = argOf('out')
  const databaseUrl =
    argOf('db') ?? process.env.DATABASE_URL ?? 'postgresql://ryasr:ryasr_dev@127.0.0.1:5432/ryasr'

  const texts = loadRealChunks(databaseUrl)
  const chunkIds = Object.keys(texts)
  console.log(`real chunks loaded: ${chunkIds.length}`)

  const coverage = coverageOf(texts)
  console.log(`\n=== ENTITY COVERAGE (gate 3 pre-condition) ===`)
  console.log(`  chunks                                 ${coverage.documents}`)
  console.log(`  chunks with >=1 extracted entity       ${coverage.withEntity} (${(coverage.coverageShare * 100).toFixed(1)}%)`)
  console.log(`  entities per chunk (mean)              ${coverage.meanEntitiesPerDoc.toFixed(2)}`)
  console.log(`  distinct entities                      ${coverage.distinctEntities}`)
  console.log(`  entities in >=2 chunks (bridges)       ${coverage.bridgingEntities}`)

  const built = buildQuestions(texts)
  const questions = built.map((b) => b.q)
  console.log(`\n=== QUESTIONS ===`)
  console.log(`  extractive questions built             ${questions.length} from ${chunkIds.length} chunks`)

  if (questions.length < 20) {
    console.error(
      `refusing to report recall from ${questions.length} questions — too few to measure anything`,
    )
    return 2
  }

  // Same context shape as the main harness. Optional vector caches let the hybrid arm be
  // graded too; when they are absent it reports NOT COMPUTABLE rather than silently
  // dropping its vector leg and being read as a hybrid result.
  const ctx: ArmContext = { texts, docIds: chunkIds }
  const docCache = argOf('embeddings')
  const queryCache = argOf('query-embeddings')
  let vectorsLoaded = false
  if (docCache && queryCache) {
    try {
      const doc = JSON.parse(readFileSync(docCache, 'utf8')) as { model: string; vectors: Record<string, number[]> }
      const qry = JSON.parse(readFileSync(queryCache, 'utf8')) as { model: string; vectors: Record<string, number[]> }
      // Mismatched models make every cosine meaningless while still printing a number.
      if (doc.model !== qry.model) throw new Error(`model mismatch: docs ${doc.model} vs queries ${qry.model}`)
      ctx.embeddings = doc.vectors
      ctx.embeddingModel = doc.model
      ctx.queryEmbeddings = qry.vectors
      ctx.queryEmbeddingModel = qry.model
      vectorsLoaded = true
    } catch (error) {
      console.error(`vector caches unusable: ${error instanceof Error ? error.message : 'load failed'}`)
      return 3
    }
  } else {
    console.log('\nno --embeddings/--query-embeddings given: the hybrid arm reports NOT COMPUTABLE')
  }

  const arms: Array<[string, Arm]> = [
    ['bm25-baseline', bm25BaselineArm],
    ['lexical-first-hybrid', hybridArm],
    ['entity-hop', makeEntityHopArm()],
    ...DESIGN_ARMS.map((a) => [a.id, a] as [string, Arm]),
  ]

  const rows: Array<{ arm: string; ready: boolean; answerAt1?: number; recall10: number | null; recall5: number | null; mrr: number | null; n: number }> = []
  for (const [label, arm] of arms) {
    if (!arm.ready(ctx)) {
      rows.push({ arm: label, ready: false, recall10: null, recall5: null, mrr: null, n: 0 })
      continue
    }
    const m = gradeArm(arm, questions, ctx, 'real-prose', ARM_BUDGET)
    rows.push({
      arm: label,
      ready: true,
      answerAt1: m.overall.answerAt1,
      recall10: m.overall.recall10,
      recall5: m.overall.recall5,
      mrr: m.overall.mrr,
      n: m.overall.n,
    })
  }

  console.log(`\n=== SINGLE-HOP RECALL on real prose (budget top-${ARM_BUDGET}, all questions are 1-hop) ===`)
  console.log(`vectors: ${vectorsLoaded ? `yes (${ctx.embeddingModel})` : 'none'}`)
  console.log('| arm | n | recall@5 | recall@10 | MRR | ans@1 |')
  console.log('|---|---|---|---|---|---|')
  for (const r of rows) {
    if (!r.ready) {
      console.log(`| ${r.arm} | 0 | NOT COMPUTABLE — needs a vector cache | | |`)
      continue
    }
    console.log(`| ${r.arm} | ${r.n} | ${r.recall5!.toFixed(4)} | ${r.recall10!.toFixed(4)} | ${r.mrr!.toFixed(4)} | ${(r.answerAt1 ?? 0).toFixed(4)} |`)
  }

  const bm25 = rows.find((r) => r.arm === 'bm25-baseline')
  const hop = rows.find((r) => r.arm === 'entity-hop')
  if (bm25?.ready && hop?.ready) {
    const delta = hop.recall10! - bm25.recall10!
    console.log(`\nentity-hop vs BM25 on real prose: recall@10 ${bm25.recall10!.toFixed(4)} -> ${hop.recall10!.toFixed(4)} (${delta >= 0 ? '+' : ''}${delta.toFixed(4)})`)
  }

  if (out) {
    writeFileSync(
      out,
      JSON.stringify(
        {
          kind: 'real-prose-arm',
          generatedAt: new Date().toISOString(),
          source: { database: databaseUrl.replace(/:[^:@]*@/, ':***@'), chunks: chunkIds.length },
          coverage,
          questions: questions.length,
          budget: ARM_BUDGET,
          vectors: vectorsLoaded ? { model: ctx.embeddingModel ?? null, docs: Object.keys(ctx.embeddings ?? {}).length, queries: Object.keys(ctx.queryEmbeddings ?? {}).length } : null,
          rows,
          note:
            'Single-hop extractive questions only. Multi-hop chains were NOT synthesised over real prose, ' +
            'because there is no ground-truth relation graph for it and a fabricated answer key is the defect ' +
            'the earlier benchmark audit found.',
        },
        null,
        2,
      ),
    )
    console.log(`\nwrote ${out}`)
  }
  return 0
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error('real-prose runner failed:', e)
      process.exit(1)
    })
}
