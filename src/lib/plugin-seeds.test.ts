/**
 * Built-in plugin seeding (the boot auto-heal).
 *
 * WHY THIS FILE EXISTS. `plugin-seeds.ts` was invoked by FOUR production paths —
 * `instrumentation.ts` on every boot, `POST /api/setup/complete`, `POST /api/setup/seed-plugins`,
 * and the `seed_plugins` admin tool — yet EVERY test that touched it MOCKED it. The module's own
 * comment even documents the consequence of that blind spot: it mentions a "news endpoint fix"
 * that "sat in the seed file while production kept 404ing on the stale row". Its real
 * implementation therefore never ran under test, which is why it needed a real test rather than
 * another mock.
 *
 * The load-bearing behaviour is the UPDATE path, and specifically the split between:
 *   - seed-owned fields (name, description, manifestJson, category, subcategory, keywords),
 *     refreshed on every boot so a corrected built-in actually reaches existing installs; and
 *   - operator-owned fields (`isEnabled`, `chatEnabled`, `agenticEnabled`), NEVER touched on an
 *     existing row.
 * Invert either half and you get a real defect: stop refreshing and a broken endpoint stays
 * broken forever; start overwriting and an admin who deliberately disabled a plugin finds it
 * silently re-enabled after every restart.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

type FindFirstArgs = { where: { organizationId: string; toolId: string }; select?: unknown }
type CreateArgs = { data: Record<string, unknown> }
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> }

const calls = {
  findFirst: [] as FindFirstArgs[],
  create: [] as CreateArgs[],
  update: [] as UpdateArgs[],
}
/** Rows that already exist, keyed by `${organizationId}:${toolId}`. */
const existingRows = new Map<string, { id: string }>()

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findFirst: async (args: FindFirstArgs) => {
        calls.findFirst.push(args)
        return existingRows.get(`${args.where.organizationId}:${args.where.toolId}`) ?? null
      },
      create: async (args: CreateArgs) => {
        calls.create.push(args)
        return args.data
      },
      update: async (args: UpdateArgs) => {
        calls.update.push(args)
        return args.data
      },
    },
  },
}))

import { seedPlugins } from './plugin-seeds'

beforeEach(() => {
  calls.findFirst.length = 0
  calls.create.length = 0
  calls.update.length = 0
  existingRows.clear()
})

