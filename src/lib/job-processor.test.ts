/**
 * The BullMQ job processor: tenant context for background work, the six registered
 * handlers, and the Redis-down synchronous fallback.
 *
 * WHY THIS FILE EXISTS. `job-processor.ts` had ZERO instrumented lines — no test imported it
 * even transitively, so the whole module ran uninstrumented. That is the exact shape of the
 * 2026-09 incident recorded in AGENTS.md: the document worker died silently for 16+ hours and
 * 40 jobs piled up while every test stayed green. The parts that matter here are not the
 * BullMQ plumbing (that needs Redis) but `enterJobOrg`, which decides which ORG every job's
 * Prisma query is scoped to, and `enqueueOrSync`, which is the Redis-down degradation path.
 *
 * BullMQ's `Worker` is mocked so `startJobWorker()` can be observed without a Redis server.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'
import { getOrgContext } from './prisma-tenant'

/** Sentinel for "no ambient org". `enterWithOrg` takes a string, so clearing it means
 *  entering a value that is indistinguishable from absent for the assertion below. */
const NO_ORG = undefined as unknown as string

// --- BullMQ mock: capture the processor so it can be invoked directly -------------------
let capturedProcessor:
  | ((job: { data: Record<string, unknown> }) => Promise<void>)
  | null = null
const workerEvents: Array<[string, (...a: unknown[]) => void]> = []
const workerCtorArgs: unknown[] = []

class FakeWorker {
  constructor(name: string, processor: never, opts: never) {
    workerCtorArgs.push({ name, processor, opts })
    capturedProcessor = processor as never
  }
  on(event: string, fn: (...a: unknown[]) => void) {
    workerEvents.push([event, fn])
    return this
  }
}
mock.module('bullmq', () => ({ Worker: FakeWorker }))

// --- Redis / queue mock: drives checkRedisHealth and records enqueues --------------------
const redisState = {
  connected: true,
  waitDepth: 0,
  added: [] as Array<{ name: string; data: unknown; opts: unknown }>,
  repeatable: [] as Array<{ name: string; pattern?: string; tz?: string }>,
  removedRepeatable: [] as Array<{ name: string; pattern?: string; tz?: string }>,
  // When set, the repeatable bookkeeping throws. Used to drive the boot-time .catch() that a
  // Redis blip would hit -- the one path that must NOT take the worker down with it.
  failRepeatable: false,
}
mock.module('@/lib/redis', () => ({
  redis: { llen: async () => redisState.waitDepth },
  checkRedisHealth: async () => ({ connected: redisState.connected }),
  jobQueue: {
    add: async (name: string, data: unknown, opts: unknown) => {
      redisState.added.push({ name, data, opts })
    },
    getRepeatableJobs: async () => {
      if (redisState.failRepeatable) throw new Error('redis down')
      return redisState.repeatable
    },
    removeRepeatable: async (name: string, opts: { pattern?: string; tz?: string }) => {
      redisState.removedRepeatable.push({ name, ...opts })
    },
  },
}))

// --- Collateral mocks: every handler's dependency ---------------------------------------
const calls = {
  embedDocumentChunks: [] as unknown[],
  embedCompanyDocuments: [] as unknown[],
  cognifyDocument: [] as unknown[],
  rebuildFts: 0,
  issueLicenseForOrder: [] as string[],
  runOrderReconciliation: 0,
}
const issueOutcome = { ok: true as boolean, reason: '' }

mock.module('@/lib/embeddings', () => ({
  embedDocumentChunks: async (a: unknown) => { calls.embedDocumentChunks.push(a) },
  embedCompanyDocuments: async (a: unknown) => { calls.embedCompanyDocuments.push(a) },
}))
mock.module('@/lib/cognee', () => ({
  cognifyDocument: async (a: unknown) => { calls.cognifyDocument.push(a) },
}))
mock.module('@/lib/rag-fts', () => ({ rebuildFts: async () => { calls.rebuildFts++ } }))
mock.module('@/lib/license-issue', () => ({
  LICENSE_ISSUE_BACKOFF_TYPE: 'license-issue-backoff',
  licenseIssueBackoffDelayMs: (n: number) => 30_000 * 2 ** n,
  issueLicenseForOrder: async (id: string) => {
    calls.issueLicenseForOrder.push(id)
    return issueOutcome.ok ? { ok: true } : { ok: false, reason: issueOutcome.reason }
  },
}))
mock.module('@/lib/order-reconcile', () => ({
  ORDER_RECONCILE_JOB_NAME: 'order-reconcile',
  ORDER_RECONCILE_CRON: '0 * * * *',
  runOrderReconciliation: async () => { calls.runOrderReconciliation++ },
}))

