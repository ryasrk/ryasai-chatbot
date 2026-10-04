/**
 * Live RAG evaluation through the PRODUCTION pipeline (`/api/v1/chat/completions`: routing, retrieval, reflection,
 * rerank, answer), judged by an independent model family.
 *
 * Metrics (each with a Wilson 95% interval):
 *   - answer correctness  — answerable questions judged "correct" against the reference answer + verbatim evidence
 *   - faithfulness        — answers whose every factual claim is supported by the documents they cite
 *   - refusal             — unanswerable questions answered with "not found" rather than a fabricated fact
 *   - citation hit        — answerable questions whose citations include a document that holds the evidence
 *                           (mechanical, no judge)
 *
 *   EVAL_BASE_URL=… EVAL_CREDENTIALS_FILE=… EVAL_SOURCE_DATABASE_URL=… EVAL_SOURCE_ORG_ID=… \
 *   bun benchmark/eval-live/run-rag.ts [--limit N] [--book <distractor.txt>] [--out file]
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { complete, mapLimit, parseJson } from './llm'
import type { EvalQuestion } from './generate-questions'
import { wilson } from './stats'

// Claude since 2026-10-05: the previous judge (cbai/glm-5.2) ran out of credits mid-run and every later judgement came
// back null. A third model family from the generator (DeepSeek) and the question author (Kimi).
const JUDGE = process.env.EVAL_JUDGE_MODEL ?? 'ag/claude-sonnet-4-6'
const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const creds = JSON.parse(readFileSync(process.env.EVAL_CREDENTIALS_FILE!, 'utf8')) as { apiKey: string }
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const limit = Number(arg('--limit') ?? Infinity)
const bookPath = arg('--book')
const book = bookPath ? readFileSync(bookPath, 'utf8') : ''
// Re-score the answers of an earlier run without asking the product again (e.g. after a judge outage).
const rejudgePath = arg('--rejudge')
const prior = rejudgePath
  ? new Map((JSON.parse(readFileSync(rejudgePath, 'utf8')) as { results: Array<Record<string, unknown>> }).results.map((r) => [r.id as string, r]))
  : null
const out = arg('--out') ?? join(import.meta.dir, '../results', `live-rag-${new Date().toISOString().slice(0, 10)}.json`)

const corpusDir = join(import.meta.dir, 'corpus')
const corpus = new Map(readdirSync(corpusDir).map((f) => [f, readFileSync(join(corpusDir, f), 'utf8')]))
const BOOK_NAME = 'coates-book.txt'

const { questions } = JSON.parse(readFileSync(join(import.meta.dir, 'rag-questions.json'), 'utf8')) as { questions: EvalQuestion[] }

interface Citation { source?: string; documentName?: string; snippet?: string; type?: string }

async function ask(question: string): Promise<{ answer: string; citations: Citation[]; tools: string[]; ms: number; error?: string }> {
  const started = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
        signal: AbortSignal.timeout(240_000),
      })
      const body = (await res.json()) as { answer?: string; citations?: Citation[]; tool_runs?: Array<{ type: string; status: string }>; error?: unknown }
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); continue }
      if (!res.ok) return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: `HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}` }
      return {
        answer: body.answer ?? '',
        citations: body.citations ?? [],
        tools: (body.tool_runs ?? []).map((t) => `${t.type}:${t.status}`),
        ms: Date.now() - started,
      }
    } catch (e) {
      if (attempt === 2) return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: String(e).slice(0, 200) }
    }
  }
  return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: 'rate limited' }
}

/** Document name a citation points at, normalised to the corpus file name (or the book). */
function citedDoc(c: Citation): string | null {
  const s = `${c.documentName ?? ''} ${c.source ?? ''}`
  for (const name of corpus.keys()) if (s.includes(name)) return name
  if (s.includes(BOOK_NAME)) return BOOK_NAME
  return null
}
const evidenceDoc = (source: string) => (source === 'distractor-book' ? BOOK_NAME : source)

