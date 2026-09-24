import { afterAll, beforeEach, describe, expect, test, mock } from 'bun:test'

// ===========================================================================
// The cognee resilience contract: memory failing in EVERY plausible way must be
// invisible to the user.
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// A live probe (Bun 1.3.14) showed cognee init failing with
//
//     Graph database error: std::bad_alloc
//
// -- a native failure inside the SDK, surfaced through JS init -- while chat
// still answered correctly. That graceful-degradation behaviour was only ever
// tested BY ACCIDENT: the existing suites cover the "disabled" and the "happy
// path" cases, and the other failure shapes (a different call throwing, a hung
// search, a missing package) were unobserved. Memory is becoming the CORE of the
// product, so "does it fail safely?" has to be pinned by tests rather than
// assumed.
//
// The contract, stated once:
//   - recallContext() returns '' and NEVER rejects.
//   - rememberChatTurn() resolves and NEVER rejects (it is fire-and-forget at
//     the streaming call site: `void rememberChatTurn(...)` in send/route.ts,
//     and awaited in tool-router.ts / the agent routes).
//   - the kill switch and the absence of an org context are no-ops, not crashes,
//     and never a cross-tenant read.
//
// THE MOCKING TRAP THIS FILE HAS TO RESPECT
// ---------------------------------------------------------------------------
// `mock.module` does not apply to a module that was STATICALLY imported: Bun has
// already resolved and hoisted that import by the time the mock registry is
// consulted (the same rule real-connectors.test.ts documents). So every mock is
// registered BEFORE a DYNAMIC `await import(...)`, which is also what lets this
// file mock the SDK PACKAGE itself and prove the init-crash case at the real
// boundary instead of against a stub of our own wrapper.
//
// Two more Bun-1.4.x facts the file depends on:
//   - `enterWithOrg()` inside a hook does NOT reach the test body, so every test
//     enters its own org INSIDE the body.
//   - AsyncLocalStorage is process-wide, so this file runs in its own `bun test`
//     subprocess (scripts/test.ts) where no other file's mocks can leak in.
//
// Nothing here reads a developer's .env, and no Redis or DB is required.
// ===========================================================================

// --- Mock behaviour, varied per case (the established pattern in cognee.test.ts)

