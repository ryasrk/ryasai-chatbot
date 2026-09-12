/**
 * Tests for the non-MCP admin tool actions in `src/lib/admin-tools.ts`.
 *
 * Why this file exists: the 214 uncovered lines there were almost entirely these
 * actions. `admin-tools-mcp.test.ts` covers `admin:mcp_install` thoroughly but its
 * `db` mock exposes only `mcpServer`/`auditLog`, so none of the other eighteen
 * tool ids had ever been executed.
 *
 * The behaviour that matters most here is the CONFIRMATION GATE. `set_prompt`,
 * `toggle_tool`, `toggle_integration` and `toggle_document` all mutate persistent
 * state that changes how every future answer is produced, and the caller is an
 * LLM planner. If `isConfirmed` were ignored, the model could rewrite the system
 * prompt — or disable the SQL guardrails' tool set — from a single tool call with
 * no human in the loop. So every one of them is asserted BOTH ways: without
 * confirmation nothing is written and `confirmationRequired` comes back, with
 * confirmation the write happens.
 *
 * Separate file: the existing admin-tools test files each mock a narrow `db`
 * surface, and widening one of them would change the module graph it was written
 * against.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

const dbState = {
  apiKeys: [] as any[],
  appConfigs: [] as any[],
  appConfigUpdates: [] as any[],
  appConfigCreates: [] as any[],
  integrations: [] as any[],
  integrationUpdates: [] as any[],
  documents: [] as any[],
  documentUpdates: [] as any[],
  audit: [] as any[],
  toolRunCount: 3,
  avgLatency: 120,
  failedApi: 1,
  counts: { integration: 2, document: 5 },
  auditLogs: [] as any[],
  plugins: [] as any[],
  schedules: [] as any[],
  mcpServers: [] as any[],
  mcpUpdates: [] as any[],
  mcpDeletes: [] as any[],
  mcpCreates: [] as any[],
  seedCalls: [] as string[],
}

mock.module('@/lib/db', () => ({
  db: {
    apiKey: { create: async (a: any) => { dbState.apiKeys.push(a); return { id: 'key-1', ...a.data } } },
    appConfig: {
      findFirst: async () => dbState.appConfigs[0] ?? null,
      update: async (a: any) => { dbState.appConfigUpdates.push(a); return a },
      create: async (a: any) => { dbState.appConfigCreates.push(a); return a },
    },
    integration: {
      findFirst: async (a: any) => dbState.integrations.find((i) => a.where.OR.some((c: any) => c.id === i.id || (c.name && i.name.includes(c.name.contains)))) ?? null,
      findMany: async () => dbState.integrations,
      update: async (a: any) => { dbState.integrationUpdates.push(a); return a },
      count: async () => dbState.counts.integration,
    },
    document: {
      findFirst: async (a: any) => dbState.documents.find((d) => a.where.OR.some((c: any) => c.id === d.id || (c.name && d.name.includes(c.name.contains)))) ?? null,
      update: async (a: any) => { dbState.documentUpdates.push(a); return a },
      count: async () => dbState.counts.document,
    },
    toolRun: {
      count: async () => dbState.toolRunCount,
      aggregate: async () => ({ _avg: { latencyMs: dbState.avgLatency } }),
    },
    apiRequestLog: { count: async () => dbState.failedApi },
    auditLog: { findMany: async () => dbState.auditLogs, create: async (a: any) => { dbState.audit.push(a); return {} } },
    plugin: {
      findMany: async () => dbState.plugins,
      // Added so seedPluginsAction can run: it counts plugins before and after
      // seeding. Without `count` the action threw, which is why it had never
      // executed under a test.
      count: async () => dbState.plugins.length,
    },
    scheduledRun: { findMany: async () => dbState.schedules },
    mcpServer: {
      // findMany must honour `where.name.contains` — resolveMcpServer decides
      // between 0, 1 and MANY matches from this result, and a mock that always
      // returns everything makes the "many matches" branch unreachable.
      findMany: async (a: any) => {
        const q = a?.where?.name?.contains
        if (!q) return dbState.mcpServers
        return dbState.mcpServers.filter((m) => String(m.name).toLowerCase().includes(String(q).toLowerCase()))
      },
      // findFirst must honour `where.id`. Returning servers[0] unconditionally
      // made byId succeed for EVERY query, so resolveMcpServer always took the
      // by-id path and the ambiguity branch could never run — a defective test
      // double hiding a production path.
      findFirst: async (a: any) => dbState.mcpServers.find((m) => m.id === a?.where?.id) ?? null,
      update: async (a: any) => { dbState.mcpUpdates.push(a); return a },
      delete: async (a: any) => { dbState.mcpDeletes.push(a); return a },
      create: async (a: any) => { dbState.mcpCreates.push(a); return a },
    },
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
  generateApiKey: () => ({ plainText: 'ryas_SECRET', hash: 'hash', prefix: 'ryas_abc' }),
  maskApiKey: (s: string) => s.slice(0, 6) + '…',
}))
mock.module('@/lib/session', () => ({ writeAudit: async (a: any) => { dbState.audit.push(a) } }))

const promptState = {
  settings: { systemPrompt: 'old prompt', tools: { sql: true, rag: true, restApi: true }, ragContextPrompt: '', toolDiversity: 2 },
  merged: null as any,
}
mock.module('@/lib/prompt-settings', () => ({
  getPromptSettings: async () => promptState.settings,
  // Records what the action asked to merge, so the test can assert the INTENT
  // rather than only the shape of the resulting JSON string.
  mergePromptSettings: (cur: any, patch: any) => {
    const merged = { ...cur, ...patch, tools: { ...cur.tools, ...(patch.tools ?? {}) } }
    promptState.merged = { cur, patch, merged }
    return merged
  },
}))
const routingState = { scores: [] as any[], throws: null as Error | null }
mock.module('@/lib/smart-router', () => ({
  getRoutingScores: async () => {
    if (routingState.throws) throw routingState.throws
    return { scores: routingState.scores }
  },
}))
mock.module('@/lib/plugin-registry', () => ({ listEnabledPlugins: async () => [] }))
mock.module('@/lib/mcp-client', () => ({
  testMcpServer: async () => ({ ok: true, tools: [], toolCount: 0 }),
  invalidateMcpToolsCache: () => {},
  disconnectMcpServer: async () => {},
}))
mock.module('@/lib/mcp-installer', () => ({
  parseMcpInstallInstructions: () => null,
  fetchMcpInstallFromUrl: async () => null,
  npmPackageMissing: async () => false,
  searchNpmPackages: async () => [],
}))
mock.module('@/lib/mcp-seed-plugins', () => ({ seedBuiltinPlugins: async () => ({ created: 2, skipped: 1 }) }))
// seedPlugins writes many org-scoped rows; mocking it keeps this file about the
// ACTION (org context, before/after counts, audit) rather than about seeding.
// Before this mock existed the real module ran and threw on a missing db model,
// which is how it became clear seedPluginsAction had never executed under test.
mock.module('@/lib/plugin-seeds', () => ({
  seedPlugins: async (orgId: string) => {
    dbState.seedCalls.push(orgId)
    dbState.plugins.push({ id: 'seeded-1' }, { id: 'seeded-2' })
    return { created: 2, skipped: 0 }
  },
}))

import { executeAdminTool } from './admin-tools'

beforeEach(() => {
  dbState.apiKeys = []
  dbState.appConfigs = []
  dbState.appConfigUpdates = []
  dbState.appConfigCreates = []
  dbState.integrations = []
  dbState.integrationUpdates = []
  dbState.documents = []
  dbState.documentUpdates = []
  dbState.audit = []
  dbState.toolRunCount = 3
  dbState.avgLatency = 120
  dbState.failedApi = 1
  dbState.counts = { integration: 2, document: 5 }
  dbState.auditLogs = []
  dbState.plugins = []
  dbState.schedules = []
  dbState.mcpServers = []
  dbState.mcpUpdates = []
  dbState.mcpDeletes = []
  dbState.mcpCreates = []
  dbState.seedCalls = []
  promptState.settings = { systemPrompt: 'old prompt', tools: { sql: true, rag: true, restApi: true }, ragContextPrompt: '', toolDiversity: 2 }
  promptState.merged = null
  routingState.scores = []
  routingState.throws = null
})

const call = (toolId: string, input: Record<string, string> = {}, confirmed = false) =>
  executeAdminTool(toolId, input, 'user-1', confirmed)

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------
describe('executeAdminTool — dispatcher', () => {
  test('an unknown tool id is refused by name, not by throwing', async () => {
    const r = await call('admin:does_not_exist')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('admin:does_not_exist')
  })

  test('every documented tool id resolves to a handler (no id silently unimplemented)', async () => {
    const ids = [
      'admin:generate_api_key', 'admin:show_monitoring', 'admin:show_audit_log',
      'admin:list_integrations', 'admin:list_plugins', 'admin:list_schedules',
      'admin:show_prompt', 'admin:set_prompt', 'admin:toggle_tool',
      'admin:toggle_integration', 'admin:toggle_document', 'admin:routing_scores',
      'admin:reindex_status', 'admin:mcp_list',
    ]
    for (const id of ids) {
      const r = await call(id)
      // An unhandled id falls to the default branch; assert none of them do.
      expect(r.output, `${id} fell through to the default branch`).not.toContain('Unknown admin tool')
    }
  })
})

// ---------------------------------------------------------------------------
// generate_api_key
// ---------------------------------------------------------------------------
describe('admin:generate_api_key', () => {
  test('returns the plaintext key exactly once and never stores it', async () => {
    const r = await call('admin:generate_api_key', { label: 'agent-key' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('ryas_SECRET')
    // Only the HASH may be persisted. A stored plaintext key is a credential leak
    // the moment anyone reads the table.
    const stored = JSON.stringify(dbState.apiKeys[0])
    expect(stored).not.toContain('ryas_SECRET')
    expect(dbState.apiKeys[0].data.keyHash).toBe('hash')
  })

  test('the key is scoped to the calling org', async () => {
    await call('admin:generate_api_key')
    expect(dbState.apiKeys[0].data.organizationId).toBe('org-1')
  })

  test('a label defaults to a dated one when none is given', async () => {
    await call('admin:generate_api_key')
    expect(dbState.apiKeys[0].data.label).toMatch(/^Agent-\d{4}-\d{2}-\d{2}$/)
  })

  test('generating a key is audit-logged as a warning', async () => {
    await call('admin:generate_api_key', { label: 'k' })
    const row = dbState.audit.find((a) => a.action === 'API_KEY_GENERATED')
    expect(row).toBeTruthy()
    expect(row.severity).toBe('warning')
  })
})

// ---------------------------------------------------------------------------
// read-only actions
// ---------------------------------------------------------------------------
describe('read-only admin actions', () => {
  test('show_monitoring reports the counts and a rounded average', async () => {
    const r = await call('admin:show_monitoring')
    expect(r.output).toContain('Tool Runs: 3')
    expect(r.output).toContain('Avg Latency: 120ms')
    expect(r.output).toContain('Active Integrations: 2')
  })

  test('a NULL average latency reports 0ms, not NaN', async () => {
    dbState.avgLatency = null as any
    const r = await call('admin:show_monitoring')
    // NaN would read as a broken metric rather than "no data yet".
    expect(r.output).not.toContain('NaN')
    expect(r.output).toContain('Avg Latency: 0ms')
  })

  test('empty lists say so instead of printing a bare header', async () => {
    for (const [id, msg] of [
      ['admin:list_integrations', 'No database integrations found.'],
      ['admin:list_plugins', 'No plugins registered.'],
      ['admin:list_schedules', 'No scheduled runs found.'],
      ['admin:show_audit_log', 'No audit logs found.'],
    ] as const) {
      const r = await call(id)
      expect(r.output, id).toBe(msg)
    }
  })

  test('a schedule without a next run renders "-" rather than an invalid date', async () => {
    dbState.schedules = [{ name: 'nightly', cronExpr: '0 2 * * *', isActive: true, nextRunAt: null }]
    const r = await call('admin:list_schedules')
    expect(r.output).toContain('next: -')
  })

  test('show_prompt renders the toggles and truncates a long prompt', async () => {
    promptState.settings.systemPrompt = 'x'.repeat(900)
    const r = await call('admin:show_prompt')
    expect(r.output).toContain('SQL: ON')
    expect(r.output).toContain('...')
    expect(r.output.length).toBeLessThan(900)
  })

  test('reindex_status counts only ready AND enabled documents', async () => {
    const r = await call('admin:reindex_status')
    expect(r.output).toContain('5 documents ready')
  })

  test('routing_scores flags a tripped circuit breaker', async () => {
    routingState.scores = [
      { tool: 'SQL', finalScore: 0.5, circuitBreakerTripped: false },
      { tool: 'RAG', finalScore: 0, circuitBreakerTripped: true },
    ]
    const r = await call('admin:routing_scores')
    expect(r.output).toContain('SQL: score=0.50')
    expect(r.output).toContain('[CIRCUIT BREAKER]')
  })
})

// ---------------------------------------------------------------------------
// THE CONFIRMATION GATE — asserted both ways for every mutating action
// ---------------------------------------------------------------------------
describe('set_prompt — confirmation gate', () => {
  test('WITHOUT confirmation: nothing is written and a confirmation comes back', async () => {
    const r = await call('admin:set_prompt', { prompt: 'new prompt' })
    expect(r.ok).toBe(false)
    expect(r.confirmationRequired?.action).toBe('SET_PROMPT')
    // The whole point: no side effect before the human agrees.
    expect(dbState.appConfigUpdates).toHaveLength(0)
    expect(dbState.appConfigCreates).toHaveLength(0)
    // The prompt shows its LENGTH, not its text. That is a deliberate choice for a
    // field that can be thousands of characters, but it does mean the model asks
    // the human to approve a change they cannot read in the confirmation itself.
    // Recorded in the doc as a UX gap rather than asserted away.
    expect(r.confirmationRequired?.message).toContain('10 characters')
    expect(r.confirmationRequired?.message).not.toContain('new prompt')
  })

  test('WITH confirmation: the prompt is persisted', async () => {
    const r = await call('admin:set_prompt', { prompt: 'new prompt' }, true)
    expect(r.ok).toBe(true)
    expect(dbState.appConfigCreates).toHaveLength(1)
    expect(dbState.appConfigCreates[0].data.promptSettings).toContain('new prompt')
  })

  test('an empty prompt is refused before the confirmation gate', async () => {
    const r = await call('admin:set_prompt', { prompt: '   ' })
    // Asking "are you sure?" about a no-op would be worse than refusing outright.
    expect(r.confirmationRequired).toBeUndefined()
    expect(r.ok).toBe(false)
    expect(r.output).toContain('cannot be empty')
  })

  test('surrounding quotes are stripped, not stored as part of the prompt', async () => {
    await call('admin:set_prompt', { prompt: '"shouty prompt"' }, true)
    expect(dbState.appConfigCreates[0].data.promptSettings).toContain('shouty prompt')
    expect(dbState.appConfigCreates[0].data.promptSettings).not.toContain('\\"shouty')
  })

  test('an existing AppConfig is UPDATED, not duplicated', async () => {
    dbState.appConfigs = [{ id: 'cfg-1' }]
    await call('admin:set_prompt', { prompt: 'x' }, true)
    expect(dbState.appConfigUpdates).toHaveLength(1)
    expect(dbState.appConfigCreates).toHaveLength(0)
  })

  test('the write is audited with the actor and a warning severity', async () => {
    await call('admin:set_prompt', { prompt: 'x' }, true)
    const row = dbState.audit.find((a) => a.action === 'PROMPT_TOOLS_UPDATE')
    expect(row.userId).toBe('user-1')
    expect(row.severity).toBe('warning')
  })
})

describe('toggle_tool — confirmation gate', () => {
  test('WITHOUT confirmation: the tool state is untouched', async () => {
    const r = await call('admin:toggle_tool', { tool: 'sql', action: 'disable' })
    expect(r.confirmationRequired?.action).toBe('TOGGLE_TOOL')
    expect(dbState.appConfigUpdates).toHaveLength(0)
    expect(dbState.appConfigCreates).toHaveLength(0)
  })

  test('WITH confirmation: disabling SQL reaches the merge as false', async () => {
    await call('admin:toggle_tool', { tool: 'sql', action: 'disable' }, true)
    // Assert the INTENT passed to the merge, not just that some JSON was written.
    expect(promptState.merged.patch).toEqual({ tools: { sql: false } })
  })

  test('the `rest` / `restapi` aliases both map to the restApi key', async () => {
    await call('admin:toggle_tool', { tool: 'rest api', action: 'disable' }, true)
    expect(promptState.merged.patch.tools).toHaveProperty('restApi', false)
  })

  test('every enable spelling means enabled', async () => {
    for (const word of ['enable', 'on', 'true', 'ENABLE']) {
      promptState.merged = null
      await call('admin:toggle_tool', { tool: 'rag', action: word }, true)
      expect(promptState.merged.patch.tools.rag, word).toBe(true)
    }
  })

  test('an unknown tool name is refused, and NOT with a confirmation prompt', async () => {
    const r = await call('admin:toggle_tool', { tool: 'database', action: 'disable' })
    expect(r.ok).toBe(false)
    // The name is validated BEFORE asking for confirmation, so a typo does not
    // produce a scary "are you sure?" for something that cannot happen.
    expect(r.confirmationRequired).toBeUndefined()
    expect(r.output).toContain('Unknown tool')
  })
})

describe('toggle_integration — confirmation gate', () => {
  const seed = () => { dbState.integrations = [{ id: 'int-1', name: 'warehouse', status: 'active' }] }

  test('WITHOUT confirmation: no update is issued', async () => {
    seed()
    const r = await call('admin:toggle_integration', { integration: 'warehouse', action: 'disable' })
    expect(r.confirmationRequired?.action).toBe('TOGGLE_INTEGRATION')
    expect(dbState.integrationUpdates).toHaveLength(0)
    // The name is resolved first so the prompt can name what will change.
    expect(r.confirmationRequired?.message).toContain('warehouse')
  })

  test('WITH confirmation: the status flips', async () => {
    seed()
    await call('admin:toggle_integration', { integration: 'warehouse', action: 'disable' }, true)
    expect(dbState.integrationUpdates[0].data.status).toBe('inactive')
  })

  test('an unresolvable target is refused without a confirmation prompt', async () => {
    const r = await call('admin:toggle_integration', { integration: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.confirmationRequired).toBeUndefined()
    expect(r.output).toContain('not found')
  })

  test('a missing target is refused', async () => {
    const r = await call('admin:toggle_integration', {})
    expect(r.output).toContain('required')
  })
})

describe('toggle_document — confirmation gate', () => {
  const seed = () => { dbState.documents = [{ id: 'doc-1', name: 'handbook.pdf', isEnabled: true }] }

  test('WITHOUT confirmation: the document is untouched', async () => {
    seed()
    const r = await call('admin:toggle_document', { document: 'handbook.pdf', action: 'disable' })
    expect(r.confirmationRequired?.action).toBe('TOGGLE_DOCUMENT')
    expect(dbState.documentUpdates).toHaveLength(0)
  })

  test('WITH confirmation: isEnabled flips', async () => {
    seed()
    await call('admin:toggle_document', { document: 'handbook.pdf', action: 'disable' }, true)
    expect(dbState.documentUpdates[0].data.isEnabled).toBe(false)
  })

  test('the audit row records the before AND after state', async () => {
    seed()
    await call('admin:toggle_document', { document: 'handbook.pdf', action: 'disable' }, true)
    const row = dbState.audit.find((a) => a.action === 'DOC_UPDATE')
    // "before" is what makes an audit row useful after the fact.
    expect(row.detail.before).toEqual({ isEnabled: true })
    expect(row.detail.after).toEqual({ isEnabled: false })
  })

  test('an unresolvable document is refused without a confirmation prompt', async () => {
    const r = await call('admin:toggle_document', { document: 'ghost.pdf' })
    expect(r.confirmationRequired).toBeUndefined()
    expect(r.output).toContain('not found')
  })
})

// ---------------------------------------------------------------------------
// MCP lifecycle actions — mcp_list / mcp_set_credentials / mcp_test / mcp_remove
//
// These five tool ids resolved through the dispatcher but their bodies had never
// run. They are the actions an operator reaches for when an MCP server stops
// working, and two of them (set_credentials, remove) change what the platform can
// reach, so their validation and confirmation gates are load-bearing.
// ---------------------------------------------------------------------------

describe('admin:mcp_list', () => {
  test('an empty registry says so rather than printing an empty list', async () => {
    dbState.mcpServers = []
    const r = await call('admin:mcp_list')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('No MCP servers')
  })

  test('each server shows its status, transport, endpoint and both scopes', async () => {
    dbState.mcpServers = [
      { id: 's1', name: 'filesystem', transport: 'stdio', command: 'npx -y fs-server', url: null, isEnabled: true, chatEnabled: true, agenticEnabled: false },
      { id: 's2', name: 'remote-docs', transport: 'sse', command: null, url: 'https://x/sse', isEnabled: false, chatEnabled: false, agenticEnabled: true },
    ]
    const r = await call('admin:mcp_list')
    expect(r.ok).toBe(true)
    // stdio servers have a command and no URL; the endpoint column must pick the
    // right one or an operator cannot tell what will actually spawn.
    expect(r.output).toContain('npx -y fs-server')
    expect(r.output).toContain('https://x/sse')
    expect(r.output).toContain('[ACTIVE]')
    expect(r.output).toContain('[OFF]')
    expect(r.output).toContain('chat:on agentic:off')
    expect(r.output).toContain('chat:off agentic:on')
  })
})

describe('admin:mcp_set_credentials — validation before any write', () => {
  test('a missing server name is refused first', async () => {
    const r = await call('admin:mcp_set_credentials', { credentials: 'KEY=value' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('name is required')
  })

  test('missing credentials are refused with the expected format', async () => {
    const r = await call('admin:mcp_set_credentials', { server: 'fs' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('Credentials are required')
    expect(r.output).toContain('KEY=value')
    // A refusal must not have written anything.
    expect(dbState.mcpUpdates).toHaveLength(0)
  })

  test('credentials that parse to NOTHING are refused, not written as empty', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true }]
    const r = await call('admin:mcp_set_credentials', { server: 'fs', credentials: 'lowercase=nope, 123=456' })
    // Two reasons this matters: an empty update would look like success, and the
    // server would be left with no credentials while reporting fine.
    expect(r.ok).toBe(false)
    expect(r.output).toContain('No valid credential pairs')
    expect(dbState.mcpUpdates).toHaveLength(0)
  })

  test('a valid pair is written for the resolved server', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true, encryptedConfig: {} }]
    const r = await call('admin:mcp_set_credentials', { server: 'fs', credentials: 'GITHUB_TOKEN=abc123' })
    expect(r.ok).toBe(true)
    expect(dbState.mcpUpdates.length).toBe(1)
    expect(dbState.mcpUpdates[0].where).toEqual({ id: 's1' })
  })

  test('an ambiguous server name is refused with the candidates listed', async () => {
    // NOT named 'github': a query that is an exact match for one candidate
    // resolves to it (resolveMcpServer checks that BEFORE reporting ambiguity), so
    // 'github' against github + github-enterprise is unambiguous by design.
    // Measured: with server:'github' the call returned ok:true. The query has to
    // be a substring of BOTH names and equal to NEITHER.
    dbState.mcpServers = [{ id: 's1', name: 'github-cloud', isEnabled: true }, { id: 's2', name: 'github-enterprise', isEnabled: true }]
    // The credentials must also be VALID: with 'A=1' the credential check rejects
    // first (a key needs at least 2 chars — /([A-Z][A-Z0-9_]+)/), which would make
    // this test cover validation while claiming to cover resolution.
    const r = await call('admin:mcp_set_credentials', { server: 'github', credentials: 'GITHUB_TOKEN=abc' })
    // Silent selection would set credentials on a server the operator did not name.
    expect(r.ok).toBe(false)
    expect(r.output).toContain('matches')
    expect(r.output).toContain('github-cloud')
    expect(dbState.mcpUpdates).toHaveLength(0)
  })

  test('an EXACT name among several substring matches resolves without asking', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'github', isEnabled: true }, { id: 's2', name: 'github-enterprise', isEnabled: true }]
    const r = await call('admin:mcp_set_credentials', { server: 'github', credentials: 'GITHUB_TOKEN=abc' })
    // 'github' is an exact, case-insensitive match for one of the two substring
    // hits, so resolution must succeed and the write must land on THAT server.
    expect(r.ok).toBe(true)
    expect(dbState.mcpUpdates).toHaveLength(1)
    expect(dbState.mcpUpdates[0].where).toEqual({ id: 's1' })
  })

  test('parseCredentialPairs accepts quoted, single-quoted and bare values', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true, encryptedConfig: {} }]
    const r = await call('admin:mcp_set_credentials', {
      server: 'fs', credentials: `TOKEN="quoted value", PATH='/a/b', BARE=plain`,
    })
    expect(r.ok).toBe(true)
    expect(dbState.mcpUpdates).toHaveLength(1)
  })
})

describe('admin:mcp_test', () => {
  test('an unknown server is refused before any connection attempt', async () => {
    dbState.mcpServers = []
    const r = await call('admin:mcp_test', { server: 'ghost' })
    expect(r.ok).toBe(false)
    expect(r.output).toContain('not found')
  })

  test('a reachable server reports its tool count', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true }]
    const r = await call('admin:mcp_test', { server: 'fs' })
    expect(r.ok).toBe(true)
    expect(r.output).toContain('reachable')
  })
})

describe('admin:mcp_remove — confirmation gate and audit', () => {
  test('without confirmation it ASKS and deletes nothing', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true }]
    const r = await call('admin:mcp_remove', { server: 'fs' })
    expect(r.confirmationRequired?.action).toBe('MCP_REMOVE')
    expect(r.confirmationRequired?.message).toContain('fs')
    // The gate is only meaningful if nothing was removed.
    expect(dbState.mcpDeletes).toHaveLength(0)
  })

  test('with confirmation it deletes, disconnects and audits', async () => {
    dbState.mcpServers = [{ id: 's1', name: 'fs', transport: 'stdio', isEnabled: true }]
    const r = await call('admin:mcp_remove', { server: 'fs' }, true)
    expect(r.ok).toBe(true)
    expect(dbState.mcpDeletes).toHaveLength(1)
    expect(dbState.mcpDeletes[0].where).toEqual({ id: 's1' })
    const row = dbState.audit.find((a) => a.action === 'MCP_SERVER_DELETE')
    // Removing a server revokes the platform's access to something; the audit row
    // is how that is answerable later.
    expect(row).toBeDefined()
    expect(row.severity).toBe('warning')
  })

  test('an unresolvable server is refused WITHOUT a confirmation prompt', async () => {
    dbState.mcpServers = []
    const r = await call('admin:mcp_remove', { server: 'ghost' })
    // Asking "are you sure?" about a server that does not exist is a dead end.
    expect(r.confirmationRequired).toBeUndefined()
    expect(r.output).toContain('not found')
  })
})

describe('admin:seed_plugins', () => {
  test('seeding reports before and after counts and audits', async () => {
    const r = await call('admin:seed_plugins')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('Before')
    expect(r.output).toContain('After')
    const row = dbState.audit.find((a) => a.action === 'PLUGINS_SEEDED')
    expect(row).toBeDefined()
    expect(row.detail.before).toBeDefined()
    expect(row.detail.after).toBeDefined()
  })
})
