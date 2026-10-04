/**
 * Live Text-to-SQL evaluation through the PRODUCTION pipeline (`/api/v1/chat/completions`, scoped to the dataset's
 * integration): routing, generation, the lexical + AST guard, execution and repair all run as for a customer.
 *
 * Execution accuracy compares the rows of the SQL the pipeline actually ran (`citations[].query_used`) with the rows
 * of the reference SQL:
 *   - strict:  same row count and the same multiset of rows (values normalised; column order and names ignored)
 *   - lenient: same row count and every reference row's values contained in a distinct result row (extra columns
 *              such as an id beside a name are allowed)
 * A reference result over the guard's 100-row cap is compared on the capped prefix: 100 rows, all present in the
 * reference.
 *
 *   EVAL_BASE_URL=… EVAL_CREDENTIALS_FILE=… DATABASE_URL=<same server> bun benchmark/eval-live/run-sql.ts [--limit N]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { complete, mapLimit, parseJson } from './llm'
import { wilson } from './stats'

const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const creds = JSON.parse(readFileSync(process.env.EVAL_CREDENTIALS_FILE!, 'utf8')) as { apiKey: string; integrations: Record<string, string> }
const server = new URL(process.env.DATABASE_URL!)
const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : null)
const limit = Number(arg('--limit') ?? Infinity)
const out = arg('--out') ?? join(import.meta.dir, '../results', `live-sql-${new Date().toISOString().slice(0, 10)}.json`)
const CAP = 100
const JUDGE = process.env.EVAL_JUDGE_MODEL ?? 'cbai/glm-5.2'

/**
 * Cases whose reference result is not a valid target: the reference SQL filters on a literal the dataset does not
 * contain (the ERP seed's categories are English; these questions were written against an Indonesian seed), so the
 * "gold" answer is an empty set that a correct pipeline cannot and should not match.
 */
const EXCLUDED: Record<string, string> = {
  'erp-005': "reference filters category = 'Elektronik'; the data has 'Electronics'",
  'erp-041': "reference filters category = 'Elektronik'; the data has 'Electronics'",
  'erp-066': "reference filters category = 'Aksesoris'; the data has 'Accessories'",
}

interface Case { id: string; dataset: string; category: string; difficulty: string; question: string; goldSql: string; goldRowCount: number; goldRows: unknown[][] }
const { cases: allCases } = JSON.parse(readFileSync(join(import.meta.dir, 'sql-questions.json'), 'utf8')) as { cases: Case[] }
const cases = allCases.filter((c) => !EXCLUDED[c.id])

export function norm(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v).trim()
  if (/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return String(Math.round(Number(s) * 100) / 100)
  if (/^\d{4}-\d{2}-\d{2}([ T].*)?$/.test(s)) return s.slice(0, 10)
  return s.toLowerCase()
}
const bag = (row: unknown[]) => row.map(norm).sort()
const contains = (outer: string[], inner: string[]) => {
  const pool = [...outer]
  return inner.every((v) => {
    const i = pool.indexOf(v)
    if (i < 0) return false
    pool.splice(i, 1)
    return true
  })
}

export function compare(gold: unknown[][], goldCount: number, pred: unknown[][]): { strict: boolean; lenient: boolean } {
  const capped = goldCount > CAP
  if (capped) {
    if (pred.length !== CAP) return { strict: false, lenient: false }
    const goldBags = gold.map(bag)
    const ok = pred.every((r) => goldBags.some((g) => contains(bag(r), g)))
    return { strict: false, lenient: ok }
  }
  if (pred.length !== gold.length) return { strict: false, lenient: false }
  const key = (b: string[]) => JSON.stringify(b)
  const strict = JSON.stringify(gold.map(bag).map(key).sort()) === JSON.stringify(pred.map(bag).map(key).sort())
  const used = new Set<number>()
  const lenient = gold.every((g) => {
    const gb = bag(g)
    const i = pred.findIndex((p, j) => !used.has(j) && contains(bag(p), gb))
    if (i < 0) return false
    used.add(i)
    return true
  })
  return { strict, lenient: strict || lenient }
}

const clients = new Map<string, pg.Client>()
async function client(dataset: string): Promise<pg.Client> {
  if (!clients.has(dataset)) {
    const url = new URL(server.toString())
    url.pathname = `/eval_${dataset}`
    const c = new pg.Client({ connectionString: url.toString() })
    await c.connect()
    clients.set(dataset, c)
  }
  return clients.get(dataset)!
}

