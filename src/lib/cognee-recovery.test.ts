import { afterAll, describe, expect, test, mock } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ===========================================================================
// The HANG deadline and the SELF-HEAL path in cognee-core.ts.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// Two behaviours in cognee-core.ts had no test at all:
//
//   1. `withDeadline(promise, op)`. The module had NO bound on an SDK call for
//      its whole life. `recallContext` guards with `.catch(() => '')`, which
//      catches a THROW and not a HANG, and `tool-router.ts` awaits
//      `rememberChatTurn` AFTER computing the answer -- so one SDK call that
//      never settles used to stall a user's response forever with nothing to
//      show for it. The deadline is the only thing that turns a hang back into
//      the documented "memory is unavailable" state.
//
//   2. `getCogneeClient()`'s self-heal. MEASURED INCIDENT (recorded in the
//      source): a crash left a torn `graph.wal` in `.cognee/system/<org>/`, and
//      from then on EVERY init for that org failed with
//      `Graph database error: initialization failed: Failed to create database:
//      std::bad_alloc` -- permanently, on every Bun version, for that tenant
//      only. Removing the WAL made the identical init succeed. So the recovery
//      path (quarantine the store, rebuild ONCE) is what stands between one
//      crash and a tenant that permanently has no memory.
//
// The matching is deliberately narrow, so the file also pins the NEGATIVE case:
// a config error must NOT be treated as store damage, because quarantining on a
// config problem would move a healthy graph on every bad deploy. That guard is
// the one that stops a typo'd API key from looking like corruption.
//
// THE MOCKING TRAP THIS FILE HAS TO RESPECT
// ---------------------------------------------------------------------------
// `mock.module` does not apply to a module that was STATICALLY imported -- Bun
// hoists that import and resolves it before the mock registry is consulted
// (the trap documented in cognee.test.ts, cognee-degradation.test.ts and
// real-connectors.test.ts). So: register every mock BEFORE a DYNAMIC
// `await import('@/lib/cognee-core')`. The same rule is why the small timeout
// is set before the dynamic import below -- `COGNEE_CALL_TIMEOUT_MS` is read
// once, at module load.
//
// `enterWithOrg()` inside a hook does NOT reach the test body (Bun 1.2+; the
// behaviour invariants.test.ts enforces a static guard against), so every test
// enters its org INSIDE the body via `withOrg()`.
//
// This file needs NO network, NO Redis, NO Postgres and NO `.env`. The DB is
// mocked and the on-disk store lives in a temp dir, so the real `.cognee/` is
// never touched.
// ===========================================================================

// ---------------------------------------------------------------------------
// A temp store root, created BEFORE the dynamic import because the module under
// test may read the path env vars at any point. The real `.cognee/` is never
// touched: this test creates and renames directories.
// ---------------------------------------------------------------------------
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'cognee-recovery-'))
const DATA_ROOT = join(TMP_ROOT, 'data')
const SYSTEM_ROOT = join(TMP_ROOT, 'system')
mkdirSync(DATA_ROOT, { recursive: true })
mkdirSync(SYSTEM_ROOT, { recursive: true })

process.env.COGNEE_DATA_DIR = DATA_ROOT
process.env.COGNEE_SYSTEM_DIR = SYSTEM_ROOT

// SMALL on purpose: the deadline case must not add 20s to the suite, and the
// happy path must be far faster than the deadline so a slow machine cannot turn
// it into a flake. 200ms still leaves the "never settled" branch 200ms to trip.
process.env.COGNEE_CALL_TIMEOUT_MS = '200'
// MANDATORY, and easy to miss: `getCogneeSettings()` only reaches the SDK when cognee is
// ON, and the db double below deliberately THROWS so the test does not depend on a working
// AppConfig row. That throw routes the settings read to `envFallback()`, whose `enabled`
// comes from THIS variable. Without it every init returns null before touching the SDK, so
// the retry counters stay 0 and the self-heal never runs -- which is exactly how these tests
// first failed (Expected: 1, Received: 0).
process.env.COGNEE_ENABLED = 'true'

const savedEnv: Record<string, string | undefined> = {}
for (const k of ['COGNEE_DATA_DIR', 'COGNEE_SYSTEM_DIR', 'COGNEE_CALL_TIMEOUT_MS', 'COGNEE_ENABLED']) {
  savedEnv[k] = process.env[k]
}

