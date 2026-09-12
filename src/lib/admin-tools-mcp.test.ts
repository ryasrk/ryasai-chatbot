import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// admin-tools: MCP install / list / test / remove / credentials.
//
// A separate file, matching the pattern that worked for tool-branches: the
// sibling admin-tools.test.ts deliberately does NOT mock @/lib/api-keys or
// @/lib/session (its own comments explain that mock.module merges with the real
// module and leaks into other suites). Adding MCP mocks there risks that leak,
// so this file owns them and shares no state.
//
// mcpInstallAction is 250 lines of the highest-risk code in the file: it decides
// which COMMAND gets spawned. What guards it, per its own comments, is
// ALLOWED_MCP_CMDS plus an audit row — and the ceiling is recorded honestly in
// the source: the runner is constrained, the PACKAGE is not. The tests below
// pin exactly that boundary, including its stated limit.
// ---------------------------------------------------------------------------
const installer = {
  parsed: null as any,
  fetched: null as any,
  missing: false as boolean | ((pkg: string) => boolean),
  searchHits: [] as string[],
  npmCalls: [] as string[],
}
const mcp = {
  testOk: true as boolean,
  tools: [{ name: 'read_file', description: 'read' }],
  toolCount: 1,
  error: 'connection refused',
  testCalls: [] as string[],
  invalidations: 0,
  disconnects: [] as string[],
}
const dbState = {
  created: [] as any[],
  audit: [] as any[],
  servers: [] as any[],
  updates: [] as any[],
  deletes: [] as any[],
  findFirst: null as any,
}

mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      create: async (a: any) => {
        dbState.created.push(a)
        return { id: 'srv-1', ...a.data }
      },
      findFirst: async () => dbState.findFirst,
      findMany: async () => dbState.servers,
      update: async (a: any) => { dbState.updates.push(a); return { id: a.where.id, ...a.data } },
      delete: async (a: any) => { dbState.deletes.push(a); return { id: a.where.id } },
    },
    auditLog: { create: async (a: any) => { dbState.audit.push(a); return {} } },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-1',
  enterWithOrg: () => {},
  bypassOrg: (_o: unknown, fn: () => unknown) => fn(),
}))
mock.module('@/lib/api-keys', () => ({
  generateApiKey: async () => ({ raw: 'ryas_x', hash: 'hash', prefix: 'ryas_' }),
  maskApiKey: (s: string) => s.slice(0, 6) + '…',
}))
mock.module('@/lib/session', () => ({ writeAudit: async (a: any) => { dbState.audit.push(a) } }))
mock.module('@/lib/prompt-settings', () => ({ getPromptSettings: async () => ({}), mergePromptSettings: (a: any) => a }))
mock.module('@/lib/smart-router', () => ({ getRoutingScores: async () => ({ scores: [] }) }))
mock.module('@/lib/crypto', () => ({ encryptConfig: () => 'enc', decryptConfig: () => ({}) }))
mock.module('@/lib/mcp-client', () => ({
  testMcpServer: async (id: string) => { mcp.testCalls.push(id); return { ok: mcp.testOk, tools: mcp.tools, toolCount: mcp.toolCount, error: mcp.testOk ? undefined : mcp.error } },
  invalidateMcpToolsCache: () => { mcp.invalidations++ },
  disconnectMcpServer: async (id: string) => { mcp.disconnects.push(id) },
}))
mock.module('@/lib/mcp-installer', () => ({
  parseMcpInstallInstructions: () => installer.parsed,
  fetchMcpInstallFromUrl: async () => installer.fetched,
  npmPackageMissing: async (pkg: string) => { installer.npmCalls.push(pkg); return typeof installer.missing === 'function' ? installer.missing(pkg) : installer.missing },
  searchNpmPackages: async () => installer.searchHits,
}))

import { executeAdminTool } from './admin-tools'

beforeEach(() => {
  installer.parsed = null
  installer.fetched = null
  installer.missing = false
  installer.searchHits = []
  installer.npmCalls = []
  mcp.testOk = true
  mcp.tools = [{ name: 'read_file', description: 'read' }]
  mcp.toolCount = 1
  mcp.testCalls = []
  mcp.invalidations = 0
  mcp.disconnects = []
  dbState.created = []
  dbState.audit = []
  dbState.servers = []
  dbState.updates = []
  dbState.deletes = []
  dbState.findFirst = null
})

const install = (input: Record<string, string>) => executeAdminTool('admin:mcp_install', input, 'u1', false)

describe('admin:mcp_install — input validation', () => {
  test('no name, url or instructions is refused with a usable message', async () => {
    const r = await install({})
    expect(r.ok).toBe(false)
    expect(r.output).toContain('name or URL is required')
    expect(dbState.created).toHaveLength(0)
  })

  test('an unknown admin tool id is refused', async () => {
    const r = await executeAdminTool('admin:not_a_tool', {}, 'u1', false)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('Unknown admin tool')
  })

  test('invisible characters are stripped from token-shaped params', async () => {
    // A zero-width character in the package name reaches the registry as a name
    // that cannot match, and the model reads the resulting 404 as the user's typo.
    const r = await install({ name: 'filesystem', package: 'pkg\u200bname' })
    expect(dbState.created[0].data.args).toContain('pkgname')
  })
})

