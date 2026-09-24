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
  // Which graph backend the client reports. Defaults to 'kuzu' because that is the local
  // default and the case where NATURAL_LANGUAGE must be skipped.
  graphProvider: 'kuzu' as string | null,
  // The backend switch. `null` (the default here) keeps EVERY pre-existing test on the
  // in-process SDK path, so adding the server tests below cannot change their behavior;
  // an object switches cognee-memory.ts to the HTTP transport.
  serverOptions: null as any,
  // The HTTP transport's own call log. Separate from `rememberCalls`/`searchCalls` so a
  // test can assert "the SDK was NEVER touched" by checking these are the only ones filled.
  httpRememberCalls: [] as any[],
  httpRecallCalls: [] as any[],
  httpRememberImpl: null as any,
  httpRecallImpl: null as any,
}

mock.module('./cognee-core', () => ({
  isCogneeEnabled: async () => state.enabled,
  getCogneeClient: async () => state.client,
  getCogneeOwnerId: () => state.owner,
  // The second backend. This export was simply MISSING from this mock, which made the
  // server branch below unreachable and is why the file's measured coverage fell from
  // 73.0% (146/200) to 56.5% (153/271) when the branch landed.
  getCogneeServerOptions: async () => state.serverOptions,
  // The graph-backend gate. Driven by `state.graphProvider` so BOTH branches are reachable
  // in-process; the real predicate is unit-tested in cognee-core.test.ts.
  getCogneeGraphProvider: async () => state.graphProvider,
  supportsNaturalLanguageSearch: (p: string | null) => p !== 'kuzu',
  withDeadline: (promise: Promise<unknown>) => promise,
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
// The HTTP transport. Spied rather than faked at the `fetch` layer so a test can assert
// on the ACTUAL arguments cognee-memory.ts builds (dataset, runInBackground, the text
// payload) — a fetch-level stub would only show the serialized form.
mock.module('./cognee-http', () => ({
  cogneeRemember: async (opts: any, args: any) => {
    state.httpRememberCalls.push({ opts, args })
    if (state.httpRememberImpl) return state.httpRememberImpl(opts, args)
    return null
  },
  cogneeRecall: async (opts: any, args: any) => {
    state.httpRecallCalls.push({ opts, args })
    if (state.httpRecallImpl) return state.httpRecallImpl(opts, args)
    return null
  },
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
  // `graphProvider` is reset too: it was left mutable across tests until the server block
  // below, where a stale 'postgres' silently changes which SDK strategies the
  // "SDK path is still used" guard observes. Each SDK-path test that cares sets it itself.
  state.graphProvider = 'kuzu'
  state.rememberCalls = []
  state.searchCalls = []
  state.searchImpl = null
  // Back to the SDK backend between tests: the server tests opt in per test, so a stale
  // object cannot silently move an SDK-path test onto the HTTP path.
  state.serverOptions = null
  state.httpRememberCalls = []
  state.httpRecallCalls = []
  state.httpRememberImpl = null
  state.httpRecallImpl = null
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

  test('stores the turn as JSON text against the org dataset (HTTP transport)', async () => {
    // The payload SHAPE is the part worth keeping, and it is unchanged: the server
    // receives the same JSON document the SDK used to. What moved is the transport, so
    // this asserts through `httpRememberCalls`. We keep the assertion because the shape is
    // what makes a stored turn reconstructable — both messages, the session, the tools —
    // and it would be easy to lose a field while swapping transports.
    state.serverOptions = { baseUrl: 'http://cognee:8000', timeoutMs: 1000 }
    await rememberChatTurn({
      userMessage: 'what is the revenue',
      aiMessage: 'Rp 5m',
      sessionId: 's1',
      toolRuns: [{ type: 'SQL', status: 'success', latencyMs: 12 }],
    })
    expect(state.httpRememberCalls).toHaveLength(1)
    // The mock records the ARGUMENTS the real client builds (`{ opts, args }`), which is
    // the point of stubbing at this layer rather than at fetch: the payload shape is
    // visible before serialization.
    const call = state.httpRememberCalls[0] as { args: { texts: string[]; datasetName: string } }
    expect(call.args.datasetName).toBe('org:acme')
    const payload = JSON.parse(call.args.texts[0])
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
      expect(['SUMMARIES', 'CHUNKS', 'NATURAL_LANGUAGE', 'CHUNKS_LEXICAL']).toContain(t)
    }
  })

  test('on kuzu NATURAL_LANGUAGE is SKIPPED, not attempted and failed', async () => {
    // MEASURED: it cannot succeed there ("generated Cypher that this graph backend rejected
    // on all 3 attempt(s)"), so before the gate every turn paid the attempt — 6039ms plus its
    // own LLM call — for a strategy with a zero success rate. CHUNKS_LEXICAL was measured
    // WORKING on kuzu (41ms) and takes its place.
    state.graphProvider = 'kuzu'
    state.client = fakeClient()
    state.searchImpl = () => 'x'
    await recallContext({ query: 'sales' })
    const used = state.searchCalls.map((c) => c.opts.searchType).filter(Boolean)
    expect(used).not.toContain('NATURAL_LANGUAGE')
    expect(used).toContain('CHUNKS_LEXICAL')
    expect(used).toContain('SUMMARIES')
    expect(used).toContain('CHUNKS')
  })

  test('on postgres NATURAL_LANGUAGE IS attempted (the gate is backend-specific)', async () => {
    // The gate must not delete a strategy that a different backend may serve. On postgres the
    // Cypher path is the backend's own language, so the attempt is kept.
    state.graphProvider = 'postgres'
    state.client = fakeClient()
    state.searchImpl = () => 'x'
    await recallContext({ query: 'sales' })
    const used = state.searchCalls.map((c) => c.opts.searchType).filter(Boolean)
    expect(used).toContain('NATURAL_LANGUAGE')
    expect(used).not.toContain('CHUNKS_LEXICAL')
  })

  test('an UNREADABLE backend stays optimistic — it must not silently drop a strategy', async () => {
    // `null` means the settings could not be read. Dropping NATURAL_LANGUAGE on an unknown
    // backend would lose a strategy that might have worked, so the gate only skips on kuzu.
    state.graphProvider = null
    state.client = fakeClient()
    state.searchImpl = () => 'x'
    await recallContext({ query: 'sales' })
    const used = state.searchCalls.map((c) => c.opts.searchType).filter(Boolean)
    expect(used).toContain('NATURAL_LANGUAGE')
  })

  test('NATURAL_LANGUAGE failing does NOT lose SUMMARIES/CHUNKS', async () => {
    // The strategy is known-broken on the local kuzu backend (it emits Cypher the
    // backend rejects on every retry) and is kept ONLY because the loop isolates each
    // strategy. The sibling test above throws from the FIRST strategy; this throws
    // from the LAST, which is the order the live pipeline actually hits — and it is
    // the order where a naive `for … await` without a per-iteration catch would throw
    // away the two answers already collected.
    // Forced onto postgres so the broken strategy is actually attempted: on kuzu the gate now
    // skips it entirely, which is the subject of the test above. This one remains valuable
    // because a backend where it IS attempted can still reject it at runtime.
    state.graphProvider = 'postgres'
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

  test('an OVERSIZED memory result is capped before it reaches a prompt', async () => {
    // Memory was the only uncapped context-injection path: the merge is an unbounded join and
    // the result is interpolated into up to six prompts per turn, so a large dataset could push
    // the user's real question out of the window. Sibling context (buildSourceGuidance) was
    // already capped at 2000, so this asserts memory now matches.
    const { MEMORY_CONTEXT_MAX_CHARS } = await import('@/lib/constants')
    state.client = fakeClient()
    state.searchImpl = () => 'M'.repeat(20_000)
    const out = await recallContext({ query: 'sales' })
    // Truncated to the budget, plus the marker that makes the loss visible to the model.
    expect(out.length).toBeLessThan(MEMORY_CONTEXT_MAX_CHARS + 40)
    expect(out).toContain('[memory truncated]')
    expect(out.slice(0, 50)).toBe('M'.repeat(50))
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

// ===========================================================================
// The HTTP server backend (`getCogneeServerOptions()` returning an object)
// ===========================================================================
//
// cognee-memory.ts gained a SECOND backend: with COGNEE_SERVER_URL set, memory goes over
// HTTP (cognee-http.ts) to a cognee 1.5.4 server instead of through the in-process SDK,
// and the server is the SHIPPED default for compose installs (AGENTS.md: "Two backends,
// one switch"). None of that was reachable from this file: the cognee-core mock predates
// the branch and never exported `getCogneeServerOptions`, which is exactly why the file's
// merged coverage dropped from 73.0% (146/200 lines) to 56.5% (153/271) when it landed.
// The branch carries its own copy of the write payload and its own degradation contract,
// so it needed its own tests rather than inheriting the SDK ones. The strategy pair is
// also DIFFERENT here: the server path asks SUMMARIES then CHUNKS and nothing else, so the
// graph-backend gate and the last-resort unscoped search do not apply to it.
const SERVER_OPTS = { baseUrl: 'http://cognee:8000', timeoutMs: 30000 }

describe('rememberChatTurn — server backend', () => {
  test('writes over HTTP with the server options, and NEVER through the SDK client', async () => {
    // What this pins is that the switch is EXCLUSIVE. A regression that fell through to
    // the SDK as well would double-write every turn (and, on the 0.2.0 binding, take the
    // whole store down — scripts/cognee-upgrade-check.md), so `state.client` is installed
    // here purely to prove nothing touches it.
    state.serverOptions = SERVER_OPTS
    state.client = fakeClient()
    state.httpRememberImpl = () => ({ status: 'ok' })

    await rememberChatTurn({
      userMessage: 'what is the revenue',
      aiMessage: 'Rp 5m',
      sessionId: 's1',
      toolRuns: [{ type: 'SQL', status: 'success', latencyMs: 12 }],
    })

    expect(state.httpRememberCalls).toHaveLength(1)
    const { opts, args } = state.httpRememberCalls[0]
    expect(opts).toBe(SERVER_OPTS)
    expect(args.datasetName).toBe('org:acme')
    // `false`, not undefined: a backgrounded server write returns before the data is
    // searchable, so the very next turn's recall would miss the fact just "stored".
    expect(args.runInBackground).toBe(false)
    expect(args.texts).toHaveLength(1)
    const payload = JSON.parse(args.texts[0])
    expect(payload.type).toBe('chat_turn')
    expect(payload.user).toBe('what is the revenue')
    expect(payload.assistant).toBe('Rp 5m')
    expect(payload.sessionId).toBe('s1')
    expect(payload.tools).toHaveLength(1)
    expect(typeof payload.ts).toBe('number')
    expect(state.rememberCalls).toHaveLength(0)
  })

  test('a null HTTP result still returns without throwing', async () => {
    // cognee-http.ts returns null (not an error object) when the server is unreachable and
    // does not throw, so this is the shape a server outage actually takes. The branch must
    // still warn rather than blow up: `res.error` is read only after `!res` is excluded.
    state.serverOptions = SERVER_OPTS
    state.httpRememberImpl = () => null
    await expect(
      rememberChatTurn({ userMessage: 'a', aiMessage: 'b', sessionId: 's1', toolRuns: [] }),
    ).resolves.toBeUndefined()
    expect(state.httpRememberCalls).toHaveLength(1)
  })

  test('a THROWING server remember is swallowed — a memory failure must not fail the chat', async () => {
    // The guarantee this whole module carries, asserted on the server path too: whatever
    // the transport does (DNS failure, TLS error, a bug in the transport itself), the
    // caller's response is already computed and memory loss must stay non-fatal.
    state.serverOptions = SERVER_OPTS
    state.httpRememberImpl = () => { throw new Error('cognee server down') }
    await expect(
      rememberChatTurn({ userMessage: 'a', aiMessage: 'b', sessionId: 's1', toolRuns: [] }),
    ).resolves.toBeUndefined()
    expect(state.httpRememberCalls).toHaveLength(1)
  })

  test('a REJECTED server remember is swallowed as well (async failure, not a sync throw)', async () => {
    // `cogneeRemember` is `async`, so a real transport failure (a rejected fetch) arrives as
    // a rejected promise rather than a synchronous throw. This is the shape the live path
    // actually produces; the same try/catch must cover both.
    state.serverOptions = SERVER_OPTS
    state.httpRememberImpl = () => Promise.reject(new Error('ECONNREFUSED'))
    await expect(
      rememberChatTurn({ userMessage: 'a', aiMessage: 'b', sessionId: 's1', toolRuns: [] }),
    ).resolves.toBeUndefined()
    expect(state.httpRememberCalls).toHaveLength(1)
  })
})

describe('recallContext — server backend', () => {
  test('merges the recall hits of both strategies, with the head deduped', async () => {
    // recallFromServer asks SUMMARIES then CHUNKS, maps each hit to `h.text` and joins.
    // MEASURED fact behind the strategy pair: HYBRID_COMPLETION (the server default)
    // returns ONE LLM-synthesized answer, so `hits.length` is not a recall count and an
    // individual fact can be lost inside the re-wording. Both strategies are given text
    // with a DIFFERENT head here, because dedupeJoin keys on the first 100 chars: two
    // outputs sharing a head collapse to one (the session-cache test below pins that).
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = (_opts: any, args: any) =>
      args.searchType === 'SUMMARIES' ? [{ text: `summary fact ${'s'.repeat(120)}` }] : [{ text: 'chunk fact' }]

    const out = await recallContext({ query: 'sales' })
    expect(out).toBe(`summary fact ${'s'.repeat(120)}\nchunk fact`)
    expect(state.httpRecallCalls).toHaveLength(2)
    expect(state.httpRecallCalls.map((c) => c.args.searchType)).toEqual(['SUMMARIES', 'CHUNKS'])
    const { opts, args } = state.httpRecallCalls[0]
    expect(opts).toBe(SERVER_OPTS)
    expect(args.query).toBe('sales')
    expect(args.datasets).toEqual(['org:acme'])
    expect(args.topK).toBe(5)
  })

  test('identical strategy outputs are deduped on the server path too', async () => {
    // dedupeJoin runs AFTER recallFromServer, not before it, so a server that answers both
    // strategies with the same text must contribute it ONCE. Injecting it twice inflates
    // the memory block and pushes the user's real question out of the prompt window.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'the identical answer text' }]
    expect(await recallContext({ query: 'sales' })).toBe('the identical answer text')
    // Both strategies were still tried — the dedupe is not a skipped request.
    expect(state.httpRecallCalls).toHaveLength(2)
  })

  test('two hits from ONE strategy are joined into that strategy\'s block', async () => {
    // CHUNKS is the strategy that returns the stored items as SEPARATE hits (the whole
    // reason it is used instead of HYBRID_COMPLETION), so both must survive.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'fact one' }, { text: 'fact two' }]
    expect(await recallContext({ query: 'sales' })).toBe('fact one\nfact two')
  })

  test('a null from every strategy is an empty string, not a throw', async () => {
    // `cogneeRecall` answers null both for an unreachable server and for a non-ok response;
    // `hits?.length` skips both, so a memory outage degrades to "no memory context" rather
    // than reaching the prompt as the string "undefined".
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => null
    expect(await recallContext({ query: 'sales' })).toBe('')
  })

  test('an EMPTY hit list is an empty string too', async () => {
    // A reachable server with nothing stored answers [] — a different shape from null,
    // and one that must not become a phantom "memory" line in the prompt.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => []
    expect(await recallContext({ query: 'sales' })).toBe('')
  })

  test('a hit with no text is not injected as an empty line', async () => {
    // The hit shape is `{ text?: string }`, so a metadata-only hit must not contribute a
    // blank line: `hits.map((h) => h.text ?? '').filter(Boolean)` drops it, and a
    // strategy left with nothing is skipped entirely.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = (_opts: any, args: any) =>
      args.searchType === 'SUMMARIES' ? [{ score: 0.9 }] : [{ text: 'chunk fact' }]
    expect(await recallContext({ query: 'sales' })).toBe('chunk fact')
  })

  test('one dead strategy does not lose the other', async () => {
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = (_opts: any, args: any) => {
      if (args.searchType === 'SUMMARIES') throw new Error('SUMMARIES unsupported')
      return [{ text: 'chunk fact' }]
    }
    expect(await recallContext({ query: 'sales' })).toBe('chunk fact')
  })

  test('the server path caps an oversized result before it reaches a prompt', async () => {
    // capMemory bounds BOTH backends. Memory is interpolated into up to six prompts per
    // turn, so an unbounded server answer could push the user's question out of the window.
    const { MEMORY_CONTEXT_MAX_CHARS } = await import('@/lib/constants')
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'M'.repeat(20_000) }]
    const out = await recallContext({ query: 'sales' })
    expect(out.length).toBeLessThan(MEMORY_CONTEXT_MAX_CHARS + 40)
    expect(out).toContain('[memory truncated]')
  })

  test('an identical repeat question in the same session does NOT recall twice', async () => {
    // The session cache sits ABOVE the backend switch in recallContext, so it must cover
    // the server path too — otherwise every repeat question pays a fresh HTTP round-trip
    // to a server whose recall is measured at ~4.3s.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'remembered fact' }]
    const first = await recallContext({ query: 'revenue', sessionId: 's-server-cache' })
    // MEASURED from the source, not assumed: both strategies returned the same head, and
    // dedupeJoin collapses them, so the cached string is the text ONCE (not twice).
    expect(first).toBe('remembered fact')
    const afterFirst = state.httpRecallCalls.length
    const second = await recallContext({ query: 'revenue', sessionId: 's-server-cache' })
    expect(second).toBe(first)
    expect(state.httpRecallCalls.length).toBe(afterFirst)
  })

  test('the sessionId reaches the server recall (3rd position in recallFromServer)', async () => {
    // recallFromServer(opts, query, sessionId) forwards the id into cogneeRecall's args as
    // `sessionId`. Dropping it would silently degrade every server recall to global-scope
    // memory: still "working", just no longer session-aware.
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'from session' }]
    await recallContext({ query: 'sales', sessionId: 'sess-77' })
    expect(state.httpRecallCalls.length).toBeGreaterThan(0)
    for (const call of state.httpRecallCalls) {
      expect(call.args.sessionId).toBe('sess-77')
    }
  })

  test('without a sessionId nothing is cached and the server still supplies the answer', async () => {
    state.serverOptions = SERVER_OPTS
    state.httpRecallImpl = () => [{ text: 'answer' }]
    expect(await recallContext({ query: 'revenue' })).toBe('answer')
    const before = state.httpRecallCalls.length
    await recallContext({ query: 'revenue' })
    expect(state.httpRecallCalls.length).toBeGreaterThan(before)
  })
})

describe('the SDK branch is a TEST SEAM — unreachable in production, exercised here', () => {
  // CORRECTED, twice, and the corrections are the point.
  //
  // This block first asserted "serverOptions === null calls the SDK and NEVER the HTTP
  // transport" — the fallback contract. When the bindings were removed I inverted it to
  // "no server means nothing is written and nothing is read", and that failed: the branch
  // IS still there, and this file's fake client reaches it.
  //
  // The truth is narrower than either. `getCogneeClient()` returns null in every real
  // deployment, so the branch is dead in production — but it is deliberately KEPT as the
  // seam that ~30 tests in this file exercise (multi-strategy merge, session cache TTL and
  // capacity, dedupe, prompt cap, degradation paths). Those behaviours must keep working if
  // a client is ever restored, and deleting the branch deleted their subject.
  //
  // So the property worth pinning is that a deployment with no server gets an EMPTY
  // context, not that the SDK is unreachable in a file that injects it by design.
  test('with no server configured the HTTP transport is never used', async () => {
    state.serverOptions = null
    state.client = fakeClient()
    state.searchImpl = () => 'graph answer'

    await rememberChatTurn({ userMessage: 'a', aiMessage: 'b', sessionId: 's1', toolRuns: [] })
    // The HTTP path must not be dialled for lack of a server: there is no address, and
    // guessing one is how a stale config would send memory to the wrong place.
    expect(state.httpRememberCalls).toHaveLength(0)
    expect(state.httpRecallCalls).toHaveLength(0)
    // The stub client is reached, because that is this suite's seam. In production
    // `getCogneeClient()` returns null and the caller gets '' instead.
    expect(await recallContext({ query: 'sales' })).toBe('graph answer')
  })

  test('the production shape: a null client degrades to empty, never to an HTTP guess', async () => {
    // This is what a real deployment without COGNEE_SERVER_URL actually experiences —
    // no client AND no server, so recall is empty and no request is made anywhere.
    state.serverOptions = null
    state.client = null
    expect(await recallContext({ query: 'sales' })).toBe('')
    expect(state.httpRecallCalls).toHaveLength(0)
    expect(state.searchCalls).toHaveLength(0)
  })
})


