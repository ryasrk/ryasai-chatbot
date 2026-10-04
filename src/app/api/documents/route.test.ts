/**
 * POST /api/documents — the upload path, and the STORAGE-CHOICE GATE that now stands in front of it.
 *
 * WHY THIS FILE EXISTS. This route had no test of its own, so every refusal that matters was unguarded,
 * including the gate added with the Knowledge restructure. The gate is easy to get subtly wrong in four
 * different directions, and all four are silent:
 *
 *   1. IT MUST REFUSE WHEN NOTHING WAS CHOSEN. `VectorStoreConfig.provider` defaults to `INTERNAL`, so
 *      "unchosen" and "chosen the bundled store" are the same value in that column -- only
 *      `storageChosenAt` separates them. A gate reading the provider column instead of
 *      `getKnowledgeStorageChoice()` would accept documents into a store nobody picked, which is exactly
 *      the behaviour the feature replaces.
 *   2. THE REFUSAL MUST BE `SETUP_REQUIRED` (503), NOT A 4xx. The install is unfinished; nothing about
 *      the request is malformed. The UI branches on the code to offer the setup link, so a 400 here
 *      would surface as "invalid file" next to a perfectly valid file.
 *   3. IT MUST SIT AFTER THE CHEAPER REFUSALS. A viewer sending an over-quota upload should be told
 *      about the role or the quota, not about storage setup. Asserted by call ordering, not by reading
 *      the source: `storageReads === 0` when the quota refuses.
 *   4. IT MUST SIT BEFORE EXTRACTION. The whole reason for the placement is that a refused upload costs
 *      no parse, no chunk write and no embedding call. Asserted on the side effects (`extractCalls`,
 *      `chunkCreateMany`), because "before extraction" is a claim about work NOT done -- a comment
 *      saying so is satisfied by the call moving one line down.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin', plan: 'flat' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer', plan: 'flat' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin
const listWheres: Array<Record<string, unknown>> = []

/** What `getKnowledgeStorageChoice()` reports. The default is the UNCHOSEN install. */
let storageChosen = false
let storageReads = 0

let docCount = 0
let extractCalls = 0
let detectCalls = 0
let extractText = 'hello world\n\nsecond paragraph'
const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
const createdDocs: Array<Record<string, unknown>> = []
const chunkWrites: Array<Array<Record<string, unknown>>> = []
const enqueued: string[] = []
const persistedChunks: Array<{ id: string; content: string; keywords: string[] }> = []

const createdDoc = {
  id: 'doc-1',
  name: 'facts.txt',
  type: 'txt',
  category: 'Uncategorized',
  sizeBytes: 27,
  mimeType: 'text/plain',
  status: 'ready',
  description: '',
}

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findMany: async (q: { where: Record<string, unknown> }) => {
        listWheres.push(q.where)
        return []
      },
      count: async () => docCount,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        createdDocs.push(data)
        return { ...createdDoc, ...data }
      },
      findUnique: async () => ({ ...createdDoc, _count: { chunks: persistedChunks.length } }),
    },
    documentChunk: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        chunkWrites.push(data)
        persistedChunks.length = 0
        data.forEach((c, i) =>
          persistedChunks.push({ id: `chunk-${i}`, content: String(c.content), keywords: [] }),
        )
        return { count: data.length }
      },
      findMany: async () => persistedChunks,
    },
  },
}))

mock.module('@/lib/session', () => ({
  /**
   * NOT USED BY THE ROUTE — see the note on `getOrgContext` below. The real `@/lib/errors` (unmocked,
   * deliberately) imports `UnauthorizedError` from this module for its `instanceof` check, so a partial
   * session mock without it fails the file at import time with "Export named 'UnauthorizedError' not
   * found". Mirrors the real class: `code` is what `handleApiError` branches on, and keeping it means
   * the mock and the real module agree on the discriminator.
   */
  UnauthorizedError: class UnauthorizedError extends Error {
    readonly code = 'UNAUTHORIZED'
    constructor(message = 'No active session.') {
      super(message)
      this.name = 'UnauthorizedError'
    }
  },
  getActiveUser: async () => getActiveUserImpl(),
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditCalls.push(args)
  },
  /**
   * Duck-typed on `code`/`statusCode` rather than `instanceof AppError`, because `@/lib/errors` is NOT
   * mocked here — the real `AppError` reaches this function, and it carries both fields. Reading
   * `statusCode` (rather than hardcoding 503) is deliberate: it means the SETUP_REQUIRED → 503 mapping
   * is asserted against the real `defaultStatusForCode` table, not against this mock.
   */
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string; hint?: string; statusCode?: number }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
    }
    if (err?.code) {
      return Response.json(
        { error: { code: err.code, message: err.message, hint: err.hint } },
        { status: err.statusCode ?? status },
      )
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/rag', () => ({
  detectDocType: (name: string) => {
    detectCalls++
    return name.split('.').pop() ?? 'txt'
  },
  extractFileText: async () => {
    extractCalls++
    return { text: extractText, isPlaceholder: false }
  },
  chunkText: (text: string, options: { maxChunks: number }) => text.split('\n\n').filter(Boolean).slice(0, options.maxChunks),
  extractKeywords: () => [],
  invalidateRagCache: async () => {},
}))