const state = {
  /** This org's AppConfig row; null = pre-setup / not yet configured. */
  appConfig: { id: 'cfg-1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null } as any,
  /** The SDK module itself fails to load (`await import('@cognee/cognee-ts')`). */
  sdkMissing: false,
  /** `new Cognee(...)` throws — the std::bad_alloc shape, as JS would see it. */
  constructThrows: false,
  /** `warm()` throws (init-time failure after the constructor succeeded). */
  warmThrows: false,
  /** `ownerId()` throws (init-time failure on the last init step). */
  ownerIdThrows: false,
  /** `datasets.has()` result; false = a fresh org with no dataset yet. */
  datasetExists: true as boolean | null,
  /** `search()` behaviour. null = an empty result; 'throw'; 'hang' = never settles. */
  search: null as null | 'ok' | 'throw' | 'hang',
  /** `remember()` throws. */
  rememberThrows: false,
  /** `remember()` never settles. */
  rememberHang: false,
  /** The org's LLM config; null models "this org has no LLM configured". */
  llm: { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://llm', apiKey: 'k', model: 'm' } as any,
  constructCalls: 0,
  searchCalls: 0,
  rememberCalls: 0,
}

function resetState() {
  state.appConfig = { id: 'cfg-1', cogneeEnabled: true, cogneeDbProvider: 'local', cogneeDbUrl: null }
  state.sdkMissing = false
  state.constructThrows = false
  state.warmThrows = false
  state.ownerIdThrows = false
  state.datasetExists = true
  state.search = null
  state.rememberThrows = false
  state.rememberHang = false
  state.llm = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://llm', apiKey: 'k', model: 'm' }
  state.constructCalls = 0
  state.searchCalls = 0
  state.rememberCalls = 0
}

// ---------------------------------------------------------------------------
// One SDK double, registered twice: the package specifier that the modules under
// test import, and a sentinel used to read it back BEFORE the dynamic import
// below. `mock.module` survives a dynamic `import()` of the mocked specifier
// (the same mechanism cognee-core.test.ts relies on), but not the registry
// lookup itself — the sentinel is what makes the indirection free.
// ---------------------------------------------------------------------------
/**
 * A test whose SUBJECT is the in-process SDK branch.
 *
 * WHY THESE ARE SKIPPED, and why they were kept rather than deleted. On 2026-09-24 the
 * `@cognee/cognee-ts` bindings were removed and the deployment moved to the cognee v1.6.0
 * API server. `getCogneeClient()` now returns null unconditionally, so the branch these
 * tests drive is UNREACHABLE IN PRODUCTION and they were failing — 13 of them — on a
 * subject that no longer exists.
 *
 * Deleting them was the first attempt and it was wrong for the same reason it is usually
 * wrong: they document real failure-mode analysis (a hung call, a lying `has()`, a
 * throwing search, sibling-org isolation) that any future transport must also survive.
 * Skipping keeps that analysis in the repository, greppable, with the reason attached —
 * and `test.skip` reports the count, so nobody mistakes a skipped suite for a passing one.
 *
 * TO REVIVE: give them a client. Either restore an in-process transport, or point them at
 * the HTTP client and assert through `cognee-http`'s seams instead of `client.search`.
 */
const sdkBranchTest = test.skip

const MOCKED_SDK = '@cognee/cognee-ts'
const SDK_SENTINEL = 'cognee-degradation-test/sdk-sentinel'

class FakeCognee {
  constructor() {
    state.constructCalls++
    if (state.constructThrows) {
      // The observed live failure. Thrown from the constructor, i.e. during
      // client construction, which is exactly the path getCogneeClient() guards.
      throw new Error('Graph database error: std::bad_alloc')
    }
  }
  async warm() {
    if (state.warmThrows) throw new Error('Graph database error: std::bad_alloc')
  }
  async ownerId() {
    if (state.ownerIdThrows) throw new Error('ownerId unavailable')
    return 'owner-of-this-org'
  }
  datasets = { has: async () => state.datasetExists }
  async search() {
    state.searchCalls++
    if (state.search === 'throw') throw new Error('cognee search failed')
    // 'hang' models an SDK call that never settles -- no error, no result.
    if (state.search === 'hang') return new Promise(() => {})
    if (state.search === 'ok') return { result: 'cognee remembers: revenue was Rp 5m' }
    return null
  }
  async remember() {
    state.rememberCalls++
    if (state.rememberThrows) throw new Error('cognee remember failed')
    if (state.rememberHang) return new Promise(() => {})
  }
}

mock.module(MOCKED_SDK, () => ({
  get Cognee() {
    // A deployment that forgot to ship/trace the package must degrade, not explode
    // at import time -- the SDK is loaded by a dynamic `import()` inside a try.
    if (state.sdkMissing) throw new Error(`Cannot find module '${MOCKED_SDK}'`)
    return FakeCognee
  },
}))
mock.module(SDK_SENTINEL, () => ({ FakeCognee }))

const sdk = await import(SDK_SENTINEL)
mock.module(MOCKED_SDK, () => ({ Cognee: sdk.FakeCognee }))

mock.module('@/lib/db', () => ({
  db: {
    appConfig: { findFirst: async () => state.appConfig },
    document: { groupBy: async () => [], update: async () => ({}) },
  },
}))

mock.module('@/lib/llm-config', () => ({
  // Null = this org has no LLM config yet; that must never leak out as a throw.
  getLlmRuntimeConfig: async () => state.llm,
}))

mock.module('@/lib/embeddings', () => ({
  getEmbeddingRuntimeConfig: async () => null,
}))

// ---------------------------------------------------------------- the modules

const { recallContext, rememberChatTurn, cogneeHealth, clearSessionCache } = await import('@/lib/cognee')
const { getCogneeClient, invalidateCogneeSettings, resetClientCache } = await import('@/lib/cognee-core')
const { enterWithOrg, bypassOrg } = await import('@/lib/prisma-tenant')

const TEST_ORG = 'org-degradation'

/**
 * A fresh org per test body, so no two cases share a client-cache / settings-cache
 * slot even if a reset lands in the wrong async context.
 */
let orgSeq = 0
function nextOrg(): string {
  orgSeq += 1
  return `${TEST_ORG}-${orgSeq}`
}

/**
 * Enter the org for THIS test body with a clean slate, then run it.
 *
 * Each case also gets its OWN org id. That is a harness isolation choice, not a
 * claim about production: it is what keeps the per-org caches independent.
 *
 * `scope` is for a case that must arrange env/DB state BEFORE the caches are read
 * (failure mode 1's kill switch), while still getting a cold settings cache.
 */
function withOrg<T>(
  fn: () => Promise<T> | T,
  scope?: () => void,
  org: string = nextOrg(),
): Promise<T> {
  enterWithOrg(org)
  resetForBody()
  if (scope) scope()
  return Promise.resolve().then(fn)
}

/**
 * `state` is reset in a HOOK, not inside withOrg, because a test configures it
 * BEFORE calling withOrg (`state.search = 'throw'`). Resetting inside withOrg
 * would erase the very setup the test just made -- measured: it turned 11 passing
 * cases into 19 failures. `state` holds no tenant context, so a hook is safe for
 * it; the env vars and caches are context-sensitive and live in resetForBody().
 */
beforeEach(() => {
  resetState()
  // HERMETIC. `COGNEE_SERVER_URL` decides whether memory has a backend AT ALL, and this
  // file's failure modes are mostly "there is no usable backend" — so a developer or CI box
  // with a cognee sidecar configured (the supported deployment!) changed what these tests
  // measured. MEASURED: adding `COGNEE_SERVER_URL` to `.env` turned 9 of them red, because
  // Bun loads `.env` and `scripts/test.ts` passes it through.
  //
  // Same class of leak as the SSRF one fixed earlier in this repo: a test asserting a
  // DEFAULT must not inherit the machine's configuration. Tests that WANT a server set it
  // explicitly, which still works — only the ambient value is removed.
  delete process.env.COGNEE_SERVER_URL
  delete process.env.COGNEE_SERVER_API_KEY
})

/** Run without any org context. bypassOrg is a callback wrapper, not a bare reset. */
const withoutOrg = <T,>(fn: () => Promise<T>): Promise<T> => bypassOrg(fn)

/**
 * Reject if `p` has not settled within `ms`.
 *
 * Failure mode 7 is about a call that NEVER settles, so the test has to be able
 * to fail on its own: without this race the assertion would simply hang and the
 * file would time out with no diagnosis. The rejection is what the mode-7 tests
 * assert on -- it is the caller's deadline doing the bounding.
 */
function within<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
    p.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

const TURN = {
  sessionId: 's1',
  userMessage: 'how much revenue last quarter?',
  aiMessage: 'Rp 5m',
  toolRuns: [{ type: 'SQL', status: 'success', latencyMs: 12 }],
}

const ENV_KEYS = ['COGNEE_ENABLED', 'COGNEE_DB_URL', 'COGNEE_DB_PROVIDER', 'COGNEE_DATA_DIR']
const savedEnv: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) savedEnv[k] = process.env[k]

/**
 * Clear the cognee env vars and both caches for the calling context.
 *
 * MEASURED — this is a harness requirement, not defensiveness. Three pieces of
 * state outlive a test body, and each one made a LATER case measure the wrong
 * thing:
 *
 *  1. `process.env.COGNEE_ENABLED='false'` (failure mode 1) is a process-wide
 *     kill switch. Restoring it only in `afterAll` left every subsequent case
 *     running with cognee killed, so `cogneeHealth()` reported `disabled`,
 *     `getCogneeClient()` returned null and the SDK was never touched. That was
 *     a cascade of ~10 failures that looked like ten separate broken behaviours
 *     and was one leaked env var.
 *  2. Settings has a 10s TTL.
 *  3. The client cache refuses a retry for 30s after a failed init.
 *  4. The session recall cache in cognee-memory.ts memoises results per session
 *     for 60s.
 *
 * (2) and (3) also cannot be cleared from a `beforeEach` hook: a hook runs under
 * whatever async context the RUNNER holds, so it misses the org the body is about
 * to enter. Same Bun quirk as `enterWithOrg` in a hook (invariants.test.ts
 * enforces that one).
 */
function resetForBody(): void {
  for (const k of ENV_KEYS) delete process.env[k]
  resetClientCache('all')
  invalidateCogneeSettings('all')
  // The THIRD cache, and the one that cost the most time to find: recall results
  // are memoised per session in cognee-memory.ts for 60s. Every case here reuses
  // `sessionId: 's1'`, so whichever case ran first pinned its answer and every
  // later case was served that answer instead of exercising its own failure
  // mode -- `recallContext` kept returning a healthy-looking string in tests
  // whose SDK was configured to throw, hang or not exist.
  clearSessionCache()
}

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ===========================================================================
// 1 -- the process-wide kill switch
// ===========================================================================

describe('failure mode 1 -- COGNEE_ENABLED=false kill switch', () => {
  test("recallContext returns '' and never touches the SDK", async () => {
    return withOrg(async () => {
      // Asserted INSIDE the org context on purpose: with no org, EVERYTHING is a
      // no-op (fail-closed, case 6), so a kill switch measured outside the context
      // would pass for the wrong reason.
      expect(await recallContext({ query: 'revenue', sessionId: 's1' })).toBe('')
      // The switch must short-circuit before the SDK is even loaded: the scheduler
      // worker sets this precisely so it never grabs the graph file lock.
      expect(state.constructCalls).toBe(0)
      expect(state.searchCalls).toBe(0)
    }, () => { process.env.COGNEE_ENABLED = 'false' })
  })

  test('rememberChatTurn resolves as a no-op', async () => {
    return withOrg(async () => {
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
      expect(state.rememberCalls).toBe(0)
    }, () => { process.env.COGNEE_ENABLED = 'false' })
  })

  test("cogneeHealth reports enabled:false, connected:false, mode:'disabled'", async () => {
    return withOrg(async () => {
      // `serverVersion` was added when the health probe stopped asking "was an SDK
      // client built?" and started asking "does the server answer?". Under the kill
      // switch there is no server to ask, so it is null — and asserting the exact
      // shape keeps a future field from being added without updating this file.
      expect(await cogneeHealth()).toEqual({
        enabled: false,
        connected: false,
        mode: 'disabled',
        serverVersion: null,
      })
      // A health probe must not warm a client either -- that would defeat the
      // kill switch on any dashboard polling the endpoint.
      expect(state.constructCalls).toBe(0)
    }, () => { process.env.COGNEE_ENABLED = 'false' })
  })
})

// ===========================================================================
// 2 -- client construction fails
// ===========================================================================

describe('failure mode 2 -- client construction fails', () => {
  sdkBranchTest('a throwing constructor yields a null client instead of a throw', async () => {
    state.constructThrows = true
    return withOrg(async () => {
      // getCogneeClient() is the single funnel for every memory entry point, so
      // "null instead of throw" is the load-bearing half of the contract.
      await expect(getCogneeClient()).resolves.toBeNull()
      expect(state.constructCalls).toBe(1)
    })
  })

  test("a throwing constructor makes recall return '' and never reject", async () => {
    state.constructThrows = true
    return withOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
      expect(state.searchCalls).toBe(0)
    })
  })

  test('a throwing constructor makes remember swallow the failure', async () => {
    state.constructThrows = true
    return withOrg(async () => {
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
      expect(state.rememberCalls).toBe(0)
    })
  })

  test("with no server configured: health is enabled but NOT connected, recall returns ''", async () => {
    // CHANGED SUBJECT, same admin-facing distinction. This used to make the SDK's
    // warm() throw and assert health reported enabled-but-disconnected. The SDK is
    // gone, so the equivalent unreachable-backend case is now "enabled, but no
    // COGNEE_SERVER_URL" — and the distinction still matters: the feature is
    // switched ON (so the UI must not render "disabled"), while nothing is
    // reachable. `recallContext` must degrade to '' rather than throw.
    return withOrg(async () => {
      expect(await cogneeHealth()).toEqual({
        enabled: true,
        connected: false,
        mode: 'disabled',
        serverVersion: null,
      })
      expect(await recallContext({ query: 'revenue', sessionId: 's1' })).toBe('')
    })
  })

  test("a throwing ownerId() leaves no half-registered client: recall returns '' and the client is null", async () => {
    // ownerId() is the LAST init step. Registering the client before it resolved
    // would leave a cached client with no owner id, i.e. every later search
    // unscoped -- the cross-tenant shape the per-org rewrite exists to prevent.
    state.ownerIdThrows = true
    return withOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
      await expect(getCogneeClient()).resolves.toBeNull()
      expect(state.searchCalls).toBe(0)
    })
  })

  test("a missing @cognee/cognee-ts package is harmless: recall returns ''", async () => {
    // A fresh checkout, or a standalone build whose output tracing dropped the
    // package. The dynamic import must sit INSIDE the try for this to hold.
    state.sdkMissing = true
    return withOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
    })
  })

  sdkBranchTest('a failed init is tried once per retry window, not once per memory call', async () => {
    state.constructThrows = true
    return withOrg(async () => {
      await recallContext({ query: 'q1', sessionId: 's1' })
      await rememberChatTurn(TURN)
      await cogneeHealth()
      // INIT_RETRY_MS = 30s: the SECOND recall inside the same window must reuse
      // the negative result instead of re-dialling the SDK.
      await recallContext({ query: 'q2', sessionId: 's2' })
      // On a deployment where the SDK is permanently broken (the bad_alloc case),
      // memory must not add an init attempt -- with its own file lock and
      // allocation -- to every single chat turn.
      expect(state.constructCalls).toBe(1)
    })
  })
})

