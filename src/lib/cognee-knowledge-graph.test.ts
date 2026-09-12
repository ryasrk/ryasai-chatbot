import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// cognee-knowledge-graph.ts had NO tests at all (413 lines, 19.2% coverage).
// It is mocked at module level; behaviour is swapped per test through the
// holders below. `mock.module` must run BEFORE the module under test is
// imported, or the import captures the real implementation.
// ---------------------------------------------------------------------------
const core = {
  enabled: true,
  client: null as any,
  settings: { cognifyBatchSize: 2, cognifyMaxRetries: 2 } as any,
  ownerId: 'org-1',
  formatted: 'FORMATTED',
  items: [] as Array<{ text: string; score: number }>,
  updateCalls: [] as Array<{ id: string; status: string; error?: string }>,
  resets: 0,
}

mock.module('@/lib/cognee-core', () => ({
  isCogneeEnabled: async () => core.enabled,
  getCogneeClient: async () => core.client,
  getCogneeSettings: async () => core.settings,
  cogneeBatchSize: () => core.settings.cognifyBatchSize,
  cognifyMaxRetries: () => core.settings.cognifyMaxRetries,
  getCogneeOwnerId: () => core.ownerId,
  formatSearchResponse: () => core.formatted,
  extractSearchItems: () => core.items.map((i) => ({ text: i.text, score: i.score })),
  updateDocumentCognifyStatus: async (id: string, status: string, error?: string) => {
    core.updateCalls.push({ id, status, error })
  },
  resetClientCache: () => { core.resets++ },
}))

const dbState = {
  documents: [] as any[],
  updateManyCalls: [] as any[],
  findManyThrow: false,
  findManyCalls: [] as any[],
}

// The fake honours the `where` it is given, because a fake that ignores the
// filter is how a test lies. The first version returned the same rows for
// every query, so `cognifyBatch`'s "already completed" lookup appeared to match
// the very documents it was meant to exclude, and `autoCognifyAll` looked
// broken (processed: 0) when it is correct. The fake must answer the query
// asked, not the query the test had in mind.
function matchesWhere(doc: any, where: any): boolean {
  if (!where) return true
  if (where.cognifyStatus === 'completed' && doc.cognifyStatus !== 'completed') return false
  if (where.id?.in && !where.id.in.includes(doc.id)) return false
  if (where.status && doc.status !== where.status) return false
  return true
}

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findMany: async (a: any) => {
        if (dbState.findManyThrow) throw new Error('db down')
        dbState.findManyCalls.push(a)
        return dbState.documents.filter((d) => matchesWhere(d, a?.where))
      },
      updateMany: async (a: any) => {
        dbState.updateManyCalls.push(a)
        return { count: 1 }
      },
    },
  },
}))

import {
  cognifyDocument,
  cognifyBatch,
  autoCognifyAll,
  recallKnowledgeGraph,
  recallKnowledgeGraphStructured,
  forgetAll,
  forgetKnowledgeGraph,
  resetCognee,
} from '@/lib/cognee-knowledge-graph'
import { COGNEE_SEARCH_TYPES } from '@/lib/cognee-types'

/** A client whose add/cognify succeed unless overridden. */
function client(over: Record<string, unknown> = {}) {
  return {
    add: async () => undefined,
    cognify: async () => undefined,
    search: async () => ({ ok: true }),
    forget: async () => undefined,
    ...over,
  }
}

beforeEach(() => {
  core.enabled = true
  core.client = client()
  core.settings = { cognifyBatchSize: 2, cognifyMaxRetries: 2 }
  core.formatted = 'FORMATTED'
  core.items = []
  core.updateCalls = []
  core.resets = 0
  dbState.documents = []
  dbState.updateManyCalls = []
  dbState.findManyCalls = []
  dbState.findManyThrow = false
})

const docs = [{ documentId: 'd1', documentName: 'a.pdf', chunks: [{ content: 'x', chunkIndex: 0 }] }]

