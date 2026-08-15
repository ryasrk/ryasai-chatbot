/**
 * PRINASA Session Scenario Runner — long-session, cross-session, and
 * source-toggle scenarios through the REAL chat pipeline.
 *
 *   long_session  : one session, 4–8 turns each; scores per-turn answers,
 *                   follow-up resolution, and topic-contamination.
 *   cross_session : separate sessions; scores whether session B resolves
 *                   references to session A honestly (memory or graceful
 *                   re-derivation — never hallucination).
 *   source_toggle : flips promptSettings.tools via the real API, then
 *                   classifies honesty: with SQL off a DB question must be
 *                   DECLINED (never fabricated), with RAG off a doc question
 *                   must not cite documents; re-enabling must restore answers.
 *
 * Usage:
 *   bun run benchmark/prinasa-session-runner.ts                     # all 40
 *   bun run benchmark/prinasa-session-runner.ts --kind long         # 20
 *   bun run benchmark/prinasa-session-runner.ts --kind cross        # 10
 *   bun run benchmark/prinasa-session-runner.ts --kind toggle       # 10
 *   bun run benchmark/prinasa-session-runner.ts --id prinl-004
 *
 * Prereqs: server on BENCHMARK_BASE_URL, admin cookie at BENCHMARK_COOKIE_FILE
 * (same as prinasa-runner.ts), PRINASA integration + documents configured.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs'
import { consumeSseStream, timeoutSignal } from './sse-client'
import {
  prinasaLongSessionScenarios,
  prinasaCrossSessionScenarios,
  prinasaToggleScenarios,
} from './questions/prinasa-sessions'
import type {
  SessionTurn,
  LongSessionScenario,
  CrossSessionScenario,
  ToggleScenario,
  ToggleStep,
  ToggleExpectedBehavior,
} from './types'

const BASE_URL = process.env.BENCHMARK_BASE_URL ?? 'http://localhost:3000'
const COOKIE_FILE = process.env.BENCHMARK_COOKIE_FILE ?? '/tmp/opencode/cookies.txt'
const TIMEOUT_MS = Number(process.env.BENCHMARK_TIMEOUT_MS ?? 150_000)

const argv = process.argv.slice(2)
const kindFilter = argv.find((a) => a.startsWith('--kind='))?.split('=')[1]
  ?? (argv.includes('--kind') ? argv[argv.indexOf('--kind') + 1] : undefined)
const idFilter = argv.find((a) => a.startsWith('--id='))?.split('=')[1]
  ?? (argv.includes('--id') ? argv[argv.indexOf('--id') + 1] : undefined)

function loadCookie(): string {
  if (!existsSync(COOKIE_FILE)) {
    console.error(`[session-runner] No cookie at ${COOKIE_FILE} — login first (see prinasa-runner.ts header).`)
    process.exit(1)
  }
  const raw = readFileSync(COOKIE_FILE, 'utf8')
  const pairs = [...raw.matchAll(/\t([^\t]+)\t([^\t]+)\n/g)].map((m) => `${m[1]}=${m[2]}`)
  if (pairs.length === 0) {
    console.error('[session-runner] Cookie file has no parseable cookies.')
    process.exit(1)
  }
  return pairs.join('; ')
}

// ---------------------------------------------------------------------------
// Pipeline transport
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** ponytail: chat POSTs are rate-limited (30/min) — retry 429 with backoff so
 * a scenario burst doesn't turn into instant cascading failures. */
async function fetchWithRetry(url: string, init: RequestInit, maxRetries = 4): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const res = await fetch(url, init)
    if (res.status !== 429) return res
    const wait = 5_000 * (attempt + 1)
    console.warn(`[429] rate-limited — waiting ${wait / 1000}s (attempt ${attempt + 1}/${maxRetries})`)
    await sleep(wait)
  }
  throw new Error('rate limited after retries')
}

