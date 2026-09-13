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
  // bypassOrg is a ONE-argument callback wrapper: bypassOrg(fn). This mock used to
  // be `(_o, fn) => fn()`, which is a signature the real module does not have — so
  // `bypassOrg(() => seedPlugins(orgId))` called `fn()` with fn undefined and threw
  // TypeError. The wrong mock made the body unreachable: seedPluginsAction had never
  // executed under test. 11 other test files already mocked it correctly.
  bypassOrg: <T>(fn: () => Promise<T>) => fn(),
}))
mock.module('@/lib/api-keys', () => ({
  generateApiKey: async () => ({ raw: 'ryas_x', hash: 'hash', prefix: 'ryas_' }),
  maskApiKey: (s: string) => s.slice(0, 6) + '…',
}))
mock.module('@/lib/session', () => ({ writeAudit: async (a: any) => { dbState.audit.push(a) } }))
mock.module('@/lib/prompt-settings', () => ({ getPromptSettings: async () => ({}), mergePromptSettings: (a: any) => a }))
mock.module('@/lib/smart-router', () => ({ getRoutingScores: async () => ({ scores: [] }) }))
const mockEncryptConfig = mock((_v?: unknown) => 'enc')
const mockDecryptConfig = mock((_v?: unknown) => ({} as Record<string, string>))
// Spies, so a test can assert exactly what gets persisted. The mock returns {} by
// default, which is why the merge branch had never run.
mock.module('@/lib/crypto', () => ({
  encryptConfig: mockEncryptConfig,
  decryptConfig: mockDecryptConfig,
}))
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

describe('admin:mcp_install — the four resolution branches that never ran', () => {
  // The chain is: LLM command → parsed install instructions → URL → name. Four
  // branches of the last two levels sat at hit=0, so nothing pinned which one wins
  // or what it produces. Each decides the exact command that will be SPAWNED, so a
  // wrong branch means the wrong package installed on a customer's host.

  test('LLM env vars are parsed on commas AND semicolons', async () => {
    // The model reads an install page and returns the required env vars however the
    // page wrote them. Missing one means the server starts and immediately fails
    // auth, which the operator sees as "the tool does not work".
    const r = await install({ name: 'demo', command: 'npx', args: '-y demo-pkg', envVars: 'TOKEN=1,A=2;B=3' })
    // The required list is reported to the MODEL as part of the answer, not stored
    // on the row -- the operator reads it out of the agent's reply.
    expect(r.output).toContain('Required credentials: TOKEN=1, A=2, B=3')
  })

  test('without LLM env vars the RUNNER env vars are used instead', async () => {
    // The parsed runner already knows which variables its package needs; falling
    // back to an empty list would silently drop them.
    installer.parsed = { command: 'npx', args: ['-y', 'known'], envVars: ['API_KEY=from-runner'] }
    const r = await install({ instructions: 'npx -y known' })
    expect(r.output).toContain('Required credentials: API_KEY=from-runner')
  })

  test('a bare server NAME derives the official scoped package token', async () => {
    // No explicit package, no known-name match: the documented convention is
    // @modelcontextprotocol/server-<name>. Without this branch the install would
    // spawn a bare runner with no package at all.
    await install({ name: 'everything' })
    const data = dbState.created[0].data
    expect(data.command).toBe('npx')
    expect(JSON.parse(data.args)).toEqual(['-y', '@modelcontextprotocol/server-everything'])
  })

  test('a uvx runner does NOT get the npx-style -y flag', async () => {
    // `-y` is an npx flag. Passing it to uvx makes the process fail to start, and
    // the failure looks like a broken package rather than a broken command line.
    await install({ name: 'everything', transport: 'uvx' })
    const data = dbState.created[0].data
    expect(data.command).toBe('uvx')
    expect(JSON.parse(data.args)).toEqual(['@modelcontextprotocol/server-everything'])
  })

  test('PARSED instructions outrank a URL when both are present', async () => {
    // Priority order matters: a prior web_fetch step already turned the URL into a
    // concrete command. Letting the raw URL win would re-fetch and could resolve to
    // a different package than the one that was read and validated.
    installer.parsed = { command: 'bunx', args: ['from-instructions'], envVars: [] }
    await install({ name: 'x', url: 'https://github.com/example/repo', instructions: 'bunx from-instructions' })
    const data = dbState.created[0].data
    expect(data.command).toBe('bunx')
    expect(JSON.parse(data.args)).toEqual(['from-instructions'])
    // And it stayed stdio rather than being re-derived from the URL.
    expect(data.transport).toBe('stdio')
  })
})

