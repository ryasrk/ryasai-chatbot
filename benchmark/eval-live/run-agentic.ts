/**
 * Live AGENTIC evaluation through the PRODUCTION API: compound questions whose every part has a known answer
 * (agentic-questions.json, built from the verified RAG and SQL sets), judged PER PART by an independent model family.
 *
 * Metrics (Wilson 95% intervals where they are rates):
 *   - part correctness     — in-scope parts judged correct against the reference answer / evidence / gold rows
 *   - all parts correct    — questions whose every in-scope part is correct (the user's view of a compound answer)
 *   - silent drop          — parts neither answered nor reported as unanswered: the failure a user cannot see
 *   - scope leak           — an out-of-scope source cited, or its part answered, by a key that may not read it (must be 0)
 *   - cost                 — LLM calls and tokens per question (LlmUsageLog, attributed by time window), latency p50/p95
 *
 * Requests run ONE AT A TIME so each question's LLM usage can be attributed to it; judging runs in parallel after.
 *
 *   EVAL_BASE_URL=… EVAL_CREDENTIALS_FILE=… EVAL_SOURCE_DATABASE_URL=… EVAL_SOURCE_ORG_ID=… \
 *   bun benchmark/eval-live/run-agentic.ts [--sets doc_db,scope] [--ids a,b] [--limit N] [--out file]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { complete, mapLimit, parseJson } from './llm'
import { wilson } from './stats'
import { generateApiKey } from '../../src/lib/api-keys'
import type { AgenticQuestion, AgenticPart } from './build-agentic-questions'

const JUDGE = process.env.EVAL_JUDGE_MODEL ?? 'ag/gemini-3.8-flash-high'
const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const credFile = process.env.EVAL_CREDENTIALS_FILE!
const evalDb = process.env.EVAL_SOURCE_DATABASE_URL!
const creds = JSON.parse(readFileSync(credFile, 'utf8')) as { orgId: string; apiKey: string; scopedKeys?: Record<string, string> }
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null)
const sets = arg('--sets')?.split(',')
const ids = arg('--ids')?.split(',')
const limit = Number(arg('--limit') ?? Infinity)
const out = arg('--out') ?? join(import.meta.dir, '../results', `live-agentic-${new Date().toISOString().slice(0, 10)}.json`)

const { questions } = JSON.parse(readFileSync(join(import.meta.dir, 'agentic-questions.json'), 'utf8')) as { questions: AgenticQuestion[] }
const selected = questions.filter((q) => (!sets || sets.includes(q.set)) && (!ids || ids.includes(q.id))).slice(0, limit)

const pool = new pg.Pool({ connectionString: evalDb, max: 2 })

/** A key that may read the Chinook database only — created once, kept in the credentials file (never printed). */
async function chinookOnlyKey(): Promise<string> {
  if (creds.scopedKeys?.chinook) return creds.scopedKeys.chinook
  const { rows } = await pool.query(`SELECT id FROM "Integration" WHERE "organizationId" = $1 AND name = 'Chinook Music Store'`, [creds.orgId])
  if (!rows[0]) throw new Error('no Chinook integration in the eval org')
  const key = generateApiKey()
  await pool.query(
    `INSERT INTO "ApiKey" (id, "organizationId", label, "keyPrefix", "keyHash", "allowedIntegrationIds", "isActive", "createdAt", "updatedAt")
     VALUES ($1, $2, 'live-eval-scope-chinook', $3, $4, $5, true, now(), now())`,
    [`evalscope${Date.now()}`, creds.orgId, key.prefix, key.hash, [rows[0].id]],
  )
  creds.scopedKeys = { ...(creds.scopedKeys ?? {}), chinook: key.plainText }
  writeFileSync(credFile, JSON.stringify(creds, null, 2), { mode: 0o600 })
  return key.plainText
}

interface Citation { source?: string; documentName?: string; type?: string; query_used?: string }
interface Reply { answer: string; citations: Citation[]; tools: string[]; ms: number; error?: string; llmCalls: number; tokens: number; byPurpose: Record<string, number> }

async function usageBetween(from: Date, to: Date): Promise<{ calls: number; tokens: number; byPurpose: Record<string, number> }> {
  const { rows } = await pool.query(
    `SELECT purpose, count(*)::int AS n, coalesce(sum("totalTokens"), 0)::int AS t FROM "LlmUsageLog"
     WHERE "organizationId" = $1 AND "createdAt" >= $2 AND "createdAt" < $3 GROUP BY purpose`,
    [creds.orgId, from.toISOString().replace('Z', ''), to.toISOString().replace('Z', '')],
  )
  return {
    calls: rows.reduce((a, r) => a + r.n, 0),
    tokens: rows.reduce((a, r) => a + r.t, 0),
    byPurpose: Object.fromEntries(rows.map((r) => [r.purpose, r.n])),
  }
}

