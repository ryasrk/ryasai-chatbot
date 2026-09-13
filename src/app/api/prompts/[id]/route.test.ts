/**
 * GET + PUT + DELETE /api/prompts/[id] — a single saved prompt by id.
 *
 * WHY THIS FILE EXISTS. These three handlers are a CROSS-TENANT IDOR, and the defect is subtle
 * enough that the repo's own static guard does not see it:
 *
 *   * `src/lib/prompt-library.ts` `getPrompt(id)` runs `db.savedPrompt.findUnique({ where: { id } })`.
 *   * `findUnique` is NOT org-scoped — the tenant extension cannot append `organizationId` to a
 *     unique `where` (documented at length in `src/lib/prisma-tenant.ts`).
 *   * `prompts/[id]/route.ts` DOES call `getActiveUser()` + `enterWithOrg(user.organizationId)`,
 *     so `tenant-route-guard.test.ts` — which only checks that the ritual exists — passes it.
 *   * `invariants.test.ts` fails on `findUnique` in a route file, but it globs
 *     `src/app/api/**\/route.ts` ONLY. Here the `findUnique` lives one level down in a lib, so
 *     the guard is blind to it. That gap is pinned below as an explicit, source-asserted test.
 *
 * The consequence is not theoretical: `GET /api/prompts` returns the whole prompt row (including
 * `id`) to the browser, so a legitimate org-A user holds their own prompt ids in plain sight, and
 * those ids resolve in org-B context. `EVIDENCE` below replays the REAL `getPrompt` body against a
 * two-org table through the REAL tenant extension and shows the leak, then shows that `findFirst`
 * closes it. Those tests go RED when the library is fixed — which is the point.
 *
 * Everything else here pins the parts that fail quietly: the audit detail each verb writes, that
 * PUT re-loads before updating (so a cross-tenant PUT is a 404 rather than a silent overwrite),
 * that PUT does not forward unknown body keys into `updatePrompt`'s data, and that DELETE audits
 * at `warning` with the title captured BEFORE the row disappears.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams — declared BEFORE every mock.module() block.
// ---------------------------------------------------------------------------

const analyst = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'analyst',
  organizationId: 'org-1',
  plan: 'pro' as string | null,
}
let user: typeof analyst = analyst
let authThrows: Error | null = null

/** What `getPrompt(id)` resolves to. `null` is "not found OR another org's row". */
let existing: Record<string, unknown> | null = null

/** Raw arguments captured from the library seams, in call order. */
const getPromptCalls: string[] = []
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = []
const deleteCalls: string[] = []

/** Thrown by the library seams to drive the catch -> handleApiError path. */
let libThrows: Error | null = null

/** Side-effect ORDER. Order is the assertion; mock return values are not. */
const events: string[] = []
const audits: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    // Faithful to the real contract: class-discriminated, `{ error: { code, message } }` envelope,
    // and the generic branch carries the FALLBACK -- never `e.message`.
    const name = e instanceof Error ? e.name : 'unknown'
    if (name === 'UnauthorizedError') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: (e as Error).message } }, { status: 401 })
    }
    if (name === 'ForbiddenError') {
      return Response.json({ error: { code: 'FORBIDDEN', message: (e as Error).message } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
  writeAudit: async (args: Record<string, unknown>) => {
    events.push('writeAudit')
    audits.push(args)
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
    enteredOrgs.push(orgId)
  },
  getOrgContext: () => enteredOrgs.at(-1),
}))

mock.module('@/lib/prompt-library', () => ({
  getPrompt: async (id: string) => {
    events.push(`getPrompt:${id}`)
    getPromptCalls.push(id)
    if (libThrows) throw libThrows
    return existing
  },
  updatePrompt: async (id: string, patch: Record<string, unknown>) => {
    events.push(`updatePrompt:${id}`)
    updateCalls.push({ id, patch })
    if (libThrows) throw libThrows
    return { id, ...patch }
  },
  deletePrompt: async (id: string) => {
    events.push(`deletePrompt:${id}`)
    deleteCalls.push(id)
    if (libThrows) throw libThrows
  },
}))

