/**
 * Build the agentic question set from the two verified sets, deterministically.
 *
 * Every part of a compound question is an existing question with a known answer: a document question carries its
 * verbatim evidence (rag-questions.json), a database question its reference rows (sql-questions.json). So a compound
 * answer can be judged PER PART against the same references the single-source evals use, and nothing here is written
 * by a model.
 *
 * Sets:
 *   doc_db      a document fact + a database fact (the defect class that dropped the second half)
 *   db_db       facts from two different databases
 *   doc_doc     facts from two different documents
 *   three_part  two documents + one database
 *   single_doc / single_db   one part only: the control for cost (a single question must not pay for a plan)
 *   scope       a Chinook fact + an ERP fact, asked with a key that may read Chinook only
 *
 *   bun benchmark/eval-live/build-agentic-questions.ts   → benchmark/eval-live/agentic-questions.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DB_NAME, withDatabase } from './db-names'

interface RagQuestion { id: string; category: string; lang: string; question: string; expectedAnswer: string; evidence: Array<{ source: string; quote: string }> }
interface SqlCase { id: string; dataset: 'chinook' | 'erp'; question: string; goldRows: unknown[][]; goldRowCount: number }

export interface AgenticPart {
  kind: 'doc' | 'db'
  sourceId: string
  /** Document file name, or the integration name. */
  source: string
  question: string
  expectedAnswer: string
  evidence?: string
  /** For the scope set: this part must NOT be answered, because the key may not read its source. */
  outOfScope?: boolean
}
export interface AgenticQuestion { id: string; set: string; question: string; parts: AgenticPart[]; scopedTo?: 'chinook' }

const dir = import.meta.dir
const rag = (JSON.parse(readFileSync(join(dir, 'rag-questions.json'), 'utf8')) as { questions: RagQuestion[] }).questions
const sql = (JSON.parse(readFileSync(join(dir, 'sql-questions.json'), 'utf8')) as { cases: SqlCase[] }).cases


// A fixed LCG, so the set is identical on every machine and every rebuild.
let seed = 20261005
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const docs = shuffle(rag.filter((q) => q.category === 'factual'))
// Scalar answers only (one row, at most two columns), so a part is right or wrong without interpretation.
const scalar = sql.filter((c) => c.goldRowCount === 1 && c.goldRows[0].length <= 2)
const dbPool = { chinook: shuffle(scalar.filter((c) => c.dataset === 'chinook')), erp: shuffle(scalar.filter((c) => c.dataset === 'erp')) }

let docIdx = 0
/**
 * The next unused document question, optionally in one language. A compound question is asked in ONE language: the
 * database cases exist in English only, and a sentence that switches language half-way measures something no user
 * does (cross-language retrieval is the RAG eval's job).
 */
const nextDoc = (notFrom: Set<string> = new Set(), lang?: string): RagQuestion => {
  for (let k = 0; k < docs.length; k++) {
    const q = docs[(docIdx + k) % docs.length]
    if (!notFrom.has(q.evidence[0].source) && (!lang || q.lang === lang)) {
      docIdx = (docIdx + k + 1) % docs.length
      return q
    }
  }
  throw new Error('no document question left')
}
const dbIdx = { chinook: 0, erp: 0 }
const nextDb = (ds: 'chinook' | 'erp'): SqlCase => {
  const c = dbPool[ds][dbIdx[ds] % dbPool[ds].length]
  dbIdx[ds]++
  return c
}


const docPart = (q: RagQuestion): AgenticPart => ({
  kind: 'doc', sourceId: q.id, source: q.evidence[0].source, question: q.question,
  expectedAnswer: q.expectedAnswer, evidence: q.evidence.map((e) => e.quote).join(' … '),
})
const dbPart = (c: SqlCase, outOfScope = false): AgenticPart => ({
  kind: 'db', sourceId: c.id, source: DB_NAME[c.dataset], question: withDatabase(c.question, c.dataset),
  expectedAnswer: c.goldRows[0].map(String).join(', '), ...(outOfScope ? { outOfScope } : {}),
})

/** Join parts the way a person asks: the first part's language decides the connective. */
function compose(parts: AgenticPart[], lang: string): string {
  const also = lang === 'id' ? 'Selain itu,' : 'Also,'
  return parts.map((p, i) => (i === 0 ? p.question : `${also} ${p.question.charAt(0).toLowerCase()}${p.question.slice(1)}`)).join(' ')
}

const out: AgenticQuestion[] = []
const add = (set: string, parts: AgenticPart[], lang: string, extra: Partial<AgenticQuestion> = {}) =>
  out.push({ id: `${set}-${String(out.filter((q) => q.set === set).length + 1).padStart(2, '0')}`, set, question: compose(parts, lang), parts, ...extra })

for (let i = 0; i < 40; i++) {
  const d = nextDoc(new Set(), 'en')
  const db = dbPart(nextDb(i % 2 === 0 ? 'chinook' : 'erp'))
  // Half the questions lead with the database part, so order is not a hidden variable.
  add('doc_db', i % 4 < 2 ? [docPart(d), db] : [db, docPart(d)], 'en')
}
for (let i = 0; i < 15; i++) add('db_db', i % 2 === 0 ? [dbPart(nextDb('chinook')), dbPart(nextDb('erp'))] : [dbPart(nextDb('erp')), dbPart(nextDb('chinook'))], 'en')
for (let i = 0; i < 15; i++) {
  const a = nextDoc()
  const b = nextDoc(new Set([a.evidence[0].source]), a.lang)
  add('doc_doc', [docPart(a), docPart(b)], a.lang)
}
for (let i = 0; i < 10; i++) {
  const a = nextDoc(new Set(), 'en')
  const b = nextDoc(new Set([a.evidence[0].source]), 'en')
  add('three_part', [docPart(a), docPart(b), dbPart(nextDb(i % 2 === 0 ? 'chinook' : 'erp'))], 'en')
}
for (let i = 0; i < 10; i++) { const d = nextDoc(); add('single_doc', [docPart(d)], d.lang) }
for (let i = 0; i < 10; i++) add('single_db', [dbPart(nextDb(i % 2 === 0 ? 'chinook' : 'erp'))], 'en')
for (let i = 0; i < 10; i++) add('scope', [dbPart(nextDb('chinook')), dbPart(nextDb('erp'), true)], 'en', { scopedTo: 'chinook' })

writeFileSync(join(dir, 'agentic-questions.json'), JSON.stringify({
  generatedAt: new Date().toISOString().slice(0, 10),
  sources: ['rag-questions.json (factual)', 'sql-questions.json (scalar cases)'],
  counts: Object.fromEntries([...new Set(out.map((q) => q.set))].map((s) => [s, out.filter((q) => q.set === s).length])),
  questions: out,
}, null, 2) + '\n')
console.log(`${out.length} questions →`, join(dir, 'agentic-questions.json'))
