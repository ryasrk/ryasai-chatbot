/**
 * Repeats a family's questions N times to separate a real defect from sampling noise.
 *
 * A single pass cannot distinguish "the pipeline is broken" from "the model sampled a
 * different SQL this time". One 800-question run showed SQL_SALES at 81% while a manual
 * re-run of the SAME failures answered 5 of 6 correctly, which is the signature of
 * variance rather than a bug. This measures how much of the gap is variance.
 *
 * Usage: bun trial/cross/repeat.ts --family SQL_SALES --trials 3 --sample 40 [--json out]
 */
import { writeFileSync } from 'node:fs'
import { casesForFamily, judgeAnswer, type Family, type CrossCase } from './questions'

const args = process.argv.slice(2)
const get = (k: string, d: string) => (args.includes(k) ? (args[args.indexOf(k) + 1] ?? d) : d)
const family = get('--family', 'SQL_SALES') as Family
const trials = Number(get('--trials', '3'))
const sample = Number(get('--sample', '40'))
const jsonOut = get('--json', `/tmp/repeat-${family}.json`)
const PACE_MS = Number(process.env.CROSS_PACE_MS ?? '300')
const BASE = process.env.CROSS_BASE ?? 'http://localhost:3000'

function jsonParse(t: string): unknown {
  return JSON.parse(t)
}
async function mintToken(): Promise<string> {
  const proc = Bun.spawn(['bun', 'trial/live/session.ts'], { stdout: 'pipe', stderr: 'ignore' })
  return (jsonParse(await new Response(proc.stdout).text()) as { token: string }).token
}
async function ask(token: string, question: string): Promise<string> {
  const r0 = await fetch(`${BASE}/api/chat/sessions`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  const sid = (jsonParse(await r0.text()) as { id: string }).id
  const res = await fetch(`${BASE}/api/chat/sessions/${sid}/send`, {
    method: 'POST',
    headers: { Cookie: `x-active-user=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: question }),
  })
  const txt = await res.text()
  let ans = ''
  for (const l of txt.split('\n')) {
    const s = l.trim()
    if (!s.startsWith('data: ')) continue
    try {
      const d = JSON.parse(s.slice(6)) as { content?: unknown; messageId?: unknown }
      if (typeof d.content === 'string' && 'messageId' in d) ans = d.content
    } catch {
      /* not a JSON frame */
    }
  }
  return ans
}

// The failures from the single pass, so the sample is the questions most likely to be
// genuinely broken -- sampling them is the strongest test of the variance hypothesis.
const all = casesForFamily(family)
const fromFile = get('--ids', '')
let cases: CrossCase[]
if (fromFile) {
  const ids = new Set(fromFile.split(','))
  cases = all.filter((c) => ids.has(c.id))
} else {
  const failed = JSON.parse(
    (await Bun.file(`trial/cross/results-${family}.json`).text()) as string,
  ) as { results: Array<{ id: string; ok: boolean }> }
  const failedIds = new Set(failed.results.filter((r) => !r.ok).map((r) => r.id))
  cases = all.filter((c) => failedIds.has(c.id)).slice(0, sample)
}

const token = await mintToken()
const rows: Array<{ id: string; verdicts: string[]; answers: string[] }> = []
for (const c of cases) {
  const verdicts: string[] = []
  const answers: string[] = []
  for (let t = 0; t < trials; t++) {
    const a = await ask(token, c.question)
    const v = !a.trim() ? 'ERR' : judgeAnswer(c, a).ok ? 'B' : 'S'
    verdicts.push(v)
    answers.push(a.replace(/\s+/g, ' ').slice(0, 120))
    await Bun.sleep(PACE_MS)
  }
  rows.push({ id: c.id, verdicts, answers })
  console.log(`${c.id} harap=${c.accept.join('/')} -> ${verdicts.join(' ')}`)
}

// Flaky = passes at least once AND fails at least once. A real defect fails every time.
const flaky = rows.filter((r) => r.verdicts.includes('B') && r.verdicts.includes('S'))
const alwaysWrong = rows.filter((r) => r.verdicts.every((v) => v === 'S'))
const alwaysRight = rows.filter((r) => r.verdicts.every((v) => v === 'B'))
const totalRuns = rows.length * trials
const totalPass = rows.reduce((s, r) => s + r.verdicts.filter((v) => v === 'B').length, 0)

const out = {
  family,
  trials,
  sampled: rows.length,
  accuracyPerRun: Number(((totalPass / totalRuns) * 100).toFixed(2)),
  flaky: flaky.map((r) => r.id),
  alwaysWrong: alwaysWrong.map((r) => ({ id: r.id, sample: r.answers[0] })),
  alwaysRight: alwaysRight.map((r) => r.id),
  rows,
}
writeFileSync(jsonOut, JSON.stringify(out, null, 2))
console.log(`\nfamily=${family} sampel=${rows.length} trial=${trials}`)
console.log(`akurasi lintas-trial : ${out.accuracyPerRun}%  (${totalPass}/${totalRuns})`)
console.log(`selalu benar         : ${alwaysRight.length}`)
console.log(`TIDAK STABIL (flaky) : ${flaky.length}  ${flaky.map((r) => r.id).join(' ')}`)
console.log(`selalu salah (bug)   : ${alwaysWrong.length}  ${alwaysWrong.map((r) => r.id).join(' ')}`)
console.log(`hasil: ${jsonOut}`)
process.exit(0)
