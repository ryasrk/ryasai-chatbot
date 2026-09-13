/**
 * POST /api/setup/seed-plugins — re-install the built-in plugins for the current org.
 *
 * WHY THIS FILE EXISTS. "Seed the plugins" reads like a maintenance helper, but this endpoint CREATES rows that the
 * planner will call with real outbound HTTP, so its gates are the whole security story. Three properties:
 *
 *   1. THE ORG ID IS THE SESSION'S, NEVER THE CALLER'S. There is no body and no query string; every DB call is
 *      scoped to `user.organizationId`. Seeding another tenant's plugin list would hand them webhooks they did not
 *      register, so the argument is asserted on the WRITE, not just on the count.
 *   2. THE BYPASS IS PER-CALL, NOT GLOBAL. The route reads through `bypassOrg` because it needs the count and the
 *      seed to run against ONE named org; it must still enter the org context first so that nothing else in the
 *      request runs unscoped, and the id passed to `seedPlugins` must be the session org.
 *   3. THE AUDIT IS `warning`. Re-seeding can point existing built-ins at different endpoints, which changes what
 *      the assistant will fetch. `writeAudit` only rethrows at severity `critical`, so this audit is
 *      best-effort-but-recorded; the route must not invent a second severity.
 *
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 * FINDING — THE AUTH GATE IS REAL (admin-only via `requireRole`), AND THAT IS *NOT* THE PROBLEM.
 *
 * The briefing asked whether this route can be called without a session. It cannot: `getActiveUser()` throws
 * UnauthorizedError when there is no valid cookie (or when AUTH_DEMO_FALLBACK is off) and `requireRole(user,
 * 'admin')` throws ForbiddenError for analyst/viewer. Both are pinned below, including a test that PROVES the
 * absence of a session is refused, so this is a verified negative, not an assumption.
 *
 * What IS notable is the ORDER: `enterWithOrg(user.organizationId)` runs AFTER `requireRole`, which is the
 * opposite of the sibling `/api/org` route. It happens to be safe here because the only DB work is explicitly
 * wrapped in `bypassOrg`, but it is the pattern `tenant-route-guard.test.ts` exists to catch, and it means the
 * invariant ("enter the org context immediately after getActiveUser") is satisfied only by a technicality — the
 * route contains the word `enterWithOrg`, so the static guard passes while the context is established after a
 * throw-capable call. Pinned as ORDER, with the impact stated honestly: no live leak today, a latent trap if
 * anyone adds an org-scoped query between the two lines.
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Control tests were verified by mutating the route in place, running the file, and restoring it.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// ---- mutable seams, declared before every mock.module ----
const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser
/** When set, getActiveUser throws it -- the "no session" seam. */
let authThrows: Error | null = null
let requireRoleThrows: Error | null = null
let counts: number[] = [0, 9]
let countThrows: Error | null = null
let seedThrows: Error | null = null
let auditThrows: Error | null = null
const countQueries: Array<Record<string, unknown>> = []
const seededOrgs: string[] = []
const audits: Array<Record<string, unknown>> = []
const events: string[] = []
let handleErrorArgs: Array<{ fallback: string; status: number | undefined }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  requireRole: (u: typeof adminUser, minRole: string) => {
    events.push(`requireRole:${minRole}`)
    if (requireRoleThrows) throw requireRoleThrows
    const rank: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }
    if (rank[u.role]! < rank[minRole]!) {
      throw Object.assign(new Error(`Requires ${minRole} role. You have ${u.role}.`), {
        name: 'ForbiddenError',
        code: 'FORBIDDEN',
      })
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    events.push('writeAudit')
    if (auditThrows) throw auditThrows
    audits.push(row)
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    handleErrorArgs.push({ fallback, status })
    events.push('handleApiError')
    const name = (e as { name?: string } | null)?.name
    if (name === 'UnauthorizedError') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: (e as Error).message } }, { status: 401 })
    }
    if (name === 'ForbiddenError') {
      return Response.json({ error: { code: 'FORBIDDEN', message: (e as Error).message } }, { status: 403 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
  },
  bypassOrg: async (fn: () => Promise<unknown>) => {
    events.push('bypassOrg')
    return fn()
  },
}))

mock.module('@/lib/plugin-seeds', () => ({
  seedPlugins: async (organizationId: string) => {
    seededOrgs.push(organizationId)
    events.push(`seedPlugins:${organizationId}`)
    if (seedThrows) throw seedThrows
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      count: async (args: Record<string, unknown>) => {
        countQueries.push(args)
        events.push('plugin.count')
        if (countThrows) throw countThrows
        return counts.length ? counts.shift()! : 0
      },
    },
  },
}))

