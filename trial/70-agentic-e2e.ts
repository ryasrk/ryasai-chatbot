/**
 * LIVE end-to-end verification for the agentic (ReAct) surface.
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT IS NOT A UNIT TEST
 *
 * Every unit test mocks the LLM, so none of them can show that native function
 * calling works against a REAL gateway. That gap shipped a defect: the ReAct
 * loop completed round 1 (the model requests a tool) and threw on EVERY round 2,
 * because our internal `LlmToolCall` is `{ id, name, arguments }` while the
 * OpenAI wire format requires `{ id, type: "function", function: {...} }`.
 * MEASURED: without the nested shape the gateway answered `text/event-stream`
 * with a single `data: [DONE]` frame, so `readCompletionBody` rethrew
 * `SyntaxError: Unexpected identifier "data"`.
 *
 * Requires: a reachable DATABASE_URL, a configured provider in LlmConfig, and a
 * running AppConfig row. Run:  bun trial/70-agentic-e2e.ts
 *
 * Cases:
 *   A. tool round-trip  — the model must call a tool, then answer from the
 *      observation. This is the case the old code could not complete.
 *   B. no tool needed   — a pure conversation must make ZERO tool calls.
 *   C. multi-round      — two sequential tool rounds in one turn.
 *   D. catalogue        — every tool id must encode to a legal function name.
 */
import { enterWithOrg, bypassOrg } from '@/lib/prisma-tenant'
import { db } from '@/lib/db'
import { getLlmRuntimeConfig } from '@/lib/llm-config'
import { runAgentOrchestrator } from '@/lib/agent-orchestrator'
import { getUnifiedTools } from '@/lib/unified-tools'

const orgRow = await bypassOrg(() => db.appConfig.findFirst({ select: { organizationId: true } }))
if (!orgRow) {
  console.error('NO AppConfig row — cannot resolve an org context')
  process.exit(1)
}
enterWithOrg(orgRow.organizationId)

const cfg = await getLlmRuntimeConfig()
if (!cfg) {
  console.error('NO LlmConfig — the orchestrator cannot run')
  process.exit(1)
}
console.log('org :', orgRow.organizationId)
console.log('llm :', `${cfg.provider} ${cfg.model} @ ${cfg.baseUrl}\n`)

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

async function turn(question: string, maxRounds = 4) {
  const events: string[] = []
  const t0 = Date.now()
  const res = await runAgentOrchestrator({
    question,
    userId: 'e2e-probe',
    organizationId: orgRow!.organizationId,
    context: 'agentic',
    isAdmin: false,
    maxRounds,
    onEvent: (e) => events.push(`${e.type}${e.data.toolId ? ':' + e.data.toolId : ''}`),
  })
  return { res, events, ms: Date.now() - t0 }
}

// --- D. catalogue: function-name legality -----------------------------------
console.log('D. catalogue')
const tools = await getUnifiedTools({ query: 'search the web', context: 'agentic', isAdmin: false })
const illegal = tools.filter((t) => !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name))
check(`every tool id encodes to a legal function name (n=${tools.length})`, illegal.length === 0,
  illegal.map((t) => `${t.id}->${t.name}`).join(', '))
check('a colon-delimited id round-trips (plugin:)', tools.some((t) => t.id.startsWith('plugin:') && t.name.includes('__')))

// --- A. tool round-trip: the case the old code could not finish -------------
console.log('\nA. tool round-trip (the regression case)')
const a = await turn('Search the web for who won the 2022 FIFA World Cup, then answer with the winner.')
check('completed within maxRounds', a.res.iterations <= 4, `${a.res.iterations} rounds, ${a.ms}ms`)
check('a tool was actually invoked', a.res.toolRuns.length > 0, JSON.stringify(a.res.toolRuns.map((r) => `${r.type}:${r.status}`)))
check('an answer was produced', a.res.answer.trim().length > 20, `${a.res.answer.length} chars`)
check('answer is grounded (names the winner)', /argentina/i.test(a.res.answer), a.res.answer.slice(0, 90).replace(/\n/g, ' '))