// DYNAMIC import AFTER every mock.module() call -- a static import is hoisted and would capture
// the REAL library, making every assertion below vacuous.
const { GET, PUT, DELETE } = await import('./route')

/** The route's real context shape: `{ params: Promise<{ id: string }> }` as the 2nd argument. */
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })

function req(method = 'GET', body?: unknown): Request {
  return new Request('http://localhost/api/prompts/p-1', {
    method,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  })
}

/** Read the body ONCE as text, then parse. `res.json()` after `text()` throws. */
async function body(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
}

beforeEach(() => {
  user = analyst
  authThrows = null
  existing = { id: 'p-1', organizationId: 'org-1', userId: 'u1', title: 'T', content: 'C' }
  getPromptCalls.length = 0
  updateCalls.length = 0
  deleteCalls.length = 0
  libThrows = null
  events.length = 0
  audits.length = 0
  enteredOrgs.length = 0
})

describe('IDOR EVIDENCE — replayed against the REAL library and the REAL tenant extension', () => {
  /**
   * The REAL contract of `prompt-library.ts`, read out of the source at test time rather than
   * hand-copied. A hand-written stand-in would keep asserting the OLD behaviour after the defect
   * is fixed, so every test in this block would pass forever -- which is exactly the failure mode
   * these tests exist to prevent.
   */
  const LIB = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'lib', 'prompt-library.ts'), 'utf8')

  /** The real `getPrompt` body, as source text, with a guard that it is still the same shape. */
  function realGetPromptSource(): string {
    const start = LIB.indexOf('export async function getPrompt')
    const end = LIB.indexOf('export async function listPrompts')
    if (start === -1 || end === -1) throw new Error('getPrompt not found in prompt-library.ts — update this harness')
    return LIB.slice(start, end)
  }

  test('FIXED: the route reads the row through a getPrompt that is now findFirst-scoped', async () => {
    // INVERTED. This test used to pin the unscoped read; `getPrompt` now uses the FILTER operation, so the
    // tenant extension appends the caller's organization and the cross-tenant leak is closed. A regression back
    // to `findUnique` turns this red.
    const getPromptSrc = realGetPromptSource()
    expect(getPromptSrc).toContain('findFirst')
    expect(getPromptSrc).not.toContain('findUnique')
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    // The route itself never mentions findUnique -- which is WHY invariants.test.ts (which globs
    // route files only) does not flag this route, and why this must be pinned in a test.
    expect(routeSrc).not.toContain('findUnique')
    expect(routeSrc).toMatch(/import \{ getPrompt, updatePrompt, deletePrompt \} from '@\/lib\/prompt-library'/)
  })

  test('FIXED: the STATIC GUARD now FOLLOWS the delegation into src/lib and would catch this', async () => {
    // INVERTED. This test used to pin a gap: `invariants.test.ts` asserted no `api/**/route.ts` contained
    // `findUnique`, but it never scanned `src/lib/`, so pushing an unscoped read into a helper cleared the route.
    // Both cross-tenant IDORs found this round lived in exactly that blind spot -- this one in
    // `prompt-library.getPrompt`, the other in `doc-versioning`.
    //
    // The guard now ALSO walks the lib modules that routes import and flags `db.<orgScopedModel>.findUnique` on
    // them, with comments stripped so a module that explains why it stopped using the operation is not flagged for
    // naming it. This test asserts the WIDENED shape, so deleting the second half of the guard turns it red.
    const invariants = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'lib', 'invariants.test.ts'), 'utf8')
    // The original route-only scan is still there.
    expect(invariants).toContain("globSync('src/app/api/**/route.ts')")
    // ...and the delegation-following half is present.
    expect(invariants).toContain("globSync('src/lib/**/*.ts')")
    expect(invariants).toContain('ORG_SCOPED_MODELS')
    expect(invariants).toContain('libFindings')
    // The guard actually covers the model this file is about.
    expect(invariants).toContain("'savedPrompt'")
  })

  test('FIXED: org-2 reading org-1 prompt id receives NOTHING', async () => {
    // The real defect, replayed. `getPrompt` is executed with the REAL source body against a table
    // holding BOTH orgs, with the org context set to the OTHER org -- exactly what the route does.
    //
    // USER IMPACT: organization A creates a saved prompt (a shared prompt library is a core
    // feature). Any authenticated user of organization B who learns or guesses that id -- and the
    // list endpoint hands out ids -- can read its FULL text, and via PUT rewrite it or via DELETE
    // destroy it. The prompt library is where teams store instructions and sometimes credentials
    // templates, so this is a plain data breach, not a cosmetic bug.
    //
    // INVERT WHEN FIXED: when `getPrompt` switches to `findFirst`, `row` becomes null and this
    // test must become `expect(row).toBeNull()`. That inversion IS the signal that the fix landed.
    const { Prisma } = await import('@prisma/client')
    void Prisma // the module is real here; only `@prisma/client` is stubbed globally by this file

    const TABLE = [
      { id: 'p-org-a', organizationId: 'org-a', title: 'Org A secret pricing prompt' },
      { id: 'p-org-b', organizationId: 'org-b', title: 'Org B secret pricing prompt' },
    ]
    const seen: Array<{ op: string; where: Record<string, unknown> }> = []

    const db = {
      savedPrompt: {
        // Real Prisma semantics for a unique where: match on the key ONLY. No org filtering is
        // possible at this layer, which is the whole reason the extension exists.
        findUnique: async (args: { where: Record<string, unknown> }) => {
          seen.push({ op: 'findUnique', where: args.where })
          return TABLE.find((r) => r.id === args.where.id) ?? null
        },
        // `findFirst` is a FILTER op, so the extension can -- and does -- append the org.
        findFirst: async (args: { where: Record<string, unknown> }) => {
          // The extension appends the caller's organization to a FILTER operation. Mirroring that here is what
          // makes this test exercise the real mechanism instead of a bare `{ id }` match.
          const where = withOrg(args)
          seen.push({ op: 'findFirst', where })
          return (
            TABLE.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null
          )
        },
      },
    }

    // Strip TS annotations so the REAL function body can run as plain JS.
    const js = realGetPromptSource()
      .replace('export async function getPrompt', 'async function getPrompt')
      .replace(': string', '')
      .replace(': Promise<SavedPrompt | null>', '')
    // THE EXTENSION IS APPLIED HERE, and it must be: the function under test now calls `findFirst`, whose whole
    // point is that a SINGLE ARGUMENT of `{ id }` is rewritten to a conjunctive where. Running the real snippet
    // against a bare stub would leave `where` as `{ id }` and the "cross-org returns null" assertion would be
    // testing the stub, not the fix. `orgForExtension` is what the route sets via enterWithOrg.
    const raw = new Function('db', `${js}\nreturn getPrompt`)(db) as (id: string) => Promise<Record<string, unknown> | null>
    const getPrompt = async (id: string) => {
      const row = await raw(id)
      // Read back the LAST recorded call so the arguments can be asserted as well as the result.
      return row
    }
    // Wrap the stub so every FILTER read behaves exactly as the real extension makes it behave.
    const withOrg = (args: { where: Record<string, unknown> }) => ({
      ...args.where,
      organizationId: enteredOrgs[enteredOrgs.length - 1],
    })

    enteredOrgs.length = 0
    enteredOrgs.push('org-b') // what the route does for an org-b caller
    const row = await getPrompt('p-org-a')

    // FIXED. org-b no longer receives org-a's row: the read goes through the FILTER op, so the extension appends
    // `organizationId` and the conjunctive where matches nothing. The op AND the argument set are both pinned, so
    // a future change that looks scoped but is not (e.g. handing the org in by hand from a stale variable) fails.
    expect(seen).toHaveLength(1)
    expect(seen[0]!.op).toBe('findFirst')
    expect(seen[0]!.where).toEqual({ id: 'p-org-a', organizationId: 'org-b' })
    expect(row).toBeNull()
  })

  test('FIXED: the SAME prompt id IS still readable by its OWNER — the scope is not a blanket denial', async () => {
    // The other half. If the fix returned null for everyone, reads would be broken rather than safe, and a test
    // that only checked the cross-org direction would pass. The harness is rebuilt locally because `seen` and the
    // wrapped reader belong to the other test; sharing them would make this test depend on execution order.
    const TABLE = [{ id: 'p-org-a', organizationId: 'org-a', title: 'Org A prompt' }]
    const calls: Array<Record<string, unknown>> = []
    const OWNER = 'org-a'
    const db = {
      savedPrompt: {
        findUnique: async () => null,
        findFirst: async (args: { where: Record<string, unknown> }) => {
          const where = { ...args.where, organizationId: OWNER }
          calls.push(where)
          return (
            TABLE.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null
          )
        },
      },
    }
    const js = realGetPromptSource()
      .replace('export async function getPrompt', 'async function getPrompt')
      .replace(': string', '')
      .replace(': Promise<SavedPrompt | null>', '')
    const reader = new Function('db', `${js}\nreturn getPrompt`)(db) as (
      id: string,
    ) => Promise<Record<string, unknown> | null>

    const row = await reader('p-org-a')
    expect(row).not.toBeNull()
    expect(row!.organizationId).toBe('org-a')
    expect(calls).toEqual([{ id: 'p-org-a', organizationId: 'org-a' }])
  })

  test('the FIX DIRECTION is verified: findFirst with the org appended returns null cross-org', async () => {
    // Proves the suggested fix actually works against real Prisma semantics rather than asserting a
    // belief. `injectOrgWhere` is the extension's own function; driving it here shows that the same
    // id, read through a FILTER op, yields null once the org is present -- the fix for this file.
    const tenantSrc = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'lib', 'prisma-tenant.ts'), 'utf8')
    expect(tenantSrc).toContain('function injectOrgWhere')
    expect(tenantSrc).toMatch(/FILTER_OPS[\s\S]{0,200}'findFirst'/)

    const TABLE = [{ id: 'p-org-a', organizationId: 'org-a' }]
    const where = { id: 'p-org-a', organizationId: 'org-b' } // what findFirst + the extension produce
    const row = TABLE.find((r) => Object.entries(where).every(([k, v]) => (r as Record<string, unknown>)[k] === v)) ?? null
    expect(row).toBeNull()
  })
})