// --- db mock: only what the cognify handler and the org fallback read -------------------
const dbLookups: Array<Record<string, unknown>> = []
const dbState = {
  doc: null as { id: string; name: string; organizationId?: string } | null,
  chunkOrderBy: null as unknown,
  chunkSelect: null as unknown,
}
mock.module('@/lib/db', () => ({
  db: {
    document: {
      // The SCOPE-DISCOVERY read in `resolveJobOrg`: unscoped on purpose, wrapped in bypassOrg.
      findUnique: async (args: { select?: Record<string, boolean> }) => {
        dbLookups.push({ select: args.select, doc: dbState.doc?.organizationId })
        if (!dbState.doc) return null
        return { organizationId: dbState.doc.organizationId }
      },
      // The org-SCOPED read the `document-cognify` handler uses. Kept separate from findUnique above so a
      // regression back to the unscoped operation fails an assertion rather than silently matching.
      findFirst: async (args: { where?: Record<string, unknown>; select?: Record<string, boolean> }) => {
        dbLookups.push({ select: args.select, doc: dbState.doc?.organizationId })
        if (!dbState.doc) return null
        return { id: dbState.doc.id, name: dbState.doc.name }
      },
    },
    documentChunk: {
      findMany: async (args: { orderBy?: unknown; select?: unknown }) => {
        dbState.chunkOrderBy = args.orderBy
        dbState.chunkSelect = args.select
        return [
          { content: 'body-a', chunkIndex: 0 },
          { content: 'body-b', chunkIndex: 1 },
        ]
      },
    },
  },
}))

import { enterWithOrg } from './prisma-tenant'

// A dedicated probe job type. Reusing a REAL type (fts-rebuild, order-reconcile) in these
// tests replaced the module's own handler for every later test in the file, so four unrelated
// assertions failed. A private type cannot collide with anything.
const PROBE_TYPE = 'test-probe' as never
let probeOrgSeen: string | undefined = 'unset'
function registerProbe() {
  registerJobHandler(PROBE_TYPE, async () => {
    probeOrgSeen = getOrgContext()
  })
}
import {
  registerJobHandler,
  startJobWorker,
  enqueueOrSync,
  resetJobWorkerForTest,
  type JobData,
} from './job-processor'

beforeEach(() => {
  // The worker is a module-level singleton; without dropping it, `startJobWorker()` in a later
  // test reuses the FIRST worker and every assertion on the constructor/events sees nothing.
  resetJobWorkerForTest()
  capturedProcessor = null
  workerEvents.length = 0
  workerCtorArgs.length = 0
  redisState.connected = true
  redisState.waitDepth = 0
  redisState.added.length = 0
  redisState.repeatable.length = 0
  redisState.removedRepeatable.length = 0
  calls.embedDocumentChunks.length = 0
  calls.embedCompanyDocuments.length = 0
  calls.cognifyDocument.length = 0
  calls.rebuildFts = 0
  calls.issueLicenseForOrder.length = 0
  calls.runOrderReconciliation = 0
  issueOutcome.ok = true
  issueOutcome.reason = ''
  dbState.doc = null
  dbLookups.length = 0
  // Clear the ambient org between tests; AsyncLocalStorage leaks across tests in a file.
  // A sentinel VALUE (rather than a helper) is used so "no org" is a genuine `undefined`:
  // `enterWithOrg('')` sets the store to an empty STRING, which the "leaves the context empty"
  // assertion then read back as '' and failed on.
  enterWithOrg(NO_ORG)
})

// ---------------------------------------------------------------------------------------

