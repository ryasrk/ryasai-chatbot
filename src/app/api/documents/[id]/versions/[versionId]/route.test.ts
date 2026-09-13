/**
 * POST /api/documents/[id]/versions/[versionId] — restore a document to a snapshot.
 *
 * WHY THIS FILE EXISTS. The route is a three-line shell over `restoreDocVersion`, so almost all of its own
 * surface is the seam: it must establish org context before the library call, must pass BOTH path ids
 * through verbatim, and must audit the restore with `restoredTo` = the version actually restored to.
 *
 * Two things beyond the plumbing are worth pinning:
 *
 *   1. THE ROUTE DOES NOT LOAD OR OWNERSHIP-CHECK ANYTHING. It hands both ids straight to the library. That
 *      is safe only because `restoreDocVersion`'s version lookup is a `findFirst({id, documentId})` -- which
 *      the Prisma tenant extension org-scopes -- and because the ROUTE establishes the org context first. If
 *      the route stopped calling `enterWithOrg`, the extension would inject no organizationId and the
 *      documentVersion lookup would resolve across tenants.
 *   2. THE LIBRARY'S `document.findUnique` IS THE ONE UN-SCOPED READ IN THE PATH. `findUnique` cannot carry
 *      an organizationId term, so when a caller supplies a `documentId` owned by another org the lookup
 *      still returns that row and the restore re-points the version of a foreign document. The route's
 *      guard is exactly the `findFirst` in front of it. Pinned statically (readFileSync on the library and
 *      the route) so that fixing the findUnique to findFirst turns these tests RED.
 *
 * The library is mocked (its behaviour is covered by doc-versioning's own tests); the DEFECT assertions read
 * the REAL sources from disk, so they survive the mock.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

let restoreResult: { version: number; restored: boolean } = { version: 3, restored: true }
let restoreThrows: Error | null = null

/** Order of side effects — the route owns "context, then restore, then audit". */
const events: string[] = []
const restoreArgs: Array<[string, string]> = []
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
  restoreDocVersion: async (documentId: string, versionId: string) => {
    restoreArgs.push([documentId, versionId])
    events.push('restoreDocVersion')
    if (restoreThrows) throw restoreThrows
    return restoreResult
  },
}))

const { POST } = await import('./route')

const ctx = (id = 'd1', versionId = 'v1') => ({ params: Promise.resolve({ id, versionId }) })

function post(id = 'd1', versionId = 'v1') {
  const url = `http://localhost/api/documents/${id}/versions/${versionId}`
  const r = new Request(url, { method: 'POST' }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return POST(r as never, ctx(id, versionId))
}

async function readBody(res: Response): Promise<Record<string, any>> {
  const t = await res.text()
  return JSON.parse(t)
}

beforeEach(() => {
  user = adminUser
  restoreResult = { version: 3, restored: true }
  restoreThrows = null
  events.length = 0
  restoreArgs.length = 0
  auditWrites.length = 0
})

describe('org context and effect order', () => {
  test('POST enters the session org BEFORE calling the library, and audits after', async () => {
    // The version lookup inside the library is org-scoped by the extension, which only injects when a
    // context exists. A context entered after the query would be useless.
    await post()
    expect(events).toEqual(['enterWithOrg:org-1', 'restoreDocVersion', 'audit'])
  })

  test('the org entered is the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-tenant-B' }
    await post()
    expect(events[0]).toBe('enterWithOrg:org-tenant-B')
  })

  test('an unauthenticated caller never reaches the library or the org context', async () => {
    user = null as unknown as typeof adminUser
    await post()
    expect(restoreArgs).toHaveLength(0)
    expect(events).toEqual([])
  })
})

describe('success path', () => {
  test('it answers 200 with ok true and the library result spread in', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({ ok: true, version: 3, restored: true })
  })

  test('it passes BOTH path ids through verbatim and in order', async () => {
    // `restoreDocVersion(documentId, versionId)` — a swap of the two arguments would restore the wrong
    // document (or throw "Version not found"), and the route is the only place that ordering is decided.
    await post('doc-a', 'ver-9')
    expect(restoreArgs).toEqual([['doc-a', 'ver-9']])
  })

  test('an id with slashes and dashes is forwarded unchanged', async () => {
    await post('doc/with-dash_1', 'v/2')
    expect(restoreArgs[0]).toEqual(['doc/with-dash_1', 'v/2'])
  })

  test('restored:false (file gone from disk) is still a 200 success', async () => {
    // The library updates the version pointer even when the original upload is missing. A 200 here is the
    // contract: the version moved, only the re-embed did not happen. The UI reports `restored` itself.
    restoreResult = { version: 5, restored: false }
    const res = await post()
    expect(res.status).toBe(200)
    expect(await readBody(res)).toEqual({ ok: true, version: 5, restored: false })
  })
})

