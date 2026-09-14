import { STOPWORDS } from '@/lib/rag'
import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { selectRelevantPlugins, type ScoredPlugin } from '@/lib/plugin-selector'
import { getEmbeddingRuntimeConfig, embedTexts, cosineSimilarity } from '@/lib/embeddings'
import {
 tokenize, expandWithSynonyms, keywordOverlap, checkAvailability, buildReason,
  computeSemanticScore, loadSchemaMetadata, loadEndpointMetadata, loadDocumentMetadata,
  loadPerformanceMetrics, loadSimilarityBoost, getQuestionEmbedding,
  invalidateSourceEmbeddingCache,
  WEIGHTS, NEUTRAL_PERF,
  type ToolScore, type AmbiguousIntegration, type SmartRouteResult, type PerfMetrics,
} from './smart-router-helpers'

export { tokenize, invalidateSourceEmbeddingCache, keywordOverlap }
export type { SmartRouteResult, AmbiguousIntegration, ToolScore, PerfMetrics }

/**
 * Generic column names that appear in virtually every database schema (both
 * the app's own internal tables and external ones). These never help
 * discriminate which integration a question is about — they just add noise
 * to keyword matching. Removed from schema keyword sets before scoring.
 */
const GENERIC_SCHEMA_TOKENS = new Set([
  'id', 'uuid', 'guid', 'uid',
  'name', 'title', 'description', 'label', 'code',
  'status', 'state', 'type', 'category', 'active', 'isactive', 'enabled',
  'created', 'createdat', 'createddate', 'updated', 'updatedat', 'updateddate',
  'deleted', 'deletedat', 'deleteddate', 'modified', 'modifiedat',
  'organization', 'organizationid', 'orgid',
  'userid', 'user', 'users', 'username', 'email',
  'version', 'versionid', 'revision',
  'timestamp', 'time', 'date', 'datetime',
  'foreignkey', 'primarykey', 'primary',
  'sessionid', 'session', 'token', 'tokens',
  'hash', 'password', 'passwordhash', 'role', 'roleid',
  'key', 'value', 'data', 'content', 'text', 'json', 'metadata',
  'count', 'total', 'sum', 'avg', 'min', 'max',
  'index', 'seq', 'sequence', 'order', 'sort',
  // App-internal table/column names that pollute matching
  'started', 'startedat', 'timeout', 'timeoutms', 'tokencount',
  'requestsummary', 'chatsession', 'chatmessage', 'llmusagelog',
  'apikey', 'apirequestlog', 'auditlog', 'queryhistory',
  'integration', 'integrationschema', 'restapiconnector', 'restapiendpoint',
  'restapirequestlog', 'plugin', 'toolrun', 'scheduledrun', 'scheduledrunlog',
  'vectorstoreconfig', 'document', 'documentchunk', 'documentversion',
  'kgrelation', 'mcpserver', 'appconfig', 'agentrun',
])

/**
 * Extract the domain glossary terms from a businessContext, lowercased.
 *
 * Exported so the Unicode behaviour can be tested against the REAL scan rather
 * than a regex re-typed inside the test. An earlier version of that test
 * duplicated the pattern, which meant it passed even with the production bug
 * restored — a guard verifying the ritual instead of the bug, which is exactly
 * the failure mode this repository has hit before.
 *
 * ponytail: Unicode-aware, NOT `[a-z0-9]`. This scan kept the Latin-only
 * character class that was removed from `tokenize` for the same reason: a
 * non-Latin businessContext (a Chinese or Arabic install's own glossary)
 * produced ZERO terms, so the DOMAIN path could never fire and a non-Latin user
 * got no source attribution from domain context — the feature silently did
 * nothing for them while working normally in English.
 */
/**
 * True when a token is in GENERIC_SCHEMA_TOKENS purely as a SQL keyword, and is therefore
 * still usable as DOMAIN vocabulary.
 *
 * GENERIC_SCHEMA_TOKENS mixes two different kinds of entry: column-name noise, and SQL
 * keywords. A domain glossary that explicitly names one of the keywords -- 'order' is both
 * `ORDER BY` and a purchase order -- was having that term silently dropped, which disabled
 * the glossary fast path for every question phrased with the business word.
 */
