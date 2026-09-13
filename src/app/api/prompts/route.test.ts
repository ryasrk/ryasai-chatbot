/**
 * GET + POST /api/prompts — the saved-prompt library list and create.
 *
 * WHY THIS FILE EXISTS. `src/lib/prisma-tenant.ts` records this route by name among the
 * twenty-four that once ran UNSCOPED: the handler awaited `getActiveUser()` and then queried the
 * DB without `enterWithOrg` in its own frame, because `AsyncLocalStorage.enterWith()` mutates the
 * CALLEE's context and does not propagate back. Every prompt of every organization was readable,
 * and the audit create failed with `organizationId: undefined`.
 *
 * Three more properties are pinned here because they fail quietly rather than loudly:
 *
 *   1. `?mine=true` FILES INTO `userId` AND IS OVERWRITTEN LAST. It comes after `?userId=`, so a
 *      caller cannot ask for `mine=true&userId=someone-else` and get someone else's prompts. The
 *      order of the four `if` statements IS the access-control decision, so it is asserted by
 *      parameter --- not by the returned rows.
 *   2. THE AUDIT NAMES THE ACTING USER AND THE NEW ROW. A prompt library is shared, so provenance
 *      is the only way to tell who added what; and `writeAudit` is NOT awaited by the caller, so
 *      it must have been CALLED before the response resolves.
 *   3. `createPrompt` IS THE ONLY THING THAT STAMPS `organizationId`. It reads `getOrgContext()`
 *      (asserted as `!`). If the route's `enterWithOrg` were removed the create would throw or, with
 *      the store still holding a PREVIOUS request's org in the same async frame, stamp another
 *      tenant's id. Both are proved below against the real extension.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable seams — declared BEFORE every mock.module() block, because mocks are
// installed at module-registration time and read these `let`s on each call.
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

/** Thrown by the session seam to drive the catch -> handleApiError path. */
let authThrows: Error | null = null

/** Raw `listPrompts(filter)` argument, or `undefined` when never called. */
let listFilter: { userId?: string; category?: string; isPublic?: boolean } | undefined

/** Raw `createPrompt(userId, input)` pair, or `undefined` when never called. */
let createArgs: { userId: string; input: Record<string, unknown> } | undefined

/** Thrown by either library seam. */
let libThrows: Error | null = null

/** Rows handed back by `listPrompts`; the CREATED row handed back by `createPrompt`. */
let listRows: Array<Record<string, unknown>> = []
let createdRow: Record<string, unknown> = { id: 'p-1' }

/** Side effect order. Order IS the assertion; return values are not. */
const events: string[] = []
/** Every `writeAudit` argument object. */
const audits: Array<Record<string, unknown>> = []
/** Org ids handed to `enterWithOrg`, in call order. */
const enteredOrgs: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    // Faithful to the real contract's shape -- `{ error: { code, message } }` -- and to its
    // CLASS-based discrimination: the three typed branches are all the route can produce here,
    // and everything else is the generic 500 carrying the fallback string, never `e.message`.
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
  // Real signature. The prompt library calls this to stamp the create, so it must
  // round-trip the value the route entered rather than returning a constant.
  getOrgContext: () => enteredOrgs.at(-1),
}))

mock.module('@/lib/prompt-library', () => ({
  listPrompts: async (filter: { userId?: string; category?: string; isPublic?: boolean }) => {
    events.push('listPrompts')
    listFilter = filter
    if (libThrows) throw libThrows
    return listRows
  },
  createPrompt: async (userId: string, input: Record<string, unknown>) => {
    events.push('createPrompt')
    createArgs = { userId, input }
    if (libThrows) throw libThrows
    return createdRow
  },
}))

// DYNAMIC import, AFTER every mock.module() call. A static import is hoisted and evaluated before
// the mocks install, so the route would capture the REAL library and these tests would assert
// nothing at all.
const { GET, POST } = await import('./route')

/**
 * `Request` has no `nextUrl`; the route reads `req.nextUrl.searchParams`, so it is attached by
 * hand. Setting it on the instance rather than on the prototype cannot leak into another test.
 */
function getReq(query = ''): Request & { nextUrl: URL } {
  const url = `http://localhost/api/prompts${query}`
  const r = new Request(url) as Request & { nextUrl: URL }
  r.nextUrl = new URL(url)
  return r
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/prompts', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
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
  listFilter = undefined
  createArgs = undefined
  libThrows = null
  listRows = []
  createdRow = { id: 'p-1', title: 'T', content: 'C' }
  events.length = 0
  audits.length = 0
  enteredOrgs.length = 0
})

