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
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { RAG_ANSWER_TOP_K, settleRetrieval, type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { getPromptSettings } from '@/lib/prompt-settings'
import { buildSourceGuidance } from '@/lib/source-guidance'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import {
  buildAuthHeaders,
  buildEndpointUrl,
  matchEndpoint,
  sanitizeHeaders,
} from '@/lib/rest-api-connectors'
import { selectRelevantPlugins } from '@/lib/plugin-selector'
import { executePlugin } from '@/lib/plugin-registry'
import { runSqlPipeline, buildCrossSourceNote } from '@/lib/pipelines/sql-pipeline'
import { getLastLlmUsage } from '@/lib/llm-client'
import type { Citation } from '@/lib/types'
import {
  buildChartDataFromRows,
  buildDocumentCitation,
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
}): Promise<CompletionResult> {
  const started = Date.now()
  let retrieval: Awaited<ReturnType<typeof retrieveWithReflection>>
  try {
    const request = { query: args.question, documentIds: args.documentIds, topK: RAG_ANSWER_TOP_K }
    retrieval = await settleRetrieval(args.speculativeRetrieval, request, () => retrieveWithReflection(request))
  } catch (e) {
    /*
     * RAG is best-effort — if the knowledge backend is down, degrade to plain chat instead of failing the
     * whole turn. The degradation is RECORDED rather than silent: `degradedFrom` names the route that was
     * attempted, so the tool run reads as "answered from chat because retrieval failed" instead of as a
     * plain chat turn. A user asking a policy question during a sidecar outage otherwise gets a
     * confident-sounding answer with no citation and no way to tell why.
     */
    log.warn('RAG retrieval failed; answering from chat', {
      error: e instanceof Error ? e.message : String(e),
    })
    return runChatBranch(args, {
      degradedFrom: 'RAG',
      degradedReason: e instanceof Error ? e.message : String(e),
    })
  }
  const topChunks = retrieval.chunks
  if (topChunks.length === 0 && !retrieval.graphContext) {
    // Distinct from the error above: retrieval RAN and found nothing. Not degraded — an empty corpus is a
    // legitimate chat answer, and labelling it degraded would cry wolf on every small install.
    return runChatBranch(args)
  }

  const chunkContext = topChunks
    .map(
      (item) =>
        `[Source: ${item.documentName}, chunk #${item.chunkIndex}, score ${item.score}]\n${item.content}`,
    )
    .join('\n\n---\n\n')
  // ponytail: document text is UNTRUSTED — a customer can upload anything. Frame
  // it as data so a document cannot pose as an instruction (see evidence-boundary.ts
  // for scope: the SQL path was already defended; this closes the TEXT path).
  const context = retrieval.graphContext
    ? `${wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)}\n\n${wrapUntrusted('CONTEXT (KNOWLEDGE GRAPH):', retrieval.graphContext)}`
    : wrapUntrusted('CONTEXT (DOCUMENTS):', chunkContext)
  // ponytail: if reflection says evidence is insufficient after multi-turn retrieval,
  // note it in the context so the LLM doesn't hallucinate beyond the evidence.
  /*
   * THE NOTE MUST NOT TURN A RETRIEVAL MISS INTO A CLAIM OF ABSENCE.
   *
   * MEASURED IN UAT, on two separate topics: asked "Bagaimana prosedur mengembalikan uang ke pelanggan yang
   * komplain?", the answer asserted "## Tidak ada prosedur pengembalian uang (refund) dalam sumber yang tersedia"
   * and enumerated specific sub-details as NOT FOUND — while `02-sop-layanan-pelanggan.md` chunk#2 contains the
   * refund procedure verbatim (7 hari kerja, 30 hari kalender, biaya 2%, minimal Rp25.000). The same chunk WAS found
   * by other phrasings of the same question, so the document was reachable and the retrieval simply missed.
   *
   * The old wording said "if the evidence doesn't contain the answer, say so" — which instructs the model to report
   * the ABSENCE OF A POLICY when the truth is ABSENCE FROM ITS OWN SEARCH. Those are different claims and only one
   * of them is safe: a knowledge officer acting on "there is no refund procedure" would tell a customer so.
   *
   * The distinction is now explicit, and the model is told to report the LIMIT OF ITS SEARCH rather than a fact about
   * the documents. It still refuses to invent an answer — the point is to name the uncertainty honestly.
   */
  const reflectionNote = !retrieval.reflection.sufficient && retrieval.retrievalPasses >= 2
    ? `\n\n[Note: The retrieved evidence may not fully address the question. Answer based only on the evidence above.` +
      ` If the answer is not in the evidence, say that YOUR SEARCH did not find it — phrase it as "saya tidak` +
      ` menemukan ini dalam dokumen yang terambil" — and do NOT claim the document or policy does not exist,` +
      ` because the search may simply have missed it. Never state that a procedure or figure is absent from the` +
      ` documents; state only what you did not find.]`
    : ''
  // Source guidance block (per-doc + org ragContextPrompt). Empty prompts
  // inject nothing. Fetch per-doc contextPrompts for the distinct contributing
  // documents in score order (dedupe by first-seen so a doc with 2 chunks
  // doesn't appear twice). See docs/superpowers/specs/2026-08-26-editable-context-prompts-design.md.
  const distinctDocIds: string[] = []
  for (const c of topChunks) {
    if (c.documentId && !distinctDocIds.includes(c.documentId)) distinctDocIds.push(c.documentId)
  }
  let sourceGuidance = ''
  if (distinctDocIds.length > 0) {
    const docs = await db.document.findMany({
      where: { id: { in: distinctDocIds } },
      select: { id: true, name: true, contextPrompt: true },
    })
    // Re-order by retrieval-score (first-seen) so truncation prefers the
    // highest-scoring evidence — buildSourceGuidance keeps caller-supplied order.
    const byId = new Map(docs.map((d) => [d.id, d]))
    const docPrompts = distinctDocIds
      .map((id) => byId.get(id))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .filter((d) => d.contextPrompt && d.contextPrompt.trim())
      .map((d) => ({ name: d.name, content: d.contextPrompt! }))
    const orgPrompt = (await getPromptSettings(db)).ragContextPrompt
    sourceGuidance = buildSourceGuidance(docPrompts, { budget: 2000, orgPrompt })
  }
  // Prepend the guidance block to the evidence (NOT as a system message —
  // keeps systemPromptPrefix semantics untouched per the spec). Empty block
  // (no prompts anywhere) leaves the context exactly as before.
  const contextWithGuidance = sourceGuidance ? `${sourceGuidance}\n\n${context}` : context
  const answer = await generateAnswer({
    question: args.question,
    context: contextWithGuidance + reflectionNote,
    source: 'RAG',
    systemPromptPrefix: args.systemPromptPrefix,
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
  })
  const citations = topChunks.map((item) =>
    buildDocumentCitation({
      documentName: item.documentName,
      chunkIndex: item.chunkIndex,
      // The chunk's OWN text: `content` leads with the document summary, which would be every citation's snippet.
      content: item.ownContent ?? item.content,
      score: item.score,
      // Carried, not re-derived: `retrieveWithReflection` re-stamped this list after the merge, and the
      // answer path concatenates several tool runs' citations, so the array index is not the rank.
      rank: item.rank,
    }),
  )

  await db.auditLog.create({
    data: {
      organizationId: requireOrgContext(),
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
}): Promise<CompletionResult> {
  const started = Date.now()
  const outcome = await runSqlPipeline(args)

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
  if (outcome.kind === 'failed') {
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
    include: {
      endpoints: {
        where: { isEnabled: true },
        orderBy: [{ method: 'asc' }, { path: 'asc' }],
        // The streaming twin's comment applies here too: the prompt caps the listing, so loading more is wasted.
        take: 40,
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
        organizationId: requireOrgContext(),
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
        organizationId: requireOrgContext(),
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
