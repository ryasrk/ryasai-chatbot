import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { retrieveRelevantChunks } from '@/lib/rag'
import { enterWithOrg } from '@/lib/prisma-tenant'
import { UnsupportedVectorProviderError } from '@/lib/vector-stores'

export const runtime = 'nodejs'

/**
 * POST /api/documents/search
 * Body: { query: string, topK?: number }   (default topK = 4)
 *
 * RAG RETRIEVAL
 * ----------------------------------------------------------------------------
 * Hybrid retrieval uses lexical scoring for every chunk and, when an external
 * embedding API is configured, adds cosine similarity against stored chunk
 * embeddings. No embedding inference runs inside this app.
 *
 * Scoring:
 *   - Tokenize the query (lowercase, >=4 chars, no stopwords, unique).
 *   - For each chunk:
 *       lexical = content/keyword/phrase hits
 *       semantic = cosine(query_embedding, chunk_embedding), if available
 *       score = lexical + semantic
 *   - Sort desc, apply per-document diversity, take topK.
 */
export async function POST(req: NextRequest) {
  let body: { query?: string; topK?: number }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const query = (body.query ?? '').toString().trim()
  if (!query) {
    return NextResponse.json({ error: 'Missing "query" field' }, { status: 400 })
  }

  const topK = Math.min(Math.max(1, Number(body.topK ?? 4) || 4), 50)

  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    
    const retrieval = await retrieveRelevantChunks({
      query,
      topK,
    })
    if (retrieval.queryTokens.length === 0) {
      // Nothing usable to match — return empty rather than scanning all chunks.
      return NextResponse.json({ results: [], queryTokens: [], topK })
    }
    /*
     * `rerankScore` and `rank` are surfaced because the ORDER and the `score` field describe two different rankings
     * once a reranker has run. MEASURED IN UAT: this endpoint returned `[0.3333, 1, 0.5, 0.1111]` — a correctly
     * ordered array whose visible scores contradict that order — while the Chat UI labelled the same list
     * "Match #1…#4" with the best chunk at #3. A consumer had no way to know which ranking the product used.
     *
     * `score` keeps its retrieval meaning (citation-trail and the dedup paths depend on it); the reranker's own
     * judgement travels beside it, and `rank` is the position in the array as returned.
     */
    const top = retrieval.chunks.map((chunk) => ({
      ...chunk,
      contentHits: chunk.scoreBreakdown.contentHits,
      keywordHits: chunk.scoreBreakdown.keywordHits,
      rerankScore: chunk.rerankScore ?? null,
      rank: chunk.rank ?? null,
    }))

    await writeAudit({
      userId: user.userId,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: {
        query,
        queryTokens: retrieval.queryTokens,
        topK,
        candidatesScanned: retrieval.candidatesScanned,
        returned: top.length,
        topScore: top[0]?.score ?? 0,
      },
    })

    return NextResponse.json({
      results: top,
      queryTokens: retrieval.queryTokens,
      topK,
      candidatesScanned: retrieval.candidatesScanned,
      /*
       * WHY THESE TWO TRAVEL WITH THE RESULTS. MEASURED IN UAT: `semanticSimilarity` was 0 on every result of
       * every query, and nothing in the response explained it. The cause was a stored-vs-configured embedding
       * mismatch (384-dimensional chunks vs a 1536-dimensional query model) that turned semantic scoring off
       * silently. `vectorAttempted: true` beside a large `embeddingMismatch` IS that condition, so a caller can
       * finally distinguish "no semantic match" from "no semantic leg".
       */
      embeddingMismatch: retrieval.embeddingMismatch ?? 0,
      embeddingModelUsed: retrieval.embeddingModelUsed ?? null,
    })
  } catch (e) {
    // An unsupported vector store provider is an operator error, not a server fault, and the old behaviour hid it
    // completely: search returned an empty result set with HTTP 200 and no log. Answered as 502 with the provider
    // NAMED so a typo in configuration is diagnosable from the response alone.
    if (e instanceof UnsupportedVectorProviderError) {
      return NextResponse.json(
        {
          error: {
            code: 'UNSUPPORTED_VECTOR_PROVIDER',
            message: `The configured vector store provider is not supported (${e.provider}). Supported: QDRANT, MILVUS, PINECONE, CHROMA.`,
          },
        },
        { status: 502 },
      )
    }
    return handleApiError(e, 'Failed to search documents.')
  }
}
