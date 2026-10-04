/**
 * Generate the live RAG eval set (300 questions) from the committed corpus, with MECHANICALLY verified ground truth.
 *
 * Every answerable question carries the verbatim quote(s) that answer it; a question whose quote is not found in the
 * named source (after whitespace/markdown normalisation) is DROPPED, not repaired. Unanswerable questions are checked
 * the other way round: the verifier model reads the WHOLE corpus and any question it can answer is dropped.
 *
 * Three different model families: the question author here, the verifier/judge, and the generator under test.
 *
 *   bun benchmark/eval-live/generate-questions.ts [--book <path-to-distractor.txt>]
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { complete, mapLimit, parseJson } from './llm'

const AUTHOR = process.env.EVAL_QUESTION_MODEL ?? 'cx/gpt-5.6-sol'
const VERIFIER = process.env.EVAL_JUDGE_MODEL ?? 'cbai/glm-5.2'
const DIR = join(import.meta.dir, 'corpus')
const OUT = join(import.meta.dir, 'rag-questions.json')

export type Category = 'factual' | 'cross-language' | 'multi-hop' | 'unanswerable' | 'colloquial' | 'distractor-book'

export interface EvalQuestion {
  id: string
  category: Category
  lang: 'id' | 'en'
  question: string
  /** Short reference answer; empty for unanswerable. */
  expectedAnswer: string
  /** Verbatim evidence: every quote was found in its source file. Empty for unanswerable. */
  evidence: Array<{ source: string; quote: string }>
}

/** Lowercase, strip markdown emphasis/table pipes, collapse whitespace — so a quote matches the rendered text. */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\$\\ge\$/g, '≥')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

const docs = readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => ({ name: f, text: readFileSync(join(DIR, f), 'utf8') }))
const byName = new Map(docs.map((d) => [d.name, d]))
const langOf = (name: string): 'id' | 'en' => (/^(fin-03|fin-04|ops-03|ops-06|it-03|it-04|sales-02|risk-02|esg-01)/.test(name) ? 'en' : 'id')

const bookPath = process.argv.includes('--book') ? process.argv[process.argv.indexOf('--book') + 1] : null
const book = bookPath ? readFileSync(bookPath, 'utf8') : null

function verified(q: Omit<EvalQuestion, 'id'>, sources: Map<string, string>): boolean {
  if (q.category === 'unanswerable') return true
  if (!q.question?.trim() || !q.expectedAnswer?.trim() || !Array.isArray(q.evidence) || q.evidence.length === 0) return false
  return q.evidence.every((e) => {
    const src = sources.get(e.source)
    const quote = normalise(e.quote ?? '')
    return Boolean(src) && quote.length >= 12 && normalise(src!).includes(quote)
  })
}

const RULES = `Rules:
- Each question must be answerable ONLY from the given text, unambiguous within a company knowledge base, and must not
  quote the answer in the question. Mention enough context (e.g. the policy or table) that a reader knows what is asked.
- "quote" must be copied EXACTLY, character for character, from the text (12-220 characters); it must contain the answer.
- "answer" is short (a number with unit, a name, a duration, a short phrase).
Return JSON: {"questions":[{"question":"...","answer":"...","evidence":[{"source":"<file>","quote":"..."}]}]}`

async function ask(prompt: string): Promise<Array<{ question: string; answer: string; evidence: Array<{ source: string; quote: string }> }>> {
  try {
    const raw = await complete(AUTHOR, [{ role: 'user', content: prompt }], { maxTokens: 6000, temperature: 0.3 })
    return parseJson<{ questions: Array<{ question: string; answer: string; evidence: Array<{ source: string; quote: string }> }> }>(raw).questions ?? []
  } catch (e) {
    console.log(`  author error: ${String(e).slice(0, 120)}`)
    return []
  }
}

