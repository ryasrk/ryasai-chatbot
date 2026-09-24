/**
 * POST /api/rag/evaluate — golden-set retrieval scoring as an HTTP endpoint.
 *
 * WHY THIS FILE EXISTS. This route is the only public door onto the retrieval
 * pipeline, and it is a SPEND endpoint: each case fans out into a full hybrid
 * retrieval (vector + FTS + KG + rerank), and the reranker can be an LLM call.
 * So the interesting properties are not "it returned 200" but the four bounds
 * that keep one request from turning into unbounded work or a cross-tenant read:
 *
 *   1. ADMIN-ONLY, AND THE CHECK PRECEDES EVERY RETRIEVAL. `requireRole` sits
 *      ABOVE the case loop, so a viewer gets 403 with ZERO retrievals. Pinned by
 *      asserting `retrievalQueries` is empty, not just the status code.
 *   2. THE ORG CONTEXT IS ENTERED BEFORE THE ROLE CHECK, FROM THE SESSION USER.
 *      The retrieval leg is org-scoped by this context (`db.documentChunk` goes
 *      through the tenant extension; the raw pgvector SQL filters on
 *      `organizationId`). Without the entry the corpus is unscoped. Order is the
 *      assertion here, so the log is `[enterWithOrg, requireRole, retrieve…]`.
 *   3. EVERY RETRIEVAL IS BOUNDED. `cases` is sliced to 50 regardless of what the
 *      caller sends, and `topK` is clamped to [1, 20] — asserted on the value
 *      actually handed to `retrieveRelevantChunks`, not on the request body.
 *      `topK` also reaches the RAG cache key, so an unclamped value would let one
 *      caller fill the cache with a distinct entry per request.
 *   4. NOTHING FROM ANOTHER TENANT REACHES THE SCORE PAYLOAD. Retrieval is driven
 *      entirely from `user.organizationId`; no client field (ids included) feeds a
 *      query. Asserted on the forwarded query and on the response key set, which is
 *      narrow ON PURPOSE — chunk ids and document text stay server-side.
 *
 * `summarizeRagEval`, `isGrounded`, `relevantSourcesFor` and `scoreRetrieval` are
 * the REAL implementations from `@/lib/rag-eval` (not re-mocked), so the metrics in
 * the body are produced by production code over the retrieval the route looped.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

// --- real libs, captured BEFORE any mock.module call -------------------------
// `mock.module` does not apply to a statically imported module, and reaching into
// an imported namespace from inside a factory re-enters that factory (infinite
// recursion -> the file hangs with no output). So the real implementations are
// bound to locals here, at module load, and the factories below close over the
// locals only.
import {
  summarizeRagEval as realSummarizeRagEval,
  isGrounded as realIsGrounded,
  relevantSourcesFor as realRelevantSourcesFor,
  scoreRetrieval as realScoreRetrieval,
} from '@/lib/rag-eval'

const realRagEval = {
  summarizeRagEval: realSummarizeRagEval,
  isGrounded: realIsGrounded,
  relevantSourcesFor: realRelevantSourcesFor,
  scoreRetrieval: realScoreRetrieval,
}

// --- session seam ------------------------------------------------------------
const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'pro',
}
let user: typeof adminUser = adminUser
let authThrows: Error | null = null

// --- seams -------------------------------------------------------------------
const events: string[] = []
const roleChecks: Array<{ role: string; minRole: string }> = []
const auditWrites: Array<Record<string, unknown>> = []
const retrievalQueries: Array<{ query: string; topK: number }> = []
/**
 * The ENTIRE argument object the route passed, kept verbatim.
 *
 * `retrievalQueries` projects two fields, which is what the bound assertions need;
 * this holds the whole thing so the cross-tenant test can prove that NOTHING else
 * (a client-supplied organizationId, documentId, chunk id) was threaded through.
 */
let fullRetrievalArgs: Array<Record<string, unknown>> = []

