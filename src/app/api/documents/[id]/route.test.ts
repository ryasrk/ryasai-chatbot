import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ponytail: per-file bun subprocess (mock.module leaks across files).
const admin = { userId: 'u1', organizationId: 'org-1', role: 'admin' }
const viewer = { userId: 'u2', organizationId: 'org-1', role: 'viewer' }
let getActiveUserImpl: () => Promise<typeof admin> = async () => admin

const auditCalls: Array<Record<string, unknown>> = []
const enterCalls: string[] = []
const deleteCalls: Array<{ id: string }> = []
const ragCacheCalls: number[] = []
let forgetCalls = 0
let cognifyCalls: Array<{ documentId: string; chunks: Array<{ content: string; chunkIndex: number }> }> = []
const chunkRows: Array<{ content: string; chunkIndex: number }> = []
let docExisting: Record<string, unknown> | null = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findFirst: async () => docExisting,
      update: async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'doc-1',
        isEnabled: data.isEnabled ?? true,
        contextPrompt: typeof data.contextPrompt === 'string' ? data.contextPrompt : '',
        updatedAt: 't',
      }),
      delete: async ({ where }: { where: { id: string } }) => {
        deleteCalls.push(where)
        return { id: where.id }
      },
    },
    documentChunk: {
      findMany: async () => chunkRows,
    },
  },
}))
mock.module('@/lib/session', () => ({
  getActiveUser: async () => getActiveUserImpl(),
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) throw new Error('Forbidden')
  },
  writeAudit: async (args: Record<string, unknown>) => {
    auditCalls.push(args)
  },
  handleApiError: (e: unknown, fallback: string) =>
    new Response(
      JSON.stringify({ error: { code: e instanceof Error && 'name' in e ? 'FORBIDDEN' : 'INTERNAL', message: e instanceof Error ? e.message : fallback } }),
      { status: e instanceof Error && e.message === 'Forbidden' ? 403 : 500 },
    ),
}))
mock.module('@/lib/cognee', () => ({
  forgetKnowledgeGraph: async () => { forgetCalls++ },
  cognifyDocument: async (a: { documentId: string; chunks: Array<{ content: string; chunkIndex: number }> }) => {
    cognifyCalls.push(a)
  },
}))
mock.module('@/lib/rag', () => ({ invalidateRagCache: async () => { ragCacheCalls.push(1) } }))
mock.module('@/lib/smart-router', () => ({ invalidateSourceEmbeddingCache: () => { ragCacheCalls.push(2) } }))
mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enterCalls.push(orgId)
  },
}))

const { PATCH, GET, DELETE } = await import('./route')

function patch(id: string, body: unknown): Promise<Response> {
  const req = new Request(`http://localhost/api/documents/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
  return PATCH(req as never, { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  getActiveUserImpl = async () => admin
  auditCalls.length = 0
  enterCalls.length = 0
  deleteCalls.length = 0
  ragCacheCalls.length = 0
  forgetCalls = 0
  cognifyCalls = []
  chunkRows.length = 0
  // `_count.chunks` is REQUIRED by the GET handler. The original fixture was
  // written for PATCH and omitted it, so the default had to grow a `_count` —
  // otherwise a GET test that does not set its own fixture throws
  // "undefined is not an object" and looks like a server error.
  docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '', _count: { chunks: 0 } }
})

describe('PATCH /api/documents/[id] contextPrompt', () => {
  test('admin can set contextPrompt', async () => {
    const res = await patch('doc-1', { contextPrompt: 'use SOP-7 for billing' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.ok).toBe(true)
    expect(json.data.contextPrompt).toBe('use SOP-7 for billing')
    expect(auditCalls).toHaveLength(1)
    expect(auditCalls[0].action).toBe('DOC_UPDATE')
  })

  test('non-admin → 403', async () => {
    getActiveUserImpl = async () => viewer
    const res = await patch('doc-1', { contextPrompt: 'x' })
    expect(res.status).toBe(403)
    expect(auditCalls).toHaveLength(0)
  })

  test('>4000 chars → 400', async () => {
    const res = await patch('doc-1', { contextPrompt: 'x'.repeat(4001) })
    expect(res.status).toBe(400)
  })

  test('whitespace is trimmed before length check & persistence', async () => {
    const res = await patch('doc-1', { contextPrompt: '   hi   ' })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data.contextPrompt).toBe('hi')
  })

  test('404 for unknown id', async () => {
    docExisting = null
    const res = await patch('nope', { contextPrompt: 'x' })
    expect(res.status).toBe(404)
  })

  test('enters org context before any query (tenant guard)', async () => {
    await patch('doc-1', { contextPrompt: 'x' })
    expect(enterCalls).toEqual(['org-1'])
  })
})

// ---------------------------------------------------------------------------
// GET /api/documents/[id]
//
// Untested until now: only PATCH had coverage, so the read path that the document
// detail page depends on (chunk preview + chunk COUNT) had never run.
// ---------------------------------------------------------------------------

function get(id: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/documents/${id}`) as never, {
    params: Promise.resolve({ id }),
  })
}

