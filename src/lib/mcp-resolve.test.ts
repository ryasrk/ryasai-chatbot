/**
 * Resolving an MCP server by name, with several installed.
 *
 * Regression: the lookup was findFirst({ name: { contains } }) with no ordering
 * and no uniqueness on name, so "set credentials for spotify" could land on
 * spotify-premium — silently, and on mcp_remove it deleted the wrong server.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

type Row = { id: string; name: string }
let rows: Row[] = []

function matches(where: Record<string, any>): Row[] {
  if (where.id) return rows.filter((r) => r.id === where.id)
  const c = where.name?.contains
  if (typeof c === 'string') {
    return rows.filter((r) => r.name.toLowerCase().includes(c.toLowerCase()))
  }
  return rows
}

mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findFirst: async ({ where }: { where: Record<string, any> }) => matches(where)[0] ?? null,
      findMany: async ({ where, orderBy }: { where: Record<string, any>; orderBy?: { name: 'asc' } }) => {
        const out = matches(where)
        return orderBy ? [...out].sort((a, b) => a.name.localeCompare(b.name)) : out
      },
    },
    auditLog: { create: async () => ({}) },
  },
}))
mock.module('@/lib/mcp-client', () => ({
  testMcpServer: async (id: string) => ({
    ok: true,
    toolCount: 1,
    tools: [{ name: `tool-for-${id}`, description: '' }],
  }),
  invalidateMcpToolsCache: () => {},
  disconnectMcpServer: async () => {},
}))

const { executeAdminTool } = await import('./admin-tools')

const test_ = (server: string) => executeAdminTool('admin:mcp_test', { server }, 'u1', true)

beforeEach(() => {
  // spotify-premium deliberately first: the old findFirst returned whichever row
  // came back first, so this ordering is what made it pick the wrong server.
  rows = [
    { id: 'a2', name: 'spotify-premium' },
    { id: 'a1', name: 'spotify' },
    { id: 'a3', name: 'weather' },
  ]
})

describe('resolving an MCP server by name', () => {
  test('an exact name wins over servers that merely contain it', async () => {
    const res = await test_('spotify')
    expect(res.ok).toBe(true)
    // a1 is the exact match; a2 also contains "spotify".
    expect(res.output).toContain('tool-for-a1')
  })

  test('a unique substring still resolves', async () => {
    const res = await test_('premium')
    expect(res.ok).toBe(true)
    expect(res.output).toContain('tool-for-a2')
  })

  test('an ambiguous substring asks instead of guessing', async () => {
    rows = [
      { id: 'b1', name: 'github-issues' },
      { id: 'b2', name: 'github-actions' },
    ]
    const res = await test_('github')
    expect(res.ok).toBe(false)
    expect(res.output).toContain('matches 2 MCP servers')
    expect(res.output).toContain('github-issues')
    expect(res.output).toContain('github-actions')
  })

  test('duplicate names are reported with IDs so the user can still pick', async () => {
    // Two repos whose README omits a name used to install under one label.
    rows = [
      { id: 'c1', name: 'github.com' },
      { id: 'c2', name: 'github.com' },
    ]
    const res = await test_('github.com')
    expect(res.ok).toBe(false)
    expect(res.output).toContain('c1')
    expect(res.output).toContain('c2')
  })

  test('an ID resolves even when it is not a name', async () => {
    const res = await test_('a3')
    expect(res.ok).toBe(true)
    expect(res.output).toContain('tool-for-a3')
  })

  test('no match reports not found', async () => {
    const res = await test_('nope')
    expect(res.ok).toBe(false)
    expect(res.output).toContain('not found')
  })

  test('an empty reference is rejected', async () => {
    const res = await test_('   ')
    expect(res.ok).toBe(false)
    expect(res.output).toContain('required')
  })
})