mock.module('@/lib/rag-chunking', () => ({
  MAX_EXTRACTED_TEXT_CHARS: 2_000_000,
  emptyDocumentContent: (name: string) => `[placeholder: ${name}]`,
}))

mock.module('@/lib/rag-fts', () => ({ upsertChunkFts: async () => {} }))
mock.module('@/lib/job-processor', () => ({
  enqueueOrSync: async (type: string) => {
    enqueued.push(type)
  },
}))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => {} }))
mock.module('@/lib/knowledge-graph', () => ({ indexChunkKnowledgeGraph: async () => {} }))
mock.module('@/lib/source-init', () => ({ initDocumentContext: async () => {} }))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
  /**
   * NOT USED BY THE ROUTE — it is here because this mock is PARTIAL, and a partial mock must expose
   * every export its real consumers import. `@/lib/errors` is deliberately NOT mocked (so the
   * SETUP_REQUIRED → 503 mapping is asserted against the real status table), and it pulls in the real
   * `@/lib/llm-client-utils`, which imports `getOrgContext` from this module. Omitting it fails the
   * whole file with "Export named 'getOrgContext' not found" — a harness error that looks nothing like
   * the thing under test.
   */
  getOrgContext: () => undefined,
  // Same reason as getOrgContext above: the real llm-client-utils imports requireOrgContext too, and a
  // partial mock that omits it fails the file at collection time with an export error.
  requireOrgContext: () => { throw new Error('requireOrgContext called in a route test with no org') },
}))

// The predicate under test is mocked at the BOUNDARY (this module), not reimplemented: what the route
// must do with `chosen: false` is the subject here, and `getKnowledgeStorageChoice` itself has its own
// tests in `src/lib/vector-stores.test.ts` (no row / default INTERNAL / timestamp / typo'd provider).
mock.module('@/lib/vector-stores', () => ({
  getKnowledgeStorageChoice: async () => {
    storageReads++
    return { chosen: storageChosen, chosenAt: null, provider: 'INTERNAL' }
  },
}))

const { GET, POST } = await import('./route')

function upload(name = 'facts.txt', body: string | Blob = 'hello world'): Promise<Response> {
  const form = new FormData()
  form.append('file', new File([body], name, { type: 'text/plain' }))
  const req = new Request('http://localhost/api/documents', { method: 'POST', body: form })
  return POST(req as never)
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  storageChosen = false
  storageReads = 0
  docCount = 0
  extractCalls = 0
  detectCalls = 0
  extractText = 'hello world\n\nsecond paragraph'
  auditCalls.length = 0
  enterCalls.length = 0
  createdDocs.length = 0
  chunkWrites.length = 0
  enqueued.length = 0
  persistedChunks.length = 0
})

describe('storage gate — uploads are refused until the store is chosen', () => {
  test('nothing chosen → 503 SETUP_REQUIRED with an actionable hint', async () => {
    const res = await upload()

    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; message: string; hint?: string } }
    expect(body.error.code).toBe('SETUP_REQUIRED')
    // The message has to say what to DO. "Uploads are disabled" would leave the operator with a
    // refused button and no next step, which is the failure mode this whole feature exists to remove.
    expect(body.error.hint).toContain('Knowledge')
    expect(body.error.hint?.toLowerCase()).toContain('storage')
  })

  test('nothing chosen → NOTHING was parsed, chunked or written', async () => {
    await upload()

    // The claim "the gate sits before extraction" is a claim about work NOT done, so it is asserted on
    // side effects. A comment asserting the placement is satisfied by moving the call one line down,
    // after which a refused upload pays for a parse and an embedding job.
    expect(extractCalls).toBe(0)
    expect(detectCalls).toBe(0)
    expect(chunkWrites).toHaveLength(0)
    expect(createdDocs).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
    expect(auditCalls).toHaveLength(0)
  })

  test('a chosen store lets the same upload through, end to end', async () => {
    storageChosen = true
    const res = await upload()

    expect(res.status).toBe(201)
    expect(createdDocs[0]).toMatchObject({ name: 'facts.txt', status: 'ready' })
    expect(enterCalls).toEqual(['org-1'])
    expect(extractCalls).toBe(1)
    // Embedding is enqueued only on the succeeding path — the pair of assertions (0 when refused, this
    // when allowed) is what makes the first one meaningful.
    expect(enqueued).toContain('document-embed')
    expect(auditCalls[0]?.action).toBe('DOC_UPLOAD')
  })
})