function del(id: string): Promise<Response> {
  return DELETE(new Request(`http://localhost/api/documents/${id}`, { method: 'DELETE' }) as never, {
    params: Promise.resolve({ id }),
  })
}

describe('GET /api/documents/[id]', () => {
  test('returns the document with its chunk count and a 3-chunk preview', async () => {
    docExisting = {
      id: 'doc-1', name: 'a.pdf', type: 'PDF', sizeBytes: 10, mimeType: 'application/pdf',
      status: 'READY', isEnabled: true, category: null, description: null,
      cognifyStatus: 'DONE', cognifyError: null, cognifiedAt: 't',
      contentText: 'full text', contextPrompt: 'ctx', createdAt: 'c1', updatedAt: 'u1',
      chunks: [{ id: 'ch-1', chunkIndex: 0, content: 'first', tokenCount: 5, keywords: 'a,b' }],
      _count: { chunks: 7 },
    }
    const res = await get('doc-1')
    expect(res.status).toBe(200)
    const body = await res.json() as { document: Record<string, unknown> }
    // chunkCount is the TOTAL; chunkPreview is the first page. Both must be
    // separate fields — conflating them would make the UI say "1 chunk".
    expect(body.document.chunkCount).toBe(7)
    expect((body.document.chunkPreview as unknown[]).length).toBe(1)
    expect(body.document.contextPrompt).toBe('ctx')
    // The fixture above already carried these, and the route already SELECTED them — but it never
    // mapped them into the response, so they were silently dropped on the way out and the detail
    // dialog had no way to explain a document with no searchable content. A selected field that is
    // not mapped is a field the API does not actually return.
    expect(body.document.cognifyStatus).toBe('DONE')
    expect(body.document.cognifyError).toBeNull()
  })

  test('a FAILED indexing status and its reason reach the client', async () => {
    // This is what makes the failure visible to a customer instead of looking like a healthy
    // document with an empty chunk list.
    docExisting = {
      id: 'doc-bad', name: 'bad.pdf', type: 'PDF', sizeBytes: 10, mimeType: 'application/pdf',
      status: 'READY', isEnabled: true, category: null, description: null,
      cognifyStatus: 'failed', cognifyError: 'Embedding API error (HTTP 401)', cognifiedAt: null,
      contentText: '', contextPrompt: null, createdAt: 'c1', updatedAt: 'u1',
      chunks: [], _count: { chunks: 0 },
    }
    const res = await get('doc-bad')
    const body = await res.json() as { document: Record<string, unknown> }
    expect(body.document.cognifyStatus).toBe('failed')
    expect(body.document.cognifyError).toBe('Embedding API error (HTTP 401)')
  })

  test('requests only the first 3 chunks, in order', async () => {
    // The detail page shows a preview; fetching every chunk of a 10k-chunk
    // document would be a large, pointless transfer.
    let selectArg: Record<string, unknown> | null = null
    const dbMod = await import('@/lib/db')
    const original = dbMod.db.document.findFirst
    dbMod.db.document.findFirst = (async (args: Record<string, unknown>) => {
      selectArg = args
      return docExisting
    }) as typeof original
    try {
      await get('doc-1')
      const chunks = (selectArg as unknown as { select: { chunks: { take: number; orderBy: unknown } } })
        .select.chunks
      expect(chunks.take).toBe(3)
      expect(chunks.orderBy).toEqual({ chunkIndex: 'asc' })
    } finally {
      dbMod.db.document.findFirst = original
    }
  })

  test('an unknown id is 404, not an empty document', async () => {
    docExisting = null
    const res = await get('nope')
    // A 200 with `document: null` would make the page render a blank shell that
    // looks like a loading failure.
    expect(res.status).toBe(404)
  })

  test('org context is entered before the query (tenant guard)', async () => {
    await get('doc-1')
    expect(enterCalls).toEqual(['org-1'])
  })

  test('a viewer may READ (only writes are admin-gated)', async () => {
    getActiveUserImpl = async () => viewer
    const res = await get('doc-1')
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/documents/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/documents/[id]', () => {
  test('an admin deletes, invalidates caches and audits with the chunk count', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', type: 'PDF', category: 'HR', _count: { chunks: 4 } }
    const res = await del('doc-1')
    expect(res.status).toBe(200)
    expect(deleteCalls).toEqual([{ id: 'doc-1' }])
    // Both caches matter: the RAG cache holds retrieved chunks and the embedding
    // cache holds the source's vectors. Leaving either warm serves a deleted
    // document back to the next question.
    expect(ragCacheCalls).toHaveLength(2)
    expect(forgetCalls).toBe(1)
    const row = auditCalls.find((a) => a.action === 'DOC_DELETE')
    expect(row).toBeDefined()
    expect(row?.severity).toBe('warning')
    expect((row?.detail as Record<string, unknown>).chunkCount).toBe(4)
  })

  test('a non-admin is refused AND nothing is deleted', async () => {
    getActiveUserImpl = async () => viewer
    docExisting = { id: 'doc-1', name: 'a.pdf', type: 'PDF', category: null, _count: { chunks: 4 } }
    const res = await del('doc-1')
    expect(res.status).toBe(403)
    // The gate is only meaningful if the write did not happen.
    expect(deleteCalls).toHaveLength(0)
    expect(auditCalls).toHaveLength(0)
  })

  test('the role check runs BEFORE the document lookup', async () => {
    // Ordering matters for information disclosure: looking the document up first
    // would let a non-admin learn whether an id exists from the difference between
    // 404 and 403.
    getActiveUserImpl = async () => viewer
    let lookedUp = false
    const dbMod = await import('@/lib/db')
    const original = dbMod.db.document.findFirst
    dbMod.db.document.findFirst = (async () => { lookedUp = true; return docExisting }) as typeof original
    try {
      const res = await del('doc-1')
      expect(res.status).toBe(403)
      expect(lookedUp).toBe(false)
    } finally {
      dbMod.db.document.findFirst = original
    }
  })

  test('an unknown id is 404 and deletes nothing', async () => {
    docExisting = null
    const res = await del('ghost')
    expect(res.status).toBe(404)
    expect(deleteCalls).toHaveLength(0)
  })

  test('org context is entered before any query (tenant guard)', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', type: 'PDF', category: null, _count: { chunks: 1 } }
    await del('doc-1')
    expect(enterCalls).toEqual(['org-1'])
  })

  test('the response reports how many chunks went with it', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', type: 'PDF', category: null, _count: { chunks: 12 } }
    const res = await del('doc-1')
    const body = await res.json() as { deletedId: string; chunkCountRemoved: number }
    expect(body.deletedId).toBe('doc-1')
    expect(body.chunkCountRemoved).toBe(12)
  })
})


