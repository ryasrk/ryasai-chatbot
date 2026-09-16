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
import { getUnifiedTools, type UnifiedTool } from '@/lib/unified-tools'

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


// --- G. MCP resources and prompts ------------------------------------------
// A server may expose resources/prompts and NO tools at all. Without handling
// that surface it contributes nothing to the catalogue even though it has usable
// capability. Verified against a fixture that declares exactly that shape.
console.log('\nG. MCP resources and prompts (needs the resources fixture)')
{
  const {
    listMcpResources, readMcpResource, listMcpPrompts, getMcpPrompt, listMcpTools,
    invalidateMcpToolsCache, invalidateMcpResourcesCache, invalidateMcpPromptsCache,
  } = await import('@/lib/mcp-client')
  const fixture = new URL('./fixtures/mcp-resources-server.mjs', import.meta.url).pathname

  await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-res-fixture' } }))
  await bypassOrg(() =>
    db.mcpServer.create({
      data: {
        organizationId: orgRow!.organizationId, name: 'mcp-res-fixture',
        description: 'resources + prompts, no tools', transport: 'stdio', command: 'node',
        args: JSON.stringify([fixture]), url: '', envJson: '{}', headersJson: '{}', isEnabled: true,
      },
    }),
  )
  invalidateMcpToolsCache(); invalidateMcpResourcesCache(); invalidateMcpPromptsCache()

  try {
    const tools = (await listMcpTools()).filter((t) => t.serverName === 'mcp-res-fixture')
    check('a resources-only server lists ZERO tools without erroring', tools.length === 0, `${tools.length}`)

    const { resources } = await listMcpResources()
    const mine = resources.filter((r) => r.serverName === 'mcp-res-fixture')
    check('resources are listed', mine.length === 2, mine.map((r) => r.uri).join(','))

    const serverId = mine[0]?.serverId ?? ''
    const text = await readMcpResource(serverId, 'note://handbook')
    check('a text resource reads back', text.ok && text.output.includes('12 per year'), text.error ?? '')
    check('the mime type survives', text.mimeType === 'text/plain', text.mimeType)

    const bin = await readMcpResource(serverId, 'note://binary')
    check('a binary resource says so instead of returning base64', !bin.ok && /binary/i.test(bin.error ?? ''), bin.error ?? '')

    const prompts = (await listMcpPrompts()).filter((p) => p.serverName === 'mcp-res-fixture')
    check('prompts are listed with their arguments', prompts.length === 1 && prompts[0].arguments.length === 2)

    const rendered = await getMcpPrompt(prompts[0].serverId, 'summarize_resource', { uri: 'note://handbook', style: 'terse' })
    check('a prompt renders with its arguments', rendered.ok && rendered.output.includes('terse'), rendered.error ?? '')

    // The catalogue must offer them, not just the low-level client.
    const offered = await getUnifiedTools({ query: 'read the handbook', context: 'agentic', isAdmin: false })
    check('the catalogue offers a resource-read tool', offered.some((t) => t.id.startsWith('mcp-resource:')),
      offered.filter((t) => t.id.startsWith('mcp-resource:')).length + ' found')
    check('the catalogue offers a prompt tool', offered.some((t) => t.id.startsWith('mcp-prompt:')),
      offered.filter((t) => t.id.startsWith('mcp-prompt:')).length + ' found')

    const found: UnifiedTool | undefined = offered.find((t) => t.id.startsWith('mcp-resource:'))
    check('a resource-read tool is present to exercise', found !== undefined)
    if (found === undefined) {
      check('resource tool checks ran', false, 'no mcp-resource tool in the catalogue')
    } else {
      const resTool = found as UnifiedTool
      const props = resTool.parameters as { properties?: { uri?: { enum?: string[] } } }
      const uris = props.properties?.uri?.enum ?? []
      check('the resource tool constrains uri with an enum of KNOWN uris', uris.length === 2, uris.join(','))
      const bad = await resTool.execute({ uri: 'note://made-up' }, { userId: 'e2e', organizationId: orgRow!.organizationId })
      check('an unknown uri is rejected by the tool', !bad.ok, String(bad.error).slice(0, 60))
    }
  } finally {
    await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-res-fixture' } }))
    invalidateMcpToolsCache(); invalidateMcpResourcesCache(); invalidateMcpPromptsCache()
  }
}