const SQL_KEYWORDS_THAT_ARE_ALSO_DOMAIN_WORDS = new Set([
  'order', 'group', 'select', 'where', 'table', 'index', 'key', 'value', 'level',
  'user', 'users', 'session', 'token', 'tokens', 'file', 'files',
])

function isSqlKeywordOnly(word: string): boolean {
  if (!GENERIC_SCHEMA_TOKENS.has(word)) return false
  return !SQL_KEYWORDS_THAT_ARE_ALSO_DOMAIN_WORDS.has(word)
}

export function extractDomainGlossaryTerms(ctxLower: string): Set<string> {
  const glossaryTerms = new Set<string>()
  // Match "TERM = definition" patterns in DOMAIN GLOSSARY
  for (const m of ctxLower.matchAll(/(?:^|\n)[-*]\s+\*{0,2}([\p{L}][\p{L}\p{N}_/ -]{2,30})\*{0,2}\s*=/gu)) {
    glossaryTerms.add(m[1].trim())
  }
  // Match the "## Domain" section up to the NEXT heading, not up to the first blank line.
  // Stopping at `\n\n` truncated the keyword list: the Sales context lists its domain
  // words across two wrapped lines, so the section's first paragraph ended mid-list.
  // Measured on the real context, the old pattern yielded 17 terms and DROPPED 'order';
  // 'Ada berapa order yang dibatalkan?' therefore matched 0 glossary terms, the fast path
  // never fired, and the turn refused with 'I could not tell which data source' THREE
  // times out of three. Narrowed to `(?:\n##|$)` so the whole section is read.
  const domainMatch = ctxLower.match(/## domain\n([\s\S]+?)(?:\n##|$)/)
  if (domainMatch) {
    for (const word of domainMatch[1].split(/[^\p{L}\p{N}]+/u)) {
      // GENERIC_SCHEMA_TOKENS exists to drop NOISE (column names like id/status/created),
      // and it also lists SQL KEYWORDS including 'order'. But 'order' is the ordinary
      // business word for a purchase order, and the Sales context declares it in its own
      // ## Domain keyword list. Filtering it made 'Ada berapa order yang dibatalkan?'
      // match zero glossary terms, so the turn refused instead of answering. A term the
      // domain context explicitly names is domain vocabulary by definition and outranks
      // the generic list; STOPWORDS still applies, since those are language noise.
      if (word.length >= 2 && !STOPWORDS.has(word) && !isSqlKeywordOnly(word)) {
        glossaryTerms.add(word)
      }
    }
  }
  return glossaryTerms
}

export async function smartRoute(args: {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
  hasRestApis: boolean
  memoryContext?: string
  preferredIntegrationId?: string
}): Promise<SmartRouteResult> {
  const tokens = tokenize(args.question)
  const expandedTokens = expandWithSynonyms(tokens)

  const [schemaMeta, endpointMeta, docMeta, perfData, similarity, pluginRelevant] = await Promise.all([
    loadSchemaMetadata(),
    loadEndpointMetadata(),
    loadDocumentMetadata(),
    loadPerformanceMetrics(),
    loadSimilarityBoost(tokens),
    selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05, context: 'chat' }),
  ])

  const mentionResult = await detectMentionedIntegration(args.question, expandedTokens)
  const mentionedIntegration = mentionResult?.integrationId
  // NOTE: detectMentionedIntegration can no longer return `ambiguous` — every one
  // of its 9 returns yields an id or undefined, because the behaviour that blocked
  // on 2+ similar scores was deliberately replaced by "pick the top scorer" (see
  // the comment at its tail). The `mentionedAmbiguous` branch that consumed it was
  // therefore unreachable, and removing it changes nothing: measured, disabling it
  // failed 0 tests. The read-side contract lives in smart-router.test.ts
  // ("ambiguousIntegrations is populated only from the semantic picker").

  const tools: RouteDecision[] = ['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN']
  const scorePromises = tools.map(async (tool): Promise<ToolScore> => {
    const schemaScore = await scoreSchemaMatch(tool, expandedTokens, schemaMeta, endpointMeta, docMeta, pluginRelevant, args.question)
    const perf = perfData[tool] ?? NEUTRAL_PERF
    const perfScore = perf.successRate
    const latencyScore = 1 - Math.min(perf.avgLatencyMs / 5000, 1)
    const availability = checkAvailability(tool, args.hasIntegrations, args.hasDocuments, args.hasRestApis)
    // Circuit breaker with half-open recovery: if tripped but last failure
    // was >5min ago, allow a probe attempt at reduced score (50%).
    const tripped = perf.total >= 10 && perf.recentFailRate > 0.7
    const cooldownMs = Number(process.env.CIRCUIT_BREAKER_COOLDOWN_MS ?? 300_000)
    const inCooldown = tripped && perf.lastFailureAt && (Date.now() - perf.lastFailureAt.getTime() < cooldownMs)
    const circuitBreakerTripped = inCooldown === true
    const isProbe = tripped && !inCooldown
    const simBoost = similarity[tool] ?? 0

    const rawScore = schemaScore * WEIGHTS.schema +
      perfScore * WEIGHTS.performance +
      latencyScore * WEIGHTS.latency +
      availability * WEIGHTS.availability +
      simBoost * WEIGHTS.similarity
    const finalScore = inCooldown || availability === 0
      ? 0
      : isProbe
        ? rawScore * 0.5
        : rawScore

    return {
      tool, schemaScore, perfScore, latencyScore, availability,
      similarityBoost: simBoost, circuitBreakerTripped, finalScore,
      reason: buildReason(tool, schemaScore, perf, circuitBreakerTripped, simBoost),
    }
  })
  const scores: ToolScore[] = await Promise.all(scorePromises)

  const sorted = [...scores].sort((a, b) => b.finalScore - a.finalScore)
  const best = sorted[0]
  const second = sorted[1]

  let decision = best.tool
  let llmUsed = false
  let reason = best.reason

  if (best.finalScore - second.finalScore < 0.1 && best.finalScore > 0) {
    // ponytail: skip LLM tiebreaker when the best tool has a strong schema
    // match (schemaScore > 0.3 means real keyword overlap with DB tables/docs).
    // The LLM router prompt doesn't know domain-specific terms, so it would
    // override SQL→CHAT on every data question because CHAT's neutral score
    // is within 0.1 of SQL's score.
    if (best.schemaScore > 0.3) {
      reason = `${best.tool}: schema match strong (${(best.schemaScore * 100).toFixed(0)}%), skipping LLM tiebreaker`
    } else {
      const llmResult = await routeQuery({
        question: args.question,
        hasIntegrations: args.hasIntegrations,
        hasDocuments: args.hasDocuments,
        hasRestApis: args.hasRestApis,
        memoryContext: args.memoryContext,
      })
      llmUsed = true
      decision = llmResult.decision
      reason = `LLM tiebreaker: ${llmResult.reason} (scores: ${best.tool}=${best.finalScore.toFixed(2)}, ${second.tool}=${second.finalScore.toFixed(2)})`
    }
  }

  if (best.finalScore === 0 && !llmUsed) {
    decision = 'CHAT'
    reason = 'All tools unavailable or circuit breaker tripped — falling back to CHAT'
  }

  let integrationId: string | undefined
  let ambiguousIntegrations: AmbiguousIntegration[] | undefined
  if (decision === 'SQL' && args.hasIntegrations) {
    if (mentionedIntegration) {
      integrationId = mentionedIntegration
    } else if (args.preferredIntegrationId) {
      integrationId = args.preferredIntegrationId
    } else {
      // ponytail: try keyword-only first (fast, no embedding API), then embedding
      const kwResult = await pickBestIntegrationByKeywords(expandedTokens)
      if (kwResult) {
        integrationId = kwResult
      } else {
        const pickResult = await pickBestIntegrationWithAmbiguity(expandedTokens, args.question)
        integrationId = pickResult?.integrationId
        ambiguousIntegrations = pickResult?.ambiguous
      }
    }
  }

  return { decision, reason, scores, integrationId, llmUsed, ambiguousIntegrations }
}

