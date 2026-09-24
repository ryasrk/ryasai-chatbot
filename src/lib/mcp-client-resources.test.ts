import { test, expect, describe, mock, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  PromptListChangedNotificationSchema,
  ListRootsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

// ---------------------------------------------------------------------------
// mcp-client's NON-TOOL surfaces over a fake SDK: roots, list-changed and
// resource-updated notifications, resources (+ templates, subscriptions, the
// content cache), prompts, and the ephemeral stdio call plugins use.
//
// mcp-client-transport.test.ts covers the tool path. None of these ran in any
// test: the file doubled in size when resources/prompts/roots landed and its
// merged coverage fell 91% -> 52%. A separate file because the fake Client here
// needs the request/notification handler registry, which the transport file's
// double does not model.
// ---------------------------------------------------------------------------

type Handler = (arg: unknown) => unknown

/** Every Client the module constructed, newest last, so a test can reach its handlers. */
const clients: FakeClient[] = []

const sdk = {
  connectThrows: false,
  tools: [] as Array<{ name: string; description?: string }>,
  listToolsThrows: false,
  callResult: null as unknown,
  callToolThrows: false,
  resources: [] as unknown[],
  resourcesError: null as unknown,
  templates: [] as unknown[],
  templatesThrows: false,
  readResult: null as unknown,
  readThrows: false,
  readCalls: 0,
  subscribeError: null as unknown,
  subscribeCalls: [] as string[],
  unsubscribeCalls: [] as string[],
  unsubscribeThrows: false,
  prompts: [] as unknown[],
  promptsError: null as unknown,
  promptResult: null as unknown,
  promptThrows: false,
  promptCalls: [] as unknown[],
  notificationThrowsFor: new Set<FakeClient>(),
  notifications: [] as unknown[],
  setRequestHandlerThrows: false,
  setNotificationHandlerThrows: false,
  builtTransport: null as unknown,
  closeCalls: 0,
}

class FakeClient {
  requestHandlers = new Map<unknown, Handler>()
  notificationHandlers = new Map<unknown, Handler>()
  constructor(public info: unknown, public opts: { capabilities?: unknown }) {
    clients.push(this)
  }
  setRequestHandler(schema: unknown, handler: Handler) {
    if (sdk.setRequestHandlerThrows) throw new Error('schema unsupported by this SDK')
    this.requestHandlers.set(schema, handler)
  }
  setNotificationHandler(schema: unknown, handler: Handler) {
    if (sdk.setNotificationHandlerThrows) throw new Error('schema unsupported by this SDK')
    this.notificationHandlers.set(schema, handler)
  }
  async connect() {
    if (sdk.connectThrows) throw new Error('ECONNREFUSED')
  }
  async close() {
    sdk.closeCalls += 1
  }
  async notification(n: unknown) {
    if (sdk.notificationThrowsFor.has(this)) throw new Error('transport closed')
    sdk.notifications.push(n)
  }
  async listTools() {
    if (sdk.listToolsThrows) throw new Error('listTools timed out')
    return { tools: sdk.tools }
  }
  async callTool() {
    if (sdk.callToolThrows) throw new Error('tool exploded')
    return sdk.callResult
  }
  async listResources() {
    if (sdk.resourcesError) throw sdk.resourcesError
    return { resources: sdk.resources }
  }
  async listResourceTemplates() {
    if (sdk.templatesThrows) throw new Error('templates unsupported')
    return { resourceTemplates: sdk.templates }
  }
  async readResource() {
    sdk.readCalls += 1
    if (sdk.readThrows) throw new Error('read failed')
    return sdk.readResult
  }
  async subscribeResource({ uri }: { uri: string }) {
    sdk.subscribeCalls.push(uri)
    if (sdk.subscribeError) throw sdk.subscribeError
  }
  async unsubscribeResource({ uri }: { uri: string }) {
    sdk.unsubscribeCalls.push(uri)
    if (sdk.unsubscribeThrows) throw new Error('already gone')
  }
  async listPrompts() {
    if (sdk.promptsError) throw sdk.promptsError
    return { prompts: sdk.prompts }
  }
  async getPrompt(p: unknown) {
    sdk.promptCalls.push(p)
    if (sdk.promptThrows) throw new Error('prompt failed')
    return sdk.promptResult
  }
}

mock.module('@modelcontextprotocol/sdk/client', () => ({ Client: FakeClient }))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(opts: unknown) { sdk.builtTransport = opts }
  },
}))

