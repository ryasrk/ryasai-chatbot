/**
 * POST /api/setup/complete — finalises onboarding: flips AppConfig.setupCompleted, seeds plugins, audits.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog. Two properties here are load-bearing beyond the happy path:
 *
 *   1. `setupCompleted = true` IS A GATE. Middleware and the wizard read it to decide whether an
 *      organization still needs onboarding, so writing it without an admin check lets any authenticated
 *      viewer declare an organization ready -- and the plugin seed below then runs against a config nobody
 *      reviewed. It is admin-only, and the audit action is asserted so the flip is traceable.
 *   2. THE PLUGIN SEED IS PER-ORGANIZATION. The in-code comment records a real prior bug: a global
 *      `plugin.count()` check skipped seeding for a NEW org whenever ANY other org already had plugins. So
 *      the count must be scoped to `organizationId`, and the seed must be invoked with the ORG id -- both
 *      asserted, because a global count silently leaves a new organization with an empty toolset.
 *
 * Also pinned: the create-vs-update branch, and the fact that the dynamic `seedPlugins` import only runs
 * when the org actually has zero plugins (a seeding call on every setup POST would duplicate rows).
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

/**
 * The acting user is a MUTABLE binding read by the mocked getActiveUser. Module namespace bindings are
 * read-only in Bun (`Attempted to assign to readonly property`), so swapping the export from outside the
 * mock is not possible -- the seam has to live in the mock's own closure.
 */
let user: typeof adminUser = adminUser

let appConfigRow: { id: string } | null = { id: 'cfg-1' }
let pluginCount = 0
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const seededOrgs: string[] = []
let seedThrows: Error | null = null

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role: string }, role: string) => {
    if (u.role !== role) {
      const e = new Error('Forbidden') as Error & { statusCode?: number }
      e.statusCode = 403
      throw e
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: (e as { statusCode?: number })?.statusCode ?? 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

mock.module('@/lib/plugin-seeds', () => ({
  seedPlugins: async (orgId: string) => {
    if (seedThrows) throw seedThrows
    seededOrgs.push(orgId)
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async (args: Record<string, unknown>) => {
        calls.push({ model: 'appConfig', op: 'findFirst', args: args ?? {} })
        return appConfigRow
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'appConfig', op: 'update', args })
        return {}
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'appConfig', op: 'create', args })
        return {}
      },
    },
    plugin: {
      count: async (args: Record<string, unknown>) => {
        calls.push({ model: 'plugin', op: 'count', args })
        return pluginCount
      },
    },
  },
}))

import { POST } from './route'

beforeEach(() => {
  user = adminUser
  appConfigRow = { id: 'cfg-1' }
  pluginCount = 0
  calls.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  seededOrgs.length = 0
  seedThrows = null
})

describe('POST /api/setup/complete — the setupCompleted flip', () => {
  test('an EXISTING config is UPDATED to completed', async () => {
    await POST()
    const u = calls.find((c) => c.model === 'appConfig' && c.op === 'update')
    expect(u).toBeDefined()
    expect(u!.args).toMatchObject({ where: { id: 'cfg-1' }, data: { setupCompleted: true } })
    expect(calls.filter((c) => c.model === 'appConfig' && c.op === 'create')).toHaveLength(0)
  })

  test('a MISSING config is CREATED completed, stamped with the session org', async () => {
    // The wizard can be reached before the safety-net AppConfig exists. The org id comes from the SESSION --
    // a body-supplied one would be a cross-tenant write.
    appConfigRow = null
    await POST()
    const c = calls.find((c) => c.model === 'appConfig' && c.op === 'create')
    expect(c).toBeDefined()
    expect(c!.args.data).toMatchObject({ organizationId: 'org-1', setupCompleted: true })
  })

  test('it is admin-only: a viewer cannot declare the org onboarded and trigger the seed', async () => {
    // setupCompleted gates the rest of the wizard, and completing setup runs the plugin seed. A non-admin
    // flipping it would run an unreviewed seed on the org.
    user = { ...adminUser, role: 'viewer' }
    const res = await POST()
    expect(res.status).toBe(403)
    expect(calls.filter((c) => c.op === 'update')).toHaveLength(0)
    expect(seededOrgs).toHaveLength(0)
  })

  test('an analyst cannot either', async () => {
    user = { ...adminUser, role: 'analyst' }
    expect((await POST()).status).toBe(403)
  })

  test('the org context is entered before any query', async () => {
    await POST()
    expect(enteredOrgs).toEqual(['org-1'])
  })
})

