/**
 * MCP fixture: a server whose resource CONTENT changes at runtime, announced
 * with the spec's `notifications/resources/updated`.
 *
 * WHY: a resource list can stay identical while a resource's CONTENT is
 * replaced (a config file edited, a record updated). The list_changed
 * notification does NOT cover that, so a client that only caches by list will
 * serve stale content for the life of the process — the model then answers from
 * a document the server already replaced.
 *
 * `note://live` reports "version 1" until MCP_FIXTURE_DELAY_MS, then flips to
 * "version 2" and announces the change.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const DELAY_MS = Number(process.env.MCP_FIXTURE_DELAY_MS ?? 2000)
let version = 1

const server = new Server(
  { name: 'mcp-updated-fixture', version: '1.0.0' },
  { capabilities: { resources: { listChanged: true, subscribe: true } } },
)

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  // The LIST never changes — only the content does.
  resources: [{ uri: 'note://live', name: 'Live Note', description: 'content changes', mimeType: 'text/plain' }],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({
  contents: [{
    uri: req.params.uri,
    mimeType: 'text/plain',
    text: `version ${version}`,
  }],
}))

setTimeout(() => {
  version = 2
  server.notification({ method: 'notifications/resources/updated', params: { uri: 'note://live' } })
    .catch(() => undefined)
  console.error('[mcp-updated-fixture] content changed to version 2 and announced resources/updated')
}, DELAY_MS).unref?.()

await server.connect(new StdioServerTransport())
