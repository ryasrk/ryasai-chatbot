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

  test('datasets.has() === false does NOT disable recall (cognee-ts 0.1.3 lies)', async () => {
    // INCIDENT this pins, measured against a real store: `datasets.has('org:<id>')`
    // returned false for a dataset that `datasets.list()` listed AND whose fact a raw
    // search returned. The old guard trusted that false and returned '' before
    // searching, so memory was written, stored, retrievable — and never surfaced. A
    // silent permanent amnesia, with no error and no log, is the worst possible failure
    // for the layer the product treats as core memory.
    state.client = fakeClient({ datasets: { has: async () => false } })
    state.searchImpl = () => 'stored fact'
    expect(await recallContext({ query: 'sales' })).toBe('stored fact')
    // It must genuinely SEARCH rather than return early on the flag.
    expect(state.searchCalls.length).toBeGreaterThan(0)
  })

  test('a false has() is ADVISORY: it must not stop the session leg either', async () => {
    // The session leg is the one that answers "what did I tell you earlier?" across
    // sessions, so a lying has() must not be allowed to suppress it. Both legs are
    // asserted here because the original bug silenced BOTH at once.
    state.client = fakeClient({ datasets: { has: async () => false } })
    state.searchImpl = () => 'from session'
    const out = await recallContext({ query: 'sales', sessionId: 'sess-1' })
    expect(out).toContain('from session')
    expect(state.searchCalls.length).toBeGreaterThan(0)
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

  test('NATURAL_LANGUAGE failing does NOT lose SUMMARIES/CHUNKS', async () => {
    // The strategy is known-broken on the local kuzu backend (it emits Cypher the
    // backend rejects on every retry) and is kept ONLY because the loop isolates each
    // strategy. The sibling test above throws from the FIRST strategy; this throws
    // from the LAST, which is the order the live pipeline actually hits — and it is
    // the order where a naive `for … await` without a per-iteration catch would throw
    // away the two answers already collected.
    const tried: string[] = []
    state.client = fakeClient()
    state.searchImpl = (_q: any, opts: any) => {
      tried.push(opts.searchType)
      if (opts.searchType === 'NATURAL_LANGUAGE') {
        throw new Error('invalid input: NATURAL_LANGUAGE search generated Cypher that this graph backend rejected')
      }
      return opts.searchType === 'SUMMARIES' ? 'from summaries' : 'from chunks'
    }
    const out = await recallContext({ query: 'sales' })
    // Both surviving strategies must reach the caller.
    expect(out).toContain('from summaries')
    expect(out).toContain('from chunks')
    expect(tried).toContain('NATURAL_LANGUAGE')
    // ...and the broken one must not have triggered the unscoped last-resort search,
    // which would mean the loop treated "one strategy died" as "all strategies died".
    expect(state.searchCalls.some((c) => c.opts.datasets === undefined && !c.opts.sessionId)).toBe(false)
  })

  test('a THROWING session leg still leaves the graph answer intact', async () => {
    // recallContext merges [sessionResult, graphResult] and filters falsy entries. A
    // session leg that throws must contribute '' (not abort), so a user whose session
    // has no history yet still gets their graph memory.
    state.client = fakeClient()
    state.searchImpl = (_q: any, opts: any) => {
      if (opts.sessionId) throw new Error('no session history')
      return opts.searchType === 'SUMMARIES' ? 'graph fact' : null
    }
    const out = await recallContext({ query: 'sales', sessionId: 's1' })
    expect(out).toBe('graph fact')
  })

  test('a false has() is advisory on the session leg too — memory is still searched', async () => {
    // The measured incident silenced BOTH legs at once. This pins the session leg
    // specifically when a sessionId IS present, because that is the shape the chat
    // route uses and the one the original guard killed first.
    state.client = fakeClient({ datasets: { has: async () => false } })
    state.searchImpl = (_q: any, opts: any) => (opts.sessionId ? 'earlier turn' : null)
    const out = await recallContext({ query: 'sales', sessionId: 'sess-false' })
    expect(out).toBe('earlier turn')
    expect(state.searchCalls.length).toBeGreaterThan(0)
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

// ===========================================================================
// The session cache's TTL and capacity, and recallFromSession's degradation
// ===========================================================================
//
// MEASURED: one recallContext() issues FOUR searches -- three graph strategies
// (SUMMARIES, CHUNKS, NATURAL_LANGUAGE) plus the session strategy -- and the merged
// text repeats a strategy's output verbatim when several return the same string
// ("one result\none result"). My first draft assumed a single result, so five
// assertions were wrong against working code. The facts below come from a dump.

/** The merged recall text for the stub, which returns `v` for every strategy. */
const merged = (v: string) => `${v}\n${v}`

describe('session cache — TTL and capacity', () => {

  test('a cached answer is reused without a second cognee search', async () => {
    // The cache exists to avoid a round-trip for a repeated question within a
    // session, which is the common UI pattern (a user re-asking after an edit).
    state.client = fakeClient()
    state.searchImpl = () => ['remembered fact']
    const first = await recallContext({ query: 'same question', sessionId: 's1' })
    expect(first).toBe(merged('remembered fact'))
    const afterFirst = state.searchCalls.length
    const second = await recallContext({ query: 'same question', sessionId: 's1' })
    expect(second).toBe(first)
    // NOT ONE more call of any kind: a cache hit short-circuits everything.
    expect(state.searchCalls.length).toBe(afterFirst)
  })

  test('an EXPIRED entry is dropped and the query is re-run', async () => {
    // Lines 63-64. Past SESSION_CACHE_TTL the entry must be discarded, otherwise a
    // conversation that has moved on keeps getting an answer from a minute ago.
    const realNow = Date.now
    state.client = fakeClient()
    let answer = 'first answer'
    state.searchImpl = () => [answer]
    try {
      expect(await recallContext({ query: 'q', sessionId: 's-ttl' })).toBe(merged('first answer'))
      const before = state.searchCalls.length
      // Move past the 60s TTL.
      Date.now = () => realNow() + 61_000
      answer = 'second answer'
      expect(await recallContext({ query: 'q', sessionId: 's-ttl' })).toBe(merged('second answer'))
      expect(state.searchCalls.length).toBeGreaterThan(before)
    } finally {
      Date.now = realNow
    }
  })

  test('a FRESH entry is NOT re-run, so the TTL test above is not passing by accident', async () => {
    // The inverse at 59s, so the suite distinguishes "expired" from "always re-runs".
    const realNow = Date.now
    state.client = fakeClient()
    let answer = 'first answer'
    state.searchImpl = () => [answer]
    try {
      await recallContext({ query: 'q', sessionId: 's-fresh' })
      const before = state.searchCalls.length
      Date.now = () => realNow() + 59_000
      answer = 'second answer'
      expect(await recallContext({ query: 'q', sessionId: 's-fresh' })).toBe(merged('first answer'))
      expect(state.searchCalls.length).toBe(before)
    } finally {
      Date.now = realNow
    }
  })

  test('at CAPACITY the OLDEST entry is evicted, keeping the cache bounded', async () => {
    // Lines 74-75. Without eviction a long session grows the Map without limit; the
    // eviction is by insertion order, so the FIRST key is the one dropped.
    // SESSION_CACHE_MAX is 100, so the 101st distinct question must push out the 1st.
    state.client = fakeClient()
    state.searchImpl = (q: string) => [`answer for ${q}`]
    for (let i = 0; i < 100; i++) {
      await recallContext({ query: `question ${i}`, sessionId: 's-cap' })
    }
    // The very first question is still cached (nothing evicted yet).
    const beforeRevisit = state.searchCalls.length
    expect(await recallContext({ query: 'question 0', sessionId: 's-cap' }))
      .toBe(merged('answer for question 0'))
    expect(state.searchCalls.length).toBe(beforeRevisit)

    // One more distinct question fills past the cap and evicts the oldest.
    await recallContext({ query: 'question 100', sessionId: 's-cap' })
    const afterInsert = state.searchCalls.length
    // `question 0` was the oldest, so re-asking it must MISS and search again.
    expect(await recallContext({ query: 'question 0', sessionId: 's-cap' }))
      .toBe(merged('answer for question 0'))
    expect(state.searchCalls.length).toBeGreaterThan(afterInsert)
  })

  test('clearSessionCache(sessionId) drops only THAT session', async () => {
    state.client = fakeClient()
    state.searchImpl = () => ['v']
    await recallContext({ query: 'q', sessionId: 'keep' })
    await recallContext({ query: 'q', sessionId: 'drop' })
    clearSessionCache('drop')
    const before = state.searchCalls.length
    // 'keep' still hits its cache.
    await recallContext({ query: 'q', sessionId: 'keep' })
    expect(state.searchCalls.length).toBe(before)
    // 'drop' must search again.
    await recallContext({ query: 'q', sessionId: 'drop' })
    expect(state.searchCalls.length).toBeGreaterThan(before)
  })
})

describe('recallFromSession — degradation', () => {
  test('a THROWING session search degrades to empty instead of failing the chat', async () => {
    // Lines 190-197. Session search before the first cognify is expected to fail;
    // the recall must return '' so the graph strategy can still contribute rather
    // than the whole chat turn erroring. The graph text alone must come back.
    state.client = fakeClient({
      search: async (q: any, opts: any) => {
        state.searchCalls.push({ q, opts })
        // The SESSION strategy is the one passing sessionId.
        if (opts?.sessionId) throw new Error('dataset not found')
        return ['from graph']
      },
    })
    // MEASURED: the graph text appears ONCE here, not twice as in the capacity
    // tests. recallFromGraph dedupes identical strategy outputs, and with a THROWING
    // session strategy the session text is '' so it is filtered out. Asserting the
    // exact string (not ) is what pins that difference.
    expect(await recallContext({ query: 'q', sessionId: 's-throw' })).toBe('from graph')
  })

  test('an UNEXPECTED session-search error still degrades to empty', async () => {
    // The regex only decides whether to WARN; the return value is the same.
    state.client = fakeClient({
      search: async (q: any, opts: any) => {
        state.searchCalls.push({ q, opts })
        if (opts?.sessionId) throw new Error('connection reset by peer')
        return ['graph content']
      },
    })
    expect(await recallContext({ query: 'q', sessionId: 's-unexpected' })).toBe('graph content')
  })
})
