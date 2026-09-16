/**
 * MCP fixture exposing RESOURCES and PROMPTS (not just tools).
 *
 * WHY THIS EXISTS: a server may support resources/prompts and no tools at all, or
 * vice versa. Without a fixture that declares only resources/prompts we cannot
 * prove the client handles those surfaces rather than assuming every server has
 * tools. It also lets us assert the -32601 path: `listResourceTemplates` here is
 * deliberately NOT implemented, so a client that treats "method not found" as a
 * failure would log an error on every call.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const server = new Server(
  { name: 'mcp-resources-fixture', version: '1.0.0' },
  { capabilities: { resources: {}, prompts: {} } },   // NOTE: no `tools`
)

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: 'note://handbook', name: 'Employee Handbook', description: 'Company policy', mimeType: 'text/plain' },
    { uri: 'note://binary', name: 'Scanned Form', description: 'A binary blob', mimeType: 'application/pdf' },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'note://binary') {
    return { contents: [{ uri: req.params.uri, mimeType: 'application/pdf', blob: 'JVBERi0xLjQ=' }] }
  }
  return {
    contents: [{ uri: req.params.uri, mimeType: 'text/plain', text: 'HANDBOOK: rest days are 12 per year.' }],
  }
})

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: 'summarize_resource',
      description: 'Summarize a resource in a given style',
      arguments: [
        { name: 'uri', description: 'Resource URI', required: true },
        { name: 'style', description: 'Tone', required: false },
      ],
    },
  ],
}))

server.setRequestHandler(GetPromptRequestSchema, async (req) => ({
  description: 'rendered',
  messages: [
    { role: 'user', content: { type: 'text', text: `Summarize ${req.params.arguments?.uri} in ${req.params.arguments?.style ?? 'plain'} style.` } },
  ],
}))

// listResourceTemplates is deliberately absent -> JSON-RPC -32601.
await server.connect(new StdioServerTransport())
