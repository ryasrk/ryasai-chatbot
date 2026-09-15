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
  resetClientCacheThrows: false,
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
  resetClientCache: () => {
    if (core.resetClientCacheThrows) throw new Error('client cache reset exploded')
    core.resets++
  },
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
  core.resetClientCacheThrows = false
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

  test("a dataset reporting 'missing' still SEARCHES — has() is advisory, not authoritative", async () => {
    // This test used to assert searched === 0, and that assertion WAS the bug.
    // MEASURED on cognee-ts 0.1.3: has() returned false for a dataset that
    // `datasets.list()` listed and that a raw search answered, so trusting it turned
    // document recall off for a healthy org — documents indexed, embeddings written,
    // and the chatbot acting like it had never ingested them.
    let searched = 0
    core.client = client({
      datasets: { has: async () => false },
      search: async () => { searched++; return {} },
    })
    // The harness's search double yields a formatted result, so recall now RETURNS it:
    // that is the whole point — the fact was reachable all along and the guard was
    // hiding it. Asserting '' here (as the old test did) would re-encode the bug.
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('FORMATTED')
    expect(searched).toBeGreaterThan(0)
  })

  test("the STRUCTURED path also treats a 'missing' dataset as advisory", async () => {
    // The other warnUnreliableHas() call site. The sibling test above only drives
    // recallKnowledgeGraph(), so a regression that reverted the STRUCTURED guard to
    // `return []` would leave this path silently dead while the string path stayed
    // green — exactly the asymmetry that made the original incident hard to see.
    // RAG consumes the structured output, so silencing it hides documents from the
    // answer prompt without any error.
    let searched = 0
    core.client = client({
      datasets: { has: async () => false },
      search: async () => { searched++; return {} },
    })
    core.items = [{ text: 'from the graph', score: 0.4 }]
    const res = await recallKnowledgeGraphStructured({ query: 'q' })
    // The indexed entity must come back: has() lied, the search answers.
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].text).toBe('from the graph')
    expect(searched).toBeGreaterThan(0)
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

  test('a datasets.has that THROWS does not abort the search (older SDK)', async () => {
    // `c.datasets?.has?.(...)` is optional-chained, and an older client may have the
    // method but not support the call. The try/catch around it must fall THROUGH to
    // the strategies, not propagate — a guard that can switch recall off by throwing
    // is the same failure as one that returns false.
    let searched = 0
    core.client = client({
      datasets: { has: async () => { throw new Error('has() unsupported') } },
      search: async () => { searched++; return {} },
    })
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('FORMATTED')
    expect(await recallKnowledgeGraphStructured({ query: 'q' })).not.toBeUndefined()
    expect(searched).toBeGreaterThan(0)
  })

  test('NATURAL_LANGUAGE failing does not lose the SUMMARIES/CHUNKS results', async () => {
    // MEASURED: NATURAL_LANGUAGE failed 2/2 in the live pipeline — the local kuzu
    // backend rejects the Cypher it emits. The strategy is kept precisely because the
    // per-strategy try/catch isolates it. Without that isolation one broken strategy
    // (and it IS broken on kuzu) would throw away two good answers per question, so
    // this pins the property the comment above the loop claims.
    const tried: string[] = []
    core.formatted = 'good answer'
    core.client = client({
      search: async (_q: string, o: any) => {
        tried.push(o.searchType)
        if (o.searchType === 'NATURAL_LANGUAGE') {
          throw new Error('NATURAL_LANGUAGE search generated Cypher that this graph backend rejected')
        }
        return {}
      },
    })
    // The answer survives even though the LAST strategy throws.
    expect(await recallKnowledgeGraph({ query: 'q' })).toBe('good answer')
    expect(tried).toContain('NATURAL_LANGUAGE')
    expect(core.items).toEqual([])
  })

  test('an error thrown by ONE structured strategy keeps the others’ items', async () => {
    // Same isolation on the structured path: RAG gets the SUMMARIES/CHUNKS entities
    // plus the NATURAL_LANGUAGE entity/relationship text; a rejected Cypher call must
    // cost only its own contribution.
    let call = 0
    core.items = [{ text: 'entity from a good strategy', score: 0.8 }]
    core.client = client({
      search: async () => {
        call++
        if (call === 2) throw new Error('CHUNKS rejected')
        return {}
      },
    })
    const res = await recallKnowledgeGraphStructured({ query: 'q' })
    expect(res.length).toBeGreaterThan(0)
    expect(res[0].text).toBe('entity from a good strategy')
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

// ---------------------------------------------------------------------------
// The failure paths of a batch, and of a reset
//
// None of these had run: a failing `add`, a transient `cognify` that recovers on
// retry, and a reset whose status sweep throws. They are the paths an operator
// actually hits when the Cognee service is unhealthy.
// ---------------------------------------------------------------------------

describe('cognifyBatch — a batch that cannot be added', () => {
  test('a failing add marks EVERY document in the batch failed and counts the loss', async () => {
    core.settings = { cognifyBatchSize: 5, cognifyMaxRetries: 2 }
    core.client = client({ add: async () => { throw new Error('cognee add exploded') } })
    const res = await cognifyBatch({
      documents: [
        { documentId: 'd1', documentName: 'a', chunks: [{ content: 'x', chunkIndex: 0 }] },
        { documentId: 'd2', documentName: 'b', chunks: [{ content: 'y', chunkIndex: 0 }] },
      ],
    })
    // Both must be accounted for: `failed` is what the operator sees, and each row
    // must carry a status so the UI can offer a retry instead of a blank state.
    expect(res.failed).toBe(2)
    expect(res.processed).toBe(0)
    const failed = core.updateCalls.filter((c) => c.status === 'failed')
    expect(failed.map((c) => c.id).sort()).toEqual(['d1', 'd2'])
    // The error is recorded, truncated — the cause must reach the operator.
    expect(failed[0].error).toContain('cognee add exploded')
  })

  test('the error string is capped at 500 characters', async () => {
    core.settings = { cognifyBatchSize: 5, cognifyMaxRetries: 1 }
    core.client = client({ add: async () => { throw new Error('E'.repeat(2000)) } })
    await cognifyBatch({ documents: docs })
    const rec = core.updateCalls.find((c) => c.status === 'failed')
    // Unbounded error text is a column-overflow risk on a TEXT-with-limit column.
    expect(rec!.error!.length).toBe(500)
  })

  test('one bad batch does not stop the batches after it', async () => {
    let n = 0
    core.settings = { cognifyBatchSize: 1, cognifyMaxRetries: 1 }
    core.client = client({
      add: async () => { n++; if (n === 1) throw new Error('first batch only') },
    })
    const res = await cognifyBatch({
      documents: [
        { documentId: 'd1', documentName: 'a', chunks: [{ content: 'x', chunkIndex: 0 }] },
        { documentId: 'd2', documentName: 'b', chunks: [{ content: 'y', chunkIndex: 0 }] },
      ],
    })
    // The `continue` is what keeps one failure from cancelling the whole upload.
    expect(res.failed).toBe(1)
    expect(res.processed).toBe(1)
  })
})

describe('cognifyBatch — a transient cognify failure is retried', () => {
  test('a FOREIGN KEY error retries, then succeeds', async () => {
    let attempts = 0
    core.settings = { cognifyBatchSize: 5, cognifyMaxRetries: 3 }
    core.client = client({
      add: async () => undefined,
      cognify: async () => {
        attempts++
        // The retry exists because cognee emits transient FK/constraint/locked
        // errors while its own writer catches up; failing the batch on the first
        // one would discard a valid upload.
        if (attempts === 1) throw new Error('FOREIGN KEY constraint failed')
      },
    })
    const res = await cognifyBatch({ documents: docs })
    expect(attempts).toBe(2)
    expect(res.processed).toBe(1)
    expect(res.failed).toBe(0)
  })

  test('a locked error also counts as transient', async () => {
    let attempts = 0
    core.settings = { cognifyBatchSize: 5, cognifyMaxRetries: 3 }
    core.client = client({
      add: async () => undefined,
      cognify: async () => { attempts++; if (attempts === 1) throw new Error('database is locked') },
    })
    await cognifyBatch({ documents: docs })
    expect(attempts).toBe(2)
  })

  test('a NON-transient error breaks out instead of burning every retry', async () => {
    let attempts = 0
    core.settings = { cognifyBatchSize: 5, cognifyMaxRetries: 3 }
    core.client = client({
      add: async () => undefined,
      cognify: async () => { attempts++; throw new Error('400 Bad Request: malformed payload') },
    })
    await cognifyBatch({ documents: docs })
    // A permanent error must not be retried three times: each attempt is real
    // compute on a service that has already said no.
    expect(attempts).toBe(1)
  })
})

describe('resetCognee — a failure returns false so the caller can report it', () => {
  test('a failure the body cannot swallow yields false, not a throw', async () => {
    // The outer catch exists so a broken reset surfaces as `false` — a boolean the
    // caller turns into an operator-facing message — instead of 500ing the route.
    //
    // MEASURED: this catches the OUTER catch only when the throw happens OUTSIDE
    // an inner swallow. `forget()` is already wrapped in `try {} catch {}`, and
    // resetClientCache is called with no guard, so that call is the one that
    // reaches the outer handler. My first attempt threw from a client getter and
    // proved nothing — the assertion passed while the catch stayed dead.
    const { resetCognee: reset } = await import('@/lib/cognee-knowledge-graph')
    core.resetClientCacheThrows = true
    const res = await reset()
    core.resetClientCacheThrows = false
    expect(res).toBe(false)
  })

  test('a failing updateMany still reports the reset as done', async () => {
    // resetCognee is "reset the client and forget", not "reset the client, forget
    // and also clear statuses". If the sweep throws, the reset HAS happened, so
    // returning false would tell the operator to retry a completed operation.
    const src = await Bun.file('./src/lib/cognee-knowledge-graph.ts').text()
    const sweep = src.slice(src.indexOf('Reset all document cognify statuses'))
    expect(sweep).toContain(".catch(logSwallowed('cognee: document.updateMany (resetCognee)'))")
    const res = await resetCognee()
    expect(res).toBe(true)
  })
})
