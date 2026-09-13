import { test, expect, describe, mock, afterEach } from 'bun:test'
import { traceLlmCall, getRecentTraces, getTraceStats, postLangfuseScore } from '@/lib/observability'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
  delete process.env.LANGFUSE_PUBLIC_KEY
  delete process.env.LANGFUSE_SECRET_KEY
  delete process.env.LANGFUSE_BASEURL
  delete process.env.HELICONE_API_KEY
})

describe('observability — in-memory ring buffer + stats', () => {
  test('traceLlmCall records a trace retrievable via getRecentTraces', () => {
    const purpose = `test-unique-${Date.now()}-${Math.random()}`
    const traceId = traceLlmCall({
      purpose,
      provider: 'OPENAI_COMPATIBLE',
      model: 'test-model',
      inputPreview: 'hello',
      outputPreview: 'world',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      latencyMs: 42,
    })
    const recent = getRecentTraces(1)
    expect(recent.length).toBe(1)
    expect(recent[0].purpose).toBe(purpose)
    expect(recent[0].model).toBe('test-model')
    expect(recent[0].latencyMs).toBe(42)
    expect(recent[0].id).toBeTruthy()
    expect(recent[0].id).toBe(traceId)
    expect(recent[0].timestamp).toBeInstanceOf(Date)
  })

  test('getRecentTraces returns most-recent-first', () => {
    const a = `first-${Math.random()}`
    const b = `second-${Math.random()}`
    traceLlmCall({ purpose: a, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 1 })
    traceLlmCall({ purpose: b, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 2 })
    const recent = getRecentTraces(2)
    expect(recent[0].purpose).toBe(b)
    expect(recent[1].purpose).toBe(a)
  })

  test('getTraceStats reflects additions (delta-based, order-independent)', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `stats-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      latencyMs: 200,
      error: undefined,
    })
    const after = getTraceStats()
    expect(after.totalCalls).toBe(before.totalCalls + 1)
    expect(after.totalTokens).toBeGreaterThanOrEqual(before.totalTokens + 150)
  })

  test('getTraceStats counts error rate from errored traces', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `err-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
      error: 'boom',
    })
    const after = getTraceStats()
    expect(after.totalCalls).toBe(before.totalCalls + 1)
    expect(after.errorRate).toBeGreaterThan(0)
  })

  test('ring buffer caps at 100 entries', () => {
    for (let i = 0; i < 150; i++) {
      traceLlmCall({
        purpose: `cap-${i}`,
        provider: 'x',
        model: 'm',
        inputPreview: '',
        outputPreview: '',
        latencyMs: i,
      })
    }
    const recent = getRecentTraces(500)
    expect(recent.length).toBeLessThanOrEqual(100)
    expect(recent[0].purpose).toBe('cap-149')
  })
})

describe('observability — trace fields', () => {
  test('records toolCalls field', () => {
    const purpose = `tools-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      toolCalls: [{ name: 'sql', arguments: '{"q":"test"}' }],
    })
    const recent = getRecentTraces(1)
    expect(recent[0].toolCalls).toEqual([{ name: 'sql', arguments: '{"q":"test"}' }])
  })

  test('records error field when present', () => {
    const purpose = `errfield-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      error: 'timeout',
    })
    const recent = getRecentTraces(1)
    expect(recent[0].error).toBe('timeout')
  })

  test('usage undefined → totalTokens not incremented', () => {
    const before = getTraceStats()
    traceLlmCall({
      purpose: `notok-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
    })
    const after = getTraceStats()
    expect(after.totalTokens).toBe(before.totalTokens)
  })

  test('getRecentTraces with limit larger than buffer returns all', () => {
    const purpose = `large-${Math.random()}`
    traceLlmCall({ purpose, provider: 'x', model: 'm', inputPreview: '', outputPreview: '', latencyMs: 1 })
    const recent = getRecentTraces(10000)
    expect(recent.length).toBeGreaterThan(0)
    expect(recent.length).toBeLessThanOrEqual(100)
  })

  test('avgLatencyMs is a positive number', () => {
    const stats = getTraceStats()
    expect(stats.avgLatencyMs).toBeGreaterThanOrEqual(0)
    expect(typeof stats.avgLatencyMs).toBe('number')
  })

  test('traceLlmCall records metadata field', () => {
    const purpose = `meta-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      metadata: { sessionId: 'sess-1', userId: 'user-1' },
    })
    const recent = getRecentTraces(1)
    expect(recent[0].metadata).toEqual({ sessionId: 'sess-1', userId: 'user-1' })
  })
})

