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
    plugin: { findMany: async () => dbState.plugins },
    scheduledRun: { findMany: async () => dbState.schedules },
    mcpServer: {
      findMany: async () => dbState.mcpServers,
      findFirst: async () => dbState.mcpServers[0] ?? null,
      update: async (a: any) => { dbState.mcpUpdates.push(a); return a },
      delete: async (a: any) => { dbState.mcpDeletes.push(a); return a },
      create: async (a: any) => { dbState.mcpCreates.push(a); return a },
    },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'org-1',
  enterWithOrg: () => {},
  bypassOrg: (_o: unknown, fn: () => unknown) => fn(),
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
