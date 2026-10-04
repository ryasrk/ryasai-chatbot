import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Captured Prisma calls — these assertions are about WHAT gets sent to the DB
// (org id present, all tokens used), so the mock records args rather than data.
let graphLockdownReason: string | null = null
let chunkExists = true
mock.module('@/lib/background-license', () => ({ backgroundLockdownReason: async () => graphLockdownReason }))
const graphDebugMessages: string[] = []
const actualLogger = await import('@/lib/logger')
const createLogger = actualLogger.scopedLogger
mock.module('@/lib/logger', () => ({ ...actualLogger, scopedLogger: (component: string) => {
  const logger = createLogger(component)
  return { ...logger, debug: (message: string, data?: Record<string, unknown>) => {
    if (component === 'kg') graphDebugMessages.push(message)
    logger.debug(message, data)
  } }
} }))
let kgCreateManyArgs: any[] = []
let chunkFindManyArgs: any[] = []
let queryRawCalls: Array<{ strings: string[]; values: unknown[] }> = []
let kgRelationRows: Array<{ chunkId: string; source: string; target: string; description: string }> = []
let chunkUpdateThrows: Error | null = null
let kgCreateManyThrows: Error | null = null
let queryRawThrows: Error | null = null
let rawUnsafeThrows: Error | null = null
let ddlStatements: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    kgRelation: {
      createMany: async (args: any) => {
        kgCreateManyArgs.push(args)
        if (kgCreateManyThrows) throw kgCreateManyThrows
        return { count: args.data.length }
      },
    },
    documentChunk: {
      findMany: async (args: any) => {
        chunkFindManyArgs.push(args)
        return [{ id: 'chunk-1', keywords: 'invoice,payment,refund' }]
      },
      // `indexChunkKnowledgeGraph` now uses the FILTER op so the tenant extension appends the org: the
      // read-modify-write could otherwise carry a foreign chunk's keywords into this tenant's row.
      findUnique: async () => null,
      findFirst: async () => chunkExists ? ({ keywords: 'existing' }) : null,
      update: async () => {
        if (chunkUpdateThrows) throw chunkUpdateThrows
        return {}
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push({ strings: [...strings], values })
      if (queryRawThrows) throw queryRawThrows
      return kgRelationRows
    },
    $executeRawUnsafe: async (sql: string) => {
      ddlStatements.push(sql)
      if (rawUnsafeThrows) throw rawUnsafeThrows
      // Failure window for the CONCURRENTLY-fallback test: set ONLY there, and only statements carrying
      // CONCURRENTLY throw — the extension and the blocking retries must succeed so the fallback is reachable.
      if ((globalThis as Record<string, unknown>).__kgConcurrentFail === true && /CONCURRENTLY/.test(sql)) {
        throw new Error('cannot run inside a transaction block')
      }
      return 1
    },
  },
}))

const mockChatOnce = mock(async () => '{"entities":[],"relations":[]}')
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
const actualLlmConfig = await import('@/lib/llm-config')
mock.module('@/lib/llm-config', () => ({
  ...actualLlmConfig,
  getRoleLlmConfig: async () => ({ provider: 'OPENAI', baseUrl: 'x', apiKey: 'k', model: 'm' }),
}))

const { dualLevelRetrieval, ensureKgTrgmIndexes, extractEntitiesRelations, indexChunkKnowledgeGraph, resetKgTrgmGuardForTests } = await import('./knowledge-graph')
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

const TEST_ORG = 'org-kg-test'

// INCIDENT: nine tests failed on Bun 1.4.2 while passing on 1.3.14, and the cause was
// NOT this file. A minimal probe proved that on 1.4.2 `AsyncLocalStorage.enterWith()`
// called inside a `beforeEach` does not reach the test body AT ALL -- not even a
// synchronous one, and not across `await`. So getOrgContext() returned undefined, the
// org-scoped guard in the code under test bailed out before doing any work, and every
// healthy-path assertion failed with `Expected: 1, Received: 0`.
//
// `enterWith` DOES work when called inside the test body itself (verified on both
// versions), so the org is established by `withOrg` below rather than by a hook. The
// hook keeps doing what it is reliable for: resetting the mock state.
beforeEach(() => {
  graphLockdownReason = null
  graphDebugMessages.length = 0
  mockChatOnce.mockReset()
  mockChatOnce.mockImplementation(async () => '{"entities":[],"relations":[]}')
  chunkExists = true
  kgCreateManyArgs = []
  chunkFindManyArgs = []
  queryRawCalls = []
  kgRelationRows = []
  queryRawThrows = null
  kgCreateManyThrows = null
  rawUnsafeThrows = null
  ddlStatements = []
  resetKgTrgmGuardForTests()
})

