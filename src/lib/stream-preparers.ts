import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import { SQL_REPAIR_ATTEMPTS, SQL_MAX_LIMIT } from '@/lib/constants'
import {
  generateRestCall,
  generateSql,
  streamAnswer,
  streamChat,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { matchEndpoint } from '@/lib/rest-api-connectors'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import type { Citation } from '@/lib/types'
import {
  withSqlConcurrency,
  buildChartDataFromRows,
  buildDocumentCitation,
  summarize,
  safeParseColumns,
  safeParseSampleRow,
  extractTableName,
  jsonRowsToChart,
  type ChatHistoryEntry,
  type StreamingCompletionResult,
} from '@/lib/tool-utils'
import { executeRestRequest } from '@/lib/tool-branches'

// ---------------------------------------------------------------------------
// Streaming branch preparers — one per RouteDecision.
// Called by runStreamingChatCompletion in tool-router.ts.
// Each returns a StreamingCompletionResult with an AsyncGenerator stream.
// ----------------------------------------------------------------------------

export async function prepareContextualChatStream(args: {
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

export async function prepareChatStream(args: {
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

export async function prepareRagStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  let retrieval: Awaited<ReturnType<typeof retrieveWithReflection>>
  try {
    retrieval = await retrieveWithReflection({ query: args.question, topK: 4 })
  } catch {
    // ponytail: RAG is best-effort — if the knowledge backend is down, degrade
    // to plain chat instead of failing the whole stream.
    return prepareChatStream(args)
  }
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
      organizationId: getOrgContext()!,
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
    citationTrail: retrieval.citationTrail,
  }
}

export async function prepareSqlStream(args: {
  question: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  let integration = args.integrationId
    ? await db.integration.findFirst({
        where: { id: args.integrationId, status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : null

  // ponytail: when no specific integration was resolved by the router (e.g.
  // embedding API timed out during pickBestIntegration), fall back to picking
  // the integration whose schema keywords best match the question — NOT just
  // the oldest one. The old `findFirst({ orderBy: { createdAt: 'asc' } })`
  // always picked "Local Postgres Test" (the app's own DB) over PRINASA.
  if (!integration) {
    const allIntegrations = await db.integration.findMany({
      where: { status: 'active' },
      include: { schemas: { orderBy: { tableName: 'asc' } } },
    })
    if (allIntegrations.length === 1) {
      integration = allIntegrations[0]
    } else if (allIntegrations.length > 1) {
      const qLower = args.question.toLowerCase()
      const qTokens = qLower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
      let bestMatch: typeof allIntegrations[0] | null = null
      let bestScore = 0
      for (const integ of allIntegrations) {
        let score = 0
        for (const s of integ.schemas) {
          if (qLower.includes(s.tableName.toLowerCase())) score += 2
          try {
            const cols = JSON.parse(s.columns) as Array<{ name?: string }>
            for (const c of cols) {
              if (c.name && qLower.includes(c.name.toLowerCase())) score += 1
            }
          } catch { /* skip */ }
        }
        // Also check integration name keywords
        for (const word of integ.name.toLowerCase().split(/\s+/)) {
          if (word.length >= 4 && qLower.includes(word)) score += 3
        }
        if (score > bestScore) {
          bestScore = score
          bestMatch = integ
        }
      }
      integration = bestMatch ?? allIntegrations[0]
    }
  }

  if (!integration || integration.schemas.length === 0) {
    return prepareChatStream(args)
  }

  const schemaDescription = describeSchema(
    integration.schemas.map((schema) => ({
      tableName: schema.tableName,
      columns: safeParseColumns(schema.columns),
      rowCount: schema.rowCount ?? undefined,
      sampleRow: safeParseSampleRow(schema.sampleRow),
      description: schema.description,
    })),
  )
  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )
  // ponytail: SQL error-correction loop, streaming twin of runSqlBranch's.
  // A failed execution feeds the DB error back to generateSql for a corrected
  // retry instead of ending the turn with a canned apology.
  let lastSqlError = ''
  const attemptedSql: string[] = []
  let executed: Awaited<ReturnType<typeof connector.executeQuery>> | null = null
  let finalSql = ''

  for (let attempt = 0; attempt <= SQL_REPAIR_ATTEMPTS; attempt++) {
    const feedback = attempt > 0
      ? `The previous SQL was:\n${attemptedSql[attemptedSql.length - 1]}\nIt failed with error:\n${lastSqlError}`
      : undefined
    const candidate = await generateSql({
      question: args.question,
      schemaDescription,
      provider: integration.provider,
      memoryContext: args.memoryContext,
      systemPromptPrefix: args.systemPromptPrefix,
      businessContext: integration.businessContext,
      repairFeedback: feedback,
    })
    const guard = validateAndSanitizeLlmSql(candidate.sql)
    if (!guard.ok) {
      lastSqlError = guard.reason ?? 'SQL rejected by guardrail'
      attemptedSql.push(candidate.sql)
      continue // guardrail rejection is retryable
    }
    const sanitizedSql = guard.sanitized
    try {
      // ponytail: retry on transient connection errors (ECONNRESET is common
      // with remote PRINASA DB under load — a single retry recovers most cases).
      let result: Awaited<ReturnType<typeof connector.executeQuery>>
      try {
        result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sanitizedSql))
      } catch (e) {
        if (/ECONNRESET|ETIMEDOUT|EPIPE|socket hang up/i.test(e instanceof Error ? e.message : String(e))) {
          await new Promise((r) => setTimeout(r, 1000))
          result = await withSqlConcurrency(integration.id, () => connector.executeQuery(sanitizedSql))
        } else {
          throw e
        }
      }
      executed = result
      finalSql = sanitizedSql
      break
    } catch (e) {
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(sanitizedSql)
    }
  }

  if (!executed) {
    const errMsg = lastSqlError
    return {
      toolRuns: [{
        type: 'SQL',
        status: 'error',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: '',
        errorMessage: errMsg.slice(0, 500),
      }],
      citations: [],
      chartData: null,
      stream: streamAnswer({
        question: args.question,
        context: `SQL execution error after ${SQL_REPAIR_ATTEMPTS + 1} attempts: ${errMsg}`,
        source: 'SQL',
        systemPromptPrefix: args.systemPromptPrefix,
        memoryContext: args.memoryContext,
        chatHistory: args.chatHistory,
      }),
    }
  }

  const result = executed
  const context = JSON.stringify(result.rows, null, 2)
  const chartData = buildChartDataFromRows(result.rows)
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'SQL',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    rowCount: result.rowCount,
    truncated: result.rowCount >= SQL_MAX_LIMIT,
  })

  const citations: Citation[] = [
    {
      type: 'DATABASE',
      source: `${integration.name}.${extractTableName(finalSql)}`,
      query_used: finalSql,
    },
  ]

  return {
    toolRuns: [{
      type: 'SQL',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(finalSql),
    }],
    citations,
    chartData,
    integrationId: integration.id,
    stream,
  }
}

export async function prepareRestStream(args: {
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

export async function preparePluginStream(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<StreamingCompletionResult> {
  const started = Date.now()
  const relevant = await selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05, context: 'chat' })
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
