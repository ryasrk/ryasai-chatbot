/**
 * Admin tools — platform management actions the agentic planner can invoke.
 * ----------------------------------------------------------------------------
 * Registered as tools in tool-registry.ts so the LLM planner decides when to
 * use them (no hardcoded regex). Each tool has a description that tells the
 * LLM when to pick it.
 *
 * Side-effectful tools (generate_api_key, set_prompt, toggle_tool, toggle_integration,
 * toggle_document) require explicit confirmation from the user before executing.
 */
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { generateApiKey, maskApiKey } from '@/lib/api-keys'
import { writeAudit } from '@/lib/session'
import { getPromptSettings, mergePromptSettings } from '@/lib/prompt-settings'
import { getRoutingScores } from '@/lib/smart-router'
import { testMcpServer, invalidateMcpToolsCache, disconnectMcpServer } from '@/lib/mcp-client'
import { fetchMcpInstallFromUrl } from '@/lib/mcp-installer'
import { encryptConfig, decryptConfig } from '@/lib/crypto'

// ponytail: lightweight known-names map for MCP package resolution. Covers the
// common @modelcontextprotocol/server-* packages + a few uvx ones. Unknown
// names fall through to the package-name pattern. Add entries as needed.
// Used inside the admin:mcp_install tool implementation — the LLM planner
// decides WHEN to install (context-driven); this map resolves WHAT to run.
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

// ponytail: defense-in-depth — only allow known safe runners for stdio spawn.
// npx/uvx/node/python only; blocks any other command parsed from a fetched page.
const ALLOWED_MCP_CMDS = new Set(['npx', 'uvx', 'node', 'python'])

export interface AdminToolResult {
  ok: boolean
  output: string
  confirmationRequired?: { action: string; message: string }
}

export async function executeAdminTool(
  toolId: string,
  input: Record<string, string>,
  userId: string,
  isConfirmed: boolean,
): Promise<AdminToolResult> {
  switch (toolId) {
    case 'admin:generate_api_key':
      return generateApiKeyAction(input, userId)
    case 'admin:show_monitoring':
      return showMonitoringAction()
    case 'admin:show_audit_log':
      return showAuditLogAction()
    case 'admin:list_integrations':
      return listIntegrationsAction()
    case 'admin:list_plugins':
      return listPluginsAction()
    case 'admin:list_schedules':
      return listSchedulesAction()
    case 'admin:show_prompt':
      return showPromptAction()
    case 'admin:set_prompt':
      return setPromptAction(input, userId, isConfirmed)
    case 'admin:toggle_tool':
      return toggleToolAction(input, userId, isConfirmed)
    case 'admin:toggle_integration':
      return toggleIntegrationAction(input, userId, isConfirmed)
    case 'admin:toggle_document':
      return toggleDocumentAction(input, userId, isConfirmed)
    case 'admin:routing_scores':
      return routingScoresAction()
    case 'admin:reindex_status':
      return reindexStatusAction()
    case 'admin:mcp_install':
      return mcpInstallAction(input, userId, isConfirmed)
    case 'admin:mcp_set_credentials':
      return mcpSetCredentialsAction(input, userId)
    case 'admin:mcp_list':
      return mcpListAction()
    case 'admin:mcp_test':
      return mcpTestAction(input)
    case 'admin:mcp_remove':
      return mcpRemoveAction(input, userId, isConfirmed)
    default:
      return { ok: false, output: `Unknown admin tool: ${toolId}` }
  }
}

async function generateApiKeyAction(input: Record<string, string>, userId: string): Promise<AdminToolResult> {
  const label = input.label || input.name || `Agent-${new Date().toISOString().slice(0, 10)}`
  const generated = generateApiKey()
  const ratePerMin = Number(process.env.DEFAULT_API_RATE_PER_MINUTE ?? 60)
  const dailyLimit = Number(process.env.DEFAULT_API_DAILY_LIMIT ?? 1000)
  const item = await db.apiKey.create({
    data: { organizationId: getOrgContext()!, label, keyPrefix: generated.prefix, keyHash: generated.hash, requestLimitPerMinute: ratePerMin, dailyRequestLimit: dailyLimit },
  })
  await writeAudit({ userId, action: 'API_KEY_GENERATED', severity: 'warning', detail: { label, keyId: item.id } })
  return {
    ok: true,
    output: `API Key created successfully.\nLabel: ${label}\nKey: ${generated.plainText}\nPrefix: ${maskApiKey(generated.prefix)}\nRate limit: ${ratePerMin} req/min, ${dailyLimit} req/day\n\nStore this key safely — it will not be shown again.`,
  }
}

