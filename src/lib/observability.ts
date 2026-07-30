/**
 * Lightweight LLM observability — in-memory ring buffer of recent traces,
 * with optional fire-and-forget forwarding to Langfuse / Helicone.
 */
export interface LlmTrace {
  id: string
  purpose: string
  provider: string
  model: string
  inputPreview: string
  outputPreview: string
  toolCalls?: Array<{ name: string; arguments: string }>
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  latencyMs: number
  timestamp: Date
  error?: string
}

const RING_MAX = 100
// ponytail: in-memory ring buffer — lost on restart. Fine for production debugging;
// persistent storage is the LlmUsageLog table, external tracers cover long-term.
const traces: LlmTrace[] = []

import { inc, observe, counter } from './metrics'
counter('llm_errors_total', 'Total LLM call errors')

export function traceLlmCall(trace: Omit<LlmTrace, 'id' | 'timestamp'>): void {
  const entry: LlmTrace = { ...trace, id: crypto.randomUUID(), timestamp: new Date() }
  if (traces.length >= RING_MAX) traces.shift()
  traces.push(entry)
  forwardTrace(entry).catch(() => {})
  inc('llm_calls_total', { provider: trace.provider, purpose: trace.purpose })
  observe('llm_duration_seconds', trace.latencyMs / 1000, { purpose: trace.purpose })
  if (trace.usage) {
    inc('llm_tokens_total', { provider: trace.provider }, trace.usage.totalTokens)
  }
  if (trace.error) {
    inc('llm_errors_total', { provider: trace.provider })
  }
}

export function getRecentTraces(limit: number = 50): LlmTrace[] {
  return traces.slice(-limit).reverse()
}

export function getTraceStats(): {
  totalCalls: number
  avgLatencyMs: number
  errorRate: number
  totalTokens: number
} {
  const n = traces.length
  if (n === 0) return { totalCalls: 0, avgLatencyMs: 0, errorRate: 0, totalTokens: 0 }
  const totalLatency = traces.reduce((s, t) => s + t.latencyMs, 0)
  const errors = traces.filter((t) => t.error).length
  const tokens = traces.reduce((s, t) => s + (t.usage?.totalTokens ?? 0), 0)
  return {
    totalCalls: n,
    avgLatencyMs: Math.round(totalLatency / n),
    errorRate: errors / n,
    totalTokens: tokens,
  }
}

// ponytail: fire-and-forget forwarding — never blocks the LLM call.
// Failures are warned to console and swallowed; the in-memory buffer is the source of truth.
async function forwardTrace(t: LlmTrace): Promise<void> {
  const langfuseKey = process.env.LANGFUSE_PUBLIC_KEY
  const langfuseSecret = process.env.LANGFUSE_SECRET_KEY
  const langfuseBase = process.env.LANGFUSE_BASEURL ?? 'https://cloud.langfuse.com'
  const heliconeKey = process.env.HELICONE_API_KEY

  if (langfuseKey && langfuseSecret) {
    try {
      const start = t.timestamp
      const end = new Date(t.timestamp.getTime() + t.latencyMs)
      await fetch(`${langfuseBase}/api/public/ingestion`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization:
            'Basic ' + Buffer.from(`${langfuseKey}:${langfuseSecret}`).toString('base64'),
        },
        body: JSON.stringify({
          batch: [
            {
              id: t.id,
              type: 'generation-create',
              body: {
                id: t.id,
                traceId: t.id,
                name: t.purpose,
                startTime: start.toISOString(),
                endTime: end.toISOString(),
                model: t.model,
                input: t.inputPreview,
                output: t.outputPreview,
                usage: t.usage
                  ? {
                      promptTokens: t.usage.promptTokens,
                      completionTokens: t.usage.completionTokens,
                    }
                  : undefined,
                metadata: t.error ? { error: t.error } : undefined,
              },
            },
          ],
        }),
      })
    } catch (e) {
      console.warn('[observability] langfuse forward failed:', e)
    }
  }

  if (heliconeKey) {
    try {
      await fetch('https://api.hconeai.com/v1/log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Helicone-Auth': `Bearer ${heliconeKey}`,
        },
        body: JSON.stringify({
          id: t.id,
          purpose: t.purpose,
          provider: t.provider,
          model: t.model,
          input: t.inputPreview,
          output: t.outputPreview,
          latencyMs: t.latencyMs,
          usage: t.usage,
          error: t.error,
        }),
      })
    } catch (e) {
      console.warn('[observability] helicone forward failed:', e)
    }
  }
}
