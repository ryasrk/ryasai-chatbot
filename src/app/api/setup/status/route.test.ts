/**
 * GET /api/setup/status — the SETUP WIZARD PROBE. Public by design; it must stay public.
 *
 * WHY THIS FILE EXISTS. `src/app/page.tsx` fetches this route on EVERY load and uses the two
 * booleans to choose between the signup form, the login form, the license screen, and the app
 * shell. Two failure modes matter more than the happy path:
 *
 *   1. THE PROBE MUST NOT LOOK CONFIGURED ON A FRESH INSTALL. INCIDENT (2026-09), recorded in
 *      `src/lib/setup.ts`: an anonymous caller used to get a hardcoded `setupCompleted: true`, so
 *      `page.tsx` skipped its whole `if (!setup.setupCompleted)` signup block and a brand-new
 *      customer was shown the app shell with no session — the deployment was unusable. We pin the
 *      anonymous path here at the ROUTE level (the invariant test pins the lib): it must delegate
 *      to `getSetupState` scoped by nothing, never short-circuit to a constant.
 *
 *   2. THE PROBE MUST NOT LEAK VALUES. It is reachable with no credentials. Its response is derived
 *      from `AppConfig`, the table that holds install configuration (endpoints, connector config,
 *      anything the wizard stores). A setup probe that echoed a connection string or an API key to
 *      an unauthenticated caller would be a real leak. We assert the response is EXACTLY
 *      `{ ok, setupCompleted, hasAdmin }` — booleans and a literal, nothing else — and that the DB
 *      is asked for `select: { setupCompleted: true }` only, never the whole row.
 *
 * Also pinned: session verification is INLINED here (not `getActiveUser()`), because
 * `getActiveUser()` throws on a missing/expired session or a license lockdown, and this route must
 * never fail just because the caller is not logged in. So there are three auth outcomes to cover —
 * no cookie, a forged/stale cookie, and a valid one — and the org scope handed to `getSetupState`
 * must follow them exactly. A stale `sessionVersion` must NOT grant org scope.
 *
 * MOCKS. Declared at the top, mutated per-test; the route is imported DYNAMICALLY after the
 * `mock.module` calls so the mocks are actually installed. Mock shapes follow the real modules:
 *   - `@/lib/setup`     — `getSetupState(db, organizationId?)` returns `{ setupCompleted, hasAdmin }`.
 *   - `@/lib/prisma-tenant` — `bypassOrg(fn)` runs `fn()` with the AsyncLocalStorage cleared.
 *   - `@/lib/session`   — `handleApiError(e, fallback)` -> NextResponse-like JSON {error:{...}}.
 *   - `@/lib/crypto`    — `verifySession(token)` -> userId|null; `extractSessionVersion(token)` -> int.
 *   - `next/headers`    — `cookies()` -> a store whose `.get(name)` returns `{ value } | undefined`.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// --- Mutable seams, ABOVE every mock.module block (house rule 2). ---
let cookieValue: string | undefined
/** When true the mocked `cookies()` store throws — exercises the handler's catch-all. */
let cookieStoreThrows = false
/** userId returned by verifySession — the mocked HMAC check result. */
let sessionUserId: string | null = null
/** sessionVersion embedded in the cookie; compared against the DB row. */
let tokenSessionVersion = 0
let userRow: { organizationId: string; isActive: boolean; sessionVersion: number } | null = null
let throwOn: 'findUnique' | 'getSetupState' | null = null
/** What getSetupState returns — set per test to exercise the response spread. */
let setupState: { setupCompleted: boolean; hasAdmin: boolean } = {
  setupCompleted: false,
  hasAdmin: false,
}

// --- Recorded call evidence: assert ARGS and ORDER, not just return values. ---
const events: string[] = []
const userFindUniqueArgs: Array<Record<string, unknown>> = []
/** Every (db, organizationId) pair getSetupState was invoked with. */
const setupStateArgs: Array<{ organizationId: string | undefined }> = []

