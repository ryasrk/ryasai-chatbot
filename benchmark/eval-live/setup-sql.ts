/**
 * Prepare the live Text-to-SQL eval: register the demo databases as integrations of the eval org (through the real
 * API, so schema reflection and enrichment run as for a customer) and compute each question's GOLD result by
 * executing its reference SQL directly. A question whose reference SQL does not run is dropped and reported.
 *
 * Datasets: Chinook 1.4.5 (public, identifiers de-underscored to match the question set's CamelCase SQL) in
 * `eval_chinook`, and the app's own demo ERP seed (`ensureDemoSchema`) in `eval_erp`.
 *
 *   DATABASE_URL=<any db on the same server> EVAL_BASE_URL=… EVAL_CREDENTIALS_FILE=… bun benchmark/eval-live/setup-sql.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import pg from 'pg'
import { login } from './ingest'
import { chinookQuestions } from '../questions/chinook'
import { erpQuestions } from '../questions/erp'

const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const credFile = process.env.EVAL_CREDENTIALS_FILE!
const creds = JSON.parse(readFileSync(credFile, 'utf8')) as Record<string, unknown>
const server = new URL(process.env.DATABASE_URL!)

const DATASETS = [
  { key: 'chinook', db: 'eval_chinook', name: 'Chinook Music Store', questions: chinookQuestions },
  { key: 'erp', db: 'eval_erp', name: 'ERP Demo', questions: erpQuestions },
]

const cookie = await login('admin')
const integrations: Record<string, string> = (creds.integrations as Record<string, string>) ?? {}
for (const d of DATASETS) {
  if (integrations[d.key]) continue
  const res = await fetch(`${base}/api/integrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({
      name: d.name,
      type: 'DATABASE',
      provider: 'POSTGRESQL',
      config: {
        host: server.hostname,
        port: Number(server.port || 5432),
        database: d.db,
        user: decodeURIComponent(server.username),
        password: decodeURIComponent(server.password),
      },
    }),
  })
  const body = (await res.json()) as { data?: { id?: string }; id?: string; error?: unknown }
  const id = body.data?.id ?? body.id
  if (!res.ok || !id) throw new Error(`creating ${d.name} failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 200)}`)
  integrations[d.key] = id
  console.log(`integration ${d.name}: ${id}`)
}
writeFileSync(credFile, JSON.stringify({ ...creds, integrations }, null, 2), { mode: 0o600 })

interface SqlEvalCase { id: string; dataset: string; category: string; difficulty: string; question: string; goldSql: string; goldRowCount: number; goldRows: unknown[][] }
const cases: SqlEvalCase[] = []
const dropped: string[] = []
for (const d of DATASETS) {
  const url = new URL(server.toString())
  url.pathname = `/${d.db}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  for (const q of d.questions) {
    try {
      const r = await client.query({ text: q.groundTruthSql, rowMode: 'array' })
      cases.push({
        id: q.id, dataset: d.key, category: q.category, difficulty: q.difficulty, question: q.question,
        goldSql: q.groundTruthSql, goldRowCount: r.rowCount ?? r.rows.length, goldRows: r.rows.slice(0, 200),
      })
    } catch (e) {
      dropped.push(`${q.id}: ${String(e).slice(0, 100)}`)
    }
  }
  await client.end()
}
writeFileSync(join(import.meta.dir, 'sql-questions.json'), JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2) + '\n')
console.log(`gold computed for ${cases.length} questions; dropped ${dropped.length}`)
for (const line of dropped) console.log(`  dropped ${line}`)
process.exit(0)
