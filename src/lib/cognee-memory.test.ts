import { test, expect, describe, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// Chat memory: remember/recall + the session-level semantic cache.
//
// This file did not exist. cognee-memory.ts was at 12.5% lines with no test, so
// the parts that decide WHAT the assistant remembers and whether a repeated
// question is answered from cache were entirely unverified. (It is also imported
// for coverage by another suite, which is where the 12.5% came from.)
// ---------------------------------------------------------------------------
const state = {
  enabled: true,
  client: null as any,
  owner: 'owner-1',
  rememberCalls: [] as any[],
  searchCalls: [] as any[],
  searchImpl: null as any,
}

mock.module('./cognee-core', () => ({
  isCogneeEnabled: async () => state.enabled,
  getCogneeClient: async () => state.client,
  getCogneeOwnerId: () => state.owner,
  formatSearchResponse: (r: any) => {
    if (r === null || r === undefined) return ''
    if (typeof r === 'string') return r
    if (Array.isArray(r)) return r.filter(Boolean).join('\n')
    return ''
  },
}))
mock.module('./cognee-types', () => ({
  datasetFor: () => 'org:acme',
  kbDatasetFor: () => 'org:acme:kb',
}))

import {
  rememberChatTurn, recallContext, clearSessionCache,
} from './cognee-memory'

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    datasets: { has: async () => true },
    remember: async (docs: any, ds: any) => { state.rememberCalls.push({ docs, ds }) },
    search: async (q: any, opts: any) => {
      state.searchCalls.push({ q, opts })
      if (state.searchImpl) return state.searchImpl(q, opts)
      return null
    },
    ...over,
  }
}

beforeEach(() => {
  clearSessionCache()
  state.enabled = true
  state.client = null
  state.owner = 'owner-1'
  state.rememberCalls = []
  state.searchCalls = []
  state.searchImpl = null
})

describe('rememberChatTurn', () => {
  test('does nothing when cognee is disabled', async () => {
    state.enabled = false
    state.client = fakeClient()
    await rememberChatTurn({ userMessage: 'hi', aiMessage: 'hello', sessionId: 's1', toolRuns: [] })
    expect(state.rememberCalls).toHaveLength(0)
  })

  test('does nothing when no client can be built', async () => {
    state.client = null
    await rememberChatTurn({ userMessage: 'hi', aiMessage: 'hello', sessionId: 's1', toolRuns: [] })
    expect(state.rememberCalls).toHaveLength(0)
  })

  test('stores the turn as JSON text against the org dataset', async () => {
    state.client = fakeClient()
    await rememberChatTurn({
      userMessage: 'what is the revenue',
      aiMessage: 'Rp 5m',
      sessionId: 's1',
      toolRuns: [{ type: 'SQL', status: 'success', latencyMs: 12 }],
    })
    expect(state.rememberCalls).toHaveLength(1)
    const { docs, ds } = state.rememberCalls[0]
    expect(ds).toBe('org:acme')
    expect(docs[0].type).toBe('text')
    const payload = JSON.parse(docs[0].text)
    // The turn must be reconstructable: both messages, the session, and the tools.
    expect(payload.user).toBe('what is the revenue')
    expect(payload.assistant).toBe('Rp 5m')
    expect(payload.sessionId).toBe('s1')
    expect(payload.tools).toHaveLength(1)
    expect(typeof payload.ts).toBe('number')
  })

  test('a THROWING remember is swallowed — a memory failure must not fail the chat', async () => {
    state.client = fakeClient({ remember: async () => { throw new Error('cognee down') } })
    await expect(
      rememberChatTurn({ userMessage: 'a', aiMessage: 'b', sessionId: 's1', toolRuns: [] }),
    ).resolves.toBeUndefined()
  })
})

