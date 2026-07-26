import { NextRequest } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { rememberChatTurn } from '@/lib/cognee'
import { db } from '@/lib/db'
import { planQuery, executePlan, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { streamAnswer } from '@/lib/ai'
import { testMcpServer, invalidateMcpToolsCache } from '@/lib/mcp-client'

// ponytail: lightweight known-names map for agentic MCP setup. Covers the
// common @modelcontextprotocol/server-* packages + a few uvx ones. Unknown
// names fall through to the package-name pattern. Add entries as needed.
const MCP_PACKAGES: Record<string, { pkg: string; runner: 'npx' | 'uvx' }> = {
  filesystem: { pkg: '@modelcontextprotocol/server-filesystem', runner: 'npx' },
  'google-drive': { pkg: '@modelcontextprotocol/server-google-drive', runner: 'npx' },
  'google-maps': { pkg: '@modelcontextprotocol/server-google-maps', runner: 'npx' },
  postgres: { pkg: '@modelcontextprotocol/server-postgres', runner: 'npx' },
  postgresql: { pkg: '@modelcontextprotocol/server-postgres', runner: 'npx' },
  sqlite: { pkg: 'mcp-server-sqlite', runner: 'uvx' },
  brave: { pkg: '@modelcontextprotocol/server-brave-search', runner: 'npx' },
  'brave-search': { pkg: '@modelcontextprotocol/server-brave-search', runner: 'npx' },
  fetch: { pkg: 'mcp-server-fetch', runner: 'uvx' },
  puppeteer: { pkg: '@modelcontextprotocol/server-puppeteer', runner: 'npx' },
  memory: { pkg: '@modelcontextprotocol/server-memory', runner: 'npx' },
  'sequential-thinking': { pkg: '@modelcontextprotocol/server-sequential-thinking', runner: 'npx' },
  github: { pkg: '@modelcontextprotocol/server-github', runner: 'npx' },
  gitlab: { pkg: '@modelcontextprotocol/server-gitlab', runner: 'npx' },
  aws: { pkg: '@modelcontextprotocol/server-aws', runner: 'npx' },
  slack: { pkg: '@modelcontextprotocol/server-slack', runner: 'npx' },
  stripe: { pkg: '@modelcontextprotocol/server-stripe', runner: 'npx' },
  sentry: { pkg: '@modelcontextprotocol/server-sentry', runner: 'npx' },
  time: { pkg: '@modelcontextprotocol/server-time', runner: 'npx' },
}

// ponytail: Agentic MCP setup — URL parsing requires regex (not LLM-decidable).
// Triggered by:
//   1. "add/install/set up mcp server [name]" (keyword-driven)
//   2. URL + (mcp|install|add|connect) keyword — "install this: https://…"
//   3. Bare URL that looks like an MCP endpoint (/sse, /mcp, /api/mcp)
async function tryMcpSetup(message: string, lower: string, userId: string): Promise<{ handled: boolean; output?: string }> {
  const urlInMessage = message.match(/https?:\/\/[^\s)]+/i)?.[0]
  const bareMcpUrl = message.match(/https?:\/\/[^\s]*\/(?:sse|mcp|api\/mcp)[^\s]*/i)?.[0]
  const mcpMatch = message.match(/(?:add|install|set\s*up)\s+(?:[\w-]+\s+)?(?:mcp\s+server|mcps?\b)/i)
  const urlWithKeyword = !!(urlInMessage && (lower.includes('mcp') || lower.includes('install') || lower.includes('add') || lower.includes('connect')))
  if (!mcpMatch && !urlWithKeyword && !bareMcpUrl) return { handled: false }

  const knownNames = Object.keys(MCP_PACKAGES)
  const nameMatch = knownNames.find((n) => lower.includes(n))
  const namedMatch = message.match(/(?:called|named)\s+([A-Za-z0-9_-]+)/i)
  let serverName = nameMatch
    ? nameMatch.charAt(0).toUpperCase() + nameMatch.slice(1)
    : namedMatch?.[1] ?? ''
  if (!serverName && urlInMessage) {
    try { serverName = new URL(urlInMessage).hostname } catch { serverName = '' }
  }
  if (!serverName) serverName = `MCP-${new Date().toISOString().slice(11, 19)}`

  let transport: 'stdio' | 'sse' | 'http' = 'stdio'
  let command = ''
  let args: string[] = []
  let url = ''

  if (urlInMessage) {
    transport = lower.includes('sse') ? 'sse' : 'http'
    url = urlInMessage
  } else {
    transport = 'stdio'
    const runner = lower.includes('uvx') ? 'uvx' : (nameMatch ? MCP_PACKAGES[nameMatch].runner : 'npx')
    command = runner
    if (nameMatch) {
      const pkg = MCP_PACKAGES[nameMatch].pkg
      args = runner === 'npx' ? ['-y', pkg] : [pkg]
      const pathMatch = message.match(/(?:for|at|path|dir|directory)\s+(\/[^\s]+)/i)
      if (pathMatch) {
        args.push(pathMatch[1])
      } else if (nameMatch === 'filesystem') {
        args.push('/tmp')
      }
      const connMatch = message.match(/(postgresql?:\/\/[^\s)]+|postgres:\/\/[^\s)]+)/i)
      if (connMatch) args.push(connMatch[1])
    } else {
      const pkgToken = `@modelcontextprotocol/server-${serverName.toLowerCase()}`
      args = runner === 'npx' ? ['-y', pkgToken] : [pkgToken]
    }
  }

  const created = await db.mcpServer.create({
    data: {
      name: serverName,
      description: `Installed via agentic setup`,
      transport,
      command,
      args: JSON.stringify(args),
      url,
      envJson: '{}',
      isEnabled: true,
      chatEnabled: true,
      agenticEnabled: true,
    },
  })
  invalidateMcpToolsCache()
  await writeAudit({
    userId, action: 'MCP_SERVER_CREATE', severity: 'warning',
    detail: { id: created.id, name: serverName, transport, via: 'agentic' },
  })

  const testResult = await testMcpServer(created.id)
  invalidateMcpToolsCache()

  if (testResult.ok) {
    const toolLines = (testResult.tools ?? []).map(
      (t) => `  - ${t.name}${t.description ? `: ${t.description}` : ''}`,
    )
    const configLine = transport === 'stdio'
      ? `Command: ${command} ${args.join(' ')}`
      : `URL: ${url}`
    return {
      handled: true,
      output: `MCP server "${serverName}" installed and connected.\nTransport: ${transport}\n${configLine}\nTools found: ${testResult.toolCount ?? 0}${
        toolLines.length > 0 ? '\n' + toolLines.join('\n') : ''
      }`,
    }
  }
  return {
    handled: true,
    output: `MCP server "${serverName}" was created but the connection test failed.\nTransport: ${transport}\nError: ${testResult.error}\n\nEdit the configuration in the Tools view to fix the issue.`,
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as { message?: string; conversationId?: string; sessionId?: string; timezone?: string }
    const message = (body.message ?? '').trim()
    const tz = body.timezone || 'UTC'
    if (!message) {
      return new Response(JSON.stringify({ error: 'Message is required.' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    let sessionId = body.sessionId ?? body.conversationId ?? null
    let sessionCreatedAt: Date = new Date()
    if (!sessionId) {
      const session = await db.chatSession.create({
        data: {
          title: `[Agent] ${new Date().toLocaleString('en-US')}`,
          userId: user.userId,
        },
      })
      sessionId = session.id
      sessionCreatedAt = session.createdAt
    } else {
      const existing = await db.chatSession.findUnique({ where: { id: sessionId }, select: { createdAt: true } })
      if (existing) sessionCreatedAt = existing.createdAt
    }

    await db.chatMessage.create({
      data: { sessionId, userId: user.userId, sender: 'user', text: message },
    }).catch(() => null)

    // Load chat history (last 10 messages, exclude agent sender to avoid duplication)
    const recentMessages = await db.chatMessage.findMany({
      where: { sessionId, sender: { in: ['user', 'ai'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { sender: true, text: true, createdAt: true },
    }).catch(() => [])
    const fmtOptsHist: Intl.DateTimeFormatOptions = { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }
    const chatHistory = recentMessages
      .reverse()
      .filter((m) => m.text && m.text.trim())
      .map((m) => {
        const ts = m.createdAt.toLocaleString('en-US', fmtOptsHist)
        const role = m.sender === 'user' ? 'user' as const : 'assistant' as const
        return { role, content: `[${ts} ${tz}] ${m.text}` }
      })

    const conversationId = sessionId
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\n`))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        }

        try {
          send('thinking', { content: 'Analyzing request...' })

          // ponytail: MCP setup is URL-driven (requires parsing URLs from text),
          // so it runs as a pre-check before the LLM planner. All other admin
          // actions are handled by the planner via admin:* tools.
          const mcpResult = await tryMcpSetup(message, message.toLowerCase(), user.userId)
          if (mcpResult.handled && mcpResult.output) {
            const mcpOutput = mcpResult.output
            send('tool_start', { stepId: 'mcp', tool: 'mcp_setup', input: { message } })
            send('tool_end', { stepId: 'mcp', tool: 'mcp_setup', output: mcpOutput, status: 'success', latencyMs: 0 })
            send('answer', { content: mcpOutput })
            send('done', { conversationId })
            await db.chatMessage.create({
              data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: mcpOutput, status: 'complete' },
            }).catch(() => null)
            await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)
            await rememberChatTurn({
              sessionId: conversationId,
              userMessage: message,
              aiMessage: mcpOutput,
              toolRuns: [{ type: 'mcp_setup', status: 'success', latencyMs: 0 }],
            })
            return
          }

          // LLM planner decides which tool to use (including admin:* tools)
          const availableTools = await getAvailableTools(message, 'agentic')
          const fmtOpts: Intl.DateTimeFormatOptions = { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }
          const sessionStart = sessionCreatedAt.toLocaleString('en-US', fmtOpts)
          const currentTime = new Date().toLocaleString('en-US', fmtOpts)
          const contextualizedMessage = `[Session started: ${sessionStart} ${tz}]\n[Current time: ${currentTime} ${tz}]\n\n${message}`

          const plan = await planQuery({ question: contextualizedMessage, availableTools, sessionId: conversationId, chatHistory })

          send('plan', {
            steps: plan.steps.map((s) => ({ id: s.id, tool: s.tool, input: s.input, dependsOn: s.dependsOn ?? [] })),
          })

          const stepStartTimes = new Map<string, number>()
          const results: PlanStepResult[] = await executePlan({
            plan,
            userId: user.userId,
            sessionId: conversationId,
            onStatus: (stepId, tool, status) => {
              if (status === 'running') {
                stepStartTimes.set(stepId, Date.now())
                send('tool_start', { stepId, tool })
              } else {
                const latencyMs = Date.now() - (stepStartTimes.get(stepId) ?? Date.now())
                send('tool_end', { stepId, tool, status: status === 'done' ? 'success' : 'error', latencyMs })
              }
            },
          })

          const synthesisContext = results.map(r => `Step ${r.stepId} (${r.tool}): ${r.output ?? r.error}`).join('\n')
          let fullAnswer = ''
          // ponytail: streamAnswer routes to configured LLM endpoint (fail-closed if unconfigured).
          // source 'SQL' is a neutral generic label for multi-source synthesis context.
          for await (const token of streamAnswer({ question: contextualizedMessage, context: synthesisContext, source: 'SQL', chatHistory })) {
            fullAnswer += token
            send('token', { content: token })
          }

          send('answer', { content: fullAnswer })
          send('done', { conversationId })

          await db.chatMessage.create({
            data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: fullAnswer, status: 'complete' },
          }).catch(() => null)
          await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)

          await writeAudit({
            userId: user.userId,
            action: 'AGENT_DASHBOARD',
            severity: 'info',
            detail: { message, conversationId, steps: plan.steps.length },
          })

          await rememberChatTurn({
            sessionId: conversationId,
            userMessage: message,
            aiMessage: fullAnswer,
            toolRuns: results.map((r) => ({ type: r.tool, status: r.ok ? 'success' : 'error', latencyMs: r.latencyMs })),
          })
        } catch (e) {
          send('error', { message: e instanceof Error ? e.message : 'An internal error occurred.' })
        } finally {
          controller.close()
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  } catch (e) {
    return handleApiError(e, 'Agentic dashboard failed.')
  }
}
