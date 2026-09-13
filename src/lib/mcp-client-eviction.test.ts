import { test, expect, describe, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// mcp-client over the LRU CAP, at the boundary.
//
// MAX_CONNECTIONS is read at MODULE LOAD from MCP_MAX_CONNECTIONS, so the cap can only
// be lowered by setting the env var BEFORE the module is evaluated. That is main-unit
// behaviour rather than a convenience: an operator sizing the pool gets exactly what
// they set, and the eviction path cannot be reached at the default of 20 without
// opening twenty servers.
//
// THE IMPORT BELOW IS DELIBERATELY DYNAMIC. A static
// `import { callMcpTool } from '@/lib/mcp-client'` is HOISTED above the assignment, so
// the module is evaluated with the env var still UNSET and the cap becomes the default
// 20 -- eviction then never runs and every assertion here reads `closeCalls === 0`.
// I chased that for several probes, including nearly filing it as a product bug, before
// the difference between this file and a working probe turned out to be static vs
// dynamic import. The same ordering rule already bit this session for the license
// client.
// ---------------------------------------------------------------------------
process.env.MCP_MAX_CONNECTIONS = '2'

const sdk = {
  connectCalls: [] as string[],
  closeCalls: 0 as number,
}

mock.module('@modelcontextprotocol/sdk/client', () => ({
  Client: class {
    constructor(_i: any, _c: any) {}
    async connect(_t: any, _o: any) {
      sdk.connectCalls.push(`c${sdk.connectCalls.length}`)
    }
    async listTools() {
      return { tools: [] }
    }
    async callTool() {
      return { content: [{ type: 'text', text: 'ok' }] }
    }
    async close() {
      sdk.closeCalls += 1
    }
  },
}))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(_o: any) {}
  },
}))
mock.module('@modelcontextprotocol/sdk/client/sse.js', () => ({ SSEClientTransport: class {} }))
mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))

let nextRow: any = null
mock.module('@/lib/db', () => ({
  db: {
    mcpServer: {
      findUnique: async () => nextRow,
      findMany: async () => [],
    },
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
  log: { debug() {}, info() {}, warn() {}, error() {} },
  logSwallowed: () => () => {},
}))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => { throw new Error('nope') } }))
mock.module('@/lib/llm-config', () => ({ isBlockedHost: () => false, isBlockedHostAsync: async () => false }))

const { callMcpTool, disconnectAllMcp } = await import('@/lib/mcp-client')

const row = (id: string) => ({
  id, name: `srv-${id}`, description: '', transport: 'stdio',
  command: 'npx', args: '[]', url: '', envJson: '', headersJson: '', isEnabled: true,
})

/** `safeClose` is called fire-and-forget (`void safeClose(...)`), so a close counter is
 *  incremented in a LATER microtask than the call that triggered it. Asserting on it
 *  synchronously reads the value BEFORE the close ran -- which is how my first version
 *  of these tests reported `closeCalls === 0` and I nearly filed a non-existent bug. */
/** Two macrotask turns, because `safeClose` is `await`ed INSIDE an async helper that
 *  is itself called as `void safeClose(...)`: the close callback runs two microtask
 *  hops after the call that triggered it. One `setTimeout(0)` was not enough and my
 *  assertion read 0 -- I nearly filed a non-existent eviction bug over it. */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(async () => {
  await disconnectAllMcp()
  sdk.connectCalls = []
  sdk.closeCalls = 0
})

describe('mcp-client — the LRU connection cap', () => {
  test('the cap is honoured: connecting PAST it evicts the OLDEST connection', async () => {
    // With MCP_MAX_CONNECTIONS=2 the third DISTINCT server must push the pool back to
    // two, closing the first. Without eviction a fleet of configured servers would open
    // one stdio child / SSE socket each and never let go -- a slow resource leak that
    // only shows up on a long-lived process.
    for (const id of ['a', 'b', 'c']) {
      nextRow = row(id)
      await callMcpTool(id, 't', {})
      await flush()
    }
    expect(sdk.connectCalls.length).toBe(3)
    // 'a' was evicted and therefore closed; 'b' and 'c' are still live.
    await flush()
    expect(sdk.closeCalls).toBeGreaterThanOrEqual(1)

    // RECONNECTING the evicted server 'a' must open a NEW client, proving 'a' is gone
    // from the cache rather than merely having been closed.
    nextRow = row('a')
    await callMcpTool('a', 't', {})
    expect(sdk.connectCalls.length).toBe(4)

    // THE MAP must not grow either. Without `connections.delete(oldest)` an evicted entry
    // is CLOSED but still PRESENT, so the pool holds a dead client forever and the map
    // climbs on every new server. A control removing only the delete produced no failing
    // test until this assertion existed: closing and forgetting are different requirements.
    //
    // The assertion is on the entry just added, NOT on 'b': after re-adding 'a' the LRU
    // order is b,c,a, so the next insertion evicts 'b'. I asserted on 'b' first and it
    // rightly failed -- the most-recently used server is the one that must survive.
    await flush()
    const connectsBefore = sdk.connectCalls.length
    nextRow = row('c')
    await callMcpTool('c', 't', {})
    expect(sdk.connectCalls.length).toBe(connectsBefore)
  })

  test('staying AT the cap does not evict: the two most recent survive', async () => {
    for (const id of ['x', 'y']) {
      nextRow = row(id)
      await callMcpTool(id, 't', {})
      await flush()
    }
    const connectsAfterFill = sdk.connectCalls.length
    // Repeat both: both are cached, so NO new connection is built and nothing is
    // evicted. This is the half of the contract that a naive "always evict" would break.
    for (const id of ['x', 'y']) {
      nextRow = row(id)
      await callMcpTool(id, 't', {})
      await flush()
    }
    expect(sdk.connectCalls.length).toBe(connectsAfterFill)
  })

  test('one server over the cap does not evict everything, only the oldest', async () => {
    for (const id of ['p', 'q']) {
      nextRow = row(id)
      await callMcpTool(id, 't', {})
      await flush()
    }
    await flush()
    const before = sdk.closeCalls
    nextRow = row('r')
    await callMcpTool('r', 't', {})
    await flush()
    // Exactly ONE eviction for one insertion past the cap.
    expect(sdk.closeCalls).toBe(before + 1)
    // 'q' is still usable without reconnecting.
    nextRow = row('q')
    const beforeQ = sdk.connectCalls.length
    await callMcpTool('q', 't', {})
    expect(sdk.connectCalls.length).toBe(beforeQ)
  })
})
