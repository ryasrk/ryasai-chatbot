import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `enqueueMemoryWrite` — the queue's admission decision, and the fallback that must actually run.
 *
 * This file did not exist, and the defect it guards was invisible without it: the function's contract
 * (module docstring) is "if Redis is unavailable the write is attempted INLINE", but its `catch` arm
 * cannot SEE an outage, so the fallback was unreachable and the promise was false.
 *
 * WHY THE CATCH CANNOT FIRE. `redis` (see redis.ts) is built with `maxRetriesPerRequest: null`, which
 * BullMQ requires for its blocking commands, and ioredis' offline queue is on by default. While the
 * connection is down, `Queue.add()` does not reject — it PARKS the command and retries forever. So the
 * caller's promise never settles and the write is lost for an unbounded time. MEASURED with `REDIS_URL`
 * pointing at a dead port: `enqueueMemoryWrite` had neither settled nor run its fallback after 30s.
 *
 * `redis` is mocked here because a unit test cannot own a real outage, but the MOCK is only the
 * connection handle: the code under test — the ordering of the status check, the fallback call, and the
 * `NODE_ENV=test` gate — is the real implementation. `MEMORY_QUEUE_IN_TESTS` is set in `beforeEach`
 * because the default (queue off in tests) would take the inline path unconditionally and make every
 * assertion below pass for the wrong reason.
 */
const state = {
  status: 'ready' as string,
  addShouldThrow: null as Error | null,
  addCalls: 0,
  closed: 0,
}

mock.module('@/lib/redis', () => ({
  redis: {
    get status() {
      return state.status
    },
  },
}))

/*
 * PARTIAL MOCKS OF A WHOLE MODULE ARE UNSUSTAINABLE, and this file proved it twice in a row.
 *
 * `mock.module('bullmq', ...)` replaces the module for every file that runs in the SAME process, so
 * exporting only what THIS file needs broke its neighbours. Measured, adding names one at a time:
 *
 *   with only `Queue`        -> `SyntaxError: Export named 'Worker' not found ...`
 *   after adding `Worker`    -> `SyntaxError: Export named 'UnrecoverableError' not found ...`
 *
 * Each name was a guess about what some other module imports, and there is no way to know when the list
 * is complete — the next import fails at COLLECTION time, which is why `memory-worker.test.ts` did not
 * run at all rather than failing one assertion.
 *
 * So the real module is spread and only `Queue` is overridden. Every other export — `Worker`,
 * `UnrecoverableError`, `Job`, whatever a future import adds — passes through untouched.
 */
const actualBullmq = await import('bullmq')
mock.module('bullmq', () => ({
  ...actualBullmq,
  Queue: class {
    async add() {
      state.addCalls++
      if (state.addShouldThrow) throw state.addShouldThrow
      return { id: 'job-1' }
    }
    async close() {
      state.closed++
      return null
    }
  },
}))

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
  log: { debug: () => {}, warn: () => {}, info: () => {}, error: () => {} },
  logSwallowed: () => {},
}))

const { enqueueMemoryWrite, resetMemoryQueueForTest } = await import('./memory-queue')

const job = {
  organizationId: 'org-1',
  sessionId: 's1',
  userMessage: 'hi',
  aiMessage: 'hello',
  toolRuns: [],
}

/** Records whether the inline path ran, and returns a settled promise so a hang shows as a timeout. */
function fallbackSpy() {
  const calls: unknown[] = []
  return {
    calls,
    fn: async (j: unknown) => {
      calls.push(j)
    },
  }
}

beforeEach(async () => {
  await resetMemoryQueueForTest()
  process.env.MEMORY_QUEUE_IN_TESTS = '1'
  state.status = 'ready'
  state.addShouldThrow = null
  state.addCalls = 0
  state.closed = 0
})

describe('enqueueMemoryWrite — a Redis outage must FALL BACK, not hang', () => {
  test('a NOT-READY connection skips the queue and writes inline', async () => {
    /*
     * THE regression guard. Every non-ready status is covered because the check is `!== 'ready'`, and a
     * gate that only recognised `'reconnecting'` would still hang on the first seconds of an outage,
     * when ioredis reports `connecting`/`connect`/`reconnecting`/`close`/`end`.
     */
    for (const status of ['connecting', 'connect', 'reconnecting', 'close', 'end']) {
      state.status = status
      const spy = fallbackSpy()
      const outcome = await enqueueMemoryWrite(job, spy.fn)
      expect(outcome).toBe('inline')
      // The fallback must run: returning 'inline' without performing the write would report a fallback
      // that stored nothing, which is the false-success shape this whole subsystem exists to remove.
      expect(spy.calls).toHaveLength(1)
      expect(spy.calls[0]).toBe(job)
    }
    // And it must not have touched Redis at all — the whole point is to not park a command.
    expect(state.addCalls).toBe(0)
  })

  test('a READY connection queues and does NOT write inline', async () => {
    // The control for the test above: without this direction, an unconditional `return 'inline'` would
    // satisfy it. This is the normal production path.
    const spy = fallbackSpy()
    const outcome = await enqueueMemoryWrite(job, spy.fn)
    expect(outcome).toBe('queued')
    expect(spy.calls).toHaveLength(0)
    expect(state.addCalls).toBe(1)
  })

  test('the WRITE is dispatched before the status check, so a queue failure still falls back', async () => {
    // A Redis that went away between the status check and the `add()`. The catch arm exists for that
    // window (and for a job the queue refuses); it must call the fallback rather than swallow the job.
    state.status = 'ready'
    state.addShouldThrow = new Error('Stream is not writeable')
    const spy = fallbackSpy()
    const outcome = await enqueueMemoryWrite(job, spy.fn)
    expect(outcome).toBe('inline')
    expect(spy.calls).toHaveLength(1)
  })
})