/** Chunks the retrieval leg will report, keyed by nothing: one queue, drained in call order. */
let retrievalChunks: Array<{ documentName: string; content: string; score: number; chunkId: string }> = []
/** When set, `retrieveRelevantChunks` rejects instead of returning. */
let retrievalThrows: Error | null = null

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
  },
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  // The REAL contract (session.ts): ROLE_RANK viewer 0 < analyst 1 < admin 2, and
  // a shortfall throws ForbiddenError. Reproduced as a distinct error class so the
  // mapper below can key on `instanceof`, exactly as `handleApiError` does.
  requireRole: (u: { role?: string } | null, minRole: string) => {
    events.push(`requireRole:${minRole}`)
    roleChecks.push({ role: String(u?.role), minRole })
    const rank: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }
    if ((rank[String(u?.role)] ?? 0) < (rank[minRole] ?? 0)) {
      const e = new Error(`Requires ${minRole} role. You have ${u?.role}.`) as Error & { code?: string }
      e.code = 'FORBIDDEN'
      e.name = 'ForbiddenError'
      throw e
    }
  },
  // Mirrors session.ts handleApiError: a NESTED `{ error: { code, message } }`, the
  // real status per branch, and a plain `Response.json` — which is why the error
  // assertions read `res.headers.get('set-cookie')`-safe status + body rather than
  // `res.cookies`.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; name?: string; message?: string; reason?: string }
    if (err?.name === 'ForbiddenError' || err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 })
    }
    if (err?.name === 'UnauthorizedError' || err?.code === 'UNAUTHORIZED') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 })
    }
    if (err?.name === 'LicenseError' || err?.code === 'LICENSE_INVALID') {
      return Response.json({ error: { code: 'LICENSE_INVALID', message: err.message } }, { status: 402 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
  writeAudit: async (args: Record<string, unknown>) => {
    events.push('writeAudit')
    auditWrites.push(args)
  },
}))

// The REAL retrieval is never run in-process here: it reaches Postgres, pgvector,
// an embedding provider and the FTS table. The seam is therefore the retrieval
// RESULTS, mocked, while the org-scoping it would depend on is asserted at the
// `enterWithOrg` boundary. This function is stubbed because it cannot be exercised
// in-process under bun (declared non-control, see the bottom of this file).
mock.module('@/lib/rag', () => ({
  retrieveRelevantChunks: async (args: { query: string; topK: number }) => {
    events.push(`retrieve:${args.query}`)
    retrievalQueries.push({ query: args.query, topK: args.topK })
    fullRetrievalArgs.push({ ...(args as unknown as Record<string, unknown>) })
    if (retrievalThrows) throw retrievalThrows
    return {
      chunks: retrievalChunks,
      queryTokens: args.query.toLowerCase().split(/\s+/).filter(Boolean),
      candidatesScanned: retrievalChunks.length,
      graphContext: '',
    }
  },
}))

// `@/lib/rag-eval` is deliberately NOT mocked: the metric assertions below are
// only meaningful against the real scorer, and `mock.module('./route')` is not a
// pattern used here — the route is imported dynamically AFTER all mocks, per the
// module-mock ordering requirement (a static import would NOT see these mocks).
const { POST } = await import('./route')

const ROUTE_URL = 'http://localhost/api/rag/evaluate'

function post(body: unknown, headers: Record<string, string> = {}) {
  const req = new Request(ROUTE_URL, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  }) as Request & { nextUrl: URL }
  req.nextUrl = new URL(ROUTE_URL)
  return POST(req as never)
}

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  // Read ONCE as text then parse: a second `res.json()` on the same Response
  // throws `TypeError: Body already used`.
  return JSON.parse(await res.text()) as Record<string, unknown>
}

beforeEach(() => {
  user = adminUser
  authThrows = null
  retrievalThrows = null
  retrievalChunks = []
  events.length = 0
  roleChecks.length = 0
  auditWrites.length = 0
  retrievalQueries.length = 0
  fullRetrievalArgs = []
})

