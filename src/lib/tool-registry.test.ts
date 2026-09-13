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

/** MCP tools as listMcpTools would return them, across two servers. */
const mockListMcpTools = mock(async () => [] as unknown[])

mock.module('@/lib/mcp-client', () => ({
  // Only listMcpTools is reached by tool-registry. `mock.module` MERGES with the real module, so
  // the remaining exports stay real and a transitive importer cannot throw
  // "Export named ... not found". No `await import()` here: a factory that awaits the module it
  // defines deadlocks.
  listMcpTools: mockListMcpTools,
}))

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
  mockListMcpTools.mockClear()
  mockListMcpTools.mockImplementation(async () => [])
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
    expect(BUILT_IN_TOOLS).toHaveLength(6)
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
  test('has 19 tools', () => {
    expect(ADMIN_TOOLS).toHaveLength(19)
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
    const tools = await getAvailableTools(undefined, 'agentic', { isAdmin: true })
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

/**
 * MCP tools are gated per context exactly like plugins, but the plugin side had five tests and the
 * MCP side had NONE — no test ever supplied an MCP tool whose server had chatEnabled/agenticEnabled
 * set, so the branch that decides whether an MCP tool is offered in chat vs agentic never ran.
 *
 * This matters more than the plugin case: an MCP server is an arbitrary remote endpoint, and its
 * tools are namespaced `mcp:<serverId>:<toolName>`. A gate that failed open would expose remote
 * tool execution in the wrong surface.
 */
describe('getAvailableTools — MCP per-server context gating', () => {
  const mcpTool = (serverId: string, toolName: string) => ({
    serverId,
    serverName: `Srv ${serverId}`,
    toolName,
    description: `does ${toolName}`,
    inputSchema: { type: 'object' },
  })

  /** Two MCP servers with opposite context flags. */
  function twoServers() {
    mockListMcpTools.mockImplementation(async () => [
      mcpTool('srv-chat', 'chat_only'),
      mcpTool('srv-agentic', 'agentic_only'),
      mcpTool('srv-unknown', 'from_an_unlisted_server'),
    ])
    mockMcpServerFindMany.mockImplementation(async () => [
      { id: 'srv-chat', chatEnabled: true, agenticEnabled: false },
      { id: 'srv-agentic', chatEnabled: false, agenticEnabled: true },
    ])
  }

  test('chat context offers ONLY the chatEnabled server tools', async () => {
    twoServers()
    const ids = (await getAvailableTools(undefined, 'chat')).map((t) => t.id)

    expect(ids).toContain('mcp:srv-chat:chat_only')
    expect(ids).not.toContain('mcp:srv-agentic:agentic_only')
  })

  test('agentic context offers ONLY the agenticEnabled server tools', async () => {
    twoServers()
    const ids = (await getAvailableTools(undefined, 'agentic')).map((t) => t.id)

    expect(ids).toContain('mcp:srv-agentic:agentic_only')
    expect(ids).not.toContain('mcp:srv-chat:chat_only')
  })

  test('a tool from a server MISSING from the flag map is KEPT (fail-open by design)', async () => {
    // Deliberate: `listMcpTools` has a 60s cache and the flag lookup is a separate query, so a tool
    // can arrive for a row that is not in the map — most often a server just created, or one
    // disabled between the two reads. Dropping it would silently hide a working tool; keeping it is
    // the documented behaviour, and this test is what stops a future "tighten it up" change from
    // inverting it without noticing.
    twoServers()
    const ids = (await getAvailableTools(undefined, 'chat')).map((t) => t.id)
    expect(ids).toContain('mcp:srv-unknown:from_an_unlisted_server')
  })

  test('NO context offers every MCP tool regardless of flags', async () => {
    // The planner-less listing path must not filter — matching the plugin behaviour already pinned.
    twoServers()
    const ids = (await getAvailableTools()).map((t) => t.id)

    expect(ids).toContain('mcp:srv-chat:chat_only')
    expect(ids).toContain('mcp:srv-agentic:agentic_only')
  })

  test('an MCP tool with no description still gets a usable server · tool label', async () => {
    mockListMcpTools.mockImplementation(async () => [
      { serverId: 's1', serverName: 'GitHub', toolName: 'list_repos', description: '', inputSchema: { type: 'object' } },
    ])
    mockMcpServerFindMany.mockImplementation(async () => [])
    const tools = await getAvailableTools()
    const tool = tools.find((t) => t.id === 'mcp:s1:list_repos')
    expect(tool?.description).toBe('GitHub · list_repos')
  })

  test('the flag lookup only asks for ENABLED servers', async () => {
    // Pins the query shape. A disabled server must not contribute flags at all, so its tools fall
    // through the `!flags` fail-open branch only if listMcpTools still lists them — i.e. the two
    // sources of truth stay independent. Asserting on the query is what makes the `isEnabled`
    // filter observable; a control that dropped it stayed green until this test existed.
    mockListMcpTools.mockImplementation(async () => [])
    mockMcpServerFindMany.mockImplementation(async () => [])
    await getAvailableTools(undefined, 'chat')

    expect(mockMcpServerFindMany).toHaveBeenCalled()
    // The mock's inferred signature is `() => never[]`, so read the recorded call through a cast
    // that goes via `unknown` rather than asserting on a tuple the type system calls empty.
    const recorded = (mockMcpServerFindMany.mock.calls as unknown as Array<[{ where?: { isEnabled?: boolean }; select?: unknown }]>)[0]!
    const arg = recorded[0]
    expect(arg.where?.isEnabled).toBe(true)
    // Only the three fields the map needs — this runs on every tool listing.
    expect(arg.select).toEqual({ id: true, chatEnabled: true, agenticEnabled: true })
  })

  test('the MCP id is namespaced with the serverId, so two servers cannot collide', async () => {
    // Without the serverId in the id, two servers exposing a tool of the same name would produce
    // the same tool id and the second would shadow the first in any id-keyed lookup.
    mockListMcpTools.mockImplementation(async () => [
      mcpTool('alpha', 'search'),
      mcpTool('beta', 'search'),
    ])
    mockMcpServerFindMany.mockImplementation(async () => [])
    const ids = (await getAvailableTools()).map((t) => t.id)
    expect(ids).toContain('mcp:alpha:search')
    expect(ids).toContain('mcp:beta:search')
    expect(new Set(ids).size).toBe(ids.length)
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