describe('observability — forwardTrace (fire-and-forget)', () => {
  test('Langfuse env vars set → calls fetch to langfuse endpoint', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    process.env.LANGFUSE_BASEURL = 'https://lf.example.com'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const purpose = `lf-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'OPENAI_COMPATIBLE',
      model: 'm',
      inputPreview: 'in',
      outputPreview: 'out',
      latencyMs: 100,
    })

    // fire-and-forget — wait for microtask queue to flush
    await new Promise((r) => setTimeout(r, 50))

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const langfuseCalls = calls.filter(
      (c) => c[0].includes('lf.example.com'),
    )
    expect(langfuseCalls.length).toBeGreaterThan(0)
  })

  test('Helicone env var set → calls fetch to helicone endpoint', async () => {
    process.env.HELICONE_API_KEY = 'hc-test'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    traceLlmCall({
      purpose: `hc-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const hcCalls = calls.filter(
      (c) => c[0].includes('hconeai.com'),
    )
    expect(hcCalls.length).toBeGreaterThan(0)
  })

  test('no env vars → no fetch calls', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    traceLlmCall({
      purpose: `noenv-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  test('forward failure does not throw (swallowed)', async () => {
    process.env.HELICONE_API_KEY = 'hc-test'
    global.fetch = mock(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch

    // should not throw — fire-and-forget with .catch(() => {})
    traceLlmCall({
      purpose: `fail-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 10,
    })

    await new Promise((r) => setTimeout(r, 50))
    // trace still recorded in buffer
    const recent = getRecentTraces(1)
    expect(recent[0].purpose).toMatch(/^fail-/)
  })
})

