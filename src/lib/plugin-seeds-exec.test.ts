import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Executes `seedPlugins` so the module is actually COVERED, not merely described.
 *
 * WHY THIS FILE EXISTS. The metrics gate reported `src/lib/plugin-seeds.ts` as a gated module
 * MISSING from the coverage report. The cause was measured, not guessed: the existing
 * `plugin-seeds.test.ts` does `readFileSync('./plugin-seeds.ts')` and asserts on the file's TEXT —
 * a useful check on the seed data, and one that executes none of the module. Its single export
 * (`seedPlugins`) was therefore never instrumented, so the gate saw a module that had silently
 * stopped being exercised.
 *
 * Reading a module's source is not the same as running it. Both are worth having: the source-level
 * test catches malformed seed data, and this one proves the upsert logic that writes that data.
 */
const dbState = {
  existing: [] as Array<{ id: string; toolId: string }>,
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
}

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findFirst: async (a: { where: { toolId?: string } }) => {
        const hit = dbState.existing.find((p) => p.toolId === a.where.toolId)
        return hit ? { id: hit.id } : null
      },
      create: async (a: { data: Record<string, unknown> }) => {
        dbState.created.push(a.data)
        return { id: `new-${dbState.created.length}`, ...a.data }
      },
      update: async (a: Record<string, unknown>) => {
        dbState.updated.push(a)
        return a
      },
    },
  },
}))

const { seedPlugins } = await import('./plugin-seeds')

describe('seedPlugins', () => {
  beforeEach(() => {
    dbState.existing = []
    dbState.created = []
    dbState.updated = []
  })

  test('creates every seed when the org has none, scoped to that org', async () => {
    await seedPlugins('org-a')

    expect(dbState.created.length).toBeGreaterThan(0)
    // Every row must carry the org it was seeded for. This module writes to a MULTI-TENANT table,
    // so a seed that omitted the org would either fail the FK or — worse — land in the wrong tenant.
    for (const row of dbState.created) {
      expect(row.organizationId).toBe('org-a')
    }
    expect(dbState.updated).toHaveLength(0)
  })

  test('every seeded plugin is enabled for chat AND agentic use', async () => {
    await seedPlugins('org-a')

    for (const row of dbState.created) {
      // The 2026-09 plugin work made plugins agentic-only in one place and chat-enabled in another;
      // both flags are set here deliberately, so assert both rather than trusting the shape.
      expect(row.chatEnabled).toBe(true)
      expect(row.agenticEnabled).toBe(true)
      expect(typeof row.toolId).toBe('string')
      expect(typeof row.manifestJson).toBe('string')
      // A manifest that is not JSON would fail at dispatch time, not at seed time.
      expect(() => JSON.parse(String(row.manifestJson))).not.toThrow()
    }
  })

  test('UPDATES an existing seed instead of creating a duplicate', async () => {
    // The branch that makes re-seeding idempotent. Without this test the update path was never
    // executed: a second seed run would silently create duplicates, and the plugin list would show
    // each tool twice.
    dbState.existing = [{ id: 'existing-1', toolId: 'weather' }]

    await seedPlugins('org-a')

    expect(dbState.updated.length).toBe(1)
    const u = dbState.updated[0] as { where: { id: string }; data: Record<string, unknown> }
    expect(u.where.id).toBe('existing-1')
    // The seed owns name/description/manifest/keywords, so a re-seed refreshes them.
    expect(u.data).toHaveProperty('manifestJson')
    expect(u.data).toHaveProperty('keywords')
    // It must NOT touch the org or the tool id — those identify the row.
    expect(u.data).not.toHaveProperty('organizationId')
    expect(u.data).not.toHaveProperty('toolId')
  })

  test('is idempotent: a second run updates rather than creating again', async () => {
    await seedPlugins('org-a')
    const afterFirst = dbState.created.length
    expect(afterFirst).toBeGreaterThan(0)

    // Second run: everything now "exists".
    dbState.existing = dbState.created.map((r, i) => ({ id: `e${i}`, toolId: String(r.toolId) }))
    dbState.created = []
    await seedPlugins('org-a')

    expect(dbState.created).toHaveLength(0)
    expect(dbState.updated).toHaveLength(afterFirst)
  })
})
