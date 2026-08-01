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
