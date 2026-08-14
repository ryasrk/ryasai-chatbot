/**
 * Bounded-concurrency mapper — run an async fn over items with a cap on
 * in-flight promises.
 *
 * Why this exists: `Promise.all(items.map(fn))` fires EVERY promise at once.
 * For per-chunk LLM calls (KG extraction) a 500-chunk document meant 500
 * simultaneous LLM requests — rate-limit spikes, cost bursts, event-loop
 * saturation — and it bypassed the job queue entirely.
 *
 * Failure semantics match Promise.allSettled: one rejection never aborts the
 * batch; errors are captured per item in the result array.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return []
  const effective = Math.max(1, Math.min(limit, items.length))
  const results = new Array<PromiseSettledResult<R>>(items.length)
  let next = 0

  const workers = Array.from({ length: effective }, async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index], index) }
      } catch (error) {
        results[index] = { status: 'rejected', reason: error }
      }
    }
  })

  await Promise.all(workers)
  return results
}