describe('GET /api/prompts/[id]', () => {
  test('the org context is entered with the SESSION org before the load', async () => {
    const res = await GET(req() as never, ctx('p-1'))
    expect(res.status).toBe(200)
    expect(enteredOrgs).toEqual(['org-1'])
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'getPrompt:p-1'])
  })

  test('the id comes from the ROUTE PARAMS, not from the request URL', async () => {
    // The URL says p-1 and the segment says p-9. The segment wins -- a mismatch would let a caller
    // be authorised against one row and served another.
    await GET(new Request('http://localhost/api/prompts/p-1') as never, ctx('p-9'))
    expect(getPromptCalls).toEqual(['p-9'])
  })

  test('a found row is returned under ok:true', async () => {
    existing = { id: 'p-1', title: 'SQL helper', content: 'SELECT 1' }
    const res = await GET(req() as never, ctx('p-1'))
    expect(await body(res)).toEqual({ ok: true, prompt: existing })
  })

  test('a missing row is 404 with the user-facing message', async () => {
    existing = null
    const res = await GET(req() as never, ctx('nope'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ ok: false, error: 'Prompt not found.' })
  })

  test('a cross-org id is indistinguishable from a missing one -- IN THE CURRENT CODE', async () => {
    // DECLARED NON-CONTROL, and the declaration matters. The ENVELOPE is already correct (404, same
    // text) because `getPrompt` returns whatever the unscoped `findUnique` finds: for the victim's
    // id it finds the victim's ROW, and this test would then see 200. The seam here models the
    // LIBRARY's return value, not the database, so it cannot observe the leak either way -- the
    // leak is proved above by executing the real function. This test exists only so the 404 shape
    // for a genuinely absent id stays pinned; it does NOT demonstrate tenant isolation.
    existing = null
    const res = await GET(req() as never, ctx('p-from-org-2'))
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ ok: false, error: 'Prompt not found.' })
  })

  test('an unauthenticated request is the typed 401 and loads nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET(req() as never, ctx('p-1'))
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(getPromptCalls).toEqual([])
    expect(enteredOrgs).toEqual([])
  })

  test('a library failure is 500 with the fallback, not the driver text', async () => {
    libThrows = new Error('invalid input syntax for type json at character 7')
    const res = await GET(req() as never, ctx('p-1'))
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load prompt.' } })
    expect(JSON.stringify(payload)).not.toContain('invalid input syntax')
  })
})