/** Ask, verify, and keep up to `want` verified questions (re-asking once if too few survive). */
async function harvest(
  category: Category,
  lang: 'id' | 'en',
  want: number,
  prompt: string,
  sources: Map<string, string>,
): Promise<Array<Omit<EvalQuestion, 'id'>>> {
  const kept: Array<Omit<EvalQuestion, 'id'>> = []
  for (let round = 0; round < 3 && kept.length < want; round++) {
    const got = await ask(prompt + (round > 0 ? `\nWrite ${want + 2} NEW questions, different from earlier ones.` : ''))
    for (const g of got) {
      const q = { category, lang, question: g.question, expectedAnswer: g.answer, evidence: g.evidence ?? [] }
      if (kept.length < want && verified(q, sources) && !kept.some((k) => k.question === q.question)) kept.push(q)
    }
  }
  return kept
}

// `--only a,b --append` tops up selected categories and merges them into the existing file.
const only = process.argv.includes('--only') ? new Set(process.argv[process.argv.indexOf('--only') + 1].split(',')) : null
const want = (c: Category) => !only || only.has(c)
const appendMode = process.argv.includes('--append')
const all: Array<Omit<EvalQuestion, 'id'>> = appendMode
  ? (JSON.parse(readFileSync(OUT, 'utf8')) as { questions: EvalQuestion[] }).questions.map(({ id: _id, ...q }) => q)
  : []
const target = (c: Category, n: number) => Math.max(0, n - all.filter((q) => q.category === c).length)
const one = (d: { name: string; text: string }) => new Map([[d.name, d.text]])

// 1. Factual — 6 per document: at least two from a TABLE and two that are numeric.
if (want('factual') && !appendMode) {
console.log('factual…')
for (const batch of await mapLimit(docs, 6, (d) =>
  harvest('factual', langOf(d.name), 6, `Source file: ${d.name}\n---\n${d.text}\n---\nWrite 8 questions in ${langOf(d.name) === 'id' ? 'Indonesian' : 'English'} about this document. At least 3 must be answered by a TABLE row and at least 3 must have a numeric answer.\n${RULES}`, one(d)),
)) all.push(...batch)
}

// 2. Cross-language — the question in the OTHER language from the document.
if (want('cross-language') && !appendMode) {
console.log('cross-language…')
for (const batch of await mapLimit(docs, 6, (d) => {
  const other = langOf(d.name) === 'id' ? 'English' : 'Indonesian'
  return harvest('cross-language', other === 'English' ? 'en' : 'id', 1, `Source file: ${d.name}\n---\n${d.text}\n---\nWrite 3 questions in ${other} (the document is in the other language). The quote stays in the document's language.\n${RULES}`, one(d))
})) all.push(...batch)
}

// 3. Multi-hop — needs facts from TWO documents (one quote from each).
if (want('multi-hop')) {
console.log('multi-hop…')
const pairs: Array<[string, string]> = [
  ['hr-02-kompensasi-tunjangan.md', 'fin-01-reimbursement.md'], ['hr-01-kebijakan-cuti.md', 'hr-04-kinerja-pelatihan.md'],
  ['fin-02-pengadaan.md', 'fin-04-anggaran.md'], ['ops-01-penerimaan-barang.md', 'ops-02-pengiriman-outbound.md'],
  ['ops-03-sla-layanan.md', 'risk-02-asuransi-klaim.md'], ['ops-04-armada.md', 'esg-01-keberlanjutan.md'],
  ['ops-05-k3-gudang.md', 'ops-06-barang-berbahaya.md'], ['it-01-keamanan-informasi.md', 'it-03-akses-sistem.md'],
  ['it-02-penanganan-insiden.md', 'it-04-pemulihan-bencana.md'], ['sales-01-tarif.md', 'fin-03-penagihan-piutang.md'],
  ['sales-02-onboarding-pelanggan.md', 'fin-03-penagihan-piutang.md'], ['risk-01-manajemen-risiko.md', 'risk-02-asuransi-klaim.md'],
]
const perPair = Math.ceil(target('multi-hop', 36) / pairs.length)
for (const batch of await mapLimit(pairs, 6, ([a, b]) => {
  const da = byName.get(a)!, db = byName.get(b)!
  return harvest('multi-hop', 'id', perPair, `File A: ${a}\n---\n${da.text}\n---\nFile B: ${b}\n---\n${db.text}\n---\nWrite 5 questions (Indonesian or English) whose answer needs ONE fact from file A AND ONE fact from file B (e.g. compare, combine, or compute). Give exactly two evidence quotes, one per file, with the right "source".\n${RULES}`, new Map([[a, da.text], [b, db.text]]))
})) all.push(...batch.map((q) => ({ ...q, lang: /[a-z]/i.test(q.question) && /\b(the|what|how|which|is|are)\b/i.test(q.question) ? 'en' as const : 'id' as const })))
}

