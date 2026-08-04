import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Captured Prisma calls — these assertions are about WHAT gets sent to the DB
// (org id present, all tokens used), so the mock records args rather than data.
let kgCreateManyArgs: any[] = []
let chunkFindManyArgs: any[] = []
let queryRawCalls: Array<{ strings: string[]; values: unknown[] }> = []
let kgRelationRows: Array<{ chunkId: string; source: string; target: string; description: string }> = []
let kgCreateManyThrows: Error | null = null

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
      return kgRelationRows
    },
  },
}))

const mockChatOnce = mock(async () => '{"entities":[],"relations":[]}')
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({
  getRoleLlmConfig: async () => ({ provider: 'OPENAI', baseUrl: 'x', apiKey: 'k', model: 'm' }),
}))

import { dualLevelRetrieval, indexChunkKnowledgeGraph } from './knowledge-graph'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

const TEST_ORG = 'org-kg-test'

beforeEach(async () => {
  enterWithOrg(TEST_ORG)
  kgCreateManyArgs = []
  chunkFindManyArgs = []
  queryRawCalls = []
  kgRelationRows = []
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