async function ask(question: string, apiKey: string): Promise<Omit<Reply, 'llmCalls' | 'tokens' | 'byPurpose'>> {
  const started = Date.now()
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
        signal: AbortSignal.timeout(300_000),
      })
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); continue }
      const body = (await res.json()) as { answer?: string; citations?: Citation[]; tool_runs?: Array<{ type: string; status: string }>; error?: unknown }
      if (!res.ok) return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: `HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}` }
      return { answer: body.answer ?? '', citations: body.citations ?? [], tools: (body.tool_runs ?? []).map((t) => `${t.type}:${t.status}`), ms: Date.now() - started }
    } catch (e) {
      if (attempt === 2) return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: String(e).slice(0, 200) }
    }
  }
  return { answer: '', citations: [], tools: [], ms: Date.now() - started, error: 'rate limited' }
}

type Verdict = 'correct' | 'partial' | 'incorrect' | 'flagged' | 'missing'
const VERDICTS: Verdict[] = ['correct', 'partial', 'incorrect', 'flagged', 'missing']

let judgeFailures = 0
async function judgeParts(q: AgenticQuestion, answer: string): Promise<Verdict[] | null> {
  const partsText = q.parts.map((p, i) => [
    `Part ${i + 1}: ${p.question}`,
    `  Reference answer: ${p.expectedAnswer}`,
    p.evidence ? `  Source text: ${p.evidence.slice(0, 1500)}` : `  Source: the ${p.source} database (reference = the query result)`,
  ].join('\n')).join('\n\n')
  const prompt = `A company assistant was asked ONE message containing ${q.parts.length} separate questions.\n\nFull message: ${q.question}\n\n${partsText}\n\nAssistant answer:\n${answer}\n\nFor EACH part, give one verdict:\n- "correct": the answer states the reference answer for that part (wording, units and number formatting may differ; extra correct detail is fine)\n- "partial": the part is addressed and partly right (e.g. some list items, or the right figure with a wrong qualifier)\n- "incorrect": the part is answered with a wrong value\n- "flagged": the answer says it could NOT answer that part, asks the user about it, or says the source is unavailable — without stating a wrong value\n- "missing": the part is not addressed at all and not mentioned as unanswered\nJudge each part only on what the answer says about THAT part.\nReply JSON {"parts": [{"part": 1, "verdict": "...", "reason": "..."}, ...]} with exactly ${q.parts.length} entries.`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = parseJson<{ parts?: Array<{ verdict?: string }> }>(await complete(JUDGE, [{ role: 'user', content: prompt }], { maxTokens: 8000 }))
      const verdicts = (v.parts ?? []).map((p) => String(p.verdict ?? '').toLowerCase() as Verdict)
      if (verdicts.length === q.parts.length && verdicts.every((x) => VERDICTS.includes(x))) return verdicts
    } catch { /* retry once */ }
  }
  judgeFailures++
  return null
}

const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

console.log(`agentic eval: ${selected.length} questions against ${base}; judge ${JUDGE}`)
const scopedKey = selected.some((q) => q.scopedTo) ? await chinookOnlyKey() : null

// Phase 1: ask, one at a time, attributing LLM usage by time window.
const replies: Reply[] = []
for (const [i, q] of selected.entries()) {
  const from = new Date()
  const r = await ask(q.question, q.scopedTo ? scopedKey! : creds.apiKey)
  // Usage rows are written fire-and-forget; give them a moment so they land inside this question's window.
  await new Promise((res) => setTimeout(res, 2000))
  const u = await usageBetween(from, new Date())
  replies.push({ ...r, llmCalls: u.calls, tokens: u.tokens, byPurpose: u.byPurpose })
  console.log(`${i + 1}/${selected.length} ${q.id} ${(r.ms / 1000).toFixed(1)}s ${u.calls} calls ${r.tools.join(' ')}${r.error ? ` ERROR ${r.error}` : ''}`)
}

// Phase 2: judge in parallel.
const verdicts = await mapLimit(selected, 4, async (q, i) => (replies[i].error ? null : judgeParts(q, replies[i].answer)))