describe('GET /api/prompts — the tenant context is entered before the query', () => {
  test('enterWithOrg runs with the SESSION org, before listPrompts', async () => {
    // `enterWith` does not propagate to the caller's frame, so a route that omits this call runs
    // the read with NO org context -- the extension then injects nothing and the list spans every
    // organization. This route is named in prisma-tenant.ts's header as a production instance.
    await GET(getReq() as never)
    expect(enteredOrgs).toEqual(['org-1'])
    expect(events).toEqual(['getActiveUser', 'enterWithOrg:org-1', 'listPrompts'])
  })

  test('an unauthenticated request yields the typed 401 and runs NO query', async () => {
    // The envelope is `{ error: { code, message } }` -- the classes in session.ts, not a string
    // match. A route that leaked the raw error would show the user a driver message or a 500.
    const e = new Error('No active session.')
    e.name = 'UnauthorizedError'
    authThrows = e
    const res = await GET(getReq() as never)
    expect(res.status).toBe(401)
    expect(await body(res)).toEqual({ error: { code: 'UNAUTHORIZED', message: 'No active session.' } })
    expect(listFilter).toBeUndefined()
    expect(enteredOrgs).toEqual([])
  })

  test('a library failure is the generic 500 carrying the FALLBACK, not the driver text', async () => {
    // handleApiError's last branch ignores `e.message` on purpose: a Prisma error string can carry
    // table and column names. Asserted by pressing the leak, not by trusting it.
    libThrows = new Error('relation "SavedPrompt" does not exist at line 42')
    const res = await GET(getReq() as never)
    expect(res.status).toBe(500)
    const payload = await body(res)
    expect(payload).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list prompts.' } })
    expect(JSON.stringify(payload)).not.toContain('SavedPrompt')
  })
})

describe('GET /api/prompts — which filters reach the library', () => {
  test('no query string means NO filter at all (the tenant extension is the only scoping)', async () => {
    // Every field absent: the route must pass `{}` rather than a hand-written `organizationId`,
    // which would double-filter and silently hide rows the moment the extension changed.
    await GET(getReq() as never)
    expect(listFilter).toEqual({})
  })

  test('mine=true filters on the SESSION user id', async () => {
    await GET(getReq('?mine=true') as never)
    expect(listFilter).toEqual({ userId: 'u1' })
  })

  test('mine=true WINS over an explicit userId -- the four branches are ordered, not merged', async () => {
    // The load-bearing one. `if (sp.get('userId'))` runs at line 12 and `if (sp.get('mine'))` at
    // line 15, so the session identity overwrites whatever the caller asked for. Reorder them and
    // `?mine=true&userId=<another-user>` returns that other user's prompts -- a horizontal
    // privilege escalation inside the tenant, invisible in the response shape.
    const res = await GET(getReq('?mine=true&userId=u-from-another-team') as never)
    expect(res.status).toBe(200)
    expect(listFilter).toEqual({ userId: 'u1' })
    expect(listFilter!.userId).not.toBe('u-from-another-team')
  })

  test('an explicit userId is honoured when mine is absent', async () => {
    // The complement: filtering by colleague is a feature, so the branch must still exist.
    await GET(getReq('?userId=u2') as never)
    expect(listFilter).toEqual({ userId: 'u2' })
  })

  test('mine=false is NOT mine -- only the literal true selects the branch', async () => {
    // `=== 'true'`. A truthy check would make `?mine=false` mean "only mine", which is the exact
    // opposite of what the caller typed.
    await GET(getReq('?mine=false&userId=u2') as never)
    expect(listFilter).toEqual({ userId: 'u2' })
  })

  test('isPublic is only applied for the literal true, and only as a real boolean', async () => {
    // `typeof filter.isPublic === 'boolean'` in the library means an undefined value is dropped and
    // a `false` is KEPT. Passing the string 'false' through would be truthy at the DB and return
    // public prompts to a caller who asked for private ones.
    await GET(getReq('?isPublic=true') as never)
    expect(listFilter).toEqual({ isPublic: true })
    await GET(getReq('?isPublic=false') as never)
    expect(listFilter).toEqual({})
  })

  test('category passes through verbatim, including an empty value', async () => {
    await GET(getReq('?category=sql') as never)
    expect(listFilter).toEqual({ category: 'sql' })
    await GET(getReq('?category=') as never)
    // Empty string is falsy in the route, so it is treated as absent -- and the library's own
    // `if (filter.category)` would drop it anyway.
    expect(listFilter).toEqual({})
  })

  test('all three filters compose into one object', async () => {
    await GET(getReq('?category=sql&isPublic=true&mine=true') as never)
    expect(listFilter).toEqual({ category: 'sql', isPublic: true, userId: 'u1' })
  })

  test('the response is the library rows under ok:true', async () => {
    listRows = [{ id: 'p-1', title: 'SQL helper' }, { id: 'p-2', title: 'Summariser' }]
    const res = await GET(getReq() as never)
    expect(res.status).toBe(200)
    const payload = await body(res)
    expect(payload.ok).toBe(true)
    expect(payload.prompts).toEqual(listRows)
  })

  test('an empty library returns an empty ARRAY, not null', async () => {
    // The view does `Array.isArray(j.prompts)` before setting state; a `null` here would leave the
    // previous list on screen after the last prompt was deleted.
    const res = await GET(getReq() as never)
    expect((await body(res)).prompts).toEqual([])
  })
})

