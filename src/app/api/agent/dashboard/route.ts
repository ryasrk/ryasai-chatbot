import { NextRequest } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { rememberChatTurn } from '@/lib/cognee'
import { db } from '@/lib/db'
import { generateApiKey, maskApiKey } from '@/lib/api-keys'
import { getPromptSettings, mergePromptSettings } from '@/lib/prompt-settings'
import { getRoutingScores } from '@/lib/smart-router'
import { planQuery, executePlan, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import { streamAnswer } from '@/lib/ai'
import { testMcpServer, invalidateMcpToolsCache } from '@/lib/mcp-client'

interface AdminActionResult {
  handled: boolean
  output?: string
  toolName?: string
  confirmationRequired?: { action: string; message: string }
}

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

async function executeAdminAction(message: string, userId: string): Promise<AdminActionResult> {
  const lower = message.toLowerCase()
  const isConfirmed =
    (lower.includes('konfirmasi') || lower.includes('confirm')) && (lower.includes('ya') || lower.includes('yes'))

  if (lower.match(/generate?\s+api\s+key|buat\s+api\s+key|bikin\s+api\s+key/)) {
    const labelMatch = message.match(/(?:nama|label|name)[:\s]+(.+)/i)
    const label = labelMatch?.[1]?.trim() || `Agent-${new Date().toISOString().slice(0, 10)}`
    const generated = generateApiKey()
    const ratePerMin = Number(process.env.DEFAULT_API_RATE_PER_MINUTE ?? 60)
    const dailyLimit = Number(process.env.DEFAULT_API_DAILY_LIMIT ?? 1000)
    const item = await db.apiKey.create({
      data: {
        label,
        keyPrefix: generated.prefix,
        keyHash: generated.hash,
        requestLimitPerMinute: ratePerMin,
        dailyRequestLimit: dailyLimit,
      },
    })
    await writeAudit({
      userId, action: 'API_KEY_GENERATED', severity: 'warning',
      detail: { label, keyId: item.id },
    })
    return {
      handled: true,
      output: `API Key created successfully.\nLabel: ${label}\nKey: ${generated.plainText}\nPrefix: ${maskApiKey(generated.prefix)}\nRate limit: ${ratePerMin} req/min, ${dailyLimit} req/day\n\nStore this key safely — it will not be shown again.`,
    }
  }

  if (lower.match(/show\s+(api\s+)?latency|monitoring|metrik|metrics/)) {
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const [toolRunCount, latencyAgg, failedApiCount, integrationCount, docCount] = await Promise.all([
      db.toolRun.count({ where: { createdAt: { gte: dayAgo } } }),
      db.toolRun.aggregate({
        where: { createdAt: { gte: dayAgo }, latencyMs: { not: null } },
        _avg: { latencyMs: true },
      }),
      db.apiRequestLog.count({ where: { status: { gte: 400 }, createdAt: { gte: dayAgo } } }),
      db.integration.count({ where: { status: 'active' } }),
      db.document.count({ where: { status: 'ready' } }),
    ])
    return {
      handled: true,
      output: `Monitoring (last 24 hours):\n\nTool Runs: ${toolRunCount}\nAvg Latency: ${Math.round(latencyAgg._avg.latencyMs ?? 0)}ms\nFailed API: ${failedApiCount}\nActive Integrations: ${integrationCount}\nDocuments Ready: ${docCount}`,
    }
  }

  if (lower.match(/show\s+audit|audit\s+log|lihat\s+audit|recent\s+audit/)) {
    const logs = await db.auditLog.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { action: true, severity: true, createdAt: true, detail: true },
    })
    if (logs.length === 0) return { handled: true, output: 'No audit logs found.' }
    const lines = logs.map((l) =>
      `[${l.severity.toUpperCase()}] ${l.action} — ${new Date(l.createdAt).toISOString().slice(0, 19)}`,
    )
    return { handled: true, output: `Audit Log (last 10):\n\n${lines.join('\n')}` }
  }

  if (lower.match(/list\s+(all\s+)?(database|integration|data\s+source)|show\s+(all\s+)?(integration|database)/)) {
    const integrations = await db.integration.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      select: { name: true, provider: true, status: true, type: true },
    })
    if (integrations.length === 0) return { handled: true, output: 'No database integrations found.' }
    const lines = integrations.map((i) => `${i.name} (${i.provider}) — ${i.status}`)
    return { handled: true, output: `Registered integrations:\n\n${lines.join('\n')}` }
  }

  if (lower.match(/reindex\s+(knowledge|dokumen)|re-index|reindex/)) {
    const docCount = await db.document.count({ where: { status: 'ready', isEnabled: true } })
    return {
      handled: true,
      output: `Knowledge base has ${docCount} documents ready.\n\nReindex is an async process — use the Knowledge menu to manage documents individually. For a full reindex, delete and re-upload documents.`,
    }
  }

  if (lower.match(/list\s+(plugin|tool)|show\s+plugin/)) {
    const plugins = await db.plugin.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      select: { toolId: true, description: true, isEnabled: true },
    })
    if (plugins.length === 0) return { handled: true, output: 'No plugins registered.' }
    const lines = plugins.map((p) => `${p.isEnabled ? '[ACTIVE]' : '[OFF]'} plugin:${p.toolId} — ${p.description}`)
    return { handled: true, output: `Registered plugins:\n\n${lines.join('\n')}` }
  }

  if (lower.match(/list\s+schedule|show\s+schedule|scheduled/)) {
    const schedules = await db.scheduledRun.findMany({
      where: {},
      orderBy: { createdAt: 'desc' },
      select: { name: true, cronExpr: true, isActive: true, nextRunAt: true },
    })
    if (schedules.length === 0) return { handled: true, output: 'No scheduled runs found.' }
    const lines = schedules.map((s) =>
      `${s.isActive ? '[ACTIVE]' : '[OFF]'} ${s.name} — cron: ${s.cronExpr}, next: ${s.nextRunAt?.toISOString().slice(0, 19) ?? '-'}`,
    )
    return { handled: true, output: `Scheduled runs:\n\n${lines.join('\n')}` }
  }

  if (lower.match(/show\s+(system\s+)?prompt|current\s+(system\s+)?prompt|tampilkan\s+(system\s+)?prompt/)) {
    const settings = await getPromptSettings(db)
    const promptPreview = settings.systemPrompt
      ? settings.systemPrompt.slice(0, 500) + (settings.systemPrompt.length > 500 ? '...' : '')
      : '(empty)'
    return {
      handled: true,
      output: `Current System Prompt:\n\n${promptPreview}\n\nTool toggles:\n- SQL: ${settings.tools.sql ? 'ON' : 'OFF'}\n- RAG: ${settings.tools.rag ? 'ON' : 'OFF'}\n- REST: ${settings.tools.restApi ? 'ON' : 'OFF'}`,
    }
  }

  const promptChangeMatch = lower.match(/(?:set|update|ubah|ganti)\s+(?:system\s+)?prompt\s+(?:to|jadi|menjadi|:)?\s*(.+)/)
  if (promptChangeMatch) {
    const newPrompt = promptChangeMatch[1].trim().replace(/^["']|["']$/g, '')
    if (!newPrompt) return { handled: true, output: 'New prompt cannot be empty.' }
    if (!isConfirmed) {
      return {
        handled: true,
        confirmationRequired: {
          action: 'SET_PROMPT',
          message: `Are you sure you want to change the System Prompt (${newPrompt.length} characters)? Type "confirm yes" along with your command to continue.`,
        },
      }
    }
    const current = await getPromptSettings(db)
    const merged = mergePromptSettings(current, { systemPrompt: newPrompt })
    const existing = await db.appConfig.findFirst()
    if (existing) {
      await db.appConfig.update({ where: { id: existing.id }, data: { promptSettings: JSON.stringify(merged) } })
    } else {
      await db.appConfig.create({ data: { promptSettings: JSON.stringify(merged) } })
    }
    await writeAudit({
      userId, action: 'PROMPT_TOOLS_UPDATE', severity: 'warning',
      detail: { systemPromptLength: merged.systemPrompt.length, via: 'agentic' },
    })
    return { handled: true, output: `System Prompt updated (${newPrompt.length} characters).\n\nPreview: ${newPrompt.slice(0, 200)}${newPrompt.length > 200 ? '...' : ''}` }
  }

  const toolToggleMatch = lower.match(/(?:enable|disable|turn\s+on|turn\s+off|aktifkan|nonaktifkan)\s+(sql|rag|rest|rest\s*api)/)
  if (toolToggleMatch) {
    const action = lower.match(/enable|turn\s+on|aktifkan/) ? true : false
    const toolRaw = toolToggleMatch[1].replace(/\s/g, '').toLowerCase()
    const toolKey = toolRaw === 'restapi' || toolRaw === 'rest' ? 'restApi' : toolRaw
    if (toolKey !== 'sql' && toolKey !== 'rag' && toolKey !== 'restApi') {
      return { handled: true, output: `Unknown tool: ${toolRaw}` }
    }
    if (!isConfirmed) {
      return {
        handled: true,
        confirmationRequired: {
          action: 'TOGGLE_TOOL',
          message: `Are you sure you want to ${action ? 'enable' : 'disable'} the ${toolKey.toUpperCase()} tool? Type "confirm yes" along with your command to continue.`,
        },
      }
    }
    const current = await getPromptSettings(db)
    const merged = mergePromptSettings(current, { tools: { [toolKey]: action } })
    const existing = await db.appConfig.findFirst()
    if (existing) {
      await db.appConfig.update({ where: { id: existing.id }, data: { promptSettings: JSON.stringify(merged) } })
    } else {
      await db.appConfig.create({ data: { promptSettings: JSON.stringify(merged) } })
    }
    await writeAudit({
      userId, action: 'PROMPT_TOOLS_UPDATE', severity: 'warning',
      detail: { tool: toolKey, enabled: action, via: 'agentic' },
    })
    return { handled: true, output: `Tool ${toolKey.toUpperCase()} ${action ? 'enabled' : 'disabled'}.\n\nStatus: SQL=${merged.tools.sql ? 'ON' : 'OFF'}, RAG=${merged.tools.rag ? 'ON' : 'OFF'}, REST=${merged.tools.restApi ? 'ON' : 'OFF'}` }
  }

  if (lower.match(/routing\s+score|tool\s+routing|routing\s+scores|show\s+routing/)) {
    const data = await getRoutingScores()
    const lines = data.scores.map((s: { tool: string; finalScore: number; circuitBreakerTripped: boolean }) =>
      `${s.tool}: score=${s.finalScore.toFixed(2)} ${s.circuitBreakerTripped ? '[CIRCUIT BREAKER]' : ''}`,
    )
    return { handled: true, output: `Routing Scores:\n\n${lines.join('\n')}` }
  }

  const intToggleMatch = lower.match(/(?:enable|disable|turn\s+on|turn\s+off|aktifkan|nonaktifkan)\s+(?:integration|database|koneksi)\s+(\S+)/)
  if (intToggleMatch) {
    const target = intToggleMatch[1].trim()
    const action = lower.match(/enable|turn\s+on|aktifkan/) ? 'active' : 'inactive'
    const integration = await db.integration.findFirst({
      where: { OR: [{ id: target }, { name: { contains: target } }] },
      select: { id: true, name: true, status: true },
    })
    if (!integration) return { handled: true, output: `Integration "${target}" not found.` }
    if (!isConfirmed) {
      return {
        handled: true,
        confirmationRequired: {
          action: 'TOGGLE_INTEGRATION',
          message: `Are you sure you want to ${action === 'active' ? 'enable' : 'disable'} integration "${integration.name}"? Type "confirm yes" along with your command to continue.`,
        },
      }
    }
    await db.integration.update({ where: { id: integration.id }, data: { status: action } })
    await writeAudit({
      userId, action: 'INTEGRATION_UPDATE', severity: 'info',
      detail: { integrationId: integration.id, name: integration.name, before: integration.status, after: action, via: 'agentic' },
    })
    return { handled: true, output: `Integration "${integration.name}" ${action === 'active' ? 'enabled' : 'disabled'}.` }
  }

  const docToggleMatch = lower.match(/(?:enable|disable|turn\s+on|turn\s+off|aktifkan|nonaktifkan)\s+(?:document|dokumen|knowledge)\s+(\S+)/)
  if (docToggleMatch) {
    const target = docToggleMatch[1].trim()
    const action = lower.match(/enable|turn\s+on|aktifkan/) ? true : false
    const doc = await db.document.findFirst({
      where: { OR: [{ id: target }, { name: { contains: target } }] },
      select: { id: true, name: true, isEnabled: true },
    })
    if (!doc) return { handled: true, output: `Document "${target}" not found.` }
    if (!isConfirmed) {
      return {
        handled: true,
        confirmationRequired: {
          action: 'TOGGLE_DOCUMENT',
          message: `Are you sure you want to ${action ? 'enable' : 'disable'} document "${doc.name}" for RAG retrieval? Type "confirm yes" along with your command to continue.`,
        },
      }
    }
    await db.document.update({ where: { id: doc.id }, data: { isEnabled: action } })
    await writeAudit({
      userId, action: 'DOC_UPDATE', severity: 'info',
      detail: { documentId: doc.id, name: doc.name, before: { isEnabled: doc.isEnabled }, after: { isEnabled: action }, via: 'agentic' },
    })
    return { handled: true, output: `Document "${doc.name}" ${action ? 'enabled' : 'disabled'} for RAG retrieval.` }
  }

  // Agentic MCP setup — "add/install/set up mcp server [name] [for/at ...]"
  const mcpMatch = message.match(/(?:add|install|set\s*up)\s+(?:an?\s+)?(?:mcp\s+server|mcps?\b)/i)
  if (mcpMatch) {
    const knownNames = Object.keys(MCP_PACKAGES)
    const nameMatch = knownNames.find((n) => lower.includes(n))
    const namedMatch = message.match(/(?:called|named)\s+([A-Za-z0-9_-]+)/i)
    const serverName = nameMatch
      ? nameMatch.charAt(0).toUpperCase() + nameMatch.slice(1)
      : namedMatch?.[1] ?? `MCP-${new Date().toISOString().slice(11, 19)}`

    const urlInMessage = message.match(/https?:\/\/[^\s)]+/i)?.[0]
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
        if (pathMatch) args.push(pathMatch[1])
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
        toolName: 'mcp_setup',
        output: `MCP server "${serverName}" installed and connected.\nTransport: ${transport}\n${configLine}\nTools found: ${testResult.toolCount ?? 0}${
          toolLines.length > 0 ? '\n' + toolLines.join('\n') : ''
        }`,
      }
    }
    return {
      handled: true,
      toolName: 'mcp_setup',
      output: `MCP server "${serverName}" was created but the connection test failed.\nTransport: ${transport}\nError: ${testResult.error}\n\nEdit the configuration in the Tools view to fix the issue.`,
    }
  }

  return { handled: false }
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

          // 1. Try admin action pattern match first (fast path, no LLM)
          const adminResult = await executeAdminAction(message, user.userId)
          if (adminResult.handled) {
            if (adminResult.confirmationRequired) {
              send('confirmation_required', adminResult.confirmationRequired)
              send('done', { conversationId })
              await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)
              return
            }
            if (adminResult.output) {
              const toolName = adminResult.toolName ?? 'admin.action'
              send('tool_start', { stepId: 'admin', tool: toolName, input: { message } })
              send('tool_end', { stepId: 'admin', tool: toolName, output: adminResult.output, status: 'success', latencyMs: 0 })
              send('answer', { content: adminResult.output })
              send('done', { conversationId })

              await db.chatMessage.create({
                data: { sessionId: conversationId, userId: user.userId, sender: 'agent', text: adminResult.output, status: 'complete' },
              }).catch(() => null)
              await db.chatSession.update({ where: { id: conversationId }, data: { updatedAt: new Date() } }).catch(() => null)

              await rememberChatTurn({
                sessionId: conversationId,
                userMessage: message,
                aiMessage: adminResult.output,
                toolRuns: [{ type: toolName, status: 'success', latencyMs: 0 }],
              })
              return
            }
          }

          // 2. Not an admin action — use multi-step planner
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
          // ponytail: streamAnswer includes z-ai-web-dev-sdk fallback (no LLM config → sandbox).
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