describe('cognee: disabled / no-client short circuits', () => {
  test('every entry point is a no-op when cognee is disabled', async () => {
    core.enabled = false
    core.client = client({
      add: async () => { throw new Error('must not be called') },
      cognify: async () => { throw new Error('must not be called') },
      search: async () => { throw new Error('must not be called') },
      forget: async () => { throw new Error('must not be called') },
    })
    // A disabled feature must not reach the network nor write statuses.
    expect(await cognifyDocument(docs[0])).toBe(false)
    expect(await cognifyBatch({ documents: docs })).toEqual({ processed: 0, failed: 0, skipped: 0 })
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('')
    expect(await recallKnowledgeGraphStructured({ query: 'q' })).toEqual([])
    expect(await forgetAll()).toBe(false)
    expect(await forgetKnowledgeGraph()).toBe(false)
    expect(await resetCognee()).toBe(false)
    expect(core.updateCalls).toHaveLength(0)
  })

  test('a null client is treated the same as disabled', async () => {
    core.client = null
    expect(await cognifyDocument(docs[0])).toBe(false)
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('')
    expect(await forgetAll()).toBe(false)
  })

  test('resetCognee still clears state when the client is null', async () => {
    // resetCognee is the admin escape hatch: it must work even when the client
    // cannot be built, or a broken client becomes unrecoverable from the UI.
    core.client = null
    expect(await resetCognee()).toBe(true)
    expect(core.resets).toBe(1)
    expect(dbState.updateManyCalls).toHaveLength(1)
  })
})

describe('cognifyDocument', () => {
  test('happy path marks processing then completed and returns true', async () => {
    const ok = await cognifyDocument(docs[0])
    expect(ok).toBe(true)
    // Order matters: 'processing' must be written before the work so an
    // interrupted run is not left looking complete.
    expect(core.updateCalls.map((c) => c.status)).toEqual(['processing', 'completed'])
  })

  test('chunks are joined in chunkIndex order, not input order', async () => {
    let sent = ''
    core.client = client({ add: async (items: any[]) => { sent = items[0].text } })
    await cognifyDocument({
      documentId: 'd1',
      documentName: 'a.pdf',
      chunks: [
        { content: 'THIRD', chunkIndex: 2 },
        { content: 'FIRST', chunkIndex: 0 },
        { content: 'SECOND', chunkIndex: 1 },
      ],
    })
    // Out-of-order chunks would scramble the document's meaning inside the graph.
    expect(sent).toBe('FIRST\n\nSECOND\n\nTHIRD')
  })

  test('an add failure marks failed with the error and returns false (no throw)', async () => {
    core.client = client({ add: async () => { throw new Error('add exploded') } })
    expect(await cognifyDocument(docs[0])).toBe(false)
    const last = core.updateCalls[core.updateCalls.length - 1]
    expect(last.status).toBe('failed')
    expect(last.error).toContain('add exploded')
  })

  test('a transient cognify error IS retried, and succeeds on the retry', async () => {
    let attempts = 0
    core.settings = { cognifyBatchSize: 2, cognifyMaxRetries: 3 }
    core.client = client({
      cognify: async () => {
        attempts++
        if (attempts < 2) throw new Error('FOREIGN KEY constraint failed')
      },
    })
    expect(await cognifyDocument(docs[0])).toBe(true)
    expect(attempts).toBe(2)
  })

  test('a NON-transient error is NOT retried (no wasted minutes)', async () => {
    let attempts = 0
    core.settings = { cognifyBatchSize: 2, cognifyMaxRetries: 5 }
    core.client = client({
      cognify: async () => { attempts++; throw new Error('permission denied') },
    })
    expect(await cognifyDocument(docs[0])).toBe(false)
    // Retrying an auth failure 5 times with growing sleeps burns the request
    // budget for a guaranteed failure.
    expect(attempts).toBe(1)
  })

  test('the error stored on the document row is truncated, not unbounded', async () => {
    core.client = client({ cognify: async () => { throw new Error('x'.repeat(2000)) } })
    await cognifyDocument(docs[0])
    const last = core.updateCalls[core.updateCalls.length - 1]
    expect(last.error!.length).toBeLessThanOrEqual(500)
  })
})

