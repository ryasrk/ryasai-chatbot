import { describe, expect, test, mock, beforeEach } from 'bun:test'

// --- Mutable mock state (reset between tests via beforeEach) ---
const mockApiKeyCreate = mock<(args: any) => Promise<any>>(async () => ({ id: 'ak-1' }))
const mockToolRunCount = mock<(args: any) => Promise<number>>(async () => 5)
const mockToolRunAggregate = mock<(args: any) => Promise<any>>(async () => ({ _avg: { latencyMs: 100 } }))
const mockApiRequestLogCount = mock<(args: any) => Promise<number>>(async () => 3)
const mockIntegrationCount = mock<(args: any) => Promise<number>>(async () => 2)
const mockDocumentCount = mock<(args: any) => Promise<number>>(async () => 10)
const mockAuditLogFindMany = mock<(args: any) => Promise<any[]>>(async () => [])
const mockAuditLogCreate = mock<(args: any) => Promise<any>>(async () => ({}))
const mockIntegrationFindMany = mock<(args: any) => Promise<any[]>>(async () => [])
const mockPluginFindMany = mock<(args: any) => Promise<any[]>>(async () => [])
const mockScheduledRunFindMany = mock<(args: any) => Promise<any[]>>(async () => [])
const mockAppConfigFindFirst = mock<(args: any) => Promise<any>>(async () => ({ id: 'cfg-1', promptSettings: '' }))
const mockAppConfigUpdate = mock<(args: any) => Promise<any>>(async () => ({}))
const mockAppConfigCreate = mock<(args: any) => Promise<any>>(async () => ({}))
const mockIntegrationFindFirst = mock<(args: any) => Promise<any>>(async () => null)
const mockIntegrationUpdate = mock<(args: any) => Promise<any>>(async () => ({}))
const mockDocumentFindFirst = mock<(args: any) => Promise<any>>(async () => null)
const mockDocumentUpdate = mock<(args: any) => Promise<any>>(async () => ({}))

const mockWriteAudit = mock<(args: any) => Promise<void>>(async () => undefined)
// ponytail: writeAudit is verified via mockAuditLogCreate (the real writeAudit calls
// db.auditLog.create). We don't mock @/lib/session to avoid breaking session.test.ts.
const mockGetPromptSettings = mock<(db: any) => Promise<any>>(async () => ({
  systemPrompt: 'test prompt',
  tools: { sql: true, rag: true, restApi: false },
}))
const mockMergePromptSettings = mock<(current: any, patch: any) => any>((current, patch) => ({
  ...current,
  ...patch,
  tools: { ...current.tools, ...patch.tools },
}))
const mockGetRoutingScores = mock<() => Promise<any>>(async () => ({
  scores: [
    { tool: 'SQL', finalScore: 0.8, circuitBreakerTripped: false },
    { tool: 'RAG', finalScore: 0.6, circuitBreakerTripped: false },
  ],
  schemaKeywords: [],
  endpointKeywords: [],
  documentKeywords: [],
}))

mock.module('@/lib/db', () => ({
  db: {
    apiKey: { create: mockApiKeyCreate },
    toolRun: { count: mockToolRunCount, aggregate: mockToolRunAggregate },
    apiRequestLog: { count: mockApiRequestLogCount },
    integration: {
      count: mockIntegrationCount,
      findMany: mockIntegrationFindMany,
      findFirst: mockIntegrationFindFirst,
      update: mockIntegrationUpdate,
    },
    document: {
      count: mockDocumentCount,
      findFirst: mockDocumentFindFirst,
      update: mockDocumentUpdate,
    },
    auditLog: { findMany: mockAuditLogFindMany, create: mockAuditLogCreate },
    plugin: { findMany: mockPluginFindMany },
    scheduledRun: { findMany: mockScheduledRunFindMany },
    appConfig: { findFirst: mockAppConfigFindFirst, update: mockAppConfigUpdate, create: mockAppConfigCreate },
  },
}))
// ponytail: do NOT mock @/lib/api-keys — Bun's mock.module merges with the real
// module and the fake generateApiKey hash ('hash123') breaks api-keys.test.ts's
// verifyApiKey length check. Use the real generateApiKey/maskApiKey instead.
// ponytail: do NOT mock @/lib/session — Bun's mock.module merges with the real
// module and the mock writeAudit breaks session.test.ts. Use the real writeAudit
// (which calls db.auditLog.create, already in our db mock).
mock.module('@/lib/prompt-settings', () => ({
  getPromptSettings: mockGetPromptSettings,
  mergePromptSettings: mockMergePromptSettings,
}))
mock.module('@/lib/smart-router', () => ({
  getRoutingScores: mockGetRoutingScores,
}))