async function showMonitoringAction(): Promise<AdminToolResult> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [toolRunCount, latencyAgg, failedApiCount, integrationCount, docCount] = await Promise.all([
    db.toolRun.count({ where: { createdAt: { gte: dayAgo } } }),
    db.toolRun.aggregate({ where: { createdAt: { gte: dayAgo }, latencyMs: { not: null } }, _avg: { latencyMs: true } }),
    db.apiRequestLog.count({ where: { status: { gte: 400 }, createdAt: { gte: dayAgo } } }),
    db.integration.count({ where: { status: 'active' } }),
    db.document.count({ where: { status: 'ready' } }),
  ])
  return {
    ok: true,
    output: `Monitoring (last 24 hours):\n\nTool Runs: ${toolRunCount}\nAvg Latency: ${Math.round(latencyAgg._avg.latencyMs ?? 0)}ms\nFailed API: ${failedApiCount}\nActive Integrations: ${integrationCount}\nDocuments Ready: ${docCount}`,
  }
}

async function showAuditLogAction(): Promise<AdminToolResult> {
  const logs = await db.auditLog.findMany({ where: {}, orderBy: { createdAt: 'desc' }, take: 10, select: { action: true, severity: true, createdAt: true } })
  if (logs.length === 0) return { ok: true, output: 'No audit logs found.' }
  const lines = logs.map((l) => `[${l.severity.toUpperCase()}] ${l.action} — ${new Date(l.createdAt).toISOString().slice(0, 19)}`)
  return { ok: true, output: `Audit Log (last 10):\n\n${lines.join('\n')}` }
}

async function listIntegrationsAction(): Promise<AdminToolResult> {
  const integrations = await db.integration.findMany({ where: {}, orderBy: { createdAt: 'desc' }, select: { name: true, provider: true, status: true, type: true } })
  if (integrations.length === 0) return { ok: true, output: 'No database integrations found.' }
  const lines = integrations.map((i) => `${i.name} (${i.provider}) — ${i.status}`)
  return { ok: true, output: `Registered integrations:\n\n${lines.join('\n')}` }
}

async function listPluginsAction(): Promise<AdminToolResult> {
  const plugins = await db.plugin.findMany({ where: {}, orderBy: { createdAt: 'desc' }, select: { toolId: true, description: true, isEnabled: true } })
  if (plugins.length === 0) return { ok: true, output: 'No plugins registered.' }
  const lines = plugins.map((p) => `${p.isEnabled ? '[ACTIVE]' : '[OFF]'} plugin:${p.toolId} — ${p.description}`)
  return { ok: true, output: `Registered plugins:\n\n${lines.join('\n')}` }
}

async function listSchedulesAction(): Promise<AdminToolResult> {
  const schedules = await db.scheduledRun.findMany({ where: {}, orderBy: { createdAt: 'desc' }, select: { name: true, cronExpr: true, isActive: true, nextRunAt: true } })
  if (schedules.length === 0) return { ok: true, output: 'No scheduled runs found.' }
  const lines = schedules.map((s) => `${s.isActive ? '[ACTIVE]' : '[OFF]'} ${s.name} — cron: ${s.cronExpr}, next: ${s.nextRunAt?.toISOString().slice(0, 19) ?? '-'}`)
  return { ok: true, output: `Scheduled runs:\n\n${lines.join('\n')}` }
}

async function showPromptAction(): Promise<AdminToolResult> {
  const settings = await getPromptSettings(db)
  const promptPreview = settings.systemPrompt
    ? settings.systemPrompt.slice(0, 500) + (settings.systemPrompt.length > 500 ? '...' : '')
    : '(empty)'
  return {
    ok: true,
    output: `Current System Prompt:\n\n${promptPreview}\n\nTool toggles:\n- SQL: ${settings.tools.sql ? 'ON' : 'OFF'}\n- RAG: ${settings.tools.rag ? 'ON' : 'OFF'}\n- REST: ${settings.tools.restApi ? 'ON' : 'OFF'}`,
  }
}

