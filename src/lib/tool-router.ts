import { db } from '@/lib/db'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
  type QueryRow,
  type ReflectedTable,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import {
  generateAnswer,
  generateChat,
  generateRestCall,
  generateSql,
  routeQuery,
  streamAnswer,
  streamChat,
  type RouteDecision,
  type RestCallPlan,
  type RestEndpointOption,
} from '@/lib/ai'
import { smartRoute } from '@/lib/smart-router'
import { retrieveRelevantChunks } from '@/lib/rag'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
} from '@/lib/rest-api-connectors'
import { getPromptSettings } from '@/lib/prompt-settings'
import { recallContext, rememberChatTurn } from '@/lib/cognee'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import { planQuery, executePlan, synthesizeAnswer, type PlanStepResult } from '@/lib/planner'
import { getAvailableTools } from '@/lib/tool-registry'
import type { ChartData, Citation } from '@/lib/types'
import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('tool-router')

// ponytail: per-integration SQL concurrency limiter — in-memory semaphore.
// Ceiling: per-instance, not distributed. Max 3 concurrent queries per integration
// to prevent database lock contention. Upgrade to Redis-backed semaphore when scaling.
const SQL_MAX_CONCURRENT = 3
const _sqlSemaphores = new Map<string, { running: number; queue: Array<() => void> }>()

export function withSqlConcurrency<T>(integrationId: string, fn: () => Promise<T>): Promise<T> {
  let sem = _sqlSemaphores.get(integrationId)
  if (!sem) {
    sem = { running: 0, queue: [] }
    _sqlSemaphores.set(integrationId, sem)
  }
  return new Promise<T>((resolve, reject) => {
    const run = async () => {
      sem!.running += 1
      try {
        const result = await fn()
        resolve(result)
      } catch (e) {
        reject(e)
      } finally {
        sem!.running -= 1
        const next = sem!.queue.shift()
        if (next) next()
      }
    }
    if (sem.running < SQL_MAX_CONCURRENT) {
      run()
    } else {
      sem.queue.push(run)
    }
  })
}

type ToolRunStatus = 'success' | 'error' | 'blocked'

export interface PendingToolRun {
  type: 'RAG' | 'SQL' | 'REST_API' | 'CHAT' | 'PLUGIN'
  status: ToolRunStatus
  latencyMs?: number
  inputSummary: string
  outputSummary?: string
  errorMessage?: string
  restApiEndpointId?: string
}

export interface CompletionResult {
  answer: string
  citations: Citation[]
  toolRuns: PendingToolRun[]
  chartData: ChartData | null
  integrationId?: string
}

export interface ChatHistoryEntry {
  role: 'user' | 'assistant'
  content: string
}