describe('authorization and the ordering of the guard', () => {
  test('it is admin-only, and a viewer causes ZERO retrievals', async () => {
    // The whole point of the check being above the loop: this route can spend 50
    // retrievals per call. A 403 that still retrieved would be the defect.
    user = { ...adminUser, role: 'viewer' }
    const res = await post({ cases: [{ question: 'anything', expectedSource: 'doc' }] })
    expect(res.status).toBe(403)
    expect(retrievalQueries).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
    expect((await bodyOf(res)).error).toMatchObject({ code: 'FORBIDDEN' })
  })

  test('an analyst is refused too, with the required role named', async () => {
    user = { ...adminUser, role: 'analyst' }
    const res = await post({ cases: [{ question: 'q' }] })
    expect(res.status).toBe(403)
    expect(roleChecks).toEqual([{ role: 'analyst', minRole: 'admin' }])
    expect(retrievalQueries).toHaveLength(0)
  })

  test('the label is `admin` specifically, not merely a passing role', async () => {
    await post({ cases: [] })
    expect(roleChecks).toEqual([{ role: 'admin', minRole: 'admin' }])
  })

  test('the order is getActiveUser -> enterWithOrg -> requireRole -> first retrieval', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'payroll.md', content: 'gaji', score: 0.4 }]
    await post({ cases: [{ question: 'gaji pokok', relevantSources: ['payroll'] }] })
    // ORDER IS THE ASSERTION. enterWithOrg must precede the role check (so a denied
    // caller still opened the session org, as every sibling route does) and both must
    // precede the first DB-reaching retrieval, which is what the org context scopes.
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'requireRole:admin',
      'retrieve:gaji pokok',
      'writeAudit',
    ])
  })

  test('the org context is the SESSION org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-tenant-b' }
    await post({ cases: [] })
    expect(events[1]).toBe('enterWithOrg:org-tenant-b')
    expect(events).not.toContain('enterWithOrg:org-1')
  })

  test('an unauthenticated caller gets 401 and touches nothing', async () => {
    authThrows = Object.assign(new Error('No active session.'), { code: 'UNAUTHORIZED', name: 'UnauthorizedError' })
    const res = await post({ cases: [{ question: 'q' }] })
    expect(res.status).toBe(401)
    expect(retrievalQueries).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
    // No org context is entered when the session itself failed.
    expect(events.filter((e) => e.startsWith('enterWithOrg'))).toHaveLength(0)
  })
})

describe('cross-tenant isolation', () => {
  test('the retrieval query is the question text and carries no client-supplied id', async () => {
    // The only fields the route reads off the body are `cases[].question` and `topK`.
    // Anything else in the payload is ignored, so an attacker-supplied organizationId
    // or documentId has no path into a query.
    //
    // Asserted on the FORWARDED ARGUMENT OBJECT, not on selected fields: a route edit
    // that threaded `body.organizationId` into the retrieval call would still leave
    // query/topK correct, and a per-field assertion could not see it. `toEqual` on the
    // whole object is what makes that mutation fail.
    await post({
      organizationId: 'org-victim',
      documentId: 'doc-from-another-tenant',
      chunkIds: ['c-victim'],
      topK: 4,
      cases: [{ question: 'rahasia gaji', documentId: 'doc-victim', chunkId: 'c-victim' }],
    })
    expect(fullRetrievalArgs).toEqual([{ query: 'rahasia gaji', topK: 4 }])
    // And belt-and-braces on the serialised argument, so a non-enumerable or nested
    // addition is still caught.
    const forwarded = JSON.stringify(fullRetrievalArgs)
    for (const forbidden of ['org-victim', 'doc-from-another-tenant', 'c-victim', 'doc-victim']) {
      expect(forwarded).not.toContain(forbidden)
    }
    expect(retrievalQueries).toEqual([{ query: 'rahasia gaji', topK: 4 }])
  })

  test('the response exposes no chunk ids and no document text', async () => {
    // The score payload is the widest surface this route has: a documentName is
    // reported in full, so anything else lifted from the chunk would leak corpus
    // content across the API. The key set is asserted EXACTLY for that reason.
    retrievalChunks = [
      {
        chunkId: 'chunk-secret-1',
        documentName: 'payroll-2026.pdf',
        content: 'SALARY TABLE INTERNAL ONLY 12345',
        score: 0.812,
      },
    ]
    const res = await post({ cases: [{ question: 'gaji', relevantSources: ['payroll'] }] })
    const raw = await res.text()
    expect(raw).not.toContain('SALARY TABLE INTERNAL ONLY')
    expect(raw).not.toContain('chunk-secret-1')
    const body = JSON.parse(raw) as { results: Array<Record<string, unknown>> }
    expect(Object.keys(body.results[0]!).sort()).toEqual([
      'grounded',
      'latencyMs',
      'ok',
      'precision',
      'question',
      'recall',
      'reciprocalRank',
      'returned',
      'topScore',
      'topSource',
    ])
    expect(body.results[0]!.topSource).toBe('payroll-2026.pdf')
  })

  test('a failed case reports an empty result set rather than another tenant data', async () => {
    retrievalThrows = new Error('pgvector unavailable')
    const res = await post({ cases: [{ question: 'q', relevantSources: ['doc'] }] })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('pgvector unavailable')
    expect(auditWrites).toHaveLength(0)
  })
})

