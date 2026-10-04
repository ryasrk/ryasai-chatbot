/**
 * Upload the eval corpus through the REAL upload API (chunking, FTS, embedding job) and wait until every chunk has a
 * vector — the eval measures what a customer's upload produces, not a hand-seeded table.
 *
 *   EVAL_BASE_URL=http://127.0.0.1:3107 EVAL_CREDENTIALS_FILE=<path> bun benchmark/eval-live/ingest.ts [--extra <file>]
 */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const base = process.env.EVAL_BASE_URL ?? 'http://127.0.0.1:3107'
const creds = JSON.parse(readFileSync(process.env.EVAL_CREDENTIALS_FILE!, 'utf8')) as {
  password: string
  users: Record<string, { email: string }>
}

export async function login(role: 'admin' | 'viewer'): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: creds.users[role].email, password: creds.password }),
  })
  const cookie = (res.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('x-active-user='))
  if (!res.ok || !cookie) throw new Error(`login as ${role} failed: HTTP ${res.status}`)
  return cookie.split(';')[0]
}

if (import.meta.main) {
  const cookie = await login('admin')
  const listDocs = async () =>
    ((await (await fetch(`${base}/api/documents`, { headers: { cookie } })).json()) as { documents?: Array<Record<string, unknown>> }).documents ?? []
  const have = new Set((await listDocs()).map((d) => String(d.name)))

  const dir = join(import.meta.dir, 'corpus')
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => join(dir, f))
  const extra = process.argv.includes('--extra') ? process.argv[process.argv.indexOf('--extra') + 1] : null
  if (extra) files.push(extra)

  for (const path of files) {
    const name = basename(path)
    if (have.has(name)) continue
    const form = new FormData()
    form.append('file', new File([readFileSync(path)], name, { type: name.endsWith('.md') ? 'text/markdown' : 'text/plain' }))
    // The upload route is rate limited per session (middleware); back off on 429 instead of skipping the file.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(`${base}/api/documents`, { method: 'POST', headers: { cookie }, body: form })
      if (res.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); continue }
      console.log(`upload ${name}: HTTP ${res.status}${res.ok ? '' : ` ${(await res.text()).slice(0, 200)}`}`)
      break
    }
  }

  // Wait for embeddings: every chunk of every document embedded.
  for (let i = 0; i < 180; i++) {
    const docs = await listDocs()
    const total = docs.reduce((n, d) => n + Number((d._count as { chunks?: number } | undefined)?.chunks ?? d.chunkCount ?? 0), 0)
    const embedded = docs.reduce((n, d) => n + Number(d.embeddedChunkCount ?? 0), 0)
    if (i % 6 === 0) console.log(`documents ${docs.length}, chunks embedded ${embedded}/${total}`)
    if (total > 0 && embedded >= total) {
      console.log(`all ${total} chunks embedded`)
      process.exit(0)
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
  console.log('timed out waiting for embeddings')
  process.exit(1)
}