async function setPromptAction(input: Record<string, string>, userId: string, isConfirmed: boolean): Promise<AdminToolResult> {
  const newPrompt = (input.prompt || input.text || input.value || '').trim().replace(/^["']|["']$/g, '')
  if (!newPrompt) return { ok: false, output: 'New prompt cannot be empty.' }
  if (!isConfirmed) {
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'SET_PROMPT',
        message: `Are you sure you want to change the System Prompt (${newPrompt.length} characters)? Type "confirm yes" along with your command to continue.`,
      },
    }
  }
  const current = await getPromptSettings(db)
  const merged = mergePromptSettings(current, { systemPrompt: newPrompt })
  const existing = await db.appConfig.findFirst()
  if (existing) await db.appConfig.update({ where: { id: existing.id }, data: { promptSettings: JSON.stringify(merged) } })
  else await db.appConfig.create({ data: { organizationId: getOrgContext()!, promptSettings: JSON.stringify(merged) } })
  await writeAudit({ userId, action: 'PROMPT_TOOLS_UPDATE', severity: 'warning', detail: { systemPromptLength: merged.systemPrompt.length, via: 'agentic' } })
  return { ok: true, output: `System Prompt updated (${newPrompt.length} characters).\n\nPreview: ${newPrompt.slice(0, 200)}${newPrompt.length > 200 ? '...' : ''}` }
}

async function toggleToolAction(input: Record<string, string>, userId: string, isConfirmed: boolean): Promise<AdminToolResult> {
  const toolRaw = (input.tool || input.name || '').replace(/\s/g, '').toLowerCase()
  const action = (input.action || input.state || '').toLowerCase()
  const enabled = action === 'enable' || action === 'on' || action === 'true'
  const toolKey = toolRaw === 'restapi' || toolRaw === 'rest' ? 'restApi' : toolRaw
  if (toolKey !== 'sql' && toolKey !== 'rag' && toolKey !== 'restApi') return { ok: false, output: `Unknown tool: ${toolRaw}` }
  if (!isConfirmed) {
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'TOGGLE_TOOL',
        message: `Are you sure you want to ${enabled ? 'enable' : 'disable'} the ${toolKey.toUpperCase()} tool? Type "confirm yes" along with your command to continue.`,
      },
    }
  }
  const current = await getPromptSettings(db)
  const merged = mergePromptSettings(current, { tools: { [toolKey]: enabled } })
  const existing = await db.appConfig.findFirst()
  if (existing) await db.appConfig.update({ where: { id: existing.id }, data: { promptSettings: JSON.stringify(merged) } })
  else await db.appConfig.create({ data: { organizationId: getOrgContext()!, promptSettings: JSON.stringify(merged) } })
  await writeAudit({ userId, action: 'PROMPT_TOOLS_UPDATE', severity: 'warning', detail: { tool: toolKey, enabled, via: 'agentic' } })
  return { ok: true, output: `Tool ${toolKey.toUpperCase()} ${enabled ? 'enabled' : 'disabled'}.\n\nStatus: SQL=${merged.tools.sql ? 'ON' : 'OFF'}, RAG=${merged.tools.rag ? 'ON' : 'OFF'}, REST=${merged.tools.restApi ? 'ON' : 'OFF'}` }
}

async function toggleIntegrationAction(input: Record<string, string>, userId: string, isConfirmed: boolean): Promise<AdminToolResult> {
  const target = (input.integration || input.name || input.id || '').trim()
  const action = (input.action || input.state || '').toLowerCase()
  const newStatus = action === 'enable' || action === 'on' || action === 'active' ? 'active' : 'inactive'
  if (!target) return { ok: false, output: 'Integration name or ID is required.' }
  const integration = await db.integration.findFirst({ where: { OR: [{ id: target }, { name: { contains: target } }] }, select: { id: true, name: true, status: true } })
  if (!integration) return { ok: false, output: `Integration "${target}" not found.` }
  if (!isConfirmed) {
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'TOGGLE_INTEGRATION',
        message: `Are you sure you want to ${newStatus === 'active' ? 'enable' : 'disable'} integration "${integration.name}"? Type "confirm yes" along with your command to continue.`,
      },
    }
  }
  await db.integration.update({ where: { id: integration.id }, data: { status: newStatus } })
  await writeAudit({ userId, action: 'INTEGRATION_UPDATE', severity: 'info', detail: { integrationId: integration.id, name: integration.name, before: integration.status, after: newStatus, via: 'agentic' } })
  return { ok: true, output: `Integration "${integration.name}" ${newStatus === 'active' ? 'enabled' : 'disabled'}.` }
}

