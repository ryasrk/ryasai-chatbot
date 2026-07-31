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
    selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05 }),
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
      const pickResult = await pickBestIntegrationWithAmbiguity(expandedTokens, args.question)
      integrationId = pickResult?.integrationId
      ambiguousIntegrations = pickResult?.ambiguous
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
    case 'CONTEXTUAL_CHAT': return 0.1
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
    let matches = 0
    for (const token of tokens) {
      if (schemaKeywords.has(token)) { matches++; continue }
      for (const kw of schemaKeywords) {
        if (kw.length >= 4 && (kw.includes(token) || token.includes(kw))) {
          matches++
          break
        }
      }
    }
    return { id: integ.id, name: integ.name, score: matches, keywordCount: schemaKeywords.size }
  })

  scored.sort((a, b) => b.score - a.score)
  if (scored[0].score > 0 && (scored.length === 1 || scored[0].score > scored[1].score * 1.5)) {
    return { integrationId: scored[0].id }
  }
  if (scored[0].score > 0 && scored[1] && scored[1].score >= scored[0].score * 0.8) {
    const topScore = scored[0].score
    const ambiguous = scored
      .filter((s) => s.score >= topScore * 0.8)
      .map((s) => ({ integrationId: s.id, integrationName: s.name, score: s.score }))
    return { ambiguous }
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
        const integEmbs = await embedTexts(config, integTexts)
        semanticScores = integrations.map((_, i) => {
          const emb = integEmbs[i]
          if (!emb || emb.length === 0) return 0
          return cosineSimilarity(queryEmb, emb)
        })
      } catch {
        // embedding API unavailable — fall back to keyword-only
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
    const nameSet = new Set(allNames)
    let matches = 0
    for (const t of tokens) {
      if (nameSet.has(t)) { matches++; continue }
      if (allNames.some((n) => n.includes(t) || t.includes(n))) matches++
    }
    const keywordScore = tokens.length > 0 ? Math.min(matches / tokens.length, 1) : 0
    const semanticScore = semanticScores[idx] ?? 0
    const score = keywordScore * 0.4 + semanticScore * 0.6
    return { id: integ.id, name: integ.name, score }
  })

  scored.sort((a, b) => b.score - a.score)

  if (scored[0].score === 0) return undefined
  if (scored.length === 1 || scored[0].score > scored[1].score * 1.5) {
    return { integrationId: scored[0].id }
  }

  const topScore = scored[0].score
  const secondScore = scored[1].score
  if (secondScore >= topScore * 0.8) {
    const ambiguous = scored
      .filter((s) => s.score >= topScore * 0.8)
      .map((s) => ({ integrationId: s.id, integrationName: s.name, score: s.score }))
    return { ambiguous }
  }

  return { integrationId: scored[0].id }
}

export async function pickBestIntegration(
  tokens: string[],
  question?: string,
): Promise<string | undefined> {
  const result = await pickBestIntegrationWithAmbiguity(tokens, question ?? '')
  return result?.integrationId
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