export async function runNonStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
  allowMultiStepDag?: boolean
}): Promise<CompletionResult> {
  // ponytail: multi-step DAG path — when flag is set, use planner instead of single-tool router.
  // Ceiling: planner makes 1+ LLM calls (plan + execute + synthesize), higher latency than single-tool.
  // Use for complex questions that need multiple tools (e.g. "Q1 sales AND the SOP for that product").
  if (args.allowMultiStepDag) {
    const dagResult = await runMultiStepDag(args)
    if (dagResult) return dagResult
    // Fall through to single-tool if planner fails (graceful degradation)
  }

  const memoryContext = await recallContext({
    query: args.question,
    sessionId: args.sessionId,
  })

  const [integrationCount, documentCount, restEndpointCount, promptSettings] = await Promise.all([
    db.integration.count({ where: { status: 'active' } }),
    db.document.count({ where: { status: 'ready', isEnabled: true } }),
    db.restApiEndpoint.count({
      where: {
        isEnabled: true,
        connector: { isActive: true },
      },
    }),
    getPromptSettings(db),
  ])

  const hasHistory = args.chatHistory && args.chatHistory.length > 0

  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId

  if (hasHistory) {
    // Multi-turn: LLM router sees history and can pick CONTEXTUAL_CHAT
    const routed = await routeQuery({
      question: args.question,
      hasIntegrations: integrationCount > 0,
      hasDocuments: documentCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
    })
    decision = routed.decision
  } else {
    // First turn: fast heuristic router (no LLM call if confident)
    const routed = await smartRoute({
      question: args.question,
      hasIntegrations: integrationCount > 0,
      hasDocuments: documentCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      preferredIntegrationId: args.integrationId,
    })
    decision = routed.decision
    resolvedIntegrationId = routed.integrationId ?? args.integrationId
  }

  decision = chooseAvailableDecision(decision, {
    hasIntegrations: integrationCount > 0,
    hasDocuments: documentCount > 0,
    hasRestApis: restEndpointCount > 0,
  })
  if (decision === 'SQL' && !promptSettings.tools.sql) decision = 'CHAT'
  if (decision === 'RAG' && !promptSettings.tools.rag) decision = 'CHAT'
  if (decision === 'REST' && !promptSettings.tools.restApi) decision = 'CHAT'

  const historyMsgs: ChatHistoryEntry[] = args.chatHistory ?? []

  // For CONTEXTUAL_CHAT: load recent tool run outputs so the LLM has prior data context
  let contextualContext = ''
  if (decision === 'CONTEXTUAL_CHAT' && args.sessionId) {
    const recentToolRuns = await db.toolRun.findMany({
      where: {
        chatMessage: { sessionId: args.sessionId },
        status: 'success',
        outputSummary: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { type: true, inputSummary: true, outputSummary: true },
    })
    if (recentToolRuns.length > 0) {
      contextualContext = recentToolRuns
        .map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`)
        .join('\n\n---\n\n')
    }
  }

  const branchArgs = {
    ...args,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: promptSettings.systemPrompt || undefined,
    memoryContext,
    chatHistory: historyMsgs,
  }

  let result: CompletionResult
  if (decision === 'SQL') result = await runSqlBranch(branchArgs)
  else if (decision === 'RAG') result = await runRagBranch(branchArgs)
  else if (decision === 'REST') result = await runRestBranch(branchArgs)
  else if (decision === 'PLUGIN') result = await runPluginBranch(branchArgs)
  else if (decision === 'CONTEXTUAL_CHAT' && contextualContext) {
    result = await runContextualChatBranch({ ...branchArgs, context: contextualContext })
  } else {
    result = await runChatBranch(branchArgs)
  }

  await rememberChatTurn({
    sessionId: args.sessionId,
    userMessage: args.question,
    aiMessage: result.answer,
    toolRuns: result.toolRuns.map((t) => ({ type: t.type, status: t.status, latencyMs: t.latencyMs ?? 0 })),
  })

  return result
}

// ponytail: multi-step DAG — plan → execute → synthesize.
// Returns null when planner fails or produces a single-step CHAT plan (fall back to single-tool router).
async function runMultiStepDag(args: {
  question: string
  userId: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult | null> {
  try {
    const availableTools = await getAvailableTools(args.question, 'chat')
    if (availableTools.length === 0) return null

    const plan = await planQuery({
      question: args.question,
      availableTools,
      sessionId: args.sessionId,
      chatHistory: args.chatHistory,
    })

    // Single-step CHAT plan = no benefit over single-tool router, skip
    if (plan.steps.length === 1 && plan.steps[0].tool === 'chat' && !plan.needsSynthesis) {
      return null
    }

    const results: PlanStepResult[] = await executePlan({
      plan,
      userId: args.userId,
      sessionId: args.sessionId,
    })

    const answer = await synthesizeAnswer({
      question: args.question,
      stepResults: results,
      plan,
    })

    const toolRuns: PendingToolRun[] = results.map((r) => ({
      type: r.tool.startsWith('plugin:') ? 'PLUGIN' : r.tool.startsWith('mcp:') ? 'PLUGIN' : (r.tool.toUpperCase() as PendingToolRun['type']),
      status: r.ok ? 'success' : 'error',
      latencyMs: r.latencyMs,
      inputSummary: summarize(args.question),
      outputSummary: summarize(r.output),
      errorMessage: r.error,
    }))

    return {
      answer,
      citations: [],
      chartData: null,
      toolRuns,
    }
  } catch (e) {
    log.warn('multi-step DAG failed, falling back to single-tool', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export interface StreamingCompletionResult {
  toolRuns: PendingToolRun[]
  citations: Citation[]
  chartData: ChartData | null
  integrationId?: string
  stream: AsyncGenerator<string, void, unknown>
}

export async function runStreamingChatCompletion(args: {
  question: string
  userId: string
  integrationId?: string
  sessionId?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const memoryContext = await recallContext({
    query: args.question,
    sessionId: args.sessionId,
  })

  const [integrationCount, documentCount, restEndpointCount, promptSettings] = await Promise.all([
    db.integration.count({ where: { status: 'active' } }),
    db.document.count({ where: { status: 'ready', isEnabled: true } }),
    db.restApiEndpoint.count({
      where: {
        isEnabled: true,
        connector: { isActive: true },
      },
    }),
    getPromptSettings(db),
  ])

  const hasHistory = args.chatHistory && args.chatHistory.length > 0

  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId

  if (hasHistory) {
    const routed = await routeQuery({
      question: args.question,
      hasIntegrations: integrationCount > 0,
      hasDocuments: documentCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
    })
    decision = routed.decision
  } else {
    const routed = await smartRoute({
      question: args.question,
      hasIntegrations: integrationCount > 0,
      hasDocuments: documentCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      preferredIntegrationId: args.integrationId,
    })
    decision = routed.decision
    resolvedIntegrationId = routed.integrationId ?? args.integrationId
  }

  decision = chooseAvailableDecision(decision, {
    hasIntegrations: integrationCount > 0,
    hasDocuments: documentCount > 0,
    hasRestApis: restEndpointCount > 0,
  })
  if (decision === 'SQL' && !promptSettings.tools.sql) decision = 'CHAT'
  if (decision === 'RAG' && !promptSettings.tools.rag) decision = 'CHAT'
  if (decision === 'REST' && !promptSettings.tools.restApi) decision = 'CHAT'

  // For CONTEXTUAL_CHAT: load recent tool run outputs so the LLM has prior data context
  let contextualContext = ''
  if (decision === 'CONTEXTUAL_CHAT' && args.sessionId) {
    const recentToolRuns = await db.toolRun.findMany({
      where: {
        chatMessage: { sessionId: args.sessionId },
        status: 'success',
        outputSummary: { not: '' },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { type: true, inputSummary: true, outputSummary: true },
    })
    if (recentToolRuns.length > 0) {
      contextualContext = recentToolRuns
        .map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`)
        .join('\n\n---\n\n')
    }
  }

  const branchArgs = {
    ...args,
    integrationId: resolvedIntegrationId,
    systemPromptPrefix: promptSettings.systemPrompt || undefined,
    memoryContext,
    chatHistory: args.chatHistory ?? [],
  }

  if (decision === 'SQL') return await prepareSqlStream(branchArgs)
  if (decision === 'RAG') return await prepareRagStream(branchArgs)
  if (decision === 'REST') return await prepareRestStream(branchArgs)
  if (decision === 'PLUGIN') return await preparePluginStream(branchArgs)
  if (decision === 'CONTEXTUAL_CHAT' && contextualContext) {
    return await prepareContextualChatStream({ ...branchArgs, context: contextualContext })
  }
  return await prepareChatStream(branchArgs)
}

