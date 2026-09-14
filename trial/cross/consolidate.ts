/**
 * Merges the four per-family result files into one report.
 *
 * Split deliberately: each family runs in its own process so four 200-question runs
 * proceed in parallel, and each writes its own file so no two writers collide. This
 * script does the single consolidation afterwards.
 *
 * Usage: bun trial/cross/consolidate.ts [--json trial/cross/report.json]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { FAMILIES, type Family, type CrossCase } from './questions'
import { ALL_CASES } from './questions'

const args = process.argv.slice(2)
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : 'trial/cross/report.json'

interface FailRow { id: string; question: string; tool: string | null; reason: string; answer: string }
interface Summary {
  family: string
  total: number
  passed: number
  accuracy: number
  latencyP50: number
  latencyP90: number
  ttftP50: number
  ttftP90: number
  avgTokensPerTask: number | null
  tokenSamples: number
  tokensPerSecondP50: number | null
  failures: FailRow[]
}
interface ResultRow {
  id: string
  question: string
  answer: string
  tool: string | null
  ok: boolean
  reason: string
  latencyMs: number
  ttftMs: number | null
  tokens: number | null
  error?: string
}

const byId = new Map<string, CrossCase>(ALL_CASES.map((c) => [c.id, c]))
const summaries: Summary[] = []
const allResults: ResultRow[] = []
const missing: Family[] = []

for (const f of FAMILIES) {
  const path = `trial/cross/results-${f}.json`
  if (!existsSync(path)) {
    missing.push(f)
    continue
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { summary: Summary; results: ResultRow[] }
  summaries.push(parsed.summary)
  allResults.push(...parsed.results)
}

const p = (arr: number[], q: number) =>
  arr.length === 0 ? 0 : (arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0)

const lat = allResults.map((r) => r.latencyMs)
const ttfts = allResults.map((r) => r.ttftMs).filter((v): v is number => v !== null)
const withTokens = allResults.filter((r) => typeof r.tokens === 'number')
const passed = allResults.filter((r) => r.ok).length

/** Accuracy per SOURCE, which is the number that answers "does it pick the right tool?". */
const bySource: Record<string, { total: number; passed: number; accuracy: number }> = {}
for (const r of allResults) {
  const src = byId.get(r.id)?.source ?? 'UNKNOWN'
  bySource[src] ??= { total: 0, passed: 0, accuracy: 0 }
  bySource[src].total++
  if (r.ok) bySource[src].passed++
}
for (const v of Object.values(bySource)) v.accuracy = Number(((v.passed / v.total) * 100).toFixed(2))

/** How often the pipeline labelled the turn with the source the question needed. */
const routing = { SQL: { total: 0, agreed: 0 }, REST: { total: 0, agreed: 0 } }
for (const r of allResults) {
  const want = byId.get(r.id)?.source
  if (want === 'SQL') {
    routing.SQL.total++
    if (r.tool === 'SQL') routing.SQL.agreed++
  } else if (want === 'REST') {
    routing.REST.total++
    if (r.tool === 'REST_API' || r.tool === 'REST') routing.REST.agreed++
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  model: process.env.CROSS_MODEL ?? '(see LlmConfig)',
  families: summaries,
  missingFamilies: missing,
  totals: {
    questions: allResults.length,
    passed,
    accuracy: allResults.length ? Number(((passed / allResults.length) * 100).toFixed(2)) : 0,
    latencyP50: p(lat, 0.5),
    latencyP90: p(lat, 0.9),
    latencyP99: p(lat, 0.99),
    ttftP50: p(ttfts, 0.5),
    ttftP90: p(ttfts, 0.9),
    avgTokensPerTask: withTokens.length
      ? Number((withTokens.reduce((s, r) => s + (r.tokens ?? 0), 0) / withTokens.length).toFixed(2))
      : null,
    totalCompletionTokens: withTokens.reduce((s, r) => s + (r.tokens ?? 0), 0),
    tokenSamples: withTokens.length,
    tokensPerSecondP50: withTokens.length
      ? Number(
          (withTokens
            .map((r) => ((r.tokens ?? 0) / Math.max(r.latencyMs - (r.ttftMs ?? r.latencyMs), 1)) * 1000)
            .sort((a, b) => a - b)[withTokens.length >> 1] ?? 0).toFixed(2),
        )
      : null,
  },
  bySource,
  routingAgreement: {
    SQL: routing.SQL.total ? Number(((routing.SQL.agreed / routing.SQL.total) * 100).toFixed(2)) : null,
    REST: routing.REST.total ? Number(((routing.REST.agreed / routing.REST.total) * 100).toFixed(2)) : null,
  },
  toolCounts: allResults.reduce<Record<string, number>>((acc, r) => {
    const k = r.tool ?? 'NONE'
    acc[k] = (acc[k] ?? 0) + 1
    return acc
  }, {}),
}

writeFileSync(jsonOut, JSON.stringify({ report, results: allResults }, null, 2))

const f = (v: number | null) => (v === null ? 'n/a' : String(v))
console.log('=== RINGKASAN CROSS-SOURCE 800 SOAL ===')
console.log(`soal            : ${report.totals.questions}/800${missing.length ? ` (keluarga belum selesai: ${missing.join(', ')})` : ''}`)
console.log(`akurasi total   : ${report.totals.accuracy}%  (${passed}/${report.totals.questions})`)
console.log(`per sumber      : ${Object.entries(bySource).map(([k, v]) => `${k} ${v.accuracy}% (${v.passed}/${v.total})`).join('  |  ')}`)
console.log(`kesesuaian rute : SQL ${f(report.routingAgreement.SQL)}%  REST ${f(report.routingAgreement.REST)}%`)
console.log(`latensi         : p50 ${report.totals.latencyP50}ms  p90 ${report.totals.latencyP90}ms  p99 ${report.totals.latencyP99}ms`)
console.log(`TTFT            : p50 ${report.totals.ttftP50}ms  p90 ${report.totals.ttftP90}ms`)
console.log(`token           : rata-rata ${f(report.totals.avgTokensPerTask)} token/task (${report.totals.tokenSamples} sampel)`)
console.log(`kecepatan token : p50 ${f(report.totals.tokensPerSecondP50)} token/detik`)
console.log(`distribusi tool : ${JSON.stringify(report.toolCounts)}`)
for (const s of summaries) {
  console.log(`  ${s.family.padEnd(10)} ${String(s.accuracy).padStart(6)}%  ${s.passed}/${s.total}  p50=${s.latencyP50}ms  ttft=${s.ttftP50}ms  tok/task=${f(s.avgTokensPerTask)}`)
}
console.log(`laporan: ${jsonOut}`)
process.exit(0)