async function newSession(cookie: string): Promise<string> {
  const res = await fetchWithRetry(`${BASE_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
    signal: timeoutSignal(30_000),
  })
  if (!res.ok) throw new Error(`session create: HTTP ${res.status}`)
  const data = await res.json()
  return data.id ?? data.session?.id
}

async function sendTurn(cookie: string, sessionId: string, text: string) {
  const res = await fetchWithRetry(`${BASE_URL}/api/chat/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, allowMultiStepDag: true }),
    signal: timeoutSignal(TIMEOUT_MS),
  })
  const sse = await consumeSseStream(res)
  if (sse.error) {
    throw new Error(`stream error: ${sse.error.code} — ${sse.error.message.slice(0, 200)}`)
  }
  return {
    answer: sse.answer,
    citations: sse.citations,
    toolRuns: sse.toolRuns,
  }
}

async function setTools(cookie: string, tools: { sql: boolean; rag: boolean; restApi?: boolean }) {
  const res = await fetch(`${BASE_URL}/api/prompt-tools`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tools }),
    signal: timeoutSignal(30_000),
  })
  if (!res.ok) throw new Error(`set-tools: HTTP ${res.status}`)
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
const CLARIFY_MARKERS = [
  'could you clarify', 'can you clarify', 'which one do you mean', 'please specify',
  'mau tanya', 'maksudnya', 'bisa dijelaskan', 'do you want', 'apakah yang anda maksud',
]
const LOOP_MARKERS = [
  'continue analyzing', 'let me continue', 'analyzing further', 'searching more',
  'still analyzing', 'i will analyze', 'melakukan analisis lebih', 'menelusuri lebih lanjut',
]
const REFUSAL_MARKERS = [
  'cannot query', "can't query", 'tidak dapat mengakses', 'tidak bisa mengakses',
  'unable to query', 'database is not available', 'sql.*disabled', 'tool.*disabled',
  'tidak tersedia', 'not available', 'cannot access the database', "i don't have access",
  'saya tidak bisa mengakses', 'fitur basis data', 'data source tidak',
]

function lower(s: string) { return s.toLowerCase() }

function isClarifying(answer: string): boolean {
  const l = lower(answer)
  return CLARIFY_MARKERS.some((m) => l.includes(m)) && answer.length < 400
}
function isLooping(answer: string): boolean {
  const l = lower(answer)
  return LOOP_MARKERS.some((m) => l.includes(m))
}
function looksLikeRefusal(answer: string): boolean {
  const l = lower(answer)
  return REFUSAL_MARKERS.some((m) => new RegExp(m).test(l))
}
function hasDocCitation(citations: Array<{ type?: string }>): boolean {
  return citations.some((c) => (c.type ?? '').toUpperCase().includes('DOCUMENT'))
}
function hasDbCitation(citations: Array<{ type?: string }>, toolRuns: Array<{ type?: string }>): boolean {
  const cited = citations.some((c) => ['DATABASE', 'SQL', 'INTEGRATION'].includes((c.type ?? '').toUpperCase()))
  const ran = toolRuns.some((t) => ['SQL', 'sql'].includes(String(t.type)))
  return cited || ran
}

// ---------------------------------------------------------------------------
// Result models
// ---------------------------------------------------------------------------
export interface TurnResult {
  index: number
  question: string
  answerExcerpt: string
  pass: boolean
  failureReasons: string[]
  outcome: 'answered' | 'clarified' | 'looped' | 'errored' | 'timeout'
  latencyMs: number
  cited: { docs: boolean; db: boolean }
}
export interface ScenarioResult {
  scenarioId: string
  kind: 'long_session' | 'cross_session' | 'source_toggle'
  description: string
  pass: boolean
  turnResults: TurnResult[]
  /** cross-session only: whether memory probes appeared in session B */
  memoryProbeHits?: string[]
  memoryProbeMissed?: string[]
  error?: string
}

