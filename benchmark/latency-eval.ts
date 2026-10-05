/**
 * Latency + correctness harness for the chat pipeline.
 * ----------------------------------------------------------------------------
 * A latency change is only acceptable if the answers stay right, so every run records BOTH:
 * how long the user waited (time to first token, LLM calls before it) and whether the answer
 * still contains the fact the document states.
 *
 * It drives `runStreamingChatCompletion` — the same entry the chat route uses — rather than a
 * sub-function, so the number covers intent, routing, retrieval, rerank and reflection together.
 * The expected facts are literal strings from the seeded policy documents, matched
 * case-insensitively; a question may list alternatives (`any`) when the document allows more
 * than one correct phrasing.
 *
 * Usage:
 *   EVAL_ORG_ID=<org> EVAL_USER_ID=<user> bun run benchmark/latency-eval.ts [--label base] [--limit N] [--out file.json]
 *
 * Compare configurations by running it twice with different env (e.g. RAG_LLM_RERANK=false) and
 * the same `--label`-ed output files; `--compare a.json b.json` prints the delta table.
 *
 * LIMITS, STATED: one pass per question per run, so a single outlier moves a mean — read the
 * median and p95, not the mean. The RAG result cache is keyed on the query, so a SECOND pass over
 * the same questions in one process would measure the cache, not the pipeline; run each
 * configuration in a fresh process.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { runStreamingChatCompletion } from '@/lib/tool-router'
import { enterTurnTiming, summarizeTurn, type TurnTimings } from '@/lib/turn-timing'

interface EvalQuestion {
  id: string
  question: string
  /** The answer is correct if it contains ANY of these (case-insensitive). */
  any: string[]
  /** Optional: it must ALSO contain every one of these. */
  all?: string[]
  /** Optional: it must ALSO contain at least one of these (e.g. an "I could not find it" phrasing). */
  also?: string[]
}

const NOT_FOUND = [
  'tidak ditemukan', 'tidak menemukan', 'tidak ada', 'tidak tersedia', 'tidak tercantum', 'tidak disebutkan',
  'tidak dapat', 'tidak bisa', 'belum', 'tidak memuat', 'tidak mencantumkan',
]

export const QUESTIONS: EvalQuestion[] = [
  { id: 'cuti-tahunan', question: 'Berapa hari cuti tahunan karyawan tetap?', any: ['12 hari'] },
  { id: 'cuti-proporsional', question: 'Bagaimana cuti untuk karyawan yang belum 12 bulan bekerja?', any: ['proporsional', '1 hari per bulan'] },
  { id: 'probation', question: 'Berapa lama masa percobaan karyawan baru?', any: ['3 bulan', 'tiga bulan'] },
  { id: 'laptop', question: 'Berapa RAM minimal laptop karyawan?', any: ['16 gb'] },
  { id: 'refund-waktu', question: 'Berapa hari kerja proses pengembalian dana setelah disetujui?', any: ['7 hari'] },
  { id: 'refund-biaya', question: 'Berapa biaya administrasi refund?', any: ['2 persen', '2%', '25.000'] },
  { id: 'klasifikasi', question: 'Ada berapa tingkat klasifikasi data?', any: ['empat', '4'] },
  { id: 'pengadaan-tender', question: 'Pengadaan di atas Rp 100 juta harus bagaimana?', any: ['tender terbuka'] },
  { id: 'pengadaan-3-penawaran', question: 'Pengadaan Rp 50 juta butuh berapa penawaran?', any: ['3 penawaran', 'tiga penawaran', 'minimal 3'] },
  { id: 'risiko-tinggi', question: 'Risiko tinggi harus dilaporkan ke siapa dan dalam berapa hari?', any: ['komite risiko'], all: ['2 hari'] },
  { id: 'gangguan-p1', question: 'Berapa target waktu penanganan gangguan P1?', any: ['15 menit'] },
  { id: 'dinas-luarnegeri', question: 'Siapa yang menyetujui perjalanan dinas luar negeri?', any: ['direktur'] },
  { id: 'pelatihan-jam', question: 'Berapa jam pelatihan per tahun untuk karyawan dengan masa kerja di atas 3 tahun?', any: ['60 jam'] },
  { id: 'pelatihan-anggaran', question: 'Berapa anggaran pelatihan per karyawan per tahun?', any: ['7.500.000'] },
  { id: 'sapaan', question: 'Halo, apa kabar?', any: [''] },
  // Questions the corpus CANNOT fully answer. A pipeline that gets faster by trusting weak evidence shows up HERE:
  // it would invent a figure instead of saying it found none. Correct = the answer admits the gap.
  // GENUINE DATABASE QUESTIONS — the fallback must never take these away from the database. Added because every
  // earlier question here was a document question, so a change that over-triggered the documents fallback could
  // not have been seen failing. `any` holds the literal value the HR database returns for each.
  { id: 'db-jumlah-it', question: 'Berapa jumlah karyawan di departemen IT?', any: ['3'] },
  { id: 'db-total-cuti', question: 'Berapa total hari cuti yang sudah diajukan?', any: ['130'] },
  { id: 'tidak-ada', question: 'Berapa gaji pokok direktur utama?', any: NOT_FOUND },
  // The compound case the multi-tool path exists for: one part answerable ONLY from a policy document, one part
  // ONLY from the HR database. A single-source answer is necessarily half an answer.
  { id: 'majemuk-dok-db', question: 'Berapa hari cuti tahunan karyawan tetap menurut kebijakan, dan berapa total hari cuti yang sudah diajukan?', any: ['12 hari'], all: ['130'] },
  { id: 'majemuk-separuh', question: 'Berapa hari cuti tahunan karyawan tetap dan berapa gaji pokok direktur utama?', any: ['12 hari'], also: NOT_FOUND },
  { id: 'tidak-ada-2', question: 'Apa nama vendor resmi untuk pengadaan laptop?', any: NOT_FOUND },
]

