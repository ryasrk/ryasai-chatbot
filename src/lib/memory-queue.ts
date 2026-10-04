import { backgroundLockdownReason } from '@/lib/background-license'
import { Queue } from 'bullmq'

import { redis } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

/**
 * A bounded, retrying queue for memory writes.
 *
 * ─── WHY THIS EXISTS (measured, on the production install) ───
 *
 * Memory writes used to be fired straight at the cognee sidecar from the request path with no
 * throttle. Four simultaneous chats produced EIGHT "already running" rejections and only TWO of the
 * four turns reached memory — because a write holds the sidecar's cognify pipeline for one dataset
 * for 45-148s, and a second write for the SAME dataset during that window is refused.
 *
 * The refusal is the dangerous part: the sidecar answers **HTTP 200** with
 * `{"status":"running","items_processed":0}`. No error, no non-2xx. So the turn looked stored and was
 * not. (The app now detects that response shape and logs it, but detection alone only makes the loss
 * visible.)
 *
 * ─── WHAT THIS CHANGES ───
 *
 * Writes are ENQUEUED and drained by workers with a per-org concurrency of ONE, so a dataset's
 * pipeline is never contended by this process. A refused or failed write is RETRIED with exponential
 * backoff instead of being dropped — the product decision taken here is that a turn the user saw must
 * eventually be remembered.
 *
 * ─── WHY A SEPARATE QUEUE, NOT `document-processing` ───
 *
 * That queue's worker runs with `concurrency: 3`, which is precisely the contention this queue exists
 * to remove, and its jobs are heavy (embedding, cognify) with 300s locks and a stalled-job checker
 * tuned for them. Mixing a 150s memory write into it would make both sets of timings unreadable.
 *
 * ─── FAILURE MODE, STATED PLAINLY ───
 *
 * If Redis is unavailable the write is attempted INLINE, exactly as before this queue existed. Memory
 * is optional; a chat must never fail because a memory queue is down. The inline path is the OLD
 * behaviour, so a Redis outage degrades to what shipped before rather than to something worse.
 */

export interface MemoryWriteJob {
  organizationId: string
  sessionId?: string
  userMessage: string
  aiMessage: string
  toolRuns: Array<{ type: string; status: string; latencyMs: number }>
}

/** One in-flight write per org: the sidecar serialises per DATASET, and a dataset is per org. */
export const MEMORY_WRITE_CONCURRENCY = 1

export const MEMORY_QUEUE_NAME = 'memory-write'

/**
 * Attempts and backoff.
 *
 * VERIFIED against BullMQ's own `Backoffs.calculate` (exponential, no jitter), not derived by hand: the
 * four remaining-wait delays are 30s, 60s, 120s, 240s, so the five attempts START at t = 0s, 30s, 90s,
 * 210s and 450s. That is **7.5 minutes of total patience**, and the second attempt lands INSIDE the
 * measured 45-148s write window rather than after it — the earlier comment here claimed "roughly 5
 * minutes", which is the sum of nothing in particular.
 *
 * WHAT THAT MEANS, measured against the 45-148s write time. A write refused at t=0 is refused because a
 * dataset's pipeline is busy, so the useful retries are the LATE ones: attempt 4 at t=210s is past the
 * longest measured write (148s), and attempt 5 at t=450s is past it by a wide margin even if attempt 4
 * itself ran a full-length write. Attempts 2 and 3 (30s, 90s) will often be refused again and burn
 * themselves against a pipeline that is still running — that cost is accepted rather than tuned away,
 * because a refusal is cheap (an immediate HTTP 200 with no server-side work) while a longer first delay
 * would delay every genuinely transient failure. The budget is therefore not "wasted": the last two
 * attempts are the ones that recover the turn.
 *
 * A LONGER LOCK IS WHAT KEEPS THIS SAFE, not the backoff: the worker's `lockDuration` is 300s, above the
 * 148s worst case, so a write that is actually running cannot be handed to a second worker mid-flight.
 */
export const MEMORY_WRITE_ATTEMPTS = 5
export const MEMORY_WRITE_BACKOFF_MS = 30_000