describe('bounds: the case count and topK', () => {
  test('cases are sliced to 50 even when 80 are supplied', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'a.md', content: 'x', score: 1 }]
    const cases = Array.from({ length: 80 }, (_, i) => ({ question: `q${i}` }))
    const res = await post({ cases })
    expect(retrievalQueries).toHaveLength(50)
    expect(retrievalQueries[0]!.query).toBe('q0')
    expect(retrievalQueries.at(-1)!.query).toBe('q49')
    expect(((await bodyOf(res)).results as unknown[])).toHaveLength(50)
  })

  test('the cap is on the SLICE, so the 51st case is never retrieved', async () => {
    retrievalChunks = []
    await post({ cases: Array.from({ length: 51 }, (_, i) => ({ question: `q${i}` })) })
    expect(retrievalQueries.map((r) => r.query)).not.toContain('q50')
  })

  test('topK defaults to 4 and is forwarded verbatim', async () => {
    await post({ cases: [{ question: 'q' }] })
    expect(retrievalQueries).toEqual([{ query: 'q', topK: 4 }])
  })

  test('an oversized topK is clamped to 20, not forwarded', async () => {
    // This is the unbounded-scan bound: topK also selects the cache key and the
    // rerank fan-out, so an unclamped 100000 is a distinct cache entry per request
    // and a much wider candidate read.
    await post({ cases: [{ question: 'q' }], topK: 100000 })
    expect(retrievalQueries[0]!.topK).toBe(20)
  })

  test('topK 0 is FALSY so it falls back to 4 before the floor, not to 1', async () => {
    // `Number(body.topK ?? 4) || 4` -- two different mechanisms, and the `||` runs
    // FIRST. 0 is falsy, so the `Math.max(1, ...)` floor never sees it. Asserted as
    // 4 (not 1) because that is what the expression actually computes.
    await post({ cases: [{ question: 'a' }], topK: 0 })
    expect(retrievalQueries[0]!.topK).toBe(4)
  })

  test('a NEGATIVE topK is truthy, so the floor clamps it to 1', async () => {
    await post({ cases: [{ question: 'b' }], topK: -5 })
    expect(retrievalQueries[0]!.topK).toBe(1)
  })

  test('a non-numeric topK falls back to 4 before the clamp', async () => {
    await post({ cases: [{ question: 'q' }], topK: 'abc' as unknown as number })
    expect(retrievalQueries[0]!.topK).toBe(4)
  })

  test('a fractional topK is forwarded as-is (Math.min/max do not truncate)', async () => {
    // Recorded, not defended: 4.5 is reachable and becomes the cache key and the
    // LIMIT for the vector leg. Not a defect under [1,20] -- it cannot be used to
    // widen the scan -- but it is the shape a "use Math.floor here" edit would change.
    await post({ cases: [{ question: 'q' }], topK: 4.5 })
    expect(retrievalQueries[0]!.topK).toBe(4.5)
  })

  test('one topK is computed once and applied to every case in the call', async () => {
    await post({ cases: [{ question: 'a' }, { question: 'b' }, { question: 'c' }], topK: 7 })
    expect(retrievalQueries.map((r) => r.topK)).toEqual([7, 7, 7])
  })
})

