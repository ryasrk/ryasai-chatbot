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
  type RouteDecision,
  type RestCallPlan,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveRelevantChunks } from '@/lib/rag'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
} from '@/lib/rest-api-connectors'
import { getPromptSettings } from '@/lib/prompt-settings'
import type { ChartData, Citation } from '@/lib/types'

type ToolRunStatus = 'success' | 'error' | 'blocked'

export interface PendingToolRun {
  type: 'RAG' | 'SQL' | 'REST_API' | 'CHAT'
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

export async function runNonStreamingChatCompletion(args: {
  question: string
  companyId: string
  userId: string
  integrationId?: string
}): Promise<CompletionResult> {
  const [integrationCount, documentCount, restEndpointCount, promptSettings] = await Promise.all([
    db.integration.count({ where: { companyId: args.companyId, status: 'active' } }),
    db.document.count({ where: { companyId: args.companyId, status: 'ready' } }),
    db.restApiEndpoint.count({
      where: {
        isEnabled: true,
        connector: { companyId: args.companyId, isActive: true },
      },
    }),
    getPromptSettings(db, args.companyId),
  ])
  const smartMappingHints = await loadSmartMappingHints(args.companyId)

  const routed = await routeQuery({
    question: args.question,
    hasIntegrations: integrationCount > 0,
    hasDocuments: documentCount > 0,
    hasRestApis: restEndpointCount > 0,
    companyId: args.companyId,
    smartMappingHints,
  })
  let decision = chooseAvailableDecision(routed.decision, {
    hasIntegrations: integrationCount > 0,
    hasDocuments: documentCount > 0,
    hasRestApis: restEndpointCount > 0,
  })

  // Enforce prompt-settings tool toggles: if the chosen tool is disabled, fall
  // back to CHAT (the default safe path).
  if (decision === 'SQL' && !promptSettings.tools.sql) decision = 'CHAT'
  if (decision === 'RAG' && !promptSettings.tools.rag) decision = 'CHAT'
  if (decision === 'REST' && !promptSettings.tools.restApi) decision = 'CHAT'

  const branchArgs = {
    ...args,
    systemPromptPrefix: promptSettings.systemPrompt || undefined,
  }

  if (decision === 'SQL') return runSqlBranch(branchArgs)
  if (decision === 'RAG') return runRagBranch(branchArgs)
  if (decision === 'REST') return runRestBranch(branchArgs)
  return runChatBranch(branchArgs)
}

async function loadSmartMappingHints(companyId: string): Promise<string> {
  const rows = await db.smartMapping.findMany({
    where: { companyId, status: 'active' },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  })
  return rows
    .map((row) => {
      const synonyms = safeParseArray(row.synonymsJson).slice(0, 12).join(', ')
      return `${row.sourceType}:${row.sourceName} -> ${row.routingHint}/${row.entityType} (${synonyms})`
    })
    .join('\n')
}

export function chooseAvailableDecision(
  decision: RouteDecision,
  available: {
    hasIntegrations: boolean
    hasDocuments: boolean
    hasRestApis: boolean
  },
): RouteDecision {
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

export function parseRestCallJson(raw: string): RestCallPlan {
  const cleaned = raw.replace(/```json|```/g, '').trim()
  const parsed = JSON.parse(cleaned) as Partial<RestCallPlan>
  const query =
    parsed.query && typeof parsed.query === 'object' && !Array.isArray(parsed.query)
      ? parsed.query
      : {}
  return {
    endpointId: String(parsed.endpointId ?? '').trim(),
    query: query as RestCallPlan['query'],
    body: parsed.body === undefined ? null : parsed.body,
    explanation: String(parsed.explanation ?? '').trim(),
  }
}

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
  companyId: string
  systemPromptPrefix?: string
}): Promise<CompletionResult> {
  const started = Date.now()
  const answer = await generateChat(args.question, args.companyId, args.systemPromptPrefix)
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

async function runRagBranch(args: {
  question: string
  companyId: string
  systemPromptPrefix?: string
}): Promise<CompletionResult> {
  const started = Date.now()
  const retrieval = await retrieveRelevantChunks({
    companyId: args.companyId,
    query: args.question,
    topK: 4,
  })
  const topChunks = retrieval.chunks
  if (topChunks.length === 0) return runChatBranch(args)

  const context = topChunks
    .map(
      (item) =>
        `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`,
    )
    .join('\n\n---\n\n')
  const answer = await generateAnswer({
    question: args.question,
    context,
    source: 'RAG',
    companyId: args.companyId,
    systemPromptPrefix: args.systemPromptPrefix,
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
      companyId: args.companyId,
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
  companyId: string
  userId: string
  integrationId?: string
  systemPromptPrefix?: string
}): Promise<CompletionResult> {
  const started = Date.now()
  const integration = args.integrationId
    ? await db.integration.findFirst({
        where: { id: args.integrationId, companyId: args.companyId, status: 'active' },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : await db.integration.findFirst({
        where: { companyId: args.companyId, status: 'active' },
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
    })),
  )
  const llm = await generateSql({
    question: args.question,
    schemaDescription,
    provider: integration.provider,
    companyId: args.companyId,
  })
  const guard = validateAndSanitizeLlmSql(llm.sql)
  if (!guard.ok) {
    await db.auditLog.create({
      data: {
        companyId: args.companyId,
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
        'Pertanyaan ditolak karena sistem mendeteksi kueri yang berisiko terhadap data perusahaan.',
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
    const result = await connector.executeQuery(sql)
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
        companyId: args.companyId,
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
      companyId: args.companyId,
      systemPromptPrefix: args.systemPromptPrefix,
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
        companyId: args.companyId,
        userId: args.userId,
        action: 'SQL_EXECUTE_ERROR',
        severity: 'warning',
        detail: JSON.stringify({ integrationId: integration.id, sql, error: errorMessage }),
      },
    })
    return {
      answer: 'Maaf, kueri ke database gagal dieksekusi. Silakan coba pertanyaan yang lebih spesifik.',
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

async function runRestBranch(args: {
  question: string
  companyId: string
  userId: string
  systemPromptPrefix?: string
}): Promise<CompletionResult> {
  const started = Date.now()
  const connectors = await db.restApiConnector.findMany({
    where: { companyId: args.companyId, isActive: true },
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
    companyId: args.companyId,
  })
  const selected = endpointOptions.find((endpoint) => endpoint.id === plan.endpointId)
  if (!selected) {
    return {
      answer: 'Maaf, AI tidak dapat memilih endpoint REST yang sesuai dari whitelist.',
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
    companyId: args.companyId,
    connector,
    endpointId: endpoint.id,
    method: selected.method,
    path: selected.path,
    plan,
  })

  if (!result.ok) {
    return {
      answer: 'Maaf, request ke REST API gagal dijalankan. Periksa koneksi dan endpoint whitelist.',
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
      companyId: args.companyId,
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
    companyId: args.companyId,
    systemPromptPrefix: args.systemPromptPrefix,
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

async function executeRestRequest(args: {
  companyId: string
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
  const authHeaders = buildAuthHeaders(args.connector.authType, authConfig)
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
        companyId: args.companyId,
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
        error: `REST API returned HTTP ${response.status}.`,
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
        companyId: args.companyId,
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
    answer: 'Sumber data yang dibutuhkan belum tersedia atau belum dikonfigurasi aktif.',
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
    }))
  } catch {
    return []
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

function safeParseArray(text: string): string[] {
  const parsed = safeJson(text)
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
}

function summarize(value: string): string {
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
