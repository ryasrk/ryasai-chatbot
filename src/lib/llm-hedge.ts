/**
 * Hedged requests for slow LLM calls: if a call is still outstanding after its purpose's p95, send an identical backup
 * and take whichever finishes first (Dean & Barroso, "The Tail at Scale", CACM 2013 — about 5% extra load for a much
 * shorter tail). The answer is the same request's answer, so accuracy is untouched; only waiting time changes.
 *
 * WHY (measured 2026-10-05, 175-question A/B, reasoning off): the selector's p95 was 4.1 s but its p99 24.6 s and its
 * max 27.2 s — a few calls hang until the provider's 30 s timeout and set the tail of the whole turn. Failed calls are
 * not in LlmUsageLog at all, so the real tail is longer than that.
 *
 * Off unless `LLM_HEDGE=on`. A backup's tokens are billed by the provider but cannot be logged (it is aborted before it
 * reports usage), so hedges are counted by the `onHedge` hook instead.
 */

/** Milliseconds before a backup is sent, per purpose: ~p95 of the 175-question A/B (rounded up). */
const HEDGE_AFTER_MS: Record<string, number> = {
  agent: 4500,
  'rag-rerank': 5000,
  reflection: 3000,
  'rag-decompose': 2500,
  synthesis: 6500,
}

export function hedgeDelayForPurpose(purpose: string | undefined): number | undefined {
  if (process.env.LLM_HEDGE !== 'on' || !purpose) return undefined
  return HEDGE_AFTER_MS[purpose]
}

/**
 * Run `send`; if it has not settled after `delayMs`, run it again and resolve with the first attempt to SUCCEED,
 * aborting the other. A failed attempt does not end the race while the other is still running; if both fail, the
 * last error is raised. `send` must honour the signal it is given.
 */
export function hedgedRequest<T>(send: (signal: AbortSignal) => Promise<T>, delayMs: number, onHedge?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controllers: AbortController[] = []
    let settled = false
    let running = 0
    let lastError: unknown
    let timer: ReturnType<typeof setTimeout> | undefined

    const launch = () => {
      const controller = new AbortController()
      controllers.push(controller)
      running++
      send(controller.signal).then(
        (value) => {
          running--
          if (settled) return
          settled = true
          clearTimeout(timer)
          for (const c of controllers) if (c !== controller) c.abort()
          resolve(value)
        },
        (error) => {
          running--
          if (settled) return
          lastError = error
          // The backup may still answer; only give up when nothing is left in flight and no backup is pending.
          if (running === 0 && timer === undefined) {
            settled = true
            reject(lastError)
          }
        },
      )
    }

    launch()
    timer = setTimeout(() => {
      timer = undefined
      if (settled) return
      onHedge?.()
      launch()
    }, delayMs)
  })
}
