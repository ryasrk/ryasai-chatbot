/**
 * Routing resolution for the chat router: the context a routing decision is made from (rewritten question, the
 * sources visible to this request, recalled memory), the decision itself (tool-calling selector first, the router
 * prompt as fallback, started speculatively so it overlaps intent analysis), and the gating that turns a decision
 * into one the org can actually serve. `tool-router.ts` owns the transports and the branch dispatch.
 */
import { db } from '@/lib/db'
import { routeQuery, type RouteDecision, type RoutingContext } from '@/lib/ai'
import { LlmProviderError } from '@/lib/llm-client-utils'
import { pickBestIntegration, pickBestIntegrationByKeywords, tokenize } from '@/lib/smart-router'
import { selectToolWithLlm } from '@/lib/tool-selector'
import { rewriteQuery } from '@/lib/intent-pipeline'
import { getPromptSettings } from '@/lib/prompt-settings'
import { recallContext } from '@/lib/cognee'
import { scopedLogger } from '@/lib/logger'
import { stripSessionWrapper, type ChatHistoryEntry } from '@/lib/tool-utils'

const log = scopedLogger('tool-router')

export function chooseAvailableDecision(
  decision: RouteDecision,
  available: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean },
): RouteDecision {
  if (decision === 'CONTEXTUAL_CHAT') return 'CONTEXTUAL_CHAT'
  if (decision === 'PLUGIN') return 'PLUGIN'
  if (decision === 'SQL' && !available.hasIntegrations) return 'CHAT'
  if (decision === 'RAG' && !available.hasDocuments) return 'CHAT'
  if (decision === 'REST' && !available.hasRestApis) return 'CHAT'
  return decision
}

export async function loadIntentPipeline(args: {
  question: string
  chatHistory?: ChatHistoryEntry[]
  sessionId?: string
  /**
   * Declared so the scope survives this boundary.
   *
   * Both call sites pass the full `args` object, so these values ALREADY arrived at runtime while this type named
   * neither — which is why `loadDbData(args)` below could not read them and the routing prompt was built from
   * every source in the org. Same "the spread carries it, the type discards it" shape that hid the streaming
   * `documentIds` gap.
   */
  integrationIds?: string[] | null
  documentIds?: string[] | null
}): Promise<[string, Awaited<ReturnType<typeof loadDbData>>, string]> {
  const hasHistory = args.chatHistory && args.chatHistory.length > 0
  // ponytail: recall + rewrite do semantic/string matching — the session
  // meta-wrapper ("[Session started: ...] [Current time: ...]") must not
  // leak into the recall query or the rewrite prompt.
  const cleanQuestion = stripSessionWrapper(args.question)
  const [effectiveQuestion, dbData, memoryContext] = await Promise.all([
    hasHistory
      ? rewriteQuery({ question: cleanQuestion, chatHistory: args.chatHistory! })
      : Promise.resolve(cleanQuestion),
    loadDbData(args),
    recallContext({ query: cleanQuestion, sessionId: args.sessionId }).catch(() => ''),
  ])
  if (hasHistory) {
    log.debug('Query rewritten', { original: cleanQuestion.slice(0, 50), rewritten: effectiveQuestion.slice(0, 50) })
  }
  return [effectiveQuestion, dbData, memoryContext]
}

/**
 * The DB context the ROUTER prompt is built from.
 *
 * `scope` is threaded in because these counts and name lists go INTO the routing prompt. Unscoped, the model was
 * told about databases the key may not read — so it could choose one and the branch would then refuse (a
 * confusing outcome for the caller), and the org's source NAMES and schema descriptions leaked to a key with no
 * access to them.
 */