// ===========================================================================
// 3 -- the recall SEARCH call throws
// ===========================================================================

describe('failure mode 3 -- the recall search throws', () => {
  test("every strategy failing still resolves to '' instead of rejecting", async () => {
    state.search = 'throw'
    return withOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
    })
  })

  sdkBranchTest('all three graph strategies plus the last-resort search are attempted', async () => {
    state.search = 'throw'
    return withOrg(async () => {
      await recallContext({ query: 'revenue', sessionId: 's1' })
      // MEASURED: 5 round-trips with a sessionId --
      // SUMMARIES + CHUNKS + NATURAL_LANGUAGE (the three graph strategies) +
      // the unscoped last-resort search + the session leg. A customer whose cognee
      // build supports only some search types must still get memory from the ones
      // that work, so one dead strategy must not end the loop.
      expect(state.searchCalls).toBe(5)
    })
  })

  sdkBranchTest('a throwing search still merges whatever the surviving strategies return', async () => {
    // The assertion that would catch an over-broad try/catch swallowing a WORKING
    // strategy: the session leg is healthy and must reach the caller.
    state.search = null
    return withOrg(async () => {
      const out = await recallContext({ query: 'revenue', sessionId: 's1' })
      expect(out).toBe('')
      // An empty result is still a SUCCESSFUL search round-trip: the SDK was
      // reached five times, which is what distinguishes "no memory yet" from
      // "memory is unreachable".
      expect(state.searchCalls).toBe(5)
    })
  })

  sdkBranchTest("a dataset that reports 'missing' still RECALLS — has() is advisory, not authoritative", async () => {
    state.datasetExists = false
    state.search = 'ok'
    return withOrg(async () => {
      // This test used to assert the OPPOSITE ("returns '' without searching at all"),
      // and that assertion was the bug. MEASURED against a real store: `datasets.has()`
      // returned false for a dataset that `datasets.list()` listed and whose fact a raw
      // search returned, so the old guard disabled recall for a healthy org — memory
      // written, stored, retrievable, and never surfaced, with no error and no log.
      // A false here must therefore never suppress a real search.
      expect(await recallContext({ query: 'revenue', sessionId: 's1' })).toContain('cognee remembers')
      // It must genuinely search rather than trust the flag.
      expect(state.searchCalls).toBeGreaterThan(0)
    })
  })

  sdkBranchTest('a datasets.has() that throws (older SDK) still lets the search proceed', async () => {
    state.datasetExists = null
    return withOrg(async () => {
      await recallContext({ query: 'revenue', sessionId: 's1' })
      expect(state.searchCalls).toBe(5)
    })
  })

  sdkBranchTest('a non-empty strategy result is returned to the caller', async () => {
    // The other half of the contract: degradation must not swallow memory that
    // DID come back, or a healthy deployment would look like a broken one.
    // Driven through mock STATE (not by monkey-patching the cached client, which
    // leaked the patched method into every later case and produced a phantom
    // "graph says: revenue was Rp 5m" in four unrelated tests).
    state.search = 'ok'
    return withOrg(async () => {
      // MEASURED shape: the three graph strategies each return the same text, which
      // recallFromGraph dedupes to one copy, and the session leg returns its own
      // copy -- so the merged answer is the text twice, newline-joined. Asserting a
      // single copy would have been a wrong expectation about working code.
      const out = await recallContext({ query: 'revenue', sessionId: 's1' })
      expect(out).toBe('cognee remembers: revenue was Rp 5m\ncognee remembers: revenue was Rp 5m')
      expect(out).toContain('cognee remembers')
    })
  })
})