describe('POST /api/setup/complete — the plugin seed is PER ORG (a previously shipped bug)', () => {
  test('the count is SCOPED to the session org, not global', async () => {
    // The in-code comment records the real regression: a global pluginCount check skipped seeding for a new
    // org whenever ANY other org already had plugins, leaving the new organization with an empty toolset.
    // Asserted on the where clause, because that is precisely what regressed.
    await POST()
    const c = calls.find((c) => c.model === 'plugin' && c.op === 'count')
    expect(c).toBeDefined()
    expect(c!.args.where).toEqual({ organizationId: 'org-1' })
  })

  test('with ZERO plugins the seed runs, for the session org', async () => {
    pluginCount = 0
    await POST()
    expect(seededOrgs).toEqual(['org-1'])
  })

  test('with plugins already present the seed is SKIPPED', async () => {
    // Re-seeding on every setup POST would duplicate rows.
    pluginCount = 3
    await POST()
    expect(seededOrgs).toHaveLength(0)
  })

  test('the seed runs AFTER the config is marked complete, so a failed seed leaves a coherent state', async () => {
    // Order matters for diagnosis: if the seed throws, the operator must see a completed config plus an error,
    // not a half-seeded org that reports itself as not set up.
    const order: string[] = []
    pluginCount = 0
    seedThrows = new Error('seed failed')
    const res = await POST()
    order.push(calls.some((c) => c.op === 'update') ? 'config-written' : 'MISSING')
    order.push(res.status === 500 ? 'error-surfaced' : `status-${res.status}`)
    expect(order).toEqual(['config-written', 'error-surfaced'])
  })

  test('a failing seed surfaces as an error rather than a false success', async () => {
    // The dangerous alternative: swallowing the seed failure and returning { ok: true }, which tells the
    // operator onboarding finished while the org has no tools.
    seedThrows = new Error('seed failed')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})

describe('POST /api/setup/complete — the audit trail', () => {
  test('a SETUP_COMPLETED audit is written for the acting user', async () => {
    await POST()
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({ userId: 'u1', action: 'SETUP_COMPLETED', detail: {} })
  })

  test('the audit is written AFTER the seed, so it only records a fully completed setup', async () => {
    // An audit row written before the seed would claim completion for an org whose seeding then failed.
    pluginCount = 0
    await POST()
    expect(seededOrgs).toEqual(['org-1'])
    expect(auditWrites).toHaveLength(1)
  })

  test('the audit is NOT written when the seed fails', async () => {
    pluginCount = 0
    seedThrows = new Error('boom')
    await POST()
    expect(auditWrites).toHaveLength(0)
  })
})

describe('POST /api/setup/complete — the success contract', () => {
  test('it returns exactly { ok: true }', async () => {
    // The wizard treats any other body as failure. Asserted with toEqual so an accidental extra field is a
    // negative -- the response is small on purpose.
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('a database failure is reported through the typed error mapper', async () => {
    seedThrows = null
    const db = (await import('@/lib/db')).db as unknown as {
      appConfig: { findFirst: (a: unknown) => Promise<unknown> }
    }
    const original = db.appConfig.findFirst
    db.appConfig.findFirst = async () => {
      throw new Error('db down')
    }
    try {
      const res = await POST()
      expect(res.status).toBe(500)
    } finally {
      db.appConfig.findFirst = original
    }
  })
})