export async function loadDbData(scope?: { integrationIds?: string[] | null; documentIds?: string[] | null }) {
  // `null`/absent means unrestricted, so both filters are spread CONDITIONALLY. An empty `in: []` would match
  // nothing and lock out every key created before these axes existed.
  const intScope = scope?.integrationIds && scope.integrationIds.length > 0 ? { id: { in: scope.integrationIds } } : {}
  const docScope = scope?.documentIds && scope.documentIds.length > 0 ? { id: { in: scope.documentIds } } : {}
  const queries = Promise.all([
    db.document.count({ where: { status: 'ready', isEnabled: true, ...docScope } }),
    db.integration.count({ where: { status: 'active', ...intScope } }),
    // ponytail: description included — the LLM first-scan (source-init) writes
    // it when the uploader doesn't. "invoice_sop_2024.pdf — Refund policy for
    // enterprise customers…" routes RAG questions far better than a file name.
    db.document.findMany({
      where: { status: 'ready', isEnabled: true, ...docScope },
      select: { name: true, category: true, description: true },
      take: 20,
    }),
    db.integration.findMany({ where: { status: 'active', ...intScope }, select: { name: true }, take: 20 }),
    db.integrationSchema.findMany({ where: { integration: { status: 'active', ...intScope }, description: { not: null } }, select: { tableName: true, description: true, integration: { select: { name: true } } }, take: 40 }),
    // ponytail: endpoint descriptions too — same first-scan rationale; they
    // tell the router which REST source answers which question.
    db.restApiEndpoint.findMany({
      where: { isEnabled: true, connector: { isActive: true } },
      select: { path: true, description: true, method: true },
      take: 20,
    }),
    getPromptSettings(db),
  ])
  // ponytail: shared 15s ceiling across the whole pre-stream DB batch so a slow
  // DB can't pin a request; the outer handler surfaces a sanitized error.
  return withTimeout(queries, 15_000, 'Preflight DB load')
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Render one schema row for the intent prompt: "integration.table: description".
 *
 * Extracted because this string is built in BOTH the streaming and the
 * non-streaming path, and the two copies had the same unguarded dereference --
 * exactly the shape that let a one-site fix silently leave the other path wrong
 * elsewhere in this file.
 *
 * The guard is not hypothetical. `integration` is a to-one relation, so Prisma
 * types it as non-null and the query filters `integration: { status: 'active' }`
 * to keep it that way. But a raw SQL read, a relaxed filter, or a Prisma version
 * that returns a null to-one join would make `undefined.name` a raw TypeError
 * thrown out of the dispatcher BEFORE any LLM call, with no user-facing error.
 * Dropping the row costs one line of prompt context; crashing costs the request.
 * A row with no name is also worse than useless in the prompt: the model cannot
 * choose a source it cannot name.
 */
export function formatSchemaForIntent(s: {
  tableName: string
  description: string | null
  integration?: { name: string } | null
}): string | null {
  const name = s.integration?.name
  if (!name) return null
  return `${name}.${s.tableName}: ${s.description}`
}

/**
 * Apply formatSchemaForIntent to a batch, keeping order and dropping the rows it
 * declines to render. Returned as a helper so both call sites share one policy.
 */
export function formatSchemasForIntent(
  rows: Array<{ tableName: string; description: string | null; integration?: { name: string } | null }>,
): string[] {
  const out: string[] = []
  for (const row of rows) {
    const rendered = formatSchemaForIntent(row)
    if (rendered) out.push(rendered)
  }
  return out
}

type DbData = Awaited<ReturnType<typeof loadDbData>>

/**
 * What the router prompt is told when the user pinned the DOCUMENT corpus.
 *
 * A constant rather than an inline string because the prompt only needs a NAME, and the picker's own label carries a
 * live count ("Documents (12)") that would change the prompt text whenever a document was added — making two
 * identical questions produce different router prompts.
 */
const DOCUMENTS_PIN_LABEL = 'the document corpus (all knowledge base documents)'

/**
 * Render a document row for the intent prompt: name [category] — description.
 * The description comes from the uploader or the LLM first-scan (source-init);
 * it is what lets the router tell "annual leave SOP" from "Q3 invoice export".
 */
export function formatDocForIntent(d: { name: string; category: string | null; description: string | null }): string {
  const label = d.category ? `${d.name} [${d.category}]` : d.name
  return d.description ? `${label} — ${d.description}` : label
}

/**
 * Turn the router's preference into a decision this org can actually execute, and
 * fall back to CHAT when the tool it picked is disabled in prompt settings.
 *
 * This existed TWICE, verbatim, in the non-streaming and streaming paths. Two
 * copies of one policy means a fix applied to one path silently leaves the other
 * wrong — and the two paths are chosen by a flag the user controls, so the bug
 * would only show up for some users. Kept as one function so they cannot diverge.
 */
export function applyToolGating(
  decision: RouteDecision,
  availability: { hasIntegrations: boolean; hasDocuments: boolean; hasRestApis: boolean },
  tools: { sql: boolean; rag: boolean; restApi: boolean },
): RouteDecision {
  let effective = chooseAvailableDecision(decision, availability)
  // A tool the operator switched OFF must not be reached by the router's
  // preference: picking SQL for an org with no SQL tool would fail the request.
  if (effective === 'SQL' && !tools.sql) effective = 'CHAT'
  if (effective === 'RAG' && !tools.rag) effective = 'CHAT'
  if (effective === 'REST' && !tools.restApi) effective = 'CHAT'
  return effective
}

/** One tool call the model made; a compound question carries several. */
export type RequestedTool = { toolId: string; args: Record<string, unknown> }

export function startSpeculativeRouting(
  args: Parameters<typeof resolveRouting>[0],
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ ok: true; value: Awaited<ReturnType<typeof resolveRouting>> } | { ok: false; error: unknown }> | null {
  if (process.env.SPECULATIVE_ROUTING === 'false') return null
  return resolveRouting(args, effectiveQuestion, dbData, memoryContext).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  )
}

