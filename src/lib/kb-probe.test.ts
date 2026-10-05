import { beforeEach, describe, expect, mock, test } from 'bun:test'

const raw: { calls: Array<{ sql: string; params: unknown[] }>; hit: number | null; throws: boolean } = { calls: [], hit: null, throws: false }
mock.module('@/lib/db', () => ({
  db: {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      raw.calls.push({ sql, params })
      if (raw.throws) throw new Error('db down')
      return raw.hit === null ? [] : [{ hit: raw.hit }]
    },
  },
}))
let org: string | null = 'org-1'
mock.module('@/lib/prisma-tenant', () => ({ getOrgContext: () => org }))

const { probeTerms, probeKnowledgeBase, KB_PROBE_MIN_TERMS } = await import('@/lib/kb-probe')

beforeEach(() => {
  raw.calls = []
  raw.hit = null
  raw.throws = false
  org = 'org-1'
})

describe('probeTerms — the words a question could be matched on', () => {
  test('content words only: stop words, short words and question words are dropped, in either language', () => {
    expect(probeTerms('What accord, discussed in the context of advances against the drug trade, was established in 2016?'))
      .toEqual(['2016', 'accord', 'advances', 'against', 'context', 'discussed', 'drug', 'established', 'trade'])
    expect(probeTerms('Berapa persen dari mereka yang memilih eutanasia menurut buku?')).toEqual(['buku', 'memilih', 'mereka', 'persen', 'eutanasia'].sort())
  })

  test('punctuation inside a word cannot reach the tsquery (it would be an operator there)', () => {
    for (const t of probeTerms("What's the 'zero-cost' (re)start & reboot | policy!")) expect(t).toMatch(/^[\p{L}\p{N}]+$/u)
  })

  test('a chit-chat line has nothing to match on', () => {
    expect(probeTerms('Halo, apa kabar?')).toEqual(['halo', 'kabar'])
    expect(probeTerms('hi')).toEqual([])
  })
})

describe('probeKnowledgeBase — does one chunk hold most of the question?', () => {
  // Calibrated on the live-eval corpus (24 policy documents + a 1 MB book): at 60% of the terms and at least 3, the
  // probe caught 20 of the 24 book questions phrased as general knowledge and 1 of 40 general questions.
  const q = 'What accord, discussed in the context of advances against the drug trade, was established in 2016?' // 9 terms

  test('most of the terms in one chunk is strong', async () => {
    raw.hit = 6
    expect(await probeKnowledgeBase({ question: q })).toEqual({ strong: true, matched: 6, terms: 9 })
  })

  test('below the fraction is weak', async () => {
    raw.hit = 5
    expect((await probeKnowledgeBase({ question: q })).strong).toBe(false)
  })

  test(`fewer than ${KB_PROBE_MIN_TERMS} matched terms is weak even when it is all of them`, async () => {
    raw.hit = 2
    expect((await probeKnowledgeBase({ question: 'machine learning' })).strong).toBe(false)
  })

  test('the statement binds the org and, when scoped, the documents — never interpolates a term', async () => {
    raw.hit = 9
    await probeKnowledgeBase({ question: q, documentIds: ['d1', 'd2'] })
    const { sql, params } = raw.calls[0]
    expect(sql).toContain('"organizationId" = $1')
    expect(sql).toContain('"documentId" = ANY(')
    expect(params[0]).toBe('org-1')
    expect(params).toContainEqual(['d1', 'd2'])
    expect(sql).not.toContain('accord')
  })

  test('an EMPTY scope means every document, as for retrieval (access-scope.ts); no-document roles arrive as a sentinel id', async () => {
    raw.hit = 9
    await probeKnowledgeBase({ question: q, documentIds: [] })
    expect(raw.calls[0].sql).not.toContain('"documentId"')
    await probeKnowledgeBase({ question: q, documentIds: ['__no_document_is_visible_to_this_role__'] })
    expect(raw.calls[1].params).toContainEqual(['__no_document_is_visible_to_this_role__'])
  })

  test('no org context, no terms, or a database error: weak, with no leak', async () => {
    org = null
    expect((await probeKnowledgeBase({ question: q })).strong).toBe(false)
    org = 'org-1'
    expect((await probeKnowledgeBase({ question: 'hi' })).strong).toBe(false)
    raw.throws = true
    expect((await probeKnowledgeBase({ question: q })).strong).toBe(false)
    // Only the error case reached the database.
    expect(raw.calls).toHaveLength(1)
  })
})