const rows = selected.map((q, i) => {
  const r = replies[i]
  const v = verdicts[i]
  // Mechanical: a citation naming a source the key may not read is a leak whatever the judge says.
  const leakedCitation = q.parts.some((p) => p.outOfScope && r.citations.some((c) => `${c.source ?? ''} ${c.documentName ?? ''}`.includes(p.source)))
  return {
    id: q.id, set: q.set, question: q.question, answer: r.answer, error: r.error, ms: r.ms, tools: r.tools,
    llmCalls: r.llmCalls, tokens: r.tokens, byPurpose: r.byPurpose,
    parts: q.parts.map((p: AgenticPart, k) => ({ kind: p.kind, source: p.source, expected: p.expectedAnswer, outOfScope: Boolean(p.outOfScope), verdict: v?.[k] ?? null })),
    citedSources: [...new Set(r.citations.map((c) => c.source ?? c.documentName ?? ''))],
    scopeLeak: leakedCitation || q.parts.some((p, k) => p.outOfScope && (v?.[k] === 'correct' || v?.[k] === 'partial')),
  }
})

const judged = rows.filter((r) => r.parts.every((p) => p.verdict !== null))
function summary(rs: typeof rows) {
  const inScope = rs.flatMap((r) => r.parts.filter((p) => !p.outOfScope && p.verdict !== null))
  const count = (v: Verdict) => inScope.filter((p) => p.verdict === v).length
  const allCorrect = rs.filter((r) => r.parts.every((p) => p.verdict !== null) && r.parts.filter((p) => !p.outOfScope).every((p) => p.verdict === 'correct'))
  const failed = inScope.filter((p) => p.verdict !== 'correct')
  return {
    questions: rs.length,
    partCorrect: wilson(count('correct'), inScope.length),
    allPartsCorrect: wilson(allCorrect.length, rs.filter((r) => r.parts.every((p) => p.verdict !== null)).length),
    silentDrop: wilson(count('missing'), inScope.length),
    verdicts: Object.fromEntries(VERDICTS.map((v) => [v, count(v)])),
    // Of the parts NOT answered correctly, how many does the answer admit to? A wrong value or a silent drop is worse
    // than an honest "could not answer".
    honestWhenWrong: wilson(failed.filter((p) => p.verdict === 'flagged').length, failed.length),
    latencyP50s: pct(rs.map((r) => r.ms), 50) / 1000,
    latencyP95s: pct(rs.map((r) => r.ms), 95) / 1000,
    llmCallsMean: rs.reduce((a, r) => a + r.llmCalls, 0) / Math.max(1, rs.length),
    tokensMean: Math.round(rs.reduce((a, r) => a + r.tokens, 0) / Math.max(1, rs.length)),
    errors: rs.filter((r) => r.error).length,
  }
}

const bySet = Object.fromEntries([...new Set(rows.map((r) => r.set))].map((s) => [s, summary(rows.filter((r) => r.set === s))]))
const compound = rows.filter((r) => r.parts.length > 1 && r.set !== 'scope')
const scope = rows.filter((r) => r.set === 'scope')
const report = {
  ranAt: new Date().toISOString(),
  base,
  judge: JUDGE,
  judgeFailures,
  compound: summary(compound),
  bySet,
  scope: scope.length
    ? {
        questions: scope.length,
        leaks: scope.filter((r) => r.scopeLeak).length,
        outOfScopeFlagged: wilson(scope.filter((r) => r.parts.some((p) => p.outOfScope && p.verdict === 'flagged')).length, scope.length),
        inScopeCorrect: wilson(scope.filter((r) => r.parts.some((p) => !p.outOfScope && p.verdict === 'correct')).length, scope.length),
      }
    : null,
  results: rows,
}
writeFileSync(out, JSON.stringify(report, null, 2) + '\n')

const fmt = (w: { rate: number; low: number; high: number; n: number }) => `${(w.rate * 100).toFixed(1)}% [${(w.low * 100).toFixed(0)}–${(w.high * 100).toFixed(0)}] n=${w.n}`
console.log('\ncompound:', `parts ${fmt(report.compound.partCorrect)} · all-parts ${fmt(report.compound.allPartsCorrect)} · silent drop ${fmt(report.compound.silentDrop)}`)
for (const [s, m] of Object.entries(bySet)) {
  console.log(`${s.padEnd(11)} parts ${fmt(m.partCorrect)} · all ${fmt(m.allPartsCorrect)} · drop ${m.verdicts.missing} · p50 ${m.latencyP50s.toFixed(1)}s p95 ${m.latencyP95s.toFixed(1)}s · ${m.llmCallsMean.toFixed(1)} calls ${m.tokensMean} tok · err ${m.errors}`)
}
if (report.scope) console.log(`scope: leaks ${report.scope.leaks}/${report.scope.questions} · out-of-scope flagged ${fmt(report.scope.outOfScopeFlagged)}`)
console.log(`judge failures ${judgeFailures}/${selected.length} → ${out}`)
await pool.end()
// A run that lost more than 2% of its judgements measures the judge, not the product (see run-rag.ts).
if (judgeFailures > Math.max(1, 0.02 * selected.length) || judged.length === 0) process.exit(1)