export async function settleRouting(
  speculative: ReturnType<typeof startSpeculativeRouting>,
  fallback: () => ReturnType<typeof resolveRouting>,
): ReturnType<typeof resolveRouting> {
  if (!speculative) return fallback()
  const settled = await speculative
  if (!settled.ok) throw settled.error
  return settled.value
}

export async function resolveRouting(
  args: {
    question: string
    integrationId?: string
  /**
   * The user pinned the DOCUMENT corpus rather than a database. Sets no `integrationId`, so no SQL source is
   * offered; the router is then free to reach RAG, which is the bias the pin is asking for. Both pins are stated in
   * the router prompt and the UI says "prefer" for both — a router instruction is a bias, not a lock.
   */
  pinToDocuments?: boolean
    chatHistory?: ChatHistoryEntry[]
    /**
     * The key's allowed sources. This function DECIDES which database answers a SQL question, so an unscoped
     * selection here reaches the customer: the branch would run generated SQL against a source the key was never
     * granted. The two selectors below are the LAST resort when the model chose no integration, which is exactly
     * when a scoped key is most likely to be sent somewhere it may not read.
     */
    integrationIds?: string[] | null
    /**
     * The key's allowed documents. Needed HERE because this function builds the router prompt's source list, and
     * that list was previously unscoped — see the note on `RoutingContext.documentIds`.
     */
    documentIds?: string[] | null
  },
  effectiveQuestion: string,
  dbData: DbData,
  memoryContext: string,
): Promise<{ decision: RouteDecision; resolvedIntegrationId: string | undefined; extraToolIds?: string[]; requestedTools?: RequestedTool[] }> {
  const [docCount, intCount, , , , restEndpoints] = dbData
  const restEndpointCount = restEndpoints.length
  const hasHistory = args.chatHistory && args.chatHistory.length > 0
  // Required by the pin lookup below, and named for it: `core` guards that EVERY integration query in the chat path
  // carries a scope filter. Spread conditionally, exactly as `loadDbData` does — an empty `in: []` matches nothing
  // and would lock out every key created before this axis existed.
  const intScope = args.integrationIds && args.integrationIds.length > 0 ? { id: { in: args.integrationIds } } : {}
  let decision: RouteDecision
  let resolvedIntegrationId = args.integrationId
  // Arguments the SELECTOR supplied, so the branch does not re-derive them.
  let selectionArgs: Record<string, unknown> = {}
  let selectionReason = ''
  /**
   * The tools the model asked for BEYOND the first one on a compound question.
   *
   * MEASURED: 'berapa hari cuti tahunan karyawan tetap dan berapa gaji pokok direktur utama?' — the model emitted
   * `search_knowledge_base` AND `query_database` on 5 of 16 tries, and the selector acted on `result[0]` only, so one
   * half of the question was dropped without anything reporting it. The existing multi-tool trigger could not catch
   * this: it reads a "MULTI_STEP" marker out of the model's text, and a reply carrying tool calls has no text.
   */
  let extraToolIds: string[] = []
  let requestedTools: RequestedTool[] = []

  // The LLM chooses the tool on BOTH paths (with and without history). History
  // previously routed through `routeQuery` while the first turn used the
  // heuristic scorer, so the SAME question could take different branches
  // depending on whether it was the opening message — a real source of
  // "sometimes it works" reports.
  const sel = await selectToolWithLlm({
    question: effectiveQuestion, context: 'chat', isAdmin: false,
    memoryContext, chatHistory: args.chatHistory,
    // Only meaningful when there IS a database to choose between.
    needsDatabaseListing: intCount > 0,
  })
  if (sel) {
    decision = sel.decision
    selectionArgs = sel.args
    selectionReason = sel.reason
    // Compound questions: the model can ask for SEVERAL sources in one reply. Recorded here and acted on by
    // `runStreamingChatCompletion`, because only that layer can route the follow-up turn.
    extraToolIds = sel.extraTools?.map((t) => t.toolId) ?? []
    if (sel.toolId && sel.extraTools?.length) requestedTools = [{ toolId: sel.toolId, args: sel.args }, ...sel.extraTools]
    // The model named the database it wants. Taking it here is what keeps SQL
    // working at all now that the heuristic router (which used to supply this)
    // is gone.
    if (sel.integrationId) resolvedIntegrationId = sel.integrationId
  } else {
    // No LLM (unconfigured, or the provider failed). `routeQuery` is the
    // documented fail-closed fallback; a hard failure here would take chat down
    // for a deployment whose only problem is a transient provider error.
    const routed = await routeQueryOrDegrade({
      question: effectiveQuestion,
      hasIntegrations: intCount > 0,
      hasDocuments: docCount > 0,
      hasRestApis: restEndpointCount > 0,
      memoryContext,
      chatHistory: args.chatHistory,
      // The scope REACHES THE PROMPT here, not just the branch. MEASURED: this call omitted it, so `routeQuery`
      // listed every table, document and table-description in the install to a key that could not read them.
      // `loadDbData` above already scoped the counts; the prompt needed the same axes.
      integrationIds: args.integrationIds,
      documentIds: args.documentIds,
      /*
       * The user's PIN, so the router can honour the composer's promise ("other sources are excluded for this turn").
       *
       * MEASURED GAP: the pin used to bind only AFTER the route was chosen — as `resolvedIntegrationId`, which the SQL
       * branch reads — so a user who pinned a database could still be answered from documents, and the UI said
       * otherwise. The lookup is one scoped `findFirst` on an id the route already validated, and only when a pin
       * exists, so an auto-routed turn costs nothing.
       */
      // A DOCUMENT pin names the corpus, which has no single row to look up — so the directive is stated directly.
      // Without this the picker's "Documents" option would set no `integrationId` and change nothing at all, which is
      // the "accepted and not applied" shape this file has already been bitten by.
      pinnedSourceName: args.pinToDocuments
        ? DOCUMENTS_PIN_LABEL
        : args.integrationId
        ? ((
            await db.integration.findFirst({
              // BOTH axes, and this is not belt-and-braces: `core` guards that every integration query in the chat
              // path carries a scope filter, and the first version of this lookup omitted it. Without `...intScope`
              // a key restricted away from a database could still have it NAMED back through the pin — the same
              // "told about a source it cannot read" leak the scope work above exists to close. The pin comes from
              // the client, so it is also an input the caller controls.
              where: { id: args.integrationId, status: 'active', ...intScope },
              select: { name: true },
            })
          )?.name ?? undefined)
        : undefined,
    })
    decision = routed.decision
    selectionReason = `fallback router: ${routed.reason}`
  }

  // The SQL tool declares `requiresDataSource: 'integration'` and its schema
  // requires only `question`, so the MODEL cannot choose an integration — that
  // has always been the router's job. Replacing the heuristic router dropped
  // this assignment, and SQL then answered "data source is not yet available"
  // because `resolvedIntegrationId` was undefined. Caught by
  // tool-router.test.ts > "SQL branch: returns answer with query results".
  if (decision === 'SQL' && !resolvedIntegrationId) {
    // ponytail: last-resort integration selection. pickBestIntegration uses
    // embedding API which can be slow/unavailable. Try keyword matching first
    // (fast, no API call), then fall back to pickBestIntegration.
    const tokens = tokenize(effectiveQuestion)
    const kwId = await pickBestIntegrationByKeywords(tokens, args.integrationIds)
    if (kwId) {
      resolvedIntegrationId = kwId
    } else {
      resolvedIntegrationId = (await pickBestIntegration(tokens, undefined, args.integrationIds)) ?? undefined
    }
  }

  return { decision, resolvedIntegrationId, ...(extraToolIds.length > 0 ? { extraToolIds, requestedTools } : {}) }
}