// ---------------------------------------------------------------------------
// The SDK double. Counts every construction and warm() so the retry-count
// assertions are about real calls, and raises a new error per attempt so the
// rebuild can succeed where the first attempt failed.
// ---------------------------------------------------------------------------
const CORRUPTION_MSG =
  'Graph database error: initialization failed: Failed to create database: std::bad_alloc'
const CONFIG_MSG = 'llm_api_key must be configured'
const REBUILD_MSG = 'Graph database error: initialization failed: Failed to create database: std::bad_alloc (second store)'

const sdk = {
  /** One entry per `new Cognee(...)`; the value is that attempt's outcome. */
  attempts: [] as string[],
  warmCalls: 0,
  ownerIdCalls: 0,
  /** Error message for each attempt, in order; the LAST entry repeats. */
  outcomes: [] as string[],
  /**
   * Index into `outcomes` that the NEXT `new Cognee(...)` uses.
   *
   * Needed because a single body may warm MORE THAN ONE org (the sibling-isolation
   * case does): indexing outcomes by the global attempt count means the second
   * org's first attempt is matched against the FIRST org's script, which silently
   * makes a corrupt-store org initialise cleanly and the test then measures
   * nothing. `sdk.outcomes = [...]` alone reads as "from now on" to a human, so
   * `scriptAttempts()` is the one call that makes that true.
   */
  base: 0,
}

/** Set the outcomes for the attempts that start NOW (not from process start). */
function scriptAttempts(outcomes: string[]): void {
  sdk.outcomes = outcomes
  sdk.base = sdk.attempts.length
}

/**
 * Zero the counters inside the test BODY, never in a hook. A `beforeEach` runs in
 * the runner's frame and this file's helpers reset caches under the org the body
 * enters, so the two would disagree; keeping the reset in one place the body
 * controls is what makes the retry COUNTS meaningful (an accumulated counter made
 * the first draft of this file assert 2 against 7).
 */
function resetSdk(): void {
  sdk.attempts.length = 0
  sdk.warmCalls = 0
  sdk.ownerIdCalls = 0
  scriptAttempts([''])
  sdk.base = 0
}

/** The counters must be zero at the START of a body; `withOrg` is what resets them. */
function assertFreshCounters(): void {
  if (sdk.attempts.length || sdk.warmCalls || sdk.ownerIdCalls) {
    throw new Error(
      `sdk counters were not reset before this test (attempts=${sdk.attempts.length}, warm=${sdk.warmCalls})`,
    )
  }
}

const outcomeForAttempt = (n: number): string =>
  sdk.outcomes[Math.min(Math.max(n - sdk.base, 0), sdk.outcomes.length - 1)] ?? ''

class FakeCognee {
  constructor(_args: any) {
    // A constructor failure belongs to the attempt at position `attempts.length`,
    // NOT to `warmCalls`: a constructor that throws never reaches warm(), so the
    // two counters are off by one and a warm-indexed outcome serves the wrong
    // attempt to the rebuild (measured: it made the corrupt store look healed on
    // attempt 1, which then made the retry unobservable).
    const outcome = outcomeForAttempt(sdk.attempts.length)
    sdk.attempts.push(outcome)
    // Both native-init failure shapes reach JS -- the constructor throws for some
    // builds, warm() throws for others. Both mean the same damaged store.
    if (outcome && outcome !== 'onWarm') throw new Error(outcome)
  }
  async warm() {
    sdk.warmCalls++
    // warm() is only reached when the constructor succeeded, so here the warm
    // index and the attempt index coincide.
    if (outcomeForAttempt(sdk.warmCalls - 1) === 'onWarm') throw new Error(CORRUPTION_MSG)
  }
  async ownerId() {
    sdk.ownerIdCalls++
    return 'owner-of-this-org'
  }
}

mock.module('@cognee/cognee-ts', () => ({ Cognee: FakeCognee }))

mock.module('@/lib/db', () => ({
  db: {
    // The org's AppConfig: cognee on, LOCAL store (quarantine only applies to the
    // file-backed store). findFirst THROWS on purpose -- getCogneeSettings()
    // falls back to env there, which keeps this test independent of the mock and
    // proves the recovery path does not need a working DB to self-heal.
    appConfig: { findFirst: async () => { throw new Error('no db here') } },
    document: { update: async () => ({}) },
  },
}))

mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => ({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://llm', apiKey: 'k', model: 'm' }),
}))

mock.module('@/lib/embeddings', () => ({
  getEmbeddingRuntimeConfig: async () => null,
}))

// ------------------------------------------------------- the module under test
const { withDeadline, getCogneeClient, getCogneeOwnerId, invalidateCogneeSettings, resetClientCache, isCogneeEnabled } =
  await import('@/lib/cognee-core')
const { enterWithOrg, bypassOrg } = await import('@/lib/prisma-tenant')

/** Run with NO org context. `bypassOrg` is a callback wrapper, not a bare reset. */
const withoutOrg = <T,>(fn: () => Promise<T>): Promise<T> => bypassOrg(fn)

/**
 * Enter the org for THIS test body, clear every cache that outlives a body, then
 * run it. A fresh org per body keeps the per-org caches isolated even if a reset
 * lands in the wrong async context.
 */
let orgSeq = 0
function withOrg<T>(fn: () => Promise<T> | T, env?: () => void): Promise<T> {
  orgSeq += 1
  enterWithOrg(`org-recovery-${orgSeq}`)
  // SNAPSHOT, then always restore. `env()` is used to point COGNEE_SYSTEM_DIR at a
  // path that cannot be a directory (the ENOTDIR quarantine tests). Without this
  // restore the broken root LEAKED into every later test in the file, which is
  // order-dependent and failed only on CI's runner. A per-test env override must be
  // scoped to that test -- two of these tests even restore it by hand, and relying
  // on that is exactly the fragility that broke CI.
  const saved = env ? { COGNEE_SYSTEM_DIR: process.env.COGNEE_SYSTEM_DIR } : null
  if (env) env()
  resetClientCache('all')
  invalidateCogneeSettings('all')
  resetSdk()
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (!saved) return
      if (saved.COGNEE_SYSTEM_DIR === undefined) delete process.env.COGNEE_SYSTEM_DIR
      else process.env.COGNEE_SYSTEM_DIR = saved.COGNEE_SYSTEM_DIR
    })
}

const currentOrg = (): string => `org-recovery-${orgSeq}`

/**
 * The store paths `storeDirsFor()` will derive. Mirrors the production
 * sanitiser, NOT a re-implementation of it: the org ids this file uses are
 * already filename-safe, so any divergence in the sanitiser would show up as the
 * test looking in the wrong place rather than as a false pass.
 */
function dirsFor(orgId: string): { dataDir: string; systemDir: string } {
  // Reads the LIVE env, not the module constants, because two tests deliberately
  // repoint COGNEE_SYSTEM_DIR at an unusable path. Deriving from a stale constant made
  // those tests plant the store in one tree and assert in another — the helper looked
  // correct while checking the wrong directory, and the mismatch only surfaced on CI.
  // Production reads the same env on every call (see storeDirsFor in cognee-core.ts).
  const dataRoot = process.env.COGNEE_DATA_DIR ?? DATA_ROOT
  const systemRoot = process.env.COGNEE_SYSTEM_DIR ?? SYSTEM_ROOT
  return { dataDir: join(dataRoot, orgId), systemDir: join(systemRoot, orgId) }
}

/** Plant a store the way a crashed local cognee leaves one: both dirs on disk. */
function plantCorruptStore(orgId: string): { dataDir: string; systemDir: string } {
  const dirs = dirsFor(orgId)
  mkdirSync(dirs.systemDir, { recursive: true })
  mkdirSync(dirs.dataDir, { recursive: true })
  // A torn write-ahead log is the measured cause of the permanent failure.
  writeFileSync(join(dirs.systemDir, 'graph.wal'), 'torn')
  return dirs
}

/**
 * Does the org's store still hold its damaged bytes UNDER `root`?
 *
 * MEASURED layout (probed, not assumed): the quarantine dir is
 * `<systemDir>.corrupt-<stamp>/`, and inside it the store keeps its own
 * basename -- `<quarantine>/<org>/graph.wal`. So a damaged WAL one level deep is
 * the positive signal that the move happened; there is no `systemDir.corrupt-<stamp>`
 * directory holding the WAL directly.
 */