async function prepareContextualChatStream(args: {
  question: string
  context: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const stream = streamAnswer({
    question: args.question,
    context: args.context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })
  return {
    toolRuns: [{
      type: 'CHAT',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(args.context),
    }],
    citations: [],
    chartData: null,
    stream,
  }
}

async function prepareChatStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const stream = streamChat(args.question, args.memoryContext, args.systemPromptPrefix, args.chatHistory)
  return {
    toolRuns: [{
      type: 'CHAT',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
    }],
    citations: [],
    chartData: null,
    stream,
  }
}

async function prepareRagStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const retrieval = await retrieveRelevantChunks({ query: args.question, topK: 4 })
  const topChunks = retrieval.chunks
  if (topChunks.length === 0 && !retrieval.graphContext) return prepareChatStream(args)

  const chunkContext = topChunks
    .map((item) => `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`)
    .join('\n\n---\n\n')

  const context = retrieval.graphContext
    ? `${chunkContext}\n\n--- Knowledge Graph Context ---\n${retrieval.graphContext}`
    : chunkContext

  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })

  const citations = topChunks.map((item) =>
    buildDocumentCitation({
      documentName: item.documentName,
      chunkIndex: item.chunkIndex,
      content: item.content,
      score: item.score,
    }),
  )

  await db.auditLog.create({
    data: {
      userId: null,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: JSON.stringify({
        query: args.question,
        returned: topChunks.length,
        candidatesScanned: retrieval.candidatesScanned,
        queryTokens: retrieval.queryTokens,
        topScore: topChunks[0]?.score ?? 0,
      }),
    },
  })

  return {
    toolRuns: [{
      type: 'RAG',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(context),
    }],
    citations,
    chartData: null,
    stream,
  }
}