function scoreTurn(
  turn: { question: string; expectContains?: string[]; expectNotContains?: string[] },
  answer: string,
  citations: Array<{ type?: string }>,
  toolRuns: Array<{ type?: string }>,
  latencyMs: number,
): TurnResult {
  const reasons: string[] = []
  const l = lower(answer)

  let outcome: TurnResult['outcome'] = 'answered'
  if (isLooping(answer)) { outcome = 'looped'; reasons.push('loop marker in answer') }
  else if (isClarifying(answer)) { outcome = 'clarified'; reasons.push('clarification instead of answer') }

  for (const tok of turn.expectContains ?? []) {
    if (!l.includes(tok.toLowerCase())) reasons.push(`missing expected token: "${tok}"`)
  }
  for (const tok of turn.expectNotContains ?? []) {
    if (l.includes(tok.toLowerCase())) reasons.push(`contamination/fabrication: unexpected "${tok}"`)
  }

  return {
    index: 0,
    question: turn.question,
    answerExcerpt: answer.slice(0, 400),
    pass: outcome === 'answered' && reasons.length === 0,
    failureReasons: reasons,
    outcome,
    latencyMs,
    cited: { docs: hasDocCitation(citations), db: hasDbCitation(citations, toolRuns) },
  }
}

// ---------------------------------------------------------------------------
// Runners per scenario kind
// ---------------------------------------------------------------------------
async function runLongSession(cookie: string, s: LongSessionScenario): Promise<ScenarioResult> {
  const sessionId = await newSession(cookie)
  const turnResults: TurnResult[] = []
  for (const [i, turn] of s.turns.entries()) {
    const t0 = Date.now()
    try {
      const { answer, citations, toolRuns } = await sendTurn(cookie, sessionId, turn.question)
      const tr = scoreTurn(turn, answer, citations, toolRuns, Date.now() - t0)
      tr.index = i + 1
      turnResults.push(tr)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      turnResults.push({
        index: i + 1, question: turn.question, answerExcerpt: '', pass: false,
        failureReasons: [msg.slice(0, 200)],
        outcome: /timeout|aborted/i.test(msg) ? 'timeout' : 'errored',
        latencyMs: Date.now() - t0, cited: { docs: false, db: false },
      })
    }
  }
  return {
    scenarioId: s.id, kind: 'long_session', description: s.description,
    pass: turnResults.every((t) => t.pass), turnResults,
  }
}

