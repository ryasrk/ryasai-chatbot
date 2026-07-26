import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockPluginFindMany = mock(async () => [
  {
    id: 'p1',
    toolId: 'weather',
    name: 'Weather',
    description: 'Get weather for a city',
    manifestJson: JSON.stringify({ paramDescription: '{ "city": "name" }' }),
    keywords: 'weather,forecast,temperature,cuaca,suhu',
    isEnabled: true,
    chatEnabled: true,
    agenticEnabled: true,
    category: 'external' as string | null,
    subcategory: 'weather' as string | null,
  },
  {
    id: 'p2',
    toolId: 'translate',
    name: 'Translate',
    description: 'Translate text between languages',
    manifestJson: JSON.stringify({ paramDescription: '{ "text": "string", "to": "lang" }' }),
    keywords: 'translate,translation,language,terjemahan,bahasa',
    isEnabled: true,
    chatEnabled: true,
    agenticEnabled: true,
    category: 'external' as string | null,
    subcategory: 'language' as string | null,
  },
])

const mockMcpServerFindMany = mock(async () => [] as unknown[])

mock.module('@/lib/db', () => ({
  db: {
    plugin: { findMany: mockPluginFindMany },
    mcpServer: { findMany: mockMcpServerFindMany, findUnique: async () => null },
  },
}))

import { getAvailableTools, getTool, BUILT_IN_TOOLS, ADMIN_TOOLS } from './tool-registry'

