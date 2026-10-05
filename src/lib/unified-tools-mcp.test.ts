/**
 * MCP servers as unified tools — the three surfaces (tools, resources, prompts) and the guards they must share.
 *
 * Why this file exists: the module was 13.57% covered and ungated, and its own comment warned that copying the guard
 * block per surface is how one surface ends up without the breaker. The tools surface WAS a copy. The parametrised
 * tests below hold all three surfaces to the same behaviour under an open breaker, a rate limit and a thrown call.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

const mcp = {
  tools: [] as Array<{ serverId: string; serverName: string; toolName: string; description?: string; inputSchema?: unknown }>,
  resources: [] as Array<{ serverId: string; serverName: string; uri: string; name: string; description?: string }>,
  prompts: [] as Array<{ serverId: string; serverName: string; name: string; description?: string; arguments: Array<{ name: string; description?: string; required?: boolean }> }>,
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  result: { ok: true, output: 'mcp-output' } as { ok: boolean; output: string; error?: string },
  throwOnCall: null as Error | null,
  listThrows: false,
}
const call = (fn: string) => async (...args: unknown[]) => {
  mcp.calls.push({ fn, args })
  if (mcp.throwOnCall) throw mcp.throwOnCall
  return mcp.result
}
mock.module('@/lib/mcp-client', () => ({
  listMcpTools: async () => { if (mcp.listThrows) throw new Error('registry down'); return mcp.tools },
  listMcpResources: async () => { if (mcp.listThrows) throw new Error('registry down'); return { resources: mcp.resources } },
  listMcpPrompts: async () => mcp.prompts,
  callMcpTool: call('callMcpTool'),
  readMcpResource: call('readMcpResource'),
  getMcpPrompt: call('getMcpPrompt'),
}))

const guards = { breakerOpen: false, rateLimited: false, failures: [] as unknown[], successes: 0, rateChecks: [] as string[] }
mock.module('@/lib/tool-circuit-breaker', () => ({
  toolCircuitBreaker: {
    isExecutionAllowed: () => (guards.breakerOpen ? { allowed: false, reason: 'circuit open' } : { allowed: true }),
    recordSuccess: () => { guards.successes++ },
    recordFailure: (_id: string, e: unknown) => { guards.failures.push(e) },
  },
}))
mock.module('@/lib/tool-rate-limit', () => ({
  checkToolRateLimit: async (_kind: string, orgId: string) => { guards.rateChecks.push(orgId); return { allowed: !guards.rateLimited } },
}))
mock.module('@/lib/tool-sandbox', () => ({ withToolSandbox: async (_id: string, run: () => Promise<unknown>) => run() }))

const toolRuns: Array<Record<string, unknown>> = []
mock.module('@/lib/db', () => ({ db: { toolRun: { create: async (a: { data: Record<string, unknown> }) => { toolRuns.push(a.data); return a.data } } } }))
mock.module('@/lib/prisma-tenant', () => ({ getOrgContext: () => 'org-ctx' }))
mock.module('@/lib/logger', () => ({ logSwallowed: () => () => {} }))

const { buildMcpUnifiedTools, buildMcpResourceAndPromptTools } = await import('@/lib/unified-tools-mcp')

const ctx = { organizationId: 'org-1', userId: 'u1' } as never

beforeEach(() => {
  mcp.tools = [{ serverId: 'srv1', serverName: 'Files', toolName: 'list_files', description: 'List files', inputSchema: { type: 'object', properties: { dir: { type: 'string' } } } }]
  mcp.resources = [
    { serverId: 'srv1', serverName: 'Files', uri: 'file:///a.txt', name: 'A', description: 'first' },
    { serverId: 'srv1', serverName: 'Files', uri: 'file:///b.txt', name: 'B' },
  ]
  mcp.prompts = [{ serverId: 'srv1', serverName: 'Files', name: 'summarize', description: 'Summarise', arguments: [{ name: 'topic', required: true }, { name: 'depth' }] }]
  mcp.calls = []
  mcp.result = { ok: true, output: 'mcp-output' }
  mcp.throwOnCall = null
  mcp.listThrows = false
  guards.breakerOpen = false
  guards.rateLimited = false
  guards.failures = []
  guards.successes = 0
  guards.rateChecks = []
  toolRuns.length = 0
})

describe('MCP tools as unified tools', () => {
  test('each server tool becomes a function with the server\'s own schema and a labelled description', async () => {
    const [t] = await buildMcpUnifiedTools()
    expect(t.id).toBe('mcp:srv1:list_files')
    expect(t.category).toBe('mcp')
    expect(t.parameters).toEqual({ type: 'object', properties: { dir: { type: 'string' } } })
    expect(t.description).toBe('[MCP: Files] List files')
  })

  test('a tool without a schema gets an empty object schema, and without a description its name', async () => {
    mcp.tools = [{ serverId: 'srv1', serverName: 'Files', toolName: 'ping' }]
    const [t] = await buildMcpUnifiedTools()
    expect(t.parameters).toEqual({ type: 'object', properties: {} })
    expect(t.description).toBe('[MCP: Files] ping')
  })

  test('a registry failure yields no tools instead of failing the catalogue', async () => {
    mcp.listThrows = true
    expect(await buildMcpUnifiedTools()).toEqual([])
    expect(await buildMcpResourceAndPromptTools()).toEqual([])
  })

  test('a successful call returns the output, passes the params through, and records a ToolRun', async () => {
    const [t] = await buildMcpUnifiedTools()
    const r = await t.execute({ dir: '/tmp' }, ctx)
    expect(r).toMatchObject({ ok: true, output: 'mcp-output' })
    expect(mcp.calls).toEqual([{ fn: 'callMcpTool', args: ['srv1', 'list_files', { dir: '/tmp' }] }])
    expect(guards.successes).toBe(1)
    expect(toolRuns[0]).toMatchObject({ organizationId: 'org-1', status: 'success', type: 'PLUGIN' })
  })
})

describe('MCP resources and prompts as unified tools', () => {
  test('resources become ONE read tool per server, its URIs an enum', async () => {
    const tools = await buildMcpResourceAndPromptTools()
    const read = tools.find((t) => t.id === 'mcp-resource:srv1')!
    expect(tools.filter((t) => t.id.startsWith('mcp-resource:'))).toHaveLength(1)
    expect((read.parameters as { properties: { uri: { enum: string[] } } }).properties.uri.enum).toEqual(['file:///a.txt', 'file:///b.txt'])
    expect(read.description).toContain('file:///a.txt — A (first)')
  })

  test('an unknown URI is refused WITHOUT reaching the server', async () => {
    const read = (await buildMcpResourceAndPromptTools()).find((t) => t.id === 'mcp-resource:srv1')!
    const r = await read.execute({ uri: 'file:///etc/passwd' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Unknown resource URI')
    expect(mcp.calls).toHaveLength(0)
  })

  test('a known URI is read', async () => {
    const read = (await buildMcpResourceAndPromptTools()).find((t) => t.id === 'mcp-resource:srv1')!
    expect((await read.execute({ uri: 'file:///b.txt' }, ctx)).ok).toBe(true)
    expect(mcp.calls).toEqual([{ fn: 'readMcpResource', args: ['srv1', 'file:///b.txt'] }])
  })

  test('a prompt declares its arguments, marks the required ones, and receives them as strings', async () => {
    const p = (await buildMcpResourceAndPromptTools()).find((t) => t.id === 'mcp-prompt:srv1:summarize')!
    expect(p.parameters).toEqual({
      type: 'object',
      properties: { topic: { type: 'string', description: 'topic' }, depth: { type: 'string', description: 'depth' } },
      required: ['topic'],
    })
    await p.execute({ topic: 'leave', depth: 3, ignored: 'x' }, ctx)
    expect(mcp.calls).toEqual([{ fn: 'getMcpPrompt', args: ['srv1', 'summarize', { topic: 'leave', depth: '3' }] }])
  })
})

describe('every MCP surface shares the same guards', () => {
  const surfaces: Array<[string, () => Promise<{ execute: (p: Record<string, unknown>, c: never) => Promise<{ ok: boolean; error?: string }> }>, Record<string, unknown>]> = [
    ['tool', async () => (await buildMcpUnifiedTools())[0], { dir: '/' }],
    ['resource', async () => (await buildMcpResourceAndPromptTools()).find((t) => t.id.startsWith('mcp-resource:'))!, { uri: 'file:///a.txt' }],
    ['prompt', async () => (await buildMcpResourceAndPromptTools()).find((t) => t.id.startsWith('mcp-prompt:'))!, { topic: 't' }],
  ]

  test.each(surfaces)('%s: an open circuit refuses without calling the server', async (_name, get, params) => {
    guards.breakerOpen = true
    const r = await (await get()).execute(params, ctx)
    expect(r).toMatchObject({ ok: false, error: 'circuit open' })
    expect(mcp.calls).toHaveLength(0)
  })

  test.each(surfaces)('%s: the per-org rate limit refuses without calling the server', async (_name, get, params) => {
    guards.rateLimited = true
    const r = await (await get()).execute(params, ctx)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Rate limit')
    expect(guards.rateChecks).toEqual(['org-1'])
    expect(mcp.calls).toHaveLength(0)
  })

  test.each(surfaces)('%s: a THROWN call is an error result, recorded on the breaker as its message', async (_name, get, params) => {
    mcp.throwOnCall = new Error('server crashed')
    const r = await (await get()).execute(params, ctx)
    expect(r).toMatchObject({ ok: false, error: 'server crashed' })
    expect(guards.failures).toEqual(['server crashed'])
  })

  test.each(surfaces)('%s: a failed result is recorded as an error ToolRun', async (_name, get, params) => {
    mcp.result = { ok: false, output: '', error: 'not found' }
    const r = await (await get()).execute(params, ctx)
    expect(r).toMatchObject({ ok: false, error: 'not found' })
    expect(guards.failures).toEqual(['not found'])
    expect(toolRuns[0]).toMatchObject({ status: 'error', errorMessage: 'not found' })
  })

  test.each(surfaces)('%s: with no org in the call, the request context org is used', async (_name, get, params) => {
    await (await get()).execute(params, { userId: 'u1' } as never)
    expect(guards.rateChecks).toEqual(['org-ctx'])
    expect(toolRuns[0]).toMatchObject({ organizationId: 'org-ctx' })
  })
})
