import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { requireOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import { SQL_REPAIR_ATTEMPTS, SQL_MAX_LIMIT } from '@/lib/constants'
import {
  generateAnswer,
  generateChat,
  generateRestCall,
  type RestCallPlan,
  type RestEndpointOption,
} from '@/lib/ai'
import { type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
// Namespace import for `expandQuery`: tests mock intent-pipeline with partial surfaces, and a missing NAMED export
// fails the whole file at load.
import * as intentNs from '@/lib/intent-pipeline'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
} from '@/lib/rest-api-connectors'
// Namespace import: several test files mock rest-api-connectors with a partial surface, and a missing NAMED
// export fails the whole file at load. Absent in such a mock, invalidation is simply skipped.
import * as restConnectorsNs from '@/lib/rest-api-connectors'
import { guardedFetch, readTextBounded } from '@/lib/guarded-fetch'

import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import { gatherRagEvidence, type RagEvidence } from '@/lib/pipelines/rag-pipeline'
import { runSqlPipeline, buildCrossSourceNote, forbiddenSourceMessage, documentsShouldAnswerInstead } from '@/lib/pipelines/sql-pipeline'
import type { RelevanceJudge } from '@/lib/sql-answerability'
import { getLastLlmUsage } from '@/lib/llm-client'
import type { Citation } from '@/lib/types'
import {
  buildChartDataFromRows,
  sanitizeSqlError,
  summarize,
  unavailableDataSourceResult,
  ambiguousDataSourceResult,
  extractTableName,
  jsonRowsToChart,
  safeJson,
  type CompletionResult,
  type ChatHistoryEntry,
} from '@/lib/tool-utils'

const log = scopedLogger('tool-branches')

/** Bytes read from a REST response; only 8,000 characters are kept (4 bytes per character at most, plus room). */
const REST_RESPONSE_READ_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Non-streaming branch executors — one function per RouteDecision.
// Called by runNonStreamingChatCompletion in tool-router.ts.
// ----------------------------------------------------------------------------

export async function runChatBranch(
  args: {
    question: string
    systemPromptPrefix?: string
    memoryContext?: string
    chatHistory?: ChatHistoryEntry[]
  },
  degradation?: { degradedFrom: string; degradedReason: string },
): Promise<CompletionResult> {
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
        /*
         * Present ONLY on a degraded turn, so its absence continues to mean "an ordinary chat answer".
         * The reason travels with the run: an operator reading the audit trail sees what failed, not just
         * that something did. (Verified-valid weakness #1: the fallback previously left a plain CHAT run,
         * indistinguishable from a turn that never wanted documents.)
         */
        ...(degradation
          ? { outputSummary: summarize(`DEGRADED from ${degradation.degradedFrom}: ${degradation.degradedReason}`) }
          : {}),
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
  /** Retrieval scope from the caller's API key and request. `null`/absent = every document. */
  documentIds?: string[] | null
  /** Retrieval the router started alongside intent analysis; reused only when it was started for exactly this request. */
  speculativeRetrieval?: SpeculativeRetrieval | null
  /**
   * The turn reached retrieval only because the knowledge-base probe matched it (kb-probe.ts), not because the model
   * asked for documents. When the evidence does not support an answer, it is answered as the chat turn it was.
   */
  chatIfUnsupported?: boolean
  /**
   * The model picked a web tool and the probe found the question in the documents (CRAG, arXiv 2401.15884: go to the
   * web when retrieval does not hold the answer). Unsupported, empty or failed retrieval runs the web tool it picked.
   */
  webIfUnsupported?: boolean
  /** Evidence the caller already gathered (the SQL branch's second chance checks it before handing over). */
  evidence?: RagEvidence
}): Promise<CompletionResult> {
  const started = Date.now()
  const evidence = args.evidence ?? await gatherRagEvidence(args)
  if (args.webIfUnsupported && (evidence.kind !== 'ready' || !evidence.supported)) return runPluginBranch(args)
  if (evidence.kind === 'degraded') {
    log.warn('RAG retrieval failed; answering from chat', { error: evidence.reason })
    return runChatBranch(args, { degradedFrom: 'RAG', degradedReason: evidence.reason })
  }
  if (evidence.kind === 'empty' || (args.chatIfUnsupported && !evidence.supported)) return runChatBranch(args)

  const answer = await generateAnswer({
    question: args.question,
    context: evidence.answerContext,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })

  return {
    answer,
    citations: evidence.citations,
    chartData: null,
    usage: getLastLlmUsage(),
    citationTrail: evidence.citationTrail,
    toolRuns: [
      {
        type: 'RAG',
        status: 'success',
        latencyMs: Date.now() - started,
        inputSummary: summarize(args.question),
        outputSummary: summarize(evidence.context),
      },
    ],
  }
}