async function scoreSchemaMatch(
  tool: RouteDecision,
  tokens: string[],
  schemaMeta: string[],
  endpointMeta: string[],
  docMeta: string[],
  pluginRelevant: ScoredPlugin[] = [],
  question: string,
): Promise<number> {
  if (tokens.length === 0) return 0
  const keywordScore = keywordScoreForTool(tool, tokens, schemaMeta, endpointMeta, docMeta, pluginRelevant)
  const semanticScore = await computeSemanticScore(question, tool)
  return keywordScore * 0.4 + semanticScore * 0.6
}

function keywordScoreForTool(
  tool: RouteDecision,
  tokens: string[],
  schemaMeta: string[],
  endpointMeta: string[],
  docMeta: string[],
  pluginRelevant: ScoredPlugin[] = [],
): number {
  switch (tool) {
    case 'SQL': return keywordOverlap(tokens, schemaMeta)
    case 'REST': return keywordOverlap(tokens, endpointMeta)
    case 'RAG': return keywordOverlap(tokens, docMeta)
    case 'PLUGIN': return pluginRelevant.length > 0 ? pluginRelevant[0].score : 0
    case 'CHAT':
    case 'CONTEXTUAL_CHAT': return 0 // ponytail: CHAT has no schema match — neutral baseline only. A non-zero value caused false LLM tiebreakers on every SQL/RAG question.
    default: return 0
  }
}

