import { db } from '@/lib/db'
import { type RouteDecision } from '@/lib/ai'
import { getEmbeddingRuntimeConfig, embedTexts, cosineSimilarity, type EmbeddingRuntimeConfig } from '@/lib/embeddings'

export const STOPWORDS = new Set([
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

const SYNONYMS: Record<string, string[]> = {
  negara: ['country'], negara2: ['country'], kota: ['city'],
  populasi: ['population'], penduduk: ['population'], bahasa: ['language'],
  benua: ['continent'], wilayah: ['region'], jumlah: ['count', 'total', 'sum'],
  rata: ['avg', 'average'], tertinggi: ['max', 'highest', 'top'],
  terendah: ['min', 'lowest', 'bottom'], terbesar: ['max', 'largest', 'biggest'],
  terkecil: ['min', 'smallest'], terbanyak: ['max', 'most'],
  terdikit: ['min', 'fewest', 'least'], pelanggan: ['customer'],
  produk: ['product'], pesanan: ['order'], gudang: ['warehouse', 'inventory'],
  gaji: ['salary'], karyawan: ['employee'], faktur: ['invoice'],
  pendapatan: ['revenue', 'income'], film: ['film', 'movie'],
  artis: ['artist'], album: ['album'], lagu: ['track', 'song'], genre: ['genre'],
}

export function expandWithSynonyms(tokens: string[]): string[] {
  const expanded = [...tokens]
  for (const token of tokens) {
    const syns = SYNONYMS[token]
    if (syns) expanded.push(...syns)
  }
  return expanded
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

export interface ToolScore {
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

export interface AmbiguousIntegration {
  integrationId: string
  integrationName: string
  score: number
}

export interface SmartRouteResult {
  decision: RouteDecision
  reason: string
  scores: ToolScore[]
  integrationId?: string
  llmUsed: boolean
  ambiguousIntegrations?: AmbiguousIntegration[]
}

export interface PerfMetrics {
  successRate: number
  avgLatencyMs: number
  total: number
  recentFailRate: number
}

export const NEUTRAL_PERF: PerfMetrics = {
  successRate: 0.5,
  avgLatencyMs: 2500,
  total: 0,
  recentFailRate: 0,
}

export const WEIGHTS = {
  schema: 0.35,
  performance: 0.25,
  latency: 0.15,
  availability: 0.10,
  similarity: 0.15,
}

let sourceEmbeddingCache: {
  sql: { texts: string[]; embeddings: number[][] }
  rag: { texts: string[]; embeddings: number[][] }
  rest: { texts: string[]; embeddings: number[][] }
  timestamp: number
} | null = null

const SOURCE_EMBEDDING_CACHE_TTL = 5 * 60 * 1000

let questionEmbeddingCache: { question: string; embedding: number[]; timestamp: number } | null = null
const QUESTION_EMBEDDING_TTL = 10 * 1000

export function invalidateSourceEmbeddingCache() {
  sourceEmbeddingCache = null
  questionEmbeddingCache = null
}

export function safeParseColumns(raw: string): Array<{ name: string }> {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((c: Record<string, unknown>) => ({ name: String(c?.name ?? '') }))
  } catch { return [] }
}

async function loadSourceTextsForEmbedding(): Promise<{
  sql: string[]
  rag: string[]
  rest: string[]
}> {
  const [schemas, docs, endpoints] = await Promise.all([
    db.integrationSchema.findMany({
      where: { integration: { status: 'active' } },
      select: { tableName: true, description: true, columns: true, integration: { select: { name: true } } },
    }),
    db.document.findMany({ where: { status: 'ready', isEnabled: true }, select: { name: true, category: true, description: true } }),
    db.restApiEndpoint.findMany({ where: { isEnabled: true, connector: { isActive: true } }, select: { path: true, description: true } }),
  ])

  const sql = schemas.map((s) => {
    const cols = safeParseColumns(s.columns).map((c) => c.name).join(', ')
    return `${s.integration.name} table ${s.tableName}: ${s.description ?? ''}. Columns: ${cols}`
  })
  const rag = docs.map((d) => `${d.name} [${d.category}]: ${d.description ?? ''}`)
  const rest = endpoints.map((e) => `${e.path}: ${e.description ?? ''}`)

  return { sql, rag, rest }
}

export async function getSourceEmbeddings(): Promise<{
  sql: { texts: string[]; embeddings: number[][] }
  rag: { texts: string[]; embeddings: number[][] }
  rest: { texts: string[]; embeddings: number[][] }
} | null> {
  const now = Date.now()
  if (sourceEmbeddingCache && now - sourceEmbeddingCache.timestamp < SOURCE_EMBEDDING_CACHE_TTL) {
    return sourceEmbeddingCache
  }

  const config = await getEmbeddingRuntimeConfig()
  if (!config) return null

  const texts = await loadSourceTextsForEmbedding()

  let sqlEmb: number[][] = []
  let ragEmb: number[][] = []
  let restEmb: number[][] = []
  try {
    [sqlEmb, ragEmb, restEmb] = await Promise.all([
      texts.sql.length > 0 ? embedTexts(config, texts.sql) : Promise.resolve([]),
      texts.rag.length > 0 ? embedTexts(config, texts.rag) : Promise.resolve([]),
      texts.rest.length > 0 ? embedTexts(config, texts.rest) : Promise.resolve([]),
    ])
  } catch {
    return null
  }

  const result = {
    sql: { texts: texts.sql, embeddings: sqlEmb },
    rag: { texts: texts.rag, embeddings: ragEmb },
    rest: { texts: texts.rest, embeddings: restEmb },
    timestamp: now,
  }
  sourceEmbeddingCache = result
  return result
}

export async function getQuestionEmbedding(question: string, config: EmbeddingRuntimeConfig): Promise<number[]> {
  const now = Date.now()
  if (questionEmbeddingCache && questionEmbeddingCache.question === question && now - questionEmbeddingCache.timestamp < QUESTION_EMBEDDING_TTL) {
    return questionEmbeddingCache.embedding
  }
  try {
    const emb = await embedTexts(config, [question])
    const embedding = emb[0] ?? []
    questionEmbeddingCache = { question, embedding, timestamp: now }
    return embedding
  } catch {
    return []
  }
}

export async function computeSemanticScore(
  question: string,
  tool: RouteDecision,
): Promise<number> {
  const sources = await getSourceEmbeddings()
  if (!sources) return 0

  const config = await getEmbeddingRuntimeConfig()
  if (!config) return 0

  const sourceData = tool === 'SQL' ? sources.sql
    : tool === 'RAG' ? sources.rag
    : tool === 'REST' ? sources.rest
    : null
  if (!sourceData || sourceData.embeddings.length === 0) return 0

  const queryEmb = await getQuestionEmbedding(question, config)
  if (queryEmb.length === 0) return 0

  let maxSim = 0
  for (const emb of sourceData.embeddings) {
    const sim = cosineSimilarity(queryEmb, emb)
    if (sim > maxSim) maxSim = sim
  }
  return maxSim
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

export function checkAvailability(
  tool: RouteDecision,
  hasIntegrations: boolean,
  hasDocuments: boolean,
  hasRestApis: boolean,
): number {
  switch (tool) {
    case 'SQL': return hasIntegrations ? 1 : 0
    case 'RAG': return hasDocuments ? 1 : 0
    case 'REST': return hasRestApis ? 1 : 0
    case 'PLUGIN': return 1
    case 'CHAT':
    case 'CONTEXTUAL_CHAT': return 1
    default: return 0
  }
}

export function buildReason(
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

export async function loadSchemaMetadata(): Promise<string[]> {
  const schemas = await db.integrationSchema.findMany({
    where: { integration: { status: 'active' } },
    select: { tableName: true, columns: true, integration: { select: { name: true, provider: true } } },
  })
  const keywords: string[] = []
  for (const s of schemas) {
    keywords.push(s.tableName.toLowerCase())
    if (s.integration?.name) {
      for (const word of s.integration.name.toLowerCase().split(/\s+/)) {
        if (word.length >= 3) keywords.push(word)
      }
    }
    try {
      const cols = JSON.parse(s.columns) as Array<{ name?: string; type?: string }>
      for (const c of cols) {
        if (c.name) keywords.push(c.name.toLowerCase())
      }
    } catch { /* skip malformed */ }
  }
  return keywords
}

export async function loadEndpointMetadata(): Promise<string[]> {
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

export async function loadDocumentMetadata(): Promise<string[]> {
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

export async function loadPerformanceMetrics(): Promise<Record<string, PerfMetrics>> {
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

export async function loadSimilarityBoost(
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