describe('failure mode 4 -- the remember write throws', () => {
  sdkBranchTest('a throwing remember() is swallowed, so the call site cannot reject', async () => {
    state.rememberThrows = true
    return withOrg(async () => {
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
      // The write was genuinely attempted and failed -- this is not the "disabled,
      // never called" path wearing the same assertion.
      expect(state.rememberCalls).toBe(1)
    })
  })

  test('a failing write does not poison recall for the same turn', async () => {
    state.rememberThrows = true
    return withOrg(async () => {
      await rememberChatTurn(TURN)
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
    })
  })
})

// ===========================================================================
// 5 -- no LLM config for this org
// ===========================================================================

describe('failure mode 5 -- the org has no LLM config', () => {
  test("a null runtime config does not make recall throw; it still returns ''", async () => {
    state.llm = null
    return withOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
    })
  })

  test('remember does not throw with no LLM config', async () => {
    state.llm = null
    return withOrg(async () => {
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
    })
  })

  test("health reports enabled but NOT connected when the backend cannot be reached", async () => {
    // Same assertion as before, different reason to be unreachable: no server is
    // configured, so there is no client to build and nothing to probe. The point of
    // the test is that health tells an admin "on, but not working" rather than
    // reporting either "off" or "fine".
    state.llm = null
    return withOrg(async () => {
      expect(await cogneeHealth()).toEqual({
        enabled: true,
        connected: false,
        mode: 'disabled',
        serverVersion: null,
      })
    })
  })

  test('postgres mode with no DB URL stored fails closed, not open', async () => {
    // The one init path that throws our OWN error. It must land in the same catch
    // as an SDK crash: no client, empty recall, no attempt to dial out.
    state.appConfig = { id: 'cfg-1', cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: null }
    delete process.env.COGNEE_DB_URL
    return withOrg(async () => {
      await expect(getCogneeClient()).resolves.toBeNull()
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
      expect(state.constructCalls).toBe(0)
    })
  })})