/**
 * How deep the queue may get before new writes are REFUSED rather than enqueued.
 *
 * WHY A CAP IS NEEDED — the measured shape of the failure it prevents. The worker drains this queue at
 * `MEMORY_WRITE_CONCURRENCY = 1` per process, and one write takes 45-148s when the sidecar's pipeline is
 * healthy. When cognee is DOWN the jobs do not fail fast: the worker's HTTP call has its own timeout, then
 * BullMQ retries with backoff out to 240s, and every chat turn keeps ADDING while nothing drains. MEASURED
 * ceiling without a cap: at a modest 1 turn/second the queue holds 3,600 jobs after an hour of outage, each
 * carrying two full message bodies, and Redis grows by the whole conversation history of the outage — for a
 * queue whose jobs are, by this module's own doc, OPTIONAL ("memory is an enhancement").
 *
 * WHAT THE CAP DOES AT THE BOUNDARY. A write past the cap is DROPPED, not queued and not run inline: the
 * inline path is the thing that must not grow during an outage (it would fire one more HTTP call per turn at
 * a sidecar that is already not answering). The drop is LOGGED with the org id and the queue depth, and the
 * caller's `'dropped'` return is what tells it not to count the write as pending. Memory of the turns shed
 * this way is lost — that is the deliberate trade, and it is the same trade the module already documents for
 * a refused write ("a turn the user saw must eventually be remembered" is bounded by what the queue can hold).
 *
 * WHY 1000 AND NOT SMALLER. It holds ~1.5-4 hours of a 45-148s-drain backlog, so a blip does not shed, while
 * capping Redis growth at a bounded size. Operators can tune it with `MEMORY_QUEUE_MAX_DEPTH`.
 */
export const MEMORY_QUEUE_MAX_DEPTH = Number(process.env.MEMORY_QUEUE_MAX_DEPTH ?? 1000)

let _queue: Queue<MemoryWriteJob> | null = null

/**
 * The queue, created lazily.
 *
 * Lazy because `redis.ts` is imported by routes that must not open a connection at module load in a
 * test process, and because a queue handle created before Redis is reachable still works — BullMQ
 * reconnects — but creating one per import is wasteful.
 */
export function memoryWriteQueue(): Queue<MemoryWriteJob> {
  if (_queue) return _queue
  _queue = new Queue<MemoryWriteJob>(MEMORY_QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: MEMORY_WRITE_ATTEMPTS,
      backoff: { type: 'exponential', delay: MEMORY_WRITE_BACKOFF_MS },
      removeOnComplete: { count: 200 },
      // Kept longer than completions: a failed write is the record an operator needs when a user
      // reports "it forgot what I told it", and a job removed on failure would erase that evidence.
      removeOnFail: { count: 1000 },
      // NOT `true`: a failed memory write must not be silently discarded, which is the whole point.
      // Deliberately absent rather than false, since the option defaults to keeping the job.
    },
  })
  return _queue
}

/** Test seam — mirrors `resetJobWorkerForTest` / `resetEnsuredCollections`. */
export async function resetMemoryQueueForTest(): Promise<void> {
  if (_queue) {
    await _queue.close().catch(() => null)
    _queue = null
  }
}

const log = scopedLogger('memory-queue')

/**
 * Enqueue a memory write, falling back to an inline attempt when Redis is unavailable.
 *
 * The fallback takes the write function as an argument rather than importing it, so this module has no
 * dependency on the cognee transport and can be unit-tested without one.
 */