interface Row {
  id: string
  firstTokenMs: number
  totalMs: number
  preTokenLlmCalls: number
  preTokenLlmMs: number
  correct: boolean
  answerPreview: string
  error?: string
  byPurpose: TurnTimings['byPurpose']
}

export function isCorrect(answer: string, q: Pick<EvalQuestion, 'any' | 'all' | 'also'>): boolean {
  const a = answer.toLowerCase()
  const anyOk = q.any.some((s) => a.includes(s.toLowerCase()))
  const allOk = (q.all ?? []).every((s) => a.includes(s.toLowerCase()))
  const alsoOk = !q.also || q.also.some((x) => a.includes(x.toLowerCase()))
  return anyOk && allOk && alsoOk
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((x, y) => x - y)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]
}

async function runOne(q: EvalQuestion, userId: string): Promise<Row> {
  const started = Date.now()
  enterTurnTiming(started)
  let answer = ''
  let firstTokenAt: number | null = null
  try {
    const res = await runStreamingChatCompletion({
      question: q.question, userId, sessionId: `latency-eval-${q.id}-${started}`, chatHistory: [], allowMultiStepDag: true,
    })
    for await (const token of res.stream) {
      if (firstTokenAt === null && token.length > 0) firstTokenAt = Date.now()
      answer += token
    }
    const t = summarizeTurn(firstTokenAt)!
    return {
      id: q.id, firstTokenMs: t.firstTokenMs, totalMs: t.totalMs, preTokenLlmCalls: t.preTokenLlmCalls,
      preTokenLlmMs: t.preTokenLlmMs, byPurpose: t.byPurpose,
      correct: isCorrect(answer, q), answerPreview: answer.replace(/\s+/g, ' ').slice(0, 160),
    }
  } catch (e) {
    const t = summarizeTurn(firstTokenAt)
    return {
      id: q.id, firstTokenMs: t?.firstTokenMs ?? Date.now() - started, totalMs: Date.now() - started,
      preTokenLlmCalls: t?.preTokenLlmCalls ?? 0, preTokenLlmMs: t?.preTokenLlmMs ?? 0, byPurpose: t?.byPurpose ?? {},
      correct: false, answerPreview: '', error: e instanceof Error ? e.message : String(e),
    }
  }
}

function summarise(rows: Row[]) {
  const ft = rows.map((r) => r.firstTokenMs)
  const tot = rows.map((r) => r.totalMs)
  const calls = rows.map((r) => r.preTokenLlmCalls)
  return {
    n: rows.length,
    correct: rows.filter((r) => r.correct).length,
    firstTokenMedian: percentile(ft, 50), firstTokenP95: percentile(ft, 95),
    totalMedian: percentile(tot, 50), totalP95: percentile(tot, 95),
    preTokenCallsMedian: percentile(calls, 50), preTokenCallsMax: Math.max(0, ...calls),
  }
}

/** Correct-count per question id, so a repeated run is judged on its RATE, not on whichever sample came first. */
export function correctByQuestion(rows: Pick<Row, 'id' | 'correct'>[]): Map<string, { ok: number; n: number }> {
  const m = new Map<string, { ok: number; n: number }>()
  for (const r of rows) {
    const slot = m.get(r.id) ?? { ok: 0, n: 0 }
    slot.n += 1
    if (r.correct) slot.ok += 1
    m.set(r.id, slot)
  }
  return m
}