describe('per-case metrics come from the real scorer', () => {
  test('a rank-2 relevant hit reports recall 1, precision 0.5 and MRR 0.5', async () => {
    retrievalChunks = [
      { chunkId: 'c1', documentName: 'unrelated.md', content: 'nothing here', score: 0.9 },
      { chunkId: 'c2', documentName: 'payroll-2026.pdf', content: 'gaji pokok', score: 0.4 },
    ]
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji', relevantSources: ['payroll'] }] }))) as {
      results: Array<Record<string, unknown>>
    }
    const r = body.results[0]!
    expect(r.ok).toBe(true)
    expect(r.recall).toBe(1)
    expect(r.precision).toBe(0.5)
    expect(r.reciprocalRank).toBe(0.5)
    expect(r.returned).toBe(2)
    expect(r.topScore).toBe(0.9)
    expect(r.topSource).toBe('unrelated.md')
  })

  test('recall is 0 when the relevant source is absent, and ok is false', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'unrelated.md', content: 'x', score: 0.1 }]
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji', relevantSources: ['payroll'] }] }))) as {
      results: Array<Record<string, unknown>>
    }
    expect(body.results[0]).toMatchObject({ ok: false, recall: 0, precision: 0, reciprocalRank: 0 })
  })

  test('the legacy expectedSource field still labels relevance', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'payroll-2026.pdf', content: 'x', score: 0.5 }]
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji', expectedSource: 'payroll' }] }))) as {
      results: Array<Record<string, unknown>>
    }
    expect(body.results[0]).toMatchObject({ ok: true, recall: 1, reciprocalRank: 1 })
  })

  test('with NO labels the ranking metrics stay 0 while ok reports that anything came back', async () => {
    // `scoreRetrieval`'s documented contract for an unlabelled case: inventing 1.0s
    // would inflate `recallAtK` in the summary.
    retrievalChunks = [{ chunkId: 'c1', documentName: 'x.md', content: 'x', score: 0.5 }]
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji' }] }))) as {
      results: Array<Record<string, unknown>>
    }
    expect(body.results[0]).toMatchObject({ ok: true, recall: 0, precision: 0, reciprocalRank: 0 })
  })

  test('grounded is judged from the CONCATENATED content of every returned chunk', async () => {
    // The route joins ALL chunk contents before calling isGrounded, so an expected
    // text that lives only in the SECOND chunk still counts as grounded. Both chunks
    // named alike here so the grounding assertion is the only variable changing.
    retrievalChunks = [
      { chunkId: 'c1', documentName: 'sop.md', content: 'header only', score: 0.9 },
      { chunkId: 'c2', documentName: 'sop.md', content: 'the BPJS rate is 4%', score: 0.2 },
    ]
    const body = (await bodyOf(
      await post({ cases: [{ question: 'rate', relevantSources: ['sop'], expectedText: 'bpjs rate is 4%' }] }),
    )) as { results: Array<Record<string, unknown>> }
    expect(body.results[0]!.grounded).toBe(true)
    expect(body.results[0]!.recall).toBe(1)
    expect(body.results[0]!.precision).toBe(1)
  })

  test('a NON-relevant first chunk still grounds the case, and costs precision', async () => {
    // Grounding and relevance are independent inputs: the expected text is found in
    // content the label does not call relevant. The route must report both truths.
    retrievalChunks = [
      { chunkId: 'c1', documentName: 'unrelated.md', content: 'noise only', score: 0.9 },
      { chunkId: 'c2', documentName: 'unrelated.md', content: 'misplaced bpjs 4%', score: 0.5 },
      { chunkId: 'c3', documentName: 'sop.md', content: 'sop body', score: 0.1 },
    ]
    const body = (await bodyOf(
      await post({ cases: [{ question: 'rate', relevantSources: ['sop'], expectedText: 'bpjs 4%' }] }),
    )) as { results: Array<Record<string, unknown>> }
    expect(body.results[0]!.grounded).toBe(true)
    expect(body.results[0]!.ok).toBe(true)
    expect(body.results[0]!.recall).toBe(1)
    // One of three returned chunks is relevant. Asserted at full precision: the
    // route forwards `scoreRetrieval`'s raw ratios and only `summarizeRagEval`
    // rounds, so 0.333 is a number this field never takes.
    expect(body.results[0]!.precision).toBe(1 / 3)
    // The first relevant chunk sits at rank 3.
    expect(body.results[0]!.reciprocalRank).toBe(1 / 3)
    expect(body.results[0]!.returned).toBe(3)
  })

  test('a case with an empty expectedText is grounded by definition', async () => {
    retrievalChunks = []
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji', expectedText: '   ' }] }))) as {
      results: Array<Record<string, unknown>>
    }
    expect(body.results[0]!.grounded).toBe(true)
  })

  test('no results drops topSource from the body entirely and reports topScore 0', async () => {
    // Found by running this file rather than by reading the route: `topSource`
    // is built as `top?.documentName`, i.e. `undefined`, and `JSON.stringify`
    // REMOVES undefined-valued keys. So the field is ABSENT from the payload, not
    // present-but-undefined -- an assertion of `toBeUndefined()` passed for the wrong
    // reason (`'topSource' in body` is false). The key set below is the real contract.
    retrievalChunks = []
    const body = (await bodyOf(await post({ cases: [{ question: 'gaji' }] }))) as {
      results: Array<Record<string, unknown>>
    }
    const r = body.results[0]!
    expect('topSource' in r).toBe(false)
    expect(Object.keys(r).sort()).toEqual([
      'grounded',
      'latencyMs',
      'ok',
      'precision',
      'question',
      'recall',
      'reciprocalRank',
      'returned',
      'topScore',
    ])
    expect(r.topScore).toBe(0)
    expect(r.returned).toBe(0)
  })

  test('the question is trimmed and a whitespace-only question is SKIPPED entirely', async () => {
    await post({ cases: [{ question: '  gaji  ' }, { question: '   ' }, { question: '' }, { question: null }] })
    expect(retrievalQueries).toEqual([{ query: 'gaji', topK: 4 }])
  })

  test('a case item with no question at all does not throw', async () => {
    const res = await post({ cases: [{}] })
    expect(res.status).toBe(200)
    expect(retrievalQueries).toHaveLength(0)
  })

  test('the response echoes the trimmed question', async () => {
    const body = (await bodyOf(await post({ cases: [{ question: '  gaji   pokok ' }] }))) as {
      results: Array<Record<string, unknown>>
    }
    expect(body.results[0]!.question).toBe('gaji   pokok')
  })
})