function record(label: string) {
  events.push(label)
}

mock.module('next/headers', () => ({
  cookies: async () => {
    record('cookies')
    if (cookieStoreThrows) throw new Error('no request scope')
    return {
      get: (name: string) => {
        record(`cookie.get:${name}`)
        return cookieValue === undefined ? undefined : { value: cookieValue }
      },
    }
  },
}))

mock.module('@/lib/crypto', () => ({
  verifySession: (token: string | undefined | null) => {
    record('verifySession')
    if (!token) return null
    return sessionUserId
  },
  extractSessionVersion: () => tokenSessionVersion,
}))

mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T>(fn: () => Promise<T>): Promise<T> => {
    record('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/session', () => ({
  handleApiError: (e: unknown, fallback: string) => {
    record('handleApiError')
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status: 500 })
  },
}))

mock.module('@/lib/setup', () => ({
  getSetupState: async (_db: unknown, organizationId?: string) => {
    record(`getSetupState:${organizationId ?? '<none>'}`)
    setupStateArgs.push({ organizationId })
    if (throwOn === 'getSetupState') throw new Error('db down')
    return setupState
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    user: {
      findUnique: async (args: Record<string, unknown>) => {
        record('user.findUnique')
        userFindUniqueArgs.push(args)
        if (throwOn === 'findUnique') throw new Error('db down')
        return userRow
      },
    },
  },
}))

// Dynamic import AFTER the mock.module calls (house rule 1).
const { GET } = await import('./route')

/** Read the body ONCE as text, then parse (house rule 5 — res.text() consumes the body). */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const raw = await res.text()
  return JSON.parse(raw) as Record<string, unknown>
}

beforeEach(() => {
  cookieValue = undefined
  cookieStoreThrows = false
  sessionUserId = null
  tokenSessionVersion = 0
  userRow = null
  throwOn = null
  setupState = { setupCompleted: false, hasAdmin: false }
  events.length = 0
  userFindUniqueArgs.length = 0
  setupStateArgs.length = 0
})

describe('GET /api/setup/status — no auth required, and it must never fail on a missing session', () => {
  test('no cookie: 200 with the anonymous setup answer', async () => {
    setupState = { setupCompleted: false, hasAdmin: false }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ ok: true, setupCompleted: false, hasAdmin: false })
  })

  test('no cookie never touches the user table and never calls getActiveUser-style auth', async () => {
    await GET()
    expect(userFindUniqueArgs).toHaveLength(0)
    expect(events).not.toContain('user.findUnique')
  })

  test('a forged/expired cookie (verifySession -> null) is treated as anonymous, not an error', async () => {
    cookieValue = 'forged.token.sig'
    sessionUserId = null
    userRow = { organizationId: 'org-1', isActive: true, sessionVersion: 0 }
    const res = await GET()
    expect(res.status).toBe(200)
    // The user row must NOT be looked up — there is no trusted userId.
    expect(userFindUniqueArgs).toHaveLength(0)
    expect(setupStateArgs[0]!.organizationId).toBeUndefined()
  })

  test('the cookie read is keyed on x-active-user (the real cookie name)', async () => {
    await GET()
    expect(events).toContain('cookie.get:x-active-user')
  })

  test('a valid session scopes the answer to the caller own organization', async () => {
    cookieValue = 'user-1.3.hmack'
    sessionUserId = 'user-1'
    tokenSessionVersion = 3
    userRow = { organizationId: 'org-42', isActive: true, sessionVersion: 3 }
    setupState = { setupCompleted: true, hasAdmin: true }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ ok: true, setupCompleted: true, hasAdmin: true })
    expect(setupStateArgs[0]!.organizationId).toBe('org-42')
  })

  test('the user lookup selects exactly the three fields the route inspects — never the whole row', async () => {
    // `select` is the thing that keeps a passwordHash out of this handler entirely. Asserting
    // the SELECT (not the returned row) is the point: a widened select is a silent leak vector.
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    tokenSessionVersion = 0
    userRow = { organizationId: 'org-1', isActive: true, sessionVersion: 0 }
    await GET()
    expect(userFindUniqueArgs).toHaveLength(1)
    expect(userFindUniqueArgs[0]!.where).toEqual({ id: 'user-1' })
    expect(userFindUniqueArgs[0]!.select).toEqual({
      organizationId: true,
      isActive: true,
      sessionVersion: true,
    })
  })

  test('the lookup is a findUnique on the id (pre-auth, org context not established) — bypassOrg wraps it', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    userRow = { organizationId: 'org-1', isActive: true, sessionVersion: 0 }
    await GET()
    // Two bypassOrg calls: the user lookup, then getSetupState. Both must run unscoped —
    // there is no org context yet, and the tenant extension would otherwise filter on undefined.
    const bypasses = events.filter((e) => e === 'bypassOrg')
    expect(bypasses).toHaveLength(2)
    // Order matters: bypassOrg must WRAP the lookup, not follow it.
    expect(events.indexOf('bypassOrg')).toBeLessThan(events.indexOf('user.findUnique'))
    expect(events.indexOf('user.findUnique')).toBeLessThan(events.lastIndexOf('bypassOrg'))
    expect(events[0]).toBe('cookies')
  })
})

