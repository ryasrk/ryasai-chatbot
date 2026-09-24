import { test, expect, describe, mock, beforeEach, afterEach, spyOn } from 'bun:test'

// ---------------------------------------------------------------------------
// executePlugin for `mcp-stdio` manifests, driven END TO END through the real
// mcp-client over a fake SDK.
//
// plugin-registry.test.ts covers webhooks and the integrity gate, but every
// mcp-stdio test there either stopped at the gate or only normalised a
// manifest, so executeMcpStdioPlugin — the execution-time allowlist re-check
// and the input-to-arguments mapping — ran in no test at all. mcp-client is
// NOT mocked: the point is that the arguments the plugin layer builds are the
// ones the MCP tool actually receives.
// ---------------------------------------------------------------------------

const sdk = {
  constructorThrows: false,
  tools: [{ name: 'echo' }] as Array<{ name: string }>,
  callToolCalls: [] as Array<{ name: string; arguments: unknown }>,
  callResult: { content: [{ type: 'text', text: 'ok' }] } as unknown,
  spawned: [] as unknown[],
}

mock.module('@modelcontextprotocol/sdk/client', () => ({
  Client: class {
    constructor() {
      if (sdk.constructorThrows) throw new Error('SDK failed to initialise')
    }
    setRequestHandler() {}
    setNotificationHandler() {}
    async connect() {}
    async close() {}
    async listTools() { return { tools: sdk.tools } }
    async callTool(a: { name: string; arguments: unknown }) {
      sdk.callToolCalls.push(a)
      return sdk.callResult
    }
  },
}))
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(opts: unknown) { sdk.spawned.push(opts) }
  },
}))
mock.module('@/lib/plugin-sandbox', () => ({
  resolveIsolation: () => ({ prefix: [], level: 'namespaces', detail: '' }),
  buildIsolatedArgv: (file: string, args: string[]) => ({ file, args }),
}))

import { executePlugin } from '@/lib/plugin-registry'

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ manifestVersion: 2, executorType: 'mcp-stdio', command: 'node', args: ['srv.mjs'], authType: 'NONE', ...over })

let warn: ReturnType<typeof spyOn>
beforeEach(() => {
  sdk.constructorThrows = false
  sdk.tools = [{ name: 'echo' }]
  sdk.callToolCalls = []
  sdk.callResult = { content: [{ type: 'text', text: 'ok' }] }
  sdk.spawned = []
  warn = spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('executePlugin — mcp-stdio', () => {
  test('spawns the manifest command and calls the tool named by toolId', async () => {
    const res = await executePlugin({ plugin: { manifestJson: manifest(), toolId: 'echo' }, args: { text: 'hi' } })
    expect(res.ok).toBe(true)
    expect(res.output).toBe('ok')
    expect(res.latencyMs).toBeGreaterThanOrEqual(0)
    expect(sdk.spawned).toEqual([{ command: 'node', args: ['srv.mjs'] }])
    expect(sdk.callToolCalls).toEqual([{ name: 'echo', arguments: { text: 'hi' } }])
  })

  test('a manifest with no args spawns the command with an empty argv', async () => {
    await executePlugin({ plugin: { manifestJson: manifest({ args: undefined }), toolId: 'echo' }, args: {} })
    expect(sdk.spawned).toEqual([{ command: 'node', args: [] }])
  })

  test('a command stored BEFORE the allowlist changed is refused at execution, never spawned', async () => {
    // parsePluginManifest does not re-check the allowlist (normalizeManifest does,
    // at registration), so the execution-time check is the one that protects a
    // running system from an old row.
    const res = await executePlugin({ plugin: { manifestJson: manifest({ command: 'rm' }), toolId: 'echo' }, args: {} })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('Refusing to run "rm": not in the permitted command set')
    expect(sdk.spawned).toEqual([])
  })

  test('an mcp-stdio manifest with NO command is refused the same way', async () => {
    const res = await executePlugin({ plugin: { manifestJson: manifest({ command: undefined }), toolId: 'echo' } })
    expect(res.error).toContain('Refusing to run ""')
    expect(sdk.spawned).toEqual([])
  })

  describe('legacy `input` is mapped to tool arguments', () => {
    const argsFor = async (input?: string) => {
      await executePlugin({ plugin: { manifestJson: manifest(), toolId: 'echo' }, input })
      return sdk.callToolCalls.at(-1)?.arguments
    }

    test('a JSON object keeps its real types', async () => {
      expect(await argsFor('{"n":2,"flag":true}')).toEqual({ n: 2, flag: true })
    })

    test('JSON that is not an object (a bare number, null) is wrapped as { input }', async () => {
      expect(await argsFor('42')).toEqual({ input: '42' })
      expect(await argsFor('null')).toEqual({ input: 'null' })
    })

    test('plain text that is not JSON is wrapped as { input }', async () => {
      expect(await argsFor('what is 2+2')).toEqual({ input: 'what is 2+2' })
    })

    test('no input at all sends an empty argument object', async () => {
      expect(await argsFor(undefined)).toEqual({})
    })

    test('structured `args` win over `input` when both are given', async () => {
      await executePlugin({ plugin: { manifestJson: manifest(), toolId: 'echo' }, input: '{"a":1}', args: { b: 2 } })
      expect(sdk.callToolCalls.at(-1)?.arguments).toEqual({ b: 2 })
    })
  })

  test('a tool error from the server comes back as ok:false with its message', async () => {
    sdk.callResult = { isError: true, content: [{ type: 'text', text: 'bad input' }] }
    const res = await executePlugin({ plugin: { manifestJson: manifest(), toolId: 'echo' }, args: {} })
    expect(res).toMatchObject({ ok: false, output: '', error: 'bad input' })
  })

  test('a failure BEFORE the MCP call is caught and reported, not thrown to the planner', async () => {
    sdk.constructorThrows = true
    const res = await executePlugin({ plugin: { manifestJson: manifest(), toolId: 'echo' }, args: {} })
    expect(res).toMatchObject({ ok: false, output: '', error: 'SDK failed to initialise' })
  })
})
