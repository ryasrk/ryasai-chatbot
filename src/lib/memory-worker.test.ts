import { beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * The memory-write worker's retry contract.
 *
 * The behaviour that matters is not "it calls the transport" — it is WHICH outcomes throw, because
 * throwing is what makes BullMQ retry and returning is what makes a lost turn permanent.
 *
 * The sidecar's refusal is the case this exists for: MEASURED, a write arriving while a dataset's
 * cognify pipeline is busy gets HTTP 200 with `{"status":"running","items_processed":0}`. That MUST
 * throw, or the retry never happens and the turn is dropped exactly as before this queue existed.
 */
const state = {
  serverOptions: { baseUrl: 'http://cognee:8000' } as { baseUrl: string } | null,
  rememberResult: null as unknown,
  calls: [] as unknown[],
}

mock.module('@/lib/cognee-core', () => ({
  getCogneeServerOptions: async () => state.serverOptions,
}))

mock.module('@/lib/cognee-http', () => ({
  cogneeRemember: async (_o: unknown, args: unknown) => {
    state.calls.push(args)
    return state.rememberResult
  },
}))

// `writeNotStored` is imported from the REAL cognee-types module rather than restated here: a second
// copy of the refusal rule is the defect this run fixed, and a stub returning `false` would make every
// refusal test below vacuous. Only its org lookup is stubbed, so `datasetFor()` resolves to a fixed
// dataset without depending on AsyncLocalStorage.
const tenantState = { entered: [] as string[] }
mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => 'test',
  enterWithOrg: (orgId: string) => {
    tenantState.entered.push(orgId)
  },
  bypassOrg: async (fn: () => Promise<unknown>) => fn(),
}))