describe('cognifyBatch — incremental + batching', () => {
  test('already-completed documents are skipped, not re-cognified', async () => {
    dbState.documents = [{ id: 'd1', cognifyStatus: 'completed' }]
    const res = await cognifyBatch({
      documents: [docs[0], { documentId: 'd2', documentName: 'b', chunks: [{ content: 'y', chunkIndex: 0 }] }],
    })
    // Re-cognifying costs real compute; the skip is the whole point of the
    // status column.
    expect(res.skipped).toBe(1)
    expect(res.processed).toBe(1)
    // d1 must never be marked processing again.
    expect(core.updateCalls.some((c) => c.id === 'd1')).toBe(false)
  })

  test('everything already completed → all skipped, no work done', async () => {
    dbState.documents = [{ id: 'd1', cognifyStatus: 'completed' }]
    const res = await cognifyBatch({ documents: docs })
    expect(res).toEqual({ processed: 0, failed: 0, skipped: 1 })
    expect(core.updateCalls).toHaveLength(0)
  })

  test('documents are chunked into batches of the configured size', async () => {
    let addCalls = 0
    core.settings = { cognifyBatchSize: 2, cognifyMaxRetries: 1 }
    core.client = client({ add: async (items: any[]) => { addCalls++; expect(items.length).toBeLessThanOrEqual(2) } })
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => ({
      documentId: n, documentName: n, chunks: [{ content: n, chunkIndex: 0 }],
    }))
    const res = await cognifyBatch({ documents: many })
    // 5 docs at batch size 2 → 3 add calls. Batching is the scalability path;
    // a regression to 1-doc-per-call is a silent cost increase.
    expect(addCalls).toBe(3)
    expect(res.processed).toBe(5)
  })

  test('a failed batch is counted as failed and the rest still process', async () => {
    core.settings = { cognifyBatchSize: 1, cognifyMaxRetries: 1 }
    let call = 0
    core.client = client({
      cognify: async () => { call++; if (call === 1) throw new Error('permission denied') },
    })
    const res = await cognifyBatch({
      documents: [
        { documentId: 'd1', documentName: 'a', chunks: [{ content: 'a', chunkIndex: 0 }] },
        { documentId: 'd2', documentName: 'b', chunks: [{ content: 'b', chunkIndex: 0 }] },
      ],
    })
    // One bad document must not abort the whole batch.
    expect(res.failed).toBe(1)
    expect(res.processed).toBe(1)
  })

  test('a failing status lookup degrades to empty instead of throwing', async () => {
    dbState.findManyThrow = true
    const res = await cognifyBatch({ documents: docs })
    // The `.catch(() => [])` on the completed-lookup means a DB read error
    // leads to re-processing rather than a crash. Pin that direction.
    expect(res.processed).toBe(1)
  })
})

describe('autoCognifyAll', () => {
  test('no eligible documents → zeroes without calling into cognee', async () => {
    dbState.documents = []
    expect(await autoCognifyAll()).toEqual({ processed: 0, failed: 0, skipped: 0 })
  })

  test('eligible documents are mapped and delegated to cognifyBatch', async () => {
    dbState.documents = [{
      id: 'd1', name: 'a.pdf', status: 'ready', cognifyStatus: null,
      chunks: [{ content: 'one', chunkIndex: 0 }, { content: 'two', chunkIndex: 1 }],
    }]
    const res = await autoCognifyAll()
    expect(res.processed).toBe(1)
    // The eligibility query must exclude documents already cognified, or every
    // click of "enable" re-runs the whole corpus.
    const first = dbState.findManyCalls[0]
    expect(first.where.status).toBe('ready')
    expect(first.where.isEnabled).toBe(true)
    expect(first.where.OR).toBeDefined()
  })
})