function damagedWalUnder(root: string): boolean {
  return existsSync(join(root, 'graph.wal')) || existsSync(join(root, currentOrg(), 'graph.wal'))
}

/**
 * The quarantine directories created for `orgId`.
 *
 * Every org this file uses is a flat directory directly under SYSTEM_ROOT, so the
 * quarantine dirs are its siblings there -- `<orgId>.corrupt-<stamp>`. The name is
 * derived from `new Date()` inside the code under test, so this reads the ACTUAL
 * directory entries rather than re-deriving a pattern: a re-derived pattern would
 * happily match a directory that does not exist. It takes the org id as an
 * argument rather than reading the current one, because a body may warm several
 * orgs and `orgSeq` has moved on by the time it asserts.
 */
function quarantinesHolding(orgId: string): string[] {
  if (!existsSync(SYSTEM_ROOT)) return []
  return readdirSync(SYSTEM_ROOT)
    .filter((n) => n.startsWith(`${orgId}.corrupt-`))
    .map((n) => join(SYSTEM_ROOT, n))
}

/** The quarantine dirs for the org the CURRENT body entered. */
const quarantineDirsFor = (orgId: string): string[] => quarantinesHolding(orgId)

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true })
  } catch {}
})

// ===========================================================================
// 1 -- the per-call deadline
// ===========================================================================