// --- H. MCP resource CONTENT updates ---------------------------------------
// A resource's list entry can stay identical while its CONTENT is replaced, and
// `resources/list_changed` does NOT cover that. Only
// `notifications/resources/updated` does. Ignoring it served stale content for
// the life of the process, so the model answered from a document the server had
// already replaced. Negative-controlled: neutering the handler makes this
// section report "version 1" while the server has "version 2".
console.log('\nH. MCP resource content updates (needs the updated fixture)')
{
  const {
    listMcpResources, readMcpResource, invalidateMcpResourcesCache, invalidateMcpToolsCache,
  } = await import('@/lib/mcp-client')
  const fixture = new URL('./fixtures/mcp-updated-server.mjs', import.meta.url).pathname

  await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-updated-fixture' } }))
  await bypassOrg(() =>
    db.mcpServer.create({
      data: {
        organizationId: orgRow!.organizationId, name: 'mcp-updated-fixture',
        description: 'content changes at runtime', transport: 'stdio', command: 'node',
        args: JSON.stringify([fixture]), url: '', envJson: '{}', headersJson: '{}', isEnabled: true,
      },
    }),
  )
  invalidateMcpToolsCache(); invalidateMcpResourcesCache()

  try {
    const { resources } = await listMcpResources()
    const mine = resources.find((r) => r.serverName === 'mcp-updated-fixture')
    check('the fixture resource is listed', mine !== undefined)
    if (mine) {
      const first = await readMcpResource(mine.serverId, 'note://live')
      check('the first read returns version 1', first.output === 'version 1', first.output)
      const again = await readMcpResource(mine.serverId, 'note://live')
      check('a repeat read is served from cache', again.output === 'version 1', again.output)

      // The server flips to version 2 and emits resources/updated.
      await new Promise((r) => setTimeout(r, 6000))
      const after = await readMcpResource(mine.serverId, 'note://live')
      check('after resources/updated the NEW content is served (no manual reset)',
        after.output === 'version 2', after.output)
    }
  } finally {
    await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-updated-fixture' } }))
    invalidateMcpToolsCache(); invalidateMcpResourcesCache()
  }
}

// --- I. MCP client capabilities: roots -------------------------------------
// `roots` is a CLIENT capability: a server may call roots/list to learn which
// directories we permit it to work in. Without the declaration a well-behaved
// server assumes none and refuses file work. The fixture performs the real round
// trip and reports what WE said, so this asserts on the client's answer.
console.log('\nI. MCP client capabilities: roots')
{
  const { callMcpTool, listMcpTools, listMcpRoots, invalidateMcpToolsCache } = await import('@/lib/mcp-client')
  const { mkdirSync } = await import('node:fs')
  const fixture = new URL('./fixtures/mcp-roots-server.mjs', import.meta.url).pathname
  mkdirSync('/tmp/mcp-root-a', { recursive: true })
  mkdirSync('/tmp/mcp-root-b', { recursive: true })

  await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-roots-fixture' } }))
  await bypassOrg(() =>
    db.mcpServer.create({
      data: {
        organizationId: orgRow!.organizationId, name: 'mcp-roots-fixture', description: 'asks for roots',
        transport: 'stdio', command: 'node', args: JSON.stringify([fixture]),
        url: '', envJson: '{}', headersJson: '{}', isEnabled: true,
      },
    }),
  )
  invalidateMcpToolsCache()

  try {
    // The safe default must be TRUTHFUL, not a guess at the host filesystem.
    delete process.env.MCP_ROOTS
    check('with no MCP_ROOTS we advertise zero roots', listMcpRoots().length === 0)
    const sid = (await listMcpTools()).find((t) => t.serverName === 'mcp-roots-fixture')?.serverId ?? ''
    const none = await callMcpTool(sid, 'ask_roots', {})
    check('the server is told, truthfully, that we grant none',
      none.ok && none.output === 'CLIENT_REPORTED_NO_ROOTS', none.error ?? none.output)

    process.env.MCP_ROOTS = '/tmp/mcp-root-a:/tmp/mcp-root-b'
    const roots = listMcpRoots()
    check('both configured roots are exposed as file:// uris',
      roots.length === 2 && roots.every((r) => r.uri.startsWith('file://')), roots.map((r) => r.uri).join(','))
    const got = await callMcpTool(sid, 'ask_roots', {})
    check('the SERVER receives our roots over the protocol',
      got.ok && got.output.includes('file:///tmp/mcp-root-a') && got.output.includes('file:///tmp/mcp-root-b'),
      got.error ?? got.output)

    process.env.MCP_ROOTS = '/tmp/mcp-root-a:/does/not/exist'
    check('a non-existent root is ignored, not advertised', listMcpRoots().length === 1)
  } finally {
    delete process.env.MCP_ROOTS
    await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-roots-fixture' } }))
    invalidateMcpToolsCache()
  }
}