async function prepareSqlStream(args: {
  question: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const integration = args.integrationId
    ? await db.integration.findFirst({
        where: { id: args.integrationId, status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : await db.integration.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })

  if (!integration || integration.schemas.length === 0) {
    return prepareChatStream(args)
  }

  const schemaDescription = describeSchema(
    integration.schemas.map((schema) => ({
      tableName: schema.tableName,
      columns: safeParseColumns(schema.columns),
      rowCount: schema.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(schema.sampleRow),
    })),
  )
  const llm = await generateSql({
    question: args.question,
    schemaDescription,
    provider: integration.provider,
    memoryContext: args.memoryContext,
  })
  const guard = validateAndSanitizeLlmSql(llm.sql)
  if (!guard.ok) {
    return {
      toolRuns: [{
        type: 'SQL',
        status: 'blocked',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: guard.reason,
      }],
      citations: [],
      chartData: null,
      stream: streamChat(
        `The SQL query was blocked by guardrails: ${guard.reason}. Please rephrase. ${args.question}`,
        args.memoryContext, args.systemPromptPrefix, args.chatHistory,
      ),
    }
  }

  const sql = guard.sanitized
  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  try {
    const result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sql))
    const context = JSON.stringify(result.rows, null, 2)
    const chartData = buildChartDataFromRows(result.rows)
    const stream = streamAnswer({
      question: args.question,
      context,
      source: 'SQL',
      systemPromptPrefix: args.systemPromptPrefix,
      memoryContext: args.memoryContext,
      chatHistory: args.chatHistory,
    })

    const citations: Citation[] = [
      {
        type: 'DATABASE',
        source: `${integration.name}.${extractTableName(sql)}`,
        query_used: sql,
      },
    ]

    return {
      toolRuns: [{
        type: 'SQL',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(sql),
      }],
      citations,
      chartData,
      integrationId: integration.id,
      stream,
    }
  } catch {
    return prepareChatStream(args)
  }
}

async function prepareRestStream(args: {
  question: string
  userId: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const connectors = await db.restApiConnector.findMany({
    where: { isActive: true },
    include: {
      endpoints: {
        where: { isEnabled: true },
        orderBy: [{ method: 'asc' }, { path: 'asc' }],
      },
    },
  })
  const endpointOptions: RestEndpointOption[] = connectors.flatMap((c) =>
    c.endpoints.map((e) => ({
      id: e.id,
      connectorName: c.name,
      method: e.method,
      path: e.path,
      description: e.description,
      parameterSchema: e.parameterSchema,
      sampleResponse: e.sampleResponse,
    })),
  )

  if (endpointOptions.length === 0) return prepareChatStream(args)

  const plan = await generateRestCall({
    question: args.question,
    endpoints: endpointOptions,
    memoryContext: args.memoryContext,
  })
  const selected = endpointOptions.find((e) => e.id === plan.endpointId)
  if (!selected) return prepareChatStream(args)

  const connector = connectors.find((c) =>
    c.endpoints.some((e) => e.id === selected.id),
  )
  if (!connector) return prepareChatStream(args)

  const endpoint = matchEndpoint(
    selected.method,
    selected.path,
    connector.endpoints.map((e) => ({ id: e.id, method: e.method, path: e.path, enabled: e.isEnabled })),
  )
  if (!endpoint) return prepareChatStream(args)

  const result = await executeRestRequest({
    connector,
    endpointId: endpoint.id,
    method: selected.method,
    path: selected.path,
    plan,
  })

  if (!result.ok) {
    return {
      toolRuns: [{
        type: 'REST_API',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: result.error,
        restApiEndpointId: endpoint.id,
      }],
      citations: [],
      chartData: null,
      stream: streamChat(
        `The REST API request failed: ${result.error}. ${args.question}`,
        args.memoryContext, args.systemPromptPrefix, args.chatHistory,
      ),
    }
  }

  const stream = streamAnswer({
    question: args.question,
    context: result.bodyText,
    source: 'REST_API',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })

  const citations: Citation[] = [
    {
      type: 'REST_API',
      source: `${connector.name} ${selected.method} ${selected.path}`,
      query_used: JSON.stringify({ query: plan.query, explanation: plan.explanation }),
    },
  ]

  return {
    toolRuns: [{
      type: 'REST_API',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.bodyText),
      restApiEndpointId: endpoint.id,
    }],
    citations,
    chartData: jsonRowsToChart(result.body),
    stream,
  }
}