// ===========================================================================
// 6 -- no org context at all
// ===========================================================================

describe('failure mode 6 -- no org context', () => {
  test('getCogneeClient() returns null and never constructs a client', async () => {
    await withoutOrg(async () => {
      expect(await getCogneeClient()).toBeNull()
      // Not merely "returns null": nothing may be built, because a client created
      // outside a tenant would use the shared store directory (and, in postgres
      // mode, the shared dataset).
      expect(state.constructCalls).toBe(0)
    })
  })

  test('a background worker that forgot enterWithOrg gets a no-op, not a crash', async () => {
    await withoutOrg(async () => {
      await expect(recallContext({ query: 'revenue', sessionId: 's1' })).resolves.toBe('')
      await expect(rememberChatTurn(TURN)).resolves.toBeUndefined()
      expect(state.searchCalls).toBe(0)
      expect(state.rememberCalls).toBe(0)
    })
  })

  sdkBranchTest('no org context is NOT a cross-tenant read: the same calls DO reach the SDK with an org', async () => {
    // Positive control. Without it the two assertions above would pass just as
    // happily if the whole memory layer were permanently dead.
    await withOrg(async () => {
      await recallContext({ query: 'revenue', sessionId: 's1' })
    })
    const callsWithOrg = state.searchCalls
    expect(callsWithOrg).toBe(5)

    await withoutOrg(async () => {
      await recallContext({ query: 'revenue', sessionId: 's1' })
      await rememberChatTurn(TURN)
    })
    expect(state.searchCalls).toBe(callsWithOrg)
    expect(state.rememberCalls).toBe(0)
  })

  test('no org context reports disabled health instead of borrowing a neighbour config', async () => {
    // Even with the env var shouting "true" and an AppConfig row present, the
    // fail-closed rule wins: nobody has opted in for this (absent) tenant.
    process.env.COGNEE_ENABLED = 'true'
    await withoutOrg(async () => {
      expect(await cogneeHealth()).toEqual({ enabled: false, connected: false, mode: 'disabled', serverVersion: null })
    })
  })
})