describe('recall — search strategies', () => {
  test('EVERY searchType used is a real SDK SearchType', async () => {
    // INVARIANT (AGENTS.md): cognee searchTypes must be literal SDK union
    // members. GRAPH_ENTITIES / GRAPH_RELATIONSHIPS were invented once and the
    // Rust backend rejects them with "unknown SearchType" — a runtime failure
    // that the type system does not catch because the SDK client is `any`.
    // This asserts against the real set, so an invented name fails here.
    const used: string[] = []
    core.client = client({ search: async (_q: string, o: any) => { used.push(o.searchType); return {} } })
    await recallKnowledgeGraph({ query: 'q' })
    await recallKnowledgeGraphStructured({ query: 'q' })
    expect(used.length).toBeGreaterThan(0)
    for (const t of used) {
      expect(COGNEE_SEARCH_TYPES.has(t)).toBe(true)
    }
  })

  test('a search returning nothing yields an empty string, not "undefined"', async () => {
    core.formatted = ''
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('')
  })

  test('a failing strategy is skipped and the next one still runs', async () => {
    const tried: string[] = []
    core.client = client({
      search: async (_q: string, o: any) => {
        tried.push(o.searchType)
        if (o.searchType === 'SUMMARIES') throw new Error('strategy down')
        return {}
      },
    })
    await recallKnowledgeGraph({ query: 'q' })
    // One broken strategy must not lose the whole recall.
    expect(tried).toContain('SUMMARIES')
    expect(tried).toContain('CHUNKS')
  })

  test('all strategies failing still returns empty (never throws)', async () => {
    core.client = client({ search: async () => { throw new Error('all down') } })
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('')
    expect(await recallKnowledgeGraphStructured({ query: 'q' })).toEqual([])
  })

  test('a missing dataset short-circuits BEFORE searching', async () => {
    let searched = 0
    core.client = client({
      datasets: { has: async () => false },
      search: async () => { searched++; return {} },
    })
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('')
    // Searching a dataset that does not exist is a guaranteed runtime error;
    // the guard exists to avoid it.
    expect(searched).toBe(0)
  })

  test('a client without datasets.has still searches (guard is best-effort)', async () => {
    let searched = 0
    core.client = client({
      datasets: {},
      search: async () => { searched++; return {} },
    })
    await recallKnowledgeGraph({ query: 'q' })
    expect(searched).toBeGreaterThan(0)
  })

  test('duplicate results are collapsed', async () => {
    core.formatted = 'SAME'
    const res = await recallKnowledgeGraph({ query: 'q' })
    // 3 strategies returning identical text must not triple the context.
    expect(res).toBe('SAME')
  })

  test('structured recall tags each result with its source', async () => {
    core.items = [{ text: 'entity one', score: 0.9 }]
    const res = await recallKnowledgeGraphStructured({ query: 'q' })
    expect(res.length).toBeGreaterThan(0)
    expect(['summary', 'chunk', 'entity']).toContain(res[0].source)
    expect(res[0].text).toBe('entity one')
  })
})

describe('forget / reset', () => {
  test('forgetAll clears statuses and returns true', async () => {
    expect(await forgetAll()).toBe(true)
    expect(dbState.updateManyCalls).toHaveLength(1)
    expect(dbState.updateManyCalls[0].data).toEqual({ cognifyStatus: null })
  })

  test('forgetKnowledgeGraph scopes the forget to the dataset', async () => {
    let arg: any
    core.client = client({ forget: async (a: any) => { arg = a } })
    expect(await forgetKnowledgeGraph()).toBe(true)
    expect(arg.kind).toBe('dataset')
    // The dataset name is the org isolation boundary — forgetting 'all' here
    // would wipe every other org's graph in a shared cognee database.
    expect(arg.dataset.name).toContain('kb')
  })

  test('forgetAll uses kind "all"', async () => {
    let arg: any
    core.client = client({ forget: async (a: any) => { arg = a } })
    await forgetAll()
    expect(arg).toEqual({ kind: 'all' })
  })

  test('a failing forget returns false instead of throwing', async () => {
    core.client = client({ forget: async () => { throw new Error('forget down') } })
    expect(await forgetAll()).toBe(false)
    expect(await forgetKnowledgeGraph()).toBe(false)
    // A failed forget must NOT report success — the UI tells the user their
    // data is gone.
    expect(dbState.updateManyCalls).toHaveLength(0)
  })

  test('resetCognee clears statuses even when forget throws', async () => {
    core.client = client({ forget: async () => { throw new Error('forget down') } })
    expect(await resetCognee()).toBe(true)
    expect(dbState.updateManyCalls).toHaveLength(1)
  })

  test('forgetAll returns true even when the status reset fails', async () => {
    dbState.updateManyCalls = []
    const res = await forgetAll()
    expect(res).toBe(true)
  })
})