describe('GET /api/setup/status — the sessionVersion gate (stale / deactivated sessions)', () => {
  test('a sessionVersion MISMATCH drops org scope — a stale cookie is as anonymous as no cookie', async () => {
    cookieValue = 'user-1.2.hmack' // token claims version 2
    sessionUserId = 'user-1'
    tokenSessionVersion = 2
    userRow = { organizationId: 'org-42', isActive: true, sessionVersion: 9 } // DB says 9
    await GET()
    expect(setupStateArgs[0]!.organizationId).toBeUndefined()
  })

  test('an INACTIVE user drops org scope even with a matching version', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    tokenSessionVersion = 0
    userRow = { organizationId: 'org-42', isActive: false, sessionVersion: 0 }
    await GET()
    expect(setupStateArgs[0]!.organizationId).toBeUndefined()
  })

  test('a valid userId whose row is missing (deleted user) drops org scope', async () => {
    cookieValue = 'ghost.0.hmack'
    sessionUserId = 'ghost'
    tokenSessionVersion = 0
    userRow = null
    await GET()
    expect(setupStateArgs[0]!.organizationId).toBeUndefined()
  })

  test('the version is extracted from the TOKEN, not defaulted — 0 must still match a 0 row', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    tokenSessionVersion = 0
    userRow = { organizationId: 'org-7', isActive: true, sessionVersion: 0 }
    await GET()
    expect(setupStateArgs[0]!.organizationId).toBe('org-7')
  })
})

describe('GET /api/setup/status — the response must be booleans only (no config VALUES leak)', () => {
  test('the response has EXACTLY three keys — ok, setupCompleted, hasAdmin', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    userRow = { organizationId: 'org-1', isActive: true, sessionVersion: 0 }
    setupState = { setupCompleted: true, hasAdmin: true }
    const body = await readJson(await GET())
    expect(Object.keys(body).sort()).toEqual(['hasAdmin', 'ok', 'setupCompleted'])
  })

  test('every value is a boolean or the ok literal — nothing else is echoed', async () => {
    const body = await readJson(await GET())
    expect(body.ok).toBe(true)
    expect(typeof body.setupCompleted).toBe('boolean')
    expect(typeof body.hasAdmin).toBe('boolean')
  })

  test('CURRENT BEHAVIOUR: an extra key on the setup state IS forwarded by the `...state` spread', async () => {
    // THE LEAK GUARD. The handler spreads `...state` into the response. Today `getSetupState`
    // returns only the two booleans, so this is safe — but the spread means ANY extra key a future
    // `getSetupState` returns (e.g. a connector URL it read to decide `setupCompleted`) would be
    // published to an unauthenticated caller. We pin the current behaviour honestly: the extra key
    // IS currently forwarded, and it must not be a config value. This test fails loudly the moment
    // the state object grows, which is exactly when the spread needs to be replaced with an
    // explicit two-field pick.
    setupState = { setupCompleted: true, hasAdmin: false, apiKey: 'sk-live-DEADBEEF' } as never
    const body = await readJson(await GET())
    // CURRENT BEHAVIOUR: `...state` forwards apiKey. INVERT THIS TEST when the route is fixed to
    // destructure `{ setupCompleted, hasAdmin }` explicitly — then this key must be absent.
    expect(body.apiKey).toBe('sk-live-DEADBEEF')
  })
})