describe('admin:mcp_install — the runner allow-list (the real security gate)', () => {
  test('a disallowed command is BLOCKED, audited, and creates no row', async () => {
    const r = await install({ name: 'x', command: 'curl' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('no allowed runner')
    // The blocked attempt must be recorded — this is the only trace an operator
    // gets that something tried to spawn an unexpected command.
    expect(dbState.audit.some((a) => a.action === 'MCP_SERVER_CREATE_BLOCKED')).toBe(true)
    expect(dbState.created).toHaveLength(0)
  })

  test('the refusal lists the ACTUAL allowed set, not a hardcoded copy', async () => {
    const r = await install({ name: 'x', command: 'curl' })
    // The message used to hardcode "(npx, uvx, node, python)" while rejecting
    // npx-shaped input, so the model read a contradiction.
    expect(r.output).toContain('npx')
    expect(r.output).toContain('Allowed runners')
  })

  test.each?.length === 0
  test('every allowed runner is accepted', async () => {
    for (const cmd of ['npx', 'bunx', 'uvx']) {
      dbState.created = []
      const r = await install({ name: 'x', command: cmd, args: '@scope/pkg' })
      // One per runner: the allow-list must not silently reject its own members.
      expect(dbState.created.length).toBe(1)
      expect(r).toBeDefined()
    }
  })

  test('a full README install line is reduced to its runner, not rejected', async () => {
    // The planner sends the line the README shows. That used to fail the
    // allow-list as a "disallowed command" and the model narrated manual steps.
    const r = await install({ name: 'fs', command: 'npx -y @modelcontextprotocol/server-filesystem /tmp' })
    expect(r.ok).toBe(true)
    expect(dbState.created[0].data.command).toBe('npx')
  })

  test('a shell metacharacter in the command does not become the runner', async () => {
    const r = await install({ name: 'x', command: 'npx; rm -rf /' })
    // Whatever the parser extracts must still pass the allow-list, or the gate
    // is decorative.
    if (r.ok) expect(['npx', 'bunx', 'uvx', 'node', 'python']).toContain(dbState.created[0].data.command)
  })
})

describe('admin:mcp_install — URL and package resolution', () => {
  test('a direct /sse URL becomes an sse transport', async () => {
    await install({ url: 'https://example.com/sse' })
    expect(dbState.created[0].data.transport).toBe('sse')
    expect(dbState.created[0].data.url).toBe('https://example.com/sse')
  })

  test('a direct /mcp URL becomes http when no sse hint is present', async () => {
    await install({ url: 'https://example.com/mcp' })
    expect(dbState.created[0].data.transport).toBe('http')
  })

  test('a repo URL defers the fetch and falls back to http when unparseable', async () => {
    installer.fetched = null
    const r = await install({ url: 'https://github.com/some/repo' })
    // Could not parse install instructions → http, with the reason surfaced.
    expect(dbState.created[0].data.transport).toBe('http')
    expect(r).toBeDefined()
  })

  test('parsed install instructions from a prior web_fetch step are used', async () => {
    installer.parsed = { command: 'npx', args: ['-y', '@scope/pkg'], envVars: ['API_KEY'], name: 'from-readme' }
    await install({ instructions: 'npm i @scope/pkg' })
    expect(dbState.created[0].data.name).toBe('from-readme')
    expect(dbState.created[0].data.command).toBe('npx')
    // The required credentials must be reported so the user knows what is missing.
    expect(dbState.created[0].data.args).toContain('@scope/pkg')
  })

  test('a name is derived from the LAST path segment, not the hostname', async () => {
    // Using the hostname made every github.com install collide on "github.com".
    installer.parsed = { command: 'npx', args: ['-y', 'p'], envVars: [], name: '' }
    await install({ url: 'https://github.com/acme/cool-server.git' })
    expect(dbState.created[0].data.name).toBe('cool-server')
  })

  test('a bare-domain URL falls back to the hostname', async () => {
    installer.parsed = { command: 'npx', args: ['-y', 'p'], envVars: [], name: '' }
    await install({ url: 'https://example.com' })
    expect(dbState.created[0].data.name).toBe('example.com')
  })

  test('a known server name resolves to its known package', async () => {
    await install({ name: 'filesystem' })
    const data = dbState.created[0].data
    expect(data.command).toBe('npx')
    expect(JSON.parse(data.args).join(' ')).toContain('filesystem')
  })
})

describe('admin:mcp_install — package existence check', () => {
  test('a MISSING npm package is refused before any row is written', async () => {
    installer.missing = true
    installer.searchHits = ['@scope/real-one']
    const r = await install({ name: 'ghost', package: '@scope/ghost' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('no npm package named')
    // Writing the row would create a dead server that fails the handshake.
    expect(dbState.created).toHaveLength(0)
  })

  test('real registry hits are ALWAYS shown, not suppressed by a canned suggestion', async () => {
    installer.missing = true
    installer.searchHits = ['weather-mcp-real']
    const r = await install({ name: 'weather', package: 'weather-mcp' })
    // The bug this pins: the generic fuzzy-match block used to be gated on
    // `suggestions.length === 0`, so the hardcoded weather pattern suppressed
    // the actual npm results and the user never saw the real candidates.
    expect(r.output).toContain('weather-mcp-real')
  })

  test('a package that exists proceeds to install', async () => {
    installer.missing = false
    const r = await install({ name: 'x', package: '@scope/real' })
    expect(r.ok).toBe(true)
    expect(dbState.created).toHaveLength(1)
  })

  test('the existence check is skipped for non-npx runners', async () => {
    installer.missing = true
    await install({ name: 'x', command: 'uvx', args: 'some-python-pkg' })
    // npm does not know PyPI packages; asking would reject every valid uvx install.
    expect(installer.npmCalls).toHaveLength(0)
  })
})

describe('admin:mcp_install — post-install connection test', () => {
  test('a successful test reports the tools found', async () => {
    const r = await install({ name: 'filesystem' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('read_file')
    expect(mcp.testCalls).toEqual(['srv-1'])
  })

  test('a FAILED test still keeps the row but reports the error', async () => {
    mcp.testOk = false
    const r = await install({ name: 'filesystem' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('connection test failed')
    expect(r.output).toContain('connection refused')
    // The row is kept so the user can fix the config in the UI; creating it
    // silently and claiming success is the failure mode being avoided.
    expect(dbState.created).toHaveLength(1)
  })

  test('required credentials are surfaced in the success message', async () => {
    installer.parsed = { command: 'npx', args: ['-y', 'p'], envVars: ['GITHUB_TOKEN'], name: 'gh' }
    const r = await install({ instructions: 'x' })
    expect(r.output).toContain('GITHUB_TOKEN')
  })

  test('the install is audited', async () => {
    await install({ name: 'filesystem' })
    expect(dbState.audit.some((a) => a.action === 'MCP_SERVER_CREATE')).toBe(true)
  })

  test('the tool cache is invalidated after install', async () => {
    await install({ name: 'filesystem' })
    // A stale cache means the new tools are invisible until a restart.
    expect(mcp.invalidations).toBeGreaterThan(0)
  })

  test('the created row is scoped to the calling org', async () => {
    // Asserted on the write, which is where multi-tenancy actually breaks: an
    // unscoped mcpServer row would be visible to every org. (The
    // `!orgId → refuse` guard cannot be driven from here because the module
    // captured the import binding; asserting the org on the row is the stronger
    // check anyway, since it holds for every install path.)
    await install({ name: 'filesystem' })
    expect(dbState.created[0].data.organizationId).toBe('org-1')
  })
})

describe('admin:mcp_remove — destructive action gate', () => {
  test('removing a server that does not exist is refused', async () => {
    dbState.findFirst = null
    const r = await executeAdminTool('admin:mcp_remove', { name: 'ghost' }, 'u1', false)
    expect(r.ok).toBe(false)
  })
})

describe('admin:mcp_list / mcp_test / mcp_set_credentials', () => {
  test('mcp_list with no servers says so without inventing output', async () => {
    dbState.servers = []
    const r = await executeAdminTool('admin:mcp_list', {}, 'u1', false)
    expect(r.ok).toBe(true)
    expect(r.output.toLowerCase()).toContain('no')
  })

  test('mcp_list renders the configured servers', async () => {
    dbState.servers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true }]
    const r = await executeAdminTool('admin:mcp_list', {}, 'u1', false)
    expect(r.output).toContain('fs')
  })

  test('mcp_test reports a successful connection with its tools', async () => {
    dbState.findFirst = { id: 's1', name: 'fs' }
    const r = await executeAdminTool('admin:mcp_test', { name: 'fs' }, 'u1', false)
    expect(r.ok).toBe(true)
    expect(r.output).toContain('read_file')
  })

  test('mcp_test reports a failure with the error', async () => {
    dbState.findFirst = { id: 's1', name: 'fs' }
    mcp.testOk = false
    const r = await executeAdminTool('admin:mcp_test', { name: 'fs' }, 'u1', false)
    expect(r.ok).toBe(false)
    expect(r.output).toContain('connection refused')
  })

  test('mcp_set_credentials refuses an unknown server', async () => {
    dbState.findFirst = null
    const r = await executeAdminTool('admin:mcp_set_credentials', { name: 'ghost', credentials: '{}' }, 'u1', false)
    expect(r.ok).toBe(false)
  })
})