// --- J. MCP resource subscriptions -----------------------------------------
// The spec only requires a server to send `resources/updated` to clients that
// SUBSCRIBED to that uri. Honouring the notification without subscribing works
// only against servers that broadcast to everyone; against a conforming server
// the content stays stale forever.
console.log('\nJ. MCP resource subscriptions')
{
  const { listMcpResources, readMcpResource, getActiveSubscriptions, disconnectMcpServer, invalidateMcpResourcesCache, invalidateMcpToolsCache } =
    await import('@/lib/mcp-client')
  const fixture = new URL('./fixtures/mcp-subscribe-server.mjs', import.meta.url).pathname

  await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-subscribe-fixture' } }))
  await bypassOrg(() =>
    db.mcpServer.create({
      data: {
        organizationId: orgRow!.organizationId, name: 'mcp-subscribe-fixture', description: 'notifies subscribers only',
        transport: 'stdio', command: 'node', args: JSON.stringify([fixture]),
        url: '', envJson: '{}', headersJson: '{}', isEnabled: true,
      },
    }),
  )
  invalidateMcpToolsCache(); invalidateMcpResourcesCache()

  try {
    const { resources } = await listMcpResources()
    const mine = resources.find((r) => r.serverName === 'mcp-subscribe-fixture')
    check('the subscribable resource is listed', mine !== undefined)
    if (mine) {
      const first = await readMcpResource(mine.serverId, 'note://live')
      check('the first read returns version 1', first.output === 'version 1', first.output)
      check('reading a resource OPENS a subscription',
        (getActiveSubscriptions()[mine.serverId] ?? []).includes('note://live'),
        JSON.stringify(getActiveSubscriptions()))

      await new Promise((r) => setTimeout(r, 6000))
      const after = await readMcpResource(mine.serverId, 'note://live')
      check('the subscriber is notified, so NEW content is served', after.output === 'version 2', after.output)

      await disconnectMcpServer(mine.serverId)
      // Assert on THIS server's entry, not on global emptiness: earlier sections
      // legitimately hold subscriptions to their own fixtures, so requiring an
      // empty map asserted something `disconnectMcpServer` never promised.
      check('THIS server\'s subscriptions are released on disconnect',
        (getActiveSubscriptions()[mine.serverId] ?? []).length === 0,
        JSON.stringify(getActiveSubscriptions()[mine.serverId] ?? []))
    }
  } finally {
    await bypassOrg(() => db.mcpServer.deleteMany({ where: { name: 'mcp-subscribe-fixture' } }))
    invalidateMcpToolsCache(); invalidateMcpResourcesCache()
  }
}

// --- K. Plugin process isolation -------------------------------------------
// A plugin's mcp-stdio command is an interpreter, and an interpreter is
// Turing-complete: allowlisting it is a naming check, not containment. This
// asserts the sandbox actually removes the network and still runs a real plugin.
console.log('\nK. Plugin process isolation')
{
  const { resolveIsolation, buildIsolatedArgv } = await import('@/lib/plugin-sandbox')
  const plan = resolveIsolation()
  console.log(`  level: ${plan.level} — ${plan.detail}`)
  check('the host provides namespace isolation', plan.level === 'namespaces', plan.detail)

  if (plan.level === 'namespaces') {
    const { spawn } = await import('node:child_process')
    const probe = new URL('./fixtures/../fixtures/../fixtures/none', import.meta.url)
    void probe
    const script = `
      const os = require('os'), net = require('net');
      const n = Object.keys(os.networkInterfaces()).filter(x => x !== 'lo');
      console.log('IFACES:' + (n.length === 0 ? 'NONE' : n.join(',')));
      const s = net.connect({ host: '1.1.1.1', port: 53 }); s.setTimeout(3000);
      s.on('connect', () => { console.log('OUT:CONNECTED'); process.exit(0); });
      s.on('timeout', () => { console.log('OUT:TIMEOUT'); process.exit(0); });
      s.on('error', e => { console.log('OUT:BLOCKED:' + e.code); process.exit(0); });
    `
    const run = (argv: { file: string; args: string[] }) =>
      new Promise<string>((res) => {
        const p = spawn(argv.file, argv.args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let o = ''
        p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d))
        p.on('close', () => res(o)); setTimeout(() => { p.kill(); res('TIMEOUT') }, 15000)
      })

    const iso = await run(buildIsolatedArgv('node', ['-e', script], resolveIsolation('namespaces')))
    check('inside the sandbox the network is GONE', iso.includes('IFACES:NONE'), iso.trim())
    check('an outbound connection is BLOCKED', /OUT:BLOCKED/.test(iso), iso.trim())
  }

  // The sandbox must not break a working plugin.
  const { normalizeManifest, executePlugin } = await import('@/lib/plugin-registry')
  const fixture = new URL('./fixtures/mcp-echo-server.mjs', import.meta.url).pathname
  const m = normalizeManifest({
    manifestVersion: 2, executorType: 'mcp-stdio', command: 'node', args: [fixture], authType: 'NONE',
    description: 'echo',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  })
  if (!('error' in m)) {
    const r = await executePlugin({
      plugin: { manifestJson: JSON.stringify(m), toolId: 'echo_upper' },
      args: { text: 's' },
    })
    check('a real mcp-stdio plugin STILL WORKS under isolation', r.ok && r.output === 'S', r.error ?? r.output)
  } else {
    check('the echo manifest validated', false, m.error)
  }
}


// Summary LAST — an earlier exit here silently skipped the sections below it,
// so the harness reported success while never running them.
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`)
process.exit(failures === 0 ? 0 : 1)