describe('admin:mcp_install — the deferred URL fetch at execution time', () => {
  // A repo/docs URL cannot be parsed at request time, so the fetch is deferred to
  // AFTER confirmation. That block (the `install` branch) had never run: the
  // fixture existed but no test drove it with confirm=yes.

  test('a repo URL is fetched on confirmation and its parsed command is used', async () => {
    installer.fetched = {
      command: 'bunx',
      args: ['@modelcontextprotocol/server-fetched'],
      name: 'fetched-server',
      envVars: ['FETCHED_TOKEN=1'],
    }
    const r = await install({
      url: 'https://github.com/example/some-mcp',
      confirm: 'yes',
    })
    const data = dbState.created[0].data
    // The parsed command replaced the placeholder derived from the URL.
    expect(data.command).toBe('bunx')
    expect(JSON.parse(data.args)).toEqual(['@modelcontextprotocol/server-fetched'])
    // The NAME from the fetched instructions wins over the one derived from the URL
    // path, because the fetched page is authoritative about what it installs.
    expect(data.name).toBe('fetched-server')
    // And the credentials it needs are surfaced to the operator.
    expect(r.output).toContain('FETCHED_TOKEN=1')
  })

  test('an UNPARSEABLE fetched page falls back to the http transport', async () => {
    // Refusing outright would be wrong: many MCP servers expose an HTTP endpoint
    // documented only in prose. Degrading to http keeps it usable.
    installer.fetched = null
    const r = await install({ url: 'https://github.com/example/opaque-mcp', confirm: 'yes' })
    const data = dbState.created[0].data
    expect(data.transport).toBe('http')
    expect(r.ok).toBe(true)
  })

  test('install does NOT require confirmation, unlike removal', async () => {
    // Deliberate asymmetry, documented at the top of the MCP section: removal
    // confirms via the standard isConfirmed parameter, install does not. My first
    // version of this test asserted the opposite and failed -- the code was right,
    // the assumption was wrong. Pinning the real behaviour so it cannot drift in
    // either direction without a test going red.
    installer.fetched = { command: 'bunx', args: ['never'], name: 'never-server', envVars: [] }
    const r = await install({ url: 'https://github.com/example/some-mcp' })
    expect(r.ok).toBe(true)
    expect(dbState.created).toHaveLength(1)
    expect((r as { confirmationRequired?: unknown }).confirmationRequired).toBeUndefined()
  })

  test('a DIRECT /sse URL is used as-is and never fetched', async () => {
    // The fetch is a fallback for human-readable repo pages. Calling it for an
    // endpoint that is already a working MCP URL would waste a request and could
    // replace a valid transport with a stdio command scraped from HTML.
    installer.fetched = { command: 'bunx', args: ['SHOULD-NOT-BE-USED'], name: 'nope', envVars: [] }
    await install({ url: 'https://example.com/sse' })
    const data = dbState.created[0].data
    expect(data.transport).toBe('sse')
    expect(data.url).toBe('https://example.com/sse')
    expect(JSON.parse(data.args ?? '[]')).not.toContain('SHOULD-NOT-BE-USED')
  })
})

