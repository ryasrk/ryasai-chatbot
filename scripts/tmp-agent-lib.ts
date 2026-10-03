/**
 * TEMPORARY — the shared harness the acceptance agents call. Removed at the end of the run.
 *
 * Every fix from the FIRST run is baked in here, because each one cost a whole agent its findings:
 *   - citations are read from `GET /api/chat/sessions/{id}`, NOT from the SSE stream (the `done` frame carries
 *     none — a stream-only harness reported "zero citations" on every correct answer and manufactured a defect);
 *   - `POST .../messages` is a WRITE endpoint and answers 405 to a GET; `GET /api/chat/sessions` returns `{ items }`;
 *   - `embeddedChunkCount` now counts chunks with a VECTOR (the column retrieval actually searches). It used to
 *     count `embeddingJson`, so a dead vector search reported 500/500 "fully embedded". `waitEmbedded` therefore
 *     waits on the real thing now.
 *
 * Usage: `set -a && . ./.env && set +a && bun run <script>` from the repo root. Import as a library.
 */
import { readFileSync } from 'node:fs'

export const BASE = process.env.AGENT_BASE ?? 'http://localhost:3000'

export interface OrgCreds { key: string; orgId: string; userId: string; email: string; token: string }

/** The isolated orgs, read from the file the setup script wrote. */
export function orgs(): Record<string, OrgCreds> {
  const lines = readFileSync('/tmp/orgs.json', 'utf8').trim().split('\n')
  const out: Record<string, OrgCreds> = {}
  for (const line of lines) {
    const row = JSON.parse(line) as OrgCreds
    out[row.key] = row
  }
  return out
}

export interface ApiResult { status: number; body: any; text: string }

export function api(org: OrgCreds, path: string, init: RequestInit = {}): Promise<ApiResult> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { Cookie: `x-active-user=${org.token}`, ...(init.headers ?? {}) },
  }).then(async (res) => {
    const text = await res.text()
    let body: any = null
    try { body = JSON.parse(text) } catch { /* non-JSON */ }
    return { status: res.status, body, text }
  })
}

export function apiJson(org: OrgCreds, path: string, init: RequestInit = {}): Promise<ApiResult> {
  return api(org, path, { ...init, headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } })
}

/** Create a chat session and return its id, or throw with the response text. */
export async function newSession(org: OrgCreds): Promise<string> {
  const r = await apiJson(org, '/api/chat/sessions', { method: 'POST', body: '{}' })
  const id = r.body?.id
  if (!id) throw new Error(`session create failed: ${r.status} ${r.text.slice(0, 200)}`)
  return id
}

export interface TurnResult {
  answer: string
  error: string
  ms: number
  citations: Array<{ source?: string; type?: string; score?: number; rank?: number; snippet?: string; query_used?: string }>
  toolRuns: Array<{ type?: string; status?: string; latencyMs?: number; outputSummary?: string }>
  firstTokenMs: number | null
  /** Every SSE event type seen, so a caller can assert on the STREAM, not only the final text. */
  events: string[]
  sessionId: string
}

/**
 * Ask one question through the real chat path and assemble the answer.
 *
 * Citations come from the PERSISTED message via `GET /api/chat/sessions/{id}` — the route the UI itself reads.
 */
