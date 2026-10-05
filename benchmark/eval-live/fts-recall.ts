/**
 * The Postgres full-text leg ALONE on the live-eval corpus: for each answerable question, is the verbatim evidence in
 * the first N rows the FTS statement returns? No vectors, no rerank, no model.
 *
 * WHY: on 2026-10-05 this leg used `plainto_tsquery`, which ANDs every word of the question, and returned zero rows for
 * 253 of 255 questions — invisible end to end, because the vector leg filled the candidate pool. This compares the
 * every-word query with the any-word query `rag-fts.ts` now builds (`buildPgOrQuery`), under four rank functions.
 *
 *   DATABASE_URL=<eval db> EVAL_CREDENTIALS_FILE=… bun benchmark/eval-live/fts-recall.ts [--limits 24,64]
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'
import { tokenize } from '../../src/lib/rag-scoring'
import { buildPgOrQuery } from '../../src/lib/rag-fts'
import type { EvalQuestion } from './generate-questions'

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const limits = (arg('--limits') ?? '24,64').split(',').map(Number)
const { orgId } = JSON.parse(readFileSync(process.env.EVAL_CREDENTIALS_FILE!, 'utf8')) as { orgId: string }
const db = new PrismaClient()
const questions = (JSON.parse(readFileSync(join(import.meta.dir, 'rag-questions.json'), 'utf8')) as { questions: EvalQuestion[] })
  .questions.filter((q) => q.category !== 'unanswerable')

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
const holdsEvidence = (q: EvalQuestion, rows: Array<{ content: string }>) => {
  const quotes = (q.evidence ?? []).map((e) => norm(e.quote).slice(0, 60))
  return quotes.length > 0 && quotes.every((e) => rows.some((r) => norm(r.content).includes(e)))
}

const arms: Array<{ name: string; query: (q: EvalQuestion) => string; fn: string; rank: string }> = [
  { name: 'every word (plainto_tsquery, before)', query: (q) => tokenize(q.question).join(' '), fn: 'plainto_tsquery', rank: 'ts_rank(tsv, q)' },
  { name: 'any word, ts_rank (shipped)', query: (q) => buildPgOrQuery(tokenize(q.question)), fn: 'to_tsquery', rank: 'ts_rank(tsv, q)' },
  { name: 'any word, ts_rank norm 1', query: (q) => buildPgOrQuery(tokenize(q.question)), fn: 'to_tsquery', rank: 'ts_rank(tsv, q, 1)' },
  { name: 'any word, ts_rank_cd', query: (q) => buildPgOrQuery(tokenize(q.question)), fn: 'to_tsquery', rank: 'ts_rank_cd(tsv, q)' },
  { name: 'any word, ts_rank_cd norm 1', query: (q) => buildPgOrQuery(tokenize(q.question)), fn: 'to_tsquery', rank: 'ts_rank_cd(tsv, q, 1)' },
]

console.log(`fts recall: ${questions.length} answerable questions`)
for (const limit of limits) {
  for (const arm of arms) {
    let found = 0
    let empty = 0
    const started = performance.now()
    for (const q of questions) {
      const text = arm.query(q)
      const rows = text
        ? await db.$queryRawUnsafe<Array<{ content: string }>>(
            `SELECT content FROM "DocumentChunk", ${arm.fn}('simple', $2) q
             WHERE "organizationId" = $1 AND tsv @@ q ORDER BY ${arm.rank} DESC, id LIMIT ${limit}`,
            orgId,
            text,
          )
        : []
      if (rows.length === 0) empty++
      if (holdsEvidence(q, rows)) found++
    }
    const ms = (performance.now() - started) / questions.length
    console.log(`top ${String(limit).padStart(2)}  ${arm.name.padEnd(38)} evidence ${found}/${questions.length}  zero rows ${empty}  ${ms.toFixed(1)} ms/query`)
  }
}
await db.$disconnect()