export async function loadContextualContext(decision: RouteDecision, sessionId?: string): Promise<string> {
  if (decision !== 'CONTEXTUAL_CHAT' || !sessionId) return ''
  const recentToolRuns = await db.toolRun.findMany({
    where: { chatMessage: { sessionId }, status: 'success', outputSummary: { not: '' } },
    orderBy: { createdAt: 'desc' }, take: 3,
    select: { type: true, inputSummary: true, outputSummary: true },
  })
  if (recentToolRuns.length === 0) return ''
  return recentToolRuns.map((tr) => `[Prior ${tr.type} result for: ${tr.inputSummary}]\n${tr.outputSummary}`).join('\n\n---\n\n')
}

/**
 * `routeQuery`, degraded instead of thrown when the PROVIDER fails.
 *
 * It is already the fallback for a failed tool selector, so reaching it usually means the provider is struggling — and
 * it had no handler of its own. MEASURED on the 2026-10-05 live eval: three questions failed with HTTP 500 on every
 * run, because the selector's call timed out (swallowed) and this one then timed out too (not caught). A transient
 * provider failure now routes by what the org has: documents first, then a database, else plain chat — the same
 * graceful-degradation order as the rest of the pipeline. An UNCONFIGURED LLM is not a transient failure and still
 * propagates: fail-closed config stays fail-closed.
 */
export async function routeQueryOrDegrade(ctx: RoutingContext): Promise<Awaited<ReturnType<typeof routeQuery>>> {
  try {
    return await routeQuery(ctx)
  } catch (e) {
    if (!(e instanceof LlmProviderError)) throw e
    const decision: RouteDecision = ctx.hasDocuments ? 'RAG' : ctx.hasIntegrations ? 'SQL' : 'CHAT'
    log.warn('router fallback failed at the provider; routing by source availability', { decision, failure: e.failure })
    return { decision, reason: `provider unavailable (${e.failure}); routed by source availability` }
  }
}