// DYNAMIC: mock.module does not apply to static imports.
const { POST } = await import('./route')

beforeEach(() => {
  user = adminUser
  authThrows = null
  requireRoleThrows = null
  counts = [0, 9]
  countThrows = null
  seedThrows = null
  auditThrows = null
  countQueries.length = 0
  seededOrgs.length = 0
  audits.length = 0
  events.length = 0
  handleErrorArgs = []
})

describe('the auth and role gates', () => {
  test('NO SESSION is refused with a 401 and seeds nothing', async () => {
    // VERIFIED NEGATIVE for the briefing question "can this be called without a session?": no. getActiveUser()
    // throws before any org context, count, or seed exists.
    authThrows = Object.assign(new Error('No active session.'), { name: 'UnauthorizedError' })
    const res = await POST()
    expect(res.status).toBe(401)
    expect(seededOrgs).toHaveLength(0)
    expect(countQueries).toHaveLength(0)
    expect(events).not.toContain('enterWithOrg:org-1')
  })

  test('an ANALYST is refused with a 403 before the org context is entered', async () => {
    // Control C1 (deleting requireRole): red across the whole gate block. Seeding rewrites what the assistant
    // fetches, so it is an admin action.
    user = { ...adminUser, role: 'analyst' }
    const res = await POST()
    expect(res.status).toBe(403)
    expect(seededOrgs).toHaveLength(0)
    expect(countQueries).toHaveLength(0)
    expect(events).not.toContain('enterWithOrg:org-1')
  })

  test('a VIEWER is refused too', async () => {
    user = { ...adminUser, role: 'viewer' }
    expect((await POST()).status).toBe(403)
    expect(seededOrgs).toHaveLength(0)
  })

  test('the gate is requireRole with the literal admin role', async () => {
    await POST()
    expect(events).toContain('requireRole:admin')
  })

  test('the gate runs BEFORE the org context is entered', async () => {
    // ORDER, recorded rather than approved. `enterWithOrg` after the gate is the inverse of /api/org and of the
    // rule in CLAUDE.md/AGENTS.md; safe today only because every query below is inside bypassOrg. Pinned so a
    // change to this order is a visible edit -- see the finding block in this file.
    await POST()
    expect(events.indexOf('requireRole:admin')).toBeLessThan(events.indexOf('enterWithOrg:org-1'))
  })

  test('the org context is entered with the SESSION org, after the gate', async () => {
    user = { ...adminUser, organizationId: 'org-7' }
    await POST()
    expect(events).toContain('enterWithOrg:org-7')
  })
})

describe('the seeding scope', () => {
  test('seedPlugins receives the SESSION org id', async () => {
    // Control C2 (passing a constant, or a body-supplied id): red. Seeding another org installs built-in webhooks
    // into a tenant that did not ask for them.
    await POST()
    expect(seededOrgs).toEqual(['org-1'])
  })

  test('a different session org seeds THAT org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-2' }
    await POST()
    expect(seededOrgs).toEqual(['org-2'])
  })

  test('the before and after counts are BOTH scoped to the session org', async () => {
    // An unscoped count would report the whole install's plugin total, and the "before/after" delta shown to the
    // admin would be nonsense.
    await POST()
    expect(countQueries).toHaveLength(2)
    for (const q of countQueries) expect(q.where).toEqual({ organizationId: 'org-1' })
  })

  test('the route takes no request argument at all', async () => {
    // There is no body, no query string, no id in the path -- the entire scope comes from the session. Asserted by
    // arity so a future `POST(req)` that reads a body has to add a test.
    expect(POST.length).toBe(0)
    await POST()
    expect(seededOrgs).toHaveLength(1)
  })

  test('the count and the seed are called inside the org bypass', async () => {
    await POST()
    expect(events.filter((e) => e === 'bypassOrg')).toHaveLength(3)
  })
})