/**
 * Questions whose correct RATE fell from one run to the other. Compared as a rate (ok/n) so runs with a different
 * number of repetitions stay comparable; a question that was always right before and is now wrong at all is flagged.
 */
export function regressions(a: Pick<Row, 'id' | 'correct'>[], b: Pick<Row, 'id' | 'correct'>[]): string[] {
  const ra = correctByQuestion(a)
  const rb = correctByQuestion(b)
  const out: string[] = []
  for (const [id, x] of ra) {
    const y = rb.get(id)
    if (!y) continue
    if (y.ok / y.n < x.ok / x.n - 1e-9) out.push(`${id} (${x.ok}/${x.n} -> ${y.ok}/${y.n})`)
  }
  return out
}

function compare(aPath: string, bPath: string) {
  const a = JSON.parse(readFileSync(aPath, 'utf8')) as { label: string; rows: Row[] }
  const b = JSON.parse(readFileSync(bPath, 'utf8')) as { label: string; rows: Row[] }
  const sa = summarise(a.rows); const sb = summarise(b.rows)
  const line = (k: string, x: number, y: number) => `${k.padEnd(24)} ${String(x).padStart(9)} ${String(y).padStart(9)}  ${y - x >= 0 ? '+' : ''}${y - x}`
  console.log(`${''.padEnd(24)} ${a.label.padStart(9)} ${b.label.padStart(9)}  delta`)
  console.log(line('samples', sa.n, sb.n))
  console.log(line('correct', sa.correct, sb.correct))
  console.log(line('first token median ms', sa.firstTokenMedian, sb.firstTokenMedian))
  console.log(line('first token p95 ms', sa.firstTokenP95, sb.firstTokenP95))
  console.log(line('total median ms', sa.totalMedian, sb.totalMedian))
  console.log(line('pre-token calls median', sa.preTokenCallsMedian, sb.preTokenCallsMedian))
  const regressed = regressions(a.rows, b.rows)
  console.log(regressed.length ? `\nREGRESSED (correct rate fell): ${regressed.join(', ')}` : '\nno question regressed')
  if (regressed.length) process.exitCode = 1
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined }
  const cmp = argv.indexOf('--compare')
  if (cmp >= 0) return compare(argv[cmp + 1], argv[cmp + 2])

  const orgId = process.env.EVAL_ORG_ID
  const userId = process.env.EVAL_USER_ID
  if (!orgId || !userId) throw new Error('EVAL_ORG_ID and EVAL_USER_ID are required')
  enterWithOrg(orgId)
  const label = flag('--label') ?? 'run'
  // `--questions file.json` replaces the built-in set (which matches the seeded demo corpus) with one for another
  // corpus, e.g. benchmark/eval-live/latency-questions.json for the live-eval organisation.
  const questionsFile = flag('--questions')
  const pool: EvalQuestion[] = questionsFile ? (JSON.parse(readFileSync(questionsFile, 'utf8')) as { questions: EvalQuestion[] }).questions : QUESTIONS
  const limit = Number(flag('--limit') ?? pool.length)
  // `--only a,b` runs just those ids; `--repeat N` runs each N times. Both exist so a single odd result (a routing flip
  // on a temperature-0 call is still one sample) can be told apart from a real regression by repetition.
  const only = flag('--only')?.split(',')
  const repeat = Math.max(1, Number(flag('--repeat') ?? 1))
  const selected = (only ? pool.filter((q) => only.includes(q.id)) : pool.slice(0, limit))
  const plan = selected.flatMap((q) => Array.from({ length: repeat }, () => q))

  const rows: Row[] = []
  for (const q of plan) {
    const r = await runOne(q, userId)
    rows.push(r)
    const tag = r.error ? 'ERR' : r.correct ? 'ok ' : 'BAD'
    console.log(`${tag} ${q.id.padEnd(22)} first-token ${String(r.firstTokenMs).padStart(6)}ms  total ${String(r.totalMs).padStart(6)}ms  pre-token LLM calls ${r.preTokenLlmCalls}${r.error ? '  ' + r.error.slice(0, 80) : ''}`)
  }
  const s = summarise(rows)
  console.log(`\n[${label}] correct ${s.correct}/${s.n} · first token median ${s.firstTokenMedian}ms p95 ${s.firstTokenP95}ms · total median ${s.totalMedian}ms · pre-token LLM calls median ${s.preTokenCallsMedian} max ${s.preTokenCallsMax}`)
  const out = flag('--out')
  if (out) writeFileSync(out, JSON.stringify({ label, rows, summary: s }, null, 2))
}

if (import.meta.main) {
  main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1) })
}