async function detectMentionedIntegration(
  question: string,
  tokens: string[],
): Promise<{ integrationId?: string; ambiguous?: AmbiguousIntegration[] } | undefined> {
  const integrations = await db.integration.findMany({
    where: { status: 'active' },
    include: { schemas: { select: { tableName: true, columns: true } } },
  })
  if (integrations.length === 0) return undefined
  if (integrations.length === 1) return undefined

  const lower = question.toLowerCase()

  // ponytail: check business context domain terms first — when 10 DBs are
  // connected, schema keyword matching alone can't tell them apart if they
  // share generic table names. But each DB's businessContext contains domain
  // terms ("mining safety", "payroll", "inventory", "CRM") that are far more
  // discriminative. If the question matches 2+ domain terms in one
  // integration's businessContext, prefer that integration immediately.
  for (const integ of integrations) {
    if (!integ.businessContext) continue
    const ctxLower = integ.businessContext.toLowerCase()
    const glossaryTerms = extractDomainGlossaryTerms(ctxLower)
    let ctxMatches = 0
    for (const term of glossaryTerms) {
      // 2 chars, not 4: the old floor dropped every CJK glossary term, because a
      // two-character Chinese word is a complete concept. `tokenize` already
      // uses 2 via `isMeaningfulToken`, so this now matches the rest of the
      // pipeline instead of being the one place with a higher bar.
      if (term.length >= 2 && lower.includes(term)) ctxMatches++
    }
    if (ctxMatches >= 2) {
      return { integrationId: integ.id }
    }
  }

  for (const integ of integrations) {
    const nameLower = integ.name.toLowerCase()
    if (lower.includes(nameLower)) return { integrationId: integ.id }
    const significantWords = nameLower.split(/\s+/).filter(
      (w) => w.length >= 4 && !STOPWORDS.has(w) && !['db', 'database', 'data', 'store', 'media'].includes(w),
    )
    if (significantWords.length >= 2 && significantWords.every((w) => lower.includes(w))) {
      return { integrationId: integ.id }
    }
  }

  const scored = integrations.map((integ) => {
    const schemaKeywords = new Set<string>()
    for (const s of integ.schemas) {
      schemaKeywords.add(s.tableName.toLowerCase())
      try {
        const cols = JSON.parse(s.columns) as Array<{ name?: string }>
        for (const c of cols) {
          if (c.name) schemaKeywords.add(c.name.toLowerCase())
        }
      } catch { /* skip */ }
    }
    // Filter out generic app-internal column names that pollute keyword matching
    // (id, status, createdat, etc.) — these appear in every integration's schema
    // and never help discriminate between domain databases.
    for (const generic of GENERIC_SCHEMA_TOKENS) schemaKeywords.delete(generic)
    // Also filter stopwords — common words like "many", "total", "system"
    // match column names in app-internal tables and cause false positives.
    for (const sw of STOPWORDS) schemaKeywords.delete(sw)

    let matches = 0
    const matchedTokens: string[] = []
    for (const token of tokens) {
      if (schemaKeywords.has(token)) { matches++; matchedTokens.push(token); continue }
      for (const kw of schemaKeywords) {
        if (kw.length >= 4 && (kw.includes(token) || token.includes(kw))) {
          matches++
          matchedTokens.push(`${token}→${kw}`)
          break
        }
      }
    }
    return { id: integ.id, name: integ.name, score: matches, keywordCount: schemaKeywords.size }
  })

  scored.sort((a, b) => b.score - a.score)
  // ponytail: pick the top-scoring integration. Only return undefined if NO
  // integration has any keyword overlap at all. Previous code blocked with a
  // clarification when two integrations had similar scores — that caused the
  // "which database?" loop on every question when 2+ DBs were active.
  if (scored[0].score > 0) {
    return { integrationId: scored[0].id }
  }
  return undefined
}