mock.module('@/lib/constants', () => ({
  MEMORY_WRITE_MAX_CHARS: 4000,
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

// The worker imports `redis` only to construct a Worker; the job function is what is under test, so
// the connection is stubbed to keep this file independent of a live Redis (CI has none).
mock.module('@/lib/redis', () => ({ redis: {} }))

const { performMemoryWrite } = await import('./memory-worker')

const job = {
  organizationId: 'org-1',
  sessionId: 's1',
  userMessage: 'hi',
  aiMessage: 'hello',
  toolRuns: [{ type: 'CHAT', status: 'success', latencyMs: 5 }],
}

beforeEach(() => {
  state.serverOptions = { baseUrl: 'http://cognee:8000' }
  state.rememberResult = null
  state.calls = []
})

describe('performMemoryWrite — retryable failures MUST throw', () => {
  test('a refused concurrent write throws, so BullMQ retries it', async () => {
    // THE case this worker exists for. Not throwing here means the turn is lost with no retry.
    state.rememberResult = { status: 'running', items_processed: 0, pipeline_run_id: null }
    await expect(performMemoryWrite(job)).rejects.toThrow(/not stored/i)
  })

  test('the thrown message names what happened, so a log reader can act', async () => {
    state.rememberResult = { status: 'running', items_processed: 0 }
    try {
      await performMemoryWrite(job)
      throw new Error('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('running')
      expect(msg).toMatch(/retrying/i)
    }
  })

  test('a transport failure throws', async () => {
    state.rememberResult = null
    await expect(performMemoryWrite(job)).rejects.toBeInstanceOf(Error)
  })

  test('a sidecar-reported error throws', async () => {
    state.rememberResult = { error: 'dataset locked' }
    await expect(performMemoryWrite(job)).rejects.toThrow(/dataset locked/)
  })
})

describe('performMemoryWrite — success and non-retryable cases MUST NOT throw', () => {
  test('a completed write resolves', async () => {
    state.rememberResult = { status: 'completed', items_processed: 1, pipeline_run_id: 'x' }
    await expect(performMemoryWrite(job)).resolves.toBeUndefined()
  })

  test('memory disabled resolves WITHOUT throwing, so retries are not burned', async () => {
    // No sidecar configured is a deployment state, not a transient failure. Throwing would retry five
    // times against a condition that cannot change, and log five warnings for a normal install.
    state.serverOptions = null
    await expect(performMemoryWrite(job)).resolves.toBeUndefined()
    expect(state.calls).toHaveLength(0)
  })
})

describe('performMemoryWrite — the payload', () => {
  test('the turn is sent as chat_turn JSON with the org dataset', async () => {
    state.rememberResult = { status: 'completed', items_processed: 1 }
    await performMemoryWrite(job)
    const args = state.calls[0] as { texts: string[]; datasetName: string; runInBackground: boolean }
    const parsed = JSON.parse(args.texts[0]!)
    expect(parsed.type).toBe('chat_turn')
    expect(parsed.user).toBe('hi')
    expect(parsed.assistant).toBe('hello')
    expect(parsed.sessionId).toBe('s1')
    expect(args.datasetName).toBe('org:test')
    // Must be false: a backgrounded write returns before the data is searchable, so the very next
    // turn's recall would miss the fact we just "stored".
    expect(args.runInBackground).toBe(false)
  })
})

/**
 * The WORKER's own admission gate: an org-less job must be REFUSED, not written.
 *
 * `startMemoryWorker` is invoked here with `bullmq`'s Worker replaced by a class that captures the
 * processor, so the assertions run against the REAL closure the worker registers rather than a copy of
 * its two lines — a copy would keep passing if the guard were deleted from the original.
 *
 * WHY IT MATTERS. `enterWithOrg('')` sets the AsyncLocalStorage context to an EMPTY STRING, and
 * `datasetFor()`'s `?? 'no-org'` fallback only fires on undefined, so an org-less job resolves to the
 * bare dataset `org:`. Measured through this exact processor before the guard: the write went to `org:`
 * and was reported as stored. Recall needs the same context, so that dataset is never read back — a
 * silent loss, and every org-less caller appended to one shared dataset that grows without limit.
 *
 * `UnrecoverableError` rather than a plain throw: the condition cannot become true on retry, so BullMQ
 * must fail the job immediately instead of spending all five attempts on it.
 */
describe('startMemoryWorker — the org-context admission gate', () => {
  // Captured by the class below. Shared across the two tests in this block so the control can drive the
  // SAME processor the refusal test captured, rather than re-registering and testing a second closure.
  let processor: ((j: unknown) => Promise<unknown>) | null = null

  test('an EMPTY organizationId is refused and nothing is written', async () => {
    const { UnrecoverableError } = await import('bullmq')
    /*
     * SPREAD THE REAL MODULE, overriding only `Worker` and `UnrecoverableError`.
     *
     * WHY, given I could NOT reproduce the failure this is meant to avoid — stated plainly because an
     * unreproducible fix is a belief, not a repair. An adversarial review reported that with an ENUMERATED mock
     * (`{ UnrecoverableError, Worker }`) a process shared with `scheduler-queue.test.ts` reports
     * `Export named 'Queue' not found` and that file drops to 20 pass / 10 fail.
     *
     * I TRIED TO REPRODUCE IT AND COULD NOT: `bun test memory-worker.test.ts scheduler-queue.test.ts` gives
     * 25 pass / 0 fail, in BOTH orders, with the enumerated mock restored. Local bun is 1.3.14 while CI pins
     * 1.4.2, and mock.module merge semantics differ between them — so the report is plausible and unverified
     * HERE, and I am not going to claim a reproduction I did not observe.
     *
     * The change stands on a simpler argument that needs no reproduction: an enumerated mock must be updated
     * for every future import, and an omission fails at COLLECTION time — the file does not run at all rather
     * than failing one assertion. Spreading makes the mock complete by construction. That is worth doing even
     * if the specific failure never occurs.
     */
    const actualBullmq = await import('bullmq')
    mock.module('bullmq', () => ({
      ...actualBullmq,
      UnrecoverableError,
      Worker: class {
        constructor(_name: string, fn: (j: unknown) => Promise<unknown>) {
          processor = fn
        }
        on() {
          return this
        }
      },
    }))
    const { startMemoryWorker, resetMemoryWorkerForTest } = await import('./memory-worker')
    resetMemoryWorkerForTest()
    startMemoryWorker()
    expect(processor).not.toBeNull()

    state.calls = []
    tenantState.entered = []
    await expect(
      (processor as unknown as (j: unknown) => Promise<unknown>)({
        data: { ...job, organizationId: '' },
        id: 'j1',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    // Neither the context nor the transport may be touched.
    expect(tenantState.entered).toEqual([])
    expect(state.calls).toHaveLength(0)
  })

  test('a real organizationId IS entered and the write proceeds (the control)', async () => {
    // Without this direction, a processor that refused EVERY job would satisfy the test above.
    state.rememberResult = { status: 'completed', items_processed: 1 }
    state.calls = []
    tenantState.entered = []
    await (processor as unknown as (j: unknown) => Promise<unknown>)({
      data: { ...job, organizationId: 'org-real' },
      id: 'j2',
    })
    expect(tenantState.entered).toEqual(['org-real'])
    expect(state.calls).toHaveLength(1)
  })
})
