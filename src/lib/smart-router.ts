/**
 * Smart Router — self-adjusting query routing.
 *
 * Replaces the single LLM `routeQuery` call with a hybrid scoring system:
 *
 * 1. Schema scoring — keyword overlap between question and actual DB tables/columns,
 *    REST endpoint paths/descriptions, and document names/categories.
 * 2. Performance scoring — success rate from recent ToolRun history per tool type.
 * 3. Latency scoring — faster tools get higher scores.
 * 4. Circuit breaker — auto-disables tools with >70% failure rate in last 10 runs.
 * 5. Similarity boost — learns from past successful routings of similar questions.
 * 6. LLM tiebreaker — when top 2 scores are within 0.1, uses LLM to break the tie.
 * 7. Integration selection — for SQL, picks the integration whose schema best matches.
 *
 * Self-adjustment is implicit: every routing decision reads recent ToolRun history,
 * so scores adapt automatically as performance changes. No manual configuration.
 */
import { db } from '@/lib/db'
import { routeQuery, type RouteDecision } from '@/lib/ai'
import { selectRelevantPlugins, type ScoredPlugin } from '@/lib/plugin-selector'

const STOPWORDS = new Set([
  'yang', 'dan', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'ini', 'itu',
  'atau', 'adalah', 'akan', 'tidak', 'juga', 'saya', 'kita', 'ada', 'bisa',
  'apa', 'bagaimana', 'siapa', 'kapan', 'dimana', 'kenapa', 'tolong', 'show',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may',
  'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why',
  'how', 'all', 'each', 'every', 'some', 'any', 'no', 'not', 'as', 'of', 'at',
  'by', 'for', 'with', 'about', 'against', 'between', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in', 'out',
  'on', 'off', 'over', 'under', 'again', 'further', 'then', 'once', 'please',
  'tell', 'give', 'me', 'my', 'our', 'your', 'their', 'his', 'her', 'its',
])

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

interface ToolScore {
  tool: RouteDecision
  schemaScore: number
  perfScore: number
  latencyScore: number
  availability: number
  similarityBoost: number
  circuitBreakerTripped: boolean
  finalScore: number
  reason: string
}

export interface SmartRouteResult {
  decision: RouteDecision
  reason: string
  scores: ToolScore[]
  integrationId?: string
  llmUsed: boolean
}

interface PerfMetrics {
  successRate: number
  avgLatencyMs: number
  total: number
  recentFailRate: number
}

const NEUTRAL_PERF: PerfMetrics = {
  successRate: 0.5,
  avgLatencyMs: 2500,
  total: 0,
  recentFailRate: 0,
}

const WEIGHTS = {
  schema: 0.35,
  performance: 0.25,
  latency: 0.15,
  availability: 0.10,
  similarity: 0.15,
}

export async function smartRoute(args: {
  question: string
  hasIntegrations: boolean
  hasDocuments: boolean
  hasRestApis: boolean
  memoryContext?: string
}): Promise<SmartRouteResult> {
  const tokens = tokenize(args.question)

  const [schemaMeta, endpointMeta, docMeta, perfData, similarity, pluginRelevant] = await Promise.all([
    loadSchemaMetadata(),
    loadEndpointMetadata(),
    loadDocumentMetadata(),
    loadPerformanceMetrics(),
    loadSimilarityBoost(tokens),
    selectRelevantPlugins({ query: args.question, topK: 1, minScore: 0.05 }),
  ])

  const tools: RouteDecision[] = ['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN']
  const scores: ToolScore[] = tools.map((tool) => {
    const schemaScore = scoreSchemaMatch(tool, tokens, schemaMeta, endpointMeta, docMeta, pluginRelevant)
    const perf = perfData[tool] ?? NEUTRAL_PERF
    const perfScore = perf.successRate
    const latencyScore = 1 - Math.min(perf.avgLatencyMs / 5000, 1)
    const availability = checkAvailability(tool, args.hasIntegrations, args.hasDocuments, args.hasRestApis)
    const circuitBreakerTripped = perf.total >= 10 && perf.recentFailRate > 0.7
    const simBoost = similarity[tool] ?? 0

    const finalScore = circuitBreakerTripped || availability === 0
      ? 0
      : schemaScore * WEIGHTS.schema +
        perfScore * WEIGHTS.performance +
        latencyScore * WEIGHTS.latency +
        availability * WEIGHTS.availability +
        simBoost * WEIGHTS.similarity

    return {
      tool,
      schemaScore,
      perfScore,
      latencyScore,
      availability,
      similarityBoost: simBoost,
      circuitBreakerTripped,
      finalScore,
      reason: buildReason(tool, schemaScore, perf, circuitBreakerTripped, simBoost),
    }
  })

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
  if (decision === 'SQL' && args.hasIntegrations) {
    integrationId = await pickBestIntegration(tokens)
  }

  return { decision, reason, scores, integrationId, llmUsed }
}