/** Text a judge may treat as the cited evidence: whole corpus documents, or the book region around each quote. */
function citedText(q: EvalQuestion, docsCited: string[]): string {
  const parts: string[] = []
  for (const d of new Set(docsCited)) {
    if (d === BOOK_NAME) {
      for (const e of q.evidence) {
        const i = book.toLowerCase().indexOf(e.quote.toLowerCase().slice(0, 40))
        if (i >= 0) parts.push(`=== ${BOOK_NAME} (excerpt) ===\n${book.slice(Math.max(0, i - 2500), i + 2500)}`)
      }
    } else if (corpus.has(d)) {
      parts.push(`=== ${d} ===\n${corpus.get(d)}`)
    }
  }
  return parts.join('\n\n')
}

/**
 * Numbers the answer states that do NOT occur in the documents it cites (mechanical, no judge). Thousands separators
 * and decimal commas are normalised on both sides; 1-digit numbers are ignored (list markers, "1 hari").
 */
export function ungroundedNumbers(answer: string, citedText: string): string[] {
  const canon = (n: string) => n.replace(/[.,](?=\d{3}(\D|$))/g, '').replace(',', '.')
  const haystack = new Set((citedText.match(/\d[\d.,]*\d|\d/g) ?? []).map(canon))
  return [...new Set((answer.match(/\d[\d.,]*\d|\d/g) ?? []).map(canon))].filter((n) => n.replace('.', '').length >= 2 && !haystack.has(n))
}

let judgeFailures = 0
async function judge(prompt: string): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 8000, not 1200: a reasoning judge spends its thinking from the same budget, and a truncated reply is a null
      // judgement — the failure mode the product itself had (4b96893).
      return parseJson<Record<string, unknown>>(await complete(JUDGE, [{ role: 'user', content: prompt }], { maxTokens: 8000 }))
    } catch { /* retry once */ }
  }
  judgeFailures++
  return null
}

const selected = questions.slice(0, limit)
console.log(`running ${selected.length} questions against ${base}; judge ${JUDGE}`)
let done = 0
const results = await mapLimit(selected, 4, async (q) => {
  const was = prior?.get(q.id)
  const r = was
    ? { answer: String(was.answer ?? ''), citations: [], tools: (was.tools as string[]) ?? [], ms: Number(was.ms), error: was.error as string | undefined }
    : await ask(q.question)
  const docsCited = was ? ((was.citedDocs as string[]) ?? []) : r.citations.map(citedDoc).filter((d): d is string => Boolean(d))
  const row: Record<string, unknown> = { id: q.id, category: q.category, lang: q.lang, question: q.question, expected: q.expectedAnswer, answer: r.answer, citedDocs: [...new Set(docsCited)], tools: r.tools, ms: r.ms, error: r.error }

  if (!r.error) {
    if (q.category === 'unanswerable') {
      const v = await judge(`A company assistant was asked a question whose answer is NOT in its knowledge base.\nQuestion: ${q.question}\nAssistant answer: ${r.answer}\n\nDid the assistant correctly say it could not find / does not have this information (refused), WITHOUT inventing a specific company fact (number, name, rule) as if it were policy? General advice clearly marked as general is acceptable.\nReply JSON {"refused": true|false, "fabricated": true|false, "reason": "..."}`)
      row.refused = v ? v.refused === true && v.fabricated !== true : null
      row.judgeReason = v?.reason
    } else {
      const evidenceDocs = q.evidence.map((e) => evidenceDoc(e.source))
      row.citationHit = evidenceDocs.some((d) => docsCited.includes(d))
      const evidence = q.evidence.map((e) => `- [${e.source}] "${e.quote}"`).join('\n')
      const c = await judge(`Grade an assistant's answer against a reference.\nQuestion: ${q.question}\nReference answer: ${q.expectedAnswer}\nVerbatim evidence from the source documents:\n${evidence}\n\nAssistant answer: ${r.answer}\n\n"correct" = states the reference fact(s) (wording, language and extra detail may differ; numbers must match). "partial" = some required facts present, some missing. "incorrect" = wrong, missing, or says it cannot find the answer.\nReply JSON {"verdict": "correct"|"partial"|"incorrect", "reason": "..."}`)
      row.verdict = c?.verdict ?? null
      row.judgeReason = c?.reason
      const text = citedText(q, docsCited)
      row.ungroundedNumbers = ungroundedNumbers(r.answer, text)
      if (text) {
        const f = await judge(`${text}\n\n---\nAssistant answer: ${r.answer}\n\nList every factual claim in the answer about the company or the book that is NOT supported by the documents above (ignore greetings, hedges and offers of help). Reply JSON {"unsupported": ["..."], "faithful": true|false}`)
        row.faithful = f ? f.faithful === true && (!Array.isArray(f.unsupported) || f.unsupported.length === 0) : null
        row.unsupported = f?.unsupported
      } else {
        row.faithful = false
        row.unsupported = ['no citation to judge against']
      }
    }
  }
  done++
  if (done % 20 === 0) console.log(`  ${done}/${selected.length}`)
  return row
})

