import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Captured Prisma calls — these assertions are about WHAT gets sent to the DB
// (org id present, all tokens used), so the mock records args rather than data.
let kgCreateManyArgs: any[] = []
let chunkFindManyArgs: any[] = []
let queryRawCalls: Array<{ strings: string[]; values: unknown[] }> = []
let kgRelationRows: Array<{ chunkId: string; source: string; target: string; description: string }> = []
let kgCreateManyThrows: Error | null = null
let queryRawThrows: Error | null = null

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
      findUnique: async () => ({ keywords: 'existing' }),
      update: async () => ({}),
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      queryRawCalls.push({ strings: [...strings], values })
      if (queryRawThrows) throw queryRawThrows
      return kgRelationRows
    },
  },
}))

const mockChatOnce = mock(async () => '{"entities":[],"relations":[]}')
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: async () => ({ provider: 'OPENAI', baseUrl: 'x', apiKey: 'k', model: 'm' }),
}))

import { dualLevelRetrieval, extractEntitiesRelations, indexChunkKnowledgeGraph } from './knowledge-graph'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

const TEST_ORG = 'org-kg-test'

beforeEach(async () => {
  enterWithOrg(TEST_ORG)
  kgCreateManyArgs = []
  chunkFindManyArgs = []
  queryRawCalls = []
  kgRelationRows = []
  queryRawThrows = null
  kgCreateManyThrows = null
})

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

  test('normalises entity names so relation lookup can match them', async () => {
    mockChatOnce.mockImplementationOnce(async () => extraction)
    await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })

    const row = kgCreateManyArgs[0].data[0]
    expect(row.source).toBe('acme corp')
    expect(row.target).toBe('invoice 42')
  })

  test('no org context → stores nothing rather than an unattributed row', async () => {
    mockChatOnce.mockImplementationOnce(async () => extraction)
    await bypassOrg(async () => {
      await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) })
    })
    expect(kgCreateManyArgs).toHaveLength(0)
  })

  test('a storage failure is contained, not rethrown', async () => {
    // Ingestion calls this fire-and-forget; it must never take the upload down.
    mockChatOnce.mockImplementationOnce(async () => extraction)
    kgCreateManyThrows = new Error('db down')
    await expect(
      indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: 'x'.repeat(80) }),
    ).resolves.toBeUndefined()
  })
})

describe('dualLevelRetrieval — local level', () => {
  test('matches on every query token, not just the first', async () => {
    await dualLevelRetrieval({ query: 'refund policy for invoice disputes', topK: 4 })

    const where = chunkFindManyArgs[0].where
    expect(Array.isArray(where.OR)).toBe(true)
    const matched = where.OR.map((c: any) => c.keywords.contains)
    expect(matched).toContain('refund')
    expect(matched).toContain('policy')
    expect(matched).toContain('invoice')
    expect(matched).toContain('disputes')
  })

  test('question words never become the match term', async () => {
    // The old tokenizer kept stopwords and used queryTokens[0], so this query
    // searched for chunks containing "what" — then boosted the hits by 1.3x.
    await dualLevelRetrieval({ query: 'what is the refund policy', topK: 4 })

    const matched = chunkFindManyArgs[0].where.OR.map((c: any) => c.keywords.contains)
    expect(matched).not.toContain('what')
    expect(matched).not.toContain('the')
    expect(matched).toEqual(['refund', 'policy'])
  })

  test('query with only stopwords retrieves nothing', async () => {
    const result = await dualLevelRetrieval({ query: 'what is the', topK: 4 })
    expect(result.allChunkIds).toEqual([])
    expect(chunkFindManyArgs).toHaveLength(0)
  })
})

describe('dualLevelRetrieval — global level tenancy', () => {
  test('the KgRelation query is filtered by organizationId', async () => {
    // Raw SQL bypasses the Prisma tenant extension, and relationContext below is
    // interpolated straight into the answer prompt — an unscoped row is a
    // cross-tenant disclosure in the model's output.
    await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })

    expect(queryRawCalls).toHaveLength(1)
    const sql = queryRawCalls[0].strings.join('?')
    expect(sql).toContain('"organizationId"')
    expect(queryRawCalls[0].values).toContain(TEST_ORG)
  })

  test('no org context → no relation query at all', async () => {
    await bypassOrg(async () => {
      const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
      expect(result.allChunkIds).toEqual([])
      expect(result.graphContext).toBe('')
    })
    expect(queryRawCalls).toHaveLength(0)
  })

  test('relations found → graph context is built for the prompt', async () => {
    kgRelationRows = [
      { chunkId: 'chunk-9', source: 'acme corp', target: 'invoice 42', description: 'was billed' },
    ]
    const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })

    expect(result.graphContext).toContain('acme corp')
    expect(result.graphContext).toContain('was billed')
    expect(result.globalChunks).toContain('chunk-9')
  })
})


describe('dualLevelRetrieval — a broken GLOBAL level degrades to local only', () => {
  test('a throwing relation query is contained, and the local level still returns', async () => {
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

  test('a HEALTHY relation query does produce graph context (the inverse)', async () => {
    kgRelationRows = [
      { chunkId: 'chunk-9', source: 'acme corp', target: 'invoice 42', description: 'was billed' },
    ]
    const result = await dualLevelRetrieval({ query: 'invoice disputes', topK: 4 })
    expect(result.graphContext).not.toBe('')
  })
})

describe('dualLevelRetrieval — a failure in the LOCAL level is still contained', () => {
  test('a throwing chunk lookup yields an empty result, not a throw', async () => {
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
    mockChatOnce.mockImplementation(async () => 'I am afraid I cannot do that.')
    await expect(extractEntitiesRelations(LONG, CFG)).resolves.toEqual({ entities: [], relations: [] })
  })

  test('a model that THROWS is likewise contained', async () => {
    mockChatOnce.mockImplementation(async () => { throw new Error('provider 503') })
    await expect(extractEntitiesRelations(LONG, CFG)).resolves.toEqual({ entities: [], relations: [] })
  })

  test('a short chunk never reaches the model at all', async () => {
    // The guard above the try: under 50 trimmed characters there is nothing worth
    // extracting, so the LLM is not called -- that is a cost decision, and it must
    // not also be a silent source of empty graphs for real chunks.
    mockChatOnce.mockImplementation(async () => JSON.stringify({ entities: [], relations: [] }))
    mockChatOnce.mockClear()
    const short = await extractEntitiesRelations('too short', CFG)
    expect(short).toEqual({ entities: [], relations: [] })
    expect(mockChatOnce).not.toHaveBeenCalled()
  })

  test('a well-formed reply is parsed into entities and relations', async () => {
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

  test('a WELL-FORMED reply does store edges (the inverse)', async () => {
    mockChatOnce.mockImplementation(async () => JSON.stringify({
      entities: [{ name: 'acme corp', type: 'ORG' }],
      relations: [{ source: 'acme corp', target: 'invoice 42', description: 'was billed', type: 'BILLED' }],
    }))
    await indexChunkKnowledgeGraph({ chunkId: 'chunk-1', content: LONG })
    expect(kgCreateManyArgs.length).toBe(1)
  })
})