async function preparePluginStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const relevant = await selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05 })
  const chatRelevant = relevant.filter((p) => p.chatEnabled)
  if (chatRelevant.length === 0) return prepareChatStream(args)

  const plugin = await db.plugin.findFirst({ where: { toolId: chatRelevant[0].toolId, isEnabled: true } })
  if (!plugin) return prepareChatStream(args)

  const result = await executePlugin({
    plugin: { manifestJson: plugin.manifestJson, toolId: plugin.toolId },
    input: JSON.stringify({ question: args.question, query: args.question }),
  })

  if (!result.ok) {
    return {
      toolRuns: [{
        type: 'PLUGIN',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: result.error,
      }],
      citations: [],
      chartData: null,
      stream: streamChat(
        `Plugin ${plugin.name} failed: ${result.error}. ${args.question}`,
        args.memoryContext, args.systemPromptPrefix, args.chatHistory,
      ),
    }
  }

  const context = `Plugin ${plugin.name} returned:\n${result.output}\n\nUser question: ${args.question}`
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })

  return {
    toolRuns: [{
      type: 'PLUGIN',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.output),
    }],
    citations: [],
    chartData: null,
    stream,
  }
}

export function chooseAvailableDecision(
  decision: RouteDecision,
  available: {
    hasIntegrations: boolean
    hasDocuments: boolean
    hasRestApis: boolean
  },
): RouteDecision {
  if (decision === 'CONTEXTUAL_CHAT') return 'CONTEXTUAL_CHAT'
  if (decision === 'PLUGIN') return 'PLUGIN'
  if (decision === 'SQL' && !available.hasIntegrations) return 'CHAT'
  if (decision === 'RAG' && !available.hasDocuments) return 'CHAT'
  if (decision === 'REST' && !available.hasRestApis) return 'CHAT'
  return decision
}

export function buildChartDataFromRows(rows: QueryRow[]): ChartData | null {
  if (!rows || rows.length < 2) return null
  const sampleKeys = Object.keys(rows[0] ?? {})
  if (sampleKeys.length < 2) return null

  let xKey: string | null = null
  const yKeys: string[] = []
  let looksLikeTimeSeries = false

  for (const key of sampleKeys) {
    const sampleValues = rows.slice(0, 6).map((row) => row[key])
    if (sampleValues.every(isNumeric)) {
      yKeys.push(key)
    } else if (
      !xKey &&
      sampleValues.every((value) => typeof value === 'string' || typeof value === 'number')
    ) {
      xKey = key
      if (sampleValues.some(isDateString)) looksLikeTimeSeries = true
    }
  }

  if (!xKey || yKeys.length === 0) return null

  return {
    type: looksLikeTimeSeries ? 'line' : 'bar',
    data: rows,
    xKey,
    yKeys,
  }
}

// ponytail: re-exported from ai.ts — single definition, test imports from here.
export { parseRestCallJson } from '@/lib/ai'

export function buildDocumentCitation(args: {
  documentName: string
  chunkIndex: number
  content: string
  score: number
}): Citation {
  const snippet = args.content.length > 240 ? `${args.content.slice(0, 240)}...` : args.content
  return {
    type: 'DOCUMENT',
    source: args.documentName,
    query_used: `chunk #${args.chunkIndex}`,
    chunkIndex: args.chunkIndex,
    snippet,
    score: args.score,
  }
}

async function runChatBranch(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const answer = await generateChat(args.question, args.systemPromptPrefix, args.memoryContext, args.chatHistory)
  return {
    answer,
    citations: [],
    chartData: null,
    toolRuns: [
      {
        type: 'CHAT',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(answer),
      },
    ],
  }
}