// Enter the org and run the body. Must be called INSIDE the test, not in a hook.
// Under Bun 1.4.2 a hook's enterWith is discarded before the body runs.
function withOrg<T>(fn: () => Promise<T> | T): Promise<T> {
  enterWithOrg(TEST_ORG)
  return Promise.resolve().then(fn)
}

describe('indexChunkKnowledgeGraph — relation storage', () => {
  const extraction = JSON.stringify({
    entities: [
      { name: 'acme corp', type: 'organization', description: 'a customer' },
      { name: 'invoice 42', type: 'concept', description: 'an invoice' },
    ],
    relations: [
      { source: 'Acme Corp', target: 'Invoice 42', description: 'was billed', keywords: 'billing' },
    ],
  })

  test('writes organizationId — the omission that made every insert throw', async () => {
    return withOrg(async () => {
    // KgRelation.organizationId is NOT NULL with no default. The raw INSERT used to
    // omit it, so every relation write failed and was swallowed as "table not
    // available" — the global half of dual-level retrieval never stored one row.
    mockChatOnce.mockImplementationOnce(async () => extraction)
    await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })

    expect(kgCreateManyArgs).toHaveLength(1)
    const rows = kgCreateManyArgs[0].data
    expect(rows).toHaveLength(1)
    expect(rows[0].organizationId).toBe(TEST_ORG)
    expect(rows[0].chunkId).toBe('chunk-1')
    })
  })

  test('normalises entity names so relation lookup can match them', async () => {
    return withOrg(async () => {
    mockChatOnce.mockImplementationOnce(async () => extraction)
    await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })

    const row = kgCreateManyArgs[0].data[0]
    expect(row.source).toBe('acme corp')
    expect(row.target).toBe('invoice 42')
    })
  })

  test('no org context → stores nothing rather than an unattributed row', async () => {
    return withOrg(async () => {
    mockChatOnce.mockImplementationOnce(async () => extraction)
    try {
      await bypassOrg(async () => {
        await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })
      })
    } finally {
      // orgStorage.run() does NOT restore the caller's context on return, so every
      // test after this one would silently run with NO org and bail before doing any
      // work -- which is how two healthy-path tests came to fail only in CI.
      enterWithOrg(TEST_ORG)
    }
    expect(kgCreateManyArgs).toHaveLength(0)
    })
  })

  test('a failure BEFORE relation storage is also contained (the outer catch)', async () => {
    return withOrg(async () => {
    // The test above drives the INNER catch around kgRelation.createMany (line 161). The OUTER
    // catch on line 177 is a different handler and had no coverage: it is what contains a
    // failure in getRoleLlmConfig, in extractEntitiesRelations, or in the chunk keyword write
    // that happens BEFORE relations are touched. A throw from documentChunk.update reaches
    // only the outer one, and ingestion calls this function fire-and-forget -- an escaping
    // error would take a document upload down with it.
    mockChatOnce.mockImplementationOnce(async () => extraction)
    chunkUpdateThrows = new Error('chunk write failed')
    try {
      await expect(
        indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) }),
      ).resolves.toBeUndefined()
      // The relation write must NOT have been attempted: the outer catch aborts the rest of
      // the function, so a partially-applied graph is impossible.
      expect(kgCreateManyArgs).toHaveLength(0)
    } finally {
      chunkUpdateThrows = null
    }
    })
  })

  test('an LLM failure during extraction is contained too', async () => {
    return withOrg(async () => {
    // The same outer catch, entered from the other side: before ANY database write.
    mockChatOnce.mockImplementationOnce(async () => {
      throw new Error('provider 502')
    })
    await expect(
      indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) }),
    ).resolves.toBeUndefined()
    expect(kgCreateManyArgs).toHaveLength(0)
    })
  })

  test('a storage failure is contained, not rethrown', async () => {
    return withOrg(async () => {
    // Ingestion calls this fire-and-forget; it must never take the upload down.
    mockChatOnce.mockImplementationOnce(async () => extraction)
    kgCreateManyThrows = new Error('db down')
    await expect(
      indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) }),
    ).resolves.toBeUndefined()
    })
  })
})

