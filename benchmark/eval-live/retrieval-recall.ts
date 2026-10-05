/**
 * Chunk-level retrieval recall on the live-eval corpus: does the context the answer model receives CONTAIN the
 * verbatim evidence of each question? Mechanical — no judge, no answer generation.
 *
 * WHY: in the 2026-10-05 full run most wrong answers were a false "not found" with the right DOCUMENT cited — the
 * chunk holding the fact never reached the context (multi-hop: one hop found, the other not). Document-level citation
 * hit (91.7%) cannot see that; this measures the unit the answer model actually reads.
 *
 * Runs the production retrieval (`retrieveWithReflection`, rerank and reflection included) in-process against the eval
 * database, inside the eval org.
 *
 *   DATABASE_URL=<eval db> EVAL_CREDENTIALS_FILE=… bun benchmark/eval-live/retrieval-recall.ts \
 *     [--categories multi-hop,factual] [--ids q1,q2] [--out file]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapLimit } from './llm'
import { wilson } from './stats'
import type { EvalQuestion } from './generate-questions'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const categories = arg('--categories')?.split(',') ?? ['factual', 'multi-hop', 'cross-language', 'colloquial', 'distractor-book']
const ids = arg('--ids')?.split(',')
const out = arg('--out') ?? join(import.meta.dir, '../results', `retrieval-recall-${new Date().toISOString().slice(0, 10)}.json`)

const creds = JSON.parse(readFileSync(process.env.EVAL_CREDENTIALS_FILE!, 'utf8')) as { orgId: string }
const { enterWithOrg } = await import('../../src/lib/prisma-tenant')
enterWithOrg(creds.orgId)
const { retrieveWithReflection } = await import('../../src/lib/intent-pipeline')
const { RAG_ANSWER_TOP_K: PRODUCT_TOP_K } = await import('../../src/lib/speculative-retrieval')
// `--topk N` measures another context size without changing the product constant.
const RAG_ANSWER_TOP_K = Number(arg('--topk') ?? PRODUCT_TOP_K)

const { questions } = JSON.parse(readFileSync(join(import.meta.dir, 'rag-questions.json'), 'utf8')) as { questions: EvalQuestion[] }
const selected = questions.filter((q) => categories.includes(q.category) && (!ids || ids.includes(q.id)))

/** Whitespace- and markdown-insensitive containment: the quote's first 80 meaningful characters. */
const norm = (s: string) => s.toLowerCase().replace(/[*_`#|>]/g, '').replace(/\s+/g, ' ').trim()
const contains = (hay: string, quote: string) => {
  const q = norm(quote)
  const probe = q.length > 80 ? q.slice(0, 80) : q
  return norm(hay).includes(probe)
}

console.log(`retrieval recall: ${selected.length} questions, topK ${RAG_ANSWER_TOP_K}`)
const rows = await mapLimit(selected, 4, async (q) => {
  try {
    // Same request shape as the RAG answer path (pipelines/rag-pipeline.ts).
    const r = await retrieveWithReflection({ query: q.question, topK: RAG_ANSWER_TOP_K })
    const context = r.chunks.map((c) => c.content).join('\n\n') + '\n\n' + (r.graphContext ?? '')
    const found = q.evidence.map((e) => contains(context, e.quote))
    return { id: q.id, category: q.category, evidence: q.evidence.length, found: found.filter(Boolean).length, all: found.every(Boolean), chunks: r.chunks.length, passes: r.retrievalPasses }
  } catch (e) {
    return { id: q.id, category: q.category, evidence: q.evidence.length, found: 0, all: false, chunks: 0, passes: 0, error: String(e).slice(0, 200) }
  }
})

const byCat = Object.fromEntries(categories.map((c) => {
  const rs = rows.filter((r) => r.category === c)
  const quotes = rs.reduce((a, r) => a + r.evidence, 0)
  return [c, { questions: rs.length, allEvidence: wilson(rs.filter((r) => r.all).length, rs.length), quoteRecall: wilson(rs.reduce((a, r) => a + r.found, 0), quotes) }]
}))
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), topK: RAG_ANSWER_TOP_K, byCategory: byCat, results: rows }, null, 2) + '\n')
const fmt = (w: { rate: number; low: number; high: number; n: number }) => `${(w.rate * 100).toFixed(1)}% [${(w.low * 100).toFixed(0)}–${(w.high * 100).toFixed(0)}] n=${w.n}`
for (const [c, m] of Object.entries(byCat)) console.log(`${c.padEnd(16)} all evidence ${fmt(m.allEvidence)} · quotes ${fmt(m.quoteRecall)}`)
console.log(`errors ${rows.filter((r) => 'error' in r).length} → ${out}`)
process.exit(0)
