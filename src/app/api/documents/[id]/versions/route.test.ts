/**
 * GET + POST /api/documents/[id]/versions — list version snapshots and take a new one.
 *
 * WHY THIS FILE EXISTS. A thin route over `doc-versioning.ts`, so the tests focus on the seam the route owns:
 * the org context it establishes, the argument it passes through, and the audit row it writes. Three things
 * are worth pinning here:
 *
 *   1. THE ROUTE (not the library) IS WHAT ENTERS THE ORG CONTEXT, and the library does not establish it
 *      itself -- `createDocVersion` reads `getOrgContext()!` to fill the new version row's `organizationId`.
 *      If the route ever stops calling `enterWithOrg`, that non-null assertion becomes a null tenant field
 *      rather than an error. Asserted on the ORDER of the two effects (context before the library call).
 *   2. THE DOCUMENT ID IS PASSED THROUGH VERBATIM. The route does not load or validate the document; the
 *      library does, and throws when it is missing. So the route's contract is that a library throw becomes a
 *      handled error response, and that the id is forwarded unchanged (the library's own tests cover the
 *      lookup, which is asserted here to happen inside the library rather than the route).
 *   3. THE SNAPSHOT'S VERSION NUMBER is what the audit records. Asserting the audit detail pins that the route
 *      reports the version actually created rather than the document id twice.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

let versions: Array<Record<string, unknown>> = []
let snapshot: Record<string, unknown> = {}
let listThrows: Error | null = null
let createThrows: Error | null = null

/** Records the order of side effects so "context before library call" is assertable. */
const events: string[] = []
const listArgs: unknown[] = []
const createArgs: unknown[] = []
const auditWrites: Array<Record<string, unknown>> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  handleApiError: (e: unknown, msg: string) => Response.json({ error: msg }, { status: 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/doc-versioning', () => ({
  listDocVersions: async (id: string) => {
    listArgs.push(id)
    events.push('listDocVersions')
    if (listThrows) throw listThrows
    return versions
  },
  createDocVersion: async (id: string) => {
    createArgs.push(id)
    events.push('createDocVersion')
    if (createThrows) throw createThrows
    return snapshot
  },
}))

import { GET, POST } from './route'

const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function get(id = 'd1') {
  return GET(new Request(`http://localhost/api/documents/${id}/versions`) as never, ctx(id))
}

function post(id = 'd1') {
  return POST(new Request(`http://localhost/api/documents/${id}/versions`, { method: 'POST' }) as never, ctx(id))
}

beforeEach(() => {
  user = adminUser
  versions = [
    { id: 'v3', documentId: 'd1', version: 3, contentHash: 'ccc', chunkCount: 30, createdAt: new Date('2026-03-01') },
    { id: 'v2', documentId: 'd1', version: 2, contentHash: 'bbb', chunkCount: 20, createdAt: new Date('2026-02-01') },
    { id: 'v1', documentId: 'd1', version: 1, contentHash: 'aaa', chunkCount: 10, createdAt: new Date('2026-01-01') },
  ]
  snapshot = {
    id: 'v4',
    documentId: 'd1',
    version: 4,
    contentHash: 'ddd',
    chunkCount: 40,
    createdAt: new Date('2026-04-01'),
  }
  listThrows = null
  createThrows = null
  events.length = 0
  listArgs.length = 0
  createArgs.length = 0
  auditWrites.length = 0
})

describe('org context', () => {
  test('GET enters the session org before listing', async () => {
    // The library does not establish org context; the ROUTE does. Order is the assertion because a context
    // entered after the query would be useless.
    await get()
    expect(events).toEqual(['enterWithOrg:org-1', 'listDocVersions'])
  })

  test('POST enters the session org before creating, and audits after', async () => {
    await post()
    expect(events).toEqual(['enterWithOrg:org-1', 'createDocVersion', 'audit'])
  })

  test('a viewer-scoped user still enters their own org (the route adds no role gate)', async () => {
    // Documented as the current behaviour: this route is not admin-only, unlike the connector edits. Recorded
    // by assertion so a later decision to gate it has to change this test deliberately.
    user = { ...adminUser, role: 'viewer' }
    await post()
    expect(events[0]).toBe('enterWithOrg:org-1')
  })
})