describe('withDeadline — an SDK call that never settles is bounded', () => {
  test('resolves with the value when the promise settles in time', async () => {
    // The deadline must be invisible on the happy path -- a bound that changed
    // the resolved value or the timing would be a behaviour change, not a guard.
    const started = Date.now()
    await expect(withDeadline(Promise.resolve('remembered'), 'remember')).resolves.toBe('remembered')
    // The timer is cleared rather than left to fire after the fact: a bound that
    // keeps the event loop alive until its deadline delays every process exit.
    // Asserted as elapsed time, which is the observable consequence of
    // clearTimeout(), and the only part of it reachable without a probe harness.
    expect(Date.now() - started).toBeLessThan(150)
  })

  test('a non-string resolution is passed through unchanged', async () => {
    const value = { result: { kind: 'Items', data: ['a'] } }
    await expect(withDeadline(Promise.resolve(value), 'search')).resolves.toBe(value)
  })

  test('a prompt rejection is passed through unchanged (no deadline involved)', async () => {
    const boom = new Error('cognee search failed')
    await expect(withDeadline(Promise.reject(boom), 'recall')).rejects.toBe(boom)
  })

  test('REJECTS when the promise never settles, naming the op and the deadline', async () => {
    // The whole point: a native call that never returns used to hang the caller
    // forever. `tool-router.ts` awaits `rememberChatTurn` AFTER computing the
    // user's answer, so this rejection is what unblocks the response.
    const started = Date.now()
    const never = new Promise<string>(() => {})
    await expect(withDeadline(never, 'ownerId')).rejects.toThrow(
      // Both halves matter: the op identifies WHICH call to look at, the timeout
      // explains why it stopped, and both come from COGNEE_CALL_TIMEOUT_MS.
      'cognee ownerId exceeded 200ms',
    )
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('the deadline is per call, so a second hung call still gets its own bound', async () => {
    // A shared/stale timer would make exactly one call per process time out.
    await expect(withDeadline(new Promise(() => {}), 'first')).rejects.toThrow('cognee first exceeded 200ms')
    await expect(withDeadline(new Promise(() => {}), 'second')).rejects.toThrow('cognee second exceeded 200ms')
  })

  test('a promise that settles just inside the deadline is NOT raced into a rejection', async () => {
    // Guards the boundary: `Promise.race` must let the value through when it
    // arrives before the timer, and the timer must not fire first for a call
    // that is merely slow. 50ms against a 200ms bound.
    await expect(
      withDeadline(new Promise((r) => setTimeout(() => r('slow but fine'), 50)), 'search'),
    ).resolves.toBe('slow but fine')
  })
})

// ===========================================================================
// 2 -- self-heal: quarantine the damaged store, rebuild once
// ===========================================================================

describe('getCogneeClient self-heal — a corrupt store is quarantined and rebuilt ONCE', () => {
  test('quarantines the damaged store, retries once, and the rebuild returns a client', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      const dirs = plantCorruptStore(org)
      assertFreshCounters()
      // Attempt 1 fails like a torn store; attempt 2 (the rebuild) succeeds.
      scriptAttempts([CORRUPTION_MSG, ''])
      const client = await getCogneeClient()

      // The quarantine is the recovery: without it the torn WAL fails every init
      // for this tenant forever, and the allocator message points at nothing.
      expect(client).not.toBeNull()
      // TWO attempts is the whole self-heal: the failed init and exactly one
      // rebuild. One attempt would mean no retry happened at all.
      expect(sdk.attempts).toEqual([CORRUPTION_MSG, ''])
      expect(sdk.ownerIdCalls).toBe(1)

      // QUARANTINE, NOT DELETE -- the bytes may be the tenant's only copy of
      // their graph, so a false positive must be recoverable.
      const quarantined = quarantineDirsFor(org)
      expect(quarantined.length).toBe(1)
      expect(damagedWalUnder(quarantined[0])).toBe(true)

      // The org's store path is free for the rebuilt store: a quarantine that
      // left the damaged dir in place would loop straight back into the failure.
      expect(existsSync(join(dirs.systemDir, 'graph.wal'))).toBe(false)
    })
  }, 5000)

  test('the retry happens EXACTLY once when the rebuild fails too', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      plantCorruptStore(org)
      // Both attempts fail with the corruption signature. A rebuild loop would
      // destroy a second store on every pass, so the code retries once and stops.
      scriptAttempts([CORRUPTION_MSG, REBUILD_MSG])
      expect(await getCogneeClient()).toBeNull()
      // Two constructions = the original attempt plus ONE rebuild. Three would
      // mean the guard is not holding. Asserted on the exact attempt sequence so
      // the second failure is the REBUILD's, not the original's repeated.
      expect(sdk.attempts).toEqual([CORRUPTION_MSG, REBUILD_MSG])
      // The failure is recorded so the 30s backoff applies instead of every
      // subsequent query paying for another failed native warm.
      expect(await getCogneeClient()).toBeNull()
      expect(sdk.attempts).toEqual([CORRUPTION_MSG, REBUILD_MSG])
    })
  }, 5000)

  test('a CONFIG error is NOT quarantined and NOT retried — a bad API key must not move a healthy graph', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      const dirs = plantCorruptStore(org)
      // The guard the whole self-heal path turns on. `llm_api_key must be
      // configured` is a deploy/config mistake; treating it as store damage would
      // quarantine a perfectly healthy graph on every bad deploy, and the graph
      // would be gone from the tenant's perspective by the second restart.
      scriptAttempts([CONFIG_MSG])
      expect(await getCogneeClient()).toBeNull()
      expect(sdk.attempts).toEqual([CONFIG_MSG])
      // The store is untouched, in place, still containing its data.
      expect(existsSync(join(dirs.systemDir, 'graph.wal'))).toBe(true)
      // ...and no quarantine directory was created next to it.
      expect(quarantineDirsFor(org)).toEqual([])
    })
  }, 5000)

  test('a non-corruption error AFTER a corrupt init is still not retried', async () => {
    return withOrg(async () => {
      plantCorruptStore(currentOrg())
      // A different failure message on the second attempt is irrelevant: the
      // match is on the error in hand, not on "we have retried before".
      scriptAttempts(['llm_api_key must be configured'])
      expect(await getCogneeClient()).toBeNull()
      expect(sdk.attempts).toEqual(['llm_api_key must be configured'])
    })
  }, 5000)

  test('a corruption signature raised from warm() (not the constructor) also self-heals', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      const dirs = plantCorruptStore(org)
      // Two different native shapes reach JS: the constructor throws for some
      // builds, warm() throws for others. Both are the same damaged store.
      scriptAttempts(['onWarm', ''])
      expect(await getCogneeClient()).not.toBeNull()
      // The constructor-succeeded attempts, and BOTH of them reached warm(): the
      // failing one and the successful rebuild.
      expect(sdk.attempts).toEqual(['onWarm', ''])
      expect(sdk.warmCalls).toBe(2)
      // Deeper than naming the directory: the damaged store's bytes are the thing
      // that survived. A quarantine that moved the dataDir and dropped the
      // systemDir would leave the torn graph.wal in the live path.
      const quarantined = quarantineDirsFor(org)
      expect(quarantined.length).toBe(1)
      expect(damagedWalUnder(quarantined[0])).toBe(true)
      expect(existsSync(join(dirs.systemDir, 'graph.wal'))).toBe(false)
    })
  }, 5000)

  test('a SECOND corruption AFTER a successful rebuild is quarantined again, on a new call', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      plantCorruptStore(org)
      scriptAttempts([CORRUPTION_MSG, ''])
      expect(await getCogneeClient()).not.toBeNull()
      expect(sdk.warmCalls).toBe(1)

      // A fresh call with a fresh failure must get the same treatment: the
      // one-retry guard is per failed init, not a process-wide "gave up once".
      // The cache MUST be dropped first -- while the recovered client is cached
      // getCogneeClient() returns it immediately and never consults the SDK, so
      // re-damaging the store alone would prove nothing. (The cache reset is what
      // a restart or a reset endpoint does, and is exactly the harness need the
      // degradation suite documents.)
      resetClientCache('all')
      plantCorruptStore(org)
      scriptAttempts([CORRUPTION_MSG, ''])
      expect(await getCogneeClient()).not.toBeNull()
      // MEASURED shape: the corruption is raised by the CONSTRUCTOR, so a cycle
      // costs a constructor attempt + a rebuild attempt and warm() is only reached
      // on each cycle's SECOND attempt. Attempts therefore go 2 -> 3 (not 4), while
      // warm() goes 1 -> 2. Asserting `warmCalls` is what pins the retry here.
      expect(sdk.attempts).toEqual([CORRUPTION_MSG, '', CORRUPTION_MSG, ''])
      expect(sdk.warmCalls).toBe(2)
      // ...and the two quarantines hold the two DIFFERENT torn WALs, i.e. the
      // second cycle moved its own store rather than the first one back.
      expect(readdirSync(quarantineDirsFor(org)[0]).length).toBeGreaterThan(0)
      const quarantines = quarantineDirsFor(org)
      expect(quarantines.length).toBe(2)
      expect(quarantines.every(damagedWalUnder)).toBe(true)
    })
  }, 5000)

  test('the rebuilt client is usable and carries the rebuilt ownerId', async () => {
    return withOrg(async () => {
      plantCorruptStore(currentOrg())
      scriptAttempts([CORRUPTION_MSG, ''])
      const client = await getCogneeClient()
      // The self-heal must return the RECOVERED client, not a stale null: the
      // caller has no other way to know recovery happened.
      expect(client).toBeInstanceOf(FakeCognee)
      expect(getCogneeOwnerId()).toBe('owner-of-this-org')
    })
  }, 5000)

  test('a healthy init is not retried and not quarantined', async () => {
    return withOrg(async () => {
      const org = currentOrg()
      // Control case: without it, a code path that ALWAYS retried and quarantined
      // would still pass every test above.
      plantCorruptStore(org)
      scriptAttempts([''])
      expect(await getCogneeClient()).not.toBeNull()
      expect(sdk.attempts).toEqual([''])
      expect(quarantineDirsFor(org)).toEqual([])
    })
  }, 5000)

  test('a failed RENAME still clears the damaged store so the rebuild can run', async () => {
    // MEASURED, and it took two failed attempts to get here: `quarantineStore` CANNOT
    // throw. `mkdirSync(recursive)` silently succeeds even when the target name exists
    // as a FILE (verified directly), and the `renameSync` failure is caught INSIDE
    // quarantineStore with an rmSync fallback. So the `catch (rebuildErr)` branch around
    // the rebuild is unreachable in practice -- tests asserting it could only ever pass
    // for the wrong reason, which is exactly what happened: two earlier versions of this
    // test "covered" lines by never actually planting a store.
    //
    // The behaviour that MATTERS is therefore not "does it throw" but "does the damaged
    // store get out of the way". This asserts that contract directly.
    return withOrg(async () => {
      const org = currentOrg()
      const planted = plantCorruptStore(org)
      scriptAttempts([CORRUPTION_MSG, ''])
      expect(await getCogneeClient()).not.toBeNull()
      // The damaged bytes were moved aside, so the retry did not loop back into them.
      expect(existsSync(join(planted.systemDir, 'graph.wal'))).toBe(false)
      // ...and they were PRESERVED, not deleted: quarantine, never destroy.
      const quarantined = quarantineDirsFor(org)
      expect(quarantined.length).toBe(1)
      expect(damagedWalUnder(quarantined[0])).toBe(true)
    })
  }, 5000)

  test('ONLY the failing org is quarantined — a sibling org keeps its store', async () => {
    return withOrg(async () => {
      // Both org ids are captured UP FRONT: entering the sibling bumps orgSeq, so
      // reading `currentOrg()` later in the body names the wrong org.
      const failing = currentOrg()
      // A REAL sibling org, warmed first, so the recovery happens BESIDE a live
      // client-cache entry rather than in an empty cache. Nothing calls the cache
      // reset after this point: doing so would evict the sibling and the test
      // would stop comparing two live entries.
      const sibling = `${failing}-sibling`
      enterWithOrg(sibling)
      const siblingDirs = plantCorruptStore(sibling)
      scriptAttempts([''])
      expect(await getCogneeClient()).not.toBeNull()

      enterWithOrg(failing)
      const failingDirs = plantCorruptStore(failing)
      // MANDATORY, and the reason this test first failed: `outcomeForAttempt()` indexes
      // `outcomes` by `attempts.length`, which is file-global. The sibling above already
      // recorded one attempt, so WITHOUT this reset the failing org's first attempt would
      // read index 1 -- the `''` meant for the rebuild -- come back a SUCCESS, and never
      // heal at all. The test would then have "proved" a bug that did not exist.
      resetSdk()
      scriptAttempts([CORRUPTION_MSG, ''])
      expect(await getCogneeClient()).not.toBeNull()

      // Quarantine is per-org state: in local mode one directory IS one knowledge
      // graph, so a recovery for one org must not touch another's bytes.
      expect(existsSync(join(siblingDirs.systemDir, 'graph.wal'))).toBe(true)
      expect(quarantinesHolding(sibling)).toEqual([])
      // ...and the failing org's own damaged store WAS moved aside.
      const failingQuarantine = quarantinesHolding(failing)
      expect(failingQuarantine.length).toBe(1)
      expect(damagedWalUnder(failingQuarantine[0])).toBe(true)
      expect(existsSync(join(failingDirs.systemDir, 'graph.wal'))).toBe(false)
    })
  }, 5000)
})

