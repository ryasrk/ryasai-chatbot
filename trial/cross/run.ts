/**
 * Runs one 200-question family against the live app and reports accuracy,
 * latency and token usage.
 *
 * Usage: bun trial/cross/run.ts --family SQL_SALES --json out.json
 *
 * Each subagent runs ONE family so the four can proceed in parallel without
 * contending for the same output file. The parent merges the four JSON files.
 *
 * The SSE `answer` frame is the authoritative text: it is what the user sees, and
 * it is the only frame guaranteed to carry the complete synthesized answer. A
 * status frame ("tool":"SQL") describes the PLAN, not the outcome, so scoring on
 * it would grade the intent rather than the answer.
 */
import { writeFileSync } from 'node:fs'
import { casesForFamily, judgeAnswer, type Family, type CrossCase } from './questions'

const args = process.argv.slice(2)
const family = (args[args.indexOf('--family') + 1] ?? 'SQL_SALES') as Family
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : `/tmp/cross-${family}.json`
const BASE = process.env.CROSS_BASE ?? 'http://localhost:3000'

function jsonResponse(res: Response): Promise<unknown> {
  // `res.text()` consumes the body, so a later `res.json()` throws
  // "Body already used". Read once, then parse.
  return res.text().then((t) => JSON.parse(t))
}

async function mintToken(): Promise<string> {
  const proc = Bun.spawn(['bun', 'trial/live/session.ts'], { stdout: 'pipe', stderr: 'ignore' })
  const out = await new Response(proc.stdout).text()
  return (JSON.parse(out) as { token: string }).token
}

async function newSession(token: string): Promise<string> {
  const res = await fetch(`${BASE}/api/chat/sessions`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  return (await jsonResponse(res) as { id: string }).id
}

interface RunResult {
  id: string
  question: string
  answer: string
  tool: string | null
  ok: boolean
  reason: string
  latencyMs: number
  ttftMs: number | null
  /** Completion tokens reported by the provider for the whole turn, when available. */
  tokens: number | null
  error?: string
}

/** Reads the SSE stream once, keeping the last answer frame and the tool label. */
async function askOnce(token: string, question: string): Promise<Omit<RunResult, 'id' | 'ok' | 'reason'>> {
  const started = Date.now()
  const sessionId = await newSession(token)
  const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: question }),
  })
  if (!res.ok || !res.body) {
    return { question, answer: '', tool: null, latencyMs: Date.now() - started, ttftMs: null, tokens: null, error: `HTTP ${res.status}` }
  }

  let answer = ''
  let tool: string | null = null
  let ttftMs: number | null = null
  let tokens: number | null = null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        if (ttftMs === null) ttftMs = Date.now() - started
        buf += decoder.decode(value, { stream: true })
      }
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data: ')) continue
        let frame: Record<string, unknown>
        try {
          frame = JSON.parse(line.slice(6)) as Record<string, unknown>
        } catch {
          continue
        }
        const t = frame.tool
        if (typeof t === 'string' && t) tool = t
        // The answer frame is the one carrying a messageId -- the same discriminator
        // the UI uses. `content` alone also appears on unrelated progress frames.
        if (typeof frame.content === 'string' && 'messageId' in frame) answer = frame.content
        const usage = frame.usage as { completion_tokens?: number } | undefined
        if (usage && typeof usage.completion_tokens === 'number') tokens = usage.completion_tokens
      }
    }
  } catch (e) {
    return { question, answer: '', tool, latencyMs: Date.now() - started, ttftMs, tokens, error: String(e).slice(0, 120) }
  }
  return { question, answer, tool, latencyMs: Date.now() - started, ttftMs, tokens }
}

const all = casesForFamily(family)
const token = await mintToken()
const results: RunResult[] = []
console.log(`[${family}] ${all.length} soal dimulai`)

for (let i = 0; i < all.length; i++) {
  const c: CrossCase = all[i]
  const r = await askOnce(token, c.question)
  const verdict = r.error ? { ok: false, reason: `error: ${r.error}` } : judgeAnswer(c, r.answer)
  results.push({ id: c.id, ok: verdict.ok, reason: verdict.reason, ...r })
  if ((i + 1) % 20 === 0) {
    const pass = results.filter((x) => x.ok).length
    console.log(`[${family}] ${i + 1}/${all.length} benar=${pass} (${((pass / (i + 1)) * 100).toFixed(1)}%)`)
  }
}

const pass = results.filter((r) => r.ok).length
const lat = results.map((r) => r.latencyMs).sort((a, b) => a - b)
const ttfts = results.map((r) => r.ttftMs).filter((v): v is number => v !== null).sort((a, b) => a - b)
const withTokens = results.filter((r) => typeof r.tokens === 'number')
const p = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))] ?? 0

const summary = {
  family,
  total: results.length,
  passed: pass,
  accuracy: Number(((pass / results.length) * 100).toFixed(2)),
  latencyP50: p(lat, 0.5),
  latencyP90: p(lat, 0.9),
  ttftP50: p(ttfts, 0.5),
  ttftP90: p(ttfts, 0.9),
  /** Average completion tokens per task -- the "avg tokens/task" metric. */
  avgTokensPerTask: withTokens.length
    ? Number((withTokens.reduce((s, r) => s + (r.tokens ?? 0), 0) / withTokens.length).toFixed(2))
    : null,
  tokenSamples: withTokens.length,
  tokensPerSecondP50: withTokens.length
    ? Number(
        (withTokens
          .map((r) => ((r.tokens ?? 0) / Math.max(r.latencyMs - (r.ttftMs ?? r.latencyMs), 1)) * 1000)
          .sort((a, b) => a - b)[withTokens.length >> 1] ?? 0).toFixed(2),
      )
    : null,
  failures: results.filter((r) => !r.ok).slice(0, 40).map((r) => ({
    id: r.id,
    question: r.question.slice(0, 90),
    tool: r.tool,
    reason: r.reason,
    answer: r.answer.replace(/\s+/g, ' ').slice(0, 140),
  })),
}

writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2))
console.log(`[${family}] SELESAI akurasi=${summary.accuracy}% p50=${summary.latencyP50}ms ttftP50=${summary.ttftP50}ms avgTok/task=${summary.avgTokensPerTask}`)
console.log(`[${family}] hasil: ${jsonOut}`)
// Bun keeps the process alive on a pending keep-alive socket; end explicitly.
process.exit(0)