import { executeAdminTool } from './admin-tools'

beforeEach(() => {
  mockApiKeyCreate.mockClear()
  mockToolRunCount.mockClear()
  mockToolRunAggregate.mockClear()
  mockApiRequestLogCount.mockClear()
  mockIntegrationCount.mockClear()
  mockDocumentCount.mockClear()
  mockAuditLogFindMany.mockClear()
  mockAuditLogCreate.mockClear()
  mockIntegrationFindMany.mockClear()
  mockPluginFindMany.mockClear()
  mockScheduledRunFindMany.mockClear()
  mockAppConfigFindFirst.mockClear()
  mockAppConfigUpdate.mockClear()
  mockAppConfigCreate.mockClear()
  mockIntegrationFindFirst.mockClear()
  mockIntegrationUpdate.mockClear()
  mockDocumentFindFirst.mockClear()
  mockDocumentUpdate.mockClear()
  mockWriteAudit.mockClear()
  mockGetPromptSettings.mockClear()
  mockMergePromptSettings.mockClear()
  mockGetRoutingScores.mockClear()
  mockApiKeyCreate.mockImplementation(async () => ({ id: 'ak-1' }))
  mockToolRunCount.mockImplementation(async () => 5)
  mockToolRunAggregate.mockImplementation(async () => ({ _avg: { latencyMs: 100 } }))
  mockApiRequestLogCount.mockImplementation(async () => 3)
  mockIntegrationCount.mockImplementation(async () => 2)
  mockDocumentCount.mockImplementation(async () => 10)
  mockAuditLogFindMany.mockImplementation(async () => [])
  mockAuditLogCreate.mockImplementation(async () => ({}))
  mockIntegrationFindMany.mockImplementation(async () => [])
  mockPluginFindMany.mockImplementation(async () => [])
  mockScheduledRunFindMany.mockImplementation(async () => [])
  mockAppConfigFindFirst.mockImplementation(async () => ({ id: 'cfg-1', promptSettings: '' }))
  mockAppConfigUpdate.mockImplementation(async () => ({}))
  mockAppConfigCreate.mockImplementation(async () => ({}))
  mockIntegrationFindFirst.mockImplementation(async () => null)
  mockIntegrationUpdate.mockImplementation(async () => ({}))
  mockDocumentFindFirst.mockImplementation(async () => null)
  mockDocumentUpdate.mockImplementation(async () => ({}))
  mockWriteAudit.mockImplementation(async () => undefined)
  mockGetPromptSettings.mockImplementation(async () => ({
    systemPrompt: 'test prompt',
    tools: { sql: true, rag: true, restApi: false },
  }))
  mockMergePromptSettings.mockImplementation((current: any, patch: any) => ({
    ...current,
    ...patch,
    tools: { ...current.tools, ...patch.tools },
  }))
  mockGetRoutingScores.mockImplementation(async () => ({
    scores: [
      { tool: 'SQL', finalScore: 0.8, circuitBreakerTripped: false },
      { tool: 'RAG', finalScore: 0.6, circuitBreakerTripped: false },
    ],
    schemaKeywords: [],
    endpointKeywords: [],
    documentKeywords: [],
  }))
})