describe('dualLevelRetrieval — local level', () => {
  test('matches on every query token, not just the first', async () => {
    return withOrg(async () => {
    await dualLevelRetrieval({ query: 'refund policy for invoice disputes', topK: 4 })

    const where = chunkFindManyArgs[0].where
    expect(Array.isArray(where.OR)).toBe(true)
    const matched = where.OR.map((c: any) => c.keywords.contains)
    expect(matched).toContain('refund')
    expect(matched).toContain('policy')
    expect(matched).toContain('invoice')
    expect(matched).toContain('disputes')
    })
  })

  test('question words never become the match term', async () => {
    return withOrg(async () => {
    // The old tokenizer kept stopwords and used queryTokens[0], so this query
    // searched for chunks containing "what" — then boosted the hits by 1.3x.
    await dualLevelRetrieval({ query: 'what is the refund policy', topK: 4 })

    const matched = chunkFindManyArgs[0].where.OR.map((c: any) => c.keywords.contains)
    expect(matched).not.toContain('what')
    expect(matched).not.toContain('the')
    expect(matched).toEqual(['refund', 'policy'])
    })
  })

  test('query with only stopwords retrieves nothing', async () => {
    return withOrg(async () => {
    const result = await dualLevelRetrieval({ query: 'what is the', topK: 4 })
    expect(result.allChunkIds).toEqual([])
    expect(chunkFindManyArgs).toHaveLength(0)
    })
  })
})

describe('dualLevelRetrieval — global level tenancy', () => {
  test('the KgRelation query is filtered by organizationId', async () => {
    return withOrg(async () => {
    // Raw SQL bypasses the Prisma tenant extension, and relationContext below is
    // interpolated straight into the answer prompt — an unscoped row is a
    // cross-tenant disclosure in the model's output.
    await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })

    expect(queryRawCalls).toHaveLength(1)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toContain('"organizationId"')
    expect(queryRawCalls[0].values).toContain(TEST_ORG)
    })
  })

  test('no org context → no relation query at all', async () => {
    return withOrg(async () => {
    try {
      await bypassOrg(async () => {
        const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
        expect(result.allChunkIds).toEqual([])
        expect(result.graphContext).toBe('')
      })
    } finally {
      enterWithOrg(TEST_ORG)
    }
    expect(queryRawCalls).toHaveLength(0)
    })
  })

  test('relations found → graph context is built for the prompt', async () => {
    return withOrg(async () => {
    kgRelationRows = [
      { chunkId: 'chunk-9', source: 'acme corp', target: 'invoice 42', description: 'was billed' },
    ]
    const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })

    expect(result.graphContext).toContain('acme corp')
    expect(result.graphContext).toContain('was billed')
    expect(result.globalChunks).toContain('chunk-9')
    })
  })
})


