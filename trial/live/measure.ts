/**
 * REAL accuracy / latency / token measurement through the production HTTP path.
 *
 * This is the measurement the earlier rounds honestly listed as unavailable. It
 * drives `POST /api/chat/sessions/[id]/send` against a running dev server with a
 * real BYOK provider, so the number covers the whole stack: tenant resolution,
 * intent pipeline, routing, the SSE transport, and the model.
 *
 * It does NOT claim to measure retrieval or SQL correctness -- those need data the
 * dev database does not have. `CASES` is deliberately factual/arithmetic/reasoning/
 * format, which a bare model can answer without org data.
 *
 * Usage: bun trial/live/measure.ts [--trials N] [--json out.json]
 * Env:   BASE (default http://localhost:3000)
 */
import { CASES } from './questions'

const BASE = process.env.BASE ?? 'http://localhost:3000'
const argv = process.argv.slice(2)
const TRIALS = (() => {
  const i = argv.indexOf('--trials')
  return i >= 0 ? Number(argv[i + 1]) : 1
})()
const JSON_OUT = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null

interface Row {
  id: string
  category: string
  trial: number
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

/** Drive one turn and reconstruct the answer + timing from the SSE events. */
async function ask(sessionId: string, question: string) {
  const started = Date.now()
  let ttftMs: number | null = null
  let answer = ''
  let errorText = ''
  const res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/send`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${TOKEN}`, 'Content-Type': 'application/json' },
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
      if (t.startsWith('event: ')) { event = t.slice(7); continue }
      if (!t.startsWith('data: ')) continue
      let payload: Record<string, unknown>
      try { payload = JSON.parse(t.slice(6)) as Record<string, unknown> } catch { continue }
      if (event === 'token' && typeof payload.content === 'string') {
        if (ttftMs === null) ttftMs = Date.now() - started
        answer += payload.content
      } else if (event === 'answer' && typeof payload.content === 'string') {
        // The authoritative full text; token events are incremental and can be partial.
        answer = payload.content
      } else if (event === 'error') {
        errorText = String(payload.message ?? payload.code ?? 'error')
      }
      event = ''
    }
  }
  return { answer, ttftMs, latencyMs: Date.now() - started, errorText }
}

function grade(id: string, category: string, answer: string): { ok: boolean; reason?: string } {
  const c = CASES.find((x) => x.id === id)!
  if (!answer.trim()) return { ok: false, reason: 'empty answer' }
  for (const re of c.accept) {
    if (!re.test(answer)) return { ok: false, reason: `missing ${re}` }
  }
  for (const re of c.reject ?? []) {
    if (re.test(answer)) return { ok: false, reason: `matched reject ${re}` }
  }
  return { ok: true }
}

const rows: Row[] = []
for (let trial = 1; trial <= TRIALS; trial++) {
  for (const c of CASES) {
    let row: Row
    try {
      const sessionId = await newSession()
      const r = await ask(sessionId, c.question)
      const g = r.errorText
        ? { ok: false, reason: `provider error: ${r.errorText}` }
        : grade(c.id, c.category, r.answer)
      row = {
        id: c.id, category: c.category, trial, ok: g.ok, latencyMs: r.latencyMs,
        ttftMs: r.ttftMs, answer: r.answer.replace(/\s+/g, ' ').slice(0, 160), reason: g.reason,
      }
    } catch (e) {
      row = { id: c.id, category: c.category, trial, ok: false, latencyMs: 0, ttftMs: null, answer: '', reason: `harness: ${(e as Error).message}` }
    }
    rows.push(row)
    console.log(`${row.ok ? 'PASS' : 'FAIL'} ${row.id} t${trial} ${row.latencyMs}ms ${row.reason ?? ''} :: ${row.answer.slice(0, 90)}`)
  }
}

const n = rows.length
const correct = rows.filter((r) => r.ok).length
const byCat = new Map<string, { n: number; ok: number }>()
for (const r of rows) {
  const b = byCat.get(r.category) ?? { n: 0, ok: 0 }
  b.n++; if (r.ok) b.ok++
  byCat.set(r.category, b)
}
const lat = rows.map((r) => r.latencyMs).sort((a, b) => a - b)
const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]
const ttfts = rows.map((r) => r.ttftMs).filter((t): t is number => t !== null)

console.log('\n' + '='.repeat(64))
console.log(`AKURASI LIVE: ${correct}/${n} = ${((correct / n) * 100).toFixed(2)}%  (${TRIALS} trial x ${CASES.length} soal)`)
for (const [cat, b] of [...byCat].sort()) {
  console.log(`  ${cat.padEnd(11)} ${b.ok}/${b.n} = ${((b.ok / b.n) * 100).toFixed(1)}%`)
}
console.log(`LATENSI    p50=${pct(50)}ms  p90=${pct(90)}ms  p99=${pct(99)}ms  max=${lat[lat.length - 1]}ms`)
if (ttfts.length) {
  const s = [...ttfts].sort((a, b) => a - b)
  console.log(`TTFT       p50=${s[Math.floor(s.length / 2)]}ms  max=${s[s.length - 1]}ms  (n=${s.length})`)
}
const failed = rows.filter((r) => !r.ok)
if (failed.length) {
  console.log(`\nKEGAGALAN (${failed.length}):`)
  for (const f of failed) console.log(`  ${f.id} :: ${f.reason} :: ${f.answer.slice(0, 80)}`)
}
if (JSON_OUT) {
  await Bun.write(JSON_OUT, JSON.stringify({
    measuredAt: new Date().toISOString(), base: BASE, trials: TRIALS,
    cases: CASES.length, total: n, correct, accuracyPct: Number(((correct / n) * 100).toFixed(2)),
    byCategory: Object.fromEntries([...byCat].map(([k, v]) => [k, { n: v.n, ok: v.ok }])),
    latency: { p50: pct(50), p90: pct(90), p99: pct(99), max: lat[lat.length - 1] },
    ttft: ttfts.length ? { p50: ttfts.sort((a, b) => a - b)[Math.floor(ttfts.length / 2)], max: Math.max(...ttfts), n: ttfts.length } : null,
    rows,
  }, null, 2))
  console.log(`\nJSON -> ${JSON_OUT}`)
}
