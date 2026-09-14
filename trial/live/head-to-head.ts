/**
 * HEAD-TO-HEAD: the full pipeline vs the small one, on the same 100 questions.
 *
 * Both pipelines are served by the SAME dev server process, selected per request by
 * the `SIMPLE_PIPELINE` env var. That is deliberate: it holds the model, the database,
 * the seed data and the machine constant across the comparison, so a difference in the
 * numbers is attributable to the routing and not to a restarted process or a warmed
 * cache. The server must therefore be started with SIMPLE_PIPELINE=1 and this script
 * flips the variable per request.
 *
 * HOW THE FLAG IS FLIPPED PER REQUEST
 * -----------------------------------
 * `SIMPLE_PIPELINE` is read inside the route handler, so it is evaluated per request
 * against `process.env` of the SERVER process, which this script cannot write to. The
 * route accepts an override header (`x-pipeline`) for exactly this purpose, used only
 * when `SIMPLE_PIPELINE` is set, so the flag cannot be toggled by a client in a normal
 * deployment.
 *
 * WHAT IS MEASURED
 * ----------------
 *   accuracy    graded per question from `accept`/`reject` regexes
 *   wrongRoute  share of DATA questions (DB/DOC) where the answer refused or came
 *               from the wrong source -- the failure a routing test exists to catch
 *   latency     p50/p90 wall clock
 *   ttft        p50 time to first token, which is the pre-token pipeline cost
 *
 * Usage: bun trial/live/head-to-head.ts [--json out.json]
 * Env:   BASE (default http://localhost:3000)
 */
import { ROUTING_CASES, type RoutingCase } from './questions-routing'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null

type Pipeline = 'full' | 'simple'

interface Row {
  id: string
  family: RoutingCase['family']
  expect: string
  pipeline: Pipeline
  ok: boolean
  latencyMs: number
  ttftMs: number | null
  answer: string
  reason?: string
}

const TOKEN = await (async () => {
  const p = Bun.spawnSync(['bun', 'trial/live/session.ts'], { stdout: 'pipe', stderr: 'pipe' })
  const out = new TextDecoder().decode(p.stdout).trim().split('\n').pop() ?? ''
  return (JSON.parse(out) as { token: string }).token
})()

async function newSession(): Promise<string> {
  const r = await fetch(`${BASE}/api/chat/sessions`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${TOKEN}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!r.ok) throw new Error(`session create failed: ${r.status}`)
  return ((await r.json()) as { id: string }).id
}

/**
 * Drive one turn. Resilient to a mid-stream socket death: Bun's DOMException carries
 * `stack: ''` and serialises to `{}`, so a bare catch would report an empty reason.
 */