function scoreSchemaMatch(
  tool: RouteDecision,
  tokens: string[],
  schemaMeta: string[],
  endpointMeta: string[],
  docMeta: string[],
  pluginRelevant: ScoredPlugin[] = [],
): number {
  if (tokens.length === 0) return 0

  switch (tool) {
    case 'SQL':
      return keywordOverlap(tokens, schemaMeta)
    case 'REST':
      return keywordOverlap(tokens, endpointMeta)
    case 'RAG':
      return keywordOverlap(tokens, docMeta)
    case 'PLUGIN':
      return pluginRelevant.length > 0 ? pluginRelevant[0].score : 0
    case 'CHAT':
    case 'CONTEXTUAL_CHAT':
      return 0.1
    default:
      return 0
  }
}

export function keywordOverlap(tokens: string[], metadata: string[]): number {
  if (metadata.length === 0 || tokens.length === 0) return 0
  const metaSet = new Set(metadata)
  let matches = 0
  for (const token of tokens) {
    if (metaSet.has(token)) {
      matches++
      continue
    }
    for (const meta of metadata) {
      if (meta.includes(token) || token.includes(meta)) {
        matches++
        break
      }
    }
  }
  return Math.min(matches / tokens.length, 1)
}

function checkAvailability(
  tool: RouteDecision,
  hasIntegrations: boolean,
  hasDocuments: boolean,
  hasRestApis: boolean,
): number {
  switch (tool) {
    case 'SQL':
      return hasIntegrations ? 1 : 0
    case 'RAG':
      return hasDocuments ? 1 : 0
    case 'REST':
      return hasRestApis ? 1 : 0
    case 'PLUGIN':
      return 1
    case 'CHAT':
    case 'CONTEXTUAL_CHAT':
      return 1
    default:
      return 0
  }
}

function buildReason(
  tool: RouteDecision,
  schemaScore: number,
  perf: PerfMetrics,
  circuitBreaker: boolean,
  simBoost: number,
): string {
  if (circuitBreaker) return `${tool} circuit breaker tripped (fail rate ${(perf.recentFailRate * 100).toFixed(0)}%)`
  const parts: string[] = []
  if (schemaScore > 0.3) parts.push(`schema match ${(schemaScore * 100).toFixed(0)}%`)
  if (perf.total > 0) parts.push(`success ${perf.successRate * 100 | 0}% (${perf.total} runs)`)
  if (simBoost > 0.2) parts.push(`similar past query boost ${(simBoost * 100).toFixed(0)}%`)
  if (parts.length === 0) return `${tool} — no strong signal, neutral`
  return `${tool}: ${parts.join(', ')}`
}

async function loadSchemaMetadata(): Promise<string[]> {
  const schemas = await db.integrationSchema.findMany({
    where: { integration: { status: 'active' } },
    select: { tableName: true, columns: true },
  })
  const keywords: string[] = []
  for (const s of schemas) {
    keywords.push(s.tableName.toLowerCase())
    try {
      const cols = JSON.parse(s.columns) as Array<{ name?: string; type?: string }>
      for (const c of cols) {
        if (c.name) keywords.push(c.name.toLowerCase())
      }
    } catch { /* skip malformed */ }
  }
  return keywords
}

async function loadEndpointMetadata(): Promise<string[]> {
  const endpoints = await db.restApiEndpoint.findMany({
    where: { isEnabled: true, connector: { isActive: true } },
    select: { path: true, description: true },
  })
  const keywords: string[] = []
  for (const e of endpoints) {
    for (const segment of e.path.split('/')) {
      const seg = segment.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (seg.length >= 3) keywords.push(seg)
    }
    if (e.description) {
      for (const word of e.description.toLowerCase().split(/\s+/)) {
        const w = word.replace(/[^a-z0-9]/g, '')
        if (w.length >= 3 && !STOPWORDS.has(w)) keywords.push(w)
      }
    }
  }
  return keywords
}