async function runCrossSession(cookie: string, s: CrossSessionScenario): Promise<ScenarioResult> {
  const turnResults: TurnResult[] = []
  let turnIdx = 0
  const allProbeHits: string[] = []
  const allProbeMissed: string[] = []

  for (const sess of s.sessions) {
    const sessionId = await newSession(cookie)
    for (const turn of sess.turns) {
      const t0 = Date.now()
      try {
        const { answer, citations, toolRuns } = await sendTurn(cookie, sessionId, turn.question)
        const tr = scoreTurn(turn, answer, citations, toolRuns, Date.now() - t0)
        tr.index = ++turnIdx
        turnResults.push(tr)
        // Memory probes scored leniently: hit is bonus, miss is informational
        for (const probe of sess.memoryProbes ?? []) {
          if (lower(answer).includes(lower(probe))) allProbeHits.push(probe)
          else allProbeMissed.push(probe)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        turnResults.push({
          index: ++turnIdx, question: turn.question, answerExcerpt: '', pass: false,
          failureReasons: [msg.slice(0, 200)],
          outcome: /timeout|aborted/i.test(msg) ? 'timeout' : 'errored',
          latencyMs: Date.now() - t0, cited: { docs: false, db: false },
        })
      }
    }
  }
  return {
    scenarioId: s.id, kind: 'cross_session', description: s.description,
    pass: turnResults.every((t) => t.pass),
    turnResults, memoryProbeHits: allProbeHits, memoryProbeMissed: allProbeMissed,
  }
}

function classifyToggleStep(
  step: Extract<ToggleStep, { action: 'ask' }>,
  answer: string,
  citations: Array<{ type?: string }>,
  toolRuns: Array<{ type?: string }>,
): { behavior: ToggleExpectedBehavior; pass: boolean; reasons: string[] } {
  const reasons: string[] = []
  const docs = hasDocCitation(citations)
  const db = hasDbCitation(citations, toolRuns)

  let actual: ToggleExpectedBehavior
  if (isLooping(answer)) actual = 'answers-chat' // placeholder; loop = hard fail below
  else if (looksLikeRefusal(answer) || (!db && !docs && answer.length < 1200 && /cannot|tidak|unable|unavailable/i.test(answer))) actual = 'refuses-db'
  else if (db) actual = 'answers-db'
  else if (docs) actual = 'answers-knowledge'
  else actual = 'answers-chat'

  if (isLooping(answer)) reasons.push('⛔ loop marker — the reported bug')
  if (isClarifying(answer)) reasons.push('⚠ clarification instead of classified behavior')

  const expected = step.expectBehavior
  if (expected === 'refuses-db') {
    if (db && step.expectNotContains?.some((t) => lower(answer).includes(lower(t)))) {
      reasons.push('fabricated DB answer while SQL disabled')
    }
    if (actual === 'answers-db') reasons.push(`expected honest refusal, got DB answer (SQL should be off)`)
  }
  if (expected === 'answers-db' && actual !== 'answers-db' && !reasons.length) {
    reasons.push(`expected DB answer, got ${actual}`)
  }
  if (expected === 'answers-knowledge' && actual !== 'answers-knowledge') {
    reasons.push(`expected knowledge answer, got ${actual}`)
  }
  if (expected === 'answers-chat' && isLooping(answer)) {
    // already recorded
  }
  if (expected === 'no-doc-citation' && docs) {
    reasons.push('cited documents while RAG disabled')
  }
  for (const tok of step.expectContains ?? []) {
    if (!lower(answer).includes(lower(tok))) reasons.push(`missing expected token: "${tok}"`)
  }
  for (const tok of step.expectNotContains ?? []) {
    if (lower(answer).includes(lower(tok))) reasons.push(`unexpected token (fabrication): "${tok}"`)
  }
  return { behavior: actual, pass: reasons.length === 0, reasons }
}

async function runToggleScenario(cookie: string, s: ToggleScenario): Promise<ScenarioResult> {
  // Snapshot current tools to restore afterwards, regardless of scenario content
  let restore: { sql: boolean; rag: boolean; restApi: boolean } | null = null
  try {
    const cur = await fetch(`${BASE_URL}/api/prompt-tools`, {
      headers: { Cookie: cookie }, signal: AbortSignal.timeout(30_000),
    })
    if (cur.ok) {
      const data = await cur.json()
      restore = data.settings?.tools ?? { sql: true, rag: true, restApi: true }
    }
  } catch { /* best effort */ }

  const turnResults: TurnResult[] = []
  try {
    for (const [i, step] of s.steps.entries()) {
      if (step.action === 'set-tools') {
        await setTools(cookie, step.tools)
        continue
      }
      if (step.action === 'restore-tools') {
        if (restore) await setTools(cookie, restore)
        continue
      }
      // ask
      const sessionId = await newSession(cookie) // fresh session per toggle question — measures routing, not memory
      const t0 = Date.now()
      try {
        const { answer, citations, toolRuns } = await sendTurn(cookie, sessionId, step.question)
        const cls = classifyToggleStep(step, answer, citations, toolRuns)
        turnResults.push({
          index: i + 1, question: step.question, answerExcerpt: answer.slice(0, 400),
          pass: cls.pass,
          failureReasons: cls.reasons.length ? cls.reasons : [`${cls.behavior} ≠ ${step.expectBehavior}`].filter(() => !cls.pass),
          outcome: cls.pass ? 'answered' : (isLooping(answer) ? 'looped' : isClarifying(answer) ? 'clarified' : 'answered'),
          latencyMs: Date.now() - t0,
          cited: { docs: hasDocCitation(citations), db: hasDbCitation(citations, toolRuns) },
        })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        turnResults.push({
          index: i + 1, question: step.question, answerExcerpt: '', pass: false,
          failureReasons: [msg.slice(0, 200)],
          outcome: /timeout|aborted/i.test(msg) ? 'timeout' : 'errored',
          latencyMs: Date.now() - t0, cited: { docs: false, db: false },
        })
      }
    }
  } finally {
    if (restore) { try { await setTools(cookie, restore) } catch { /* best effort */ } }
  }
  return {
    scenarioId: s.id, kind: 'source_toggle', description: s.description,
    pass: turnResults.every((t) => t.pass), turnResults,
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cookie = loadCookie()

  let longs = prinasaLongSessionScenarios
  let crosses = prinasaCrossSessionScenarios
  let toggles = prinasaToggleScenarios
  if (idFilter) {
    longs = longs.filter((s) => s.id === idFilter)
    crosses = crosses.filter((s) => s.id === idFilter)
    toggles = toggles.filter((s) => s.id === idFilter)
  } else if (kindFilter) {
    if (kindFilter === 'long') { crosses = []; toggles = [] }
    if (kindFilter === 'cross') { longs = []; toggles = [] }
    if (kindFilter === 'toggle') { longs = []; crosses = [] }
  }

  const scenarioFns: Array<() => Promise<ScenarioResult>> = []
  const labels: string[] = []
  for (const s of longs) { labels.push(s.id); scenarioFns.push(() => runLongSession(cookie, s)) }
  for (const s of crosses) { labels.push(s.id); scenarioFns.push(() => runCrossSession(cookie, s)) }
  for (const s of toggles) { labels.push(s.id); scenarioFns.push(() => runToggleScenario(cookie, s)) }

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  PRINASA SESSION SCENARIOS — ${labels.length} (${longs.length} long, ${crosses.length} cross, ${toggles.length} toggle)`)
  console.log(`${'═'.repeat(70)}\n`)

  const results: ScenarioResult[] = []
  // Run scenarios sequentially — eager promise creation floods the rate limiter
  // with 40+ simultaneous session-create + send calls.
  for (const [i, fn] of scenarioFns.entries()) {
    process.stdout.write(`[${String(i + 1).padStart(3)}/${labels.length}] ${labels[i]} … `)
    try {
      const r = await fn()
      results.push(r)
      const turnsOk = r.turnResults.filter((t) => t.pass).length
      console.log(`${r.pass ? '✔' : '✖'} ${turnsOk}/${r.turnResults.length} turns${r.memoryProbeHits?.length ? ` (memory:${r.memoryProbeHits.length}✓)` : ''}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      results.push({ scenarioId: labels[i], kind: 'long_session', description: '', pass: false, turnResults: [], error: msg.slice(0, 300) })
      console.log(`✖ scenario error: ${msg.slice(0, 120)}`)
    }
    // Pace under the chat rate limit between scenarios.
    await sleep(4_000)
  }

  const byKind = (k: ScenarioResult['kind']) => results.filter((r) => r.kind === k)
  const allTurns = results.flatMap((r) => r.turnResults)
  const loopCount = allTurns.filter((t) => t.outcome === 'looped').length
  const clarifyCount = allTurns.filter((t) => t.outcome === 'clarified').length

  console.log(`\n${'═'.repeat(70)}`)
  console.log(`  SUMMARY`)
  console.log(`${'═'.repeat(70)}`)
  for (const k of ['long_session', 'cross_session', 'source_toggle'] as const) {
    const rs = byKind(k)
    if (rs.length === 0) continue
    const passed = rs.filter((r) => r.pass).length
    const turns = rs.flatMap((r) => r.turnResults)
    const turnPass = turns.filter((t) => t.pass).length
    console.log(`  ${k.padEnd(14)}: ${passed}/${rs.length} scenarios, ${turnPass}/${turns.length} turns`)
  }
  console.log(`  ⛔ looped turns    : ${loopCount}  ← must be 0`)
  console.log(`  ⚠ clarified turns : ${clarifyCount}`)
  const memHits = results.reduce((s, r) => s + (r.memoryProbeHits?.length ?? 0), 0)
  const memMiss = results.reduce((s, r) => s + (r.memoryProbeMissed?.length ?? 0), 0)
  if (memHits + memMiss > 0) console.log(`  cross-session memory probes: ${memHits}/${memHits + memMiss} recalled`)
  console.log(`  fabrication flags : ${allTurns.reduce((s, t) => s + t.failureReasons.filter((r) => r.includes('fabrication') || r.includes('unexpected token')).length, 0)}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = `benchmark/results/prinasa-sessions-${stamp}.json`
  writeFileSync(outPath, JSON.stringify({ summary: { scenarios: results.length, passed: results.filter((r) => r.pass).length, loopCount, clarifyCount }, results }, null, 2))
  console.log(`\n  report → ${outPath}\n`)
}

void main()