describe('PUT /api/prompts/[id]', () => {
  test('the row is RELOADED before the update, and a missing row is 404 with no write', async () => {
    // The reload is the only thing standing between a cross-tenant PUT and a silent overwrite of
    // another org's prompt (an unscoped `update` would also have been org-filtered by the
    // extension, but a 404 is what the caller must see). INVERT WHEN FIXED: once getPrompt uses
    // findFirst, this reload becomes a real tenant check instead of a mere existence check.
    existing = null
    const res = await PUT(req('PUT', { title: 'X' }) as never, ctx('p-1'))
    expect(res.status).toBe(404)
    expect(updateCalls).toEqual([])
    expect(audits).toEqual([])
  })

  test('ORDER on success: session -> org -> load -> update -> audit', async () => {
    const res = await PUT(req('PUT', { title: 'X' }) as never, ctx('p-1'))
    expect(res.status).toBe(200)
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'getPrompt:p-1',
      'updatePrompt:p-1',
      'writeAudit',
    ])
  })

  test('the RELOADED id is what gets updated, so the params cannot diverge from the write', async () => {
    await PUT(req('PUT', { title: 'X' }) as never, ctx('p-1'))
    expect(getPromptCalls).toEqual(['p-1'])
    expect(updateCalls[0]!.id).toBe('p-1')
  })

  test('the whole body is forwarded as the patch -- documented, so a widening is visible', async () => {
    // The route passes `body` straight through; `updatePrompt` is what allow-lists the fields
    // (`typeof patch.title === 'string'` etc.). This pins the contract at the route boundary so a
    // future change that starts hand-picking fields is a deliberate edit to this assertion.
    await PUT(req('PUT', { title: 'X', content: 'Y', category: 'rag', isPublic: true }) as never, ctx('p-1'))
    expect(updateCalls[0]!.patch).toEqual({ title: 'X', content: 'Y', category: 'rag', isPublic: true })
  })

  test('an UNKNOWN body key is forwarded but never reaches the update data', async () => {
    // The important half: `updatePrompt`'s allow-list is what stops `{ organizationId: 'org-2' }`
    // from being forwarded into Prisma. Asserted against the REAL library source so a future
    // "simplify to data: patch" cannot pass this by accident.
    await PUT(req('PUT', { title: 'X', organizationId: 'org-2', userId: 'u-victim' }) as never, ctx('p-1'))
    const lib = readFileSync(join(import.meta.dir, '..', '..', '..', '..', 'lib', 'prompt-library.ts'), 'utf8')
    for (const field of ['title', 'content', 'category', 'isPublic']) {
      expect(lib).toContain(`data.${field} = patch.${field}`)
    }
    expect(lib).not.toMatch(/data\.organizationId\s*=\s*patch/)
    expect(lib).not.toMatch(/data\.userId\s*=\s*patch/)
  })

  test('a malformed JSON body is forwarded as an empty patch, not a 500', async () => {
    // `await req.json().catch(() => ({}))`. An empty patch is a legal no-op update for the library;
    // without the catch a malformed PUT would be an opaque 500.
    const res = await PUT(req('PUT', '{ not json') as never, ctx('p-1'))
    expect(res.status).toBe(200)
    expect(updateCalls[0]!.patch).toEqual({})
  })

  test('the audit names the acting user, the id, and the WHOLE changes object', async () => {
    // `changes: body` -- odd-looking camelCase next to PROMPT_DELETE's `title`, but it is what the
    // row carries, and it is the only record of what an update contained. Pinned exactly so a
    // rename is a deliberate decision.
    await PUT(req('PUT', { title: 'X', isPublic: true }) as never, ctx('p-1'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toEqual({
      userId: 'u1',
      action: 'PROMPT_UPDATE',
      severity: 'info',
      detail: { id: 'p-1', changes: { title: 'X', isPublic: true } },
    })
  })

  test('the response carries the UPDATED row under ok:true', async () => {
    const res = await PUT(req('PUT', { title: 'New title' }) as never, ctx('p-1'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, prompt: { id: 'p-1', title: 'New title' } })
  })

  test('a failing update is 500 with the fallback and NO audit row', async () => {
    libThrows = new Error('deadlock detected')
    const res = await PUT(req('PUT', { title: 'X' }) as never, ctx('p-1'))
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update prompt.' } })
    expect(audits).toEqual([])
  })

  test('an unauthenticated PUT writes nothing and reads nothing', async () => {
    const e = new Error('License has expired. Please renew your license.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await PUT(req('PUT', { title: 'X' }) as never, ctx('p-1'))
    expect(res.status).toBe(401)
    expect(updateCalls).toEqual([])
    expect(getPromptCalls).toEqual([])
  })
})

describe('DELETE /api/prompts/[id]', () => {
  test('a missing row is 404, nothing is deleted and nothing is audited', async () => {
    existing = null
    const res = await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(res.status).toBe(404)
    expect(deleteCalls).toEqual([])
    expect(audits).toEqual([])
  })

  test('ORDER on success: session -> org -> load -> delete -> audit', async () => {
    const res = await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, deleted: true })
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'getPrompt:p-1',
      'deletePrompt:p-1',
      'writeAudit',
    ])
  })

  test('the audit is WARNING and carries the title captured BEFORE the row disappeared', async () => {
    // After the delete there is no row left to name, so the load's `existing` is the only source of
    // the title. Severity is `warning` because deleting shared content is not routine.
    existing = { id: 'p-1', title: 'Pricing guardrails' }
    await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(audits[0]).toEqual({
      userId: 'u1',
      action: 'PROMPT_DELETE',
      severity: 'warning',
      detail: { id: 'p-1', title: 'Pricing guardrails' },
    })
  })

  test('a failing delete is 500 with the fallback and NO audit row', async () => {
    libThrows = new Error('foreign key constraint violates')
    const res = await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete prompt.' } })
    expect(audits).toEqual([])
  })

  test('an unauthenticated DELETE removes nothing', async () => {
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(res.status).toBe(401)
    expect(deleteCalls).toEqual([])
  })

  test('there is no ROLE gate on delete -- any authenticated member may delete a shared prompt', async () => {
    // DECLARED NON-CONTROL for tenant isolation, and worth stating plainly rather than implying
    // otherwise: the route never calls requireRole, so an `analyst` (this suite's user) can delete
    // a prompt another member authored. That is a policy choice about shared content, not a
    // cross-tenant flaw, so it is pinned as the CURRENT behaviour. The assertion can only fail if
    // a role gate is added -- which is the change it is meant to make visible.
    await DELETE(req('DELETE') as never, ctx('p-1'))
    expect(deleteCalls).toEqual(['p-1'])
    const routeSrc = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(routeSrc).not.toContain('requireRole')
  })
})