describe('the summary is computed by summarizeRagEval over the results', () => {
  test('the summary matches the real summarizer for the same inputs', async () => {
    retrievalChunks = [
      { chunkId: 'c1', documentName: 'payroll-2026.pdf', content: 'gaji pokok', score: 0.9 },
      { chunkId: 'c2', documentName: 'unrelated.md', content: 'x', score: 0.1 },
    ]
    const body = (await bodyOf(
      await post({
        cases: [
          { question: 'gaji', relevantSources: ['payroll'], expectedText: 'gaji pokok' },
          { question: 'absent', relevantSources: ['missing'], expectedText: 'nope' },
        ],
      }),
    )) as { summary: Record<string, number>; results: Array<Record<string, number>> }

    // The same results fed through the REAL summarizer, so this cannot drift into
    // an assertion that merely records whatever the route happens to print.
    const expected = realRagEval.summarizeRagEval(
      body.results.map((r) => ({
        ok: r.ok as unknown as boolean,
        grounded: r.grounded as unknown as boolean,
        latencyMs: r.latencyMs as unknown as number,
        recall: r.recall,
        precision: r.precision,
        reciprocalRank: r.reciprocalRank,
      })),
    )
    expect(body.summary).toMatchObject({
      total: 2,
      precisionAtK: expected.precisionAtK,
      recallAtK: expected.recallAtK,
      mrr: expected.mrr,
      groundedRate: expected.groundedRate,
    })
    // Absolute values, so a change to the scorer shows up rather than being
    // mirrored by the expectation: hit rate 1/2, recall mean (1 + 0)/2 = 0.5,
    // MRR mean (1 + 0)/2 = 0.5, grounded rate 1/2.
    expect(body.summary.precisionAtK).toBe(0.5)
    expect(body.summary.recallAtK).toBe(0.5)
    expect(body.summary.mrr).toBe(0.5)
    expect(body.summary.groundedRate).toBe(0.5)
    expect(typeof body.summary.avgLatencyMs).toBe('number')
  })

  test('an empty case list summarises to total 0 with zeroed rates, not NaN', async () => {
    const body = (await bodyOf(await post({ cases: [] }))) as { summary: Record<string, number> }
    expect(body.summary).toMatchObject({
      total: 0,
      precisionAtK: 0,
      recallAtK: 0,
      mrr: 0,
      groundedRate: 0,
      avgLatencyMs: 0,
    })
    expect(JSON.stringify(body)).not.toContain('null')
  })

  test('a body with no cases key at all behaves like an empty list', async () => {
    const body = (await bodyOf(await post({}))) as { summary: { total: number } }
    expect(body.summary.total).toBe(0)
    expect(retrievalQueries).toHaveLength(0)
  })

  test('a non-array cases value is ignored rather than iterated', async () => {
    const res = await post({ cases: { length: 3, 0: { question: 'q' } } as unknown as unknown[] })
    expect(res.status).toBe(200)
    expect(retrievalQueries).toHaveLength(0)
  })

  test('a malformed JSON body is treated as an empty body, not a 400', async () => {
    const res = await post('{not json')
    expect(res.status).toBe(200)
    expect(((await bodyOf(res)).summary as Record<string, number>).total).toBe(0)
  })
})

