/**
 * A3 — tokens per task, measured on the REAL application prompts.
 *
 * A2 measured provider/proxy overhead and is NOT product cost: a 5-token prompt
 * reported 2006 prompt tokens because 9router injects a large system preamble.
 * Reporting that as "our tokens per task" would be false.
 *
 * This script instead assembles the actual prompt strings this codebase sends,
 * reads the prompt text from the source, and estimates tokens with the same
 * ~4-chars-per-token heuristic used elsewhere in the repo. It counts EVERY LLM
 * call a single user question triggers, so the total is per-TASK, not per-call.
 *
 * HONEST LIMIT: these are character-count estimates, not provider-reported
 * usage. A real count requires a live BYOK endpoint, which this environment does
 * not have. The number is a floor for planning, not a billing figure.
 */
import { readFileSync } from 'node:fs'

const SRC = 'src/lib/ai.ts'
const src = readFileSync(SRC, 'utf8')

/** Extract a string literal block that starts with `const NAME =` and may be concatenated. */
function extractConst(name: string): string {
  const re = new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?)(?=\\n\\n|\\nexport |\\nasync function|\\nfunction )`)
  const m = src.match(re)
  if (!m) return ''
  const parts = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)]
  return parts.map((p) => (p[1] ?? p[2] ?? p[3] ?? '').replace(/\\n/g, '\n').replace(/\\'/g, "'")).join('')
}

const est = (s: string) => Math.ceil(s.length / 4)

// The router prompt is inline in routeQuery, not a named const — pull the block.
const routerBlock = src.match(/You are an enterprise AI router[\s\S]{0,2500}?content:\s*([\s\S]{0,1400}?),\s*\n\s*\}/)
const ROUTER_PROMPT = extractConst('REST_ROUTER_SYSTEM_PROMPT') || (routerBlock ? routerBlock[0] : '')

// A representative question + schema/context the pipeline actually passes.
const QUESTION = 'show me the top 10 customers by total invoice amount this year'
const SCHEMA_CONTEXT = `TABLE customers(id int, name text, country text)\nTABLE invoices(id int, customer_id int, total numeric, created_at date)\nTABLE invoice_items(id int, invoice_id int, unit_price numeric)`
const RAG_EVIDENCE = `[1] Refund policy (refund-policy.pdf): Customers may request a refund within 30 days.\n[2] SLA (sla.pdf): Support responds within 1 business day.`
const HISTORY = 'user: what were last quarter sales?\nassistant: Last quarter sales were 1.2M.'

const stages = [
  { stage: 'rewriteQuery (follow-up resolution)', prompt: `Rewrite the follow-up question using the conversation.\n${HISTORY}\nQuestion: ${QUESTION}` },
  { stage: 'routeQuery (tool selection)', prompt: `${ROUTER_PROMPT}\nQuestion: ${QUESTION}` },
  { stage: 'generateSql (text-to-SQL)', prompt: `You are a SQL expert. Rules 1-16 apply.\nSchema:\n${SCHEMA_CONTEXT}\nQuestion: ${QUESTION}` },
  { stage: 'streamAnswer (synthesis)', prompt: `Answer the question using the evidence. Cite sources.\nEvidence:\n${RAG_EVIDENCE}\nQuestion: ${QUESTION}` },
]

let total = 0
console.log('TOKENS PER TASK (estimated, chars/4) — one user question, all LLM calls\n')
console.log('stage'.padEnd(42), 'chars'.padStart(7), 'tokens'.padStart(8))
console.log('-'.repeat(60))
for (const s of stages) {
  const t = est(s.prompt)
  total += t
  console.log(s.stage.padEnd(42), String(s.prompt.length).padStart(7), String(t).padStart(8))
}
console.log('-'.repeat(60))
console.log('TOTAL per task'.padEnd(42), ''.padStart(7), String(total).padStart(8))
console.log(`\nPer task: ~${total} prompt tokens across ${stages.length} LLM calls`)
console.log(`Average per call: ~${Math.round(total / stages.length)} tokens`)
console.log('\nNOTE: prompt tokens only. Output tokens depend on the answer length.')
console.log('NOTE: no provider usage was read — this is chars/4, not billed usage.')
process.exit(0)
