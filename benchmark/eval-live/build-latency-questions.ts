/**
 * The latency set for the live-eval organisation: questions from the verified RAG and SQL sets whose answer can be
 * checked by substring, so `benchmark/latency-eval.ts --questions` reports first-token time AND correctness on the
 * same corpus the quality evals use.
 *
 *   bun benchmark/eval-live/build-latency-questions.ts   → benchmark/eval-live/latency-questions.json
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withDatabase } from './db-names'

const dir = import.meta.dir
const rag = (JSON.parse(readFileSync(join(dir, 'rag-questions.json'), 'utf8')) as { questions: Array<{ id: string; category: string; question: string; expectedAnswer: string }> }).questions
const sql = (JSON.parse(readFileSync(join(dir, 'sql-questions.json'), 'utf8')) as { cases: Array<{ id: string; dataset: 'chinook' | 'erp'; question: string; goldRows: unknown[][]; goldRowCount: number }> }).cases

/** Forms a number is written in: as given, and without thousands separators (12.500 / 12,500 / 12500). */
function forms(n: string): string[] {
  const plain = n.replace(/[.,](?=\d{3}\b)/g, '')
  return [...new Set([n, plain])]
}

/** The answer's first number of 2+ digits, which every correct answer has to state. */
const firstNumber = (s: string) => s.match(/\d[\d.,]*\d/)?.[0]

const pick = (category: string, n: number) => rag.filter((q) => q.category === category && firstNumber(q.expectedAnswer)).slice(0, n)
const docQs = [...pick('factual', 30), ...pick('multi-hop', 6)].map((q) => ({ id: q.id, question: q.question, any: forms(firstNumber(q.expectedAnswer)!) }))
const dbQs = sql.filter((c) => c.goldRowCount === 1 && c.goldRows[0].length === 1 && /^\d{2,}$/.test(String(c.goldRows[0][0])))
  .slice(0, 10)
  .map((c) => ({ id: c.id, question: withDatabase(c.question, c.dataset), any: forms(String(c.goldRows[0][0])) }))
const chat = [{ id: 'sapaan', question: 'Halo, apa kabar?', any: [''] }, { id: 'thanks', question: 'Terima kasih atas bantuannya!', any: [''] }]

const questions = [...docQs, ...dbQs, ...chat]
writeFileSync(join(dir, 'latency-questions.json'), JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), questions }, null, 2) + '\n')
console.log(`${questions.length} questions (${docQs.length} documents, ${dbQs.length} database, ${chat.length} chat)`)
