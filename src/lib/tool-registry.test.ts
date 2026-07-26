import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockPluginFindMany = mock(async () => [
  {
    toolId: 'weather',
    description: 'Get weather for a city',
    manifestJson: JSON.stringify({ paramDescription: '{ "city": "name" }' }),
    isEnabled: true,
    chatEnabled: true,
    agenticEnabled: true,
    category: 'external' as string | null,
    subcategory: 'weather' as string | null,
  },
])

const mockSelectRelevantPlugins = mock(async () => [
  {
    toolId: 'translate',
    description: 'Translate text between languages',
    manifestJson: JSON.stringify({ paramDescription: '{ "text": "string", "to": "lang" }' }),
    category: 'external',
    subcategory: 'language',
    chatEnabled: true,
    agenticEnabled: true,
  },
])

const mockListMcpTools = mock(async () => [
  { serverId: 'srv1', serverName: 'FileServer', toolName: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } },
])

const mockMcpServerFindMany = mock(async () => [
  { id: 'srv1', chatEnabled: true, agenticEnabled: true },
])

mock.module('@/lib/db', () => ({
  db: {
    plugin: { findMany: mockPluginFindMany },
    mcpServer: { findMany: mockMcpServerFindMany },
  },
}))
mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: mockSelectRelevantPlugins,
}))
mock.module('@/lib/mcp-client', () => ({
  listMcpTools: mockListMcpTools,
}))

import { getAvailableTools, getTool, BUILT_IN_TOOLS } from './tool-registry'

beforeEach(() => {
  mockPluginFindMany.mockClear()
  mockSelectRelevantPlugins.mockClear()
  mockListMcpTools.mockClear()
  mockMcpServerFindMany.mockClear()
})

describe('getTool', () => {
  test('returns tool by id when found', () => {
    const t = getTool('sql')
    expect(t).toBeDefined()
    expect(t!.id).toBe('sql')
  })

  test('returns undefined for unknown id', () => {
    expect(getTool('nonexistent')).toBeUndefined()
  })
})

describe('BUILT_IN_TOOLS', () => {
  test('contains sql, rag, rest, chat', () => {
    const ids = BUILT_IN_TOOLS.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids).toContain('rag')
    expect(ids).toContain('rest')
    expect(ids).toContain('chat')
  })
})

describe('getAvailableTools without query', () => {
  test('returns built-in + all enabled plugins + mcp tools', async () => {
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids).toContain('rag')
    expect(ids).toContain('plugin:weather')
    expect(ids).toContain('mcp:srv1:read_file')
    expect(mockPluginFindMany).toHaveBeenCalledTimes(1)
    expect(mockSelectRelevantPlugins).not.toHaveBeenCalled()
  })

  test('plugin tool has parsed paramDescription from manifest', async () => {
    const tools = await getAvailableTools()
    const weather = tools.find((t) => t.id === 'plugin:weather')
    expect(weather?.paramDescription).toContain('city')
  })

  test('plugin with invalid manifest JSON → default paramDescription', async () => {
    mockPluginFindMany.mockImplementationOnce(async () => [
      { toolId: 'broken', description: 'bad manifest', manifestJson: 'not-json', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: null, subcategory: null },
    ])
    const tools = await getAvailableTools()
    const broken = tools.find((t) => t.id === 'plugin:broken')
    expect(broken?.paramDescription).toContain('input')
  })
})

describe('getAvailableTools with query', () => {
  test('uses selectRelevantPlugins instead of findMany', async () => {
    const tools = await getAvailableTools('translate this text')
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('plugin:translate')
    expect(mockSelectRelevantPlugins).toHaveBeenCalledTimes(1)
    expect(mockPluginFindMany).not.toHaveBeenCalled()
  })

  test('mcp tools still included when query present', async () => {
    const tools = await getAvailableTools('some query')
    expect(tools.some((t) => t.id.startsWith('mcp:'))).toBe(true)
  })
})

describe('getAvailableTools — mcp graceful degradation', () => {
  test('mcp listing failure → still returns built-in + plugins', async () => {
    mockListMcpTools.mockImplementationOnce(async () => {
      throw new Error('MCP server down')
    })
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids.every((id) => !id.startsWith('mcp:'))).toBe(true)
  })
})
