/**
 * MCP fixture: a server that ASKS THE CLIENT for its roots.
 *
 * WHY: `roots` is a CLIENT capability. A server may call `roots/list` to learn
 * which directories it is permitted to work in, and a well-behaved server
 * refuses file work when the client reports none. A client that never declares
 * the capability cannot answer, so the server is left to guess (the real
 * filesystem server logs "Client does not support MCP Roots" and falls back to
 * whatever it was started with).
 *
 * It exposes one tool, `ask_roots`, which performs the roots/list round trip and
 * returns what the CLIENT said — so the test asserts on the client's real answer,
 * not on the fixture's expectation.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'mcp-roots-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'ask_roots',
    description: 'Ask the client which roots it exposes',
    inputSchema: { type: 'object', properties: {} },
  }],
}))

server.setRequestHandler(CallToolRequestSchema, async () => {
  try {
    const res = await server.listRoots()
    const roots = res?.roots ?? []
    return {
      content: [{
        type: 'text',
        text: roots.length === 0
          ? 'CLIENT_REPORTED_NO_ROOTS'
          : roots.map((r) => `${r.uri}|${r.name ?? ''}`).join(','),
      }],
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `ROOTS_LIST_FAILED: ${e instanceof Error ? e.message : e}` }], isError: true }
  }
})

await server.connect(new StdioServerTransport())
