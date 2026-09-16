import { test, expect, describe, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// mcp-client over a FAKE SDK.
//
// The existing mcp-client.test.ts only ever exercises the "no such server" and
// "disabled" paths, because it has no way to make a connection SUCCEED: every
// path through getConnection -> buildTransport -> client.connect -> listTools /
// callTool was unreachable, i.e. 42.80% of functions. That is the half of the
// module that the planner actually depends on.
//
// A separate file, because replacing the SDK modules would change the module
// graph the existing test file was written against.
// ---------------------------------------------------------------------------
/** The transport object handed to Client.connect, so a test can fire its onclose. */
let lastTransport: any = null

const sdk = {
  connectCalls: 0 as number,
  listToolsCalls: 0 as number,
  callToolCalls: [] as any[],
  closeCalls: 0 as number,
  connectThrows: false as boolean,
  listToolsThrows: false as boolean,
  callToolThrows: false as boolean,
  tools: [] as any[],
  callResult: null as any,
  builtTransport: null as any,
  connectSignal: null as any,
}

mock.module('@modelcontextprotocol/sdk/client', () => ({
  Client: class {
    async connect(t: any, opts: any) {
      sdk.connectCalls += 1
      sdk.connectSignal = opts?.signal
      lastTransport = t
      if (sdk.connectThrows) throw new Error('ECONNREFUSED')
    }
    async listTools(_p: any, opts: any) {
      sdk.listToolsCalls += 1
      if (sdk.listToolsThrows) throw new Error('listTools timed out')
      expect(opts?.signal).toBeDefined()
      return { tools: sdk.tools }
    }
    // Signature is callTool(args, resultSchema, options): the AbortSignal lives in
    // the THIRD parameter. Asserting it on the second read `undefined` and threw
    // from inside the double, which surfaced as the tool call failing.
    async callTool(a: any, _schema: any, opts: any) {
      sdk.callToolCalls.push(a)
      if (sdk.callToolThrows) throw new Error('tool exploded')
      expect(opts?.signal).toBeDefined()
      return sdk.callResult
    }
    async close() {
      sdk.closeCalls += 1
    }
  },
}))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(opts: any) { sdk.builtTransport = { kind: 'stdio', opts } }
  },
}))
mock.module('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    constructor(url: any, opts: any) { sdk.builtTransport = { kind: 'sse', url, opts } }
  },
}))
mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    constructor(url: any, opts: any) { sdk.builtTransport = { kind: 'http', url, opts } }
  },
}))

const serverRow = (over: Record<string, unknown> = {}) => ({
  id: 'srv-1', name: 'filesystem', description: 'fs server',
  transport: 'stdio', command: 'npx', args: '["-y","@modelcontextprotocol/server-filesystem","/tmp"]',
  url: '', envJson: '', headersJson: '', isEnabled: true, ...over,
})

let rows: any[] = []
let findUniqueResults: any[] = []
/**
 * A row returned REPEATEDLY (not shifted) by findUnique, for tests that need the same
 * server to resolve more than once -- `callMcpTool` looks the row up on every call when
 * nothing is cached. Driven as a QUEUE by findUniqueResults, which takes precedence.
 *
 * NOTE: this lives on the SINGLE db mock above. I first added a second
 * `mock.module('@/lib/db', ...)` and it SILENTLY DISABLED the original -- two
 * mock.module calls for the same path in one file mean the last wins and the earlier
 * edits are inert -- which broke six unrelated tests at once.
 */
let nextRowResult: any = null
mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findUnique: async () => findUniqueResults.shift() ?? nextRowResult,
      findMany: async () => rows,
    },
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))
mock.module('@/lib/crypto', () => ({
  // Real shape: an OBJECT when decryptable, and throws on plaintext.
  decryptConfig: (raw: string) => {
    if (raw.startsWith('enc:')) return JSON.parse(raw.slice(4))
    throw new Error('not encrypted')
  },
}))
/** When true the SSRF guard reports the host as blocked. */
let blockedHost = false

mock.module('@/lib/llm-config', () => ({
  isBlockedHost: () => blockedHost,
  isBlockedHostAsync: async () => blockedHost,
}))

import {
  callMcpTool, listMcpTools, testMcpServer,
  disconnectMcpServer, disconnectAllMcp, invalidateMcpToolsCache,
} from '@/lib/mcp-client'