let isolationLevel: 'namespaces' | 'rlimits' | 'none' = 'namespaces'
mock.module('@/lib/plugin-sandbox', () => ({
  resolveIsolation: () => ({ prefix: [], level: isolationLevel, detail: `level=${isolationLevel}` }),
  buildIsolatedArgv: (file: string, args: string[]) => ({ file: `sandboxed:${file}`, args }),
}))

const serverRow = (over: Record<string, unknown> = {}) => ({
  id: 'srv-1', name: 'docs', description: '',
  transport: 'stdio', command: 'node', args: '["server.mjs"]',
  url: '', envJson: '', headersJson: '', isEnabled: true, ...over,
})

let rows: ReturnType<typeof serverRow>[] = []
let rowById: Record<string, ReturnType<typeof serverRow>> = {}
mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findMany: async () => rows,
      findUnique: async ({ where }: { where: { id: string } }) => rowById[where.id] ?? null,
    },
  },
}))

import {
  listMcpRoots, notifyRootsChanged, listMcpTools, listMcpResources, readMcpResource,
  listMcpPrompts, getMcpPrompt, getActiveSubscriptions, invalidateMcpResourceContent,
  invalidateMcpResourcesCache, invalidateMcpPromptsCache, invalidateMcpToolsCache,
  disconnectMcpServer, disconnectAllMcp, callStdioMcpTool,
} from '@/lib/mcp-client'

const methodNotFound = () => Object.assign(new Error('Method not found'), { code: -32601 })

let warn: ReturnType<typeof spyOn>
const savedRoots = process.env.MCP_ROOTS

beforeEach(async () => {
  // Connections, subscriptions and every cache are module-level; a server
  // connected by one test would otherwise be reused by the next.
  await disconnectAllMcp()
  invalidateMcpToolsCache()
  invalidateMcpResourcesCache()
  invalidateMcpPromptsCache()
  invalidateMcpResourceContent()
  clients.length = 0
  Object.assign(sdk, {
    connectThrows: false, tools: [], listToolsThrows: false, callResult: null, callToolThrows: false,
    resources: [], resourcesError: null, templates: [], templatesThrows: false,
    readResult: null, readThrows: false, readCalls: 0,
    subscribeError: null, subscribeCalls: [], unsubscribeCalls: [], unsubscribeThrows: false,
    prompts: [], promptsError: null, promptResult: null, promptThrows: false, promptCalls: [],
    notificationThrowsFor: new Set(), notifications: [],
    setRequestHandlerThrows: false, setNotificationHandlerThrows: false,
    builtTransport: null, closeCalls: 0,
  })
  isolationLevel = 'namespaces'
  rows = [serverRow()]
  rowById = { 'srv-1': serverRow() }
  delete process.env.MCP_ROOTS
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  if (savedRoots === undefined) delete process.env.MCP_ROOTS
  else process.env.MCP_ROOTS = savedRoots
})

const warned = (fragment: string) =>
  warn.mock.calls.some((c: unknown[]) => c.map(String).join(' ').includes(fragment))

describe('listMcpRoots — the directories this install grants a server', () => {
  test('MCP_ROOTS unset advertises NO roots rather than guessing at the filesystem', () => {
    expect(listMcpRoots()).toEqual([])
  })

  // The allowlist is colon-separated absolute POSIX paths (the PATH convention),
  // which is the deployment target. On Windows a drive letter splits on ':'.
  describe.skipIf(process.platform === 'win32')('POSIX paths', () => {
    let dir = ''
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mcp-roots-')) })
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    test('an existing directory becomes a file:// root named after its basename', () => {
      process.env.MCP_ROOTS = ` ${dir} `
      expect(listMcpRoots()).toEqual([{ uri: `file://${dir}`, name: basename(dir) }])
    })

    test('a path that does not exist is dropped with a warning, not advertised', () => {
      process.env.MCP_ROOTS = `${dir}:${join(dir, 'missing')}`
      expect(listMcpRoots().map((r) => r.uri)).toEqual([`file://${dir}`])
      expect(warned('does not exist')).toBe(true)
    })

    test('a FILE is not a root: a server would be told it may work in a directory that is not one', () => {
      const file = join(dir, 'notes.txt')
      writeFileSync(file, 'x')
      process.env.MCP_ROOTS = file
      expect(listMcpRoots()).toEqual([])
      expect(warned('not a directory')).toBe(true)
    })

    test('the roots/list request handler answers with the same list', async () => {
      process.env.MCP_ROOTS = dir
      await listMcpTools()
      const handler = clients[0].requestHandlers.get(ListRootsRequestSchema)!
      expect(await handler({})).toEqual({ roots: [{ uri: `file://${dir}`, name: basename(dir) }] })
    })
  })
})