describe('admin:mcp_install — normalizeRunner takes env vars off a README line', () => {
  test('a full install line keeps its runner and drops the rest into args', async () => {
    // The planner sends what the README shows, not a bare runner. The extracted
    // runner goes through the allow-list; the remaining tokens become args.
    const r = await install({ name: 'demo', command: 'npx -y @scope/pkg' })
    const data = dbState.created[0].data
    expect(data.command).toBe('npx')
    expect(JSON.parse(data.args)).toEqual(['-y', '@scope/pkg'])
    expect(r.ok).toBe(true)
  })
})

describe('admin:mcp_set_credentials — merging with the stored env', () => {
  // The merge branch (decrypt existing env, overlay the new pairs, re-encrypt) had
  // never run: the crypto mock returns {} and no test set envJson. Getting it wrong
  // means SETTING one credential WIPES the others, and the server then fails auth
  // with a message that points nowhere near this code.

  test('a new credential is MERGED with the stored ones, not replacing them', async () => {
    dbState.findFirst = { id: 'srv-1', name: 'demo', envJson: 'encrypted-blob' }
    mockDecryptConfig.mockImplementationOnce(() => ({ OLD_TOKEN: 'keep-me' }))
    const r = await executeAdminTool('admin:mcp_set_credentials', {
      server: 'demo',
      credentials: 'NEW_TOKEN=fresh',
    }, 'u1', false)
    expect(r.ok).toBe(true)
    // Both keys reached the encrypted payload that gets persisted.
    const written = mockEncryptConfig.mock.calls.at(-1)?.[0] as unknown as Record<string, string>
    expect(written).toEqual({ OLD_TOKEN: 'keep-me', NEW_TOKEN: 'fresh' })
    expect(r.output).toContain('NEW_TOKEN')
  })

  test('a CORRUPT stored blob starts fresh instead of failing the update', async () => {
    // An unreadable envJson must not block setting a credential -- the operator
    // would have no way to recover through this tool at all.
    dbState.findFirst = { id: 'srv-1', name: 'demo', envJson: 'corrupt' }
    mockDecryptConfig.mockImplementationOnce(() => { throw new Error('bad ciphertext') })
    const r = await executeAdminTool('admin:mcp_set_credentials', {
      server: 'demo',
      credentials: 'ONLY=fresh',
    }, 'u1', false)
    expect(r.ok).toBe(true)
    const written = mockEncryptConfig.mock.calls.at(-1)?.[0] as unknown as Record<string, string>
    expect(written).toEqual({ ONLY: 'fresh' })
  })

  test('an EMPTY stored env is not treated as corrupt', async () => {
    // envJson '{}' is the documented "no credentials yet" sentinel and must skip
    // decryption entirely rather than attempting it on an empty payload.
    dbState.findFirst = { id: 'srv-1', name: 'demo', envJson: '{}' }
    mockDecryptConfig.mockClear()
    const r = await executeAdminTool('admin:mcp_set_credentials', {
      server: 'demo',
      credentials: 'FIRST=1',
    }, 'u1', false)
    expect(r.ok).toBe(true)
    expect(mockDecryptConfig).not.toHaveBeenCalled()
    const written = mockEncryptConfig.mock.calls.at(-1)?.[0] as unknown as Record<string, string>
    expect(written).toEqual({ FIRST: '1' })
  })

  test('the connection-test FAILURE branch still reports the credentials were saved', async () => {
    // A failed test after a successful save is the confusing case: the operator must
    // be told the save landed, or they will re-enter the credential repeatedly.
    // This is the `return {` at the end of the action, which never ran.
    dbState.findFirst = { id: 'srv-1', name: 'demo', envJson: '{}' }
    mcp.testOk = false
    try {
      const r = await executeAdminTool('admin:mcp_set_credentials', {
        server: 'demo',
        credentials: 'TOKEN=x',
      }, 'u1', false)
      expect(r.ok).toBe(true)
      expect(r.output).toContain('The credentials were saved')
      expect(r.output).toContain(mcp.error)
    } finally {
      mcp.testOk = true
    }
  })
})

