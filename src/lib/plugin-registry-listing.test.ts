import { test, expect, describe, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// listEnabledPlugins
//
// The one function in plugin-registry that touches the database, and the reason
// this is a SEPARATE test file: plugin-registry.test.ts has no `db` mock at all,
// so adding one there would change the module instance every other test in that
// file sees. A fresh file keeps the mock isolated.
// ---------------------------------------------------------------------------

/** Rows the mocked findMany returns. */
let rows: Array<Record<string, unknown>> = []
/** Args captured from the last findMany call. */
let lastArgs: unknown = null

mock.module('@/lib/db', () => ({
  db: {
    plugin: {
      findMany: async (args: unknown) => {
        lastArgs = args
        return rows
      },
    },
  },
}))

const { listEnabledPlugins } = await import('@/lib/plugin-registry')

beforeEach(() => {
  rows = []
  lastArgs = null
})

describe('listEnabledPlugins', () => {
  test('queries ONLY enabled plugins', async () => {
    // The visibility rule: a DISABLED plugin must never be offered to the model. If the
    // `isEnabled: true` filter were dropped, an operator who switched a plugin off would
    // still see it callable -- a safety control that silently stops working.
    rows = [{ id: 'p1', toolId: 't1', name: 'Enabled', description: 'd' }]
    const result = await listEnabledPlugins()

    expect(result).toHaveLength(1)
    expect(lastArgs).toMatchObject({ where: { isEnabled: true } })
  })

  test('selects ONLY the four safe columns -- never the manifest or credentials', async () => {
    // `select` matters for secrets: manifestJson holds ENCRYPTED credentials and the
    // endpoint URL. Narrowing to id/toolId/name/description means a listing call cannot
    // leak them into a prompt or an API response.
    rows = []
    await listEnabledPlugins()

    const select = (lastArgs as { select?: Record<string, boolean> }).select
    expect(select).toEqual({ id: true, toolId: true, name: true, description: true })
    expect(Object.keys(select ?? {})).not.toContain('manifestJson')
    expect(Object.keys(select ?? {})).not.toContain('authCredentials')
    expect(Object.keys(select ?? {})).not.toContain('endpoint')
  })

  test('an empty result is an empty ARRAY, not undefined', async () => {
    // The caller spreads this into a tool list. Returning undefined would throw at the
    // spread site rather than simply contributing nothing.
    rows = []
    const result = await listEnabledPlugins()
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
  })

  test('the rows are returned UNCHANGED and in order', async () => {
    rows = [
      { id: 'b', toolId: 'tb', name: 'B', description: '' },
      { id: 'a', toolId: 'ta', name: 'A', description: '' },
    ]
    const result = await listEnabledPlugins()
    expect(result.map((p) => p.id)).toEqual(['b', 'a'])
    expect(result[0]).toEqual({ id: 'b', toolId: 'tb', name: 'B', description: '' })
  })
})
