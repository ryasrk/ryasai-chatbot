/**
 * speculative-retrieval — retrieval started alongside intent analysis.
 *
 * What these pin, and why each is here:
 *  - it STARTS only for a turn that can reach the documents (none exist / tool off / database pinned pay nothing);
 *  - a result is reused ONLY for the exact request it was started for. Reusing it for another document scope would
 *    serve chunks the caller's key may not read, with no error — so the scope mismatch case is the most important one;
 *  - a failed speculative retrieval does not become an unhandled rejection on a turn that never uses it, and IS
 *    re-thrown by the branch that does (so that branch's "degrade to chat" handling still applies);
 *  - the kill switch is read per call (a function, not a module constant).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

let calls: Array<{ query: string; topK: number; documentIds?: string[] | null }> = []
let impl: (args: { query: string; topK: number; documentIds?: string[] | null }) => Promise<unknown> = async () => ({ chunks: [], marker: 'speculative' })

mock.module('@/lib/intent-pipeline', () => ({
  retrieveWithReflection: (args: { query: string; topK: number; documentIds?: string[] | null }) => {
    calls.push(args)
    return impl(args)
  },
}))

const {
  RAG_ANSWER_TOP_K,
  cancelSpeculativeRetrieval,
  sameRequest,
  settleRetrieval,
  speculativeRetrievalEnabled,
  startSpeculativeRetrieval,
} = await import('./speculative-retrieval')

const base = { question: 'Berapa hari cuti tahunan?', documentCount: 3, ragToolEnabled: true, pinnedIntegration: false }

beforeEach(() => {
  calls = []
  impl = async () => ({ chunks: [], marker: 'speculative' })
  delete process.env.SPECULATIVE_RETRIEVAL
})

describe('startSpeculativeRetrieval — only when the documents are reachable', () => {
  test('starts one retrieval with the answer topK for an ordinary document turn', async () => {
    const spec = startSpeculativeRetrieval({ ...base, documentIds: null })
    expect(spec).not.toBeNull()
    await spec!.settled
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ query: base.question, topK: RAG_ANSWER_TOP_K })
  })

  test('RAG_ANSWER_TOP_K is the value the branches have always used', () => {
    // Both answer branches read this constant, so the speculation cannot start for a topK they no longer ask for.
    expect(RAG_ANSWER_TOP_K).toBe(4)
  })

  test.each([
    ['an org with no documents', { documentCount: 0 }],
    ['the RAG tool switched off', { ragToolEnabled: false }],
    ['a user-pinned database', { pinnedIntegration: true }],
  ])('does NOT start for %s — those turns pay nothing', (_label, over) => {
    const spec = startSpeculativeRetrieval({ ...base, ...over })
    expect(spec).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('SPECULATIVE_RETRIEVAL=false turns it off, and is read at call time', () => {
    process.env.SPECULATIVE_RETRIEVAL = 'false'
    expect(speculativeRetrievalEnabled()).toBe(false)
    expect(startSpeculativeRetrieval(base)).toBeNull()
    expect(calls).toHaveLength(0)
    delete process.env.SPECULATIVE_RETRIEVAL
    expect(speculativeRetrievalEnabled()).toBe(true)
    expect(startSpeculativeRetrieval(base)).not.toBeNull()
  })
})

describe('settleRetrieval — reuse only for the exact request', () => {
  test('the same request reuses the speculative result and does NOT call the fallback', async () => {
    const spec = startSpeculativeRetrieval({ ...base, documentIds: ['d1', 'd2'] })
    let fallbackCalls = 0
    const out = await settleRetrieval(spec, { query: base.question, topK: RAG_ANSWER_TOP_K, documentIds: ['d1', 'd2'] }, async () => {
      fallbackCalls += 1
      return { chunks: [], marker: 'fallback' } as never
    })
    expect((out as unknown as { marker: string }).marker).toBe('speculative')
    expect(fallbackCalls).toBe(0)
    expect(calls).toHaveLength(1)
  })

  test('a DIFFERENT document scope discards the speculative result — a scope leak must be impossible', async () => {
    const spec = startSpeculativeRetrieval({ ...base, documentIds: ['d1'] })
    const out = await settleRetrieval(spec, { query: base.question, topK: RAG_ANSWER_TOP_K, documentIds: ['d2'] }, async () => ({ chunks: [], marker: 'fallback' }) as never)
    expect((out as unknown as { marker: string }).marker).toBe('fallback')
  })

  test('unrestricted (null) and restricted scopes are different requests', () => {
    expect(sameRequest({ query: 'q', topK: 4, documentIds: null }, { query: 'q', topK: 4, documentIds: ['d1'] })).toBe(false)
    expect(sameRequest({ query: 'q', topK: 4, documentIds: undefined }, { query: 'q', topK: 4, documentIds: [] })).toBe(true)
  })

  test('the same documents in a different ORDER are the same scope', () => {
    expect(sameRequest({ query: 'q', topK: 4, documentIds: ['a', 'b'] }, { query: 'q', topK: 4, documentIds: ['b', 'a'] })).toBe(true)
  })

  test('a different question or topK is a different request', () => {
    expect(sameRequest({ query: 'q1', topK: 4 }, { query: 'q2', topK: 4 })).toBe(false)
    expect(sameRequest({ query: 'q', topK: 4 }, { query: 'q', topK: 8 })).toBe(false)
  })

  test('no speculative retrieval (null) runs the fallback', async () => {
    const out = await settleRetrieval(null, { query: 'q', topK: 4 }, async () => ({ chunks: [], marker: 'fallback' }) as never)
    expect((out as unknown as { marker: string }).marker).toBe('fallback')
  })
})

describe('failure handling', () => {
  test('a rejected speculative retrieval that nobody awaits does not become an unhandled rejection', async () => {
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    impl = async () => { throw new Error('vector store down') }
    try {
      const spec = startSpeculativeRetrieval(base)
      expect(spec).not.toBeNull()
      // The turn routed elsewhere: nobody settles it. Give the runtime time to report an unhandled rejection.
      await new Promise((r) => setTimeout(r, 30))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('the branch that DOES use it gets the failure re-thrown, so its degrade-to-chat handling still applies', async () => {
    impl = async () => { throw new Error('vector store down') }
    const spec = startSpeculativeRetrieval(base)
    await expect(
      settleRetrieval(spec, { query: base.question, topK: RAG_ANSWER_TOP_K, documentIds: undefined }, async () => ({ chunks: [] }) as never),
    ).rejects.toThrow('vector store down')
  })

  test('a SYNCHRONOUS throw from the retriever is settled too, not thrown out of startSpeculativeRetrieval', async () => {
    // The shared mock calls `impl`, so making `impl` throw synchronously (not return a rejected promise) reproduces
    // a retriever that throws before it ever returns one — a bad argument, a missing export.
    impl = (() => { throw new Error('sync boom') }) as never
    let spec: ReturnType<typeof startSpeculativeRetrieval> = null
    expect(() => { spec = startSpeculativeRetrieval(base) }).not.toThrow()
    expect(spec).not.toBeNull()
    const settled = await spec!.settled
    expect(settled.ok).toBe(false)
  })
})

describe('cancelSpeculativeRetrieval — a turn that will not use the retrieval stops it', () => {
  test('hands the retrieval an AbortSignal, and cancel aborts exactly that signal', async () => {
    let seen: AbortSignal | undefined
    impl = (async (a: { signal?: AbortSignal }) => { seen = a.signal; return { chunks: [] } }) as never
    const spec = startSpeculativeRetrieval(base)
    await spec!.settled
    expect(seen).toBeDefined()
    expect(seen!.aborted).toBe(false)
    cancelSpeculativeRetrieval(spec)
    expect(seen!.aborted).toBe(true)
  })

  test('the signal does NOT leak into the request identity that sameRequest compares', () => {
    const spec = startSpeculativeRetrieval(base)!
    expect(Object.keys(spec.request).sort()).toEqual(['documentIds', 'query', 'topK'])
  })

  test('is safe with null/undefined and when called twice', () => {
    expect(() => cancelSpeculativeRetrieval(null)).not.toThrow()
    expect(() => cancelSpeculativeRetrieval(undefined)).not.toThrow()
    const spec = startSpeculativeRetrieval(base)
    expect(() => { cancelSpeculativeRetrieval(spec); cancelSpeculativeRetrieval(spec) }).not.toThrow()
  })

  test('a CANCELLED retrieval is never reused: the branch runs a fresh one instead of re-throwing an AbortError', async () => {
    impl = async () => { throw new DOMException('aborted', 'AbortError') }
    const spec = startSpeculativeRetrieval(base)
    cancelSpeculativeRetrieval(spec)
    let fallbackCalls = 0
    const out = await settleRetrieval(spec, { query: base.question, topK: RAG_ANSWER_TOP_K, documentIds: undefined }, async () => {
      fallbackCalls += 1
      return { chunks: [], marker: 'fresh' } as never
    })
    expect(fallbackCalls).toBe(1)
    expect((out as unknown as { marker: string }).marker).toBe('fresh')
  })
})