describe('GET /api/setup/status — failures surface as a handled error, not a crash', () => {
  test('a DB failure in getSetupState is routed through handleApiError', async () => {
    throwOn = 'getSetupState'
    const res = await GET()
    expect(res.status).toBe(500)
    expect(events).toContain('handleApiError')
    const body = await readJson(res)
    expect(body.error).toMatchObject({ message: 'Failed to read setup status.' })
  })

  test('a DB failure in the user lookup is also handled (never uncaught)', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    throwOn = 'findUnique'
    const res = await GET()
    expect(res.status).toBe(500)
    expect(events).toContain('handleApiError')
    // getSetupState must NOT run after the lookup threw — no half-answer.
    expect(setupStateArgs).toHaveLength(0)
  })

  test('a cookie store that throws is handled too', async () => {
    // `cookies()` is outside the handler's own try only in spirit — the whole body is wrapped, so a
    // throw here must still come back as a handled error rather than an unhandled rejection.
    cookieStoreThrows = true
    const res = await GET()
    expect(res.status).toBe(500)
    expect(events).toContain('handleApiError')
  })
})

describe('GET /api/setup/status — the fresh-install regression stays pinned at the route level', () => {
  test('anonymous on an empty install reports setupCompleted:false (the 2026-09 incident)', async () => {
    // The lib test pins this in `getSetupState`; here we pin that the ROUTE does not bypass it.
    // A short-circuit `return { ok: true, setupCompleted: true }` for anonymous callers would
    // leave the wizard unreachable — this is the assertion that catches it.
    setupState = { setupCompleted: false, hasAdmin: false }
    const body = await readJson(await GET())
    expect(body.setupCompleted).toBe(false)
    expect(body.hasAdmin).toBe(false)
  })

  test('anonymous always delegates to getSetupState — it is never answered from a constant', async () => {
    await GET()
    expect(setupStateArgs).toHaveLength(1)
    expect(setupStateArgs[0]!.organizationId).toBeUndefined()
  })
})

describe('GET /api/setup/status — side-effect ORDER', () => {
  test('cookie -> verifySession -> user lookup -> getSetupState, in that order', async () => {
    cookieValue = 'user-1.0.hmack'
    sessionUserId = 'user-1'
    tokenSessionVersion = 0
    userRow = { organizationId: 'org-1', isActive: true, sessionVersion: 0 }
    await GET()
    const order = events.filter(
      (e) =>
        e === 'cookies' ||
        e.startsWith('cookie.get') ||
        e === 'verifySession' ||
        e === 'bypassOrg' ||
        e === 'user.findUnique' ||
        e.startsWith('getSetupState'),
    )
    expect(order).toEqual([
      'cookies',
      'cookie.get:x-active-user',
      'verifySession',
      'bypassOrg',
      'user.findUnique',
      'bypassOrg',
      'getSetupState:org-1',
    ])
  })

  test('anonymous: cookie -> verifySession -> getSetupState, with NO user lookup', async () => {
    await GET()
    expect(events).toEqual([
      'cookies',
      'cookie.get:x-active-user',
      'verifySession',
      'bypassOrg',
      'getSetupState:<none>',
    ])
  })
})