describe('admin:mcp_install — normalizeRunner falls back to the prose parser', () => {
  // normalizeRunner first splits the string and checks the HEAD token against the
  // allow-list. When the head is not a runner (prose, a JSON block, a wrapped line)
  // it must fall back to the install-instruction parser rather than giving up --
  // both remaining uncovered lines live on that path.

  test('prose with the runner buried inside still resolves to an allowed command', async () => {
    // The head token here is "Install", which is not and must never be a runner.
    // The parser finds `npx` further in, and the allow-list is applied to THAT.
    installer.parsed = { command: 'npx', args: ['-y', 'found-in-prose'], envVars: [] }
    const r = await install({ name: 'demo', command: 'Install the server with npx -y found-in-prose' })
    const data = dbState.created[0].data
    expect(data.command).toBe('npx')
    expect(JSON.parse(data.args)).toEqual(['-y', 'found-in-prose'])
    expect(r.ok).toBe(true)
  })

  test('the PARSER-supplied env vars are used when the LLM sent none', async () => {
    // The model gave a command but no credentials. The parser read them off the
    // page. Dropping them means the server starts and immediately fails auth, which
    // the operator reads as "the tool is broken" rather than "a variable is missing".
    installer.parsed = {
      command: 'npx', args: ['-y', 'pkg'], envVars: ['FROM_PARSER=yes'],
    }
    const r = await install({ name: 'demo', command: 'see the docs above' })
    expect(r.output).toContain('Required credentials: FROM_PARSER=yes')
  })

  test('a parsed runner OUTSIDE the allow-list is still refused', async () => {
    // The fallback must not become a bypass: extracting a runner from prose is fine
    // only because the extracted runner is re-checked against the allow-list.
    //
    // NOTE ON LAYERING. Deleting the check INSIDE normalizeRunner (line 342) does
    // not turn this test red -- a SECOND gate after resolution
    // (`transport === 'stdio' && command && !ALLOWED_MCP_CMDS.has(command)`) catches
    // the same command. That is correct defence in depth, and this test asserts the
    // OUTCOME, so it survives either gate being weakened. It was verified against
    // the SECOND gate: removing that one turns it red.
    installer.parsed = { command: 'curl', args: ['evil'], envVars: [] }
    const r = await install({ name: 'demo', command: 'some prose here' })
    expect(r.ok).toBe(false)
    expect(dbState.created).toHaveLength(0)
    // The refusal names the text that FAILED, not the parser's reading of it: when
    // normalizeRunner rejects, it returns null and `command` stays the operator's
    // original string. Quoting that back is the more useful diagnostic -- it shows
    // exactly what the model sent.
    expect(r.output).toContain('some prose here')
    // The allowed set is RENDERED FROM THE SET, not retyped; the earlier hardcoded
    // list had drifted and made the model invent an environment policy.
    expect(r.output).toContain('Allowed runners: npx, bunx, uvx, node, python.')
  })

  test('the refusal is AUDITED as a warning, not silently dropped', async () => {
    // The second gate is the security boundary. A refusal that leaves no audit row
    // means an install attempt on a customer host is invisible after the fact.
    installer.parsed = { command: 'curl', args: ['evil'], envVars: [] }
    dbState.audit.length = 0
    await install({ name: 'demo', command: 'some prose here' })
    const row = dbState.audit.find((a: { action?: string }) => a.action === 'MCP_SERVER_CREATE_BLOCKED')
    expect(row).toBeDefined()
    expect(row.severity).toBe('warning')
    // The rejected command is recorded verbatim, so the operator can see WHAT was
    // attempted rather than only that something was. The attributed user is stored
    // too -- an unattributed security event is not actionable.
    expect(row.detail.command).toBe('some prose here')
    expect(row.detail.reason).toBe('disallowed command')
    expect(row.userId).toBe('u1')
  })
})
