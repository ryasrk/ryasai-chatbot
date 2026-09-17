import { describe, test, expect, beforeEach } from 'bun:test'
import {
  toolIdToFunctionName,
  functionNameToToolId,
  toLlmToolDef,
  SQL_TOOL,
  RAG_TOOL,
  REST_TOOL,
  WEB_SEARCH_TOOL,
  WEB_FETCH_TOOL,
  DIRECT_CHAT_TOOL,
  buildAdminUnifiedTools,
} from './unified-tools'
import { toolCircuitBreaker } from './tool-circuit-breaker'

describe('unified-tools — function name encoding and schema mapping', () => {
  beforeEach(() => {
    toolCircuitBreaker.reset()
  })

  test('encodes canonical built-in tools to clean function names', () => {
    expect(toolIdToFunctionName('sql')).toBe('query_database')
    expect(toolIdToFunctionName('rag')).toBe('search_knowledge_base')
    expect(toolIdToFunctionName('rest')).toBe('call_rest_api')
    expect(toolIdToFunctionName('chat')).toBe('direct_chat')
  })

  test('recovers tool id from canonical function name', () => {
    expect(functionNameToToolId('query_database')).toBe('sql')
    expect(functionNameToToolId('search_knowledge_base')).toBe('rag')
    expect(functionNameToToolId('call_rest_api')).toBe('rest')
    expect(functionNameToToolId('direct_chat')).toBe('chat')
  })

  test('encodes and decodes colon-delimited tool IDs (admin & MCP)', () => {
    const adminFn = toolIdToFunctionName('admin:generate_api_key')
    expect(adminFn).toBe('admin__generate_api_key')
    expect(functionNameToToolId(adminFn)).toBe('admin:generate_api_key')

    const mcpFn = toolIdToFunctionName('mcp:server-1:get_weather')
    expect(mcpFn).toBe('mcp__server-1__get_weather')
    expect(functionNameToToolId(mcpFn)).toBe('mcp:server-1:get_weather')
  })

  test('encoded function names strictly match LLM regex ^[a-zA-Z0-9_-]{1,64}$', () => {
    const fn = toolIdToFunctionName('plugin:custom/special@tool:123')
    expect(fn).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
  })

  test('toLlmToolDef formats compliant function calling definition', () => {
    const def = toLlmToolDef(SQL_TOOL)
    expect(def.type).toBe('function')
    expect(def.function.name).toBe('query_database')
    expect(def.function.description).toContain('database')
    expect(def.function.parameters).toEqual(SQL_TOOL.parameters)
  })

  test('built-in tools have strict JSON schemas', () => {
    for (const tool of [SQL_TOOL, RAG_TOOL, REST_TOOL, WEB_SEARCH_TOOL, WEB_FETCH_TOOL, DIRECT_CHAT_TOOL]) {
      expect(tool.parameters.type).toBe('object')
      expect(tool.parameters.properties).toBeDefined()
      expect(Array.isArray(tool.parameters.required)).toBe(true)
    }
  })

  test('direct_chat tool returns message directly', async () => {
    const res = await DIRECT_CHAT_TOOL.execute({ message: 'Hello agent' }, { userId: 'u1' })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('Hello agent')
  })

  test('web_fetch tool rejects empty url', async () => {
    const res = await WEB_FETCH_TOOL.execute({ url: '' }, { userId: 'u1' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('URL parameter is required')
  })

  test('web_search tool rejects empty query', async () => {
    const res = await WEB_SEARCH_TOOL.execute({ query: '' }, { userId: 'u1' })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Query parameter is required')
  })

  test('admin tools reject non-admin execution', async () => {
    const adminTools = buildAdminUnifiedTools()
    const apiKeyTool = adminTools.find((t) => t.id === 'admin:generate_api_key')
    expect(apiKeyTool).toBeDefined()

    const res = await apiKeyTool!.execute({ label: 'test' }, { userId: 'u1', isAdmin: false })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('requires administrator privileges')
  })
})

describe('web_search is offered only when it can work', () => {
  // INCIDENT (MEASURED): the fallback scrapes `lite.duckduckgo.com`, and on a
  // network that hijacks that host it fails EVERY time. Here the host served an
  // ISP interstitial (`CN = dnssehat1.huma.net.id`), so all three probe queries
  // returned ERR_TLS_CERT_ALTNAME_INVALID. The tool stayed in the catalogue anyway,
  // and asked "cuaca di jakarta" both model families chose the broken `web_search`
  // over the `weather` plugin — which returns real data — in 10 of 10 runs each.
  // A listed-but-unusable tool does not merely waste a call; it outranks the right
  // one. After gating it: plugin:weather 10/10 on both families.
  const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    try { await fn() } finally {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v)
    }
  }
  const ids = async (): Promise<string[]> => {
    const { getUnifiedTools } = await import('./unified-tools')
    return (await getUnifiedTools({ query: 'cuaca jakarta', context: 'chat', isAdmin: false })).map((t) => t.id)
  }

  test('no backend configured → web_search is NOT offered, web_fetch IS', async () => {
    await withEnv({ SEARXNG_URL: undefined, WEB_SEARCH_SCRAPE_FALLBACK: undefined }, async () => {
      const found = await ids()
      expect(found).not.toContain('web_search')
      // Retrieval of a KNOWN url does not depend on any search backend, so it must
      // never be gated out with it.
      expect(found).toContain('web_fetch')
    })
  })

  test('a configured SearXNG makes web_search available', async () => {
    await withEnv({ SEARXNG_URL: 'http://searxng:8080' }, async () => {
      expect(await ids()).toContain('web_search')
    })
  })

  test('an explicit opt-in re-enables the scrape fallback', async () => {
    // The operator's escape hatch: set WEB_SEARCH_SCRAPE_FALLBACK=1 on a network
    // where DuckDuckGo is reachable.
    await withEnv({ SEARXNG_URL: undefined, WEB_SEARCH_SCRAPE_FALLBACK: '1' }, async () => {
      expect(await ids()).toContain('web_search')
    })
  })

  test('the exhaustive catalogue still contains every built-in', async () => {
    // CORE_BUILT_IN_TOOLS stays complete for callers that need the full list;
    // only the OPERATIONAL set is filtered. Conflating the two would make the
    // catalogue lie about what the build contains.
    const { CORE_BUILT_IN_TOOLS } = await import('./unified-tools')
    expect(CORE_BUILT_IN_TOOLS.map((t) => t.id)).toContain('web_search')
  })
})

