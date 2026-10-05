/**
 * The selector must RESOLVE every tool call the model emitted, not just the first.
 *
 * WHY THIS FILE EXISTS, and why the existing guards were not enough. `tool-selector.test.ts` asserts on the SOURCE
 * TEXT of `tool-selector.ts`, which is the only option when a module has no seam to drive — but a source guard says
 * the code is WRITTEN, not that it RUNS. MEASURED: deleting the line that spreads `extraTools` into the returned
 * selection left every test green, including the source guards and the router test in `tool-router.test.ts` (which
 * mocks this module, so the assembly never executes there). That is the exact shape the repo has been bitten by
 * repeatedly: a field computed and then not returned, with nothing reporting it.
 *
 * So this file drives the REAL `selectToolWithLlm` against a stubbed provider response and asserts on its RETURN
 * VALUE. Everything below the transport is genuine.
 */
import { describe, expect, test, mock, beforeEach } from 'bun:test'

type ToolCall = { name: string; arguments: string }
let chatResult: string | ToolCall[] = 'no tool needed'
let chatThrows = false
/** The last messages the selector sent, so a test can prove what the model was shown. */
let lastMessages: Array<{ role: string; content: string }> = []

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => ({ id: 'r1', provider: 'openai', baseUrl: 'http://x', model: 'm', apiKey: 'k' }),
  getRoleLlmConfig: async () => null,
}))
mock.module('@/lib/llm-client', () => ({
  chatOnce: async (_cfg: unknown, messages: Array<{ role: string; content: string }>) => {
    lastMessages = messages
    if (chatThrows) throw new Error('provider down')
    return chatResult
  },
}))
mock.module('@/lib/unified-tools', () => ({
  SQL_TOOL: { id: 'sql', name: 'query_database', description: 'db', category: 'database', parameters: {} },
  getUnifiedTools: async () => [
    { id: 'sql', name: 'query_database', description: 'Query structured relational data', category: 'database', requiresDataSource: 'integration', parameters: { type: 'object', properties: {}, required: [] } },
    { id: 'rag', name: 'search_knowledge_base', description: 'Search company documents', category: 'knowledge', requiresDataSource: 'document', parameters: { type: 'object', properties: {}, required: [] } },
    { id: 'rest', name: 'call_rest_api', description: 'Call a whitelisted REST endpoint', category: 'api', parameters: { type: 'object', properties: {}, required: [] } },
  ],
  toLlmToolDef: (t: { name: string; description: string }) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: { type: 'object', properties: {}, required: [] } } }),
  functionNameToToolId: (name: string) => (name === 'query_database' ? 'sql' : name === 'search_knowledge_base' ? 'rag' : name === 'call_rest_api' ? 'rest' : null),
}))
mock.module('@/lib/db', () => ({
  db: { integration: { findMany: async () => [{ id: 'i1', name: 'HR Database', schemas: [{ tableName: 'karyawan' }] }] } },
}))
mock.module('@/lib/memory-routing', () => ({ routingMemoryBlock: () => '' }))
mock.module('@/lib/logger', () => ({ logSwallowed: () => () => {}, log: { info: () => {}, warn: () => {}, error: () => {} } }))

const { selectToolWithLlm } = await import('@/lib/tool-selector')

const ask = () => selectToolWithLlm({ question: 'Berapa hari cuti tahunan karyawan tetap dan berapa gaji pokok direktur utama?', context: 'chat', isAdmin: false, needsDatabaseListing: true })

beforeEach(() => {
  chatResult = 'no tool needed'
  chatThrows = false
  lastMessages = []
})

describe('selectToolWithLlm — every tool call is resolved', () => {
  test('the SECOND and later calls are returned in extraTools, with their own arguments', async () => {
    // The measured shape: the model asks for BOTH sources on a compound question.
    chatResult = [
      { name: 'search_knowledge_base', arguments: '{"query":"cuti tahunan"}' },
      { name: 'query_database', arguments: '{"question":"gaji pokok direktur","database":"HR Database"}' },
    ]
    const sel = await ask()
    expect(sel?.toolId).toBe('rag')
    expect(sel?.extraTools).toEqual([{ toolId: 'sql', args: { question: 'gaji pokok direktur', database: 'HR Database' } }])
  })

  test('THREE calls yield two extras, in order', async () => {
    chatResult = [
      { name: 'search_knowledge_base', arguments: '{}' },
      { name: 'query_database', arguments: '{}' },
      { name: 'call_rest_api', arguments: '{}' },
    ]
    const sel = await ask()
    expect(sel?.extraTools?.map((t) => t.toolId)).toEqual(['sql', 'rest'])
  })

  test('an identical REPEAT of a call is dropped — the same source would run twice', async () => {
    chatResult = [
      { name: 'search_knowledge_base', arguments: '{"query":"a","limit":3}' },
      // Same call, different key order and spacing.
      { name: 'search_knowledge_base', arguments: '{ "limit": 3, "query": "a" }' },
    ]
    const sel = await ask()
    expect(sel?.extraTools).toBeUndefined()
  })

  test('the SAME tool with different arguments is a second part, not a repeat', async () => {
    // Two databases in one question: both are `query_database`, and the second used to be dropped.
    chatResult = [
      { name: 'query_database', arguments: '{"question":"total orders","database":"HR Database"}' },
      { name: 'query_database', arguments: '{"question":"stock of SKU-1","database":"Warehouse"}' },
      { name: 'query_database', arguments: '{"question":"stock of SKU-1","database":"Warehouse"}' },
    ]
    const sel = await ask()
    expect(sel?.extraTools).toEqual([{ toolId: 'sql', args: { question: 'stock of SKU-1', database: 'Warehouse' } }])
  })

  test('an UNKNOWN tool name is dropped rather than carried as an id', async () => {
    chatResult = [
      { name: 'search_knowledge_base', arguments: '{}' },
      { name: 'invent_a_tool', arguments: '{}' },
    ]
    const sel = await ask()
    expect(sel?.extraTools).toBeUndefined()
  })

  test('a malformed argument blob keeps the REQUEST and sends empty args', async () => {
    // The tool id is what the caller routes on; the branch falls back to the user's question when its argument is
    // missing. Dropping the call over a JSON detail would lose half of a compound question.
    chatResult = [
      { name: 'search_knowledge_base', arguments: '{}' },
      { name: 'query_database', arguments: '{not json' },
    ]
    const sel = await ask()
    expect(sel?.extraTools).toEqual([{ toolId: 'sql', args: {} }])
  })

  test('a SINGLE call has no extras at all (the field stays absent)', async () => {
    chatResult = [{ name: 'search_knowledge_base', arguments: '{}' }]
    const sel = await ask()
    expect(sel?.toolId).toBe('rag')
    expect('extraTools' in (sel ?? {})).toBe(false)
  })

  test('text-only answers and provider failures are unchanged', async () => {
    const text = await ask()
    expect(text?.toolId).toBeNull()
    expect(text?.extraTools).toBeUndefined()
    chatThrows = true
    expect(await ask()).toBeNull()
  })
})