async function runContextualChatBranch(args: {
  question: string
  context: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const answer = await generateAnswer({
    question: args.question,
    context: args.context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })
  return {
    answer,
    citations: [],
    chartData: null,
    toolRuns: [
      {
        type: 'CHAT',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(args.context),
      },
    ],
  }
}

async function runRagBranch(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const retrieval = await retrieveRelevantChunks({
    query: args.question,
    topK: 4,
  })
  const topChunks = retrieval.chunks
  if (topChunks.length === 0 && !retrieval.graphContext) return runChatBranch(args)

  const chunkContext = topChunks
    .map(
      (item) =>
        `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`,
    )
    .join('\n\n---\n\n')
  const context = retrieval.graphContext
    ? `${chunkContext}\n\n--- Knowledge Graph Context ---\n${retrieval.graphContext}`
    : chunkContext
  const answer = await generateAnswer({
    question: args.question,
    context,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })
  const citations = topChunks.map((item) =>
    buildDocumentCitation({
      documentName: item.documentName,
      chunkIndex: item.chunkIndex,
      content: item.content,
      score: item.score,
    }),
  )

  await db.auditLog.create({
    data: {
      userId: null,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: JSON.stringify({
        query: args.question,
        returned: topChunks.length,
        candidatesScanned: retrieval.candidatesScanned,
        queryTokens: retrieval.queryTokens,
        topScore: topChunks[0]?.score ?? 0,
      }),
    },
  })

  return {
    answer,
    citations,
    chartData: null,
    toolRuns: [
      {
        type: 'RAG',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(context),
      },
    ],
  }
}

async function runSqlBranch(args: {
  question: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const integration = args.integrationId
    ? await db.integration.findFirst({
        where: { id: args.integrationId, status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : await db.integration.findFirst({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })

  if (!integration || integration.schemas.length === 0) {
    return unavailableDataSourceResult('SQL', args.question, started)
  }

  const schemaDescription = describeSchema(
    integration.schemas.map((schema) => ({
      tableName: schema.tableName,
      columns: safeParseColumns(schema.columns),
      rowCount: schema.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(schema.sampleRow),
    })),
  )
  const llm = await generateSql({
    question: args.question,
    schemaDescription,
    provider: integration.provider,
    memoryContext: args.memoryContext,
  })
  const guard = validateAndSanitizeLlmSql(llm.sql)
  if (!guard.ok) {
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: 'GUARDRAIL_BLOCK',
        severity: 'critical',
        detail: JSON.stringify({
          integrationId: integration.id,
          naturalQuery: args.question,
          generatedSql: llm.sql,
          reason: guard.reason,
          detectedNodes: guard.detectedNodes,
        }),
      },
    })
    return {
      answer:
        'The question was rejected because the system detected a risky query against company data.',
      citations: [],
      chartData: null,
      integrationId: integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'blocked',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: guard.reason ?? 'SQL blocked by guardrail',
        },
      ],
    }
  }

  const sql = guard.sanitized
  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  try {
    const result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sql))
    await db.queryHistory.create({
      data: {
        integrationId: integration.id,
        userId: args.userId,
        naturalQuery: args.question,
        generatedSql: sql,
        rowCount: result.rowCount,
        executionMs: result.executionMs,
        success: true,
      },
    })
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: 'SQL_EXECUTE',
        severity: 'info',
        detail: JSON.stringify({
          integrationId: integration.id,
          sql,
          rowCount: result.rowCount,
          executionMs: result.executionMs,
        }),
      },
    })

    const answer = await generateAnswer({
      question: args.question,
      context: JSON.stringify(result.rows, null, 2),
      source: 'SQL',
      systemPromptPrefix: args.systemPromptPrefix,
      memoryContext: args.memoryContext,
      chatHistory: args.chatHistory,
    })
    const citations: Citation[] = [
      {
        type: 'DATABASE',
        source: `${integration.name}.${extractTableName(sql)}`,
        query_used: sql,
      },
    ]

    return {
      answer,
      citations,
      chartData: buildChartDataFromRows(result.rows),
      integrationId: integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'success',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          outputSummary: summarize(sql),
        },
      ],
    }
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : String(e)
    await db.queryHistory.create({
      data: {
        integrationId: integration.id,
        userId: args.userId,
        naturalQuery: args.question,
        generatedSql: sql,
        success: false,
        errorMessage,
      },
    })
    await db.auditLog.create({
      data: {
        userId: args.userId,
        action: 'SQL_EXECUTE_ERROR',
        severity: 'warning',
        detail: JSON.stringify({ integrationId: integration.id, sql, error: errorMessage }),
      },
    })
    return {
      answer: `Sorry, the database query failed to execute.\n\nError: ${sanitizeSqlError(errorMessage)}\n\nSuggestion: try a more specific question, or check whether the queried table columns are available in this integration.`,
      citations: [],
      chartData: null,
      integrationId: integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'error',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage,
        },
      ],
    }
  }
}

// ponytail: sanitize SQL error — strip credentials, connection strings, and schema-internal noise.
export function sanitizeSqlError(msg: string): string {
  return msg
    .replace(/postgres:\/\/[^\s]+/g, 'postgres://***')
    .replace(/mysql:\/\/[^\s]+/g, 'mysql://***')
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=***')
    .replace(/user\s*=\s*[^\s;]+/gi, 'user=***')
    .slice(0, 300)
}