describe('client capabilities and handler registration', () => {
  test('declares roots.listChanged and NOT sampling/elicitation, which it cannot serve', async () => {
    await listMcpTools()
    expect(clients[0].opts.capabilities).toEqual({ roots: { listChanged: true } })
  })

  test('roots/list answers an empty grant when MCP_ROOTS is unset', async () => {
    await listMcpTools()
    const handler = clients[0].requestHandlers.get(ListRootsRequestSchema)!
    expect(await handler({})).toEqual({ roots: [] })
  })

  test('an SDK that rejects a handler schema still connects (each registration is guarded)', async () => {
    sdk.setRequestHandlerThrows = true
    sdk.setNotificationHandlerThrows = true
    sdk.tools = [{ name: 'echo' }]
    const tools = await listMcpTools()
    expect(tools.map((t) => t.toolName)).toEqual(['echo'])
    expect(warned('roots/list handler not registered')).toBe(true)
    expect(warned('resources/updated handler not registered')).toBe(true)
  })
})

describe('list_changed notifications drop the matching cache', () => {
  test('tools/list_changed forces the next listMcpTools to ask the server again', async () => {
    sdk.tools = [{ name: 'old' }]
    expect((await listMcpTools()).map((t) => t.toolName)).toEqual(['old'])
    sdk.tools = [{ name: 'new' }]
    expect((await listMcpTools()).map((t) => t.toolName)).toEqual(['old']) // cached
    clients[0].notificationHandlers.get(ToolListChangedNotificationSchema)!({})
    expect((await listMcpTools()).map((t) => t.toolName)).toEqual(['new'])
  })

  test('resources/list_changed forces a fresh resource listing', async () => {
    sdk.resources = [{ uri: 'doc://a', name: 'a' }]
    expect((await listMcpResources()).resources).toHaveLength(1)
    sdk.resources = []
    expect((await listMcpResources()).resources).toHaveLength(1) // cached
    clients[0].notificationHandlers.get(ResourceListChangedNotificationSchema)!({})
    expect((await listMcpResources()).resources).toHaveLength(0)
  })

  test('prompts/list_changed forces a fresh prompt listing', async () => {
    sdk.prompts = [{ name: 'summarise' }]
    expect(await listMcpPrompts()).toHaveLength(1)
    sdk.prompts = []
    expect(await listMcpPrompts()).toHaveLength(1) // cached
    clients[0].notificationHandlers.get(PromptListChangedNotificationSchema)!({})
    expect(await listMcpPrompts()).toHaveLength(0)
  })
})

describe('notifyRootsChanged', () => {
  test('tells every connected server, and one dead connection does not stop the rest', async () => {
    rows = [serverRow({ id: 'a', name: 'a' }), serverRow({ id: 'b', name: 'b' })]
    await listMcpTools()
    expect(clients).toHaveLength(2)
    sdk.notificationThrowsFor.add(clients[0])
    expect(await notifyRootsChanged()).toBe(1)
    expect(sdk.notifications).toEqual([{ method: 'notifications/roots/list_changed' }])
  })

  test('with nothing connected it tells no one', async () => {
    expect(await notifyRootsChanged()).toBe(0)
  })
})

