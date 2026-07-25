import { NextRequest, NextResponse } from 'next/server'
import { isGrounded, summarizeRagEval, type RagEvalCase } from '@/lib/rag-eval'
import { retrieveRelevantChunks } from '@/lib/rag'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
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
      const ok = item.expectedSource
        ? chunks.some((chunk) => chunk.documentName.includes(item.expectedSource!))
        : chunks.length > 0
      results.push({
        question,
        ok,
        grounded: isGrounded(content, item.expectedText),
        latencyMs: Date.now() - started,
        topSource: top?.documentName,
        topScore: top?.score ?? 0,
        returned: chunks.length,
      })
    }

    const summary = summarizeRagEval(results)
    await writeAudit({
      userId: user.userId,
      action: 'RAG_EVAL_RUN',
      severity: 'info',
      detail: summary,
    })

    return NextResponse.json({ ok: true, summary, results })
  } catch (e) {
    return handleApiError(e, 'Gagal menjalankan evaluasi RAG.')
  }
}