describe('dualLevelRetrieval — a broken GLOBAL level degrades to local only', () => {
  test('a throwing relation query is contained, and the local level still returns', async () => {
    return withOrg(async () => {
    // The catch at 269-271. Global graph retrieval is an ENHANCEMENT layered on the
    // local level: if the relation query fails (missing table, timeout), the caller
    // must still receive its local chunks. Rethrowing would turn a partial outage in
    // an optional feature into a TOTAL retrieval failure.
    queryRawThrows = new Error('relation "KgRelation" does not exist')
    const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
    // THE DECISIVE ASSERTION, and the one my first three versions missed.
    // `graphContext === ''` is ALSO what a totally failed retrieval returns, and the
    // OUTER catch (288-290) returns empty everything -- so rethrowing from 269-271
    // still satisfied every assertion I had. The difference between "degraded to
    // local only" and "failed entirely" is that the LOCAL level survived: the local
    // chunk ids must still be present. Without this, the test could not tell the
    // two apart and stayed green when the degradation was deleted.
    expect(result.localChunks).toEqual(['chunk-1'])
    expect(result.allChunkIds).toEqual(['chunk-1'])
    // The raw query WAS attempted -- proving we reached the catch rather than
    // skipping the global level for some other reason.
    expect(queryRawCalls.length).toBeGreaterThan(0)
    // ...and the graph half contributed NOTHING, which is the degradation.
    expect(result.globalChunks).toEqual([])
    // DECISIVE: a healthy query in the same fixture yields a NON-EMPTY graph
    // context and extra global chunks. Without this comparison the assertions above
    // were satisfied even when the catch rethrew (measured: deleting the degradation
    // left this test green), because 'no graph context' is also what a skipped
    // global level produces. The fixture must be one whose global level WOULD
    // succeed, so the failure is what removes it.
    queryRawThrows = null
    kgRelationRows = [
      { chunkId: 'chunk-global', source: 'acme corp', target: 'invoice 42', description: 'was billed' },
    ]
    const healthy = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
    expect(healthy.graphContext).not.toBe('')
    expect(healthy.graphContext).toContain('was billed')
    expect(healthy.globalChunks).toContain('chunk-global')
    })
  })

  test('a HEALTHY relation query does produce graph context (the inverse)', async () => {
    return withOrg(async () => {
    kgRelationRows = [
      { chunkId: 'chunk-9', source: 'acme corp', target: 'invoice 42', description: 'was billed' },
    ]
    const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
    expect(result.graphContext).not.toBe('')
    })
  })
})

describe('dualLevelRetrieval — a failure in the LOCAL level is still contained', () => {
  test('a throwing chunk lookup yields an empty result, not a throw', async () => {
    return withOrg(async () => {
    // The catch at 288-290, the outermost guard. This is the backstop: whatever
    // goes wrong inside (including the local Prisma read), the call returns a shape
    // callers can destructure. A throw here would propagate into the answer path.
    const { db } = await import('@/lib/db')
    const original = db.documentChunk.findMany
    ;(db.documentChunk as { findMany: unknown }).findMany = async () => {
      throw new Error('documentChunk exploded')
    }
    try {
      const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
      expect(result).toEqual({
        localChunks: [],
        globalChunks: [],
        allChunkIds: [],
        matchedEntities: [],
        graphContext: '',
      })
    } finally {
      ;(db.documentChunk as { findMany: unknown }).findMany = original
    }
    })
  })
})

describe('entity extraction — a model that returns junk degrades to no entities', () => {
  // The catch at 91-93. The extractor asks an LLM for JSON, and an LLM can reply
  // with prose or a truncated response. An ingest must not abort because one model
  // reply was malformed: the chunk is still stored, merely without graph edges.
  // NOTE the guard above the try -- `text.trim().length < 50` returns EARLY, so a
  // fixture with a short chunk would never reach the parser at all.
  const LONG = 'This is a sufficiently long chunk of invoice text for extraction. '.repeat(3)

  // MEASURED -- and my first two attempts at this were wrong. Driving
  // indexChunkKnowledgeGraph with a junk reply left BOTH of these controls green,
  // because that function wraps the extraction in its own try/catch: a rethrow from
  // 91-93 is swallowed one level up, and "nothing was written" is equally true when
  // the call throws. The catch at 91-93 is only observable by calling the EXPORTED
  // extractor directly, which is what it is for.
  const CFG = { id: 'cfg-1', provider: 'OPENAI', baseUrl: 'x', apiKey: 'k', model: 'm' } as never

  test('an unparseable model reply returns empty edges instead of throwing', async () => {
    return withOrg(async () => {
    mockChatOnce.mockImplementation(async () => 'I am afraid I cannot do that.')
    await expect(extractEntitiesRelations(LONG, CFG)).resolves.toEqual({ entities: [], relations: [] })
    })
  })

  test('a model that THROWS is likewise contained', async () => {
    return withOrg(async () => {
    mockChatOnce.mockImplementation(async () => { throw new Error('provider 503') })
    await expect(extractEntitiesRelations(LONG, CFG)).resolves.toEqual({ entities: [], relations: [] })
    })
  })

  test('a short chunk never reaches the model at all', async () => {
    return withOrg(async () => {
    // The guard above the try: under 50 trimmed characters there is nothing worth
    // extracting, so the LLM is not called -- that is a cost decision, and it must
    // not also be a silent source of empty graphs for real chunks.
    mockChatOnce.mockImplementation(async () => JSON.stringify({ entities: [], relations: [] }))
    mockChatOnce.mockClear()
    const short = await extractEntitiesRelations('too short', CFG)
    expect(short).toEqual({ entities: [], relations: [] })
    expect(mockChatOnce).not.toHaveBeenCalled()
    })
  })

  test('a well-formed reply is parsed into entities and relations', async () => {
    return withOrg(async () => {
    // The inverse, so the empty results above are provably the DEGRADED path.
    mockChatOnce.mockImplementation(async () => JSON.stringify({
      entities: [{ name: 'acme corp', type: 'ORG' }],
      relations: [{ source: 'acme corp', target: 'invoice 42', description: 'was billed', type: 'BILLED' }],
    }))
    const out = await extractEntitiesRelations(LONG, CFG)
    expect(out.entities.length).toBe(1)
    expect(out.entities[0].name).toBe('acme corp')
    expect(out.relations.length).toBe(1)
    })
  })

  test('a WELL-FORMED reply does store edges (the inverse)', async () => {
    return withOrg(async () => {
    mockChatOnce.mockImplementation(async () => JSON.stringify({
      entities: [{ name: 'acme corp', type: 'ORG' }],
      relations: [{ source: 'acme corp', target: 'invoice 42', description: 'was billed', type: 'BILLED' }],
    }))
    await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: LONG })
    expect(kgCreateManyArgs.length).toBe(1)
    })
  })
})