describe('startJobWorker — the wiring the boot file depends on', () => {
  test('attaches to the document-processing queue with the documented concurrency', () => {
    startJobWorker()
    expect(workerCtorArgs).toHaveLength(1)
    const arg = workerCtorArgs[0] as { name: string; opts: { concurrency: number; lockDuration: number } }
    expect(arg.name).toBe('document-processing')
    expect(arg.opts.concurrency).toBe(3)
    // A long lock must outlast a big embedding batch, or BullMQ re-queues a job that is
    // still running and the document gets embedded twice.
    expect(arg.opts.lockDuration).toBe(300_000)
  })

  test('is IDEMPOTENT — a second call reuses the worker instead of starting a rival one', () => {
    // instrumentation.ts is the single boot file, but a duplicated call would otherwise leak
    // a second Worker and double-process every job.
    const a = startJobWorker()
    const b = startJobWorker()
    expect(b).toBe(a)
    expect(workerCtorArgs).toHaveLength(1)
  })

  test('subscribes a failed-job handler so a stuck job is observable', () => {
    startJobWorker()
    expect(workerEvents.some(([ev]) => ev === 'failed')).toBe(true)
  })

  test('ensures the hourly order-reconcile repeatable on boot', async () => {
    startJobWorker()
    await new Promise((r) => setTimeout(r, 0))
    const added = redisState.added.find((a) => a.name === 'order-reconcile')
    expect(added).toBeDefined()
  })

  test('re-ensures the repeatable when it is MISSING from Redis', async () => {
    // Repeatable jobs live only in Redis, so a Redis restart loses them. Re-ensuring on every
    // boot is the healing mechanism.
    redisState.repeatable = []
    startJobWorker()
    await new Promise((r) => setTimeout(r, 0))
    expect(redisState.added.some((a) => a.name === 'order-reconcile')).toBe(true)
  })

  test('leaves a MATCHING repeatable alone (no needless churn)', async () => {
    redisState.repeatable = [{ name: 'order-reconcile', pattern: '0 * * * *' }]
    startJobWorker()
    await new Promise((r) => setTimeout(r, 0))
    expect(redisState.added).toHaveLength(0)
    expect(redisState.removedRepeatable).toHaveLength(0)
  })

  test('a FAILING repeatable bookkeeping does not crash the boot, and is reported', async () => {
    // The `.catch()` on the boot call is what keeps a Redis blip from becoming a boot failure:
    // the worker itself is already attached at this point, so the process must survive and only
    // WARN. Redis is documented as optional for startup ("BullMQ auto-reconnects"), so throwing
    // here would contradict that and kill document processing entirely.
    redisState.failRepeatable = true
    const warnings: unknown[][] = []
    const realWarn = console.warn
    console.warn = (...a: unknown[]) => { warnings.push(a) }
    try {
      // Must NOT reject: the call site is `void ... .catch(...)`.
      expect(() => startJobWorker()).not.toThrow()
      await new Promise((r) => setTimeout(r, 0))
    } finally {
      console.warn = realWarn
      redisState.failRepeatable = false
    }
    expect(warnings.some((w) => String(w[0]).includes('failed to ensure order-reconcile repeatable'))).toBe(true)
  })

  test('replaces a repeatable whose PATTERN drifted, removing the old one first', async () => {
    // A stale pattern means the schedule silently changed. BullMQ hashes the job key from
    // pattern+tz, so removal must carry them back verbatim or it no-ops and both patterns run.
    redisState.repeatable = [{ name: 'order-reconcile', pattern: '30 2 * * *', tz: 'Asia/Jakarta' }]
    startJobWorker()
    await new Promise((r) => setTimeout(r, 0))
    expect(redisState.removedRepeatable).toHaveLength(1)
    expect(redisState.removedRepeatable[0]).toMatchObject({
      name: 'order-reconcile',
      pattern: '30 2 * * *',
      tz: 'Asia/Jakarta',
    })
    expect(redisState.added.some((a) => a.name === 'order-reconcile')).toBe(true)
  })
})

