import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { hasPlan } from '@/lib/plan-gating'
import { rememberChatTurn } from '@/lib/cognee'
import { db } from '@/lib/db'
import { planQuery, executePlan, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { streamAnswer } from '@/lib/ai'
import { testMcpServer, invalidateMcpToolsCache, disconnectMcpServer } from '@/lib/mcp-client'
import { fetchMcpInstallFromUrl } from '@/lib/mcp-installer'
import { encryptConfig, decryptConfig } from '@/lib/crypto'

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
async function tryMcpSetup(message: string, lower: string, userId: string, organizationId: string, isAdmin: boolean): Promise<{ handled: boolean; output?: string }> {
  const urlInMessage = message.match(/https?:\/\/[^\s)]+/i)?.[0]
  const bareMcpUrl = message.match(/https?:\/\/[^\s]*\/(?:sse|mcp|api\/mcp)[^\s]*/i)?.[0]
  const mcpMatch = message.match(/(?:add|install|set\s*up)\s+(?:[\w-]+\s+)?(?:mcp\s+server|mcps?\b)/i)
  const urlWithKeyword = !!(urlInMessage && (lower.includes('mcp') || lower.includes('install') || lower.includes('add') || lower.includes('connect')))
  if (!mcpMatch && !urlWithKeyword && !bareMcpUrl) return { handled: false }

  // ponytail: MCP install spawns child processes (npx/uvx) — admins only.
  // Prevents a prompt-injected or crafted message from running arbitrary
  // packages as the app runtime user. Non-admins get a clear denial.
  if (!isAdmin) {
    return {
      handled: true,
      output: 'MCP server installation requires an administrator account. Ask an admin to add this MCP server.',
    }
  }

  // ponytail: confirmation gate — installing an MCP server via stdio spawns a
  // child process (npx/uvx). Require the user to explicitly confirm by including
  // "confirm" or "yes" in their message. Without this, a crafted message could
  // trigger arbitrary package execution with no approval.
  const isConfirmed = /\b(confirm|yes|proceed|go ahead)\b/i.test(message)
  if (!isConfirmed) {
    const knownNames = Object.keys(MCP_PACKAGES)
    const nameMatch = knownNames.find((n) => lower.includes(n))
    const serverName = nameMatch
      ? nameMatch.charAt(0).toUpperCase() + nameMatch.slice(1)
      : (message.match(/(?:called|named)\s+([A-Za-z0-9_-]+)/i)?.[1] ?? 'the server')
    return {
      handled: true,
      output: `I detected an MCP server install request for "${serverName}".\n\nThis will spawn a child process to run the MCP server. To confirm, reply with:\n\n  install ${serverName} confirm`,
    }
  }

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
  let requiredEnvVars: string[] = []

  if (urlInMessage) {
    // ponytail: URL could be a direct MCP endpoint (/sse, /mcp, /api/mcp) or a
    // repo/docs page with install instructions. For the latter, fetch the page
    // and parse for npx/uvx/JSON config patterns.
    const isDirectMcpEndpoint = /\/(?:sse|mcp|api\/mcp)/i.test(urlInMessage)
    if (isDirectMcpEndpoint) {
      transport = lower.includes('sse') ? 'sse' : 'http'
      url = urlInMessage
    } else {
      // Fetch the URL (GitHub README, docs page) and parse for install instructions
      const install = await fetchMcpInstallFromUrl(urlInMessage)
      if (install) {
        transport = 'stdio'
        command = install.command
        args = install.args
        if (install.name) serverName = install.name
        requiredEnvVars = install.envVars
      } else {
        // Could not parse install instructions — fall back to HTTP
        transport = 'http'
        url = urlInMessage
      }
    }
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

  // ponytail: defense-in-depth — only allow known safe runners for stdio spawn.
  // npx/uvx/node/python only; blocks any other command parsed from a fetched page.
  const ALLOWED_CMDS = new Set(['npx', 'uvx', 'node', 'python'])
  if (transport === 'stdio' && command && !ALLOWED_CMDS.has(command)) {
    await writeAudit({
      userId, action: 'MCP_SERVER_CREATE_BLOCKED', severity: 'warning',
      detail: { name: serverName, command, reason: 'disallowed command' },
    })
    return {
      handled: true,
      output: `MCP install blocked: command "${command}" is not in the allowed list (npx, uvx, node, python).`,
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
      organizationId,
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
    const envLine = requiredEnvVars.length > 0
      ? `\nRequired credentials: ${requiredEnvVars.join(', ')}\nTo set them, reply: set credentials for ${serverName}: ${requiredEnvVars.map((k) => `${k}=your_value`).join(', ')}`
      : ''
    return {
      handled: true,
      output: `MCP server "${serverName}" installed and connected.\nTransport: ${transport}\n${configLine}\nTools found: ${testResult.toolCount ?? 0}${
        toolLines.length > 0 ? '\n' + toolLines.join('\n') : ''
      }${envLine}`,
    }
  }
  // ponytail: if the connection test failed AND we detected required env vars,
  // the most likely cause is missing credentials — tell the user.
  const envHint = requiredEnvVars.length > 0
    ? `\n\nThis server requires credentials: ${requiredEnvVars.join(', ')}\nReply with: set credentials for ${serverName}: ${requiredEnvVars.map((k) => `${k}=your_value`).join(', ')}`
    : ''
  return {
    handled: true,
    output: `MCP server "${serverName}" was created but the connection test failed.\nTransport: ${transport}\nError: ${testResult.error}${envHint}\n\nEdit the configuration in the Tools view to fix the issue.`,
  }
}

// ponytail: credential handler — detects "set credentials for X: KEY=val, KEY=val"
// or "set GITHUB_TOKEN to ghp_xxx for X" and updates the MCP server's encrypted envJson.
async function tryMcpCredentials(message: string, lower: string, userId: string, isAdmin: boolean): Promise<{ handled: boolean; output?: string }> {
  // Pattern 1: "set credentials for <name>: KEY=val, KEY=val"
  const credMatch = message.match(/(?:set|update|add)\s+credentials\s+for\s+["']?([\w-]+)["']?\s*[:]\s*(.+)/i)
  // Pattern 2: "set <KEY> to <val> for <name>" (single key)
  const singleMatch = message.match(/(?:set|update)\s+([A-Z][A-Z0-9_]+)\s+(?:to|=)\s+(\S+)\s+for\s+["']?([\w-]+)["']?/i)

  let serverName: string
  let envUpdates: Record<string, string>

  if (credMatch) {
    serverName = credMatch[1]
    envUpdates = parseCredentialPairs(credMatch[2])
  } else if (singleMatch) {
    serverName = singleMatch[3]
    envUpdates = { [singleMatch[1]]: singleMatch[2].replace(/['"`]/g, '') }
  } else {
    return { handled: false }
  }

  if (Object.keys(envUpdates).length === 0) return { handled: false }

  // ponytail: MCP credentials are secrets — admins only.
  if (!isAdmin) {
    return {
      handled: true,
      output: 'Setting MCP server credentials requires an administrator account.',
    }
  }

  // Find the server by name (case-insensitive)
  const server = await db.mcpServer.findFirst({
    where: { name: { contains: serverName, mode: 'insensitive' } },
  })
  if (!server) {
    return {
      handled: true,
      output: `MCP server "${serverName}" not found. Use the Tools view to see registered servers.`,
    }
  }

  // Merge with existing env vars (decrypt, merge, re-encrypt)
  let existingEnv: Record<string, string> = {}
  if (server.envJson && server.envJson !== '{}') {
    try {
      const dec = decryptConfig(server.envJson)
      if (dec && typeof dec === 'object') existingEnv = dec as Record<string, string>
    } catch {
      // not encrypted or corrupt — start fresh
    }
  }
  const merged = { ...existingEnv, ...envUpdates }
  const encryptedEnv = encryptConfig(merged)

  await db.mcpServer.update({
    where: { id: server.id },
    data: { envJson: encryptedEnv },
  })
  await disconnectMcpServer(server.id)
  invalidateMcpToolsCache()
  await writeAudit({
    userId,
    action: 'MCP_SERVER_UPDATE',
    severity: 'warning',
    detail: { id: server.id, name: server.name, envKeys: Object.keys(envUpdates), via: 'agentic' },
  })

  // Re-test the connection with the new credentials
  const testResult = await testMcpServer(server.id)
  invalidateMcpToolsCache()

  const keysList = Object.keys(envUpdates).join(', ')
  if (testResult.ok) {
    return {
      handled: true,
      output: `Credentials updated for "${server.name}".\nSet: ${keysList}\nConnection test: OK (${testResult.toolCount ?? 0} tools available).`,
    }
  }
  return {
    handled: true,
    output: `Credentials updated for "${server.name}".\nSet: ${keysList}\nConnection test failed: ${testResult.error}\n\nThe credentials were saved. Check if the values are correct or if the server needs additional configuration.`,
  }
}

function parseCredentialPairs(s: string): Record<string, string> {
  const result: Record<string, string> = {}
  // Match KEY=value or KEY="value" or KEY='value' pairs separated by commas or spaces
  const regex = /([A-Z][A-Z0-9_]+)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s*,\s*|\s+|$)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(s)) !== null) {
    const key = m[1]
    const val = m[2] ?? m[3] ?? m[4]
    if (val) result[key] = val.replace(/['"`]/g, '')
  }
  return result
}

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    if (!hasPlan(user.plan, 'pro')) {
      return NextResponse.json({ error: 'Agent features require a Pro plan or higher.' }, { status: 403 })
    }
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
          organizationId: user.organizationId,
        },
      })
      sessionId = session.id
      sessionCreatedAt = session.createdAt
    } else {
      const existing = await db.chatSession.findUnique({ where: { id: sessionId }, select: { createdAt: true } })
      if (existing) sessionCreatedAt = existing.createdAt
    }

    await db.chatMessage.create({
      data: { sessionId, userId: user.userId, sender: 'user', text: message, organizationId: user.organizationId },
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

          // ponytail: MCP credential update — detect "set credentials for X: KEY=val"
          // before MCP setup (which is for new installs) and before the LLM planner.
          const credResult = await tryMcpCredentials(message, message.toLowerCase(), user.userId, user.role === 'admin')
          if (credResult.handled && credResult.output) {
            const credOutput = credResult.output
            send('tool_start', { stepId: 'mcp-cred', tool: 'mcp_credentials', input: { message: 'set credentials' } })
            send('tool_end', { stepId: 'mcp-cred', tool: 'mcp_credentials', output: credOutput, status: 'success', latencyMs: 0 })
            send('answer', { content: credOutput })
            send('done', { conversationId })
            await db.chatMessage.create({
              data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: credOutput, status: 'complete', organizationId: user.organizationId },
            }).catch(() => null)
            await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)
            await rememberChatTurn({
              sessionId: conversationId,
              userMessage: message,
              aiMessage: credOutput,
              toolRuns: [{ type: 'mcp_credentials', status: 'success', latencyMs: 0 }],
            })
            return
          }

          // ponytail: MCP setup is URL-driven (requires parsing URLs from text),
          // so it runs as a pre-check before the LLM planner. All other admin
          // actions are handled by the planner via admin:* tools.
          const mcpResult = await tryMcpSetup(message, message.toLowerCase(), user.userId, user.organizationId, user.role === 'admin')
          if (mcpResult.handled && mcpResult.output) {
            const mcpOutput = mcpResult.output
            send('tool_start', { stepId: 'mcp', tool: 'mcp_setup', input: { message } })
            send('tool_end', { stepId: 'mcp', tool: 'mcp_setup', output: mcpOutput, status: 'success', latencyMs: 0 })
            send('answer', { content: mcpOutput })
            send('done', { conversationId })
            await db.chatMessage.create({
              data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: mcpOutput, status: 'complete', organizationId: user.organizationId },
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

          // LLM planner decides which tool to use (admin:* only for admins)
          const availableTools = await getAvailableTools(message, 'agentic', { isAdmin: user.role === 'admin' })
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
            isAdmin: user.role === 'admin',
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
            data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: fullAnswer, status: 'complete', organizationId: user.organizationId },
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