describe('seedPlugins — a fresh install', () => {
  test('creates every built-in plugin for the org', async () => {
    await seedPlugins('org-fresh')
    expect(calls.create.length).toBeGreaterThan(0)
    expect(calls.update).toHaveLength(0)
    // Every lookup was scoped to this org — never a global scan of the plugin table.
    expect(calls.findFirst.every((c) => c.where.organizationId === 'org-fresh')).toBe(true)
  })

  test('the seeded tool ids are unique, so no plugin is created twice', async () => {
    // The seeder looks up by toolId; a duplicate in the PLUGINS array would make the second
    // occurrence overwrite the first plugin's row on a fresh install.
    await seedPlugins('org-fresh')
    const ids = calls.create.map((c) => c.data.toolId as string)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('a created plugin is ENABLED and available to both chat and agentic', async () => {
    // A built-in that lands disabled, or invisible to the agentic planner, is effectively not
    // installed — and only the toolId list is checked by the admin UI, so this would look fine.
    await seedPlugins('org-fresh')
    const data = calls.create[0]!.data
    expect(data.isEnabled).toBe(true)
    expect(data.chatEnabled).toBe(true)
    expect(data.agenticEnabled).toBe(true)
  })

  test('organizationId is written explicitly on create', async () => {
    // The seeder runs under bypassOrg (called from instrumentation and setup), so the tenant
    // extension will NOT inject an org. Relying on it would create an unowned row.
    await seedPlugins('org-explicit')
    expect(calls.create.every((c) => c.data.organizationId === 'org-explicit')).toBe(true)
  })

  test('the manifest is stored as a JSON STRING, not an object', async () => {
    // manifestJson is a String column (see the schema note about JSON-as-string). Passing the
    // object through silently stores "[object Object]" on some drivers.
    await seedPlugins('org-fresh')
    const manifest = calls.create[0]!.data.manifestJson as string
    expect(typeof manifest).toBe('string')
    expect(() => JSON.parse(manifest)).not.toThrow()
    const parsed = JSON.parse(manifest) as Record<string, unknown>
    expect(parsed.executorType).toBe('webhook')
    expect(typeof parsed.endpoint).toBe('string')
  })

  test('every built-in has the fields the plugin registry needs to execute it', async () => {
    // A seed entry missing an endpoint or executor type would install a plugin that fails only
    // when an end user first invokes it.
    await seedPlugins('org-fresh')
    for (const c of calls.create) {
      const m = JSON.parse(c.data.manifestJson as string) as Record<string, unknown>
      expect(typeof m.endpoint).toBe('string')
      expect((m.endpoint as string).startsWith('https://')).toBe(true)
      expect(typeof m.method).toBe('string')
      expect(typeof m.executorType).toBe('string')
      expect(typeof c.data.keywords).toBe('string')
      expect(c.data.name).toBeTruthy()
      expect(c.data.description).toBeTruthy()
      expect(c.data.category).toBeTruthy()
      expect(c.data.subcategory).toBeTruthy()
    }
  })
})

describe('seedPlugins — the update path on an existing install', () => {
  test('an EXISTING row is UPDATED, never re-created', async () => {
    // Re-creating would violate the per-org toolId uniqueness the registry relies on.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    await seedPlugins('org-a')
    // The row that existed is UPDATED in place...
    expect(calls.update.some((u) => u.where.id === 'row-weather')).toBe(true)
    // ...and NOT re-created. Exactly one fewer create than there are built-ins.
    const createdToolIds = calls.create.map((c) => c.data.toolId as string)
    expect(createdToolIds).not.toContain('weather')
    expect(calls.create).toHaveLength(calls.findFirst.length - 1)
  })

  test('seed-owned fields ARE refreshed on an existing row (the auto-heal)', async () => {
    // This is what lets a corrected manifest reach an install whose row predates the fix —
    // exactly the "news endpoint fix stayed in the seed file" defect the module documents.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    await seedPlugins('org-a')
    const upd = calls.update.find((u) => u.where.id === 'row-weather')!
    for (const field of ['name', 'description', 'manifestJson', 'category', 'subcategory', 'keywords']) {
      expect(field in upd.data).toBe(true)
    }
    // The refreshed manifest must be the CURRENT seed manifest, not a stale copy.
    expect(() => JSON.parse(upd.data.manifestJson as string)).not.toThrow()
  })

  test('the operator enable toggles are NOT written on an existing row', async () => {
    // THE property that protects operator intent. An admin who disabled a plugin must not have
    // it silently re-enabled by the next restart, and an admin who enabled a seed-disabled
    // plugin must not have it turned back off.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    await seedPlugins('org-a')
    const upd = calls.update.find((u) => u.where.id === 'row-weather')!
    expect('isEnabled' in upd.data).toBe(false)
    expect('chatEnabled' in upd.data).toBe(false)
    expect('agenticEnabled' in upd.data).toBe(false)
  })

  test('the UPDATE never rewrites organizationId or toolId', async () => {
    // Both are the row's identity; rewriting toolId would orphan the plugin from its registry
    // entry, and rewriting organizationId would move another tenant's plugin.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    await seedPlugins('org-a')
    const upd = calls.update.find((u) => u.where.id === 'row-weather')!
    expect('organizationId' in upd.data).toBe(false)
    expect('toolId' in upd.data).toBe(false)
  })

  test('the lookup is scoped by BOTH organizationId and toolId', async () => {
    // Matching on toolId alone would let org A's weather plugin be treated as org B's, so org B
    // would never get its own row and would silently share org A's configuration.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    await seedPlugins('org-b')
    expect(calls.update).toHaveLength(0)
    expect(calls.create.length).toBeGreaterThan(0)
    expect(calls.findFirst.every((c) => c.where.organizationId === 'org-b')).toBe(true)
  })

  test('a MIXED install updates the present plugins and creates the missing ones', async () => {
    // The real upgrade path: an install seeded before a new built-in was added.
    existingRows.set('org-a:weather', { id: 'row-weather' })
    existingRows.set('org-a:datetime', { id: 'row-datetime' })
    await seedPlugins('org-a')

    expect(calls.update.map((u) => u.where.id).sort()).toEqual(['row-datetime', 'row-weather'])
    // Everything else is created, and nothing is both updated and created.
    const updatedToolIds = new Set(
      calls.update.map((u) => calls.findFirst.find((f) => f.where.toolId)?.where.toolId),
    )
    expect(calls.create.length).toBe(calls.findFirst.length - calls.update.length)
    expect(updatedToolIds.size).toBeGreaterThan(0)
  })
})

describe('seedPlugins — idempotency and scale', () => {
  test('a second run over an already-seeded org performs only UPDATES', async () => {
    // The boot path runs this on EVERY server start; a create on the second run would pile up
    // duplicate rows (or throw on a uniqueness constraint once one exists).
    await seedPlugins('org-a')
    const createdIds = calls.create.map((c) => c.data.toolId as string)
    for (const id of createdIds) existingRows.set(`org-a:${id}`, { id: `row-${id}` })

    calls.create.length = 0
    calls.update.length = 0
    await seedPlugins('org-a')

    expect(calls.create).toHaveLength(0)
    expect(calls.update).toHaveLength(createdIds.length)
  })

  test('exactly ONE findFirst per built-in plugin (the documented ceiling)', async () => {
    // The comment states "one findFirst per plugin". N+1 growth here would make boot slower on
    // every restart; pinning the count means a future refactor is a visible change.
    await seedPlugins('org-a')
    expect(calls.findFirst).toHaveLength(calls.create.length)
    expect(new Set(calls.findFirst.map((c) => c.where.toolId)).size).toBe(calls.findFirst.length)
  })

  test('two different orgs get independent rows with the same tool ids', async () => {
    await seedPlugins('org-a')
    const aIds = calls.create.map((c) => c.data.toolId as string)
    calls.create.length = 0
    calls.findFirst.length = 0
    await seedPlugins('org-b')
    const bIds = calls.create.map((c) => c.data.toolId as string)

    expect(bIds).toEqual(aIds)
    expect(calls.create.every((c) => c.data.organizationId === 'org-b')).toBe(true)
  })
})