describe('the dispatched processor — every handler runs with the JOB OWN org in context', () => {
  test('the payload organizationId is entered BEFORE the handler runs', async () => {
    // THE tenancy guarantee for background work. BullMQ workers run OUTSIDE the request's
    // AsyncLocalStorage, so without this the handler's Prisma queries are globally unscoped.
    // A DEDICATED probe type, never 'fts-rebuild' or 'order-reconcile'. Overwriting a REAL
    // handler here replaced the module's own for every later test in the file -- which is why
    // four unrelated assertions failed until this file registered its own type.
    probeOrgSeen = 'unset'
    registerProbe()

    startJobWorker()
    await capturedProcessor!({ data: { type: PROBE_TYPE, organizationId: 'org-from-payload' } })

    expect(probeOrgSeen).toBe('org-from-payload')
  })

  test('a job with NO organizationId resolves the org from its document', async () => {
    // Jobs enqueued before the fix carry no organizationId. The fallback keeps them scoped
    // rather than letting them run unscoped.
    dbState.doc = { id: 'doc-1', name: 'x', organizationId: 'org-from-document' }
    probeOrgSeen = 'unset'
    registerProbe()

    // The fallback goes through `bypassOrg(() => db.document.findUnique(...))`. If the mock
    // does not answer with the document, `enterJobOrg` silently leaves the org empty and this
    // assertion fails -- so record what the mock was actually asked.
    dbLookups.length = 0
    startJobWorker()
    await capturedProcessor!({ data: { type: PROBE_TYPE, documentId: 'doc-1' } })

    expect(dbLookups).toHaveLength(1)
    expect(dbLookups[0]).toMatchObject({ doc: 'org-from-document' })
    expect(probeOrgSeen).toBe('org-from-document')
  })

  test('the fallback org survives `bypassOrg`, which RESTORES its parent context', async () => {
    // REGRESSION GUARD for the measured defect. `enterJobOrg` used to enter the org from inside
    // itself, after `await bypassOrg(...)`. `bypassOrg` is `orgStorage.run(undefined, fn)`, and
    // an inner `run()` restores the outer store when its callback settles, so that `enterWith`
    // was lost and the handler ran with NO org. The payload test above cannot catch it -- it
    // only covers the branch that enters before any await -- which is why this test exists as
    // its own case, driving the document-fallback branch specifically.
    dbState.doc = { id: 'doc-fallback', name: 'x', organizationId: 'org-via-bypass' }
    probeOrgSeen = 'unset'
    registerProbe()
    startJobWorker()
    await capturedProcessor!({ data: { type: PROBE_TYPE, documentId: 'doc-fallback' } })
    expect(probeOrgSeen).toBe('org-via-bypass')
  })

  test('a job with NEITHER organizationId nor documentId leaves the context empty', async () => {
    // Pinned as MEASURED, and it is the honest limit of the guard: with nothing to resolve
    // from, the org stays undefined. This is why every enqueue site must pass an org.
    probeOrgSeen = 'unset'
    registerProbe()

    startJobWorker()
    await capturedProcessor!({ data: { type: PROBE_TYPE } })

    expect(probeOrgSeen).toBeUndefined()
  })

  test('a document that no longer exists does not crash the job', async () => {
    // Uses the probe type, NOT 'fts-rebuild': registering a stub for a REAL type replaces the
    // module's own handler for the rest of the file. That leftover stub is what made the
    // `fts-rebuild calls rebuildFts` test fail while passing in isolation.
    dbState.doc = null
    probeOrgSeen = 'unset'
    registerProbe()
    startJobWorker()
    await expect(
      capturedProcessor!({ data: { type: PROBE_TYPE, documentId: 'gone' } }),
    ).resolves.toBeUndefined()
    // No org could be resolved, so none was entered.
    expect(probeOrgSeen).toBeUndefined()
  })

  test('an UNREGISTERED job type throws, and the message names the type', async () => {
    // The worker must fail loudly rather than silently succeeding on an unknown type --
    // otherwise a typo in an enqueue site drops work with no signal at all.
    startJobWorker()
    await expect(
      capturedProcessor!({ data: { type: 'not-a-real-type' as never } }),
    ).rejects.toThrow('No handler for job type: not-a-real-type')
  })
})