describe('ensureKgTrgmIndexes — the KG scan stays fast as the graph grows', () => {
  /*
   * MEASURED NEED (simulated to 134k rows, because at today's 131 the query is instant): `source ILIKE '%tok%'`
   * cannot use the btree indexes on that column — infix patterns defeat them — so the scan is proportional to row
   * count: 0.14 ms today, 11 ms at ~17k rows, 94 ms at ~134k. With a GIN trigram index the 134k case measured 9 ms.
   * The table grows with every document uploaded, so this is the one KG cost that scales with corpus size.
   *
   * Prisma cannot express an operator class, and `db push` runs on every boot — a Prisma-managed index it cannot
   * re-derive would be treated as drift and dropped. So the index is created at runtime with IF NOT EXISTS, the same
   * pattern `rag-fts.ts` uses for the tsv index.
   */
  test('creates the extension and a CONCURRENTLY index, once per process', async () => {
    await ensureKgTrgmIndexes()
    await ensureKgTrgmIndexes()
    expect(ddlStatements.filter((x) => /pg_trgm/.test(x)).length).toBe(1)
    const idx = ddlStatements.filter((x) => /KgRelation_(source|target)_trgm/.test(x))
    // TWO statements — one per column. A single multicolumn GIN would be one statement and MEASURED never used
    // (Postgres can only probe its leading column), so this count is the guard against collapsing back to it.
    expect(idx.length).toBe(2)
    for (const st of idx) {
      expect(st).toContain('CONCURRENTLY')
      expect(st).toContain('gin_trgm_ops')
    }
    expect(idx.some((x) => x.includes('ON "KgRelation" USING GIN (source gin_trgm_ops)'))).toBe(true)
    expect(idx.some((x) => x.includes('ON "KgRelation" USING GIN (target gin_trgm_ops)'))).toBe(true)
  })

  test('a CONCURRENTLY failure falls back to the blocking form rather than skipping the index', async () => {
    /*
     * Only the CONCURRENTLY builds may fail here. Patching the captured `db` object does not reach the reference the
     * module under test bound at import, so the failure is delivered through the module mock itself: a window on
     * globalThis that the mock consults per statement. MEASURED: an earlier version threw for EVERY statement, which
     * made the EXTENSION throw too, and the function returned at that catch before any index was attempted — the test
     * then measured zero statements and passed for no reason.
     */
    resetKgTrgmGuardForTests()
    ddlStatements = []
    rawUnsafeThrows = null
    ;(globalThis as Record<string, unknown>).__kgConcurrentFail = true
    try {
      await ensureKgTrgmIndexes()
    } finally {
      ;(globalThis as Record<string, unknown>).__kgConcurrentFail = undefined
    }
    const idx = ddlStatements.filter((x) => /KgRelation_(source|target)_trgm/.test(x))
    // The first CONCURRENTLY throw abandons the rest of the try block, so the sequence is
    // [src-CONCURRENTLY, src-blocking, tgt-blocking]: THREE index statements, the last two WITHOUT CONCURRENTLY.
    // (A 4-statement expectation assumed the second CONCURRENTLY also ran; it does not, by construction.)
    expect(idx.length, 'the blocking fallbacks must have run for BOTH columns').toBe(3)
    expect(idx[1]).not.toContain('CONCURRENTLY')
    expect(idx[2]).not.toContain('CONCURRENTLY')
    expect(idx[1]).toContain('source')
    expect(idx[2]).toContain('target')
  })

  test('a database that cannot take the extension keeps working, unindexed, and says so ONCE', async () => {
    resetKgTrgmGuardForTests()
    rawUnsafeThrows = new Error('permission denied to create extension')
    await ensureKgTrgmIndexes()   // must not throw: the query works without the index, just slower
    resetKgTrgmGuardForTests()
    rawUnsafeThrows = null
  })

  test('dualLevelRetrieval ensures the index before its first global scan', async () => {
    return withOrg(async () => {
      await dualLevelRetrieval({ query: 'refund policy' })
      expect(ddlStatements.some((x) => /gin_trgm_ops/.test(x))).toBe(true)
    })
  })

  test('with the DDL disabled the retrieval query still runs — the index is a speed-up, never a dependency', async () => {
    return withOrg(async () => {
      process.env.KG_TRGM_DISABLED = '1'
      resetKgTrgmGuardForTests()
      const r = await dualLevelRetrieval({ query: 'refund policy' })
      expect(typeof r.graphContext).toBe('string')
      process.env.KG_TRGM_DISABLED = undefined
    })
  })

  test('the entity scan is expressed as ONE ILIKE PER PATTERN, not ILIKE ANY', async () => {
    /*
     * MEASURED at 1.05M rows: the two forms return the same rows at the same plain-SQL cost, but the planner
     * converts ONLY the expanded OR to the GIN trigram indexes (a BitmapOr). `ILIKE ANY` walks the array per row
     * and stayed a sequential scan — the indexes would exist and do nothing, which is the exact shape of a defence
     * that is correct while the only caller bypasses it. Reading the source is the only way to pin a SQL FORM.
     */
    const src = await Bun.file(new URL('./knowledge-graph.ts', import.meta.url)).text()
    // Comments are stripped: this file's own comments explain WHY the old form was abandoned and would
    // otherwise satisfy the assertion from the FIX'S OWN NOTES — the exact vacuous-guard shape this repo records.
    const code = src
      .split('\n')
      .map((l) => (l.trimStart().startsWith('*') || l.trimStart().startsWith('//') || l.trimStart().startsWith('/*') ? '' : l))
      .join('\n')
    expect(code).toContain('r.source ILIKE ${p}')
    expect(code).toContain('r.target ILIKE ${p}')
    expect(code).not.toContain('ILIKE ANY')
  })
})


test('locked chunk indexing calls neither the provider nor relation persistence', () => withOrg(async () => {
  graphLockdownReason = 'expired'
  mockChatOnce.mockClear()
  await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })
  expect(mockChatOnce).not.toHaveBeenCalled()
  expect(kgCreateManyArgs).toHaveLength(0)
}))
test('a foreign or deleted chunk is refused before extraction and relation persistence', () => withOrg(async () => {
  chunkExists = false
  mockChatOnce.mockClear()
  await indexChunkKnowledgeGraph({ chunkId: 'foreign', content: 'x'.repeat(80) })
  expect(mockChatOnce).not.toHaveBeenCalled()
  expect(kgCreateManyArgs).toHaveLength(0)
}))


test('failed relation persistence never logs the chunk as indexed', () => withOrg(async () => {
  mockChatOnce.mockImplementationOnce(async () => JSON.stringify({ entities: [{ name: 'entity', type: 'concept' }], relations: [{ source: 'entity', target: 'entity' }] }))
  kgCreateManyThrows = new Error('relation write failed')
  await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })
  expect(kgCreateManyArgs).toHaveLength(1)
  expect(graphDebugMessages).not.toContain('Indexed chunk KG')
}))
