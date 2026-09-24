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
import { enterWithOrg } from '@/lib/prisma-tenant'
import { enterWithFusionK, resolveFusionConfig } from '@/lib/rag-fusion-config'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // Up to 50 full retrievals per call, each able to fan out into HyDE, rerank
    // and KG extraction LLM calls — admin-only, same as the other spend endpoints.
    requireRole(user, 'admin')
    const body = (await req.json().catch(() => ({}))) as { cases?: RagEvalCase[]; topK?: number }
    const cases = Array.isArray(body.cases) ? body.cases.slice(0, 50) : []
    const topK = Math.min(Math.max(1, Number(body.topK ?? 4) || 4), 20)
    // Retrieval A/B seam: the same golden set can be re-run at a different RRF `k`
    // against the SAME server process, so a difference between two runs is the
    // constant rather than a restarted process or a cold cache. Gated on
    // RAG_FUSION_K, like the chat route — entering a value is a no-op when unset.
    const fusionOverrideAccepted = enterWithFusionK(req.headers.get('x-fusion-k'))
    const fusion = resolveFusionConfig()
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
      // The fusion configuration is recorded because two eval runs at different `k`
      // are only comparable if each names the value it measured.
      detail: { ...summary, fusionK: fusion.k, fusionKSource: fusion.source, fusionOverrideAccepted },
    })

    return NextResponse.json({
      ok: true,
      summary,
      fusion: { k: fusion.k, source: fusion.source, overrideAccepted: fusionOverrideAccepted },
      results,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to run RAG evaluation.')
  }
}