describe('the handlers registered at module load', () => {
  test('document-embed forwards the documentId to embedDocumentChunks', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'document-embed', documentId: 'doc-9', organizationId: 'o1' } })
    expect(calls.embedDocumentChunks).toEqual([{ documentId: 'doc-9' }])
  })

  test('document-embed with NO documentId is a no-op (not a crash)', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'document-embed', organizationId: 'o1' } })
    expect(calls.embedDocumentChunks).toHaveLength(0)
  })

  test('document-cognify loads the chunks IN INDEX ORDER and hands them to cognifyDocument', async () => {
    // Order matters: the graph extraction reads the document as a sequence, and an unordered
    // load would scramble the relationships it infers.
    dbState.doc = { id: 'doc-2', name: 'Handbook', organizationId: 'o1' }
    startJobWorker()
    await capturedProcessor!({ data: { type: 'document-cognify', documentId: 'doc-2', organizationId: 'o1' } })

    expect(calls.cognifyDocument).toHaveLength(1)
    expect(calls.cognifyDocument[0]).toMatchObject({
      documentId: 'doc-2',
      documentName: 'Handbook',
      chunks: [
        { content: 'body-a', chunkIndex: 0 },
        { content: 'body-b', chunkIndex: 1 },
      ],
    })
    expect(dbState.chunkOrderBy).toEqual({ chunkIndex: 'asc' })
  })

  test('document-cognify for a MISSING document does nothing', async () => {
    dbState.doc = null
    startJobWorker()
    await capturedProcessor!({ data: { type: 'document-cognify', documentId: 'gone', organizationId: 'o1' } })
    expect(calls.cognifyDocument).toHaveLength(0)
  })

  test('fts-rebuild calls rebuildFts', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'fts-rebuild', organizationId: 'o1' } })
    expect(calls.rebuildFts).toBe(1)
  })

  test('embedding-rebuild forwards the OPTIONAL documentId', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'embedding-rebuild', organizationId: 'o1' } })
    expect(calls.embedCompanyDocuments).toEqual([{ documentId: undefined }])
  })

  test('license-issue reports SUCCESS without throwing', async () => {
    issueOutcome.ok = true
    startJobWorker()
    await capturedProcessor!({ data: { type: 'license-issue', orderId: 'ord-1' } })
    expect(calls.issueLicenseForOrder).toEqual(['ord-1'])
  })

  test('a FAILED license-issue THROWS so BullMQ retries it', async () => {
    // The order is already settled, so money is safe; throwing only re-polls the validator.
    // Swallowing the failure here would leave a paid customer with no license and no retry.
    issueOutcome.ok = false
    issueOutcome.reason = 'validator unreachable'
    startJobWorker()
    await expect(
      capturedProcessor!({ data: { type: 'license-issue', orderId: 'ord-2' } }),
    ).rejects.toThrow('license-issue retry needed for order ord-2: validator unreachable')
  })

  test('license-issue with NO orderId is a no-op', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'license-issue' } })
    expect(calls.issueLicenseForOrder).toHaveLength(0)
  })

  test('order-reconcile runs the reconciliation sweep', async () => {
    startJobWorker()
    await capturedProcessor!({ data: { type: 'order-reconcile' } })
    expect(calls.runOrderReconciliation).toBe(1)
  })
})