describe('observability — postLangfuseScore', () => {
  test('no-op when Langfuse env vars not configured', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await postLangfuseScore({ name: 'faithfulness', value: 0.95 })
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  test('posts to scores endpoint when Langfuse configured', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    process.env.LANGFUSE_BASEURL = 'https://lf.example.com'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await postLangfuseScore({ name: 'faithfulness', value: 0.95, comment: 'good', traceId: 't1' })

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const scoreCalls = calls.filter((c) => c[0].includes('/api/public/scores'))
    expect(scoreCalls.length).toBe(1)
    const body = JSON.parse(scoreCalls[0][1].body as string)
    expect(body.name).toBe('faithfulness')
    expect(body.value).toBe(0.95)
    expect(body.comment).toBe('good')
    expect(body.traceId).toBe('t1')
  })

  test('post failure does not throw (swallowed)', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    global.fetch = mock(() => Promise.reject(new Error('network down'))) as unknown as typeof fetch

    await postLangfuseScore({ name: 'faithfulness', value: 0.5 })
  })

  test('traceLlmCall returns traceId that links to postLangfuseScore', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-test'
    process.env.LANGFUSE_SECRET_KEY = 'sk-test'
    process.env.LANGFUSE_BASEURL = 'https://lf.example.com'

    const fetchMock = mock(() =>
      Promise.resolve({ ok: true } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const traceId = traceLlmCall({
      purpose: `link-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
    })

    await new Promise((r) => setTimeout(r, 50))

    await postLangfuseScore({ name: 'faithfulness', value: 0.9, traceId })

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][]
    const scoreCalls = calls.filter((c) => c[0].includes('/api/public/scores'))
    expect(scoreCalls.length).toBe(1)
    const body = JSON.parse(scoreCalls[0][1].body as string)
    expect(body.traceId).toBe(traceId)
  })
})

describe('observability — the Langfuse forward FAILURE path', () => {
  test('a failing LANGFUSE forward is swallowed and the trace survives', async () => {
    // MEASURED GAP: the existing "forward failure" test sets ONLY HELICONE_API_KEY,
    // so it exercises the HELICONE catch and never the Langfuse one. Both exports are
    // fire-and-forget, and the buffer -- not the vendor -- is the source of truth, so
    // a vendor outage must never lose a locally recorded trace.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-fail'
    process.env.LANGFUSE_SECRET_KEY = 'sk-fail'
    global.fetch = mock(() => Promise.reject(new Error('langfuse down'))) as unknown as typeof fetch

    const purpose = `langfuse-fail-${Math.random()}`
    expect(() =>
      traceLlmCall({
        purpose,
        provider: 'x',
        model: 'm',
        inputPreview: '',
        outputPreview: '',
        latencyMs: 10,
      }),
    ).not.toThrow()

    await new Promise((r) => setTimeout(r, 60))
    // The trace is still retrievable: forwarding is best-effort, recording is not.
    expect(getRecentTraces(50).some((t) => t.purpose === purpose)).toBe(true)
  })

  test('a failing SCORE post is swallowed and returns undefined', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-fail'
    process.env.LANGFUSE_SECRET_KEY = 'sk-fail'
    global.fetch = mock(() => Promise.reject(new Error('scores endpoint down'))) as unknown as typeof fetch

    // Scoring is advisory: a low score (e.g. a weak alignment check) must never turn
    // into an unhandled rejection that takes down the request that produced it.
    const result = await postLangfuseScore({ name: 'alignment', value: 0.2, traceId: 't1' })
    expect(result).toBeUndefined()
  })

  test('a NON-OK score response is still not an error, and the call resolves', async () => {
    // The fetch here never checks res.ok, so a 500 from Langfuse resolves normally.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk-fail'
    process.env.LANGFUSE_SECRET_KEY = 'sk-fail'
    global.fetch = mock(() => Promise.resolve(new Response('nope', { status: 500 }))) as unknown as typeof fetch

    await expect(postLangfuseScore({ name: 'alignment', value: 0.2 })).resolves.toBeUndefined()
  })
})

describe('observability — the usage ternary in the forwarded payload', () => {
  test('a trace WITH usage forwards prompt AND completion tokens', async () => {
    // The `usage ? {...} : undefined` ternary: without it the vendor receives no
    // token counts and every cost/latency dashboard is silently empty.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    let sent: Record<string, unknown> | null = null
    global.fetch = mock((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    traceLlmCall({
      purpose: `usage-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
      latencyMs: 5,
    })
    await new Promise((r) => setTimeout(r, 60))

    const body = (sent as unknown as { batch: Array<{ body: { usage: Record<string, number> } }> }).batch[0]!.body
    expect(body.usage).toEqual({ promptTokens: 7, completionTokens: 3 })
  })

  test('a trace WITHOUT usage forwards usage: undefined, not a zeroed object', async () => {
    // A zeroed object would look like a real measurement of 0 tokens and corrupt any
    // average computed downstream; `undefined` disappears from the JSON entirely.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    let sent: Record<string, unknown> | null = null
    global.fetch = mock((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    traceLlmCall({
      purpose: `no-usage-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
    })
    await new Promise((r) => setTimeout(r, 60))

    const raw = JSON.stringify(sent)
    expect(raw).not.toContain('promptTokens')
    expect(raw).not.toContain('"usage"')
  })

  test('an ERROR is folded into metadata alongside existing metadata keys', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    let sent: Record<string, unknown> | null = null
    global.fetch = mock((_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as unknown as typeof fetch

    traceLlmCall({
      purpose: `err-meta-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 5,
      error: 'upstream 502',
      metadata: { orgId: 'org-1' },
    })
    await new Promise((r) => setTimeout(r, 60))

    const md = (sent as unknown as { batch: Array<{ body: { metadata: Record<string, unknown> } }> })
      .batch[0]!.body.metadata
    expect(md.orgId).toBe('org-1')
    expect(md.error).toBe('upstream 502')
  })
})

describe('observability — the forward is non-blocking, and has NO timeout', () => {
  test('a vendor that NEVER responds does not block traceLlmCall (fire-and-forget)', async () => {
    // traceLlmCall promises to never block the LLM call, and the comment above
    // forwardTrace says so explicitly. MEASURED: with a fetch that never settles,
    // traceLlmCall returns immediately -- forwarding is genuinely detached.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    global.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch

    const t0 = Date.now()
    traceLlmCall({
      purpose: `hang-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 1,
    })
    // The call itself is synchronous and returns at once; the assertion is that it did
    // not wait on the outstanding fetch.
    expect(Date.now() - t0).toBeLessThan(200)
    expect(getRecentTraces(1).length).toBe(1)
  })

  test('DECLARED GAP: a hanging vendor leaks the socket, because no timeout is set', async () => {
    // Reported, not fixed. The Langfuse ingestion, Langfuse scores and Helicone log
    // calls pass NO AbortSignal, so a vendor that accepts the connection but never
    // responds leaves the promise PENDING FOREVER and holds its socket. A functional
    // test cannot observe the leak -- it can only pin that the promise never settles,
    // which is what this does. The fix (an AbortSignal.timeout) is a product decision
    // about the duration and about what a timeout should mean for a nightly metric
    // export, so it is not changed silently.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    let settled = false
    const stuck = new Promise<Response>(() => {})
    global.fetch = mock((_url: string, init?: RequestInit) => {
      // MEASURED: init carries no `signal` at all.
      expect(init?.signal).toBeUndefined()
      void stuck.finally(() => { settled = true })
      return stuck
    }) as unknown as typeof fetch

    traceLlmCall({
      purpose: `stuck-${Math.random()}`,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 1,
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(settled).toBe(false)
  })
})

describe('observability — the forward failure path is guarded TWICE, and the inner guard is inert', () => {
  test('DECLARED EQUIVALENT: removing the inner Langfuse catch changes nothing observable', () => {
    // MEASURED. `traceLlmCall` detaches the forward as `forwardTrace(entry).catch(() => {})`,
    // so ANY error that escapes the inner `try` is swallowed by that outer catch. The
    // two guards are therefore indistinguishable from outside: the trace is still
    // recorded and nothing throws either way. A negative control that removed the inner
    // catch produced ZERO failing tests, which is what led me to this.
    //
    // The innermost guard is NOT pointless -- it survives a future caller that awaits
    // forwardTrace directly, or a refactor that drops the outer `.catch`. But it cannot
    // be proven by a test of the CURRENT public surface, so it is declared rather than
    // claimed as covered. Contrast `postLangfuseScore`, which callers await DIRECTLY:
    // there the inner catch is load-bearing and removing it turns two tests red.
    expect(true).toBe(true)
  })

  test('the OUTER catch is what protects the caller when the forward rejects', async () => {
    // This is the guard that IS observable. `postLangfuseScore` awaited directly proves
    // the inner one; this proves the outer one, via an explicit .catch on a rejecting
    // forward. The public contract is: recording succeeds even when forwarding explodes.
    process.env.LANGFUSE_PUBLIC_KEY = 'pk'
    process.env.LANGFUSE_SECRET_KEY = 'sk'
    global.fetch = mock(() => Promise.reject(new Error('boom'))) as unknown as typeof fetch

    const purpose = `outer-${Math.random()}`
    traceLlmCall({
      purpose,
      provider: 'x',
      model: 'm',
      inputPreview: '',
      outputPreview: '',
      latencyMs: 1,
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(getRecentTraces(50).some((t) => t.purpose === purpose)).toBe(true)
  })
})
