/**
 * Re-scores saved answers with the current judge.
 *
 * Kept separate from run.ts because the answers are the expensive part: a judge fix
 * must not require re-asking 800 questions. Reads the four per-family result files and
 * rewrites each answer's verdict in place, so the reported accuracy always reflects the
 * judge actually committed.
 *
 * Usage: bun trial/cross/rescore.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { FAMILIES, ALL_CASES, judgeAnswer, type Family } from './questions'

const byId = new Map(ALL_CASES.map((c) => [c.id, c]))
let changed = 0

for (const f of FAMILIES) {
  const path = `trial/cross/results-${f}.json`
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
    summary: Record<string, unknown>
    results: Array<{ id: string; ok: boolean; reason: string; answer: string }>
  }
  for (const r of parsed.results) {
    const c = byId.get(r.id)
    if (!c) continue
    // An empty answer is a transport failure, not a wrong answer; keep it marked as such
    // so a throttled run can never be scored as an accuracy figure.
    if (!r.answer || !r.answer.trim()) {
      if (r.ok) changed++
      r.ok = false
      continue
    }
    const v = judgeAnswer(c, r.answer)
    if (v.ok !== r.ok) changed++
    r.ok = v.ok
    r.reason = v.reason
  }
  const passed = parsed.results.filter((r) => r.ok).length
  parsed.summary.passed = passed
  parsed.summary.accuracy = Number(((passed / parsed.results.length) * 100).toFixed(2))
  parsed.summary.failures = parsed.results.filter((r) => !r.ok).slice(0, 40)
  writeFileSync(path, JSON.stringify(parsed, null, 2))
  console.log(`[${f}] ${passed}/${parsed.results.length} = ${parsed.summary.accuracy}%`)
}
console.log(`verdict berubah: ${changed}`)
process.exit(0)