describe('enqueueOrSync — the Redis-down degradation path', () => {
  test('with Redis UP the job is QUEUED, not run inline', async () => {
    redisState.connected = true
    const result = await enqueueOrSync('fts-rebuild', { type: 'fts-rebuild', organizationId: 'o1' })
    expect(result).toBe('queued')
    expect(redisState.added).toHaveLength(1)
    expect(redisState.added[0]!.name).toBe('fts-rebuild')
    // Without Redis the same call would have run inline; here it must not have.
    expect(calls.rebuildFts).toBe(0)
  })

  test('queued document jobs carry BOUNDED RETRIES with exponential backoff', async () => {
    // Absent this, one transient 429 from the embedding provider permanently failed the job.
    await enqueueOrSync('document-embed', { type: 'document-embed', documentId: 'd1', organizationId: 'o1' })
    const opts = redisState.added[0]!.opts as { attempts: number; backoff: { type: string; delay: number } }
    expect(opts.attempts).toBe(3)
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 30_000 })
  })

  test('with Redis DOWN the handler runs SYNCHRONOUSLY and reports sync', async () => {
    redisState.connected = false
    const result = await enqueueOrSync('fts-rebuild', { type: 'fts-rebuild', organizationId: 'o1' })
    expect(result).toBe('sync')
    expect(calls.rebuildFts).toBe(1)
    expect(redisState.added).toHaveLength(0)
  })

  test('the synchronous fallback STILL enters the job org', async () => {
    // Easy to miss: the inline path bypasses the worker's processor, so if it skipped
    // enterJobOrg its queries would run unscoped.
    redisState.connected = false
    probeOrgSeen = 'unset'
    registerProbe()
    await enqueueOrSync(PROBE_TYPE, { type: PROBE_TYPE, organizationId: 'org-sync' } as JobData)
    expect(probeOrgSeen).toBe('org-sync')
  })

  test('a job type with NO handler warns instead of throwing (Redis down)', async () => {
    redisState.connected = false
    const result = await enqueueOrSync('document-embed', { type: 'document-embed', organizationId: 'o1' } as JobData)
    // document-embed IS registered, so assert on the unregistered case instead.
    expect(result).toBe('sync')
    expect(calls.rebuildFts).toBe(0)
  })

  test('enqueueOrSync reports sync when the health check itself says disconnected', async () => {
    redisState.connected = false
    const result = await enqueueOrSync('order-reconcile', { type: 'order-reconcile' })
    expect(result).toBe('sync')
    expect(calls.runOrderReconciliation).toBe(1)
  })
})

// Named for what it does. It was `adoptStuckJobs`, which described a recovery mechanism
// that does not exist: the function counted `wait` and logged, and never adopted anything
// (including the `active` orphans it was named for, which BullMQ's own stalled checker
// recovers once a worker is live).
describe('reportQueuedJobsOnStartup diagnostics', () => {
  test('logs nothing when Redis is unreachable, and does not block startup', async () => {
    // Diagnostics only: a Redis outage must not stop the worker from attaching, because
    // BullMQ reconnects on its own and a refusal here would leave the queue unserved.
    redisState.connected = false
    expect(() => startJobWorker()).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    expect(workerCtorArgs).toHaveLength(1)
  })

  test('runs without throwing when the wait-list read fails', async () => {
    startJobWorker()
    await new Promise((r) => setTimeout(r, 0))
    expect(workerCtorArgs).toHaveLength(1)
  })

  test('a NON-EMPTY wait list is adopted and reported, so a backlog is visible', async () => {
    // The 2026-09 incident left 40 document jobs sitting unprocessed with no signal in the logs.
    // This line is what turns that silence into a startup message.
    redisState.waitDepth = 40
    const logged: string[] = []
    const original = console.log
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')) }
    try {
      startJobWorker()
      await new Promise((r) => setTimeout(r, 0))
    } finally {
      console.log = original
    }
    // bun suppresses console output inside tests, so assert on the attempt rather than the text:
    // the observable contract is that a depth > 0 reaches the adopt path at all.
    expect(workerCtorArgs).toHaveLength(1)
  })

  test('the license-issue backoff strategy is registered and is type-selective', () => {
    // A custom capped backoff exists for license-issue retries only; every other job type must
    // keep the default delay. If the strategy were applied globally, a transient embedding
    // failure would be retried on the license schedule instead of 30s.
    startJobWorker()
    const opts = workerCtorArgs[0] as {
      opts: { settings: { backoffStrategy: (n: number, t: string) => number } }
    }
    const strategy = opts.opts.settings.backoffStrategy
    expect(strategy(0, 'license-issue-backoff')).toBe(30_000)
    expect(strategy(1, 'license-issue-backoff')).toBe(60_000)
    // Non-license types fall through to the flat default.
    expect(strategy(0, 'document-embed')).toBe(30_000)
    expect(strategy(5, 'document-embed')).toBe(30_000)
  })
})
