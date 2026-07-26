import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import { retrieveRelevantChunks } from '@/lib/rag'

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

    const retrieval = await retrieveRelevantChunks({
      query,
      topK,
    })
    if (retrieval.queryTokens.length === 0) {
      // Nothing usable to match — return empty rather than scanning all chunks.
      return NextResponse.json({ results: [], queryTokens: [], topK })
    }
    const top = retrieval.chunks.map((chunk) => ({
      ...chunk,
      contentHits: chunk.scoreBreakdown.contentHits,
      keywordHits: chunk.scoreBreakdown.keywordHits,
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
    })
  } catch (e) {
    return handleApiError(e, 'Failed to search documents.')
  }
}