export async function runSqlBranch(args: {
  question: string
  userId: string
  integrationId?: string
  /**
   * Every active integration name in the org, so the answer can name what it did NOT include.
   *
   * MEASURED IN UAT: "Bandingkan jumlah pengiriman dengan jumlah pesanan" was answered entirely from Logistics and
   * reported "Jumlah pesanan (total) | 8" while Sales held TWELVE orders — 8 is the shipment count relabelled. A
   * prompt rule forbidding one-sided comparisons could not help, because the model did not know a second source
   * existed. Passing the names through is what makes that rule actionable.
   */
  integrationNames?: string[]
  systemPromptPrefix?: string
  memoryContext?: string
  chatHistory?: ChatHistoryEntry[]
  /**
   * The API-key scope's allowed integrations, or `null`/absent for every source.
   *
   * WITHOUT THIS the axis was computed and DROPPED: the route resolved `effectiveScope.integrationIds` and
   * passed only `documentIds` onward, so a key restricted to one database could be routed to another one
   * whenever the question's keywords scored against a different schema. The document axis was enforced while
   * this one was not, which is the same "stored, validated, displayed, enforces nothing" shape the tool-family
   * axis had before it was fixed.
   */
  integrationIds?: string[] | null
  /** The API-key scope's documents, for the second chance below (`null`/absent = every document). */
  documentIds?: string[] | null
  /** The user chose this database: its answer is never second-guessed by the documents. */
  userPinnedIntegration?: boolean
  relevanceJudge?: RelevanceJudge
}): Promise<CompletionResult> {
  const started = Date.now()
  const outcome = await runSqlPipeline(args)

  // The documents' second chance, decided by the same function as the streaming transport (sql-pipeline.ts).
  const viaDocuments = async (rows: ReadonlyArray<Record<string, unknown>> | null, sqlError?: string): Promise<CompletionResult | null> => {
    const reason = await documentsShouldAnswerInstead({ ...args, rows })
    if (!reason) return null
    const ragArgs = {
      question: args.question,
      systemPromptPrefix: args.systemPromptPrefix,
      memoryContext: args.memoryContext,
      chatHistory: args.chatHistory,
      documentIds: args.documentIds,
    }
    // The documents take over only when their evidence SUPPORTS an answer. Checking for citations was not enough:
    // retrieval nearly always returns some chunk, so a database answer the relevance judge wrongly rejected was
    // replaced by "not found in the documents" — MEASURED (agentic eval 2026-10-05): "Which warehouse stores the
    // product ordered the most in the ERP Demo database?" judged irrelevant 2 of 2 times, then answered from an
    // IT-security policy. Unsupported evidence keeps the database's answer.
    const evidence = await gatherRagEvidence(ragArgs)
    if (evidence.kind !== 'ready' || !evidence.supported) return null
    const rag = await runRagBranch({ ...ragArgs, evidence })
    return {
      ...rag,
      toolRuns: [
        {
          type: 'SQL',
          status: sqlError ? 'error' : 'success',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          outputSummary: `not used: ${reason}`,
          ...(sqlError ? { errorMessage: sqlError.slice(0, 500) } : {}),
        },
        ...rag.toolRuns,
      ],
    }
  }

  if (outcome.kind === 'ambiguous') return ambiguousDataSourceResult('SQL', args.question, outcome.candidates, started)
  if (outcome.kind === 'unavailable') return unavailableDataSourceResult('SQL', args.question, started)
  if (outcome.kind === 'rate_limited') {
    return {
      answer: 'Rate limit exceeded for SQL queries. Please try again in a minute.',
      citations: [],
      chartData: null,
      integrationId: outcome.integration.id,
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
  if (outcome.kind === 'forbidden') {
    return {
      answer: forbiddenSourceMessage(outcome.integration.name),
      citations: [],
      chartData: null,
      integrationId: outcome.integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'blocked',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: 'Access denied for this role.',
        },
      ],
    }
  }
  if (outcome.kind === 'failed') {
    const fallback = await viaDocuments(null, outcome.lastError)
    if (fallback) return fallback
    return {
      answer: `Sorry, the database query failed after ${SQL_REPAIR_ATTEMPTS + 1} attempts.\n\nLast error: ${sanitizeSqlError(outcome.lastError)}\n\nSuggestion: try a more specific question, or check whether the queried table columns are available in this integration.`,
      citations: [],
      chartData: null,
      integrationId: outcome.integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'error',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: outcome.lastError,
        },
      ],
    }
  }

  const { integration, result, finalSql, sqlExplanation } = outcome
  const fallback = await viaDocuments(result.rows)
  if (fallback) return fallback
  // `integrationNames` comes from `loadDbData`, which the router already ran — an explicit `integrationId` must
  // perform no candidate listing here (pinned by tool-branches.test.ts).
  const crossSourceNote = buildCrossSourceNote(integration.name, args.integrationNames)
  const answer = await generateAnswer({
    question: args.question,
    // The measured population travels WITH the rows inside the untrusted wrapper: it is model-generated text about
    // the data and must not acquire system authority.
    context:
      (sqlExplanation ? `QUERY SCOPE (what the SQL measured): ${sqlExplanation}\n\n` : '') +
      wrapUntrusted('CONTEXT (DATABASE ROWS):', JSON.stringify(result.rows, null, 2)),
    source: 'SQL',
    systemPromptPrefix: crossSourceNote + (outcome.systemPromptPrefix ?? ''),
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
        outputSummary: summarize(finalSql),
      },
    ],
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
    // A defined order: the endpoint listing used to depend on whatever order the rows came back in.
    orderBy: { createdAt: 'asc' },
    include: {
      endpoints: {
        where: { isEnabled: true },
        orderBy: [{ method: 'asc' }, { path: 'asc' }],
        // generateRestCall shows the 40 most RELEVANT endpoints (source-relevance.ts). Capping here at 40 per
        // connector, by path, decided relevance by alphabet before the ranking ever ran. 200 bounds the payload.
        take: 200,
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
    // Translated phrasings let an Indonesian question rank an English endpoint description.
    phrasings: [args.question, ...(intentNs.expandQuery?.(args.question) ?? [])],
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
    // Say WHY when the reason is diagnosable, and keep the vague text only for genuinely unknown
    // failures. The blocked-host case is not "check the connection" — the endpoint is unreachable BY
    // POLICY, so an admin following that advice would debug the network, the firewall and the
    // credentials while the actual fix is one environment variable.
    //
    // MEASURED: a REST connector pointing at an internal API returned
    // "Endpoint points to a blocked internal host." into ToolRun.errorMessage (visible in the
    // Security view) while the chat said "Check the connection and whitelisted endpoints." The
    // correct instruction is `LLM_ALLOWED_HOSTS`, which is the documented self-hosted opt-in.
    const blockedHost = /blocked internal host/i.test(result.error)
    const answer = blockedHost
      ? 'This API endpoint is on a host that ryasai blocks by default (internal/loopback addresses are refused to prevent SSRF). ' +
        'An admin can allow it by adding the hostname to LLM_ALLOWED_HOSTS, then retrying.'
      : 'Sorry, the REST API request failed to execute. Check the connection and whitelisted endpoints.'
    return {
      answer,
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
      organizationId: requireOrgContext(),
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
    context: wrapUntrusted('CONTEXT (REST API RESPONSE):', result.bodyText),
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
  const hasBody = args.method !== 'GET' && args.method !== 'HEAD' && args.plan.body !== null
  let headers: Record<string, string> = hasBody ? { 'Content-Type': 'application/json' } : {}
  // A function, so the summary logged on failure shows whatever headers existed when it failed.
  const requestSummary = () => JSON.stringify({
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
    // Inside the `try`: building auth can FAIL (an OAuth2 token endpoint that is down, rate-limited or answers
    // non-JSON). It used to run before the `try`, so that failure was THROWN past this function's
    // `{ ok: false }` contract and never logged — MEASURED, 80 of 100 concurrent OAuth2 calls threw.
    headers = { ...(await buildAuthHeaders(args.connector.authType, authConfig)), ...headers }
    // `guardedFetch` re-checks every redirect hop: with the default `redirect: 'follow'` a permitted API answering
    // `302 -> http://127.0.0.1/...` was followed and the internal response returned (measured).
    const response = await guardedFetch(url, {
      method: args.method,
      headers,
      body: hasBody ? JSON.stringify(args.plan.body) : undefined,
      signal: AbortSignal.timeout(args.connector.timeoutMs),
    })
    // Bounded: only 8,000 characters are kept, and a 300 MB response was read whole first (measured +304 MB RSS).
    const bodyText = (await readTextBounded(response, REST_RESPONSE_READ_BYTES)).slice(0, 8000)
    if (response.status === 401 && args.connector.authType.trim().toUpperCase() === 'OAUTH2') {
      // The cached token was rejected (revoked, rotated): the next call fetches a fresh one.
      restConnectorsNs.invalidateOAuthToken?.(authConfig)
    }
    const latencyMs = Date.now() - started
    await db.restApiRequestLog.create({
      data: {
        organizationId: requireOrgContext(),
        connectorId: args.connector.id,
        endpointId: args.endpointId,
        statusCode: response.status,
        latencyMs,
        requestSummary: requestSummary(),
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
        organizationId: requireOrgContext(),
        connectorId: args.connector.id,
        endpointId: args.endpointId,
        latencyMs,
        requestSummary: requestSummary(),
        errorMessage: error,
      },
    })
    return { ok: false, error, latencyMs }
  }
}
