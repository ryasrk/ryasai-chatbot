import { describe, expect, test } from 'bun:test'
import { hedgedRequest, hedgeDelayForPurpose } from '@/lib/llm-hedge'

/** A fake request: resolves (or rejects) after `ms`, records whether it was aborted. */
function fake(ms: number, outcome: 'ok' | 'fail' = 'ok', label = 'r') {
  const state = { started: 0, aborted: 0 }
  const send = (signal: AbortSignal) => {
    state.started++
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => (outcome === 'ok' ? resolve(`${label}${state.started}`) : reject(new Error('transport'))), ms)
      signal.addEventListener('abort', () => { clearTimeout(t); state.aborted++; reject(new Error('aborted')) })
    })
  }
  return { send, state }
}

describe('hedgedRequest — a backup request for a slow call (The Tail at Scale)', () => {
  test('a call that finishes before the delay is sent once', async () => {
    const f = fake(10)
    expect(await hedgedRequest(f.send, 50)).toBe('r1')
    await new Promise((r) => setTimeout(r, 70))
    expect(f.state.started).toBe(1)
  })

  test('a slow call gets a backup; the first to finish wins and the other is aborted', async () => {
    let n = 0
    const state = { aborted: 0 }
    const send = (signal: AbortSignal) => {
      n++
      const ms = n === 1 ? 300 : 20 // the original hangs, the backup is quick
      const label = `call${n}`
      return new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => resolve(label), ms)
        signal.addEventListener('abort', () => { clearTimeout(t); state.aborted++; reject(new Error('aborted')) })
      })
    }
    const started = Date.now()
    expect(await hedgedRequest(send, 30)).toBe('call2')
    expect(Date.now() - started).toBeLessThan(200)
    expect(n).toBe(2)
    expect(state.aborted).toBe(1)
  })

  test('if one attempt fails, the other is still awaited', async () => {
    let n = 0
    const send = (_s: AbortSignal) => {
      n++
      return n === 1
        ? new Promise<string>((_, reject) => setTimeout(() => reject(new Error('transport')), 60))
        : new Promise<string>((resolve) => setTimeout(() => resolve('backup'), 40))
    }
    expect(await hedgedRequest(send, 20)).toBe('backup')
  })

  test('when both fail, the error is raised', async () => {
    const f = fake(20, 'fail')
    await expect(hedgedRequest(f.send, 5)).rejects.toThrow('transport')
  })

  test('the hook is told when a backup is sent', async () => {
    let hedges = 0
    const f = fake(60)
    await hedgedRequest(f.send, 10, () => { hedges++ })
    expect(hedges).toBe(1)
  })
})

describe('hedgeDelayForPurpose', () => {
  test('off unless LLM_HEDGE=on, and only for the measured purposes', () => {
    delete process.env.LLM_HEDGE
    expect(hedgeDelayForPurpose('agent')).toBeUndefined()
    process.env.LLM_HEDGE = 'on'
    try {
      expect(hedgeDelayForPurpose('agent')).toBeGreaterThan(0)
      expect(hedgeDelayForPurpose('rag-rerank')).toBeGreaterThan(0)
      expect(hedgeDelayForPurpose('sql')).toBeUndefined()
    } finally {
      delete process.env.LLM_HEDGE
    }
  })
})
