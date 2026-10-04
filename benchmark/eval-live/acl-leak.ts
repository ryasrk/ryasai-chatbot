/**
 * Live per-role document access check (ADR 0014): hide documents from `viewer`, then try to reach them as a viewer
 * through every read path a viewer has — search with the very questions written about those documents, the
 * document list, the document detail and the chunk viewer. Any hidden document returned is a leak.
 *
 *   EVAL_BASE_URL=… EVAL_CREDENTIALS_FILE=… bun benchmark/eval-live/acl-leak.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { login } from './ingest'
import type { EvalQuestion } from './generate-questions'

const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const HIDDEN = ['hr-02-kompensasi-tunjangan.md', 'fin-04-anggaran.md', 'risk-01-manajemen-risiko.md']

const admin = await login('admin')
const viewer = await login('viewer')
const list = async (cookie: string) =>
  ((await (await fetch(`${base}/api/documents`, { headers: { cookie } })).json()) as { documents: Array<{ id: string; name: string }> }).documents

const all = await list(admin)
const hidden = all.filter((d) => HIDDEN.includes(d.name))
if (hidden.length !== HIDDEN.length) throw new Error('hidden documents not found in the eval org')

const setRoles = async (roles: string[]) => {
  for (const d of hidden) {
    const res = await fetch(`${base}/api/documents/${d.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', cookie: admin }, body: JSON.stringify({ allowedRoles: roles }),
    })
    if (!res.ok) throw new Error(`PATCH ${d.name}: HTTP ${res.status}`)
  }
}

const { questions } = JSON.parse(readFileSync(join(import.meta.dir, 'rag-questions.json'), 'utf8')) as { questions: EvalQuestion[] }
const probes = questions.filter((q) => q.evidence.some((e) => HIDDEN.includes(e.source))).map((q) => q.question)

const leaks: string[] = []
let checks = 0
await setRoles(['admin'])
try {
  for (const q of probes) {
    const res = await fetch(`${base}/api/documents/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie: viewer }, body: JSON.stringify({ query: q, topK: 10 }),
    })
    const body = (await res.json()) as { results?: Array<{ documentName?: string }> }
    checks++
    for (const r of body.results ?? []) if (HIDDEN.includes(r.documentName ?? '')) leaks.push(`search "${q.slice(0, 60)}" → ${r.documentName}`)
  }
  const viewerList = await list(viewer)
  checks++
  for (const d of viewerList) if (HIDDEN.includes(d.name)) leaks.push(`list → ${d.name}`)
  for (const d of hidden) {
    for (const path of [`/api/documents/${d.id}`, `/api/documents/${d.id}/chunks`]) {
      const res = await fetch(`${base}${path}`, { headers: { cookie: viewer } })
      checks++
      if (res.status !== 404) leaks.push(`${path} → HTTP ${res.status}`)
    }
  }
  // Control: the admin still reaches every hidden document, so the check above is not passing vacuously.
  const adminSees = (await list(admin)).filter((d) => HIDDEN.includes(d.name)).length
  console.log(`probe questions ${probes.length}; checks ${checks}; leaks ${leaks.length}; admin control sees ${adminSees}/${HIDDEN.length}`)
  for (const l of leaks) console.log(`  LEAK ${l}`)
  if (adminSees !== HIDDEN.length) throw new Error('control failed: admin cannot see the hidden documents')
} finally {
  await setRoles(['admin', 'analyst', 'viewer'])
}
process.exit(leaks.length > 0 ? 1 : 0)