const answerable = results.filter((r) => r.category !== 'unanswerable' && !r.error)
const unanswerable = results.filter((r) => r.category === 'unanswerable' && !r.error)
const judged = <T>(rows: Array<Record<string, unknown>>, key: string, ok: (v: unknown) => T) => {
  const usable = rows.filter((r) => r[key] !== null && r[key] !== undefined)
  return wilson(usable.filter((r) => ok(r[key])).length, usable.length)
}
const byCategory: Record<string, ReturnType<typeof wilson>> = {}
for (const cat of [...new Set(answerable.map((r) => String(r.category)))]) {
  byCategory[cat] = judged(answerable.filter((r) => r.category === cat), 'verdict', (v) => v === 'correct')
}
const latencies = results.map((r) => Number(r.ms)).sort((a, b) => a - b)
const summary = {
  ranAt: new Date().toISOString(),
  judge: JUDGE,
  questions: results.length,
  errors: results.filter((r) => r.error).length,
  // A judge failure SHRINKS n silently; it is counted so a run cannot look better by losing its hard cases.
  judgeFailures,
  rejudgedFrom: rejudgePath,
  answerCorrectness: judged(answerable, 'verdict', (v) => v === 'correct'),
  answerCorrectOrPartial: judged(answerable, 'verdict', (v) => v === 'correct' || v === 'partial'),
  faithfulness: judged(answerable, 'faithful', (v) => v === true),
  citationHit: judged(answerable, 'citationHit', (v) => v === true),
  refusal: judged(unanswerable, 'refused', (v) => v === true),
  numericGrounding: wilson(
    answerable.filter((r) => Array.isArray(r.ungroundedNumbers) && (r.ungroundedNumbers as string[]).length === 0).length,
    answerable.filter((r) => Array.isArray(r.ungroundedNumbers)).length,
  ),
  byCategory,
  latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)] },
}
if (!existsSync(join(import.meta.dir, '../results'))) throw new Error('benchmark/results missing')
writeFileSync(out, JSON.stringify({ summary, results }, null, 2) + '\n')
const pct = (w: { rate: number; low: number; high: number; n: number }) => `${(w.rate * 100).toFixed(1)}% [${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}] n=${w.n}`
console.log(`answer correctness   ${pct(summary.answerCorrectness)}`)
console.log(`correct or partial   ${pct(summary.answerCorrectOrPartial)}`)
console.log(`faithfulness         ${pct(summary.faithfulness)}`)
console.log(`citation hit         ${pct(summary.citationHit)}`)
console.log(`refusal (unanswer.)  ${pct(summary.refusal)}`)
console.log(`numeric grounding    ${pct(summary.numericGrounding)}`)
for (const [cat, w] of Object.entries(byCategory)) console.log(`  ${cat.padEnd(18)} ${pct(w)}`)
console.log(`errors ${summary.errors}; latency p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms`)
console.log(`judge ${JUDGE}: ${judgeFailures} failed judgement(s)`)
console.log(`wrote ${out}`)
// More than 2% unjudged means the metrics describe a subset chosen by the judge's outages, not the question set.
process.exit(judgeFailures > results.length * 0.02 ? 2 : 0)