async function loadDocumentMetadata(): Promise<string[]> {
  const docs = await db.document.findMany({
    where: { status: 'ready', isEnabled: true },
    select: { name: true, category: true, description: true },
  })
  const keywords: string[] = []
  for (const d of docs) {
    for (const word of d.name.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3) keywords.push(word)
    }
    if (d.category) keywords.push(d.category.toLowerCase())
    if (d.description) {
      for (const word of d.description.toLowerCase().split(/\s+/)) {
        const w = word.replace(/[^a-z0-9]/g, '')
        if (w.length >= 3 && !STOPWORDS.has(w)) keywords.push(w)
      }
    }
  }
  return keywords
}

async function loadPerformanceMetrics(): Promise<Record<string, PerfMetrics>> {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const types = ['SQL', 'RAG', 'REST_API', 'CHAT', 'PLUGIN']
  const result: Record<string, PerfMetrics> = {}

  for (const type of types) {
    const [recent, last10] = await Promise.all([
      db.toolRun.findMany({
        where: { type, createdAt: { gte: dayAgo } },
        select: { status: true, latencyMs: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      db.toolRun.findMany({
        where: { type },
        select: { status: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ])

    if (recent.length === 0) {
      result[type === 'REST_API' ? 'REST' : type] = NEUTRAL_PERF
      continue
    }

    const successCount = recent.filter((r) => r.status === 'success').length
    const latencies = recent.filter((r) => r.status === 'success' && r.latencyMs != null).map((r) => r.latencyMs!)
    const failCount10 = last10.filter((r) => r.status === 'error' || r.status === 'blocked').length

    result[type === 'REST_API' ? 'REST' : type] = {
      successRate: successCount / recent.length,
      avgLatencyMs: latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 2500,
      total: recent.length,
      recentFailRate: failCount10 / 10,
    }
  }

  return result
}

async function loadSimilarityBoost(
  tokens: string[],
): Promise<Record<string, number>> {
  if (tokens.length === 0) return {}
  const recentRuns = await db.toolRun.findMany({
    where: { status: 'success' },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { type: true, inputSummary: true },
  })

  const boosts: Record<string, number> = { SQL: 0, RAG: 0, REST: 0, CHAT: 0, PLUGIN: 0 }
  for (const run of recentRuns) {
    const cleanSummary = (run.inputSummary ?? '').replace(/^\[Session started:[^\]]*\]\s*\[Current time:[^\]]*\]\s*/i, '').trim()
    const runTokens = tokenize(cleanSummary)
    if (runTokens.length === 0) continue
    const overlap = tokens.filter((t) => runTokens.includes(t)).length
    if (overlap === 0) continue
    const similarity = overlap / Math.max(tokens.length, runTokens.length)
    const key = run.type === 'REST_API' ? 'REST' : run.type
    if (boosts[key] !== undefined) {
      boosts[key] = Math.max(boosts[key], similarity)
    }
  }
  return boosts
}

export async function pickBestIntegration(
  tokens: string[],
): Promise<string | undefined> {
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
    const nameSet = new Set(allNames)
    let matches = 0
    for (const t of tokens) {
      if (nameSet.has(t)) { matches++; continue }
      if (allNames.some((n) => n.includes(t) || t.includes(n))) matches++
    }
    return { id: integ.id, name: integ.name, score: matches }
  })

  scored.sort((a, b) => b.score - a.score)
  if (scored[0].score === 0) {
    return integrations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0].id
  }
  return scored[0].id
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
  const scores = tools.map((tool) => {
    const schemaScore = scoreSchemaMatch(tool, [], schemaMeta, endpointMeta, docMeta)
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
      tool,
      schemaScore,
      perfScore: perf.successRate,
      latencyScore,
      availability,
      similarityBoost: 0,
      circuitBreakerTripped,
      finalScore,
      reason: buildReason(tool, schemaScore, perf, circuitBreakerTripped, 0),
      perfMetrics: perf,
    }
  })

  return {
    scores,
    schemaKeywords: schemaMeta.slice(0, 50),
    endpointKeywords: endpointMeta.slice(0, 50),
    documentKeywords: docMeta.slice(0, 50),
  }
}