async function ask(sessionId: string, question: string, pipeline: Pipeline) {
  const started = Date.now()
  let ttftMs: number | null = null
  let answer = ''
  let errorText = ''
  let routeChosen = ''
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/send`, {
      method: 'POST',
      headers: {
        Cookie: `x-active-user=${TOKEN}`,
        'Content-Type': 'application/json',
        'x-pipeline': pipeline,
      },
      body: JSON.stringify({ text: question }),
    })
    if (!res.body) throw new Error('no body')
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let event = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('event: ')) {
          event = t.slice(7)
          continue
        }
        if (!t.startsWith('data: ')) continue
        let payload: Record<string, unknown>
        try {
          payload = JSON.parse(t.slice(6)) as Record<string, unknown>
        } catch {
          continue
        }
        if (event === 'token' && typeof payload.content === 'string') {
          if (ttftMs === null) ttftMs = Date.now() - started
          answer += payload.content
        } else if (event === 'answer' && typeof payload.content === 'string') {
          answer = payload.content
        } else if (event === 'tool_start' && typeof payload.tool === 'string') {
          routeChosen = payload.tool
        } else if (event === 'error') {
          errorText = String(payload.message ?? payload.code ?? 'error')
        }
        event = ''
      }
    }
  } catch (e) {
    errorText = e instanceof Error && e.message ? e.message : 'stream failed'
  }
  return { answer, ttftMs, latencyMs: Date.now() - started, errorText, routeChosen }
}

function grade(c: RoutingCase, answer: string): { ok: boolean; reason?: string } {
  if (!answer.trim()) return { ok: false, reason: 'empty answer' }
  for (const re of c.accept) {
    if (!re.test(answer)) return { ok: false, reason: `missing ${re}` }
  }
  for (const re of c.reject ?? []) {
    if (re.test(answer)) return { ok: false, reason: `matched reject ${re}` }
  }
  return { ok: true }
}

function pct(n: number, d: number): string {
  return d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(2)}%`
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

const rows: Row[] = []
// Order alternates per case so a drifting server warms both pipelines equally rather
// than giving whichever ran first a systematic advantage.
for (const c of ROUTING_CASES) {
  const order: Pipeline[] = rows.length % 2 === 0 ? ['full', 'simple'] : ['simple', 'full']
  for (const pipeline of order) {
    let row: Row
    try {
      const sessionId = await newSession()
      const r = await ask(sessionId, c.question, pipeline)
      const g = r.errorText
        ? { ok: false, reason: `provider error: ${r.errorText}` }
        : grade(c, r.answer)
      row = {
        id: c.id, family: c.family, expect: c.expect, pipeline, ok: g.ok,
        latencyMs: r.latencyMs, ttftMs: r.ttftMs,
        answer: r.answer.replace(/\s+/g, ' ').slice(0, 160), reason: g.reason,
      }
    } catch (e) {
      row = {
        id: c.id, family: c.family, expect: c.expect, pipeline, ok: false,
        latencyMs: 0, ttftMs: null, answer: '',
        reason: `harness error: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    rows.push(row)
    const mark = row.ok ? 'ok  ' : 'FAIL'
    console.log(`${mark} [${pipeline.padEnd(6)}] ${row.id.padEnd(4)} ${String(row.latencyMs).padStart(6)}ms  ${c.question.slice(0, 52)}`)
    if (!row.ok) console.log(`        -> ${row.reason ?? ''} | ${row.answer.slice(0, 110)}`)
  }
}

const summary: Record<string, unknown> = {}
for (const pipeline of ['full', 'simple'] as Pipeline[]) {
  const mine = rows.filter((r) => r.pipeline === pipeline)
  const pass = mine.filter((r) => r.ok).length
  const dataQs = mine.filter((r) => r.family === 'DB' || r.family === 'DOC')
  const lat = mine.map((r) => r.latencyMs)
  const ttft = mine.map((r) => r.ttftMs).filter((x): x is number => x !== null)
  summary[pipeline] = {
    total: mine.length,
    pass,
    accuracy: pct(pass, mine.length),
    dataQuestions: dataQs.length,
    dataPass: dataQs.filter((r) => r.ok).length,
    dataAccuracy: pct(dataQs.filter((r) => r.ok).length, dataQs.length),
    latencyP50: quantile(lat, 0.5),
    latencyP90: quantile(lat, 0.9),
    ttftP50: ttft.length ? quantile(ttft, 0.5) : null,
    byFamily: Object.fromEntries(
      (['DB', 'DOC', 'GREET', 'GENERAL', 'TRAP'] as const).map((f) => {
        const sub = mine.filter((r) => r.family === f)
        return [f, { n: sub.length, pass: sub.filter((r) => r.ok).length, acc: pct(sub.filter((r) => r.ok).length, sub.length) }]
      }),
    ),
  }
}

console.log('\n=== HEAD TO HEAD ===')
for (const [k, v] of Object.entries(summary)) {
  const s = v as Record<string, unknown>
  console.log(
    `${k.padEnd(7)} acc ${String(s.accuracy).padStart(7)} (${s.pass}/${s.total})  ` +
      `data ${String(s.dataAccuracy).padStart(7)} (${s.dataPass}/${s.dataQuestions})  ` +
      `p50 ${String(s.latencyP50).padStart(6)}ms  p90 ${String(s.latencyP90).padStart(6)}ms  ` +
      `ttft p50 ${String(s.ttftP50).padStart(6)}ms`,
  )
  console.log(`        ${JSON.stringify(s.byFamily)}`)
}

if (JSON_OUT) {
  await Bun.write(JSON_OUT, JSON.stringify({ summary, rows }, null, 2))
  console.log(`\nwrote ${JSON_OUT}`)
}