describe('audit', () => {
  test('the audit records the version restored TO, the document and the flag', async () => {
    await post('d7', 'vX')
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'DOC_VERSION_RESTORE',
      severity: 'warning',
      detail: { documentId: 'd7', versionId: 'vX', restoredTo: 3, restored: true },
    })
  })

  test('the audit severity is WARNING (a restore overwrites live content)', async () => {
    await post()
    expect(auditWrites[0]!.severity).toBe('warning')
  })

  test('restoredTo comes from the RESULT version, not the requested versionId', async () => {
    // The path carries a version ROW id ("vX"); the audit must record the numeric version that became live.
    // Recording `versionId` would misreport the restore target as a cuid.
    restoreResult = { version: 12, restored: true }
    await post('d1', 'some-cuid')
    const detail = auditWrites[0]!.detail as Record<string, unknown>
    expect(detail.restoredTo).toBe(12)
    expect(detail.versionId).toBe('some-cuid')
  })

  test('a library failure writes NO audit row at all', async () => {
    restoreThrows = new Error('Version not found: v9')
    await post()
    expect(auditWrites).toHaveLength(0)
    expect(events).toEqual(['enterWithOrg:org-1', 'restoreDocVersion'])
  })

  test('two restores write two audit rows (no de-duplication)', async () => {
    await post()
    await post()
    expect(auditWrites).toHaveLength(2)
    expect(restoreArgs).toEqual([['d1', 'v1'], ['d1', 'v1']])
  })
})

describe('failure mapping', () => {
  test('a missing version is 500 through the handler, not a 404', async () => {
    // The route never loads the version, so it cannot tell "not found" from "the library broke". Pinned as
    // the CURRENT behaviour: the library throws a plain Error and handleApiError maps it to the fallback.
    restoreThrows = new Error('Version not found: v9')
    const res = await post()
    expect(res.status).toBe(500)
  })

  test('the library error text is NOT leaked to the client', async () => {
    restoreThrows = new Error('Document not found: secret-doc-in-org-B')
    const res = await post()
    const body = await readBody(res)
    expect(JSON.stringify(body)).not.toContain('org-B')
  })

  test('a half-applied restore (chunk re-embed failure) is reported as ok because the library swallows it', async () => {
    // The library catches its own uploadPath errors and returns restored:false. The route therefore reports
    // success for a version that moved but whose content was NOT re-embedded. Recorded by assertion: the UI
    // must read `restored` to warn the user, and the route does not add its own signal.
    restoreResult = { version: 2, restored: false }
    const res = await post()
    expect((await readBody(res)).ok).toBe(true)
  })
})

describe('DEFECT — the library read behind this route is not org-scoped', () => {
  // INVERT WHEN FIXED
  //
  // `src/lib/doc-versioning.ts` loads the target document with `db.document.findUnique({ where: { id } })`.
  // The tenant extension SKIPS findUnique (Prisma's unique where rejects extra fields), so no organizationId
  // is injected. `documentId` is a client-supplied path segment, so a user in org A who knows/guesses a
  // document id in org B gets that document's row back: the lookup succeeds where it should be null.
  //
  // USER IMPACT: the version pointer of a FOREIGN document is moved (`document.update({ data: { version } })`),
  // and when the foreign document has an uploadPath the handler re-reads its file, deletes its chunks and
  // re-embeds them — a cross-tenant destructive write driven by a path segment. The version lookup in front
  // of it IS scoped, so the attacker still needs a version row id belonging to that document; the id
  // enumeration surface is what makes this reachable.
  //
  // FIXED: the load is now `findFirst({ where: { id: documentId } })`, so the tenant extension injects
  // organizationId and a foreign document id can no longer reach the destructive re-embed below. This test used to
  // PIN the defect; it is inverted so a regression back to `findUnique` turns it red.
  test('FIXED: the document load uses findFirst, which the tenant extension DOES scope', () => {
    const src = readFileSync(join(import.meta.dir, '../../../../../../lib/doc-versioning.ts'), 'utf-8')
    // The read is scoped...
    expect(src).toMatch(/restoreDocVersion[\s\S]*db\.document\.findFirst/)
    // ...and the unscoped form is gone from the whole file, so no other caller can reintroduce it quietly.
    expect(src).not.toContain('db.document.findUnique')
  })

  test('the route delegates ownership checking entirely to the library, it does no read of its own', () => {
    // Documents why the defect above is not caught by the route: the route imports no db at all.
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf-8')
    expect(src).not.toContain("from '@/lib/db'")
    expect(src).toContain('restoreDocVersion(id, versionId)')
  })

  test('the route DOES scope its own context, so the defect is the library query and not a missing ritual', () => {
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf-8')
    expect(src).toContain('enterWithOrg(user.organizationId)')
  })
})

describe('the WHOLE doc-versioning module is org-scoped, not just the restored path', () => {
  // A regression in ONE function is enough to reopen the hole, so the module is checked as a whole rather than
  // per-function. `createDocVersion` was a SECOND occurrence of the same mistake, found only because this
  // assertion is file-wide.
  test('no `db.document.findUnique` remains anywhere in the module', () => {
    const src = readFileSync(join(import.meta.dir, '../../../../../../lib/doc-versioning.ts'), 'utf-8')
    expect(src).not.toContain('db.document.findUnique')
    // Both readers use the scoped operation, so a fix that only patched one is caught here.
    expect((src.match(/db\.document\.findFirst/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })

  test('every function that takes a client-supplied document id reads it through findFirst', () => {
    const src = readFileSync(join(import.meta.dir, '../../../../../../lib/doc-versioning.ts'), 'utf-8')
    for (const fn of ['createDocVersion', 'restoreDocVersion', 'listDocVersions']) {
      const body = src.slice(src.indexOf(`export async function ${fn}`))
      const next = body.indexOf('\nexport ', 10)
      const scoped = next === -1 ? body : body.slice(0, next)
      // The document ROW itself is never loaded by unique id; a scoped read (or none at all) is the contract.
      expect(scoped).not.toContain('db.document.findUnique')
    }
  })
})
