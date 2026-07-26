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

import { getAvailableTools, getTool, BUILT_IN_TOOLS } from './tool-registry'

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

describe('getAvailableTools — mcp graceful degradation', () => {
  test('mcp DB failure → still returns built-in + plugins', async () => {
    mockMcpServerFindMany.mockImplementationOnce(async () => { throw new Error('DB down') })
    const tools = await getAvailableTools()
    const ids = tools.map((t) => t.id)
    expect(ids).toContain('sql')
    expect(ids.some((id) => id.startsWith('plugin:'))).toBe(true)
  })
})