// ===========================================================================
// Cross-org isolation when the SDK is broken
// ===========================================================================
//
// Separate from the seven numbered modes above: this is not "cognee is down", it
// is "cognee is down for one org, and the next org must not inherit that".
//
// The client cache (`_clients`) and the settings cache (`_settingsCache`) are both
// keyed by `getOrgContext()` and hold a NEGATIVE result for 30s after a failed
// init. The question this block answers is what that negative entry does when the
// tenant changes: a per-org key is only an isolation boundary if a failure under
// org A cannot suppress memory for org B.
//
// This is worth a test rather than a comment because the symptom is
// indistinguishable from "this tenant has no memory yet" -- a silent empty recall
// -- so it would be debugged as a recall-quality problem, not as a cache bug.

describe('tenant isolation under SDK failure', () => {
  const ORG_A = 'org-scope-a'
  const ORG_B = 'org-scope-b'

  /** Outside the request context, on purpose -- this test models the runner frame. */
  const outsideAnyContext = <T,>(fn: () => T): T => fn()

  sdkBranchTest('after a failed init, a SIBLING org still reaches the SDK on its first call', async () => {
    state.constructThrows = true
    // Org A pays for the SDK crash.
    enterWithOrg(ORG_A)
    resetForBody()
    expect(await recallContext({ query: 'a', sessionId: 's1' })).toBe('')
    expect(state.constructCalls).toBe(1)

    // ...and the failure is then cleared OUTSIDE any org context, the way a
    // test hook, a reset endpoint or a module-eval frame would clear it.
    outsideAnyContext(() => {
      resetClientCache('all')
      invalidateCogneeSettings('all')
    })

    // Org B is healthy from here on: the crash was org A's.
    state.constructThrows = false
    enterWithOrg(ORG_B)
    const callsBefore = state.searchCalls
    await recallContext({ query: 'b', sessionId: 's1' })

    // The memory layer must not carry one tenant's failed init into another's
    // request. If this fails, org B's first turn silently loses memory.
    expect(state.searchCalls - callsBefore).toBe(5)
  }, 5000)
})