// ---------------------------------------------------------------------------
// PATCH — re-enabling triggers re-cognify
//
// documentChunk was not even present in this file's db mock, so the re-cognify
// branch had never executed: a document turned back ON kept whatever the
// knowledge graph held from before it was disabled.
// ---------------------------------------------------------------------------

describe('PATCH /api/documents/[id] — re-enable re-cognifies', () => {
  test('enabling a previously DISABLED document re-sends its chunks to cognify', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: false, contextPrompt: '' }
    chunkRows.push({ content: 'chunk one', chunkIndex: 0 }, { content: 'chunk two', chunkIndex: 1 })
    const res = await patch('doc-1', { isEnabled: true })
    expect(res.status).toBe(200)
    expect(cognifyCalls).toHaveLength(1)
    expect(cognifyCalls[0].documentId).toBe('doc-1')
    // The chunks must be ordered and carry their index: cognee rebuilds the
    // document from them, and an unordered set produces a scrambled graph.
    expect(cognifyCalls[0].chunks).toEqual([
      { content: 'chunk one', chunkIndex: 0 },
      { content: 'chunk two', chunkIndex: 1 },
    ])
  })

  test('enabling an ALREADY-enabled document does NOT re-cognify', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }
    await patch('doc-1', { isEnabled: true })
    // Re-cognifying on every PATCH would rebuild the whole graph on a no-op edit.
    expect(cognifyCalls).toHaveLength(0)
  })

  test('DISABLING does not re-cognify', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }
    await patch('doc-1', { isEnabled: false })
    expect(cognifyCalls).toHaveLength(0)
  })

  test('a contextPrompt-only edit does not re-cognify', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }
    await patch('doc-1', { contextPrompt: 'new prompt' })
    expect(cognifyCalls).toHaveLength(0)
  })

  test('a rejected body does not reach the update', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: true, contextPrompt: '' }
    // Neither field supplied.
    const res = await patch('doc-1', { isEnabled: 'yes' })
    expect(res.status).toBe(400)
    expect(cognifyCalls).toHaveLength(0)
  })

  test('isEnabled is only accepted as a real boolean', async () => {
    docExisting = { id: 'doc-1', name: 'a.pdf', isEnabled: false, contextPrompt: '' }
    // A truthy STRING must not flip the flag: 'false' would otherwise enable a
    // document the user meant to disable.
    const res = await patch('doc-1', { isEnabled: 'false' })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/documents/[id] — failure path', () => {
  test('a database error is handled, not thrown at the caller', async () => {
    const dbMod = await import('@/lib/db')
    const original = dbMod.db.document.findFirst
    dbMod.db.document.findFirst = (async () => { throw new Error('db down') }) as unknown as typeof original
    try {
      const res = await get('doc-1')
      // The handler must convert it to a Response; an uncaught throw would give
      // the client a bare 500 with no JSON envelope.
      expect(res.status).toBe(500)
    } finally {
      dbMod.db.document.findFirst = original
    }
  })
})
