import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { selectRelevantPlugins, type ScoredPlugin } from '@/lib/plugin-selector'
import { getEmbeddingRuntimeConfig, embedTexts, cosineSimilarity } from '@/lib/embeddings'
import {
  STOPWORDS, tokenize, expandWithSynonyms, keywordOverlap, checkAvailability, buildReason,
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
  const mentionedAmbiguous = mentionResult?.ambiguous

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
    } else if (mentionedAmbiguous && mentionedAmbiguous.length > 1) {
      ambiguousIntegrations = mentionedAmbiguous
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
    const glossaryTerms = new Set<string>()
    // Match "TERM = definition" patterns in DOMAIN GLOSSARY
    for (const m of ctxLower.matchAll(/(?:^|\n)[-*]\s+\*{0,2}([a-z][a-z0-9_/ -]{2,30})\*{0,2}\s*=/g)) {
      glossaryTerms.add(m[1].trim())
    }
    // Match "## DOMAIN" section first paragraph for domain keywords
    const domainMatch = ctxLower.match(/## domain\n([\s\S]+?)(\n##|\n\n)/)
    if (domainMatch) {
      for (const word of domainMatch[1].split(/[^a-z0-9]+/)) {
        if (word.length >= 4 && !STOPWORDS.has(word) && !GENERIC_SCHEMA_TOKENS.has(word)) {
          glossaryTerms.add(word)
        }
      }
    }
    let ctxMatches = 0
    for (const term of glossaryTerms) {
      if (term.length >= 4 && lower.includes(term)) ctxMatches++
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

async function pickBestIntegrationWithAmbiguity(
  tokens: string[],
  question: string,
): Promise<{ integrationId?: string; ambiguous?: AmbiguousIntegration[] } | undefined> {
  const integrations = await db.integration.findMany({
    where: { status: 'active' },
    include: { schemas: { select: { tableName: true, columns: true, description: true } } },
  })
  if (integrations.length === 0) return undefined
  if (integrations.length === 1) return { integrationId: integrations[0].id }

  const integTexts = integrations.map((integ) => {
    const parts: string[] = [integ.name]
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
    return { id: integ.id, name: integ.name, score }
  })

  scored.sort((a, b) => b.score - a.score)

  if (scored[0].score === 0) return undefined
  // ponytail: always pick the best — no ambiguity blocking. The previous 0.8x
  // threshold caused "which database?" loops on every multi-DB question.
  return { integrationId: scored[0].id }
}

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