describe('executeAdminTool — admin:generate_api_key', () => {
  test('returns ok with key and audits', async () => {
    const result = await executeAdminTool('admin:generate_api_key', { label: 'test' }, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('ryas_')
    expect(result.output).toContain('test')
    expect(result.output).toContain('API Key created successfully')
    expect(mockApiKeyCreate).toHaveBeenCalledTimes(1)
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
    const auditArg = mockAuditLogCreate.mock.calls[0][0]
    expect(auditArg.data.action).toBe('API_KEY_GENERATED')
    expect(auditArg.data.userId).toBe('user1')
  })
})

describe('executeAdminTool — admin:show_monitoring', () => {
  test('returns monitoring data with metrics', async () => {
    const result = await executeAdminTool('admin:show_monitoring', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Tool Runs: 5')
    expect(result.output).toContain('Avg Latency: 100ms')
    expect(result.output).toContain('Failed API: 3')
    expect(result.output).toContain('Active Integrations: 2')
    expect(result.output).toContain('Documents Ready: 10')
  })
})

describe('executeAdminTool — admin:show_audit_log', () => {
  test('returns logs when present', async () => {
    mockAuditLogFindMany.mockImplementation(async () => [
      { action: 'LOGIN', severity: 'info', createdAt: new Date('2026-07-26T10:00:00Z') },
      { action: 'GUARDRAIL_BLOCK', severity: 'critical', createdAt: new Date('2026-07-26T11:00:00Z') },
    ])
    const result = await executeAdminTool('admin:show_audit_log', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('LOGIN')
    expect(result.output).toContain('GUARDRAIL_BLOCK')
    expect(result.output).toContain('[CRITICAL]')
    expect(result.output).toContain('[INFO]')
  })

  test('returns no logs message when empty', async () => {
    mockAuditLogFindMany.mockImplementation(async () => [])
    const result = await executeAdminTool('admin:show_audit_log', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('No audit logs found.')
  })
})

describe('executeAdminTool — admin:list_integrations', () => {
  test('returns integration list when present', async () => {
    mockIntegrationFindMany.mockImplementation(async () => [
      { name: 'Sales DB', provider: 'POSTGRESQL', status: 'active', type: 'database' },
    ])
    const result = await executeAdminTool('admin:list_integrations', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('Sales DB')
    expect(result.output).toContain('POSTGRESQL')
    expect(result.output).toContain('active')
  })

  test('returns no integrations message when empty', async () => {
    mockIntegrationFindMany.mockImplementation(async () => [])
    const result = await executeAdminTool('admin:list_integrations', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('No database integrations found.')
  })
})

describe('executeAdminTool — admin:list_plugins', () => {
  test('returns plugin list when present', async () => {
    mockPluginFindMany.mockImplementation(async () => [
      { toolId: 'web_search', description: 'Search the web', isEnabled: true },
      { toolId: 'translate', description: 'Translate text', isEnabled: false },
    ])
    const result = await executeAdminTool('admin:list_plugins', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('[ACTIVE]')
    expect(result.output).toContain('plugin:web_search')
    expect(result.output).toContain('[OFF]')
    expect(result.output).toContain('plugin:translate')
  })

  test('returns no plugins message when empty', async () => {
    mockPluginFindMany.mockImplementation(async () => [])
    const result = await executeAdminTool('admin:list_plugins', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('No plugins registered.')
  })
})

describe('executeAdminTool — admin:list_schedules', () => {
  test('returns schedule list when present', async () => {
    mockScheduledRunFindMany.mockImplementation(async () => [
      { name: 'Daily Summary', cronExpr: '0 9 * * *', isActive: true, nextRunAt: new Date('2026-07-27T09:00:00Z') },
    ])
    const result = await executeAdminTool('admin:list_schedules', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('[ACTIVE]')
    expect(result.output).toContain('Daily Summary')
    expect(result.output).toContain('0 9 * * *')
  })

  test('returns no schedules message when empty', async () => {
    mockScheduledRunFindMany.mockImplementation(async () => [])
    const result = await executeAdminTool('admin:list_schedules', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toBe('No scheduled runs found.')
  })
})

describe('executeAdminTool — admin:show_prompt', () => {
  test('returns prompt settings with tool toggles', async () => {
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: 'You are a helpful assistant.',
      tools: { sql: true, rag: true, restApi: false },
    }))
    const result = await executeAdminTool('admin:show_prompt', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('You are a helpful assistant.')
    expect(result.output).toContain('SQL: ON')
    expect(result.output).toContain('RAG: ON')
    expect(result.output).toContain('REST: OFF')
  })

  test('shows (empty) when systemPrompt is blank', async () => {
    mockGetPromptSettings.mockImplementation(async () => ({
      systemPrompt: '',
      tools: { sql: true, rag: true, restApi: true },
    }))
    const result = await executeAdminTool('admin:show_prompt', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('(empty)')
  })
})

describe('executeAdminTool — admin:set_prompt', () => {
  test('not confirmed → confirmationRequired', async () => {
    const result = await executeAdminTool('admin:set_prompt', { prompt: 'new prompt' }, 'user1', false)
    expect(result.ok).toBe(false)
    expect(result.confirmationRequired).toBeDefined()
    expect(result.confirmationRequired!.action).toBe('SET_PROMPT')
    expect(result.confirmationRequired!.message).toContain('System Prompt')
  })

  test('confirmed → prompt updated and audited', async () => {
    const result = await executeAdminTool('admin:set_prompt', { prompt: 'new prompt' }, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('System Prompt updated')
    expect(mockAppConfigFindFirst).toHaveBeenCalledTimes(1)
    expect(mockAppConfigUpdate).toHaveBeenCalledTimes(1)
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
    expect(mockAuditLogCreate.mock.calls[0][0].data.action).toBe('PROMPT_TOOLS_UPDATE')
  })

  test('empty prompt → error', async () => {
    const result = await executeAdminTool('admin:set_prompt', { prompt: '' }, 'user1', true)
    expect(result.ok).toBe(false)
    expect(result.output).toBe('New prompt cannot be empty.')
  })
})

describe('executeAdminTool — admin:toggle_tool', () => {
  test('not confirmed → confirmationRequired', async () => {
    const result = await executeAdminTool('admin:toggle_tool', { tool: 'sql', action: 'disable' }, 'user1', false)
    expect(result.ok).toBe(false)
    expect(result.confirmationRequired).toBeDefined()
    expect(result.confirmationRequired!.action).toBe('TOGGLE_TOOL')
    expect(result.confirmationRequired!.message).toContain('SQL')
  })

  test('confirmed disable → tool toggled and audited', async () => {
    const result = await executeAdminTool('admin:toggle_tool', { tool: 'sql', action: 'disable' }, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('SQL')
    expect(result.output).toContain('disabled')
    expect(mockAppConfigUpdate).toHaveBeenCalledTimes(1)
    expect(mockAuditLogCreate).toHaveBeenCalledTimes(1)
    const auditData = mockAuditLogCreate.mock.calls[0][0].data
    expect(auditData.action).toBe('PROMPT_TOOLS_UPDATE')
    const detail = JSON.parse(auditData.detail)
    expect(detail.tool).toBe('sql')
    expect(detail.enabled).toBe(false)
  })

  test('invalid tool name → error', async () => {
    const result = await executeAdminTool('admin:toggle_tool', { tool: 'invalid', action: 'disable' }, 'user1', true)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('Unknown tool: invalid')
  })
})

describe('executeAdminTool — admin:toggle_integration', () => {
  test('not confirmed → confirmationRequired', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => ({ id: 'int-1', name: 'Chinook DB', status: 'active' }))
    const result = await executeAdminTool('admin:toggle_integration', { integration: 'Chinook', action: 'disable' }, 'user1', false)
    expect(result.ok).toBe(false)
    expect(result.confirmationRequired).toBeDefined()
    expect(result.confirmationRequired!.action).toBe('TOGGLE_INTEGRATION')
    expect(result.confirmationRequired!.message).toContain('Chinook DB')
  })

  test('integration not found → error', async () => {
    mockIntegrationFindFirst.mockImplementation(async () => null)
    const result = await executeAdminTool('admin:toggle_integration', { integration: 'notfound' }, 'user1', true)
    expect(result.ok).toBe(false)
    expect(result.output).toContain('not found')
  })
})

describe('executeAdminTool — admin:routing_scores', () => {
  test('returns routing scores', async () => {
    const result = await executeAdminTool('admin:routing_scores', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('SQL')
    expect(result.output).toContain('score=0.80')
    expect(result.output).toContain('RAG')
  })
})

describe('executeAdminTool — admin:reindex_status', () => {
  test('returns document count', async () => {
    mockDocumentCount.mockImplementation(async () => 42)
    const result = await executeAdminTool('admin:reindex_status', {}, 'user1', true)
    expect(result.ok).toBe(true)
    expect(result.output).toContain('42 documents ready')
  })
})

describe('executeAdminTool — unknown tool', () => {
  test('admin:unknown_tool → error', async () => {
    const result = await executeAdminTool('admin:unknown_tool', {}, 'user1', true)
    expect(result.ok).toBe(false)
    expect(result.output).toBe('Unknown admin tool: admin:unknown_tool')
  })
})
