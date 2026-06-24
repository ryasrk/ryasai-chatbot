import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit } from '@/lib/session'
import { tokenize } from '@/lib/rag'

export const runtime = 'nodejs'

/**
 * POST /api/documents/search
 * Body: { query: string, topK?: number }   (default topK = 4)
 *
 * RAG RETRIEVAL — PRAGMATIC SANDBOX STAND-IN
 * ----------------------------------------------------------------------------
 * The original spec (§3.3) calls for BGE-M3 dense embeddings stored in
 * ChromaDB, with hybrid BM25 + dense retrieval + MMR reranking. Neither
 * BGE-M3 nor ChromaDB are available in this sandbox. We therefore implement
 * a lightweight in-memory keyword-overlap scorer that operates on the same
 * (chunk, keywords) data model the spec expects. The retrieval API surface
 * (top-K chunks with score + provenance) is preserved so the chat pipeline
 * can consume results identically to a future dense-retrieval backend.
 *
 * Scoring:
 *   - Tokenize the query (lowercase, >=4 chars, no stopwords, unique).
 *   - For each chunk:
 *       content_hits = number of query tokens present in chunk.content
 *       keyword_hits = number of query tokens present in chunk.keywords
 *       score        = content_hits + (keyword_hits * 2)
 *   - Sort desc, take topK. Zero-score chunks are excluded.
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

    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) {
      // Nothing usable to match — return empty rather than scanning all chunks.
      return NextResponse.json({ results: [], queryTokens: [], topK })
    }

    // Load all ready documents + chunks for the active company.
    // We use a single query with include to avoid N+1.
    const docs = await db.document.findMany({
      where: { companyId: user.companyId, status: 'ready' },
      select: {
        id: true,
        name: true,
        chunks: {
          select: {
            id: true,
            chunkIndex: true,
            content: true,
            keywords: true,
          },
        },
      },
    })

    type Scored = {
      chunkId: string
      documentId: string
      documentName: string
      chunkIndex: number
      content: string
      score: number
      contentHits: number
      keywordHits: number
    }

    const scored: Scored[] = []
    for (const doc of docs) {
      for (const chunk of doc.chunks) {
        const contentLower = chunk.content.toLowerCase()
        const keywordsLower = (chunk.keywords ?? '').toLowerCase()

        let contentHits = 0
        let keywordHits = 0
        for (const tok of queryTokens) {
          if (contentLower.includes(tok)) contentHits++
          // keywords are stored comma-separated; substring match is fine here.
          if (keywordsLower) {
            const kwSet = keywordsLower
              .split(',')
              .map((k) => k.trim())
              .filter(Boolean)
            if (kwSet.includes(tok)) keywordHits++
          }
        }
        const score = contentHits + keywordHits * 2
        if (score > 0) {
          scored.push({
            chunkId: chunk.id,
            documentId: doc.id,
            documentName: doc.name,
            chunkIndex: chunk.chunkIndex,
            content: chunk.content,
            score,
            contentHits,
            keywordHits,
          })
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)
    const top = scored.slice(0, topK)

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'RAG_SEARCH',
      severity: 'info',
      detail: {
        query,
        queryTokens,
        topK,
        candidatesScanned: scored.length,
        returned: top.length,
        topScore: top[0]?.score ?? 0,
      },
    })

    return NextResponse.json({
      results: top,
      queryTokens,
      topK,
      candidatesScanned: scored.length,
    })
  } catch (e) {
    console.error('[POST /api/documents/search]', e)
    return NextResponse.json(
      { error: 'Failed to search documents', detail: String(e) },
      { status: 500 },
    )
  }
}
