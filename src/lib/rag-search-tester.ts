export interface RagSearchScoreBreakdown {
  total: number
  lexicalTotal: number
  contentHits: number
  keywordHits: number
  phraseHits: number
  semanticSimilarity: number
  semanticScore: number
}

export interface RagSearchResult {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
  contentHits: number
  keywordHits: number
  scoreBreakdown: RagSearchScoreBreakdown
}

export interface RagSearchMeta {
  queryTokens: string[]
  topK: number
  candidatesScanned: number
}

export function normalizeRagSearchResponse(body: unknown): {
  results: RagSearchResult[]
  meta: RagSearchMeta
} {
  const data = asRecord(body)
  const results = Array.isArray(data.results)
    ? data.results.map(normalizeResult).filter((row): row is RagSearchResult => row !== null)
    : []

  return {
    results,
    meta: {
      queryTokens: Array.isArray(data.queryTokens)
        ? data.queryTokens.map(String)
        : [],
      topK: Number(data.topK ?? results.length) || results.length,
      candidatesScanned: Number(data.candidatesScanned ?? 0) || 0,
    },
  }
}

function normalizeResult(row: unknown): RagSearchResult | null {
  const data = asRecord(row)
  const chunkId = stringValue(data.chunkId)
  const documentId = stringValue(data.documentId)
  const documentName = stringValue(data.documentName)
  const content = stringValue(data.content)
  if (!chunkId || !documentId || !documentName || !content) return null

  const score = Number(data.score ?? 0) || 0
  const contentHits = Number(data.contentHits ?? 0) || 0
  const keywordHits = Number(data.keywordHits ?? 0) || 0
  const rawBreakdown = asRecord(data.scoreBreakdown)

  return {
    chunkId,
    documentId,
    documentName,
    chunkIndex: Number(data.chunkIndex ?? 0) || 0,
    content,
    score,
    contentHits,
    keywordHits,
    scoreBreakdown: {
      total: Number(rawBreakdown.total ?? score) || score,
      lexicalTotal: Number(rawBreakdown.lexicalTotal ?? score) || score,
      contentHits: Number(rawBreakdown.contentHits ?? contentHits) || contentHits,
      keywordHits: Number(rawBreakdown.keywordHits ?? keywordHits) || keywordHits,
      phraseHits: Number(rawBreakdown.phraseHits ?? 0) || 0,
      semanticSimilarity: Number(rawBreakdown.semanticSimilarity ?? 0) || 0,
      semanticScore: Number(rawBreakdown.semanticScore ?? 0) || 0,
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
