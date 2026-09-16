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
