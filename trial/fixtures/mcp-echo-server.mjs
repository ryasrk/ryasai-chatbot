/** Minimal MCP stdio server used as a PLUGIN's implementation (executorType: mcp-stdio). */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'plugin-echo', version: '1.0.0' },
  { capabilities: { tools: {} } },
)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo_upper',
    description: 'Upper-case the given text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  }],
}))
server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: 'text', text: String(req.params.arguments?.text ?? '').toUpperCase() }],
}))
await server.connect(new StdioServerTransport())