describe('listMcpResources', () => {
  test('resources and templates are listed with server attribution and empty-string defaults', async () => {
    sdk.resources = [
      { uri: 'doc://handbook', name: 'Handbook', description: 'HR', mimeType: 'text/markdown' },
      { uri: 'doc://bare', name: 'Bare' },
    ]
    sdk.templates = [{ uriTemplate: 'doc://{id}', name: 'By id' }]
    const { resources, templates } = await listMcpResources()
    expect(resources).toEqual([
      { serverId: 'srv-1', serverName: 'docs', uri: 'doc://handbook', name: 'Handbook', description: 'HR', mimeType: 'text/markdown' },
      { serverId: 'srv-1', serverName: 'docs', uri: 'doc://bare', name: 'Bare', description: '', mimeType: '' },
    ])
    expect(templates).toEqual([
      { serverId: 'srv-1', serverName: 'docs', uriTemplate: 'doc://{id}', name: 'By id', description: '', mimeType: '' },
    ])
  })

  test('a server without template support still contributes its concrete resources', async () => {
    sdk.resources = [{ uri: 'doc://a', name: 'a' }]
    sdk.templatesThrows = true
    const { resources, templates } = await listMcpResources()
    expect(resources).toHaveLength(1)
    expect(templates).toEqual([])
  })

  test('"method not found" is a normal capability gap: skipped WITHOUT a warning', async () => {
    sdk.resourcesError = methodNotFound()
    expect((await listMcpResources()).resources).toEqual([])
    expect(warned('listResources failed')).toBe(false)
  })

  test('any other failure is warned about and the server is skipped', async () => {
    sdk.resourcesError = new Error('socket hang up')
    expect((await listMcpResources()).resources).toEqual([])
    expect(warned('listResources failed for "docs"')).toBe(true)
  })

  test('a server that cannot connect is skipped', async () => {
    sdk.connectThrows = true
    expect(await listMcpResources()).toEqual({ resources: [], templates: [] })
  })
})

describe('readMcpResource', () => {
  test('text parts are joined, the uri is subscribed, and the content is cached', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', mimeType: 'text/plain', text: 'one' }, { uri: 'doc://a', text: 'two' }] }
    expect(await readMcpResource('srv-1', 'doc://a')).toEqual({ ok: true, output: 'one\ntwo', mimeType: 'text/plain' })
    expect(sdk.subscribeCalls).toEqual(['doc://a'])
    expect(getActiveSubscriptions()).toEqual({ 'srv-1': ['doc://a'] })

    // Second read is served from the cache: no round trip, no second subscribe.
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'changed' }] }
    expect((await readMcpResource('srv-1', 'doc://a')).output).toBe('one\ntwo')
    expect(sdk.readCalls).toBe(1)
  })

  test('resources/updated for that uri drops the cached content, so the next read is fresh', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v1' }] }
    await readMcpResource('srv-1', 'doc://a')
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v2' }] }
    clients[0].notificationHandlers.get(ResourceUpdatedNotificationSchema)!({ params: { uri: 'doc://a' } })
    expect((await readMcpResource('srv-1', 'doc://a')).output).toBe('v2')
    // Already subscribed: the refresh must not subscribe a second time.
    expect(sdk.subscribeCalls).toEqual(['doc://a'])
  })

  test('an update for a DIFFERENT uri leaves this one cached', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v1' }] }
    await readMcpResource('srv-1', 'doc://a')
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v2' }] }
    clients[0].notificationHandlers.get(ResourceUpdatedNotificationSchema)!({ params: { uri: 'doc://b' } })
    expect((await readMcpResource('srv-1', 'doc://a')).output).toBe('v1')
  })

  test('a malformed update (no uri) clears ALL content — the conservative direction', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v1' }] }
    await readMcpResource('srv-1', 'doc://a')
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v2' }] }
    clients[0].notificationHandlers.get(ResourceUpdatedNotificationSchema)!({ params: {} })
    expect((await readMcpResource('srv-1', 'doc://a')).output).toBe('v2')
  })

  test('a binary-only resource is refused and NOT cached', async () => {
    sdk.readResult = { contents: [{ uri: 'img://a', mimeType: 'image/png', blob: 'iVBORw0' }] }
    expect(await readMcpResource('srv-1', 'img://a')).toEqual({
      ok: false, output: '', mimeType: 'image/png',
      error: 'Resource is binary; this client can only surface text resources.',
    })
    await readMcpResource('srv-1', 'img://a')
    expect(sdk.readCalls).toBe(2)
    expect(sdk.subscribeCalls).toEqual([])
  })

  test('mixed text + blob keeps the text; a resource with no contents is empty text', async () => {
    sdk.readResult = { contents: [{ uri: 'x', text: 'caption' }, { uri: 'x', blob: 'AAAA' }] }
    expect((await readMcpResource('srv-1', 'x')).output).toBe('caption')
    sdk.readResult = { contents: [] }
    expect(await readMcpResource('srv-1', 'empty')).toEqual({ ok: true, output: '', mimeType: '' })
  })

  test('an unknown or disabled server is reported unavailable', async () => {
    expect((await readMcpResource('nope', 'doc://a')).error).toBe('MCP server unavailable or inactive.')
    rowById['off'] = serverRow({ id: 'off', isEnabled: false })
    expect((await readMcpResource('off', 'doc://a')).ok).toBe(false)
  })

  test('a failed read returns the error instead of throwing', async () => {
    sdk.readThrows = true
    expect(await readMcpResource('srv-1', 'doc://a')).toEqual({ ok: false, output: '', mimeType: '', error: 'read failed' })
  })

  test('a server that cannot subscribe still serves the read, is not asked again, and is not warned about', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'x' }] }
    sdk.subscribeError = methodNotFound()
    expect((await readMcpResource('srv-1', 'doc://a')).ok).toBe(true)
    // Recorded anyway, so a later read of a different-cache-key does not retry it.
    expect(getActiveSubscriptions()).toEqual({ 'srv-1': ['doc://a'] })
    expect(warned('subscribe failed')).toBe(false)
  })

  test('an UNEXPECTED subscribe failure is warned about, and the read still succeeds', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'x' }] }
    sdk.subscribeError = new Error('socket hang up')
    expect((await readMcpResource('srv-1', 'doc://a')).ok).toBe(true)
    expect(warned('subscribe failed for doc://a')).toBe(true)
  })
})