describe('GET', () => {
  test('it returns the versions under an ok envelope', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; versions: Array<{ version: number }> }
    expect(body.ok).toBe(true)
    expect(body.versions.map((v) => v.version)).toEqual([3, 2, 1])
  })

  test('it passes the path id through unchanged', async () => {
    await get('doc-with-dashes-123')
    expect(listArgs).toEqual(['doc-with-dashes-123'])
  })

  test('an EMPTY history is 200 with an empty list, not a 404', async () => {
    // A document that has never been snapshotted is not an error; the UI renders "no versions yet".
    versions = []
    const res = await get()
    expect(res.status).toBe(200)
    expect(((await res.json()) as { versions: unknown[] }).versions).toEqual([])
  })

  test('the ORDER the library returns is preserved, not re-sorted by the route', async () => {
    // `listDocVersions` orders by version desc. If the route re-sorted ascending, a UI showing "latest first"
    // would silently invert.
    versions = [
      { id: 'v1', version: 1 },
      { id: 'v9', version: 9 },
    ]
    const res = await get()
    expect(((await res.json()) as { versions: Array<{ version: number }> }).versions.map((v) => v.version))
      .toEqual([1, 9])
  })

  test('a library failure is 500 without leaking the library error text', async () => {
    listThrows = new Error('connection reset on documentVersion')
    const res = await get()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('a failed list writes NO audit row', async () => {
    listThrows = new Error('boom')
    await get()
    expect(auditWrites).toHaveLength(0)
  })

  test('an unauthenticated GET is 500 through the handler (the error boundary owns auth failures)', async () => {
    // Documented: `getActiveUser()` throws and this route has no separate auth branch, so an expired session
    // surfaces via handleApiError. The response is a typed error, never a partial version list.
    user = null as unknown as typeof adminUser
    const res = await get()
    expect(res.status).toBe(500)
    expect((await res.json()) as { versions?: unknown }).not.toHaveProperty('versions')
  })
})

describe('POST', () => {
  test('it answers 201 with the created snapshot', async () => {
    const res = await post()
    expect(res.status).toBe(201)
    const body = (await res.json()) as { ok: boolean; version: { version: number } }
    expect(body.ok).toBe(true)
    expect(body.version.version).toBe(4)
  })

  test('it passes the path id through unchanged', async () => {
    await post('doc-42')
    expect(createArgs).toEqual(['doc-42'])
  })

  test('the audit records the NEW version number and the document id', async () => {
    // Pins that the route reports the version it actually created. `detail: { documentId: id, version:
    // snapshot.version }` -- a swap of the two would otherwise be invisible.
    await post()
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'DOC_VERSION_CREATE',
      severity: 'info',
      detail: { documentId: 'd1', version: 4 },
    })
  })

  test('the audit is INFO, not warning (a snapshot is not a destructive act)', async () => {
    await post()
    expect((auditWrites[0]!.severity as string)).toBe('info')
  })

  test('a MISSING document is 500 through the handler, and no version row is audited', async () => {
    // `createDocVersion` throws `Document not found`. Pinned as the CURRENT behaviour, and noted as the reason
    // it is not a 404: the route never loads the document, so it cannot distinguish "missing" from "the
    // library failed". A 404 here would require the route to do its own lookup.
    createThrows = new Error('Document not found: d1')
    const res = await post()
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })

  test('a failure does NOT write an audit row claiming a version was created', async () => {
    // The dangerous alternative: auditing before the create succeeds would leave a trail of version rows that
    // do not exist.
    createThrows = new Error('hash failure')
    await post()
    expect(events).toEqual(['enterWithOrg:org-1', 'createDocVersion'])
  })

  test('the snapshot is returned WHOLE, not a hand-picked subset', async () => {
    // The response shape matters to the UI (hash + chunkCount are displayed). Asserted as an exact match so a
    // narrowing of the response has to be deliberate.
    snapshot = {
      id: 'vX',
      documentId: 'd1',
      version: 7,
      contentHash: 'fff',
      chunkCount: 12,
      createdAt: new Date('2026-05-01'),
    }
    const res = await post()
    const body = (await res.json()) as { version: Record<string, unknown> }
    expect(Object.keys(body.version).sort()).toEqual([
      'chunkCount',
      'contentHash',
      'createdAt',
      'documentId',
      'id',
      'version',
    ])
  })

  test('a repeated POST takes a SECOND snapshot rather than being idempotent', async () => {
    // No de-duplication: two calls take two versions. Recorded by assertion because "POST creates" is the
    // contract, and a future idempotency key would break it visibly.
    await post()
    await post()
    expect(createArgs).toEqual(['d1', 'd1'])
    expect(auditWrites).toHaveLength(2)
  })

  test('the audit uses the acting user, not a hardcoded id', async () => {
    user = { ...adminUser, userId: 'u-other' }
    await post()
    expect(auditWrites[0]!.userId).toBe('u-other')
  })
})

describe('the two handlers do not share state', () => {
  test('GET does not create a version and POST does not list one', async () => {
    await get()
    expect(createArgs).toHaveLength(0)
    await post()
    expect(listArgs).toEqual(['d1'])
  })
})