// 4. Colloquial — informal Indonesian (chat style, abbreviations), still precise.
if (want('colloquial') && !appendMode) {
console.log('colloquial…')
for (const batch of await mapLimit(docs, 6, (d) =>
  harvest('colloquial', 'id', 1, `Source file: ${d.name}\n---\n${d.text}\n---\nWrite 3 questions in very informal Indonesian chat style (e.g. "min, klo ... brp ya?", abbreviations, no capitals), as an employee would type in a chat app.\n${RULES}`, one(d)),
)) all.push(...batch)
}

// 5. Book distractor — evidence lives in a long unrelated document, so retrieval works at scale.
if (book && want('distractor-book') && !appendMode) {
  console.log('distractor book…')
  const windows = Array.from({ length: 24 }, (_, i) => {
    const start = Math.floor(((i + 0.5) / 24) * (book.length - 4000))
    return book.slice(start, start + 4000)
  })
  const sources = new Map([['distractor-book', book]])
  for (const batch of await mapLimit(windows, 6, (w) =>
    harvest('distractor-book', 'en', 1, `Source file: distractor-book\n---\n${w}\n---\nWrite 3 English questions about specific facts in this excerpt of a long book. Use "distractor-book" as the source.\n${RULES}`, sources),
  )) all.push(...batch)
}

// 6. Unanswerable — plausible for this company, NOT answered anywhere; verified against the whole corpus.
if (want('unanswerable')) {
console.log('unanswerable…')
const need = target('unanswerable', 48)
const titles = docs.map((d) => `${d.name}: ${d.text.split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '') ?? ''}`).join('\n')
const candidates: Array<{ question: string; lang: 'id' | 'en' }> = []
for (let round = 0; round < 4 && candidates.length < need * 3; round++) {
  const raw = await complete(AUTHOR, [{ role: 'user', content: `A company knowledge base contains these documents:\n${titles}\n\nWrite 40 questions (half Indonesian, half English) an employee might plausibly ask that look like they belong to this knowledge base but whose answer is NOT in any of these documents (e.g. a benefit, a location, a threshold, a system or a procedure that the documents do not cover). Return JSON {"questions":[{"question":"...","lang":"id|en"}]}` }], { maxTokens: 5000, temperature: 0.7 }).catch(() => '')
  try { candidates.push(...(parseJson<{ questions: Array<{ question: string; lang: 'id' | 'en' }> }>(raw).questions ?? [])) } catch { /* next round */ }
}
const corpusText = docs.map((d) => `=== ${d.name} ===\n${d.text}`).join('\n\n')
const unanswerable: Array<Omit<EvalQuestion, 'id'>> = []
await mapLimit(candidates, 4, async (c) => {
  if (unanswerable.length >= need) return
  const raw = await complete(VERIFIER, [{ role: 'user', content: `${corpusText}\n\n---\nQuestion: ${c.question}\nCan this question be answered (fully or partially) from the documents above? Reply JSON {"answerable": true|false, "quote": "<exact supporting text if answerable, else empty>"}` }], { maxTokens: 800 }).catch(() => '')
  try {
    const v = parseJson<{ answerable: boolean }>(raw)
    if (v.answerable === false && unanswerable.length < need && !all.some((q) => q.question === c.question)) {
      unanswerable.push({ category: 'unanswerable', lang: c.lang === 'en' ? 'en' : 'id', question: c.question, expectedAnswer: '', evidence: [] })
    }
  } catch { /* unverifiable — dropped */ }
})
all.push(...unanswerable)
}

const questions: EvalQuestion[] = all.map((q, i) => ({ id: `q${String(i + 1).padStart(3, '0')}`, ...q }))
const counts = questions.reduce<Record<string, number>>((m, q) => ({ ...m, [q.category]: (m[q.category] ?? 0) + 1 }), {})
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), author: AUTHOR, verifier: VERIFIER, counts, questions }, null, 2) + '\n')
console.log(`wrote ${questions.length} questions`, counts)