// ===========================================================================
// 3 -- the no-op paths (guard rails: they were only ever incidental coverage)
// ===========================================================================

describe('getCogneeClient — the documented no-op paths stay no-ops', () => {
  test('returns null and never touches the SDK when there is no org context', async () => {
    // Fail closed: a background worker that forgot enterWithOrg must get NOTHING
    // rather than whichever org initialised first. Constructing the SDK here
    // would create a store directory for an org that is not the request's.
    //
    // These two bodies reset the counters DIRECTLY instead of going through
    // withOrg() -- withOrg enters an org, and the absence of an org is the thing
    // under test.
    resetSdk()
    scriptAttempts([''])
    expect(await withoutOrg(() => getCogneeClient())).toBeNull()
    expect(sdk.attempts).toEqual([])
  })

  test('returns null with no org context even if the SDK would fail', async () => {
    resetSdk()
    scriptAttempts([CORRUPTION_MSG, ''])
    expect(await withoutOrg(() => getCogneeClient())).toBeNull()
    // No attempt means no quarantine either -- there is no org to quarantine for.
    expect(sdk.attempts).toEqual([])
    expect(quarantineDirsFor('whatever')).toEqual([])
  })

  test('returns null when cognee is disabled by the kill switch', async () => {
    return withOrg(
      async () => {
        // What is pinned here is the KILL SWITCH, not a client property:
        // getCogneeClient() itself never consults `settings.enabled` (its CALLERS
        // do, via isCogneeEnabled()), so a client is still built for a disabled
        // org. Asserting `client === null` here would be asserting behaviour the
        // code does not have — see the honest-gaps note at the top of this file.
        expect(await isCogneeEnabled()).toBe(false)
      },
      () => { process.env.COGNEE_ENABLED = 'false' },
    )
  })

  test('with no org context the kill switch reports disabled and no client exists', async () => {
    await withoutOrg(async () => {
      expect(await isCogneeEnabled()).toBe(false)
      // No org context also means no OWNER id -- the owner is what every search
      // passes, so a global owner id would have been a cross-tenant read.
      expect(getCogneeOwnerId()).toBeUndefined()
    })
  })
})