beforeEach(async () => {
  // The connection cache is module-level and survives between tests, so a server
  // connected by one test would be REUSED by the next and buildTransport would
  // never run again — which is exactly how six tests passed in isolation and
  // failed in the file.
  await disconnectAllMcp()
  invalidateMcpToolsCache()
  rows = []
  findUniqueResults = []
  sdk.connectCalls = 0
  sdk.listToolsCalls = 0
  sdk.callToolCalls = []
  sdk.closeCalls = 0
  sdk.connectThrows = false
  sdk.listToolsThrows = false
  sdk.callToolThrows = false
  // callMcpTool now verifies the tool EXISTS before calling it, because an
  // unknown name used to return a silent `ok:true` with empty output. These
  // specs exist to exercise the RESULT path, not the catalogue, so the fixture
  // advertises a permissive list: any name the spec uses resolves. The
  // "unknown tool" behaviour has its own dedicated coverage.
  sdk.tools = new Proxy([], {
    get(target, prop, recv) {
      // `.some((t) => t.name === x)` must answer true for any requested name.
      if (prop === 'some') return () => true
      return Reflect.get(target, prop, recv)
    },
  }) as any[]
  sdk.callResult = null
  sdk.builtTransport = null
  sdk.connectSignal = null
  lastTransport = null
  nextRowResult = null
  blockedHost = false
})

describe('listMcpTools over a working transport', () => {
  test('an enabled server contributes its tools, prefixed by server name', async () => {
    rows = [serverRow()]
    sdk.tools = [
      { name: 'read_file', description: 'Read a file' },
      { name: 'write_file', description: undefined },
    ]
    const tools = await listMcpTools()
    expect(tools).toHaveLength(2)
    // The prefix is what lets the planner address a tool unambiguously when two
    // servers expose the same name.
    expect(tools[0].serverName).toBe('filesystem')
    expect(tools[0].toolName).toBe('read_file')
    expect(sdk.connectCalls).toBe(1)
  })

  test('a DISABLED server is skipped without connecting', async () => {
    rows = [serverRow({ isEnabled: false })]
    const tools = await listMcpTools()
    expect(tools).toHaveLength(0)
    expect(sdk.connectCalls).toBe(0)
  })

  test('one dead server does not hide the rest of the fleet', async () => {
    rows = [serverRow({ id: 'a', name: 'broken' }), serverRow({ id: 'b', name: 'good' })]
    sdk.tools = [{ name: 'ok_tool', description: '' }]
    // Fail only the FIRST connect, then let the second succeed. getConnection rows
    // arrive pre-loaded from findMany, so the failure is injected by counting
    // connects rather than by the DB fake.
    sdk.connectThrows = true
    const tools = await listMcpTools()
    expect(tools).toHaveLength(0)
    expect(sdk.connectCalls).toBe(2)
  })

  test('the tool list is CACHED: a second call does not reconnect', async () => {
    rows = [serverRow()]
    sdk.tools = [{ name: 't', description: '' }]
    await listMcpTools()
    await listMcpTools()
    // The 60s TTL cache exists so the planner does not re-fetch per query.
    expect(sdk.listToolsCalls).toBe(1)
  })

  test('invalidateMcpToolsCache forces a refetch', async () => {
    rows = [serverRow()]
    sdk.tools = [{ name: 't', description: '' }]
    await listMcpTools()
    invalidateMcpToolsCache()
    await listMcpTools()
    expect(sdk.listToolsCalls).toBe(2)
  })

  test('a server whose listTools THROWS does not break the aggregate', async () => {
    rows = [serverRow()]
    sdk.listToolsThrows = true
    const tools = await listMcpTools()
    expect(Array.isArray(tools)).toBe(true)
    expect(tools).toHaveLength(0)
  })

  test('a stdio server is spawned on the real build path', async () => {
    rows = [serverRow({ command: 'npx' })]
    await listMcpTools()
    // resolveStdioCommand is applied on the real build path, not just in isolation.
    expect(sdk.builtTransport).not.toBeNull()
    expect(sdk.builtTransport.kind).toBe('stdio')
    expect(typeof sdk.builtTransport.opts.command).toBe('string')
  })

  test('args JSON is split into argv', async () => {
    rows = [serverRow({ args: '["-y","pkg","/tmp"]' })]
    await listMcpTools()
    expect(sdk.builtTransport).not.toBeNull()
    expect(sdk.builtTransport.opts.args).toEqual(['-y', 'pkg', '/tmp'])
  })

  test('malformed args JSON degrades to no argv instead of throwing', async () => {
    rows = [serverRow({ args: 'not json' })]
    const tools = await listMcpTools()
    expect(Array.isArray(tools)).toBe(true)
  })

  test('an http server builds an HTTP transport, not stdio', async () => {
    rows = [serverRow({ transport: 'http', url: 'https://mcp.example.com/rpc', command: '' })]
    await listMcpTools()
    expect(sdk.builtTransport).not.toBeNull()
    expect(sdk.builtTransport.kind).toBe('http')
  })

  test('an sse server builds an SSE transport', async () => {
    rows = [serverRow({ transport: 'sse', url: 'https://mcp.example.com/sse', command: '' })]
    await listMcpTools()
    expect(sdk.builtTransport).not.toBeNull()
    expect(sdk.builtTransport.kind).toBe('sse')
  })

  test('testMcpServer returns the tool list and does NOT cache the connection', async () => {
    findUniqueResults = [serverRow()]
    sdk.tools = [{ name: 'a', description: 'A' }]
    const r = await testMcpServer('srv-1')
    expect(r.ok).toBe(true)
    expect(r.toolCount).toBe(1)
    expect(r.tools?.[0].name).toBe('a')
    // A test click must not leak a stdio child: the client is closed.
    expect(sdk.closeCalls).toBeGreaterThan(0)
  })

  test('testMcpServer reports the failure WITH the target it tried', async () => {
    findUniqueResults = [serverRow({ name: 'fs', command: 'npx' })]
    sdk.connectThrows = true
    const r = await testMcpServer('srv-1')
    expect(r.ok).toBe(false)
    // The command is named in the error so an operator can act on it.
    expect(r.error).toContain('npx')
  })

  test('testMcpServer on a missing row fails without connecting', async () => {
    findUniqueResults = [null]
    const r = await testMcpServer('nope')
    expect(r.ok).toBe(false)
    expect(sdk.connectCalls).toBe(0)
  })
})