describe('the two tool catalogues agree on web_search', () => {
  // INCIDENT: gating only the unified catalogue left `web_search` visible in the
  // LEGACY one, and the live harness caught the drift ("onlyLegacy":["web_search"]).
  // The legacy entry's description is the strongest in the codebase ("ALWAYS use
  // this ... NEVER use the chat tool"), so an unusable tool there would be chosen
  // even more forcefully than in the ReAct path. Both must be gated together.
  test('unified and legacy agree, with and without a search backend', async () => {
    const { getUnifiedTools } = await import('./unified-tools')
    const { getAvailableTools } = await import('./tool-registry')
    const saved = process.env.SEARXNG_URL
    try {
      for (const searxng of [undefined, 'http://searxng:8080']) {
        searxng === undefined ? delete process.env.SEARXNG_URL : (process.env.SEARXNG_URL = searxng)
        const unified = (await getUnifiedTools({ query: 'cuaca', context: 'agentic', isAdmin: false })).map((t) => t.id)
        const legacy = (await getAvailableTools('cuaca', 'agentic')).map((t) => t.id)
        expect(unified.includes('web_search'), `unified @ searxng=${searxng}`).toBe(legacy.includes('web_search'))
      }
    } finally {
      saved === undefined ? delete process.env.SEARXNG_URL : (process.env.SEARXNG_URL = saved)
    }
  })
})
