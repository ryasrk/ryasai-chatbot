import { NextRequest, NextResponse } from 'next/server'
import {
  isGrounded,
  relevantSourcesFor,
  scoreRetrieval,
  summarizeRagEval,
  type RagEvalCase,
} from '@/lib/rag-eval'
import { retrieveRelevantChunks } from '@/lib/rag'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    // Up to 50 full retrievals per call, each able to fan out into HyDE, rerank
    // and KG extraction LLM calls — admin-only, same as the other spend endpoints.
    requireRole(user, 'admin')
    const body = (await req.json().catch(() => ({}))) as { cases?: RagEvalCase[]; topK?: number }
    const cases = Array.isArray(body.cases) ? body.cases.slice(0, 50) : []
    const topK = Math.min(Math.max(1, Number(body.topK ?? 4) || 4), 20)
    const results: Array<{
      question: string
      ok: boolean
      grounded: boolean
      latencyMs: number
      topSource?: string
      topScore: number
      returned: number
      recall: number
      precision: number
      reciprocalRank: number
    }> = []

    for (const item of cases) {
      const question = String(item.question ?? '').trim()
      if (!question) continue
      const started = Date.now()
      const retrieval = await retrieveRelevantChunks({
        query: question,
        topK,
      })
      const chunks = retrieval.chunks
      const top = chunks[0]
      const content = chunks.map((chunk) => chunk.content).join('\n')
      // chunks are in rank order, which scoreRetrieval needs for MRR.
      const scored = scoreRetrieval(chunks, relevantSourcesFor(item))
      results.push({
        question,
        ok: scored.hit,
        grounded: isGrounded(content, item.expectedText),
        latencyMs: Date.now() - started,
        topSource: top?.documentName,
        topScore: top?.score ?? 0,
        returned: chunks.length,
        recall: scored.recall,
        precision: scored.precision,
        reciprocalRank: scored.reciprocalRank,
      })
    }

    const summary = summarizeRagEval(results)
    await writeAudit({
      userId: user.userId,
      action: 'RAG_EVAL_RUN',
      severity: 'info',
      detail: { ...summary },
    })

    return NextResponse.json({ ok: true, summary, results })
  } catch (e) {
    return handleApiError(e, 'Failed to run RAG evaluation.')
  }
}