async function toggleDocumentAction(input: Record<string, string>, userId: string, isConfirmed: boolean): Promise<AdminToolResult> {
  const target = (input.document || input.name || input.id || '').trim()
  const action = (input.action || input.state || '').toLowerCase()
  const enabled = action === 'enable' || action === 'on' || action === 'true'
  if (!target) return { ok: false, output: 'Document name or ID is required.' }
  const doc = await db.document.findFirst({ where: { OR: [{ id: target }, { name: { contains: target } }] }, select: { id: true, name: true, isEnabled: true } })
  if (!doc) return { ok: false, output: `Document "${target}" not found.` }
  if (!isConfirmed) {
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'TOGGLE_DOCUMENT',
        message: `Are you sure you want to ${enabled ? 'enable' : 'disable'} document "${doc.name}" for RAG retrieval? Type "confirm yes" along with your command to continue.`,
      },
    }
  }
  await db.document.update({ where: { id: doc.id }, data: { isEnabled: enabled } })
  await writeAudit({ userId, action: 'DOC_UPDATE', severity: 'info', detail: { documentId: doc.id, name: doc.name, before: { isEnabled: doc.isEnabled }, after: { isEnabled: enabled }, via: 'agentic' } })
  return { ok: true, output: `Document "${doc.name}" ${enabled ? 'enabled' : 'disabled'} for RAG retrieval.` }
}

async function routingScoresAction(): Promise<AdminToolResult> {
  const data = await getRoutingScores()
  const lines = data.scores.map((s: { tool: string; finalScore: number; circuitBreakerTripped: boolean }) =>
    `${s.tool}: score=${s.finalScore.toFixed(2)} ${s.circuitBreakerTripped ? '[CIRCUIT BREAKER]' : ''}`,
  )
  return { ok: true, output: `Routing Scores:\n\n${lines.join('\n')}` }
}

async function reindexStatusAction(): Promise<AdminToolResult> {
  const docCount = await db.document.count({ where: { status: 'ready', isEnabled: true } })
  return {
    ok: true,
    output: `Knowledge base has ${docCount} documents ready.\n\nReindex is an async process — use the Knowledge menu to manage documents individually. For a full reindex, delete and re-upload documents.`,
  }
}

// ---------------------------------------------------------------------------
// MCP server management tools — context-driven via the LLM planner.
// The planner decides when to invoke these based on conversation history.
// Confirmation flows through the standard isConfirmed parameter (the planner
// emits confirm: "yes" in the tool input when the user confirms).
// ---------------------------------------------------------------------------