describe('the resource content cache is a bounded LRU', () => {
  test('past MCP_RESOURCE_CACHE_MAX (default 100) the OLDEST entry is evicted', async () => {
    let n = 0
    Object.defineProperty(sdk, 'readResult', { get: () => ({ contents: [{ uri: 'u', text: `r${n++}` }] }), configurable: true })
    try {
      for (let i = 0; i <= 100; i++) await readMcpResource('srv-1', `doc://${i}`)
      expect(sdk.readCalls).toBe(101)
      await readMcpResource('srv-1', 'doc://100') // newest: still cached
      expect(sdk.readCalls).toBe(101)
      await readMcpResource('srv-1', 'doc://0') // oldest: evicted, so re-read
      expect(sdk.readCalls).toBe(102)
    } finally {
      Object.defineProperty(sdk, 'readResult', { value: null, writable: true, configurable: true })
    }
  })
})

describe('disconnect releases subscriptions and cached content', () => {
  test('disconnectMcpServer unsubscribes, closes, and drops that server\'s content', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v1' }] }
    await readMcpResource('srv-1', 'doc://a')
    await disconnectMcpServer('srv-1')
    expect(sdk.unsubscribeCalls).toEqual(['doc://a'])
    expect(getActiveSubscriptions()).toEqual({})
    // The cached content went with the connection: the next read reconnects and re-reads.
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v2' }] }
    expect((await readMcpResource('srv-1', 'doc://a')).output).toBe('v2')
  })

  test('a failing unsubscribe does not stop the disconnect', async () => {
    sdk.readResult = { contents: [{ uri: 'doc://a', text: 'v1' }] }
    await readMcpResource('srv-1', 'doc://a')
    sdk.unsubscribeThrows = true
    await disconnectAllMcp()
    expect(sdk.unsubscribeCalls).toEqual(['doc://a'])
    expect(getActiveSubscriptions()).toEqual({})
  })

  test('disconnecting a server that was never connected is a no-op', async () => {
    await disconnectMcpServer('never')
    expect(sdk.closeCalls).toBe(0)
  })
})

describe('listMcpPrompts', () => {
  test('prompts and their arguments are listed with defaults for optional fields', async () => {
    sdk.prompts = [
      { name: 'summarise', description: 'Summarise a doc', arguments: [{ name: 'doc', description: 'Doc id', required: true }, { name: 'tone' }] },
      { name: 'bare' },
    ]
    expect(await listMcpPrompts()).toEqual([
      {
        serverId: 'srv-1', serverName: 'docs', name: 'summarise', description: 'Summarise a doc',
        arguments: [{ name: 'doc', description: 'Doc id', required: true }, { name: 'tone', description: '', required: false }],
      },
      { serverId: 'srv-1', serverName: 'docs', name: 'bare', description: '', arguments: [] },
    ])
  })

  test('"method not found" is skipped quietly; anything else is warned about', async () => {
    sdk.promptsError = methodNotFound()
    expect(await listMcpPrompts()).toEqual([])
    expect(warned('listPrompts failed')).toBe(false)

    invalidateMcpPromptsCache()
    sdk.promptsError = new Error('boom')
    expect(await listMcpPrompts()).toEqual([])
    expect(warned('listPrompts failed for "docs"')).toBe(true)
  })

  test('a server that cannot connect is skipped', async () => {
    sdk.connectThrows = true
    expect(await listMcpPrompts()).toEqual([])
  })
})