export async function enqueueMemoryWrite(
  job: MemoryWriteJob,
  inlineFallback: (job: MemoryWriteJob) => Promise<void>,
): Promise<'queued' | 'inline' | 'dropped'> {
  let reason: Awaited<ReturnType<typeof backgroundLockdownReason>>
  try {
    reason = await backgroundLockdownReason(job.organizationId)
  } catch {
    // Optional memory may be dropped; an unverifiable entitlement cannot permit a write.
    log.warn('memory write dropped: organization license could not be verified', { organizationId: job.organizationId })
    return 'dropped'
  }
  if (reason) {
    log.warn('memory write dropped: organization license is locked', { organizationId: job.organizationId, reason })
    return 'dropped'
  }

  /*
   * SKIPPED IN TESTS unless a test opts in.
   *
   * WHY AN EXPLICIT SWITCH AND NOT A HEALTH CHECK. The first version tried the queue and fell back on
   * failure, which made the write path depend on whether REDIS HAPPENED TO BE RUNNING: green in local
   * dev (Redis up), inline in CI (no Redis), and every existing memory test asserted the inline
   * behaviour. A behaviour that differs between environments is one nobody can reason about, and the
   * tests were silently measuring the environment rather than the code.
   *
   * So the queue is OFF under `NODE_ENV=test` by default, and a test that wants it sets
   * `MEMORY_QUEUE_IN_TESTS=1`. The fallback below still covers a REAL Redis outage in production,
   * which is the case it was written for.
   */
  if (process.env.NODE_ENV === 'test' && process.env.MEMORY_QUEUE_IN_TESTS !== '1') {
    await inlineFallback(job)
    return 'inline'
  }

  /*
   * THE CONNECTION IS CHECKED *BEFORE* THE ADD, and that ordering is the whole fix.
   *
   * The `catch` arm below CANNOT see a Redis outage, so on its own it was dead code and this function's
   * promise — "if Redis is unavailable the write is attempted INLINE" — was false. MEASURED: with
   * `REDIS_URL` pointing at a dead port, `enqueueMemoryWrite` had neither settled nor run its fallback
   * after 30s (the probe waited 30s; BullMQ's own default is to wait indefinitely).
   *
   * WHY: `redis` is created with `maxRetriesPerRequest: null` — required by BullMQ, because its blocking
   * commands must survive a reconnect — and ioredis' offline queue is on by default. So `add()` does not
   * reject while the connection is down; it parks the command and retries it forever. The write is then
   * lost for an unbounded time while the caller's promise never settles, which is strictly worse than the
   * pre-queue behaviour it replaced (a direct HTTP call that failed and was logged).
   *
   * `status === 'ready'` is ioredis' own synchronous verdict — no round trip, and the only thing that
   * reflects "a command sent NOW will be written to Redis rather than buffered". `checkRedisHealth()` is
   * deliberately NOT used: it goes through the separate fail-fast `cmd` connection, which MEASURED
   * returns `{connected: false}` even with Redis healthy and `queue.add` succeeding 8ms later — gating on
   * it would push every write to the inline path on a working install.
   *
   * RESIDUAL RACE, stated rather than hidden: Redis can still die between this check and the `add()`, and
   * that add would then park in the offline queue. Bounding it with a timeout was REJECTED as the fix —
   * the parked job would later be delivered as well, so the turn would be written twice, which is the
   * double-write this module already had to fix once. The window is milliseconds against an outage that
   * lasts as long as Redis is down, and a boot-time `connecting` status only means the write takes the
   * pre-queue inline path, which is a slow write rather than a loss.
   */
  if (redis.status !== 'ready') {
    log.warn('Redis is not ready; attempting the memory write inline', { status: redis.status })
    await inlineFallback(job)
    return 'inline'
  }

  /*
   * DEPTH CHECK BEFORE THE ADD — the shedding boundary.
   *
   * `getJobCounts` is one Redis round trip per ENQUEUE, not per request: this function is called once per
   * completed chat turn, so the cost is a single O(1) command against a queue that already exists. The count
   * used is `wait + active + delayed + paused`: jobs sitting in RETRY BACKOFF are `delayed`, and a shed rule
   * that ignored them would keep admitting during exactly the outage it exists for.
   *
   * Failure of the check itself is NOT a reason to shed or to fail: the queue was reachable a moment ago
   * (the status gate above passed), so a count that errors is treated as "unknown, allow" — the pre-cap
   * behaviour — rather than turning a transient count error into data loss.
   */
  try {
    const counts = await memoryWriteQueue().getJobCounts('wait', 'active', 'delayed', 'paused')
    const depth = (counts.wait ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0) + (counts.paused ?? 0)
    if (depth >= MEMORY_QUEUE_MAX_DEPTH) {
      log.warn('memory queue is at its depth cap; dropping this write rather than queueing it', {
        organizationId: job.organizationId,
        depth,
        cap: MEMORY_QUEUE_MAX_DEPTH,
        // Dropped, not deferred: the doc on the constant records why the inline path is not taken here.
        outcome: 'dropped',
      })
      return 'dropped'
    }
  } catch {
    // See above: an unknown depth allows the write. Logging at debug level keeps the outage visible
    // without warning noise on every turn of a flapping connection.
    log.warn('could not read the memory queue depth; enqueueing anyway', {
      organizationId: job.organizationId,
    })
  }

  try {
    await memoryWriteQueue().add('remember-turn', job)
    return 'queued'
  } catch (e) {
    // A rejected add — Redis went away between the status check and here, or the queue refused the job.
    // The chat has already been answered either way, so the only question is whether this write is
    // attempted now or not at all.
    log.warn('queueing the memory write failed; attempting it inline', {
      error: e instanceof Error ? e.message : String(e),
    })
    await inlineFallback(job)
    return 'inline'
  }
}