describe('POST /api/prompts — validation happens before any write', () => {
  test('a missing title is 400 and createPrompt is never reached', async () => {
    const res = await POST(postReq({ content: 'body' }) as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Title is required.' })
    expect(createArgs).toBeUndefined()
    expect(audits).toEqual([])
  })

  test('a whitespace-only title is rejected, not stored as whitespace', async () => {
    // `(body.title ?? '').trim()` then `if (!title)`. Without the trim a row titled "   " enters the
    // library and is unfindable in the UI.
    const res = await POST(postReq({ title: '   ', content: 'body' }) as never)
    expect(res.status).toBe(400)
    expect(createArgs).toBeUndefined()
  })

  test('a missing content is 400 and createPrompt is never reached', async () => {
    const res = await POST(postReq({ title: 'T' }) as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Content is required.' })
    expect(createArgs).toBeUndefined()
  })

  test('a whitespace-only content is rejected', async () => {
    const res = await POST(postReq({ title: 'T', content: '\n\t ' }) as never)
    expect(res.status).toBe(400)
    expect(createArgs).toBeUndefined()
  })

  test('an unparseable body is treated as an EMPTY body, not as a 500', async () => {
    // `await req.json().catch(() => ({}))`. The title branch then reports the validation problem the
    // client can actually act on; without the catch a malformed POST would be an opaque 500.
    const res = await POST(postReq('}{ not json') as never)
    expect(res.status).toBe(400)
    expect(await body(res)).toEqual({ ok: false, error: 'Title is required.' })
  })
})

describe('POST /api/prompts — the create and the audit trail', () => {
  test('the created row is authored by the SESSION user, not by the request body', async () => {
    // `createPrompt(user.userId, ...)` -- the body has no `userId` field in its type at all, and
    // ignoring one is what stops a caller from planting a prompt under another author.
    createdRow = { id: 'p-9', title: 'Mine' }
    const res = await POST(postReq({ title: ' Mine ', content: ' body ', userId: 'u-victim', organizationId: 'org-2' }) as never)
    expect(res.status).toBe(201)
    expect(createArgs!.userId).toBe('u1')
    expect(createArgs!.input).not.toHaveProperty('userId')
    expect(createArgs!.input).not.toHaveProperty('organizationId')
  })

  test('title and content are TRIMMED before they reach the library', async () => {
    await POST(postReq({ title: '  Spaced title  ', content: '  Spaced body  ' }) as never)
    expect(createArgs!.input.title).toBe('Spaced title')
    expect(createArgs!.input.content).toBe('Spaced body')
  })

  test('optional fields are forwarded as given so the LIBRARY applies its defaults', async () => {
    // `category` defaults to 'general' and `isPublic` to false inside prompt-library.ts. Sending a
    // filler value from the route would override a default the library owns.
    await POST(postReq({ title: 'T', content: 'C' }) as never)
    expect(createArgs!.input.category).toBeUndefined()
    expect(createArgs!.input.isPublic).toBeUndefined()

    await POST(postReq({ title: 'T', content: 'C', category: 'rag', isPublic: true }) as never)
    expect(createArgs!.input.category).toBe('rag')
    expect(createArgs!.input.isPublic).toBe(true)
  })

  test('ORDER: session -> org -> create -> audit, and the audit names the row', async () => {
    // The audit is deliberately NOT awaited by the route, so it must have been CALLED before the
    // response resolves. Its `detail.id` and `detail.title` are what let an operator answer "who
    // added this prompt and what was it called" after a rename.
    createdRow = { id: 'p-77', title: 'Renamed later' }
    const res = await POST(postReq({ title: 'Original', content: 'C' }) as never)
    expect(res.status).toBe(201)
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'createPrompt',
      'writeAudit',
    ])
    expect(audits[0]).toEqual({
      userId: 'u1',
      action: 'PROMPT_CREATE',
      severity: 'info',
      detail: { id: 'p-77', title: 'Original' },
    })
  })

  test('the 201 carries ok:true and the created row', async () => {
    createdRow = { id: 'p-3', title: 'T', content: 'C', category: 'general', isPublic: false }
    const res = await POST(postReq({ title: 'T', content: 'C' }) as never)
    expect(res.status).toBe(201)
    expect(await body(res)).toEqual({ ok: true, prompt: createdRow })
  })

  test('a library failure is 500 with the fallback and NO audit row', async () => {
    // Writing a PROMPT_CREATE audit for a create that threw would leave the log claiming a prompt
    // exists when it does not.
    libThrows = new Error('deadlock detected')
    const res = await POST(postReq({ title: 'T', content: 'C' }) as never)
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create prompt.' } })
    expect(audits).toEqual([])
  })

  test('a session failure is 401 before the body is even validated', async () => {
    const e = new Error('License has expired. Please renew your license.')
    e.name = 'LicenseError'
    authThrows = e
    const res = await POST(postReq({ title: 'T', content: 'C' }) as never)
    expect(res.status).toBe(500)
    // handleApiError's LicenseError branch is 402; this seam only models the generic branch, so the
    // point of the test is that NO write happened and the session gate ran FIRST.
    expect(createArgs).toBeUndefined()
    expect(audits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DEFECT — cross-tenant read/write on the `[id]` handlers of the sibling file
// ---------------------------------------------------------------------------
//
// This file covers `/api/prompts`, not `/api/prompts/[id]`; the sibling test file pins the IDOR.
// What is proved HERE is the half that looks correct and is not sufficient: `createPrompt` is the
// only function that stamps `organizationId`, and it does so from the AsyncLocalStorage store.
// These two tests read the REAL sources and drive the REAL tenant extension, so they go red if the
// library's contract changes -- a hand-written expectation would keep passing forever.

describe('the org stamp is the library contract, checked against the REAL sources', () => {
  test('prompt-library.ts stamps the org on create and scopes EVERY read', async () => {
    // STATIC EVIDENCE. `getOrgContext()!` is what makes a forgotten `enterWithOrg` a THROW
    // (`organizationId: undefined` fails Prisma validation) rather than a silent cross-tenant row.
    // If this becomes a parameter or a fallback, the failure mode changes shape and this test is
    // meant to notice.
    //
    // Path depth: this file sits at src/app/api/prompts/, so `src/lib` is THREE levels up
    // (prompts -> api -> app -> src). Four would land on the repo root.
    const lib = readFileSync(join(import.meta.dir, '..', '..', '..', 'lib', 'prompt-library.ts'), 'utf8')
    expect(lib).toContain('organizationId: getOrgContext()!')
    expect(lib).toMatch(/export async function listPrompts\([\s\S]{0,400}?db\.savedPrompt\.findMany/)
    // INVERTED. The single-row read used to be the ONE unscoped read in this library (`findUnique`), which is what
    // the sibling [id] test file pinned as a cross-tenant IDOR. It is now a FILTER op, so the extension appends the
    // caller's org and every read in this module is scoped. A regression to `findUnique` turns this red.
    expect(lib).toMatch(/getPrompt\(id: string\)[\s\S]{0,600}?db\.savedPrompt\.findFirst/)
    // Asserted against CODE with the comments stripped. A naive `not.toContain('findUnique')` on the whole file
    // fails on the docstring that explains WHY the operation changed, which would have made this test demand that
    // the rationale be deleted -- the wrong kind of red.
    const libCode = lib.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(libCode).not.toContain('findUnique')
  })
})