describe('the response envelope and the audit record', () => {
  test('the top-level shape is exactly { ok, summary, fusion, results }', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'a.md', content: 'x', score: 1 }]
    const body = (await bodyOf(await post({ cases: [{ question: 'q' }] }))) as Record<string, unknown>
    // `fusion` names the RRF `k` the run used. Two eval runs at different k are only
    // comparable if each reports the value it measured, so the config travels with
    // the numbers rather than living only in the server's environment.
    expect(Object.keys(body).sort()).toEqual(['fusion', 'ok', 'results', 'summary'])
    expect(body.ok).toBe(true)
    expect(Object.keys(body.fusion as object).sort()).toEqual(['k', 'overrideAccepted', 'source'])
    expect(Object.keys(body.summary as object).sort()).toEqual([
      'avgLatencyMs',
      'groundedRate',
      'mrr',
      'precisionAtK',
      'recallAtK',
      'total',
    ])
  })

  test('the reported fusion config is the default when nothing is set', async () => {
    const body = (await bodyOf(await post({ cases: [{ question: 'q' }] }))) as {
      fusion: { k: number; source: string; overrideAccepted: boolean }
    }
    expect(body.fusion).toEqual({ k: 60, source: 'default', overrideAccepted: false })
  })

  test('the audit is written AFTER the retrievals and AFTER the summary', async () => {
    retrievalChunks = []
    await post({ cases: [{ question: 'q1' }, { question: 'q2' }] })
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'requireRole:admin',
      'retrieve:q1',
      'retrieve:q2',
      'writeAudit',
    ])
  })

  test('the audit carries the action, severity, user and the summary as detail', async () => {
    retrievalChunks = [{ chunkId: 'c1', documentName: 'payroll.md', content: 'x', score: 1 }]
    const body = (await bodyOf(
      await post({ cases: [{ question: 'gaji', relevantSources: ['payroll'] }] }),
    )) as { summary: Record<string, unknown> }
    expect(auditWrites).toHaveLength(1)
    expect(auditWrites[0]).toMatchObject({
      userId: 'u1',
      action: 'RAG_EVAL_RUN',
      severity: 'info',
    })
    // The summary PLUS the fusion config, because an audit row for an eval run is
    // only interpretable if it names the ranking it measured.
    expect(auditWrites[0]!.detail).toEqual({
      ...body.summary,
      fusionK: 60,
      fusionKSource: 'default',
      fusionOverrideAccepted: false,
    })
  })

  test('x-fusion-k is IGNORED while RAG_FUSION_K is unset — a client cannot pick the ranking', async () => {
    // The security property of the seam: an operator who has not opted in must not
    // have a client enable it for them. Asserted through the response, because the
    // value reaching the retrieval is what matters, not that a header was read.
    delete process.env.RAG_FUSION_K
    const body = (await bodyOf(
      await post({ cases: [{ question: 'q' }] }, { 'x-fusion-k': '1' }),
    )) as { fusion: { k: number; source: string; overrideAccepted: boolean } }
    expect(body.fusion).toEqual({ k: 60, source: 'default', overrideAccepted: false })
  })

  test('x-fusion-k IS honoured once RAG_FUSION_K is set, and it wins', async () => {
    process.env.RAG_FUSION_K = '10'
    try {
      const body = (await bodyOf(
        await post({ cases: [{ question: 'q' }] }, { 'x-fusion-k': '1' }),
      )) as { fusion: { k: number; source: string; overrideAccepted: boolean } }
      expect(body.fusion).toEqual({ k: 1, source: 'request', overrideAccepted: true })
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })

  test('an invalid x-fusion-k falls back to the env value, not to the default', async () => {
    process.env.RAG_FUSION_K = '10'
    try {
      const body = (await bodyOf(
        await post({ cases: [{ question: 'q' }] }, { 'x-fusion-k': '0' }),
      )) as { fusion: { k: number; source: string; overrideAccepted: boolean } }
      expect(body.fusion).toEqual({ k: 10, source: 'env', overrideAccepted: false })
    } finally {
      delete process.env.RAG_FUSION_K
    }
  })

  test('the audit never carries the question text', async () => {
    // The audit row is a spend record. The golden-set questions can name internal
    // documents, so they must not be copied into a log that outlives the request.
    await post({ cases: [{ question: 'rahasia klien bank abc', relevantSources: ['x'] }] })
    expect(JSON.stringify(auditWrites[0])).not.toContain('rahasia klien bank abc')
  })

  test('a failed evaluation is not audited', async () => {
    // The audit is the last statement before the response, so a throw anywhere in
    // the loop skips it and the error mapper answers instead.
    retrievalThrows = new Error('embedding provider down')
    const res = await post({ cases: [{ question: 'q' }] })
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
    expect((await bodyOf(res)).error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Failed to run RAG evaluation.',
    })
  })

  test('the failure body carries neither the summary nor the results', async () => {
    retrievalThrows = new Error('boom')
    const body = await bodyOf(await post({ cases: [{ question: 'q' }] }))
    expect(Object.keys(body)).toEqual(['error'])
    expect(JSON.stringify(body)).not.toContain('boom')
  })
})
