/**
 * LIVE MCP verification against a REAL MCP server.
 * ----------------------------------------------------------------------------
 * Requires an enabled McpServer row. Seed one first, e.g.:
 *
 *   db.mcpServer.create({ data: { organizationId, name: 'fs-sandbox',
 *     description: 'FS sandbox', transport: 'stdio', command: 'npx',
 *     args: JSON.stringify(['-y','@modelcontextprotocol/server-filesystem','/tmp/mcp-sandbox']),
 *     url: '', envJson: '{}', headersJson: '{}', isEnabled: true } })
 *
 * Proves the thing the unit tests cannot: that a real server's tools survive the
 * adapter with their JSON Schema INTACT. A flattened schema would lose `tail`/
 * `head` as typed numbers and `$schema`, and the model would then guess.
 */
import { enterWithOrg, bypassOrg } from '@/lib/prisma-tenant'
import { db } from '@/lib/db'
import { listMcpTools, invalidateMcpToolsCache } from '@/lib/mcp-client'
import { buildMcpUnifiedTools } from '@/lib/unified-tools'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { runAgentOrchestrator } from '@/lib/agent-orchestrator'
import { getUnifiedTools } from '@/lib/unified-tools'

const orgRow = await bypassOrg(() => db.appConfig.findFirst({ select: { organizationId: true } }))
if (!orgRow) { console.error('NO AppConfig row'); process.exit(1) }
enterWithOrg(orgRow.organizationId)
invalidateMcpToolsCache()

let failures = 0
const check = (l: string, ok: boolean, d = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? ' — ' + d : ''}`); if (!ok) failures++ }

console.log('1. listMcpTools() against the real server')
const raw = await listMcpTools()
check('tools discovered', raw.length > 0, `${raw.length} tools`)
if (raw.length === 0) { console.error('no MCP tools — is a server enabled?'); process.exit(1) }

const sample = raw.find((t) => /read.*file/i.test(t.toolName)) ?? raw[0]
console.log(`\n2. schema fidelity for "${sample.toolName}"`)
console.log('   server schema:', JSON.stringify(sample.inputSchema).slice(0, 300))

const unified = await buildMcpUnifiedTools()
const u = unified.find((t) => t.id === `mcp:${sample.serverId}:${sample.toolName}`)
check('adapter produced a tool for every server tool', unified.length === raw.length, `${unified.length}/${raw.length}`)
check('reachable by its mcp: id', !!u, u?.id ?? '')
if (u) {
  check('schema is BYTE-IDENTICAL to the server\'s (lossless)',
    JSON.stringify(u.parameters) === JSON.stringify(sample.inputSchema), '')
  check('schema keeps typed properties', !!(u.parameters as { properties?: unknown }).properties,
    Object.keys((u.parameters as { properties?: Record<string, unknown> }).properties ?? {}).join(','))
  check('function name is LLM-legal', /^[a-zA-Z0-9_-]{1,64}$/.test(u.name), u.name)
}

console.log('\n3. agent turn: the model must choose and call an MCP tool')
const cfg = await getLlmRuntimeConfig()
if (!cfg) { console.log('  SKIP  no LLM configured'); process.exit(failures ? 1 : 0) }

const offered = (await getUnifiedTools({ query: 'read a file from the filesystem', context: 'agentic', isAdmin: false }))
  .filter((t) => t.category === 'mcp')
console.log(`   MCP tools offered to the model: ${offered.length}`)

const events: string[] = []
const t0 = Date.now()
const res = await runAgentOrchestrator({
  question: 'Using an MCP filesystem tool, read /tmp/mcp-sandbox/readme.txt and tell me its exact contents.',
  userId: 'mcp-live', organizationId: orgRow.organizationId,
  context: 'agentic', isAdmin: false, maxRounds: 4,
  onEvent: (e) => events.push(e.data.toolId ? `${e.type}:${String(e.data.toolId)}` : e.type),
})
console.log('   iterations:', res.iterations, '| ms:', Date.now() - t0)
console.log('   toolRuns  :', JSON.stringify(res.toolRuns.map((r) => `${r.type}:${r.status}`)))
console.log('   answer    :', res.answer.slice(0, 160).replace(/\n/g, ' '))
check('the model chose an MCP tool', events.some((e) => e.startsWith('tool_start:mcp:')), '')
check('an MCP call succeeded', res.toolRuns.some((r) => r.status === 'success'), '')
check('answer contains the real file contents', /hello from mcp sandbox/i.test(res.answer), '')

console.log(`\n${failures === 0 ? 'ALL MCP CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