describe('recallContext', () => {
  test('returns empty string when cognee is disabled', async () => {
    state.enabled = false
    expect(await recallContext({ query: 'q' })).toBe('')
  })

  test('returns empty string when no client can be built', async () => {
    state.client = null
    expect(await recallContext({ query: 'q' })).toBe('')
  })

  test('returns the first non-empty formatted result from the strategies', async () => {
    state.client = fakeClient()
    let n = 0
    state.searchImpl = () => { n += 1; return n === 1 ? 'graph answer' : null }
    const out = await recallContext({ query: 'sales' })
    expect(out).toBe('graph answer')
  })

  test('the dataset-missing guard short-circuits BEFORE any search', async () => {
    state.client = fakeClient({ datasets: { has: async () => false } })
    const out = await recallContext({ query: 'sales' })
    expect(out).toBe('')
    // A fresh org has no dataset; searching anyway threw and logged twice per
    // turn. has() is the cheap metadata check that avoids that noise.
    expect(state.searchCalls).toHaveLength(0)
  })

  test('an UNKNOWN dataset state still tries the search', async () => {
    state.client = fakeClient({ datasets: { has: async () => true } })
    state.searchImpl = () => 'found'
    expect(await recallContext({ query: 'sales' })).toBe('found')
  })

  test('a datasets.has that THROWS is not fatal (older SDK)', async () => {
    state.client = fakeClient({ datasets: { has: async () => { throw new Error('no such API') } } })
    state.searchImpl = () => 'found anyway'
    expect(await recallContext({ query: 'sales' })).toBe('found anyway')
  })

  test('a missing datasets object entirely is not fatal', async () => {
    state.client = fakeClient({ datasets: undefined })
    state.searchImpl = () => 'found anyway'
    expect(await recallContext({ query: 'sales' })).toBe('found anyway')
  })

  test('one failing strategy does not abort the others', async () => {
    state.client = fakeClient()
    let n = 0
    state.searchImpl = () => {
      n += 1
      if (n === 1) throw new Error('SUMMARIES unsupported')
      return 'second strategy worked'
    }
    const out = await recallContext({ query: 'sales' })
    expect(out).toBe('second strategy worked')
    // All three strategies were attempted; a dead one must not stop the loop.
    expect(state.searchCalls.length).toBeGreaterThanOrEqual(2)
  })

  test('only SDK-valid searchTypes are used', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'x'
    await recallContext({ query: 'sales' })
    const used = state.searchCalls.map((c) => c.opts.searchType).filter(Boolean)
    // GRAPH_ENTITIES / GRAPH_RELATIONSHIPS are rejected by the Rust side with an
    // "unknown SearchType" error — they must never be sent.
    for (const t of used) {
      expect(['SUMMARIES', 'CHUNKS', 'NATURAL_LANGUAGE']).toContain(t)
    }
  })

  test('the search is scoped to the org dataset and owner', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'x'
    await recallContext({ query: 'sales' })
    expect(state.searchCalls[0].opts.datasets).toEqual(['org:acme'])
    expect(state.searchCalls[0].opts.userId).toBe('owner-1')
  })

  test('when every strategy fails it falls back to an UNSCOPED search', async () => {
    state.client = fakeClient()
    let n = 0
    state.searchImpl = () => {
      n += 1
      if (n <= 3) throw new Error('strategy failed')
      return 'last resort answer'
    }
    const out = await recallContext({ query: 'sales' })
    expect(out).toBe('last resort answer')
    const last = state.searchCalls[state.searchCalls.length - 1]
    expect(last.opts.datasets).toBeUndefined()
  })

  test('when even the fallback fails the result is empty, not a throw', async () => {
    state.client = fakeClient()
    state.searchImpl = () => { throw new Error('everything is down') }
    expect(await recallContext({ query: 'sales' })).toBe('')
  })

  test('overlapping strategy outputs are deduped before joining', async () => {
    state.client = fakeClient()
    const same = 'the identical answer text'
    let n = 0
    state.searchImpl = () => { n += 1; return n <= 2 ? same : null }
    const out = await recallContext({ query: 'sales' })
    // Both strategies returned the same head, so it must appear once.
    expect(out).toBe(same)
  })

  test('distinct strategy outputs are joined', async () => {
    state.client = fakeClient()
    let n = 0
    state.searchImpl = () => { n += 1; return n <= 2 ? `answer number ${n}` : null }
    const out = await recallContext({ query: 'sales' })
    expect(out).toBe('answer number 1\nanswer number 2')
  })
})