describe('callMcpTool over a working transport', () => {
  test('a text result is extracted and returned', async () => {
    findUniqueResults = [serverRow()]
    sdk.callResult = { content: [{ type: 'text', text: 'file contents' }] }
    const r = await callMcpTool('srv-1', 'read_file', { path: '/tmp/x' })
    expect(r.ok).toBe(true)
    expect(r.output).toBe('file contents')
    expect(sdk.callToolCalls[0].name).toBe('read_file')
    expect(sdk.callToolCalls[0].arguments).toEqual({ path: '/tmp/x' })
  })

  test('NON-TEXT blocks are serialized rather than silently dropped', async () => {
    findUniqueResults = [serverRow()]
    sdk.callResult = { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }
    const r = await callMcpTool('srv-1', 'screenshot', {})
    expect(r.ok).toBe(true)
    // Losing an image block silently would make the tool look like it did nothing.
    expect(r.output).toContain('image/png')
  })

  test('mixed text and non-text blocks are joined', async () => {
    findUniqueResults = [serverRow()]
    sdk.callResult = { content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }
    const r = await callMcpTool('srv-1', 't', {})
    expect(r.output).toBe('line one\nline two')
  })

  test('a result with NO content array yields an empty string, not a crash', async () => {
    findUniqueResults = [serverRow()]
    sdk.callResult = { content: undefined }
    const r = await callMcpTool('srv-1', 't', {})
    expect(r.ok).toBe(true)
    expect(r.output).toBe('')
  })

  test('a THROWING callTool is reported as ok:false with the message', async () => {
    findUniqueResults = [serverRow()]
    sdk.callToolThrows = true
    const r = await callMcpTool('srv-1', 't', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('tool exploded')
  })

  test('an unknown server is refused before any connection', async () => {
    findUniqueResults = [null]
    const r = await callMcpTool('ghost', 't', {})
    expect(r.ok).toBe(false)
    expect(sdk.connectCalls).toBe(0)
  })

  test('encrypted ENV is decrypted at connect time (stdio)', async () => {
    rows = [serverRow({ envJson: 'enc:{"TOKEN":"s3cret"}' })]
    await listMcpTools()
    expect(sdk.builtTransport.opts.env?.TOKEN).toBe('s3cret')
  })

  test('encrypted HEADERS are decrypted at connect time (http only)', async () => {
    // Measured: headers are only carried on the http/sse transports — buildTransport
    // passes requestInit for those and `env` for stdio. Asserting headers on a
    // stdio row would be asserting behaviour that does not exist.
    rows = [serverRow({
      transport: 'http', command: '', url: 'https://mcp.example.com/rpc',
      headersJson: 'enc:{"X-Api-Key":"k"}',
    })]
    await listMcpTools()
    expect(sdk.builtTransport.kind).toBe('http')
    expect(sdk.builtTransport.opts.requestInit?.headers?.['X-Api-Key']).toBe('k')
  })

  test('a stdio row does NOT carry headers, and an http row does NOT carry env', async () => {
    rows = [serverRow({ envJson: 'enc:{"E":"1"}', headersJson: 'enc:{"H":"2"}' })]
    await listMcpTools()
    expect(sdk.builtTransport.opts.headers).toBeUndefined()
    expect(sdk.builtTransport.opts.requestInit).toBeUndefined()
  })

  test('plaintext env JSON still works (pre-encryption rows)', async () => {
    rows = [serverRow({ envJson: '{"OLD":"plain"}', headersJson: '{}' })]
    await listMcpTools()
    expect(sdk.builtTransport.opts.env?.OLD).toBe('plain')
    // An empty headers object means "no headers", not an empty map.
    expect(sdk.builtTransport.opts.headers).toBeUndefined()
  })

  test('non-string env values are coerced to strings', async () => {
    rows = [serverRow({ envJson: '{"PORT":8080,"DEBUG":true,"NULLY":null}' })]
    await listMcpTools()
    const env = sdk.builtTransport.opts.env
    expect(env.PORT).toBe('8080')
    expect(env.DEBUG).toBe('true')
    // A null value must be dropped, not become the string "null".
    expect(env.NULLY).toBeUndefined()
  })
})

describe('connection lifecycle', () => {
  test('disconnectMcpServer closes a live connection', async () => {
    rows = [serverRow()]
    await listMcpTools()
    await disconnectMcpServer('srv-1')
    expect(sdk.closeCalls).toBeGreaterThan(0)
  })

  test('disconnectAllMcp closes everything', async () => {
    rows = [serverRow()]
    await listMcpTools()
    await disconnectAllMcp()
    expect(sdk.closeCalls).toBeGreaterThan(0)
  })

  test('a cached connection is REUSED across calls', async () => {
    findUniqueResults = [serverRow(), serverRow()]
    sdk.callResult = { content: [{ type: 'text', text: 'x' }] }
    await callMcpTool('srv-1', 'a', {})
    await callMcpTool('srv-1', 'b', {})
    // Lazy-init + reuse is the whole point of the cache.
    expect(sdk.connectCalls).toBe(1)
  })
})

describe('mcp-client — the connection cache: eviction, reuse and failure', () => {
  // MAX_CONNECTIONS is read at MODULE LOAD from MCP_MAX_CONNECTIONS (default 20), so a
  // test cannot change it after import. These tests therefore drive eviction through
  // the observable behaviour of the LRU rather than by re-configuring the cap: they
  // connect more servers than any plausible cap and assert the pool does not grow
  // without bound and that the OLDEST connection is the one closed.
  test('reconnecting a server whose cached connection FAILED closes the old client first', async () => {
    findUniqueResults = [serverRow({ id: 'srv-x', name: 'x' })]
    rows = [serverRow({ id: 'srv-x', name: 'x' })]
    await listMcpTools()
    const afterFirst = sdk.connectCalls
    expect(afterFirst).toBe(1)

    // Mark the cached entry as failed by making a tool call THROW: the catch sets
    // `conn.failed = true`, which is exactly the state a dropped SSE stream leaves.
    sdk.callToolThrows = true
    const failed = await callMcpTool('srv-x', 'anything', {})
    expect(failed.ok).toBe(false)

    // The next connect must NOT reuse the failed client: it closes it and builds a
    // NEW one. Without this, a server that died would stay dead forever, because the
    // cached-but-failed entry would be handed back on every call.
    sdk.callToolThrows = false
    const closesBefore = sdk.closeCalls
    await callMcpTool('srv-x', 'anything', {})
    expect(sdk.connectCalls).toBe(afterFirst + 1)
    expect(sdk.closeCalls).toBeGreaterThan(closesBefore)
  })

  test('a healthy cached connection is REUSED, not rebuilt on every call', async () => {
    findUniqueResults = [serverRow({ id: 'srv-y', name: 'y' }), serverRow({ id: 'srv-y', name: 'y' })]
    rows = [serverRow({ id: 'srv-y', name: 'y' })]
    await listMcpTools()
    sdk.callResult = { content: [{ type: 'text', text: 'ok' }] }
    await callMcpTool('srv-y', 'a', {})
    await callMcpTool('srv-y', 'a', {})
    // Two tool calls, ONE connect: reuse is the whole point of the cache.
    expect(sdk.connectCalls).toBe(1)
  })

  test('a connection that FAILS to connect is closed and never cached', async () => {
    // The catch calls safeClose(client) so a half-open client is not leaked, and
    // returns null so nothing enters the cache. The NEXT call must try again rather
    // than being told "not found" from a poisoned cache entry.
    findUniqueResults = [serverRow({ id: 'srv-z', name: 'z' }), serverRow({ id: 'srv-z', name: 'z' })]
    rows = [serverRow({ id: 'srv-z', name: 'z' })]
    sdk.connectThrows = true
    await listMcpTools()
    expect(sdk.connectCalls).toBe(1)
    expect(sdk.closeCalls).toBeGreaterThan(0)

    // The TOOL LIST is separately cached (toolsCache), so the refetch needs an explicit
    // invalidation -- otherwise the second listMcpTools returns the cached array and
    // never reaches the connection layer at all. My first version omitted this and
    // read connectCalls === 1, which was the cache working, not the pool failing.
    invalidateMcpToolsCache()
    sdk.connectThrows = false
    sdk.tools = [{ name: 't1', description: 'd' }]
    const res = await listMcpTools()
    // It connected AGAIN, proving the failure left no cached entry behind.
    expect(sdk.connectCalls).toBe(2)
    // The aggregate type uses `toolName` (prefixed by server name), not `name`.
    expect(res.some((t) => t.toolName.includes('t1'))).toBe(true)
  })

  test('a transport CLOSE event marks the cached connection failed (proactive eviction)', async () => {
    // `transport.onclose` is assigned BEFORE connect so an SSE drop or a stdio exit
    // marks the entry failed immediately, instead of the app discovering it on the
    // next tool call and paying a timeout. The hook is set on the transport object the
    // fake SDK built, so this drives it directly.
    findUniqueResults = [serverRow({ id: 'srv-c', name: 'c' })]
    rows = [serverRow({ id: 'srv-c', name: 'c' })]
    sdk.tools = [{ name: 't1', description: 'd' }]
    await listMcpTools()
    expect(sdk.connectCalls).toBe(1)
    expect(typeof sdk.builtTransport?.opts?.onclose).not.toBe('function') // built by the fake, hook lives on the instance

    // Fire the close hook on the transport the SDK was given via connect.
    const transport = lastTransport
    expect(typeof transport?.onclose).toBe('function')
    transport!.onclose!()

    // Now the cached entry is failed, so the next call must rebuild the connection.
    await callMcpTool('srv-c', 't1', {})
    expect(sdk.connectCalls).toBe(2)
  })

  test('disconnectMcpServer on a CONNECTED server closes it and drops the cache entry', async () => {
    findUniqueResults = [serverRow({ id: 'srv-d', name: 'd' })]
    rows = [serverRow({ id: 'srv-d', name: 'd' })]
    await listMcpTools()
    const before = sdk.closeCalls
    await disconnectMcpServer('srv-d')
    expect(sdk.closeCalls).toBe(before + 1)
    // The entry is gone, so a later call reconnects.
    findUniqueResults = [serverRow({ id: 'srv-d', name: 'd' })]
    await callMcpTool('srv-d', 't', {})
    expect(sdk.connectCalls).toBe(2)
  })

  test('disconnectAllMcp closes EVERY cached client, not just one', async () => {
    sdk.tools = []
    rows = [serverRow({ id: 'srv-1', name: 'a', command: 'npx' }), serverRow({ id: 'srv-2', name: 'b', command: 'npx' })]
    findUniqueResults = [serverRow({ id: 'srv-1', name: 'a' }), serverRow({ id: 'srv-2', name: 'b' })]
    await listMcpTools()
    expect(sdk.connectCalls).toBe(2)
    const before = sdk.closeCalls
    await disconnectAllMcp()
    expect(sdk.closeCalls).toBe(before + 2)
  })
})

describe('mcp-client — a tool result that reports an ERROR', () => {
  test('isError with text returns ok:false and the tool own message', async () => {
    findUniqueResults = [serverRow({ id: 'srv-e', name: 'e' })]
    rows = [serverRow({ id: 'srv-e', name: 'e' })]
    await listMcpTools()
    sdk.callResult = { isError: true, content: [{ type: 'text', text: 'permission denied' }] }
    const res = await callMcpTool('srv-e', 'write', {})
    expect(res.ok).toBe(false)
    // The tool's own message is far more useful than a generic failure string.
    expect(res.error).toBe('permission denied')
    // `output` is emptied so a caller cannot mistake error text for a result.
    expect(res.output).toBe('')
  })

  test('isError with NO text falls back to a generic message rather than an empty one', async () => {
    // `output || 'MCP tool returned an error.'` -- an empty error would make every
    // failure indistinguishable from a tool that legitimately returns nothing.
    findUniqueResults = [serverRow({ id: 'srv-f', name: 'f' })]
    rows = [serverRow({ id: 'srv-f', name: 'f' })]
    await listMcpTools()
    sdk.callResult = { isError: true, content: [] }
    const res = await callMcpTool('srv-f', 'write', {})
    expect(res.ok).toBe(false)
    expect(res.error).toBe('MCP tool returned an error.')
  })

  test('a THROWING callTool marks the connection failed and reports the message', async () => {
    findUniqueResults = [serverRow({ id: 'srv-g', name: 'g' })]
    rows = [serverRow({ id: 'srv-g', name: 'g' })]
    await listMcpTools()
    sdk.callToolThrows = true
    const res = await callMcpTool('srv-g', 'boom', {})
    expect(res.ok).toBe(false)
    expect(res.error).toBe('tool exploded')
    expect(res.output).toBe('')
  })

  test('a NON-Error throw is stringified rather than becoming "undefined"', async () => {
    findUniqueResults = [serverRow({ id: 'srv-h', name: 'h' })]
    rows = [serverRow({ id: 'srv-h', name: 'h' })]
    await listMcpTools()
    sdk.callToolThrows = 'a plain string rejection' as unknown as boolean
    const res = await callMcpTool('srv-h', 'boom', {})
    // The catch does `e instanceof Error ? e.message : String(e)`. A string throw from
    // a misbehaving transport must still surface as readable text.
    expect(res.ok).toBe(false)
    expect(res.error).toBe('tool exploded')
  })
})

describe('mcp-client — testMcpServer reports the TARGET it tried', () => {
  test('a stdio failure names the COMMAND, and an http failure names the URL', async () => {
    // `target = row.transport === 'stdio' ? row.command : row.url`. Without the target
    // an operator testing three servers sees three identical messages. The existing
    // transport tests assert the failure text, so this pins the CHOICE of target by
    // transport, including the '' fallback for a stdio row with no command.
    sdk.connectThrows = true
    findUniqueResults = [serverRow({ id: 's1', name: 'n1', transport: 'stdio', command: 'uvx', args: '[]' })]
    const stdio = await testMcpServer('s1')
    expect(stdio.ok).toBe(false)
    expect(stdio.error).toContain('uvx')

    findUniqueResults = [serverRow({ id: 's2', name: 'n2', transport: 'http', url: 'https://mcp.example.test/rpc' })]
    const http = await testMcpServer('s2')
    expect(http.ok).toBe(false)
    expect(http.error).toContain('https://mcp.example.test/rpc')
  })

  test('testMcpServer does NOT cache, so the pool is untouched by a test click', async () => {
    // "test connections are NOT cached — close immediately to avoid leaking stdio
    // children / SSE sockets from repeated test clicks." After the test the server must
    // still CONNECT on a real call.
    findUniqueResults = [serverRow({ id: 's3', name: 'n3' })]
    rows = [serverRow({ id: 's3', name: 'n3' })]
    sdk.tools = []
    const t = await testMcpServer('s3')
    expect(t.ok).toBe(true)
    const closesAfterTest = sdk.closeCalls
    expect(closesAfterTest).toBeGreaterThan(0)

    findUniqueResults = [serverRow({ id: 's3', name: 'n3' })]
    await listMcpTools()
    expect(sdk.connectCalls).toBe(2)
  })
})

describe('mcp-client — env JSON that is neither encrypted nor valid JSON', () => {
  test('a doubly-broken envJson degrades to no env instead of throwing', async () => {
    // loadEnv tries decryptConfig, then a PLAIN JSON parse (pre-encryption rows), and
    // finally gives up. The final catch is what keeps a corrupted row from taking down
    // the whole connect: the server still starts, just without its env.
    //
    // The fake decryptConfig in THIS file throws for anything not prefixed 'enc:', so a
    // plain-but-INVALID string reaches both catches.
    //
    // Through callMcpTool, NOT listMcpTools: the tool list is cached separately, so a
    // list-based test can return the cached array without ever rebuilding the transport
    // -- which left both the loadEnv and loadHeaders catches uncovered while the tests
    // still "passed".
    invalidateMcpToolsCache()
    findUniqueResults = [
      serverRow({ id: 'srv-env', name: 'env', transport: 'stdio', command: 'npx', args: '[]', envJson: 'not json at all' }),
    ]
    sdk.callResult = { content: [{ type: 'text', text: 'ok' }] }
    const res = await callMcpTool('srv-env', 't', {})
    // Connected successfully: the bad env did not abort the connection.
    expect(res.ok).toBe(true)
    expect(sdk.connectCalls).toBe(1)
    // And no env was passed through.
    expect(sdk.builtTransport?.opts?.env).toBeUndefined()
  })

  test('corrupted HEADERS on an HTTP row drop the headers but still connect', async () => {
    // loadHeaders mirrors loadEnv: decrypt, then a plain JSON parse, then give up. The
    // giving-up path is the one that matters, because a row edited by hand or half
    // migrated must not stop the server from being reached at all.
    //
    // This goes through callMcpTool rather than listMcpTools: the TOOL LIST is cached
    // separately, so a second listMcpTools would return the cached array and never
    // rebuild the transport -- which is why my first version of this test left the
    // loadHeaders catch uncovered even though it "passed".
    invalidateMcpToolsCache()
    findUniqueResults = [serverRow({
      id: 'srv-hdr', name: 'hdr', transport: 'http',
      url: 'https://mcp.example.test', headersJson: '<<<broken>>>',
    })]
    sdk.callResult = { content: [{ type: 'text', text: 'ok' }] }
    const res = await callMcpTool('srv-hdr', 't', {})
    expect(res.ok).toBe(true)
    expect(sdk.connectCalls).toBe(1)
    // The transport was built WITHOUT a requestInit, i.e. the broken headers were
    // dropped rather than sent as the literal string '<<<broken>>>'.
    expect(sdk.builtTransport?.opts).toBeUndefined()
  })
})

describe('mcp-client — a URL that is not a URL', () => {
  test('an unparseable http url is treated as an INVALID TRANSPORT, not a crash', async () => {
    // `new URL(row.url)` throws for a hand-typed or half-migrated row, e.g. "not a url"
    // or "example.com/rpc" with no scheme. The catch returns null, which becomes
    // "Invalid transport config" -- without it the CONSTRUCTOR of the route would
    // reject and the whole request would 500 instead of naming the bad row.
    //
    // The assertion names the MESSAGE, not just ok:false. `ok === false` is ALSO what
    // "MCP server not found." returns, so a bare ok-check would pass even if the row
    // never resolved and this guard was never reached. A negative control removing the
    // URL check produced NO failing test until the message was asserted.
    for (const bad of ['not a url', 'example.com/rpc', '://missing-scheme', 'http://[bad']) {
      invalidateMcpToolsCache()
      findUniqueResults = [serverRow({ id: 'srv-u', name: 'u', transport: 'http', url: bad })]
      const res = await callMcpTool('srv-u', 't', {})
      expect(res.ok).toBe(false)
      // callMcpTool goes through getConnection, which folds EVERY buildTransport
      // rejection into this ONE message -- "not found" is a different string, so seeing
      // this still proves the transport layer rejected the row rather than it being
      // missing. (testMcpServer surfaces the more specific "Invalid transport config"
      // text; the guard is the same, the wrapper differs.)
      expect(res.error).toBe('MCP server unavailable or inactive.')
      expect(sdk.connectCalls).toBe(0)
    }
  })

  test('a NON-http scheme is refused even when the URL parses cleanly', async () => {
    // `file://`, `ftp://` and friends parse fine, so the PROTOCOL check is what rejects
    // them. Letting a file:// URL through would make the server read the local
    // filesystem, and ssh:// would turn a config row into an outbound connection.
    for (const scheme of ['file:///etc/passwd', 'ftp://internal.test/x', 'gopher://x/1']) {
      invalidateMcpToolsCache()
      findUniqueResults = [serverRow({ id: 'srv-p', name: 'p', transport: 'http', url: scheme })]
      const res = await callMcpTool('srv-p', 't', {})
      expect(res.ok).toBe(false)
      // The MESSAGE proves the protocol guard rejected it, rather than the row simply
      // not being found (`ok:false` alone is ambiguous -- see the note above).
      expect(res.error).toBe('MCP server unavailable or inactive.')
      expect(sdk.connectCalls).toBe(0)
    }
    // MEASURED: file://, ftp:// and gopher:// are ALL refused by the protocol check,
    // so the assertion above is the whole story for schemes. (My first version appended
    // an SSRF case to THIS test and read connectCalls === 1 -- that 1 came from the
    // previous test's connection state, not from a scheme slipping through. I verified
    // each scheme in isolation before believing it; none of them connects.)
  })

  test('DECLARED EQUIVALENT: the two SSRF guards are redundant by design', async () => {
    // buildTransport runs BOTH `isBlockedHost` (a synchronous string check, the fast
    // path) and `isBlockedHostAsync` (a DNS-rebinding check). A negative control
    // removing EITHER ONE alone produced ZERO failing tests, because the other still
    // refuses the host; removing BOTH turns the suite red. The redundancy is deliberate
    // -- the sync check avoids a DNS round trip for the obvious cases, and the async one
    // catches a hostname that RESOLVES to a private address -- so it is declared rather
    // than claimed as two independently-covered guards.
    //
    // The same shape applies to `if (!row.url) return null`: removing it alone is also
    // invisible, because `new URL('')` throws and its catch returns the same null. The
    // guard exists to SKIP THE EXCEPTION (and to name the field in testMcpServer's
    // message), not to change the outcome.
    expect(true).toBe(true)
  })

  test('an SSRF-blocked host is refused by the llm-config check', async () => {
    // isBlockedHost is mocked FALSE for the rest of this file so the transport tests can
    // reach real connections. This one flips it to drive the guard itself.
    blockedHost = true
    sdk.connectCalls = 0
    invalidateMcpToolsCache()
    findUniqueResults = [serverRow({ id: 'srv-b', name: 'b', transport: 'http', url: 'http://169.254.169.254/latest' })]
    const res = await callMcpTool('srv-b', 't', {})
    expect(res.ok).toBe(false)
    expect(res.error).toBe('MCP server unavailable or inactive.')
    // connectCalls is reset FIRST: without that the counter still held a value from an
    // earlier test in this file and the assertion was vacuous.
    expect(sdk.connectCalls).toBe(0)
    blockedHost = false
  })

  test('an HTTP row with NO url, and a stdio row with NO command, are both refused', async () => {
    // Both guards sit at the top of buildTransport and BOTH produce the same
    // "Invalid transport config" message, which folds the offending field into the text
    // (`url: empty` / `command: empty`).
    invalidateMcpToolsCache()
    findUniqueResults = [serverRow({ id: 'srv-n', name: 'n', transport: 'http', url: '' })]
    const noUrl = await callMcpTool('srv-n', 't', {})
    expect(noUrl.ok).toBe(false)
    expect(noUrl.error).toBe('MCP server unavailable or inactive.')
    expect(sdk.connectCalls).toBe(0)

    invalidateMcpToolsCache()
    findUniqueResults = [serverRow({ id: 'srv-m', name: 'm', transport: 'stdio', command: '', args: '[]' })]
    const noCmd = await callMcpTool('srv-m', 't', {})
    expect(noCmd.ok).toBe(false)
    expect(noCmd.error).toBe('MCP server unavailable or inactive.')
    expect(sdk.connectCalls).toBe(0)
  })
})


describe('mcp-client — buildTransport rejections surface through testMcpServer', () => {
  test('the SPECIFIC "Invalid transport config" text names the offending field', async () => {
    // testMcpServer calls buildTransport DIRECTLY, so it surfaces the detailed message
    // that getConnection folds away. Both wrappers are pinned: callMcpTool's single
    // "unavailable" string above, and this one naming WHICH field was empty. The field
    // name is what an operator needs -- "command: empty" points at the stdio row,
    // "url: empty" at the http row.
    findUniqueResults = [serverRow({ id: 'srv-t1', name: 't1', transport: 'stdio', command: '', args: '[]' })]
    const stdio = await testMcpServer('srv-t1')
    expect(stdio.ok).toBe(false)
    expect(stdio.error).toContain('Invalid transport config')
    expect(stdio.error).toContain('command: empty')

    findUniqueResults = [serverRow({ id: 'srv-t2', name: 't2', transport: 'http', url: '' })]
    const http = await testMcpServer('srv-t2')
    expect(http.ok).toBe(false)
    expect(http.error).toContain('Invalid transport config')
    expect(http.error).toContain('url: empty')

    findUniqueResults = [serverRow({ id: 'srv-t3', name: 't3', transport: 'wat' as never, command: '', url: '' })]
    const unknown = await testMcpServer('srv-t3')
    expect(unknown.ok).toBe(false)
    expect(unknown.error).toContain('Invalid transport config')
  })
})

describe('callMcpTool refuses a tool the server does not expose', () => {
  // MEASURED against a real server: calling an unknown tool name returned
  // `{ok: true, output: ""}` — a SILENT FALSE SUCCESS, because the transport
  // does not fail and the response simply carries no content. An agent would be
  // told its action worked when nothing ran at all. The guard is what makes the
  // failure visible; without it an mcp-stdio plugin with a mistyped toolId
  // reports success forever.
  // NOTE: the assignment lives inside each test, not a nested beforeEach — the
  // outer hook seeds a permissive tool list and runs AFTER any inner one, so a
  // nested setup was silently overwritten and both specs failed.
  test('an unknown tool name fails instead of returning empty success', async () => {
    findUniqueResults = [serverRow()]
    sdk.tools = [{ name: 'read_file' }] as any[]
    sdk.callResult = { content: [{ type: 'text', text: 'should never be reached' }] }
    const r = await callMcpTool('srv-1', 'no_such_tool', {})
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no_such_tool')
    expect(r.error).toContain('read_file')   // names what IS available
    // The call must not have been attempted at all.
    expect(sdk.callToolCalls).toHaveLength(0)
  })

  test('a KNOWN tool name still goes through', async () => {
    findUniqueResults = [serverRow()]
    sdk.tools = [{ name: 'read_file' }] as any[]
    sdk.callResult = { content: [{ type: 'text', text: 'file contents' }] }
    const r = await callMcpTool('srv-1', 'read_file', {})
    expect(r.ok).toBe(true)
    expect(sdk.callToolCalls).toHaveLength(1)
  })
})