if (import.meta.main) {
  const selected = cases.slice(0, limit)
  console.log(`running ${selected.length} SQL questions against ${base}`)
  let done = 0
  const results = await mapLimit(selected, 3, async (c) => {
    const started = Date.now()
    let body: { answer?: string; citations?: Array<{ type?: string; query_used?: string }>; tool_runs?: Array<{ type: string; status: string }>; error?: unknown } = {}
    let status = 0
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(`${base}/api/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${creds.apiKey}` },
        body: JSON.stringify({ messages: [{ role: 'user', content: c.question }], sources: { integrationIds: [creds.integrations[c.dataset]] } }),
        signal: AbortSignal.timeout(240_000),
      }).catch(() => null)
      status = res?.status ?? 0
      if (status === 429 || status === 0) { await new Promise((r) => setTimeout(r, 15_000)); continue }
      body = (await res!.json().catch(() => ({}))) as typeof body
      break
    }
    const sql = body.citations?.find((x) => x.type === 'DATABASE')?.query_used ?? null
    const tools = (body.tool_runs ?? []).map((t) => `${t.type}:${t.status}`)
    const row: Record<string, unknown> = { id: c.id, dataset: c.dataset, category: c.category, difficulty: c.difficulty, question: c.question, goldSql: c.goldSql, sql, tools, status, ms: Date.now() - started, answer: body.answer ?? '' }
    if (sql) {
      try {
        const r = await (await client(c.dataset)).query({ text: sql, rowMode: 'array' })
        Object.assign(row, compare(c.goldRows, c.goldRowCount, r.rows), { predRowCount: r.rows.length })
      } catch (e) {
        Object.assign(row, { strict: false, lenient: false, execError: String(e).slice(0, 160) })
      }
    } else {
      Object.assign(row, { strict: false, lenient: false })
    }
    // Semantic correctness of the ANSWER a user reads, judged against the reference rows. Execution accuracy cannot
    // credit a correct "list all" answer when the reference SQL capped its own listing at an arbitrary LIMIT.
    if (body.answer) {
      const gold = JSON.stringify(c.goldRows.slice(0, 40))
      const raw = await complete(JUDGE, [{ role: 'user', content: `Question: ${c.question}\nReference result rows (${c.goldRowCount} total, first ${Math.min(40, c.goldRowCount)} shown, column order may differ): ${gold}\nReference SQL: ${c.goldSql}\n\nAssistant answer:\n${body.answer.slice(0, 6000)}\n\n"correct" = the answer's facts agree with the reference result (a longer correct listing, extra columns, rounding, or a different but valid reading of an ambiguous question are fine). "partial" = some agree, some missing or wrong. "incorrect" = wrong numbers or rows, no answer, or a refusal.\nReply JSON {"verdict":"correct"|"partial"|"incorrect","reason":"..."}` }], { maxTokens: 800 }).catch(() => '')
      try { const v = parseJson<{ verdict: string; reason: string }>(raw); row.verdict = v.verdict; row.judgeReason = v.reason } catch { row.verdict = null }
    }
    if (++done % 20 === 0) console.log(`  ${done}/${selected.length}`)
    return row
  })

  const n = results.length
  const k = (f: (r: Record<string, unknown>) => boolean) => results.filter(f).length
  const byDataset: Record<string, ReturnType<typeof wilson>> = {}
  for (const d of [...new Set(results.map((r) => String(r.dataset)))]) {
    const rows = results.filter((r) => r.dataset === d)
    byDataset[d] = wilson(rows.filter((r) => r.lenient).length, rows.length)
  }
  const byDifficulty: Record<string, ReturnType<typeof wilson>> = {}
  for (const d of [...new Set(results.map((r) => String(r.difficulty)))]) {
    const rows = results.filter((r) => r.difficulty === d)
    byDifficulty[d] = wilson(rows.filter((r) => r.lenient).length, rows.length)
  }
  const lat = results.map((r) => Number(r.ms)).sort((a, b) => a - b)
  const summary = {
    ranAt: new Date().toISOString(),
    questions: n,
    routedToSql: wilson(k((r) => Boolean(r.sql)), n),
    executionAccuracyLenient: wilson(k((r) => r.lenient === true), n),
    executionAccuracyStrict: wilson(k((r) => r.strict === true), n),
    answerCorrect: wilson(k((r) => r.verdict === 'correct'), results.filter((r) => r.verdict).length),
    answerCorrectOrPartial: wilson(k((r) => r.verdict === 'correct' || r.verdict === 'partial'), results.filter((r) => r.verdict).length),
    excluded: EXCLUDED,
    guardBlocksSeen: k((r) => (r.tools as string[]).some((t) => t.startsWith('SQL:blocked'))),
    byDataset,
    byDifficulty,
    latencyMs: { p50: lat[Math.floor(n * 0.5)], p95: lat[Math.floor(n * 0.95)] },
  }
  writeFileSync(out, JSON.stringify({ summary, results }, null, 2) + '\n')
  const pct = (w: { rate: number; low: number; high: number; n: number }) => `${(w.rate * 100).toFixed(1)}% [${(w.low * 100).toFixed(1)}–${(w.high * 100).toFixed(1)}] n=${w.n}`
  console.log(`routed to SQL          ${pct(summary.routedToSql)}`)
  console.log(`execution acc lenient  ${pct(summary.executionAccuracyLenient)}`)
  console.log(`execution acc strict   ${pct(summary.executionAccuracyStrict)}`)
  console.log(`answer correct (judge) ${pct(summary.answerCorrect)}`)
  console.log(`correct or partial     ${pct(summary.answerCorrectOrPartial)}`)
  for (const [d, w] of Object.entries(byDataset)) console.log(`  ${d.padEnd(10)} ${pct(w)}`)
  for (const [d, w] of Object.entries(byDifficulty)) console.log(`  ${d.padEnd(10)} ${pct(w)}`)
  console.log(`latency p50 ${summary.latencyMs.p50} ms, p95 ${summary.latencyMs.p95} ms; wrote ${out}`)
  for (const c of clients.values()) await c.end()
  process.exit(0)
}
