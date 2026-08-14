import { describe, expect, test } from 'bun:test'
import { mapWithConcurrency } from './bounded-concurrency'

describe('mapWithConcurrency', () => {
  test('never exceeds the concurrency limit', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_, i) => i)

    await mapWithConcurrency(items, 5, async (n) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      expect(inFlight).toBeLessThanOrEqual(5)
      await new Promise((r) => setTimeout(r, 5 + (n % 3)))
      inFlight -= 1
      return n * 2
    })

    // The whole point: 50 items, cap 5 — the old Promise.all peaked at 50.
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1) // actually parallel, not serialized
  })

  test('preserves result order and values', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (5 - n) * 4)) // reverse latency
      return n * 10
    })
    expect(out.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([10, 20, 30, 40])
  })

  test('one rejection does not abort the batch (allSettled semantics)', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 })
    expect(out[1].status).toBe('rejected')
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 })
  })

  test('empty input → empty output, no workers spawned', async () => {
    const out = await mapWithConcurrency([], 5, async () => 1)
    expect(out).toEqual([])
  })

  test('limit clamped to [1, items.length]', async () => {
    const tiny = await mapWithConcurrency([1], 100, async (n) => n)
    expect(tiny[0].status).toBe('fulfilled')
    const zero = await mapWithConcurrency([1, 2, 3], 0, async (n) => n)
    expect(zero.every((r) => r.status === 'fulfilled')).toBe(true)
  })
})