describe('getMcpPrompt', () => {
  test('text parts are returned verbatim with the arguments passed through', async () => {
    sdk.promptResult = { messages: [{ role: 'user', content: { type: 'text', text: 'Summarise X' } }] }
    expect(await getMcpPrompt('srv-1', 'summarise', { doc: 'X' })).toEqual({ ok: true, output: 'Summarise X' })
    expect(sdk.promptCalls).toEqual([{ name: 'summarise', arguments: { doc: 'X' } }])
  })

  test('non-text parts are NOTED, not silently dropped', async () => {
    sdk.promptResult = {
      messages: [
        { role: 'user', content: { type: 'text', text: 'Look:' } },
        { role: 'user', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } },
        { role: 'user', content: { type: 'resource' } },
      ],
    }
    expect((await getMcpPrompt('srv-1', 'p', {})).output).toBe('Look:\n[2 non-text part(s) omitted]')
  })

  test('an unknown server, and a failing server, both return an error instead of throwing', async () => {
    expect(await getMcpPrompt('nope', 'p', {})).toEqual({ ok: false, output: '', error: 'MCP server unavailable or inactive.' })
    sdk.promptThrows = true
    expect(await getMcpPrompt('srv-1', 'p', {})).toEqual({ ok: false, output: '', error: 'prompt failed' })
  })
})

describe('callStdioMcpTool — the ephemeral server a plugin runs', () => {
  const spec = { command: 'node', args: ['server.mjs'], label: 'plugin:echo' }

  test('runs under the sandbox wrapper, calls the tool, and closes the client every time', async () => {
    sdk.tools = [{ name: 'echo' }]
    sdk.callResult = { content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'A' }] }
    const res = await callStdioMcpTool(spec, 'echo', { text: 'hi' })
    expect(res).toEqual({ ok: true, output: 'hi\n{"type":"image","data":"A"}' })
    expect(sdk.builtTransport).toEqual({ command: 'sandboxed:node', args: ['server.mjs'] })
    expect(sdk.closeCalls).toBe(1)
    // Full isolation is the quiet path.
    expect(warned('running with')).toBe(false)
  })

  test('a degraded sandbox is NAMED in the logs rather than silently accepted', async () => {
    isolationLevel = 'rlimits'
    sdk.tools = [{ name: 'echo' }]
    sdk.callResult = { content: [] }
    await callStdioMcpTool(spec, 'echo', {})
    expect(warned('plugin "plugin:echo" running with level=rlimits')).toBe(true)
  })

  test('a tool the server does not expose is refused before callTool, listing what exists', async () => {
    sdk.tools = [{ name: 'a' }, { name: 'b' }]
    const res = await callStdioMcpTool(spec, 'missing', {})
    expect(res.ok).toBe(false)
    expect(res.error).toContain('has no tool "missing". Available: a, b')
    expect(sdk.closeCalls).toBe(1)
  })

  test('a server whose tools/list FAILS is still called: enumeration is advisory, not a gate', async () => {
    sdk.listToolsThrows = true
    sdk.callResult = { content: [{ type: 'text', text: 'done' }] }
    expect(await callStdioMcpTool(spec, 'echo', {})).toEqual({ ok: true, output: 'done' })
  })

  test('isError results surface the server\'s own message, or a generic one when it gave none', async () => {
    sdk.tools = [{ name: 'echo' }]
    sdk.callResult = { isError: true, content: [{ type: 'text', text: 'bad input' }] }
    expect(await callStdioMcpTool(spec, 'echo', {})).toEqual({ ok: false, output: '', error: 'bad input' })
    sdk.callResult = { isError: true, content: 'not-an-array' }
    expect(await callStdioMcpTool(spec, 'echo', {})).toEqual({ ok: false, output: '', error: 'MCP tool returned an error.' })
  })

  test('a connect failure is reported with the plugin label and tool name', async () => {
    sdk.connectThrows = true
    const res = await callStdioMcpTool(spec, 'echo', {})
    expect(res).toEqual({ ok: false, output: '', error: 'MCP stdio plugin "plugin:echo" (echo): ECONNREFUSED' })
    expect(sdk.closeCalls).toBe(1)
  })
})