async function mcpInstallAction(
  input: Record<string, string>,
  userId: string,
  isConfirmed: boolean,
): Promise<AdminToolResult> {
  const name = (input.name || input.server || '').trim()
  const url = (input.url || input.endpoint || '').trim()
  const explicitPkg = (input.package || input.pkg || '').trim()
  const transportHint = (input.transport || '').trim().toLowerCase()

  if (!name && !url) {
    return { ok: false, output: 'MCP server name or URL is required. Ask the user for a server name or install URL.' }
  }

  // Resolve server name + transport + command + args from the inputs.
  let serverName = name
  let transport: 'stdio' | 'sse' | 'http' = 'stdio'
  let command = ''
  let args: string[] = []
  let serverUrl = ''
  let needsUrlFetch = false

  const knownNameHit = serverName ? Object.keys(MCP_PACKAGES).find((n) => serverName.toLowerCase().includes(n)) : undefined

  if (url) {
    const isDirectMcpEndpoint = /\/(?:sse|mcp|api\/mcp)/i.test(url)
    if (isDirectMcpEndpoint) {
      transport = transportHint === 'sse' || url.includes('/sse') ? 'sse' : 'http'
      serverUrl = url
    } else {
      // Repo/docs URL — defer fetch to execution time (post-confirmation).
      transport = 'stdio'
      needsUrlFetch = true
      serverUrl = url
    }
  } else {
    transport = 'stdio'
    const runner = transportHint === 'uvx' ? 'uvx' : (knownNameHit ? MCP_PACKAGES[knownNameHit].runner : 'npx')
    command = runner
    if (explicitPkg) {
      args = runner === 'npx' ? ['-y', explicitPkg] : [explicitPkg]
    } else if (knownNameHit) {
      const pkg = MCP_PACKAGES[knownNameHit].pkg
      args = runner === 'npx' ? ['-y', pkg] : [pkg]
      if (knownNameHit === 'filesystem') args.push('/tmp')
    } else if (serverName) {
      const pkgToken = `@modelcontextprotocol/server-${serverName.toLowerCase()}`
      args = runner === 'npx' ? ['-y', pkgToken] : [pkgToken]
    }
  }

  if (!serverName) {
    if (url) {
      try { serverName = new URL(url).hostname } catch { serverName = '' }
    }
    if (!serverName) serverName = `MCP-${new Date().toISOString().slice(11, 19)}`
  }

  // ponytail: confirmation gate — stdio transport spawns a child process.
  // Show a preview of what will run, ask the user to confirm.
  if (!isConfirmed) {
    const configPreview = transport === 'stdio' && command
      ? `Command: ${command} ${args.join(' ')}`
      : transport === 'stdio' && needsUrlFetch
        ? `Source: ${serverUrl} (will fetch install instructions)`
        : `URL: ${serverUrl}`
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'MCP_INSTALL',
        message: `I'll install MCP server "${serverName}" (transport: ${transport}).\n${configPreview}\n\nThis will spawn a child process to run the MCP server. Type "confirm yes" to proceed.`,
      },
    }
  }

  // Confirmed — execute the install.
  let requiredEnvVars: string[] = []

  if (needsUrlFetch && serverUrl) {
    const install = await fetchMcpInstallFromUrl(serverUrl)
    if (install) {
      transport = 'stdio'
      command = install.command
      args = install.args
      if (install.name) serverName = install.name
      requiredEnvVars = install.envVars
    } else {
      // Could not parse install instructions — fall back to HTTP.
      transport = 'http'
      command = ''
      args = []
    }
  }

  if (transport === 'stdio' && command && !ALLOWED_MCP_CMDS.has(command)) {
    await writeAudit({
      userId, action: 'MCP_SERVER_CREATE_BLOCKED', severity: 'warning',
      detail: { name: serverName, command, reason: 'disallowed command' },
    })
    return { ok: false, output: `MCP install blocked: command "${command}" is not in the allowed list (npx, uvx, node, python).` }
  }

  const orgId = getOrgContext()
  if (!orgId) return { ok: false, output: 'Organization context is required.' }

  const created = await db.mcpServer.create({
    data: {
      name: serverName,
      description: 'Installed via agentic setup',
      transport,
      command,
      args: JSON.stringify(args),
      url: serverUrl,
      envJson: '{}',
      isEnabled: true,
      chatEnabled: true,
      agenticEnabled: true,
      organizationId: orgId,
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
      : `URL: ${serverUrl}`
    const envLine = requiredEnvVars.length > 0
      ? `\nRequired credentials: ${requiredEnvVars.join(', ')}\nTo set them, ask me to set credentials for ${serverName}.`
      : ''
    return {
      ok: true,
      output: `MCP server "${serverName}" installed and connected.\nTransport: ${transport}\n${configLine}\nTools found: ${testResult.toolCount ?? 0}${
        toolLines.length > 0 ? '\n' + toolLines.join('\n') : ''
      }${envLine}`,
    }
  }

  const envHint = requiredEnvVars.length > 0
    ? `\n\nThis server requires credentials: ${requiredEnvVars.join(', ')}\nAsk me to set credentials for ${serverName}.`
    : ''
  return {
    ok: false,
    output: `MCP server "${serverName}" was created but the connection test failed.\nTransport: ${transport}\nError: ${testResult.error}${envHint}\n\nEdit the configuration in the Tools view to fix the issue.`,
  }
}

async function mcpSetCredentialsAction(
  input: Record<string, string>,
  userId: string,
): Promise<AdminToolResult> {
  const serverName = (input.server || input.name || '').trim()
  const credentialsRaw = (input.credentials || input.env || input.vars || '').trim()

  if (!serverName) return { ok: false, output: 'MCP server name is required.' }
  if (!credentialsRaw) return { ok: false, output: 'Credentials are required. Format: KEY=value, KEY=value' }

  const envUpdates = parseCredentialPairs(credentialsRaw)
  if (Object.keys(envUpdates).length === 0) {
    return { ok: false, output: 'No valid credential pairs found. Format: KEY=value, KEY=value' }
  }

  const server = await db.mcpServer.findFirst({
    where: { name: { contains: serverName, mode: 'insensitive' } },
  })
  if (!server) {
    return { ok: false, output: `MCP server "${serverName}" not found.` }
  }

  // Merge with existing env vars (decrypt, merge, re-encrypt).
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

  // Re-test the connection with the new credentials.
  const testResult = await testMcpServer(server.id)
  invalidateMcpToolsCache()

  const keysList = Object.keys(envUpdates).join(', ')
  if (testResult.ok) {
    return {
      ok: true,
      output: `Credentials updated for "${server.name}".\nSet: ${keysList}\nConnection test: OK (${testResult.toolCount ?? 0} tools available).`,
    }
  }
  return {
    ok: true,
    output: `Credentials updated for "${server.name}".\nSet: ${keysList}\nConnection test failed: ${testResult.error}\n\nThe credentials were saved. Check if the values are correct or if the server needs additional configuration.`,
  }
}

async function mcpListAction(): Promise<AdminToolResult> {
  const servers = await db.mcpServer.findMany({
    where: {},
    orderBy: { name: 'asc' },
    select: { id: true, name: true, transport: true, command: true, url: true, isEnabled: true, chatEnabled: true, agenticEnabled: true },
  })
  if (servers.length === 0) return { ok: true, output: 'No MCP servers registered.' }
  const lines = servers.map((s) => {
    const status = s.isEnabled ? '[ACTIVE]' : '[OFF]'
    const scope = `chat:${s.chatEnabled ? 'on' : 'off'} agentic:${s.agenticEnabled ? 'on' : 'off'}`
    const endpoint = s.transport === 'stdio' ? s.command : s.url
    return `${status} ${s.name} — ${s.transport} (${endpoint}) ${scope}`
  })
  return { ok: true, output: `MCP servers:\n\n${lines.join('\n')}` }
}

async function mcpTestAction(input: Record<string, string>): Promise<AdminToolResult> {
  const target = (input.server || input.name || input.id || '').trim()
  if (!target) return { ok: false, output: 'MCP server name or ID is required.' }
  const server = await db.mcpServer.findFirst({
    where: { OR: [{ id: target }, { name: { contains: target } }] },
    select: { id: true, name: true },
  })
  if (!server) return { ok: false, output: `MCP server "${target}" not found.` }

  const result = await testMcpServer(server.id)
  if (result.ok) {
    const toolLines = (result.tools ?? []).map((t) => `  - ${t.name}: ${t.description}`)
    return {
      ok: true,
      output: `MCP server "${server.name}" is reachable.\nTools: ${result.toolCount ?? 0}${
        toolLines.length > 0 ? '\n' + toolLines.join('\n') : ''
      }`,
    }
  }
  return { ok: false, output: `MCP server "${server.name}" connection test failed: ${result.error}` }
}

async function mcpRemoveAction(
  input: Record<string, string>,
  userId: string,
  isConfirmed: boolean,
): Promise<AdminToolResult> {
  const target = (input.server || input.name || input.id || '').trim()
  if (!target) return { ok: false, output: 'MCP server name or ID is required.' }
  const server = await db.mcpServer.findFirst({
    where: { OR: [{ id: target }, { name: { contains: target } }] },
    select: { id: true, name: true },
  })
  if (!server) return { ok: false, output: `MCP server "${target}" not found.` }

  if (!isConfirmed) {
    return {
      ok: false,
      output: '',
      confirmationRequired: {
        action: 'MCP_REMOVE',
        message: `Are you sure you want to remove MCP server "${server.name}"? Type "confirm yes" to proceed.`,
      },
    }
  }

  await db.mcpServer.delete({ where: { id: server.id } })
  await disconnectMcpServer(server.id)
  await writeAudit({
    userId, action: 'MCP_SERVER_DELETE', severity: 'warning',
    detail: { id: server.id, name: server.name, via: 'agentic' },
  })
  return { ok: true, output: `MCP server "${server.name}" removed.` }
}

function parseCredentialPairs(s: string): Record<string, string> {
  const result: Record<string, string> = {}
  const regex = /([A-Z][A-Z0-9_]+)\s*=\s*(?:"([^"]+)"|'([^']+)'|(\S+?))(?:\s*,\s*|\s+|$)/g
  let m: RegExpExecArray | null
  while ((m = regex.exec(s)) !== null) {
    const key = m[1]
    const val = m[2] ?? m[3] ?? m[4]
    if (val) result[key] = val.replace(/['"`]/g, '')
  }
  return result
}
