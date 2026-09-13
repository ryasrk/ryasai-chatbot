/**
 * GET /api/routing/scores — the router's own scoring table, as JSON.
 *
 * WHY THIS FILE EXISTS. The route is thirteen lines, but what it returns is the
 * router's INTERNALS, and both facts that matter are invisible from the route:
 *
 *   1. THE ORG CONTEXT IS ENTERED, AND THIS IS WHAT SCOPES THE SCORES. Every
 *      loader behind `getRoutingScores()` is an ORG-SCOPED read through the tenant
 *      extension: `loadSchemaMetadata` reads `integrationSchema` (joined to
 *      `integration`), `loadEndpointMetadata` reads `restApiEndpoint`,
 *      `loadDocumentMetadata` reads `document`, `loadPerformanceMetrics` reads
 *      `toolRun` (six queries per tool type). All of those feed response fields
 *      that carry COLUMN NAMES, REST PATHS and DOCUMENT NAMES. Without the org
 *      context the extension injects no `organizationId` and the payload is another
 *      tenant schema. So `enterWithOrg` is asserted here with its argument, and
 *      asserted to run BEFORE the first read.
 *   2. THERE IS NO AUTHORIZATION GATE. `getActiveUser()` only proves a session
 *      exists; the route has no `requireRole`, unlike its sibling spend endpoints
 *      (`rag/evaluate` calls `requireRole(user, 'admin')`). A viewer therefore gets
 *      the org full schema keyword list, endpoint paths, document names and the
 *      performance counters. Pinned as the CURRENT behaviour, with the inversion
 *      written against the fix so the test goes RED when a gate is added.
 *
 * The scoring ARITHMETIC is not re-mocked: `getRoutingScores` is the real
 * implementation from `@/lib/smart-router`, with the three `smart-router-helpers`
 * data loaders and `computeSemanticScore` stubbed so the reads and the embedding
 * provider never leave the process. Every other helper the module imports --
 * `WEIGHTS`, `NEUTRAL_PERF`, `keywordOverlap`, `buildReason`, `checkAvailability`,
 * the metadata loaders, `getSourceEmbeddings`, `getQuestionEmbedding`,
 * `loadSimilarityBoost`, `expandWithSynonyms`, `tokenize`, `invalidateSourceEmbeddingCache`
 * and both type-only exports -- is re-implemented above with the REAL shape, because
 * a mocked module must export every name its importer binds.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

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
const calls: Array<{ model: string; op: string }> = []
let schemaMetadata: string[] = []
let endpointMetadata: string[] = []
let documentMetadata: string[] = []
let perfData: Record<string, { successRate: number; avgLatencyMs: number; total: number; recentFailRate: number; lastFailureAt: Date | null }> = {}
let perfThrows: Error | null = null

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    events.push(`enterWithOrg:${orgId}`)
  },
  // Imported by smart-router-helpers for the embedding cache scope; not exercised by
  // this route, but the mocked module must still satisfy the import graph.
  getOrgContext: () => 'org-1',
}))

mock.module('@/lib/session', () => ({
  getActiveUser: async () => {
    events.push('getActiveUser')
    if (authThrows) throw authThrows
    return user
  },
  // Mirrors the REAL requireRole (session.ts): ROLE_RANK viewer 0 < analyst 1 < admin 2,
  // throwing a ForbiddenError on a shortfall. Exported unconditionally so that ADDING a
  // gate to the route makes the two INVERT WHEN FIXED tests below go RED on the HTTP
  // status, rather than failing the whole file with
  // `SyntaxError: Export named 'requireRole' not found`.
  requireRole: (u: { role?: string } | null, minRole: string) => {
    events.push(`requireRole:${minRole}`)
    const rank: Record<string, number> = { viewer: 0, analyst: 1, admin: 2 }
    if ((rank[String(u?.role)] ?? 0) < (rank[minRole] ?? 0)) {
      const e = new Error(`Requires ${minRole} role. You have ${u?.role}.`) as Error & { code?: string }
      e.code = 'FORBIDDEN'
      e.name = 'ForbiddenError'
      throw e
    }
  },
  // Mirrors the REAL `handleApiError` mapping (session.ts): a NESTED
  // `{ error: { code, message } }` and a plain `Response.json`, which is why error
  // assertions read status + body and never `res.cookies` (undefined on this path).
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; name?: string; message?: string }
    if (err?.name === 'UnauthorizedError' || err?.code === 'UNAUTHORIZED') {
      return Response.json({ error: { code: 'UNAUTHORIZED', message: err.message } }, { status: 401 })
    }
    if (err?.name === 'ForbiddenError' || err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: err.message } }, { status: 403 })
    }
    if (err?.name === 'LicenseError' || err?.code === 'LICENSE_INVALID') {
      return Response.json({ error: { code: 'LICENSE_INVALID', message: err.message } }, { status: 402 })
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

// `db` is mocked even though no route module reads it directly: smart-router's
// `detectMentionedIntegration`, `pickBestIntegration*` and every loader in
// smart-router-helpers go through it, and one stray un-stubbed call would otherwise
// try to reach a real Postgres from a unit test.
mock.module('@/lib/db', () => ({
  db: {
    integration: {
      findMany: async () => {
        calls.push({ model: 'integration', op: 'findMany' })
        return []
      },
    },
    toolRun: {
      findMany: async () => {
        calls.push({ model: 'toolRun', op: 'findMany' })
        return []
      },
      findFirst: async () => {
        calls.push({ model: 'toolRun', op: 'findFirst' })
        return null
      },
    },
    document: {
      findMany: async () => {
        calls.push({ model: 'document', op: 'findMany' })
        return []
      },
    },
  },
}))

mock.module('@/lib/ai', () => ({
  // Type-only importer; the runtime export is mirrored for completeness.
  routeQuery: async () => ({ decision: 'CHAT', reason: 'stub' }),
}))

mock.module('@/lib/plugin-selector', () => ({
  selectRelevantPlugins: async () => [],
}))

// The embedding provider is a network call; stubbed so semantic scoring is
// deterministic (0) and never leaves the process. Declared non-control: the
// 0.4/0.6 blend at the other end of this function is not exercised in-process.
mock.module('@/lib/smart-router-helpers', () => {
  const NEUTRAL_PERF = {
    successRate: 0.5,
    avgLatencyMs: 2500,
    total: 0,
    recentFailRate: 0,
    lastFailureAt: null as Date | null,
  }
  const WEIGHTS = { schema: 0.35, performance: 0.25, latency: 0.15, availability: 0.10, similarity: 0.15 }

  const STOPWORDS = new Set(['the', 'and', 'yang', 'dan'])

  return {
    NEUTRAL_PERF,
    WEIGHTS,
    // --- real shapes, re-implemented (see the file header) -------------------
    tokenize: (text: string): string[] => {
      if (!text) return []
      const seen = new Set<string>()
      const out: string[] = []
      for (const word of text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
        if (!word || word.length < 2 || STOPWORDS.has(word) || seen.has(word)) continue
        seen.add(word)
        out.push(word)
      }
      return out
    },
    expandWithSynonyms: (tokens: string[]) => tokens,
    keywordOverlap: (tokens: string[], metadata: string[]): number => {
      if (metadata.length === 0 || tokens.length === 0) return 0
      const meta = new Set(metadata)
      let matches = 0
      for (const token of tokens) if (meta.has(token)) matches += 1
      return matches / tokens.length
    },
    checkAvailability: () => 1,
    // The REAL format (smart-router-helpers.ts buildReason): percent with no
    // decimals, plus a trailing "— no strong signal, neutral" when nothing fires.
    buildReason: (tool: string, schemaScore: number, perf: { recentFailRate: number; total: number; successRate: number }, circuitBreaker: boolean) => {
      if (circuitBreaker) {
        return `${tool} circuit breaker tripped (fail rate ${(perf.recentFailRate * 100).toFixed(0)}%)`
      }
      const parts: string[] = []
      if (schemaScore > 0.3) parts.push(`schema match ${(schemaScore * 100).toFixed(0)}%`)
      if (perf.total > 0) parts.push(`success ${perf.successRate * 100 | 0}% (${perf.total} runs)`)
      if (parts.length === 0) return `${tool} — no strong signal, neutral`
      return `${tool}: ${parts.join(', ')}`
    },
    computeSemanticScore: async () => 0,
    loadSchemaMetadata: async () => {
      calls.push({ model: 'integrationSchema', op: 'findMany' })
      // Feeds the SHARED events log, not just `calls`: the ordering test needs the read
      // and the org-context entry on one timeline, or the two orderings are
      // indistinguishable and a `enterWithOrg`-too-late defect passes.
      events.push('read:loadSchemaMetadata')
      return schemaMetadata
    },
    loadEndpointMetadata: async () => {
      calls.push({ model: 'restApiEndpoint', op: 'findMany' })
      events.push('read:loadEndpointMetadata')
      return endpointMetadata
    },
    loadDocumentMetadata: async () => {
      calls.push({ model: 'document', op: 'findMany' })
      events.push('read:loadDocumentMetadata')
      return documentMetadata
    },
    loadPerformanceMetrics: async () => {
      calls.push({ model: 'toolRun', op: 'loadPerformanceMetrics' })
      events.push('read:loadPerformanceMetrics')
      if (perfThrows) throw perfThrows
      return perfData
    },
    loadSimilarityBoost: async () => ({}),
    getSourceEmbeddings: async () => null,
    getQuestionEmbedding: async () => [],
    invalidateSourceEmbeddingCache: () => {},
  }
})

// Imported dynamically, AFTER every mock.module call: a static import is not
// affected by a mock registered later in the file.
const { GET } = await import('./route')

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  // Read ONCE as text then parse: a second `res.json()` on the same Response throws
  // `TypeError: Body already used`.
  return JSON.parse(await res.text()) as Record<string, unknown>
}

type Score = {
  tool: string
  schemaScore: number
  perfScore: number
  latencyScore: number
  availability: number
  similarityBoost: number
  circuitBreakerTripped: boolean
  finalScore: number
  reason: string
  perfMetrics: Record<string, unknown>
}

const scoresOf = async (): Promise<Score[]> => ((await bodyOf(await GET())) as { scores: Score[] }).scores
const scoreFor = async (tool: string): Promise<Score> => {
  const found = (await scoresOf()).find((s) => s.tool === tool)
  if (!found) throw new Error(`no score for ${tool}`)
  return found
}

beforeEach(() => {
  user = adminUser
  authThrows = null
  perfThrows = null
  schemaMetadata = []
  endpointMetadata = []
  documentMetadata = []
  perfData = {}
  events.length = 0
  calls.length = 0
})

describe('the session and the org context', () => {
  test('it enters the session org BEFORE its first read', async () => {
    // The single most load-bearing property of a thirteen-line route: every read behind
    // getRoutingScores() is org-scoped by this context, and the payload it shapes is
    // schema keywords, REST paths and document names.
    //
    // ORDER, not mere presence -- and this assertion had to be strengthened. A first
    // version asserted `events === ['getActiveUser','enterWithOrg:org-1']` plus
    // `calls.length > 0`; a control that moved `enterWithOrg` to AFTER
    // `getRoutingScores()` still passed it, because the stub loaders only record their
    // own call and the two ORDERINGS ARE INDISTINGUISHABLE unless the loaders feed the
    // same log. So the loaders below push into `events` as well, which is what makes
    // the interleaving visible. Without this the test was proof of a ritual, not of the
    // property that keeps another tenant's schema out of the response.
    await GET()
    // Measured, not guessed: `Promise.all` issues all four loaders, so every read
    // follows the context entry rather than only the first one.
    expect(events).toEqual([
      'getActiveUser',
      'enterWithOrg:org-1',
      'read:loadSchemaMetadata',
      'read:loadEndpointMetadata',
      'read:loadDocumentMetadata',
      'read:loadPerformanceMetrics',
    ])
    // Belt and braces: assert the position relationship directly, so a future loader
    // that is not instrumented cannot silently invalidate the sequence assertion.
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.indexOf('read:loadSchemaMetadata'))
    expect(events.indexOf('getActiveUser')).toBeLessThan(events.indexOf('enterWithOrg:org-1'))
  })

  test('the org taken is the SESSION org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-tenant-b' }
    await GET()
    expect(events).toContain('enterWithOrg:org-tenant-b')
    expect(events).not.toContain('enterWithOrg:org-1')
  })

  test('an unauthenticated caller gets 401, enters no org and reads nothing', async () => {
    authThrows = Object.assign(new Error('No active session.'), { code: 'UNAUTHORIZED', name: 'UnauthorizedError' })
    const res = await GET()
    expect(res.status).toBe(401)
    expect(events.filter((e) => e.startsWith('enterWithOrg'))).toHaveLength(0)
    expect(calls).toHaveLength(0)
    expect((await bodyOf(res)).error).toMatchObject({ code: 'UNAUTHORIZED' })
  })

  test('a license failure surfaces as 402, not as a routing table', async () => {
    authThrows = Object.assign(new Error('License has expired.'), { code: 'LICENSE_INVALID', name: 'LicenseError' })
    const res = await GET()
    expect(res.status).toBe(402)
    const body = await bodyOf(res)
    expect(body.error).toMatchObject({ code: 'LICENSE_INVALID', message: 'License has expired.' })
    expect(body).not.toHaveProperty('scores')
    expect(calls).toHaveLength(0)
  })
})

describe('the response envelope', () => {
  test('it is exactly { ok, scores, schemaKeywords, endpointKeywords, documentKeywords }', async () => {
    // The route spreads getRoutingScores() into the envelope, so this key set is the
    // contract: a new field on the scoring internals reaches the wire with no route
    // edit at all. That is why it is asserted exactly rather than partially.
    const body = await bodyOf(await GET())
    expect(Object.keys(body).sort()).toEqual([
      'documentKeywords',
      'endpointKeywords',
      'ok',
      'schemaKeywords',
      'scores',
    ])
    expect(body.ok).toBe(true)
    expect(Array.isArray(body.scores)).toBe(true)
  })

  test('every score entry carries the same fixed key set', async () => {
    const [first] = await scoresOf()
    expect(Object.keys(first!).sort()).toEqual([
      'availability',
      'circuitBreakerTripped',
      'finalScore',
      'latencyScore',
      'perfMetrics',
      'perfScore',
      'reason',
      'schemaScore',
      'similarityBoost',
      'tool',
    ])
  })

  test('perfMetrics is the raw PerfMetrics object, including lastFailureAt', async () => {
    // `perfMetrics: perf` is passed through untouched, so a Date escapes into the
    // JSON body. Recorded as-is rather than assumed to be summarised away.
    perfData = {
      SQL: { successRate: 0.5, avgLatencyMs: 2500, total: 0, recentFailRate: 0, lastFailureAt: new Date('2026-02-01T00:00:00.000Z') },
    }
    const sql = await scoreFor('SQL')
    expect(Object.keys(sql.perfMetrics).sort()).toEqual([
      'avgLatencyMs',
      'lastFailureAt',
      'recentFailRate',
      'successRate',
      'total',
    ])
    expect(sql.perfMetrics.lastFailureAt).toBe('2026-02-01T00:00:00.000Z')
  })

  test('it reports every router decision tool in the scores array', async () => {
    expect((await scoresOf()).map((s) => s.tool).sort()).toEqual(['CHAT', 'PLUGIN', 'RAG', 'REST', 'SQL'])
  })
})

describe('what the payload exposes', () => {
  test('the keyword lists are the org real schema, endpoint paths and document names', async () => {
    // This is the disclosure the file exists for: these three arrays are the org
    // database columns, its REST paths and its document names, and they reach the
    // browser for ANY signed-in role.
    schemaMetadata = ['customers', 'invoice_total', 'npwp']
    endpointMetadata = ['api', 'orders', 'shipments']
    documentMetadata = ['payroll-2026', 'sop-cuti']
    const body = await bodyOf(await GET())
    expect(body.schemaKeywords).toEqual(['customers', 'invoice_total', 'npwp'])
    expect(body.endpointKeywords).toEqual(['api', 'orders', 'shipments'])
    expect(documentKeywordsOf(body)).toEqual(['payroll-2026', 'sop-cuti'])
  })

  test('the keyword lists are capped at 50 entries by the route', async () => {
    schemaMetadata = Array.from({ length: 60 }, (_, i) => `col_${i}`)
    endpointMetadata = Array.from({ length: 51 }, (_, i) => `path_${i}`)
    documentMetadata = Array.from({ length: 50 }, (_, i) => `doc_${i}`)
    const body = await bodyOf(await GET())
    expect((body.schemaKeywords as string[])).toHaveLength(50)
    expect((body.schemaKeywords as string[])[49]).toBe('col_49')
    expect((body.endpointKeywords as string[])).toHaveLength(50)
    expect((body.documentKeywords as string[])).toHaveLength(50)
  })

  test('no database credentials, connector config or model names appear in the body', async () => {
    // The loaders select only `tableName`/`columns`/`path`/`description`/`name`, so
    // nothing else can ride along. Asserted on the serialised body so a future
    // `select` widening is caught here rather than in review.
    schemaMetadata = ['customers']
    const raw = await (await GET()).text()
    for (const forbidden of ['password', 'encryptedConfig', 'apiKey', 'baseUrl', 'postgresql://', 'connectionString']) {
      expect(raw.toLowerCase()).not.toContain(forbidden.toLowerCase())
    }
  })

  test('there is NO role gate: a viewer receives the full routing table', async () => {
    // INVERT WHEN FIXED: when a `requireRole(user, 'admin')` (or a plan gate) is added
    // to GET /api/routing/scores, this test must fail. The fix is a single line after
    // `enterWithOrg(...)`, matching the sibling spend endpoint rag/evaluate.
    // Current behaviour, proven: a viewer gets 200 with the org schema keywords.
    //
    // This IS the inversion guard for the missing gate -- it is not green-because-buggy:
    // the reference fix below makes it red, asserted both on the status and on the fact
    // that no role check was consulted at all.
    //
    //   const u = await getActiveUser(); enterWithOrg(u.organizationId)
    //   requireRole(u, 'admin')   // <- the fix; makes this test fail
    user = { ...adminUser, role: 'viewer' }
    schemaMetadata = ['customers', 'invoice_total']
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await bodyOf(res)
    expect(body.ok).toBe(true)
    expect(body.schemaKeywords).toEqual(['customers', 'invoice_total'])
    // No gate was consulted. Once one exists this line is the second red flag.
    expect(events.filter((e) => e.startsWith('requireRole'))).toHaveLength(0)
  })

  test('and an analyst receives it too, with no audit trail of the read', async () => {
    // INVERT WHEN FIXED: same fix as above. The route writes no audit row either, so
    // an admin-only gate would be the ONLY record that this disclosure happened.
    user = { ...adminUser, role: 'analyst' }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await bodyOf(res)).ok).toBe(true)
    expect(events.filter((e) => e.startsWith('requireRole'))).toHaveLength(0)
  })
})

describe('the scoring arithmetic is the real implementation', () => {
  test('a neutral tool scores exactly 0.3 from WEIGHTS and NEUTRAL_PERF', async () => {
    // schemaScore 0 (the route passes no tokens, see below) * 0.35
    // + successRate 0.5    * 0.25 = 0.125
    // + latencyScore 0.5   * 0.15 = 0.075   (1 - min(2500/5000, 1))
    // + availability 1     * 0.10 = 0.10
    // = 0.3
    const sql = await scoreFor('SQL')
    expect(sql.schemaScore).toBe(0)
    expect(sql.perfScore).toBe(0.5)
    expect(sql.latencyScore).toBe(0.5)
    expect(sql.availability).toBe(1)
    expect(sql.similarityBoost).toBe(0)
    expect(sql.finalScore).toBeCloseTo(0.3, 10)
    expect(sql.circuitBreakerTripped).toBe(false)
  })

  test('schemaScore is ALWAYS 0 here because the route passes an empty token array', async () => {
    // Found by running this file, not by reading the route: getRoutingScores calls
    // `scoreSchemaMatch(tool, [], schemaMeta, endpointMeta, docMeta, [], '')` -- the
    // token list, the plugin list and the question are all empty strings/arrays. So
    // `if (tokens.length === 0) return 0` fires before ANY keyword or semantic
    // scoring, and the schema leg of the score is dead in this endpoint.
    //
    // That is the difference between this diagnostic table and a live routing
    // decision: smartRoute passes `expandedTokens` and the real question. Recorded
    // here with the metadata deliberately non-empty, so this cannot pass because the
    // fixtures were empty.
    schemaMetadata = ['customers']
    endpointMetadata = ['orders']
    documentMetadata = ['payroll']
    const scores = await scoresOf()
    expect(scores.map((s) => s.schemaScore)).toEqual([0, 0, 0, 0, 0])
    // Which also means the keyword lists in the payload do NOT influence the scores
    // printed beside them -- they are shown for diagnosis only.
    const body = await bodyOf(await GET())
    expect(body.schemaKeywords).toEqual(['customers'])
    expect(body.endpointKeywords).toEqual(['orders'])
  })

  test('a 90% success rate and a 500ms latency raise the score by the weighted amounts', async () => {
    perfData = {
      SQL: { successRate: 0.9, avgLatencyMs: 500, total: 20, recentFailRate: 0, lastFailureAt: null },
    }
    const sql = await scoreFor('SQL')
    expect(sql.perfScore).toBe(0.9)
    expect(sql.latencyScore).toBe(0.9)
    // 0.9*0.25 + 0.9*0.15 + 1*0.10 = 0.225 + 0.135 + 0.10
    expect(sql.finalScore).toBeCloseTo(0.46, 10)
  })

  test('latencyScore floors at 0 once the average reaches 5000ms', async () => {
    perfData = {
      SQL: { successRate: 1, avgLatencyMs: 5000, total: 5, recentFailRate: 0, lastFailureAt: null },
    }
    expect((await scoreFor('SQL')).latencyScore).toBe(0)
  })

  test('latencyScore is 1 for an instantaneous average', async () => {
    perfData = {
      SQL: { successRate: 1, avgLatencyMs: 0, total: 5, recentFailRate: 0, lastFailureAt: null },
    }
    expect((await scoreFor('SQL')).latencyScore).toBe(1)
  })

  test('an availability of 1 is hardcoded, so an unconfigured tool is not zeroed', async () => {
    // `const availability = 1` in getRoutingScores -- NOT checkAvailability(...),
    // which the chat path uses. So this READ-ONLY table reports SQL/RAG/REST as fully
    // available even when the org has no integration, no document and no REST
    // connector. Recorded; it is why the endpoint describes itself as a diagnostic.
    expect((await scoresOf()).map((s) => s.availability)).toEqual([1, 1, 1, 1, 1])
  })

  test('similarityBoost is hardcoded to 0, unlike smartRoute', async () => {
    // getRoutingScores passes similarityBoost: 0 explicitly, and does not call
    // loadSimilarityBoost. A reader comparing this table to a live routing decision
    // would otherwise see two different scores for the same tool.
    expect((await scoresOf()).map((s) => s.similarityBoost)).toEqual([0, 0, 0, 0, 0])
  })

  test('the per-tool rows differ only by their performance data', async () => {
    // Because every `schemaScore` is 0 (empty tokens) and every `similarityBoost` is
    // 0, the only per-tool inputs left are the rows of `loadPerformanceMetrics`. This
    // asserts exactly that: two tools with different histories get different scores,
    // and the ones with no history share the NEUTRAL_PERF-derived 0.3.
    perfData = {
      SQL: { successRate: 1, avgLatencyMs: 0, total: 4, recentFailRate: 0, lastFailureAt: null },
      CHAT: { successRate: 0, avgLatencyMs: 5000, total: 4, recentFailRate: 0, lastFailureAt: null },
    }
    const byTool = Object.fromEntries((await scoresOf()).map((s) => [s.tool, s]))
    // SQL: 1*0.25 + 1*0.15 + 0.10
    expect(byTool.SQL!.finalScore).toBeCloseTo(0.5, 10)
    // CHAT: 0*0.25 + 0*0.15 + 0.10
    expect(byTool.CHAT!.finalScore).toBeCloseTo(0.1, 10)
    // RAG/REST/PLUGIN have no row and share the neutral value.
    expect(byTool.RAG!.finalScore).toBeCloseTo(0.3, 10)
    expect(byTool.REST!.finalScore).toBeCloseTo(0.3, 10)
    expect(byTool.PLUGIN!.finalScore).toBeCloseTo(0.3, 10)
    // All five remain in a fixed order: SQL, RAG, REST, CHAT, PLUGIN.
    expect((await scoresOf()).map((s) => s.tool)).toEqual(['SQL', 'RAG', 'REST', 'CHAT', 'PLUGIN'])
  })

  test('a tool absent from the performance table falls back to NEUTRAL_PERF', async () => {
    // `perfData[tool] ?? NEUTRAL_PERF` -- an org that never ran RAG still gets a
    // neutral row rather than a missing or NaN one.
    perfData = { SQL: { successRate: 1, avgLatencyMs: 100, total: 3, recentFailRate: 0, lastFailureAt: null } }
    const rag = await scoreFor('RAG')
    expect(rag.perfScore).toBe(0.5)
    expect(rag.perfMetrics.total).toBe(0)
    expect(perfDataOf(rag).avgLatencyMs).toBe(2500)
  })
})

describe('the circuit breaker, as this endpoint reports it', () => {
  test('ten runs with an 80% recent failure rate tripped and zero the score', async () => {
    perfData = {
      SQL: { successRate: 0.8, avgLatencyMs: 100, total: 10, recentFailRate: 0.8, lastFailureAt: new Date() },
    }
    const sql = await scoreFor('SQL')
    expect(sql.circuitBreakerTripped).toBe(true)
    expect(sql.finalScore).toBe(0)
    // perfScore still reports the raw success rate, not 0 -- only finalScore is zeroed.
    expect(sql.perfScore).toBe(0.8)
  })

  test('the breaker is asked about the threshold, exactly: total 10 and rate above 0.7', async () => {
    // `perf.total >= 10 && perf.recentFailRate > 0.7`. Nine runs is below the sample
    // size, and exactly 0.7 is not above the threshold. Both must stay untripped, or
    // a tool would be disabled on a coin flip.
    perfData = {
      SQL: { successRate: 0.2, avgLatencyMs: 100, total: 9, recentFailRate: 1, lastFailureAt: new Date() },
      RAG: { successRate: 0.2, avgLatencyMs: 100, total: 10, recentFailRate: 0.7, lastFailureAt: new Date() },
    }
    expect((await scoreFor('SQL')).circuitBreakerTripped).toBe(false)
    expect((await scoreFor('RAG')).circuitBreakerTripped).toBe(false)
    expect((await scoreFor('SQL')).finalScore).toBeGreaterThan(0)
  })

  test('this endpoint has NO half-open recovery, unlike smartRoute', async () => {
    // smartRoute requires the last failure to be inside CIRCUIT_BREAKER_COOLDOWN_MS
    // before it reports the breaker as tripped, and gives a half-open probe 50% of
    // the raw score. getRoutingScores uses the bare `total >= 10 && rate > 0.7`, so a
    // failure from a year ago still reports the breaker tripped. Recorded: the two
    // surfaces disagree by design, and this test is the one that says so.
    perfData = {
      SQL: {
        successRate: 0.2,
        avgLatencyMs: 100,
        total: 10,
        recentFailRate: 0.8,
        lastFailureAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      },
    }
    const sql = await scoreFor('SQL')
    expect(sql.circuitBreakerTripped).toBe(true)
    expect(sql.finalScore).toBe(0)
  })

  test('the reason string names the tool and the fail rate when tripped', async () => {
    perfData = {
      SQL: { successRate: 0.2, avgLatencyMs: 100, total: 10, recentFailRate: 0.82, lastFailureAt: new Date() },
    }
    expect((await scoreFor('SQL')).reason).toBe('SQL circuit breaker tripped (fail rate 82%)')
  })

  test('an untripped tool with no signal says so rather than emitting an empty reason', async () => {
    expect((await scoreFor('CHAT')).reason).toBe('CHAT — no strong signal, neutral')
  })

  test('an untripped tool with a strong history names the run count but NO schema match', async () => {
    // `buildReason` only appends "schema match N%" above 0.3, and schemaScore is
    // pinned at 0 in this endpoint, so that clause is unreachable here. Asserted
    // exactly: a call site that started passing real tokens would change this string.
    schemaMetadata = ['customers']
    perfData = {
      SQL: { successRate: 1, avgLatencyMs: 100, total: 12, recentFailRate: 0, lastFailureAt: null },
    }
    expect((await scoreFor('SQL')).reason).toBe('SQL: success 100% (12 runs)')
  })

  test('the success percentage is truncated toward zero, not rounded', async () => {
    // `perf.successRate * 100 | 0` in buildReason: 79.9% prints as "79%".
    perfData = {
      SQL: { successRate: 0.799, avgLatencyMs: 100, total: 12, recentFailRate: 0, lastFailureAt: null },
    }
    expect((await scoreFor('SQL')).reason).toBe('SQL: success 79% (12 runs)')
  })
})

describe('failures', () => {
  test('a loader failure is a 500 that leaks neither the error nor a partial table', async () => {
    perfThrows = new Error('connection terminated unexpectedly')
    const res = await GET()
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('connection terminated')
    const body = JSON.parse(raw) as Record<string, unknown>
    expect(Object.keys(body)).toEqual(['error'])
    expect(body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Failed to load routing scores.' })
  })

  test('the handler takes NO arguments, so it is called with none', async () => {
    // `export async function GET()` -- passing a Request here would be a type error
    // and a false signal that the handler reads the request. Asserted by arity so a
    // future signature change is a deliberate edit at this call site too.
    expect(GET).toHaveLength(0)
    expect((await GET()).status).toBe(200)
  })
})

// --- small readers -----------------------------------------------------------
type Perf = { successRate: number; avgLatencyMs: number; total: number; recentFailRate: number }
const perfDataOf = (s: Score): Perf => s.perfMetrics as unknown as Perf
const documentKeywordsOf = (body: Record<string, unknown>): string[] => body.documentKeywords as string[]