async function runRestBranch(args: {
  question: string
  userId: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const connectors = await db.restApiConnector.findMany({
    where: { isActive: true },
    include: {
      endpoints: {
        where: { isEnabled: true },
        orderBy: [{ method: 'asc' }, { path: 'asc' }],
      },
    },
  })
  const endpointOptions: RestEndpointOption[] = connectors.flatMap((connector) =>
    connector.endpoints.map((endpoint) => ({
      id: endpoint.id,
      connectorName: connector.name,
      method: endpoint.method,
      path: endpoint.path,
      description: endpoint.description,
      parameterSchema: endpoint.parameterSchema,
      sampleResponse: endpoint.sampleResponse,
    })),
  )

  if (endpointOptions.length === 0) return unavailableDataSourceResult('REST_API', args.question, started)

  const plan = await generateRestCall({
    question: args.question,
    endpoints: endpointOptions,
    memoryContext: args.memoryContext,
  })
  const selected = endpointOptions.find((endpoint) => endpoint.id === plan.endpointId)
  if (!selected) {
    return {
      answer: 'Sorry, the AI could not select a matching REST endpoint from the whitelist.',
      citations: [],
      chartData: null,
      toolRuns: [
        {
          type: 'REST_API',
          status: 'blocked',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: 'Selected endpoint is not whitelisted.',
        },
      ],
    }
  }

  const connector = connectors.find((item) =>
    item.endpoints.some((endpoint) => endpoint.id === selected.id),
  )
  if (!connector) return unavailableDataSourceResult('REST_API', args.question, started)

  const endpoint = matchEndpoint(
    selected.method,
    selected.path,
    connector.endpoints.map((item) => ({
      id: item.id,
      method: item.method,
      path: item.path,
      enabled: item.isEnabled,
    })),
  )
  if (!endpoint) return unavailableDataSourceResult('REST_API', args.question, started)

  const result = await executeRestRequest({
    connector,
    endpointId: endpoint.id,
    method: selected.method,
    path: selected.path,
    plan,
  })

  if (!result.ok) {
    return {
      answer: 'Sorry, the REST API request failed to execute. Check the connection and whitelisted endpoints.',
      citations: [],
      chartData: null,
      toolRuns: [
        {
          type: 'REST_API',
          status: 'error',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: result.error,
          restApiEndpointId: endpoint.id,
        },
      ],
    }
  }

  await db.auditLog.create({
    data: {
      userId: args.userId,
      action: 'REST_ENDPOINT_EXECUTE',
      severity: result.statusCode >= 200 && result.statusCode < 400 ? 'info' : 'warning',
      detail: JSON.stringify({
        connectorId: connector.id,
        endpointId: endpoint.id,
        method: selected.method,
        path: selected.path,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
      }),
    },
  })

  const answer = await generateAnswer({
    question: args.question,
    context: result.bodyText,
    source: 'REST_API',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })
  const citations: Citation[] = [
    {
      type: 'REST_API',
      source: `${connector.name} ${selected.method} ${selected.path}`,
      query_used: JSON.stringify({ query: plan.query, explanation: plan.explanation }),
    },
  ]

  return {
    answer,
    citations,
    chartData: jsonRowsToChart(result.body),
    toolRuns: [
      {
        type: 'REST_API',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(result.bodyText),
        restApiEndpointId: endpoint.id,
      },
    ],
  }
}

async function runPluginBranch(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const relevant = await selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05 })
  const chatRelevant = relevant.filter((p) => p.chatEnabled)
  if (chatRelevant.length === 0) return runChatBranch(args)

  const plugin = await db.plugin.findFirst({ where: { toolId: chatRelevant[0].toolId, isEnabled: true } })
  if (!plugin) return runChatBranch(args)

  const result = await executePlugin({
    plugin: { manifestJson: plugin.manifestJson, toolId: plugin.toolId },
    input: JSON.stringify({ question: args.question, query: args.question }),
  })

  if (!result.ok) {
    return {
      answer: `Sorry, plugin ${plugin.name} failed to execute: ${result.error}`,
      citations: [],
      chartData: null,
      toolRuns: [{
        type: 'PLUGIN',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        errorMessage: result.error,
      }],
    }
  }

  const context = `Plugin ${plugin.name} returned:\n${result.output}\n\nUser question: ${args.question}`
  const answer = await generateAnswer({
    question: args.question,
    context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })

  return {
    answer,
    citations: [],
    chartData: null,
    toolRuns: [{
      type: 'PLUGIN',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.output),
    }],
  }
}