export async function pickBestIntegrationWithAmbiguity(
  tokens: string[],
  question: string,
): Promise<{ integrationId?: string; ambiguous?: AmbiguousIntegration[] } | undefined> {
  const integrations = await db.integration.findMany({
    where: { status: 'active' },
    // `businessContext` is REQUIRED here because it carries the domain glossary. It was
    // not loaded, so the glossary path existed in `detectMentionedIntegration` but not
    // in THIS picker -- and this picker is the one the SQL branch calls.
    select: {
      id: true,
      name: true,
      businessContext: true,
      schemas: { select: { tableName: true, columns: true, description: true } },
    },
  })
  if (integrations.length === 0) return undefined
  if (integrations.length === 1) return { integrationId: integrations[0].id }

  // DOMAIN GLOSSARY, checked BEFORE any scoring.
  //
  // Why this is a separate step and not part of the weighted score: a glossary hit is
  // categorical evidence, not a similarity. Measured on "berapa jumlah pelanggan di
  // database penjualan?" with four databases connected, keyword scoring TIES at 0.250
  // because `demo_pelanggan` merely CONTAINS "pelanggan", and the tie was then broken
  // by a 0.6-weight embedding score -- so the question was answered from the demo
  // database and returned 5 instead of 8. The glossary separates them cleanly (Sales
  // matched 2 domain terms, every other integration 0), and mixing it into the same
  // weights would let 0.6 of semantic noise cancel it out again.
  for (const integ of integrations) {
    if (!integ.businessContext) continue
    const terms = extractDomainGlossaryTerms(integ.businessContext.toLowerCase())
    let ctxMatches = 0
    for (const term of terms) {
      if (term.length >= 2 && question.toLowerCase().includes(term)) ctxMatches++
    }
    if (ctxMatches >= 2) return { integrationId: integ.id }
  }

  const integTexts = integrations.map((integ) => {
    // `businessContext` is prepended only when present. Pushing it unconditionally
    // makes the joined text start with ". " for integrations that have no context,
    // changing their vector for no reason.
    const parts: string[] = []
    if (integ.businessContext) parts.push(integ.businessContext)
    parts.push(integ.name)
    for (const s of integ.schemas) {
      parts.push(`table ${s.tableName}: ${s.description ?? ''}`)
    }
    return parts.join('. ')
  })

  let semanticScores: number[] = integrations.map(() => 0)
  const config = await getEmbeddingRuntimeConfig()
  if (config && question.trim().length > 0) {
    const queryEmb = await getQuestionEmbedding(question, config)
    if (queryEmb.length > 0) {
      try {
        // ponytail: race embeddings against a 5s timeout — if the API is slow
        // or the integration list is large (30+ tables), fall back to keyword-
        // only matching rather than blocking the chat pipeline for 30s.
        const embPromise = embedTexts(config, integTexts)
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('embedding timeout')), 5_000),
        )
        const integEmbs = await Promise.race([embPromise, timeoutPromise])
        semanticScores = integrations.map((_, i) => {
          const emb = integEmbs[i]
          if (!emb || emb.length === 0) return 0
          return cosineSimilarity(queryEmb, emb)
        })
      } catch {
        // embedding API unavailable or timed out — fall back to keyword-only
      }
    }
  }

  const scored = integrations.map((integ, idx) => {
    const allNames: string[] = []
    for (const s of integ.schemas) {
      allNames.push(s.tableName.toLowerCase())
      try {
        const cols = JSON.parse(s.columns) as Array<{ name?: string }>
        for (const c of cols) {
          if (c.name) allNames.push(c.name.toLowerCase())
        }
      } catch { /* skip */ }
    }
    // Filter generic tokens same as detectMentionedIntegration
    const nameSet = new Set(
      allNames.filter((n) => !GENERIC_SCHEMA_TOKENS.has(n)),
    )
    let matches = 0
    for (const t of tokens) {
      if (nameSet.has(t)) { matches++; continue }
      // Only match on non-generic tokens to avoid false positives
      for (const n of nameSet) {
        if (n.length >= 4 && (n.includes(t) || t.includes(n))) matches++
      }
    }
    const keywordScore = tokens.length > 0 ? Math.min(matches / tokens.length, 1) : 0
    const semanticScore = semanticScores[idx] ?? 0
    const score = keywordScore * 0.4 + semanticScore * 0.6
    return { id: integ.id, name: integ.name, score, keywordScore, semanticScore }
  })

  scored.sort((a, b) => b.score - a.score)

  // ponytail: `scored[0].score === 0` was effectively NEVER true once embeddings
  // are configured — a semantic score is a cosine similarity, which is positive
  // even for a question that names nothing ("tolong lihat"). Measured on a live
  // install: 200/200 off-topic questions were attributed to some database instead
  // of being refused, so the refusal path existed but never fired.
  //
  // Refusing now requires positive EVIDENCE of a match:
  //   - a real keyword overlap (a question token appears in the schema/name), or
  //   - a clearly better semantic candidate (a margin over the runner-up).
  // Off-topic questions satisfy neither, so they are refused instead of guessed.
  const top = scored[0]
  const runnerUp = scored[1]
  const hasKeywordEvidence = top.keywordScore > 0
  const semanticMargin = runnerUp ? top.semanticScore - runnerUp.semanticScore : top.semanticScore
  const hasSemanticEvidence = top.semanticScore >= SEMANTIC_MATCH_FLOOR && semanticMargin >= SEMANTIC_MATCH_MARGIN
  if (!hasKeywordEvidence && !hasSemanticEvidence) return undefined
  // ponytail: always pick the best — no ambiguity blocking. The previous 0.8x
  // threshold caused "which database?" loops on every multi-DB question.
  return { integrationId: scored[0].id }
}

