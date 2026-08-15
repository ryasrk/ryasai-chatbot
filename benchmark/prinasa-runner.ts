/**
 * PRINASA Hybrid Benchmark Runner — drives the FULL chat pipeline
 * (intent → routing → tool execution → synthesis) against questions that
 * need BOTH the PRINASA database and document knowledge.
 *
 * Why this runner exists (incident 2026-08): with a knowledge base AND a
 * database integration both configured, the chatbot entered endless
 * "continue analyzing" loops and vague clarification questions — it never
 * answered. The SQL-only runner (runner.ts) cannot see that failure because
 * it calls generateSql directly. This runner goes through
 * runNonStreamingChatCompletion exactly like the real chat UI and scores:
 *
 *   - looped:      the agentic loop hit its iteration ceiling (BUG)
 *   - clarified:   returned a clarification question instead of answering,
 *                  even though the question is self-contained (BUG)
 *   - db_answered / knowledge_answered: source coverage
 *   - dbTokensHit / knowledgeKeywordsHit: content correctness per source
 *   - latencyMs + llmCalls: cost of getting there
 *
 * Usage:
 *   bun run benchmark/prinasa-runner.ts                       # all 405
 *   bun run benchmark/prinasa-runner.ts --only-hybrid         # 20 flagship
 *   bun run benchmark/prinasa-runner.ts --limit 25
 *   bun run benchmark/prinasa-runner.ts --category aggregation
 *   bun run benchmark/prinasa-runner.ts --skip-sql            # hybrid only, no SQL-half check
 *
 * Prereqs: dev/prod server running, PRINASA integration created, documents
 * uploaded + embedded, LLM configured. Uses an internal admin session via
 * BENCHMARK_SESSION_COOKIE (or falls back to cookies.txt from curl login).
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { consumeSseStream, timeoutSignal } from './sse-client'

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? 'http://localhost:3000'
const COOKIE_FILE = process.env.BENCHMARK_COOKIE_FILE ?? '/tmp/opencode/cookies.txt'
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS ?? 120_000)

interface CliArgs {
  limit?: number
  category?: string
  onlyHybrid: boolean
  skipSql: boolean
}
function parseArgs(): CliArgs {
  const argv = process.argv.slice(2)
  // Accept both --limit=25 and --limit 25 (the flag style varies by docs/habit)
  const limitIdx = argv.findIndex((a) => a === '--limit' || a.startsWith('--limit='))
  const limit = limitIdx >= 0
    ? argv[limitIdx].includes('=')
      ? Number(argv[limitIdx].split('=')[1])
      : Number(argv[limitIdx + 1])
    : undefined
  const catIdx = argv.findIndex((a) => a === '--category' || a.startsWith('--category='))
  const category = catIdx >= 0
    ? argv[catIdx].includes('=')
      ? argv[catIdx].split('=')[1]
      : argv[catIdx + 1]
    : undefined
  return {
    limit: Number.isFinite(limit) ? limit : undefined,
    category,
    onlyHybrid: argv.includes('--only-hybrid') || argv.includes('--skip-sql'),
    skipSql: argv.includes('--skip-sql'),
  }
}

// ---------------------------------------------------------------------------
// Question sets (static imports keep the bundler happy)
// ---------------------------------------------------------------------------
import { prinasaSqlQuestions } from './questions/prinasa-sql'
import { prinasaSqlQuestions2 } from './questions/prinasa-sql2'
import { prinasaSqlQuestions3 } from './questions/prinasa-sql3'
import { prinasaSqlQuestions4 } from './questions/prinasa-sql4'
import {
  prinasaRobustnessQuestions,
  prinasaHybridQuestions,
} from './questions/prinasa-hybrid'
import type { BenchmarkQuestion, HybridBenchmarkQuestion } from './types'

const ALL_SQL: BenchmarkQuestion[] = [
  ...prinasaSqlQuestions,
  ...prinasaSqlQuestions2,
  ...prinasaSqlQuestions3,
  ...prinasaSqlQuestions4,
  ...prinasaRobustnessQuestions,
]

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------
export type HybridOutcome =
  | 'answered'        // final answer produced
  | 'clarified'       // pipeline returned a clarification instead of answering
  | 'looped'          // agentic loop exhausted iterations (the reported bug)
  | 'errored'         // pipeline threw
  | 'timeout'

export interface HybridResult {
  questionId: string
  category: string
  difficulty: string
  question: string
  outcome: HybridOutcome
  answer: string
  answerTruncated: string
  llmCalls: number
  latencyMs: number
  dbTokensHit: string[]
  dbTokensMissed: string[]
  knowledgeKeywordsHit: string[]
  knowledgeKeywordsMissed: string[]
  citations: Array<{ type?: string; source?: string }>
  toolRunTypes: string[]
  isHybrid: boolean
  error?: string
}

function loadCookie(): string {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`[hybrid-runner] No session cookie at ${COOKIE_FILE}.
Login first:
  curl -s -c ${COOKIE_FILE} -X POST ${BASE_URL}/api/auth/login \\
    -H 'Content-Type: application/json' \\
    -d '{"email":"<admin>","password":"<pass>"}'`)
    process.exit(1)
  }
  const raw = readFileSync(COOKIE_FILE, 'utf8')
  const pairs = [...raw.matchAll(/\t([^\t]+)\t([^\t]+)\n/g)].map((m) => `${m[1]}=${m[2]}`)
  if (pairs.length === 0) {
    console.error('[hybrid-runner] Cookie file has no parseable cookies.')
    process.exit(1)
  }
  return pairs.join('; ')
}

// ---------------------------------------------------------------------------
// Pipeline call — mirrors the chat UI's HTTP path
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** ponytail: middleware rate-limits chat POSTs (30/min default). Two POSTs per
 * question (session create + send) means a benchmark run would trip 429 within
 * ~15 questions and every subsequent item fails instantly — indistinguishable
 * from real errors in the report. Retry with backoff instead, and pace the
 * loop just under the window. */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 4): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(url, init)
    if (res.status !== 429) return res
    const wait = 5_000 * (attempt + 1)
    console.warn(`[429] rate-limited — waiting ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})`)
    await sleep(wait)
  }
  throw lastErr ?? new Error('rate limited after retries')
}