async function executeRestRequest(args: {
  connector: {
    id: string
    baseUrl: string
    authType: string
    encryptedAuthConfig: string | null
    timeoutMs: number
  }
  endpointId: string
  method: string
  path: string
  plan: RestCallPlan
}): Promise<
  | { ok: true; statusCode: number; latencyMs: number; bodyText: string; body: unknown }
  | { ok: false; error: string; latencyMs: number }
> {
  const started = Date.now()
  const authConfig = args.connector.encryptedAuthConfig
    ? decryptConfig(args.connector.encryptedAuthConfig)
    : {}
  const authHeaders = await buildAuthHeaders(args.connector.authType, authConfig)
  const hasBody = args.method !== 'GET' && args.method !== 'HEAD' && args.plan.body !== null
  const headers = {
    ...authHeaders,
    ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
  }
  const requestSummary = JSON.stringify({
    method: args.method,
    path: args.path,
    query: args.plan.query,
    headers: sanitizeHeaders(headers),
  })

  try {
    const url = buildEndpointUrl(args.connector.baseUrl, args.path, args.plan.query)
    const response = await fetch(url, {
      method: args.method,
      headers,
      body: hasBody ? JSON.stringify(args.plan.body) : undefined,
      signal: AbortSignal.timeout(args.connector.timeoutMs),
    })
    const bodyText = (await response.text()).slice(0, 8000)
    const latencyMs = Date.now() - started
    await db.restApiRequestLog.create({
      data: {
        connectorId: args.connector.id,
        endpointId: args.endpointId,
        statusCode: response.status,
        latencyMs,
        requestSummary,
        responseSummary: summarize(bodyText),
      },
    })
    if (!response.ok) {
      return {
        ok: false,
        error: `REST API returned HTTP ${response.status} (${response.statusText || 'Unknown'}). Endpoint: ${args.method} ${args.path}.`,
        latencyMs,
      }
    }
    return {
      ok: true,
      statusCode: response.status,
      latencyMs,
      bodyText,
      body: safeJson(bodyText),
    }
  } catch (e) {
    const latencyMs = Date.now() - started
    const error = e instanceof Error ? e.message : String(e)
    await db.restApiRequestLog.create({
      data: {
        connectorId: args.connector.id,
        endpointId: args.endpointId,
        latencyMs,
        requestSummary,
        errorMessage: error,
      },
    })
    return { ok: false, error, latencyMs }
  }
}

function unavailableDataSourceResult(
  type: PendingToolRun['type'],
  question: string,
  started: number,
): CompletionResult {
  return {
    answer: 'The required data source is not yet available or not configured as active.',
    citations: [],
    chartData: null,
    toolRuns: [
      {
        type,
        status: 'blocked',
        latencyMs: Date.now() - started,
        inputSummary: summarize(question),
        errorMessage: 'Data source unavailable.',
      },
    ],
  }
}

function safeParseColumns(raw: string): ReflectedTable['columns'] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((column) => ({
      name: String(column?.name ?? ''),
      type: String(column?.type ?? ''),
      primaryKey: Boolean(column?.primaryKey) || undefined,
      notNull: Boolean(column?.notNull) || undefined,
      foreignKey: column?.foreignKey ? String(column.foreignKey) : undefined,
      distinctValues: Array.isArray(column?.distinctValues) ? column.distinctValues.map(String) : undefined,
    }))
  } catch {
    return []
  }
}

function safeParseSampleRow(raw: string | null | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed
    return undefined
  } catch {
    return undefined
  }
}

function extractTableName(sql: string): string {
  const match = sql.match(/\b(?:FROM|JOIN)\s+["`]?(\w+)["`]?/i)
  return match ? match[1] : 'query'
}

function jsonRowsToChart(value: unknown): ChartData | null {
  const rows = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : []
  if (!rows.every((row) => row && typeof row === 'object' && !Array.isArray(row))) return null
  return buildChartDataFromRows(rows as QueryRow[])
}

function safeJson(text: string): unknown | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function summarize(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value
}

function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return true
  if (typeof value === 'bigint') return true
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
    return true
  }
  return false
}

function isDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{2}\/\d{2}\/\d{4}/.test(value)
}