describe('enqueueMemoryWrite — the test gate', () => {
  test('NODE_ENV=test without the opt-in writes inline WITHOUT touching Redis', async () => {
    // The gate that keeps every other memory test measuring the inline path instead of the environment.
    // It must short-circuit BEFORE the queue so a test process never opens a connection.
    process.env.MEMORY_QUEUE_IN_TESTS = '0'
    state.status = 'ready'
    const spy = fallbackSpy()
    expect(process.env.NODE_ENV).toBe('test')
    expect(await enqueueMemoryWrite(job, spy.fn)).toBe('inline')
    expect(spy.calls).toHaveLength(1)
    expect(state.addCalls).toBe(0)
    process.env.MEMORY_QUEUE_IN_TESTS = '1'
  })
})

/**
 * The retry BUDGET, derived from BullMQ rather than restated.
 *
 * The comment on `MEMORY_WRITE_ATTEMPTS` used to claim "5 attempts over roughly 5 minutes", which is not
 * the schedule BullMQ produces. Asserting the numbers here — computed by calling BullMQ's own
 * `Backoffs.calculate` — is what stops the prose from drifting again, and it pins the property that
 * actually matters: enough attempts must start AFTER the longest measured write (148s) for a refused
 * write to be recoverable.
 */
describe('the memory-write retry schedule', () => {
  test('delays are exponential and the LATE attempts clear a 148s write', async () => {
    const { Backoffs } = await import('bullmq/dist/cjs/classes/backoffs.js')
    const { MEMORY_WRITE_ATTEMPTS, MEMORY_WRITE_BACKOFF_MS } = await import('./memory-queue')
    const cfg = { type: 'exponential', delay: MEMORY_WRITE_BACKOFF_MS }

    // attemptsMade is 1-based on the failure that schedules the next run, so n-1 waits for n attempts.
    const waits: number[] = []
    for (let made = 1; made < MEMORY_WRITE_ATTEMPTS; made++) {
      waits.push(Backoffs.calculate(cfg, made, null, null, null) as number)
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000])

    // Attempt start times: t=0 first, then each delay after the previous attempt's start.
    let t = 0
    const starts = [0]
    for (const w of waits) {
      t += w
      starts.push(t)
    }
    expect(starts).toEqual([0, 30_000, 90_000, 210_000, 450_000])

    // The load-bearing property. A refused write means a busy pipeline, so recovery needs at least ONE
    // attempt scheduled beyond the 148s worst case — otherwise every retry is refused and the turn is
    // dropped, which is the outcome this queue exists to remove.
    const LONGEST_MEASURED_WRITE_MS = 148_000
    const usable = starts.filter((s) => s > LONGEST_MEASURED_WRITE_MS)
    expect(usable.length).toBeGreaterThanOrEqual(2)
    // And the last attempt must not be before the FIRST attempt could have finished a minimum write
    // (45s) plus its backoff, or the budget would be spent entirely inside the contended window.
    expect(starts[starts.length - 1]).toBeGreaterThan(45_000 + waits[0]!)
  })

  test('lockDuration exceeds the longest measured write, so a job is never double-run', async () => {
    // THE precondition that makes the retry schedule meaningful. A lock shorter than the write would hand
    // the same job to a second worker mid-write; the sidecar would then REFUSE the duplicate (HTTP 200 /
    // items_processed 0) and the retry would look like a failure it cannot recover from.
    const src = readFileSync(join(import.meta.dir, 'memory-worker.ts'), 'utf-8')
    const match = src.match(/lockDuration:\s*([\d_]+)/)
    expect(match).not.toBeNull()
    const lockDuration = Number(match![1]!.replace(/_/g, ''))
    const LONGEST_MEASURED_WRITE_MS = 148_000
    expect(lockDuration).toBeGreaterThan(LONGEST_MEASURED_WRITE_MS)
  })
})
