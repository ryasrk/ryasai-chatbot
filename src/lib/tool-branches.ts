import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import {
  generateAnswer,
  generateChat,
  generateRestCall,
  generateSql,
  type RestCallPlan,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
} from '@/lib/rest-api-connectors'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import { withToolSandbox } from '@/lib/tool-sandbox'
import { checkToolRateLimit } from '@/lib/tool-rate-limit'
import { getLastLlmUsage } from '@/lib/llm-client'
import type { Citation } from '@/lib/types'
import {
  withSqlConcurrency,
  buildChartDataFromRows,
  buildDocumentCitation,
  sanitizeSqlError,
  summarize,
  unavailableDataSourceResult,
  safeParseColumns,
  safeParseSampleRow,
  extractTableName,
  jsonRowsToChart,
  safeJson,
  type CompletionResult,
  type ChatHistoryEntry,
} from '@/lib/tool-utils'

// ---------------------------------------------------------------------------
// Non-streaming branch executors — one function per RouteDecision.
// Called by runNonStreamingChatCompletion in tool-router.ts.
// ----------------------------------------------------------------------------

export async function runChatBranch(args: {
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
    usage: getLastLlmUsage(),
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

export async function runContextualChatBranch(args: {
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

export async function runRagBranch(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  let retrieval: Awaited<ReturnType<typeof retrieveWithReflection>>
  try {
    retrieval = await retrieveWithReflection({
      query: args.question,
      topK: 4,
    })
  } catch {
    // ponytail: RAG is best-effort — if the knowledge backend is down, degrade
    // to plain chat instead of failing the whole turn.
    return runChatBranch(args)
  }
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
  // ponytail: if reflection says evidence is insufficient after multi-turn retrieval,
  // note it in the context so the LLM doesn't hallucinate beyond the evidence.
  const reflectionNote = !retrieval.reflection.sufficient && retrieval.retrievalPasses >= 2
    ? `\n\n[Note: The retrieved evidence may not fully address the question. Answer based only on the evidence above. If the evidence doesn't contain the answer, say so.]`
    : ''
  const answer = await generateAnswer({
    question: args.question,
    context: context + reflectionNote,
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
    answer,
    citations,
    chartData: null,
    usage: getLastLlmUsage(),
    citationTrail: retrieval.citationTrail,
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

export async function runSqlBranch(args: {
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
      description: schema.description,
    })),
  )
  const llm = await generateSql({
    question: args.question,
    schemaDescription,
    provider: integration.provider,
    memoryContext: args.memoryContext,
    systemPromptPrefix: args.systemPromptPrefix,
  })
  const guard = validateAndSanitizeLlmSql(llm.sql)
  if (!guard.ok) {
    await db.auditLog.create({
      data: {
        organizationId: getOrgContext()!,
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

  const orgId = getOrgContext()
  if (orgId) {
    const rl = await checkToolRateLimit('sql', orgId)
    if (!rl.allowed) {
      return {
        answer: 'Rate limit exceeded for SQL queries. Please try again in a minute.',
        citations: [],
        chartData: null,
        integrationId: integration.id,
        toolRuns: [
          {
            type: 'SQL',
            status: 'blocked',
            latencyMs: Date.now() - started,
            inputSummary: summarize(args.question),
            errorMessage: 'SQL rate limit exceeded.',
          },
        ],
      }
    }
  }

  const connector = connectorRegistry.getConnector(
    integration.id,
    integration.provider,
    decryptConfig(integration.encryptedConfig),
  )

  try {
    const result = await withSqlConcurrency(integration.id, () =>
      withToolSandbox('sql', () => connector.executeQuery(sql)),
    )
    await db.queryHistory.create({
      data: {
        organizationId: getOrgContext()!,
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
        organizationId: getOrgContext()!,
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
      usage: getLastLlmUsage(),
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
        organizationId: getOrgContext()!,
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
        organizationId: getOrgContext()!,
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

export async function runRestBranch(args: {
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
      organizationId: getOrgContext()!,
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
    usage: getLastLlmUsage(),
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

export async function runPluginBranch(args: {
  question: string
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
}): Promise<CompletionResult> {
  const started = Date.now()
  const relevant = await selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05, context: 'chat' })
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
    usage: getLastLlmUsage(),
    toolRuns: [{
      type: 'PLUGIN',
      status: 'success',
      latencyMs: Date.now() - started,
      inputSummary: summarize(args.question),
      outputSummary: summarize(result.output),
    }],
  }
}

// ---------------------------------------------------------------------------
// REST request executor — shared by runRestBranch and prepareRestStream.
// ----------------------------------------------------------------------------

export async function executeRestRequest(args: {
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
    // SSRF protection at execution time — don't trust admin-configured baseUrl blindly.
    const parsedUrl = new URL(url)
    const { isBlockedHost, isBlockedHostAsync } = await import('@/lib/llm-config')
    if (isBlockedHost(parsedUrl.hostname) || await isBlockedHostAsync(parsedUrl.hostname)) {
      return { ok: false, error: 'Endpoint points to a blocked internal host.', latencyMs: Date.now() - started }
    }
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
        organizationId: getOrgContext()!,
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
        organizationId: getOrgContext()!,
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
