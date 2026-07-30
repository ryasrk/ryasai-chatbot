import { scopedLogger } from '@/lib/logger'
const log = scopedLogger('alignment')

export interface AlignmentResult {
  aligned: boolean
  risk: 'low' | 'medium' | 'high'
  reason: string
}

export async function checkAlignment(agentReasoning: string, userGoal: string): Promise<AlignmentResult> {
  const url = process.env.ALIGNMENT_CHECK_URL
  if (url) return checkAlignmentHttp(url, agentReasoning, userGoal)
  if (process.env.ALIGNMENT_CHECK === 'true') return checkAlignmentLlm(agentReasoning, userGoal)
  return { aligned: true, risk: 'low', reason: 'alignment check disabled' }
}

async function checkAlignmentHttp(url: string, reasoning: string, goal: string): Promise<AlignmentResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentReasoning: reasoning, userGoal: goal }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.warn('alignment HTTP check failed', { status: res.status })
      return { aligned: true, risk: 'low', reason: `alignment service unavailable (HTTP ${res.status})` }
    }
    const data = (await res.json()) as Partial<AlignmentResult>
    return {
      aligned: data.aligned ?? true,
      risk: data.risk ?? 'low',
      reason: data.reason ?? 'no reason provided',
    }
  } catch (e) {
    log.warn('alignment HTTP check error', { error: e instanceof Error ? e.message : String(e) })
    return { aligned: true, risk: 'low', reason: 'alignment service unreachable' }
  }
}

async function checkAlignmentLlm(reasoning: string, goal: string): Promise<AlignmentResult> {
  try {
    const { getRoleLlmConfig } = await import('@/lib/llm-config')
    const { chatOnce } = await import('@/lib/llm-client')
    const cfg = await getRoleLlmConfig('query')
    if (!cfg) return { aligned: true, risk: 'low', reason: 'no LLM configured for alignment check' }

    const prompt = `Does this agent reasoning align with the user's goal?
Agent reasoning: ${reasoning.slice(0, 2000)}
User goal: ${goal.slice(0, 500)}
Respond ONLY with JSON: {"aligned": true|false, "risk": "low"|"medium"|"high", "reason": "brief explanation"}`

    const raw = await chatOnce(cfg, [{ role: 'user', content: prompt }], 0, 'alignment-check')
    const { extractJson } = await import('@/lib/constrained-output')
    const parsed = extractJson(raw) as Partial<AlignmentResult>
    return {
      aligned: parsed.aligned ?? true,
      risk: parsed.risk === 'low' || parsed.risk === 'medium' || parsed.risk === 'high' ? parsed.risk : 'low',
      reason: typeof parsed.reason === 'string' ? parsed.reason : 'no reason provided',
    }
  } catch (e) {
    log.warn('alignment LLM check failed', { error: e instanceof Error ? e.message : String(e) })
    return { aligned: true, risk: 'low', reason: 'alignment check failed' }
  }
}
