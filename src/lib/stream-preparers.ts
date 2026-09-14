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
import { resolveIntegrationForQuestion, tokenize } from '@/lib/smart-router'
import { wrapUntrusted } from '@/lib/evidence-boundary'
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
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context: args.context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
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
  // `usage` arrives only after the stream ends, so it is captured here and read by the
  // route once the stream drains. Exposed as a getter, never a value: object spread
  // evaluates getters, and a snapshot taken at return time is always undefined.
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamChat(args.question, args.memoryContext, args.systemPromptPrefix, args.chatHistory, (u) => {
    usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens }
  })
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
    get usage() { return usage },
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

  // Same framing as the non-streaming RAG branch — untrusted document text must
  // be marked as data on BOTH transports, or the two drift (this class of
  // transport drift has now bitten three times in this codebase).
  const context = retrieval.graphContext
    ? `${wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)}\n\n${wrapUntrusted('CONTEXT (KNOWLEDGE GRAPH):', retrieval.graphContext)}`
    : wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)

  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
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
    get usage() { return usage },
    citationTrail: retrieval.citationTrail,
  }
}

/**
 * Message shown when we refuse to guess the data source in a streaming turn.
 * Kept next to the non-streaming twin (ambiguousDataSourceResult in tool-utils)
 * so the two wordings stay recognisably the same behaviour to the user.
 */
function ambiguousStreamNote(names: string[]): string {
  const list = names.slice(0, 10)
  const more = names.length > list.length ? ` (and ${names.length - list.length} more)` : ''
  return (
    `I could not tell which data source this question refers to, and I do not want to guess ` +
    `and answer from the wrong database. Available sources${more}: ${list.join(', ')}. ` +
    `Please name the source you mean — for example "in ${list[0] ?? 'the sales database'}, ...".`
  )
}

/** Stream a plain note (no SQL) as the assistant's answer. */
function prepareChatStreamWithNote(
  args: { question: string; systemPromptPrefix?: string; memoryContext?: string; chatHistory?: ChatHistoryEntry[] },
  note: string,
  started: number,
): StreamingCompletionResult {
  const stream = (async function* () { yield note })()
  return {
    toolRuns: [{
      type: 'SQL',
      status: 'blocked',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      errorMessage: 'Ambiguous data source — refusing to guess.',
    }],
    citations: [],
    chartData: null,
    stream,
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

  // ponytail: this used to be an inline ~45-line keyword scorer ending in
  // `bestMatch ?? allIntegrations[0]` — a SECOND implementation that drifted from
  // the non-streaming path's `orderBy: { createdAt: 'asc' }` and from the
  // router's ambiguity-aware picker. The same question could therefore resolve to
  // a different database depending on transport, and when nothing matched both
  // fallbacks silently took the OLDEST source instead of refusing. Now delegated
  // to resolveIntegrationForQuestion so there is exactly one implementation.
  if (!integration) {
    const available = await db.integration.count({ where: { status: 'active' } })
    if (available > 1) {
      const choice = await resolveIntegrationForQuestion(tokenize(args.question), args.question, 'refuse')
      if (!choice) {
        // Refuse to guess in a streaming turn too, and name the candidates.
        const names = await db.integration.findMany({
          where: { status: 'active' },
          orderBy: { name: 'asc' },
          select: { name: true },
        })
        return prepareChatStreamWithNote(args, ambiguousStreamNote(names.map((n) => n.name)), started)
      }
      integration = await db.integration.findFirst({
        where: { id: choice.integrationId, status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    } else {
      integration = await db.integration.findFirst({
        where: { status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
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
    // ponytail: generateSql MUST be inside a try. It was not, and only the SQL
    // EXECUTION was guarded, so an LLM failure (provider down, dead BYOK key,
    // timeout — all of which throw) escaped prepareSqlStream entirely. The
    // caller has already promised the client an SSE stream by that point, so the
    // turn died with the connection open and ZERO frames sent: the UI showed
    // nothing at all, not even an error. Found by stream-preparers.test.ts,
    // which is the first test ever to exercise this path.
    let candidate: Awaited<ReturnType<typeof generateSql>>
    try {
      candidate = await generateSql({
        question: args.question,
        schemaDescription,
        provider: integration.provider,
        memoryContext: args.memoryContext,
        systemPromptPrefix: args.systemPromptPrefix,
        businessContext: integration.businessContext,
        repairFeedback: feedback,
      })
    } catch (e) {
      // A transient provider blip must not end the turn; the repair loop retries.
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(`<generation failed: ${lastSqlError}>`)
      continue
    }
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
  const context = wrapUntrusted('CONTEXT (DATABASE ROWS):', JSON.stringify(result.rows, null, 2))
  const chartData = buildChartDataFromRows(result.rows)
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'SQL',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    rowCount: result.rowCount,
    truncated: result.rowCount >= SQL_MAX_LIMIT,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
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
    get usage() { return usage },
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

  // ponytail: same leak prepareSqlStream had. `generateRestCall` is an LLM call
  // that throws on a dead provider/key/timeout, and it sat outside any try — so
  // a BYOK failure killed the turn after the SSE stream was already promised,
  // leaving the client with an open connection and no frames. The caller can
  // recover from this, so answer as CHAT instead.
  let plan: Awaited<ReturnType<typeof generateRestCall>>
  try {
    plan = await generateRestCall({
      question: args.question,
      endpoints: endpointOptions,
      memoryContext: args.memoryContext,
    })
  } catch {
    return prepareChatStream(args)
  }
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

  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context: result.bodyText,
    source: 'REST_API',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
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
    get usage() { return usage },
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

  // Plugin output is third-party and therefore untrusted too.
  const context = `${wrapUntrusted(`CONTEXT (PLUGIN ${plugin.name}):`, result.output)}\n\nUser question: ${args.question}`
  let usage: { promptTokens: number; completionTokens: number } | undefined
  const stream = streamAnswer({
    question: args.question,
    context,
    source: 'CHAT',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    onUsage: (u) => { usage = { promptTokens: u.promptTokens, completionTokens: u.completionTokens } },
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
    get usage() { return usage },
  }
}