beforeEach(() => {
  mockPluginFindMany.mockClear()
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

  test('has exactly 4 tools', () => {
    expect(BUILT_IN_TOOLS).toHaveLength(4)
  })

  test('every tool has required fields (id, description, paramDescription, requiresDataSource)', () => {
    for (const t of BUILT_IN_TOOLS) {
      expect(t.id).toBeTruthy()
      expect(typeof t.id).toBe('string')
      expect(t.description).toBeTruthy()
      expect(typeof t.description).toBe('string')
      expect(t.paramDescription).toBeTruthy()
      expect(typeof t.paramDescription).toBe('string')
      expect(['integration', 'document', 'rest', 'none']).toContain(t.requiresDataSource)
    }
  })

  test('every tool has a unique id', () => {
    const ids = BUILT_IN_TOOLS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('ADMIN_TOOLS', () => {
  test('has 13 tools', () => {
    expect(ADMIN_TOOLS).toHaveLength(13)
  })

  test('every admin tool has required fields', () => {
    for (const t of ADMIN_TOOLS) {
      expect(t.id).toBeTruthy()
      expect(t.id.startsWith('admin:')).toBe(true)
      expect(typeof t.id).toBe('string')
      expect(t.description).toBeTruthy()
      expect(typeof t.description).toBe('string')
      expect(t.paramDescription).toBeTruthy()
      expect(typeof t.paramDescription).toBe('string')
      expect(t.requiresDataSource).toBe('none')
      expect(t.category).toBe('admin')
    }
  })

  test('every admin tool has a unique id', () => {
    const ids = ADMIN_TOOLS.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('includes generate_api_key, show_monitoring, show_audit_log', () => {
    const ids = ADMIN_TOOLS.map((t) => t.id)
    expect(ids).toContain('admin:generate_api_key')
    expect(ids).toContain('admin:show_monitoring')
    expect(ids).toContain('admin:show_audit_log')
  })

  test('includes list_integrations, list_plugins, list_schedules', () => {
    const ids = ADMIN_TOOLS.map((t) => t.id)
    expect(ids).toContain('admin:list_integrations')
    expect(ids).toContain('admin:list_plugins')
    expect(ids).toContain('admin:list_schedules')
  })

  test('includes show_prompt, set_prompt, toggle_tool', () => {
    const ids = ADMIN_TOOLS.map((t) => t.id)
    expect(ids).toContain('admin:show_prompt')
    expect(ids).toContain('admin:set_prompt')
    expect(ids).toContain('admin:toggle_tool')
  })

  test('includes toggle_integration, toggle_document, routing_scores, reindex_status', () => {
    const ids = ADMIN_TOOLS.map((t) => t.id)
    expect(ids).toContain('admin:toggle_integration')
    expect(ids).toContain('admin:toggle_document')
    expect(ids).toContain('admin:routing_scores')
    expect(ids).toContain('admin:reindex_status')
  })
})

describe('getAvailableTools without query', () => {
  test('returns built-in + all enabled plugins', async () => {
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids).toContain('rag')
    expect(ids).toContain('plugin:weather')
    expect(mockPluginFindMany).toHaveBeenCalledTimes(1)
  })

  test('plugin tool has parsed paramDescription from manifest', async () => {
    const tools = await getAvailableTools()
    const weather = tools.find((t) => t.id === 'plugin:weather')
    expect(weather?.paramDescription).toContain('city')
  })

  test('plugin with invalid manifest JSON → default paramDescription', async () => {
    mockPluginFindMany.mockImplementationOnce(async () => [
      { id: 'p3', toolId: 'broken', name: 'Broken', description: 'bad manifest', manifestJson: 'not-json', keywords: '', isEnabled: true, chatEnabled: true, agenticEnabled: true, category: null, subcategory: null },
    ])
    const tools = await getAvailableTools()
    const broken = tools.find((t) => t.id === 'plugin:broken')
    expect(broken?.paramDescription).toContain('input')
  })
})

describe('getAvailableTools with query', () => {
  test('uses selectRelevantPlugins → returns relevant plugin', async () => {
    const tools = await getAvailableTools('translate this text')
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('plugin:translate')
    expect(mockPluginFindMany).toHaveBeenCalledTimes(1)
  })

  test('mcp graceful degradation — no real servers → still returns built-in + plugins', async () => {
    const tools = await getAvailableTools('weather forecast')
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids.some((id) => id.startsWith('plugin:'))).toBe(true)
  })
})

describe('getAvailableTools — context filtering', () => {
  test('chat context → no admin tools included', async () => {
    const tools = await getAvailableTools(undefined, 'chat')
    const ids = tools.map((t) => t.id)
    expect(ids.some((id) => id.startsWith('admin:'))).toBe(false)
    expect(ids).toContain('sql')
    expect(ids).toContain('plugin:weather')
  })

  test('agentic context → admin tools included', async () => {
    const tools = await getAvailableTools(undefined, 'agentic')
    const ids = tools.map((t) => t.id)
    expect(ids.some((id) => id.startsWith('admin:'))).toBe(true)
    expect(ids).toContain('admin:generate_api_key')
    expect(ids).toContain('sql')
  })

  test('no context → no admin tools (default)', async () => {
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids.some((id) => id.startsWith('admin:'))).toBe(false)
  })

  test('chat context filters out chatEnabled=false plugins', async () => {
    mockPluginFindMany.mockImplementationOnce(async () => [
      { id: 'p1', toolId: 'weather', name: 'Weather', description: 'Get weather', manifestJson: '{}', keywords: 'weather', isEnabled: true, chatEnabled: false, agenticEnabled: true, category: null, subcategory: null },
      { id: 'p2', toolId: 'translate', name: 'Translate', description: 'Translate', manifestJson: '{}', keywords: 'translate', isEnabled: true, chatEnabled: true, agenticEnabled: false, category: null, subcategory: null },
    ])

    const tools = await getAvailableTools(undefined, 'chat')
    const ids = tools.map((t) => t.id)
    expect(ids).not.toContain('plugin:weather')
    expect(ids).toContain('plugin:translate')
  })

  test('agentic context filters out agenticEnabled=false plugins', async () => {
    mockPluginFindMany.mockImplementationOnce(async () => [
      { id: 'p1', toolId: 'weather', name: 'Weather', description: 'Get weather', manifestJson: '{}', keywords: 'weather', isEnabled: true, chatEnabled: true, agenticEnabled: false, category: null, subcategory: null },
      { id: 'p2', toolId: 'translate', name: 'Translate', description: 'Translate', manifestJson: '{}', keywords: 'translate', isEnabled: true, chatEnabled: false, agenticEnabled: true, category: null, subcategory: null },
    ])

    const tools = await getAvailableTools(undefined, 'agentic')
    const ids = tools.map((t) => t.id)
    expect(ids).not.toContain('plugin:weather')
    expect(ids).toContain('plugin:translate')
  })

  test('no context → all enabled plugins included regardless of chat/agentic flags', async () => {
    mockPluginFindMany.mockImplementationOnce(async () => [
      { id: 'p1', toolId: 'weather', name: 'Weather', description: 'Get weather', manifestJson: '{}', keywords: 'weather', isEnabled: true, chatEnabled: false, agenticEnabled: false, category: null, subcategory: null },
    ])

    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('plugin:weather')
  })
})

describe('getAvailableTools — mcp graceful degradation', () => {
  test('mcp DB failure → still returns built-in + plugins', async () => {
    mockMcpServerFindMany.mockImplementationOnce(async () => { throw new Error('DB down') })
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids.some((id) => id.startsWith('plugin:'))).toBe(true)
  })
})
