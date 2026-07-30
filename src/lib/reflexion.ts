import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('reflexion')

export interface SelfCritiqueResult {
  critique: string
  revisedAnswer: string
  needsRevision: boolean
}

const CRITIQUE_PROMPT = `You are a self-critique evaluator. Given a question, a proposed answer, and the gathered evidence, critique the answer and revise it if needed.

Rules:
- If the answer is accurate and complete, set needsRevision=false.
- If the answer has gaps, contradictions, or unsupported claims, set needsRevision=true and provide a revised answer grounded in the evidence.
- The revised answer must be a complete answer (not a diff).

Output ONLY valid JSON (no markdown fence):
{
  "critique": "what's wrong or missing, brief",
  "revisedAnswer": "the full revised answer, or the original if no revision needed",
  "needsRevision": true|false
}`

export async function selfCritique(
  question: string,
  answer: string,
  evidence: string,
): Promise<SelfCritiqueResult> {
  if (!answer || answer.trim().length === 0) {
    return { critique: '', revisedAnswer: answer, needsRevision: false }
  }

  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('query')
    if (!cfg) return { critique: '', revisedAnswer: answer, needsRevision: false }

    const raw = await chatOnce(
      cfg,
      [
        { role: 'system', content: CRITIQUE_PROMPT },
        {
          role: 'user',
          content: `Question: ${question}\n\nCurrent answer: ${answer.slice(0, 2000)}\n\nEvidence:\n${evidence.slice(0, 2000)}\n\nCritique and revise. Output JSON only.`,
        },
      ],
      0,
      'reflexion',
    )

    const cleaned = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned) as Partial<SelfCritiqueResult>
    return {
      critique: String(parsed.critique ?? ''),
      revisedAnswer: String(parsed.revisedAnswer ?? answer),
      needsRevision: Boolean(parsed.needsRevision),
    }
  } catch (e) {
    log.warn('selfCritique failed', { error: e instanceof Error ? e.message : String(e) })
    return { critique: '', revisedAnswer: answer, needsRevision: false }
  }
}