describe('the before/after report', () => {
  test('it answers the before and after counts', async () => {
    counts = [3, 12]
    const body = (await (await POST()).json()) as { ok: boolean; before: number; after: number }
    expect(body).toEqual({ ok: true, before: 3, after: 12 })
  })

  test('an idempotent re-seed reports before === after', async () => {
    // The common case: the built-ins already exist and the upsert refreshes them without adding rows. The admin
    // must be able to tell "nothing added" from "nothing happened" -- hence both numbers, not just the delta.
    counts = [9, 9]
    const body = (await (await POST()).json()) as { before: number; after: number }
    expect(body.before).toBe(9)
    expect(body.after).toBe(9)
  })

  test('the FIRST count is taken before the seed and the SECOND after', async () => {
    // Ordering pin: two counts of the same table are trivially swappable, and a swapped pair inverts the report.
    await POST()
    const countIndexes = events.map((e, i) => (e === 'plugin.count' ? i : -1)).filter((i) => i >= 0)
    const seedIndex = events.indexOf('seedPlugins:org-1')
    expect(countIndexes[0]!).toBeLessThan(seedIndex)
    expect(countIndexes[1]!).toBeGreaterThan(seedIndex)
  })

  test('a zero-plugin org that seeds nothing still answers ok with equal counts', async () => {
    counts = [0, 0]
    const body = (await (await POST()).json()) as { ok: boolean; before: number; after: number }
    expect(body).toMatchObject({ ok: true, before: 0, after: 0 })
  })
})

describe('the audit record', () => {
  test('it audits PLUGINS_SEEDED at WARNING with before, after and the manual origin', async () => {
    // Control C3 (changing severity to 'info'): red. `via: 'manual-api'` is what separates a hand-triggered
    // re-seed from the boot auto-heal -- without it an operator cannot tell who changed the plugin set.
    counts = [1, 10]
    await POST()
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'PLUGINS_SEEDED',
      severity: 'warning',
      detail: { before: 1, after: 10, via: 'manual-api' },
    })
  })

  test('the audit uses the ACTING user, not a constant', async () => {
    user = { ...adminUser, userId: 'u-admin-2' }
    await POST()
    expect(audits[0]!.userId).toBe('u-admin-2')
  })

  test('the audit happens AFTER the seed', async () => {
    // An audit row for a seed that never ran fabricates a maintenance event.
    await POST()
    expect(events.indexOf('seedPlugins:org-1')).toBeLessThan(events.indexOf('writeAudit'))
  })

  test('the audit carries NO plugin manifests or credentials', async () => {
    // The audit payload must stay a summary: plugin manifests can hold encrypted webhook credentials.
    await POST()
    const logged = JSON.stringify(audits[0])
    expect(logged).not.toContain('manifestJson')
    expect(logged).not.toContain('authCredentials')
    expect(logged).not.toContain('endpoint')
  })

  test('a seed FAILURE is a 500 and writes NO audit row', async () => {
    seedThrows = new Error('duplicate key value violates unique constraint')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(audits).toHaveLength(0)
    expect(handleErrorArgs).toEqual([{ fallback: 'Failed to seed plugins.', status: 500 }])
  })

  test('a COUNT failure is a 500 with no seed attempt', async () => {
    // The before-count is the first query: if the DB is unreachable the route must not go on to write plugins.
    countThrows = new Error('connect ECONNREFUSED')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(seededOrgs).toHaveLength(0)
  })

  test('the raw DB error text never reaches the client', async () => {
    seedThrows = new Error('relation "Plugin" does not exist at 10.0.0.7:5432')
    const t = await (await POST()).text()
    expect(t).not.toContain('10.0.0.7')
    expect(t).not.toContain('does not exist')
    expect(t).toContain('Failed to seed plugins.')
  })

  test('an audit failure is SURFACED as a 500, not swallowed by the route', async () => {
    // writeAudit swallows info/warning in the REAL module, so this can only happen if it is asked to throw. The
    // route adds no catch of its own -- pinned so a future "log and continue" edit is deliberate.
    auditThrows = new Error('audit write failed')
    expect((await POST()).status).toBe(500)
  })
})

describe('handler shape', () => {
  test('a successful call is a single 200 with ok:true', async () => {
    const res = await POST()
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  test('the response body has EXACTLY ok, before and after', async () => {
    // No plugin rows, no org id, no manifests. Pinned key-set so widening it is a deliberate edit.
    const body = (await (await POST()).json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['after', 'before', 'ok'])
  })

  test('the module seeds through the dynamic import boundary, so the seed list can be tree-shaken per call', async () => {
    // STATIC check on the real source: `seedPlugins` is imported DYNAMICALLY inside the handler. That is what lets
    // the test above mock it through mock.module at all, and it is the reason a static import here would silently
    // bypass every mock in this file.
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const src = readFileSync(join(import.meta.dir, 'route.ts'), 'utf8')
    expect(src).toContain("const { seedPlugins } = await import('@/lib/plugin-seeds')")
    expect(src).not.toMatch(/^import[^\n]*plugin-seeds/m)
  })
})
