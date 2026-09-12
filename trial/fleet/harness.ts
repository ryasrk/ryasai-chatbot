/**
 * Fleet trial harness — menjalankan setiap kasus lewat KODE PRODUKSI dan
 * memeriksa hasilnya secara mesin. Tidak ada penilaian rasa.
 *
 * Output: akurasi per divisi, per tim, plus daftar kegagalan dengan alasan.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { wrapUntrusted } from '../../src/lib/evidence-boundary'
import { CASES, casesByDivision, type TrialCase } from './dataset'
import { validateAndSanitizeLlmSql } from '../../src/lib/guardrails'
// NOTE: two tokenize implementations exist (rag.ts and smart-router-helpers.ts).
// The trial exercises BOTH — if they disagree on any input, that is a finding.
import { tokenize as tokenizeRag } from '../../src/lib/rag'
import { tokenize as tokenizeRouter } from '../../src/lib/smart-router-helpers'

export interface CaseResult {
  id: string
  division: string
  team: string
  kind: string
  input: string
  pass: boolean
  reason: string
  ms: number
}

const log: string[] = []
const emit = (m: string) => { log.push(m) }

function runGuardrail(c: TrialCase): { pass: boolean; reason: string } {
  let res: { ok: boolean; reason?: string }
  try {
    res = validateAndSanitizeLlmSql(c.input) as { ok: boolean; reason?: string }
  } catch (e) {
    // A throw is a rejection too, but record it — a crash is not a clean block.
    return { pass: c.kind === 'guard-block', reason: `threw: ${String(e).slice(0, 60)}` }
  }
  if (c.kind === 'guard-block') {
    // Hard requirement: malicious SQL must NOT pass.
    return res.ok
      ? { pass: false, reason: 'MALICIOUS SQL ALLOWED' }
      : { pass: true, reason: `blocked (${res.reason?.slice(0, 40) ?? 'no reason'})` }
  }
  // guard-allow: over-blocking is a functional bug; a legitimate query must pass.
  return res.ok
    ? { pass: true, reason: 'allowed' }
    : { pass: false, reason: `FALSE POSITIVE: ${res.reason?.slice(0, 50) ?? ''}` }
}

function runRetrievalInvariant(c: TrialCase): { pass: boolean; reason: string } {
  // Tokenizing must never throw and must always return an array of strings,
  // for every input shape including empty, 5k chars, emoji, and null bytes.
  try {
    for (const [name, fn] of [['rag', tokenizeRag], ['router', tokenizeRouter]] as const) {
      const t = fn(c.input)
      if (!Array.isArray(t)) return { pass: false, reason: `${name}.tokenize did not return an array` }
      const bad = t.find((x) => typeof x !== 'string')
      if (bad !== undefined) return { pass: false, reason: `${name}: non-string token (${typeof bad})` }
      // An empty token poisons BM25 IDF math (log(0) → -Infinity).
      if (t.some((x) => x.length === 0)) return { pass: false, reason: `${name}: empty token produced` }
    }
    // Divergence between the two implementations is a defect even if each is
    // individually well-formed: routing and retrieval would score differently.
    const a = tokenizeRag(c.input).join('|')
    const b = tokenizeRouter(c.input).join('|')
    if (a !== b) return { pass: false, reason: `tokenize DIVERGENCE: rag=[${a.slice(0,30)}] router=[${b.slice(0,30)}]` }
    return { pass: true, reason: `ok (${tokenizeRag(c.input).length} tokens, both impls agree)` }
  } catch (e) {
    return { pass: false, reason: `threw: ${String(e).slice(0, 70)}` }
  }
}

function runPipelineInvariant(c: TrialCase): { pass: boolean; reason: string } {
  // Prompt-boundary helper must be total, and the fence must stay BALANCED:
  // content is legitimately rewritten (trimmed, embedded markers replaced), so
  // "input appears verbatim" is the wrong invariant. What matters is that a
  // payload can never close the block early and have its remainder read as
  // instructions.
  try {
    const wrapped = wrapUntrusted('TEST', c.input)
    if (typeof wrapped !== 'string') return { pass: false, reason: 'wrapUntrusted returned non-string' }

    if (c.input.trim() === '') {
      return wrapped === ''
        ? { pass: true, reason: 'ok (empty input -> empty output)' }
        : { pass: false, reason: 'empty input must yield empty output' }
    }

    const fenceCount = (wrapped.match(/<<<RYASAI-UNTRUSTED-DATA>>>/g) ?? []).length
    if (fenceCount !== 2) {
      return { pass: false, reason: `UNBALANCED FENCE: ${fenceCount} markers (need exactly 2)` }
    }
    if (!wrapped.startsWith('TEST\n')) {
      return { pass: false, reason: 'label missing from wrapped output' }
    }
    const inner = wrapped.split('<<<RYASAI-UNTRUSTED-DATA>>>')[1] ?? ''
    if (inner.includes('<<<RYASAI-UNTRUSTED-DATA>>>')) {
      return { pass: false, reason: 'FENCE ESCAPE: payload injected a closing marker' }
    }
    return { pass: true, reason: `ok (${wrapped.length} chars, fence balanced)` }
  } catch (e) {
    return { pass: false, reason: `threw: ${String(e).slice(0, 70)}` }
  }
}

export function runAll(): CaseResult[] {
  const out: CaseResult[] = []
  for (const c of CASES) {
    const t0 = Date.now()
    let r: { pass: boolean; reason: string }
    if (c.kind === 'guard-block' || c.kind === 'guard-allow') r = runGuardrail(c)
    else if (c.division === 'D1') r = runRetrievalInvariant(c)
    else r = runPipelineInvariant(c)
    out.push({ ...c, ...r, ms: Date.now() - t0 })
  }
  return out
}

export function report(results: CaseResult[]): string {
  const byDiv = new Map<string, { p: number; f: number }>()
  const byTeam = new Map<string, { p: number; f: number }>()
  const byKind = new Map<string, { p: number; f: number }>()
  for (const r of results) {
    const bump = (m: Map<string, { p: number; f: number }>, k: string) => {
      const e = m.get(k) ?? { p: 0, f: 0 }
      r.pass ? e.p++ : e.f++
      m.set(k, e)
    }
    bump(byDiv, r.division)
    bump(byTeam, `${r.division}/${r.team}`)
    bump(byKind, r.kind)
  }
  const total = results.length
  const passed = results.filter((r) => r.pass).length

  emit('')
  emit('='.repeat(78))
  emit(`TRIAL FLEET — ${total} KASUS pada KODE PRODUKSI`)
  emit('='.repeat(78))
  emit('')
  emit('PER DIVISI')
  for (const [k, v] of [...byDiv.entries()].sort()) {
    const n = v.p + v.f
    const bar = '#'.repeat(Math.round((v.p / n) * 30)).padEnd(30, '.')
    emit(`  ${k}  ${bar} ${v.p}/${n}  ${((v.p / n) * 100).toFixed(1)}%`)
  }
  emit('')
  emit('PER JENIS')
  for (const [k, v] of [...byKind.entries()].sort()) {
    const n = v.p + v.f
    emit(`  ${k.padEnd(14)} ${v.p}/${n}  ${((v.p / n) * 100).toFixed(1)}%`)
  }
  emit('')
  const fails = results.filter((r) => !r.pass)
  emit(`KEGAGALAN: ${fails.length}/${total}`)
  const shown = fails.slice(0, 40)
  for (const f of shown) {
    emit(`  [${f.id}] ${f.kind} — ${f.reason}`)
    emit(`       input: ${JSON.stringify(f.input.slice(0, 70))}`)
  }
  if (fails.length > shown.length) emit(`  ... dan ${fails.length - shown.length} lagi`)
  emit('')
  emit('='.repeat(78))
  emit(`AKURASI TOTAL: ${passed}/${total} = ${((passed / total) * 100).toFixed(2)}%`)
  emit('='.repeat(78))
  return log.join('\n')
}

if (import.meta.main) {
  const results = runAll()
  const text = report(results)
  console.log(text)
  appendFileSync('/tmp/fleet.txt', text + '\n')
  writeFileSync('trial/fleet/results.json', JSON.stringify(results, null, 2))
}

  process.exit(0)