describe('the gate sits behind the cheaper refusals', () => {
  test('an over-quota admin is told about the quota, and storage is never read', async () => {
    // 'starter' allows 25 documents; the count is already at the ceiling.
    getActiveUserImpl = async () => ({ ...admin, plan: 'starter' })
    docCount = 25

    const res = await upload()

    expect(res.status).toBe(402)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('QUOTA_EXCEEDED')
    // The ORDER is the assertion. If the gate ran first, every over-quota upload in an unconfigured
    // install would report the storage problem -- a real, actionable refusal replaced by a different,
    // equally real one, and the operator fixes the wrong thing.
    expect(storageReads).toBe(0)
    expect(extractCalls).toBe(0)
  })

  test('a non-admin is refused by role, with no document count and no storage read', async () => {
    getActiveUserImpl = async () => ({ ...viewer, plan: 'flat' })

    const res = await upload()

    expect(res.status).toBe(403)
    expect(storageReads).toBe(0)
    expect(createdDocs).toHaveLength(0)
  })
})

describe('request validation still answers before any auth work', () => {
  test('a disallowed extension → 400 without touching the database', async () => {
    const res = await upload('payload.exe')

    expect(res.status).toBe(400)
    expect(storageReads).toBe(0)
    expect(createdDocs).toHaveLength(0)
  })

  test('an empty file → 400', async () => {
    const res = await upload('empty.txt', '')

    expect(res.status).toBe(400)
    expect(storageReads).toBe(0)
  })
})

describe('bounded upload preserves all accepted chunks', () => {
  test('a document above the old 500 cap retains its final chunk', async () => {
    storageChosen = true
    extractText = Array.from({ length: 1_029 }, (_, i) => `Book section ${i}`).join('\n\n')
    const res = await upload()
    expect(res.status).toBe(201)
    expect(chunkWrites[0]).toHaveLength(1_029)
    expect(chunkWrites[0].at(-1)?.content).toBe('Book section 1028')
    const body = await res.json()
    expect(body.document.chunkCount).toBe(1_029)
  })
  test('a document exactly at the limit retains every chunk', async () => {
    storageChosen = true
    extractText = Array.from({ length: 2_000 }, (_, i) => `Section ${i}`).join('\n\n')
    const res = await upload()
    expect(res.status).toBe(201)
    expect(chunkWrites[0]).toHaveLength(2_000)
    expect(chunkWrites[0].at(-1)?.content).toBe('Section 1999')
    expect((await res.json()).document.chunkCount).toBe(2_000)
  })
  test('over-limit documents fail before any document, chunk, audit or job is persisted', async () => {
    storageChosen = true
    extractText = Array.from({ length: 2_001 }, (_, i) => `Section ${i}`).join('\n\n')
    const res = await upload()
    expect(res.status).toBe(413)
    expect((await res.json()).error).toContain('Split it into smaller documents')
    expect(createdDocs).toHaveLength(0)
    expect(chunkWrites).toHaveLength(0)
    expect(auditCalls).toHaveLength(0)
    expect(enqueued).toHaveLength(0)
  })
})

describe('GET /api/documents — per-role visibility', () => {
  test('a viewer lists only documents whose allowedRoles include viewer', async () => {
    getActiveUserImpl = async () => viewer
    listWheres.length = 0
    const res = await GET(new Request('http://x/api/documents') as never)
    expect(res.status).toBe(200)
    expect(listWheres[0]).toEqual({ allowedRoles: { has: 'viewer' } })
  })

  test('an admin lists every document, and the category filter still applies', async () => {
    getActiveUserImpl = async () => admin
    listWheres.length = 0
    await GET(new Request('http://x/api/documents?category=SOP') as never)
    expect(listWheres[0]).toEqual({ category: 'SOP' })
  })
})