// A cosine similarity is never meaningfully zero, so "score > 0" cannot express
// "this candidate matched". Require both a floor (the question really is about
// this source) and a margin over the runner-up (it is not a coin flip) before
// treating an embedding score as evidence. Values chosen from measured runs
// (trial/51, trial/60): in-corpus questions scored 0.3-0.5 against the right
// source, off-topic ones sat near 0.1-0.2 with a margin under 0.05.
const SEMANTIC_MATCH_FLOOR = 0.25
const SEMANTIC_MATCH_MARGIN = 0.02

/**
 * Resolve which database integration a question should run against, with an
 * explicit decision about what to do when NOTHING matches.
 *
 * INCIDENT (2026-09): three divergent implementations existed —
 *   A. tool-branches.ts        `orderBy: { createdAt: 'asc' }` — always returned
 *                              the OLDEST integration, never looked at the
 *                              question at all, never refused.
 *   B. stream-preparers.ts     an inline ~45-line keyword scorer, ending in
 *                              `bestMatch ?? allIntegrations[0]` — also fell
 *                              back to the oldest when every score was 0.
 *   C. this file's ambiguity picker — the only one that refused on a zero score.
 * The same question could therefore be answered from a DIFFERENT database
 * depending on transport, and A/B would silently query the wrong one: no error,
 * no log, just a confident answer built from the wrong schema. Proven at runtime
 * (trial/25-wrong-db-proof.ts): with an HR database created before a Sales
 * database, "berapa total penjualan?" ran against HR.
 *
 * This is now the single implementation. Callers decide `onNoMatch`:
 *   - 'refuse'  (default) — return null and let the caller ask which source the
 *                user means. Correct for chat: a wrong-but-plausible answer is
 *                worse than a clarifying question.
 *   - 'oldest'  — legacy behaviour, for scheduled/automated runs where there is
 *                nobody to ask and failing the run is worse than guessing.
 * Never widen 'oldest' to an interactive path.
 */
export type IntegrationChoice = {
  integrationId: string
  /** true when the pick came from the legacy 'oldest' fallback, not a match. */
  unverified: boolean
}

