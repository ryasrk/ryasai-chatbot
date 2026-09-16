/**
 * MCP fixture: a SPEC-CONFORMING server that notifies ONLY subscribers.
 *
 * WHY THIS IS THE RIGHT FIXTURE: the previous resource-update fixture announced
 * `resources/updated` unconditionally, so the client "worked" without ever
 * subscribing. The spec only requires a server to send that notification to
 * clients that SUBSCRIBED to the uri, so the earlier test could pass while a
 * conforming server would have sent us nothing.
 *
 * This fixture tracks subscriptions and sends `resources/updated` ONLY to a
 * subscriber. If the client never subscribes, the content silently stays stale —
 * which is exactly the failure the subscription exists to prevent.
 *
 * `note://live` reads "version 1" until the content flips to "version 2"
 * MCP_FIXTURE_DELAY_MS after the FIRST READ (not at start-up), so the flip can
 * only be observed by a client that was already subscribed.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const DELAY_MS = Number(process.env.MCP_FIXTURE_DELAY_MS ?? 2000)
let version = 1
let firstReadAt = null
const subscribers = new Set()

const server = new Server(
  { name: 'mcp-subscribe-fixture', version: '1.0.0' },
  // `subscribe: true` is the advertised promise; the fixture honours it.
  { capabilities: { resources: { subscribe: true, listChanged: true } } },
)

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{ uri: 'note://live', name: 'Live Note', description: 'subscribers only', mimeType: 'text/plain' }],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => ({ contents: [{
  uri: req.params.uri, mimeType: 'text/plain', text: `version ${version}`,
}]}))

server.setRequestHandler(SubscribeRequestSchema, async (req) => {
  subscribers.add(req.params.uri)
  console.error(`[mcp-subscribe-fixture] subscribed: ${req.params.uri}`)
  if (firstReadAt === null) {
    firstReadAt = Date.now()
    setTimeout(() => {
      version = 2
      // ONLY to subscribers, per spec.
      if (subscribers.has('note://live')) {
        server.notification({ method: 'notifications/resources/updated', params: { uri: 'note://live' } })
          .catch(() => undefined)
        console.error('[mcp-subscribe-fixture] content -> version 2, notified SUBSCRIBER')
      } else {
        console.error('[mcp-subscribe-fixture] content -> version 2, but NO subscriber to notify')
      }
    }, DELAY_MS).unref?.()
  }
  return {}
})

server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
  subscribers.delete(req.params.uri)
  console.error(`[mcp-subscribe-fixture] unsubscribed: ${req.params.uri}`)
  return {}
})

await server.connect(new StdioServerTransport())
