/**
 * MCP install — full-path integration test.
 *
 * Everything here is real except the database: it fetches the actual GitHub
 * README over the network, parses the install command out of it, and spawns the
 * real MCP server as a child process to list its tools.
 *
 * This is the test that would have caught the production break — `npx` does not
 * exist in the `oven/bun:1-slim` runtime, so every stdio server failed to start
 * while the unit tests (which stop at the parser) stayed green.
 *
 * Opt-in — needs network + package download. Run: bun run test:integration
 */
import { describe, expect, test, mock } from 'bun:test'

const TARGET_URL = 'https://github.com/weather-mcp/weather-mcp'

// --- in-memory stand-in for the mcpServer table ---------------------------
type Row = Record<string, unknown>
const rows = new Map<string, Row>()
let seq = 0

const mcpServer = {
  create: async ({ data }: { data: Row }) => {
    const id = `mcp-${++seq}`
    const row = { id, ...data }
    rows.set(id, row)
    return row
  },
  findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
  findFirst: async () => null,
  findMany: async () => [...rows.values()],
  update: async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = { ...rows.get(where.id), ...data }
    rows.set(where.id, row)
    return row
  },
  delete: async ({ where }: { where: { id: string } }) => {
    const row = rows.get(where.id)
    rows.delete(where.id)
    return row
  },
}

mock.module('@/lib/db', () => ({
  db: {
    mcpServer,
    auditLog: { create: async () => ({}), findMany: async () => [] },
    user: { findUnique: async () => ({ id: 'u1', role: 'admin' }) },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-1',
  bypassOrg: async (fn: () => unknown) => fn(),
  enterWithOrg: () => {},
}))

const { executeAdminTool } = await import('./admin-tools')

describe('admin:mcp_install — real README, real spawn', () => {
  test('unconfirmed install asks for confirmation and writes nothing', async () => {
    const before = rows.size
    const res = await executeAdminTool('admin:mcp_install', { url: TARGET_URL }, 'u1', false)

    expect(res.confirmationRequired).toBeDefined()
    expect(res.confirmationRequired!.action).toBe('MCP_INSTALL')
    expect(res.confirmationRequired!.message).toContain(TARGET_URL)
    expect(rows.size).toBe(before)
  })

  test('confirmed install fetches the README, spawns the server, and lists its tools', async () => {
    const res = await executeAdminTool(
      'admin:mcp_install',
      { url: TARGET_URL, confirm: 'yes' },
      'u1',
      true,
    )

    expect(res.output).toContain('installed and connected')
    expect(res.ok).toBe(true)

    // Name and command came out of the README, not out of the URL.
    expect(res.output).toContain('weather')
    expect(res.output).toContain('@dangahagan/weather-mcp')

    // The child process really answered tools/list.
    const toolCount = Number(res.output.match(/Tools found: (\d+)/)?.[1] ?? 0)
    expect(toolCount).toBeGreaterThan(0)
    expect(res.output).toContain('get_forecast')

    // Row persisted as npx — remapping happens at spawn time, so the stored
    // config stays correct for a Node runtime.
    const saved = [...rows.values()].at(-1)!
    expect(saved.transport).toBe('stdio')
    expect(saved.command).toBe('npx')
    expect(String(saved.args)).toContain('@dangahagan/weather-mcp')
  }, 180_000)
})

describe('admin:mcp_install — uvx (Python) path', () => {
  // The npx half and the uvx half fail for unrelated reasons, so cover both.
  // This one needs `uvx` on PATH; the runtime is installed in the Docker prod
  // stage, and locally via the astral installer into ~/.local/bin.
  test('installing a known uvx server by name spawns it and lists tools', async () => {
    const res = await executeAdminTool(
      'admin:mcp_install',
      { name: 'fetch', confirm: 'yes' },
      'u1',
      true,
    )

    expect(res.output).toContain('installed and connected')
    expect(res.ok).toBe(true)
    expect(res.output).toContain('mcp-server-fetch')

    const toolCount = Number(res.output.match(/Tools found: (\d+)/)?.[1] ?? 0)
    expect(toolCount).toBeGreaterThan(0)

    // The SDK pin has to survive into the stored args, or the server dies on
    // ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions'.
    const saved = [...rows.values()].at(-1)!
    expect(saved.command).toBe('uvx')
    expect(String(saved.args)).toContain('mcp<1.10')
  }, 300_000)
})