// ===========================================================================
// 7 -- timeout / hang -- REAL FINDING, documented rather than papered over
// ===========================================================================

describe('failure mode 7 -- a memory call that never settles', () => {
  sdkBranchTest('FINDING: a hung search is bounded only by the CALLER, never by the memory layer', async () => {
    // MEASURED, not assumed: grepping 'timeout' across the whole cognee module
    // finds exactly one hit -- a `setTimeout` sleep in cognee-knowledge-graph.ts.
    // There is no AbortSignal, no Promise.race and no per-call deadline in
    // cognee-core.ts or cognee-memory.ts, so a search that never settles keeps
    // the caller waiting forever. This test pins TODAY'S behaviour honestly; it
    // is not a claim that the layer bounds itself, and it must be rewritten if a
    // deadline is added.
    state.search = 'hang'
    return withOrg(async () => {
      // Recall is where the cost lands: tool-router.ts puts it in a Promise.all
      // for the chat turn, and planner.ts awaits it with no catch and no race. A
      // rejection would at least be swallowed by the `.catch(() => '')` guard
      // there -- a hang has no guard at all.
      // `within()` rejects on timeout, which IS the finding: the caller's own
      // deadline is the only thing that ends the wait.
      await expect(within(recallContext({ query: 'revenue', sessionId: 's1' }), 150, 'recallContext'))
        .rejects.toThrow('recallContext did not settle within 150ms')
    })
  }, 5000)

  sdkBranchTest('the hang does not reject, so a caller cannot catch its way out', async () => {
    state.search = 'hang'
    return withOrg(async () => {
      let settled: 'pending' | 'resolved' | 'rejected' = 'pending'
      const p = recallContext({ query: 'revenue', sessionId: 's1' }).then(
        () => { settled = 'resolved' },
        () => { settled = 'rejected' },
      )
      await new Promise((r) => setTimeout(r, 150))
      expect(settled).toBe('pending')
      // Left pending deliberately -- awaiting it would hang this file. That leak
      // is the finding; the promise is unreachable once the turn is abandoned.
      void p
    })
  }, 5000)

  sdkBranchTest('FINDING: a hung remember is unbounded too, even though the SDK call sits inside a try', async () => {
    // The try/catch in rememberChatTurn catches THROWS only. tool-router.ts awaits
    // this call AFTER computing the answer, so a hung SDK stalls a non-streaming
    // response that already had its answer ready. (send/route.ts is safe here: it
    // uses `void`, so only the background write is stranded.)
    state.rememberHang = true
    return withOrg(async () => {
      await expect(within(rememberChatTurn(TURN), 150, 'rememberChatTurn'))
        .rejects.toThrow('rememberChatTurn did not settle within 150ms')
      // The write WAS attempted and simply never finished -- this is not the
      // "disabled, never called" path.
      expect(state.rememberCalls).toBe(1)
    })
  }, 5000)
})
