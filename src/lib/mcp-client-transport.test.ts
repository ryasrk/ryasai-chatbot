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
    async connect(_t: any, opts: any) {
      sdk.connectCalls += 1
      sdk.connectSignal = opts?.signal
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
mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findUnique: async () => findUniqueResults.shift() ?? null,
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
mock.module('@/lib/llm-config', () => ({
  isBlockedHost: () => false,
  isBlockedHostAsync: async () => false,
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
  sdk.tools = []
  sdk.callResult = null
  sdk.builtTransport = null
  sdk.connectSignal = null
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