describe('the session semantic cache', () => {
  test('a repeated question in the same session is served from cache', async () => {
    state.client = fakeClient()
    // recallContext merges a SESSION result and a GRAPH result; the mock is told
    // apart by the search options, so the expected string is exact. (A single
    // one-size return made both legs identical and the expectation ambiguous.)
    state.searchImpl = (_q: any, opts: any) => (opts.sessionId ? 'session memory' : 'graph answer')
    const first = await recallContext({ query: 'revenue', sessionId: 's1' })
    expect(first).toBe('session memory\ngraph answer')
    const callsAfterFirst = state.searchCalls.length
    const second = await recallContext({ query: 'revenue', sessionId: 's1' })
    expect(second).toBe('session memory\ngraph answer')
    // The whole point: no second round-trip for a repeat question.
    expect(state.searchCalls.length).toBe(callsAfterFirst)
  })

  test('the cache key is case- and whitespace-insensitive', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'Revenue', sessionId: 's1' })
    const callsAfterFirst = state.searchCalls.length
    // A user typing the same question with different casing must not pay a
    // second graph round-trip.
    const second = await recallContext({ query: '  revenue  ', sessionId: 's1' })
    expect(second).toBe('answer\nanswer')
    expect(state.searchCalls.length).toBe(callsAfterFirst)
  })

  test('a DIFFERENT session does not share the cache', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'revenue', sessionId: 's1' })
    const callsAfterFirst = state.searchCalls.length
    await recallContext({ query: 'revenue', sessionId: 's2' })
    // Cross-session leakage would show one user another user's remembered answer.
    expect(state.searchCalls.length).toBeGreaterThan(callsAfterFirst)
  })

  test('a different question in the same session is not a cache hit', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'revenue', sessionId: 's1' })
    const callsAfterFirst = state.searchCalls.length
    await recallContext({ query: 'headcount', sessionId: 's1' })
    expect(state.searchCalls.length).toBeGreaterThan(callsAfterFirst)
  })

  test('clearSessionCache(id) clears only that session', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'revenue', sessionId: 's1' })
    await recallContext({ query: 'revenue', sessionId: 's2' })
    const before = state.searchCalls.length
    clearSessionCache('s1')
    // s1 refetches, s2 is still cached.
    await recallContext({ query: 'revenue', sessionId: 's1' })
    expect(state.searchCalls.length).toBeGreaterThan(before)
    const afterS1 = state.searchCalls.length
    await recallContext({ query: 'revenue', sessionId: 's2' })
    expect(state.searchCalls.length).toBe(afterS1)
  })

  test('clearSessionCache() with no id clears everything', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'revenue', sessionId: 's1' })
    await recallContext({ query: 'revenue', sessionId: 's2' })
    clearSessionCache()
    const before = state.searchCalls.length
    await recallContext({ query: 'revenue', sessionId: 's1' })
    await recallContext({ query: 'revenue', sessionId: 's2' })
    expect(state.searchCalls.length).toBeGreaterThan(before)
  })

  test('an EMPTY result is not cached, so it can be retried once the graph is ready', async () => {
    state.client = fakeClient()
    state.searchImpl = () => null
    await recallContext({ query: 'revenue', sessionId: 's1' })
    const before = state.searchCalls.length
    // Caching '' would pin a pre-cognify session to "no memory" permanently.
    await recallContext({ query: 'revenue', sessionId: 's1' })
    expect(state.searchCalls.length).toBeGreaterThan(before)
  })

  test('without a sessionId nothing is cached', async () => {
    state.client = fakeClient()
    state.searchImpl = () => 'answer'
    await recallContext({ query: 'revenue' })
    const before = state.searchCalls.length
    await recallContext({ query: 'revenue' })
    expect(state.searchCalls.length).toBeGreaterThan(before)
  })
})