async function resolveIntegrationForQuestion(
  tokens: string[],
  question: string,
  onNoMatch: 'refuse' | 'oldest' = 'refuse',
): Promise<IntegrationChoice | null> {
  const picked = await pickBestIntegrationWithAmbiguity(tokens, question)
  if (picked?.integrationId) {
    return { integrationId: picked.integrationId, unverified: false }
  }

  // No integration scored above zero. Options: refuse (interactive) or take the
  // oldest (unattended), and if we take the oldest we MARK it — callers can then
  // tell the user, or log it, rather than presenting a guess as a match.
  const all = await db.integration.findMany({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  if (all.length === 0) return null
  if (onNoMatch === 'refuse') return null
  return { integrationId: all[0].id, unverified: true }
}

export { resolveIntegrationForQuestion }

export async function pickBestIntegration(
  tokens: string[],
  question?: string,
): Promise<string | undefined> {
  const result = await pickBestIntegrationWithAmbiguity(tokens, question ?? '')
  return result?.integrationId
}

/**
 * Fast keyword-only integration picker — no embedding API call.
 * Used as a first-choice fallback when the embedding-based picker is
 * unavailable or too slow. Filters generic schema tokens (id, name, etc.)
 * to avoid false matches on app-internal tables.
 */
export async function pickBestIntegrationByKeywords(tokens: string[]): Promise<string | undefined> {
  const integrations = await db.integration.findMany({
    where: { status: 'active' },
    include: { schemas: { select: { tableName: true, columns: true } } },
  })
  if (integrations.length === 0) return undefined
  if (integrations.length === 1) return integrations[0].id

  const scored = integrations.map((integ) => {
    const allNames: string[] = []
    for (const s of integ.schemas) {
      allNames.push(s.tableName.toLowerCase())
      try {
        const cols = JSON.parse(s.columns) as Array<{ name?: string }>
        for (const c of cols) {
          if (c.name) allNames.push(c.name.toLowerCase())
        }
      } catch { /* skip */ }
    }
    const nameSet = new Set(allNames.filter((n) => !GENERIC_SCHEMA_TOKENS.has(n)))
    let matches = 0
    for (const t of tokens) {
      if (nameSet.has(t)) { matches++; continue }
      for (const n of nameSet) {
        if (n.length >= 4 && (n.includes(t) || t.includes(n))) { matches++; break }
      }
    }
    return { id: integ.id, name: integ.name, score: matches }
  })

  scored.sort((a, b) => b.score - a.score)
  if (scored[0].score > 0) return scored[0].id
  return undefined
}

export async function getRoutingScores(): Promise<{
  scores: Array<{
    tool: string
    schemaScore: number
    perfScore: number
    latencyScore: number
    availability: number
    similarityBoost: number
    circuitBreakerTripped: boolean
    finalScore: number
    reason: string
    perfMetrics: PerfMetrics
  }>
  schemaKeywords: string[]
  endpointKeywords: string[]
  documentKeywords: string[]
}> {
  const [schemaMeta, endpointMeta, docMeta, perfData] = await Promise.all([
    loadSchemaMetadata(),
    loadEndpointMetadata(),
    loadDocumentMetadata(),
    loadPerformanceMetrics(),
  ])

  const tools: RouteDecision[] = ['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN']
  const scores = await Promise.all(tools.map(async (tool) => {
    const schemaScore = await scoreSchemaMatch(tool, [], schemaMeta, endpointMeta, docMeta, [], '')
    const perf = perfData[tool] ?? NEUTRAL_PERF
    const latencyScore = 1 - Math.min(perf.avgLatencyMs / 5000, 1)
    const availability = 1
    const circuitBreakerTripped = perf.total >= 10 && perf.recentFailRate > 0.7
    const finalScore = circuitBreakerTripped
      ? 0
      : schemaScore * WEIGHTS.schema +
        perf.successRate * WEIGHTS.performance +
        latencyScore * WEIGHTS.latency +
        availability * WEIGHTS.availability

    return {
      tool, schemaScore, perfScore: perf.successRate, latencyScore, availability,
      similarityBoost: 0, circuitBreakerTripped, finalScore,
      reason: buildReason(tool, schemaScore, perf, circuitBreakerTripped, 0),
      perfMetrics: perf,
    }
  }))

  return {
    scores,
    schemaKeywords: schemaMeta.slice(0, 50),
    endpointKeywords: endpointMeta.slice(0, 50),
    documentKeywords: docMeta.slice(0, 50),
  }
}