export async function ask(
  org: OrgCreds,
  question: string,
  opts: { sessionId?: string; timeoutMs?: number } = {},
): Promise<TurnResult> {
  const sessionId = opts.sessionId ?? (await newSession(org))
  const t0 = Date.now()
  let res: Response
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 180_000)
  try {
    res = await fetch(`${BASE}/api/chat/sessions/${sessionId}/send`, {
      method: 'POST',
      headers: { Cookie: `x-active-user=${org.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
      signal: ctl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    return { answer: '', error: `send threw: ${(e as Error).name}: ${(e as Error).message}`, ms: Date.now() - t0, citations: [], toolRuns: [], firstTokenMs: null, events: [], sessionId }
  }
  if (!res.body) {
    clearTimeout(timer)
    return { answer: '', error: `no body (${res.status})`, ms: Date.now() - t0, citations: [], toolRuns: [], firstTokenMs: null, events: [], sessionId }
  }

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = '', event = '', answer = '', error = ''
  let firstTokenMs: number | null = null
  const events: string[] = []
  const toolRuns: TurnResult['toolRuns'] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('event: ')) { event = t.slice(7); continue }
        if (!t.startsWith('data: ')) continue
        let p: any
        try { p = JSON.parse(t.slice(6)) } catch { continue }
        if (event) events.push(event)
        if (event === 'token' && typeof p.content === 'string') {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0
          answer += p.content
        } else if (event === 'answer' && typeof p.content === 'string') {
          if (firstTokenMs === null) firstTokenMs = Date.now() - t0
          answer = p.content
        } else if (event === 'error') {
          error = String(p.message ?? p.code ?? 'error')
        } else if (event === 'tool_end' && typeof p.tool === 'string') {
          toolRuns.push({ type: p.tool, status: p.status, latencyMs: p.latencyMs })
        }
        event = ''
      }
    }
  } catch (e) {
    error = error || `stream read threw: ${(e as Error).name}: ${(e as Error).message}`
  } finally {
    clearTimeout(timer)
  }

  /*
   * Citations: `GET /api/chat/sessions/{id}` returns the session WITH its messages, each carrying its parsed
   * `citations`. This is the UI's own read path. Deriving them from the stream was measured wrong — the `done`
   * frame has no citations field, so a stream-only reader sees zero on every correct answer.
   */
  const citations: TurnResult['citations'] = []
  try {
    const cRes = await fetch(`${BASE}/api/chat/sessions/${sessionId}`, {
      headers: { Cookie: `x-active-user=${org.token}` },
    })
    if (cRes.ok) {
      const body = (await cRes.json()) as { messages?: Array<{ sender?: string; citations?: unknown }> }
      const msgs = body.messages ?? []
      const last = [...msgs].reverse().find((m) => m.sender === 'ai' && Array.isArray(m.citations))
      if (Array.isArray(last?.citations)) citations.push(...(last!.citations as TurnResult['citations']))
    }
  } catch { /* citations stay empty; the caller sees it */ }

  return { answer, error, ms: Date.now() - t0, citations, toolRuns, firstTokenMs, events, sessionId }
}

/** Normalise a number for comparison: strips thousands separators. */
export function num(s: string): string {
  return s.replace(/[.\s,](?=\d{3}\b)/g, '').replace(/\s+/g, ' ')
}

/** Upload a document from a local path (multipart, the same route the UI uses). */
export async function uploadFile(org: OrgCreds, filePath: string, name?: string): Promise<ApiResult> {
  const bytes = readFileSync(filePath)
  const base = (name ?? filePath.split('/').pop() ?? 'upload.bin')
  const form = new FormData()
  form.append('file', new Blob([bytes]), base)
  return api(org, '/api/documents', { method: 'POST', body: form })
}

/** Upload text content as a .txt document. */
export async function uploadText(org: OrgCreds, fileName: string, content: string, category?: string): Promise<ApiResult> {
  const form = new FormData()
  form.append('file', new Blob([content], { type: 'text/plain' }), fileName)
  if (category) form.append('category', category)
  return api(org, '/api/documents', { method: 'POST', body: form })
}

/**
 * Poll until every document with `name` has ALL its chunks VECTORISED.
 *
 * `embeddedChunkCount` counts the pgvector column — the one retrieval searches — so this waits on real
 * searchability. `embeddedJsonOnlyChunkCount`, if non-zero, means an embedder/column dimension mismatch: the
 * document is NOT searchable and the wait must not treat it as ready.
 */
export async function waitEmbedded(org: OrgCreds, name: string, timeoutMs = 120_000): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now()
  let last = ''
  while (Date.now() - t0 < timeoutMs) {
    const r = await api(org, '/api/documents')
    if (r.status === 200 && Array.isArray(r.body?.documents)) {
      const mine = r.body.documents.filter((d: any) => d.name === name)
      if (mine.length > 0) {
        const bad = mine.filter((d: any) => !d.chunkCount || (d.embeddedChunkCount ?? 0) !== d.chunkCount)
        if (bad.length === 0) return { ok: true, detail: `${mine.length} doc(s) fully vectorised` }
        last = bad.map((d: any) => `${d.name} ${d.embeddedChunkCount}/${d.chunkCount} status=${d.status} jsonOnly=${d.embeddedJsonOnlyChunkCount ?? '?'}`).join('; ')
      } else last = `${name} not listed yet`
    } else last = `documents list ${r.status}`
    await new Promise((r) => setTimeout(r, 2000))
  }
  return { ok: false, detail: last }
}
