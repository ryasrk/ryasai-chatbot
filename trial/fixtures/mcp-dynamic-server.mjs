/**
 * MCP fixture: a spec-compliant server whose tool set changes at RUNTIME.
 *
 * WHY THIS EXISTS: MCP servers may advertise `capabilities.tools.listChanged`
 * and then push `notifications/tools/list_changed` when their tools change — the
 * standard pattern for servers whose tools depend on auth or server-side config.
 * A client that caches the tool list and ignores that notification serves a STALE
 * catalogue. This fixture reproduces the case so the guard can assert on it.
 *
 * It adds its second tool ~2s after start and announces the change.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const DELAY_MS = Number(process.env.MCP_FIXTURE_DELAY_MS ?? 2000)
let toolCount = 1

const server = new Server(
  { name: 'mcp-dynamic-fixture', version: '1.0.0' },
  { capabilities: { tools: { listChanged: true } } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Array.from({ length: toolCount }, (_, i) => ({
    name: `dynamic_tool_${i + 1}`,
    description: `Dynamic tool number ${i + 1}`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: `called ${req.params.name}` }],
}))

setTimeout(() => {
  toolCount = 2
  server.notification({ method: 'notifications/tools/list_changed' }).catch(() => undefined)
  console.error('[mcp-dynamic-fixture] added tool 2 and sent notifications/tools/list_changed')
}, DELAY_MS).unref?.()

await server.connect(new StdioServerTransport())