async function askChatPipeline(
  cookie: string,
  question: string,
): Promise<{ answer: string; citations: Array<{ type?: string; source?: string }>; toolRunTypes: string[]; llmCalls: number }> {
  // Create a fresh session per question so history never bleeds across items.
  const sessRes = await fetchWithRetry(`${BASE_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
    signal: timeoutSignal(30_000),
  })
  if (!sessRes.ok) throw new Error(`session create failed: HTTP ${sessRes.status}`)
  const sessJson = await sessRes.json()
  const sessionId = sessJson.id ?? sessJson.session?.id
  if (!sessionId) throw new Error('session create returned no id')

  const sendRes = await fetchWithRetry(`${BASE_URL}/api/chat/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text: question, allowMultiStepDag: true }),
    signal: timeoutSignal(TIMEOUT_MS),
  })
  const sse = await consumeSseStream(sendRes)
  if (sse.error) {
    throw new Error(`stream error: ${sse.error.code} — ${sse.error.message.slice(0, 200)}`)
  }
  return {
    answer: sse.answer,
    citations: sse.citations,
    toolRunTypes: sse.toolRuns.map((t) => t.type ?? 'unknown'),
    llmCalls: sse.toolRuns.length + 1,
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
const CLARIFY_MARKERS = [
  'could you clarify', 'can you clarify', 'which one do you mean',
  'please specify', 'could you specify', 'mau tanya', 'maksudnya',
  'bisa dijelaskan', 'tolong jelaskan lebih', 'which document',
  'do you want', 'apakah yang anda maksud',
]
const LOOP_MARKERS = [
  'continue analyzing', 'let me continue', 'analyzing further',
  'searching more', 'still analyzing', 'need more information to',
  'i will analyze', 'melakukan analisis lebih', 'menelusuri lebih lanjut',
]

function classifyOutcome(answer: string, llmCalls: number): HybridOutcome {
  const lower = answer.toLowerCase()
  if (LOOP_MARKERS.some((m) => lower.includes(m))) return 'looped'
  if (CLARIFY_MARKERS.some((m) => lower.includes(m)) && answer.length < 400) return 'clarified'
  if (llmCalls >= 8) return 'looped' // iteration ceiling proxy
  return 'answered'
}

function scoreTokens(answer: string, tokens: string[]) {
  const lower = answer.toLowerCase()
  // Normalize digit separators: Indonesian locale uses "." as thousands
  // separator (5.044 = 5044). Strip dots/commas between digits so "5044"
  // matches "5.044" and "5,044".
  const normalizedAnswer = lower.replace(/(\d)[.,](?=\d{3}\b)/g, '$1')
  // Indonesian-English translation map for common status values
  const translations: Record<string, string[]> = {
    'active': ['aktif'],
    'expired': ['kadaluarsa', 'kedaluwarsa'],
    'inactive': ['tidak aktif'],
    'pending': ['menunggu'],
    'approved': ['disetujui'],
    'rejected': ['ditolak'],
    'completed': ['selesai'],
    'cancelled': ['dibatalkan'],
  }
  const hit = tokens.filter((t) => {
    const tl = t.toLowerCase()
    if (lower.includes(tl)) return true
    // Try normalized form for numeric tokens
    if (/^\d+$/.test(tl)) {
      return normalizedAnswer.includes(tl)
    }
    // Try Indonesian translation
    const trans = translations[tl]
    if (trans && trans.some(tr => lower.includes(tr))) return true
    return false
  })
  return { hit, missed: tokens.filter((t) => !hit.includes(t)) }
}

// ---------------------------------------------------------------------------
// SQL-half verification (ground truth against the live PRINASA DB, optional)
// ---------------------------------------------------------------------------
async function verifySqlHalf(q: HybridBenchmarkQuestion): Promise<string[] | null> {
  if (!q.groundTruthSql) return null
  // The app's own guardrails clamp LIMIT; run ground truth verbatim via psql
  // is NOT available here — instead we only verify the ANSWER carries the DB
  // tokens, which is what matters for the hybrid score. SQL execution
  // correctness is already covered by the SQL runner for the same tables.
  return null
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs()
  const cookie = loadCookie()

  const sqlQuestions: BenchmarkQuestion[] = []
  const hybridQuestions: HybridBenchmarkQuestion[] = prinasaHybridQuestions

  if (!args.onlyHybrid) {
    let qs: BenchmarkQuestion[] = ALL_SQL
    if (args.category) qs = qs.filter((x) => x.category === args.category)
    sqlQuestions.push(...qs)
  }
  let all: Array<BenchmarkQuestion | HybridBenchmarkQuestion> = [...sqlQuestions, ...hybridQuestions]
  if (args.limit) all = all.slice(0, args.limit)

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  PRINASA HYBRID BENCHMARK — ${all.length} questions`)
  console.log(`  (${sqlQuestions.length} SQL + ${hybridQuestions.length} hybrid) → ${BASE_URL}`)
  console.log(`${'═'.repeat(70)}\n`)

  const results: HybridResult[] = []
  let consecutiveErrors = 0
  for (const [i, question] of all.entries()) {
    const isHybrid = question.category === 'cross_source_hybrid'
    const hq = question as HybridBenchmarkQuestion
    const started = Date.now()
    process.stdout.write(`[${String(i + 1).padStart(3)}/${all.length}] ${question.id} (${question.category}) … `)
    // ponytail: circuit breaker — 10 consecutive errors means the environment
    // is broken (server down / auth expired / LLM key dead), not that the
    // pipeline is failing per-question. Stop instead of burning an hour of
    // guaranteed-false results.
    if (consecutiveErrors >= 10) {
      console.log('\n[runner] 10 consecutive errors — environment looks broken, aborting run.')
      console.log('[runner] Fix the environment (server/cookie/LLM) and re-run.')
      break
    }
    try {
      await verifySqlHalf(hq)
      const r = await askChatPipeline(cookie, question.question)
      consecutiveErrors = 0
      const outcome = classifyOutcome(r.answer, r.llmCalls)
      const dbScore = scoreTokens(r.answer, question.expectedAnswerContains)
      const kbScore = isHybrid
        ? scoreTokens(r.answer, hq.expectedKnowledgeKeywords ?? [])
        : { hit: [], missed: [] }
      const result: HybridResult = {
        questionId: question.id,
        category: question.category,
        difficulty: question.difficulty,
        question: question.question,
        outcome,
        answer: r.answer,
        answerTruncated: r.answer.slice(0, 500),
        llmCalls: r.llmCalls,
        latencyMs: Date.now() - started,
        dbTokensHit: dbScore.hit,
        dbTokensMissed: dbScore.missed,
        knowledgeKeywordsHit: kbScore.hit,
        knowledgeKeywordsMissed: kbScore.missed,
        citations: r.citations,
        toolRunTypes: r.toolRunTypes,
        isHybrid,
      }
      results.push(result)
      const mark =
        outcome === 'answered' ? '✔' : outcome === 'looped' ? '⛔LOOP' : outcome === 'clarified' ? '⚠CLARIFY' : '✖'
      console.log(`${mark} ${outcome} (${result.latencyMs}ms, ${r.llmCalls} calls) db:${dbScore.hit.length}/${question.expectedAnswerContains.length}${isHybrid ? ` kb:${kbScore.hit.length}/${hq.expectedKnowledgeKeywords.length}` : ''}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const isTimeout = /timeout|aborted/i.test(msg)
      results.push({
        questionId: question.id,
        category: question.category,
        difficulty: question.difficulty,
        question: question.question,
        outcome: isTimeout ? 'timeout' : 'errored',
        answer: '',
        answerTruncated: '',
        llmCalls: 0,
        latencyMs: Date.now() - started,
        dbTokensHit: [],
        dbTokensMissed: question.expectedAnswerContains,
        knowledgeKeywordsHit: [],
        knowledgeKeywordsMissed: isHybrid ? (hq.expectedKnowledgeKeywords ?? []) : [],
        citations: [],
        toolRunTypes: [],
        isHybrid,
        error: msg.slice(0, 300),
      })
      consecutiveErrors += 1
      console.log(`✖ ${isTimeout ? 'timeout' : 'errored'}: ${msg.slice(0, 120)}`)
    }
    // Pace under the chat rate limit (30/min): 2 POSTs per question + margin.
    await sleep(4_500)
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const byOutcome = (o: HybridOutcome) => results.filter((r) => r.outcome === o).length
  const answered = results.filter((r) => r.outcome === 'answered')
  const hybridAnswered = answered.filter((r) => r.isHybrid)
  const hybridAll = results.filter((r) => r.isHybrid)

  const dbTokenAccuracy = (() => {
    const withTokens = results.filter((r) => (r.dbTokensHit.length + r.dbTokensMissed.length) > 0)
    if (withTokens.length === 0) return 0
    const hit = withTokens.reduce((s, r) => s + r.dbTokensHit.length, 0)
    const total = withTokens.reduce((s, r) => s + r.dbTokensHit.length + r.dbTokensMissed.length, 0)
    return Math.round((100 * hit) / Math.max(total, 1))
  })()
  const kbTokenAccuracy = (() => {
    const withTokens = hybridAll.filter((r) => (r.knowledgeKeywordsHit.length + r.knowledgeKeywordsMissed.length) > 0)
    if (withTokens.length === 0) return null
    const hit = withTokens.reduce((s, r) => s + r.knowledgeKeywordsHit.length, 0)
    const total = withTokens.reduce((s, r) => s + r.knowledgeKeywordsHit.length + r.knowledgeKeywordsMissed.length, 0)
    return Math.round((100 * hit) / Math.max(total, 1))
  })()
  const avgLatency = results.length ? Math.round(results.reduce((s, r) => s + r.latencyMs, 0) / results.length) : 0

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  SUMMARY — ${results.length} questions`)
  console.log(`${'═'.repeat(70)}`)
  console.log(`  answered   : ${byOutcome('answered')}/${results.length} (${Math.round(100 * byOutcome('answered') / Math.max(results.length, 1))}%)`)
  console.log(`  ⛔ looped    : ${byOutcome('looped')}   ← must be 0 (the reported bug)`)
  console.log(`  ⚠ clarified : ${byOutcome('clarified')} ← self-contained questions must not clarify`)
  console.log(`  ✖ errored   : ${byOutcome('errored')}   timeouts: ${byOutcome('timeout')}`)
  console.log(`  hybrid answered     : ${hybridAnswered.length}/${hybridAll.length}`)
  console.log(`  db token accuracy   : ${dbTokenAccuracy}%`)
  if (kbTokenAccuracy !== null) console.log(`  knowledge accuracy  : ${kbTokenAccuracy}%`)
  console.log(`  avg latency         : ${(avgLatency / 1000).toFixed(1)}s`)
  console.log(`  db-only answers (hybrid that missed knowledge): ${hybridAnswered.filter((r) => r.knowledgeKeywordsMissed.length > 0).length}`)
  console.log(`  kb-only answers (hybrid that missed db)       : ${hybridAnswered.filter((r) => r.dbTokensMissed.length > 0 && (r.dbTokensHit.length + r.dbTokensMissed.length) > 0).length}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = `benchmark/results/prinasa-hybrid-${stamp}.json`
  writeFileSync(outPath, JSON.stringify({ summary: { total: results.length, answered: byOutcome('answered'), looped: byOutcome('looped'), clarified: byOutcome('clarified'), errored: byOutcome('errored'), timeout: byOutcome('timeout'), dbTokenAccuracy, kbTokenAccuracy, avgLatency }, results }, null, 2))
  console.log(`\n  report → ${outPath}\n`)
}

void main()
