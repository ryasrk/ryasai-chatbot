import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext, requireOrgContext } from '@/lib/prisma-tenant'
import { decryptConfig } from '@/lib/crypto'
import {
  connectorRegistry,
  describeSchema,
} from '@/lib/connectors'
import { validateAndSanitizeLlmSql } from '@/lib/guardrails'
import { SQL_REPAIR_ATTEMPTS, SQL_MAX_LIMIT , SQL_REPAIR_MIN_REMAINING_MS, SQL_REPAIR_TOTAL_BUDGET_MS } from '@/lib/constants'
import {
  generateAnswer,
  generateChat,
  generateRestCall,
  generateSql,
  type RestCallPlan,
  type RestEndpointOption,
} from '@/lib/ai'
import { retrieveWithReflection } from '@/lib/intent-pipeline'
import { RAG_ANSWER_TOP_K, settleRetrieval, type SpeculativeRetrieval } from '@/lib/speculative-retrieval'
import { getPromptSettings, resolveSqlRulesPrompt } from '@/lib/prompt-settings'
import { buildSourceGuidance } from '@/lib/source-guidance'
import { wrapUntrusted } from '@/lib/evidence-boundary'
import { resolveIntegrationForQuestion, tokenize } from '@/lib/smart-router'
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
  ambiguousDataSourceResult,
  safeParseColumns,
  safeParseSampleRow,
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
  // ponytail: when the router did not resolve a specific integration, ASK
  // WHICH ONE — do not take the oldest. `findFirst({ orderBy: { createdAt: 'asc' } })`
  // used to pick the oldest active integration without looking at the question,
  // so a Sales question could be answered from the HR database. That failed
  // SILENTLY: if both schemas happen to share a table name the generated SQL is
  // valid and the answer is simply wrong, with no error and no log
  // (proven at runtime, trial/25-wrong-db-proof.ts). A clarifying question is
  // strictly better than a confident answer from the wrong database.
  // The streaming path had a second, different heuristic — both now go through
  // resolveIntegrationForQuestion so they cannot drift again.
  /*
   * The scope's integration filter, applied to EVERY lookup in this branch.
   *
   * `null` means unrestricted, which is what every key created before this axis existed resolves to — so
   * the filter is spread in CONDITIONALLY rather than sent as `in: []`, which would match nothing and lock
   * out every existing key. That distinction is the whole convention the scope module documents.
   */
  const scopeIds = args.integrationIds && args.integrationIds.length > 0 ? args.integrationIds : null
  const inScope = scopeIds ? { id: { in: scopeIds } } : {}

  let integration = args.integrationId
    ? await db.integration.findFirst({
        // A CLIENT-NAMED integration outside the scope resolves to null here, so the branch reports "no data
        // source" rather than answering from a database the key may not read. Fail-closed on purpose: a refusal
        // reads as a configuration problem an operator can fix, while silently answering from another database
        // reads as a correct answer.
        where: { id: args.integrationId, status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    : null

  let integrationUnverified = false
  if (!integration) {
    const active = await db.integration.findMany({
      // Scoped, or a key restricted to one database would be offered every other one to choose from.
      where: { status: 'active', ...inScope },
      orderBy: { name: 'asc' },
      select: { name: true },
    })
    if (active.length === 1) {
      // Exactly one source configured — nothing to disambiguate.
      integration = await db.integration.findFirst({
        where: { status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
    } else if (active.length > 1) {
      const choice = await resolveIntegrationForQuestion(
        tokenize(args.question),
        args.question,
        'refuse',
        // The key's allowed sources, so the scorer cannot pick one the key may not read.
        args.integrationIds,
      )
      if (!choice) {
        // Refuse rather than guess, and name the candidates so the user can pick.
        return ambiguousDataSourceResult('SQL', args.question, active.map((n) => n.name), started)
      }
      integration = await db.integration.findFirst({
        where: { id: choice.integrationId, status: 'active', ...inScope },
        include: { schemas: { orderBy: { tableName: 'asc' } } },
      })
      integrationUnverified = choice.unverified
    }
  }

  if (!integration || integration.schemas.length === 0) {
    return unavailableDataSourceResult('SQL', args.question, started)
  }
  void integrationUnverified

  // ponytail: integration.contextPrompt is admin-edited business guidance for
  // SQL answer synthesis (spec §Injection → SQL). It's appended to BOTH the
  // SQL-generation step and the final answer step so prose respects it too.
  // Capped at 2000 chars so a runaway prompt can't eat the whole context. We
  // append to the effective prefix only — args.systemPromptPrefix itself is
  // left untouched (callers' contract unchanged).
  const intPrompt = integration.contextPrompt && integration.contextPrompt.trim()
    ? `\n\nContext guidance:\n${integration.contextPrompt!.slice(0, 2000)}`
    : ''
  const effectiveSystemPromptPrefix = args.systemPromptPrefix
    ? `${args.systemPromptPrefix}${intPrompt}`
    : intPrompt
      ? intPrompt.replace(/^\s+/, '')
      : undefined

  /*
   * The org's editable Text-to-SQL rules, resolved ONCE per branch rather than per repair attempt —
   * the retry loop below calls `generateSql` up to three times, and re-reading the row each time
   * would be three identical queries for a value that cannot change mid-request.
   *
   * Resolved here rather than inside `generateSql` so `ai.ts` keeps no DB dependency and the
   * "empty means default" rule lives in exactly one function.
   */
  const sqlRules = resolveSqlRulesPrompt((await getPromptSettings(db)).sqlRulesPrompt)

  const schemaTables = integration.schemas.map((schema) => ({
    tableName: schema.tableName,
    columns: safeParseColumns(schema.columns),
    rowCount: schema.rowCount ?? undefined,
    sampleRow: safeParseSampleRow(schema.sampleRow),
    description: schema.description,
  }))
  const schemaDescription = describeSchema(schemaTables)
  // Free-text columns, for the stale-profile fallback. Derived from the reflected
  // schema rather than hardcoded: they are what the model wrongly filters on when
  // no query hints tell it otherwise.
  const textColumns = [
    ...new Set(
      schemaTables
        .flatMap((t) => t.columns)
        .filter((c) => /char|text|string/i.test(String(c.type)) && !c.primaryKey)
        .map((c) => c.name),
    ),
  ]
  // ponytail: rate-limit BEFORE burning LLM calls — the repair loop can make
  // up to 3 generation calls per turn.
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

  // ponytail: SQL error-correction loop — a failed execution used to be a
  // dead end ("Sorry, the database query failed to execute"). Common failures
  // (wrong column name, type mismatch, dialect quirk, guardrail rejection)
  // are fixable when the error is fed back to generateSql for a retry.
  let lastSqlError = ''
  const attemptedSql: string[] = []
  let executed: Awaited<ReturnType<typeof connector.executeQuery>> | null = null
  let finalSql = ''
  /*
   * THE SQL GENERATOR'S OWN EXPLANATION, which used to be discarded.
   *
   * MEASURED IN UAT: rule 17 tells the SQL generator to NAME THE POPULATION it measured — "based on completed orders",
   * "all statuses included" — because two questions in one session silently used different filters and reported
   * different totals for the same customer (Rp 1.240.000 vs Rp 1.620.000). But only `candidate.sql` was used; the
   * `explanation` field it wrote was dropped, so the answer generator never saw the filter and could not state it.
   *
   * Verified by asking the question after adding rule 17: the answer still said nothing about the population, because
   * the field carrying it never reached the prompt. Threading it through is what makes the rule observable to a user.
   */
  let sqlExplanation = ''

  for (let attempt = 0; attempt <= SQL_REPAIR_ATTEMPTS; attempt++) {
    /*
     * TIME BUDGET BEFORE EVERY RETRY (attempt 0 runs unconditionally: a check before the first attempt
     * would mean a turn that started late answers nothing at all). One attempt is an LLM call plus a query,
     * each ~30s worst case; the loop previously counted only attempts, so attempt 3 could start at t=100s
     * on a turn whose 120s deadline was already gone — the user got a timeout instead of the failure this
     * branch had already diagnosed. Breaking out here hands the turn to the answer with the failure
     * recorded in `lastSqlError`, which is the honest outcome.
     */
    if (attempt > 0 && Date.now() - started + SQL_REPAIR_MIN_REMAINING_MS() > SQL_REPAIR_TOTAL_BUDGET_MS()) {
      log.warn('sql repair loop: not enough budget left for another attempt', {
        elapsedMs: Date.now() - started,
        budgetMs: SQL_REPAIR_TOTAL_BUDGET_MS(),
        attemptsDone: attempt,
      })
      break
    }
    const feedback = attempt > 0
      ? `The previous SQL was:\n${attemptedSql[attemptedSql.length - 1]}\nIt failed with error:\n${lastSqlError}`
      : undefined
    const candidate = await generateSql({
      question: args.question,
      schemaDescription,
      provider: integration.provider,
      memoryContext: args.memoryContext,
      systemPromptPrefix: effectiveSystemPromptPrefix,
      repairFeedback: feedback,
      textColumns,
      // ponytail: admin-authored business context (integration settings) must
      // reach BOTH SQL calls. `ai.ts` renders it into the prompt, and the
      // streaming path has always passed it (stream-preparers.ts) — but nothing
      // on the non-streaming path did, so the exact same question produced a
      // different SQL/answer depending on transport (scheduled runs, the agentic
      // loop and /api/v1 all take this branch). Keep the two in sync.
      businessContext: integration.businessContext,
      // The org's editable rules. `resolveSqlRulesPrompt` already fell back to the built-in default
      // when the field is empty, so this line is unconditional — no branch here means no way for one
      // transport to pass rules and another to forget them.
      sqlRules,
    })
    // Captured BEFORE the guard so a repaired retry replaces it, matching the SQL that finally runs.
    sqlExplanation = typeof candidate.explanation === 'string' ? candidate.explanation.trim() : ''
    const guard = validateAndSanitizeLlmSql(candidate.sql)
    if (!guard.ok) {
      // Guardrail rejection is retryable — the model often just needs to be
      // told the system only allows SELECT. Log it and let the loop retry.
      lastSqlError = guard.reason ?? 'SQL rejected by guardrail'
      attemptedSql.push(candidate.sql)
      await db.auditLog.create({
        data: {
          organizationId: requireOrgContext(),
          userId: args.userId,
          action: 'GUARDRAIL_BLOCK',
          severity: 'critical',
          detail: JSON.stringify({
            integrationId: integration.id,
            naturalQuery: args.question,
            generatedSql: candidate.sql,
            reason: guard.reason,
            detectedNodes: guard.detectedNodes,
            attempt,
          }),
        },
      })
      continue
    }
    const sanitizedSql = guard.sanitized
    try {
      const result = await withSqlConcurrency(integration.id, () =>
        withToolSandbox('sql', () => connector.executeQuery(sanitizedSql)),
      )
      executed = result
      finalSql = sanitizedSql
      break
    } catch (e) {
      lastSqlError = e instanceof Error ? e.message : String(e)
      attemptedSql.push(sanitizedSql)
      await db.queryHistory.create({
        data: {
          organizationId: requireOrgContext(),
          integrationId: integration.id,
          userId: args.userId,
          naturalQuery: args.question,
          generatedSql: sanitizedSql,
          success: false,
          errorMessage: `attempt ${attempt + 1}: ${lastSqlError}`,
        },
      })
      await db.auditLog.create({
        data: {
          organizationId: requireOrgContext(),
          userId: args.userId,
          action: 'SQL_EXECUTE_ERROR',
          severity: 'warning',
          detail: JSON.stringify({ integrationId: integration.id, sql: sanitizedSql, error: lastSqlError, attempt }),
        },
      })
    }
  }

  if (!executed) {
    return {
      answer: `Sorry, the database query failed after ${SQL_REPAIR_ATTEMPTS + 1} attempts.\n\nLast error: ${sanitizeSqlError(lastSqlError)}\n\nSuggestion: try a more specific question, or check whether the queried table columns are available in this integration.`,
      citations: [],
      chartData: null,
      integrationId: integration.id,
      toolRuns: [
        {
          type: 'SQL',
          status: 'error',
          latencyMs: Date.now() - started,
          inputSummary: summarize(args.question),
          errorMessage: lastSqlError,
        },
      ],
    }
  }

  const result = executed
  await db.queryHistory.create({
    data: {
      organizationId: requireOrgContext(),
      integrationId: integration.id,
      userId: args.userId,
      naturalQuery: args.question,
      generatedSql: finalSql,
      rowCount: result.rowCount,
      executionMs: result.executionMs,
      success: true,
    },
  })
  await db.auditLog.create({
    data: {
      organizationId: requireOrgContext(),
      userId: args.userId,
      action: 'SQL_EXECUTE',
      severity: 'info',
      detail: JSON.stringify({
        integrationId: integration.id,
        sql: finalSql,
        rowCount: result.rowCount,
        executionMs: result.executionMs,
        attempts: attemptedSql.length + 1,
      }),
    },
  })

  const truncated = result.rowCount >= SQL_MAX_LIMIT
  /*
   * TELL THE MODEL WHICH OTHER SOURCES EXIST.
   *
   * MEASURED IN UAT: "Bandingkan jumlah pengiriman dengan jumlah pesanan" was answered entirely from Logistics — it
   * reported "Jumlah pesanan (total) | 8" when the Sales database held TWELVE orders, because 8 is the shipment count
   * relabelled. A prompt rule against one-sided comparisons cannot fix that on its own: the model had no way to know a
   * second source existed, so it had nothing to name as missing. Verified that the rule alone was insufficient — the
   * mislabelling survived it.
   *
   * The authoritative list is the org's active integrations. The SQL branch does not otherwise need it, so it is
   * fetched here rather than threaded through every call site: one query, only on the SQL path, only when an answer is
   * about to be generated, and a failure to fetch simply omits the note rather than failing the turn.
   */
  // The list comes from `loadDbData`, which the router ALREADY ran, rather than a second query here. That matters
  // beyond tidiness: `tool-branches.test.ts` pins that an explicit `integrationId` performs NO candidate listing (it
  // is the disambiguation path's job), and a fresh `db.integration.findMany` broke exactly that assertion.
  const otherSources = (args.integrationNames ?? []).filter((n) => n !== integration.name)
  /*
   * TWO RULES, and the second one is the one that was missing.
   *
   * The first covers a question that asks to COMPARE with another source. The second covers a question about
   * "everything" / "the system" / how much data exists — a scope the ONE chosen source cannot satisfy, because the
   * router picked it out of several. MEASURED with three databases connected: "Berapa banyak data yang tersimpan di
   * sistem?" was answered with "total 45 baris data yang tersebar di empat tabel utama" from ONE of them (citation:
   * `ZZ Sales.pelanggan`), while the three databases hold 104 rows across 12 tables. The user asked about the system,
   * got a confident strict subset, and nothing in the answer said the other sources were not consulted. A confident
   * subset presented as the whole is the same class as a fabricated figure: the reader cannot tell them apart.
   */
  const crossSourceNote =
    otherSources.length > 0
      ? `Other connected data sources in this workspace: ${otherSources.join(', ')}. ` +
        `This answer uses ${integration.name} ONLY. Two rules follow, and BOTH apply:\n` +
        `1. If the question asks you to compare or combine this result with something those sources would hold, say ` +
        `plainly that THIS ANSWER COVERS ONLY ${integration.name} and name what was not included. Never present a ` +
        `figure from this source as if it described another one.\n` +
        `2. If the question asks about "all", "every", "the system", "the workspace", or the TOTAL amount of data, ` +
        `then this source CANNOT answer it alone: state that the figure covers only ${integration.name}, name the ` +
        `other sources (${otherSources.join(', ')}) that were NOT included, and offer to run it per source. Never ` +
        `present a count from ${integration.name} as the count for the workspace.` +
        '\n\n'
      : ''
  const answer = await generateAnswer({
    question: args.question,
    /*
     * The measured population travels WITH the rows, in the untrusted wrapper (it is model-generated text about the
     * data, so it must not acquire system authority). Without it the answer cannot say which rows it counted, which is
     * the whole point of rule 17.
     */
    context:
      (sqlExplanation ? `QUERY SCOPE (what the SQL measured): ${sqlExplanation}\n\n` : '') +
      wrapUntrusted('CONTEXT (DATABASE ROWS):', JSON.stringify(result.rows, null, 2)),
    source: 'SQL',
    systemPromptPrefix: crossSourceNote + (effectiveSystemPromptPrefix ?? ''),
    memoryContext: args.memoryContext,
    chatHistory: args.chatHistory,
    rowCount: result.rowCount,
    truncated,
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