// --- B. no tool needed ------------------------------------------------------
console.log('\nB. conversational turn makes no tool call')
const b = await turn('Reply with exactly the word PONG and nothing else.', 3)
check('zero tool runs', b.res.toolRuns.length === 0, `${b.res.toolRuns.length}`)
check('single round', b.res.iterations === 1, `${b.res.iterations}`)
check('answer present', b.res.answer.trim().length > 0, b.res.answer.slice(0, 40))

// --- C. multi-round: proves the wire shape survives a second tool round -----
console.log('\nC. multi-round (two sequential tool rounds)')
const c = await turn('First search the web for the 2022 FIFA World Cup final score, then fetch its Wikipedia page, then summarise what you learned in one sentence.')
check('more than one round', c.res.iterations > 1, `${c.res.iterations} rounds`)
check('at least two tool runs', c.res.toolRuns.length >= 2, `${c.res.toolRuns.length}`)
check('an answer was produced', c.res.answer.trim().length > 20, `${c.res.answer.slice(0, 80).replace(/\n/g, ' ')}`)


// --- E. catalogue parity ---------------------------------------------------
// TWO tool catalogues exist: tool-registry.ts (the legacy multi-step DAG, still
// live on the chat path) and unified-tools.ts (the ReAct orchestrator). Nothing
// structurally forces them to agree, so a tool added to one but not the other
// silently disappears for whichever surface the user is on. This check requires
// a real database, which is why it lives here and not in the unit suite.
console.log('\nE. catalogue parity (needs a populated DB)')
{
  const { getAvailableTools } = await import('@/lib/tool-registry')
  const unifiedChat = await getUnifiedTools({ query: 'database query knowledge search', context: 'chat', isAdmin: false })
  const legacyChat = await getAvailableTools('database query knowledge search', 'chat')
  const uniIds = unifiedChat.map((t) => t.id).sort()
  const legIds = legacyChat.map((t) => t.id).sort()
  check(`both catalogues expose the same ids (n=${uniIds.length})`, JSON.stringify(uniIds) === JSON.stringify(legIds),
    JSON.stringify({ onlyUnified: uniIds.filter((i) => !legIds.includes(i)), onlyLegacy: legIds.filter((i) => !uniIds.includes(i)) }))
  check('the catalogue is not empty', uniIds.length > 0)
}

// --- F. MCP runtime tool changes -------------------------------------------
// A spec-compliant server may add or remove tools at runtime and announce it
// with `notifications/tools/list_changed`. A client that caches the tool list
// and ignores that notification serves a STALE catalogue — the model cannot call
// a tool the server has just enabled. Measured before the fix: the client
// reported 1 tool where the server had 2, until the cache was reset by hand.
console.log('\nF. MCP runtime tool changes (needs the dynamic fixture)')
{
  const { listMcpTools, invalidateMcpToolsCache } = await import('@/lib/mcp-client')
  const fixture = new URL('./fixtures/mcp-dynamic-server.mjs', import.meta.url).pathname

  await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-dynamic-fixture' } }))
  await bypassOrg(() =>
    db.mcpServer.create({
      data: {
        organizationId: orgRow!.organizationId, name: 'mcp-dynamic-fixture',
        description: 'adds a tool at runtime and announces list_changed',
        transport: 'stdio', command: 'node', args: JSON.stringify([fixture]),
        url: '', envJson: '{}', headersJson: '{}', isEnabled: true,
      },
    }),
  )
  invalidateMcpToolsCache()

  try {
    const before = (await listMcpTools()).filter((t) => t.serverName === 'mcp-dynamic-fixture')
    check('the fixture starts with exactly one tool', before.length === 1, `${before.length}`)

    // Give the server time to add tool 2 and emit the notification.
    await new Promise((r) => setTimeout(r, 6000))

    const after = (await listMcpTools()).filter((t) => t.serverName === 'mcp-dynamic-fixture')
    // NO manual invalidation here — honouring the notification is the thing under test.
    check('the runtime-added tool is visible WITHOUT a manual cache reset', after.length === 2,
      `saw ${after.length}: ${after.map((t) => t.toolName).join(',')}`)
  } finally {
    await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-dynamic-fixture' } }))
    invalidateMcpToolsCache()
  }
}

// Summary LAST — an earlier exit here silently skipped the sections below it,
// so the harness reported success while never running them.
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
