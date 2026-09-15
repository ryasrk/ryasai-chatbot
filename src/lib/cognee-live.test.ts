/**
 * Cognee LIVE integration test — proves the real `@cognee/cognee-ts` memory layer
 * actually works, end to end, against a reachable backend.
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * The only other cognee end-to-end test, `cognee.e2e.test.ts`, is gated on
 * `RUN_COGNEE_E2E` and is therefore never executed by any script in this repo —
 * `bun run test` skips it, CI never sets the flag, and its 15-Wikipedia-article
 * fixture needs a 600s budget and downloaded corpus. Meanwhile the unit suites
 * (`cognee.test.ts`, `cognee-memory.test.ts`, `cognee-core.test.ts`) mock the SDK
 * out entirely, so an incompatible `@cognee/cognee-ts` upgrade, a renamed search
 * strategy, a dataset name the SDK rejects, or a `remember`/`recall` pair that
 * simply never round-trips would leave every test green. The integration was
 * unverified in both directions: too slow to run by accident, never run on
 * purpose.
 *
 * WHAT IT PROVES
 * One fact is written through the production wrapper (`rememberChatTurn`) under a
 * unique, run-scoped token, and must come back out of `recallContext` — the same
 * prompt-ready string the router and planner consume. It also proves recall is
 * ORG-level, not session-level (memory is written on one session id and read on
 * another), and that `cogneeHealth()` reports the layer enabled and connected.
 *
 * HOW TO RUN IT
 *   RUN_COGNEE_LIVE=true bun test ./src/lib/cognee-live.test.ts
 * Skipped by default, so CI stays green with no cognee backend. When the flag IS
 * set the test fails LOUDLY (never silently passes) if the client cannot be built;
 * a silent pass here would be the exact "unverified integration" bug this file
 * exists to catch.
 *
 * REQUIREMENTS when opting in
 *   - live Postgres via `DATABASE_URL`
 *   - a `LlmConfig` row for the org (also the embedding config source), and an
 *     `AppConfig` row with cognee enabled
 *   - reachable LLM + embedding endpoints
 *
 * COST: the assertion cannot pass from leftover data — see LIVE_TOKEN below.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { enterWithOrg } from '@/lib/prisma-tenant'

// The opt-in flag and the isolation env, set at module scope — BEFORE the imports
// below are evaluated. `cognee-core` captures no env at import time today, but the
// data/system dirs are read per client init and we must own them rather than
// writing into whatever `.cognee/` an installed instance already uses.
const LIVE_ENABLED = process.env.RUN_COGNEE_LIVE === 'true'

const DIR_SUFFIX = `cognee-live-${Date.now()}`
const LIVE_DATA_DIR = process.env.COGNEE_LIVE_DATA_DIR ?? join('.cognee-live', DIR_SUFFIX)

if (LIVE_ENABLED) {
  process.env.COGNEE_DATA_DIR = join(LIVE_DATA_DIR, 'data')
  process.env.COGNEE_SYSTEM_DIR = join(LIVE_DATA_DIR, 'system')

  // A live test normally talks to a local LLM/embedding endpoint, and this
  // codebase's SSRF blocklist rejects private hosts unless an operator names them.
  // Appending (never replacing) keeps a developer's own allowlist intact. Local
  // names are distinct from the production case: they cannot open a whole private
  // range, and an absolute URL still bypasses the allowlist entirely.
  const hosts = (process.env.LLM_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  for (const local of ['localhost', '127.0.0.1']) {
    if (!hosts.includes(local)) hosts.push(local)
  }
  process.env.LLM_ALLOWED_HOSTS = hosts.join(',')
}

import { db } from '@/lib/db'
import { forgetAll, recallContext, rememberChatTurn, cogneeHealth } from '@/lib/cognee'
import { getCogneeClient } from '@/lib/cognee-core'

// `describe.skip` when not opted in, mirroring the RUN_COGNEE_E2E gate in
// cognee.e2e.test.ts: the file must be inert in CI without a cognee backend.
const maybeDescribe = LIVE_ENABLED ? describe : describe.skip

// How long the remember pipeline may take before the assertion is declared failed.
// cognee runs an LLM extraction pass per ingest (measured ~13s on a local model
// before the first recall hit) so this is a deadline, not a sleep.
const RECALL_DEADLINE_MS = 45_000
const RECALL_POLL_INTERVAL_MS = 2_000
// One client build is allowed to be slow (SDK load + DB/vector-store warm-up).
const CLIENT_SETUP_TIMEOUT_MS = 180_000

// Unique per run: the token appears nowhere else, so a recall hit proves THIS
// write landed rather than a previous run's leftover data being re-read.
const LIVE_TOKEN = `ZEBRA-${Date.now()}`
const LIVE_SESSION_ID = `cognee-live-session-${Date.now()}`
// A DIFFERENT session id. Memory is dataset-scoped per ORG (`org:<id>`), so this
// must still recall; if it does not, recall has silently become session-bound.
const OTHER_SESSION_ID = `cognee-live-other-${Date.now()}`

const CLEANUP_TIMEOUT_MS = 120_000

/**
 * Poll until recall surfaces `needle`, or the deadline expires.
 *
 * WHY POLLING AND NOT A FIXED SLEEP: `rememberChatTurn` is fire-and-forget and the
 * require/cognify pipeline that makes the fact searchable runs asynchronously, so
 * the time to first recall is a property of the backend and the model, not of this
 * test. A fixed sleep is simultaneously too short on a slow model (flake) and
 * wasted wall-clock on a fast one. Polling returns as soon as the fact is
 * recallable and only spends the full deadline when it genuinely never appears.
 */
async function pollRecall(
  query: string,
  sessionId: string,
  needle: string,
): Promise<string> {
  const deadline = Date.now() + RECALL_DEADLINE_MS
  let last = ''
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    // A fresh session id per attempt: the SDK keeps a short-lived in-process
    // session recall cache, and a cached EMPTY string would be indistinguishable
    // from "not written yet", masking the write for its whole TTL.
    last = (await recallContext({ query, sessionId })).trim()
    if (last.includes(needle)) return last
    if (Date.now() + RECALL_POLL_INTERVAL_MS < deadline) {
      await new Promise((resolve) => setTimeout(resolve, RECALL_POLL_INTERVAL_MS))
    }
  }
  throw new Error(
    `recallContext did not surface the stored fact within ${RECALL_DEADLINE_MS / 1000}s ` +
      `(${attempts} attempts). Last recall returned ${last.length} chars: ` +
      `${last.slice(0, 300) || '<empty>'}`,
  )
}

/**
 * List the cognee dataset names that belong to `orgId`, straight through the SDK.
 *
 * `recallContext()` cannot be used for the post-delete check: it degrades to '' on
 * ANY error (including "dataset not found") and then retries WITHOUT a dataset
 * filter, so it cannot distinguish "the dataset is gone" from "the backend is
 * down" — and a test that cannot tell those apart passes for the wrong reason.
 * Reading the dataset list directly reports the difference.
 */
async function orgDatasets(orgId: string): Promise<string[]> {
  const names = await withOrg(orgId, async () => {
    const client = await getCogneeClient()
    if (!client) throw new Error('getCogneeClient() returned null during cleanup verification.')
    const datasets = (await client.datasets.list()) as Array<{ name: string }>
    return datasets.map((d) => d.name)
  })
  // The live run's dataset name is `org:<orgId>` (datasetFor() in cognee-types.ts).
  return names.filter((name) => name === `org:${orgId}` || name.startsWith(`org:${orgId}:`))
}

/**
 * Enter the org inside the CALLING frame and hand back the frame.
 *
 * INCIDENT (Bun 1.4.2): `AsyncLocalStorage.enterWith()` called in a `beforeEach`
 * does not reach the test body — not even a synchronous one — so the org context
 * is gone by the time the body runs and every cognee entry point degrades to a
 * no-op (`getCogneeSettings()` returns DISABLED_SETTINGS without an org, and
 * `getCogneeClient()` returns null). Calling it in the test body works on every
 * Bun version we run. This mirrors `withOrg` in `knowledge-graph.test.ts`, and
 * `cognee.test.ts` documents the same trap.
 */
function withOrg<T>(orgId: string, body: () => Promise<T>): Promise<T> {
  enterWithOrg(orgId)
  return body()
}

/**
 * Resolve the org under test the same way the live system does.
 *
 * The read runs through `bypassOrg` because it happens BEFORE any org context
 * exists — which is also why it cannot leak the way `getEmbeddingRuntimeConfig()`
 * once could (its comment records a cross-tenant credential leak from a
 * context-free `findFirst`). This is a setup read of one column, not a caller's
 * request path.
 *
 * `LIVE_ORG_ID` wins when set, so a deployment with several orgs can name the one
 * whose LLM config + cognee toggle are real.
 */
async function resolveLiveOrgId(): Promise<string | undefined> {
  const configured = process.env.LIVE_ORG_ID?.trim()
  if (configured) return configured
  const { bypassOrg } = await import('@/lib/prisma-tenant')
  const row = await bypassOrg(() =>
    db.organization.findFirst({
      where: { appConfigs: { some: { cogneeEnabled: true } } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }),
  )
  if (row) return row.id
  // No appConfig row = nothing has opted in, but `COGNEE_ENABLED=true` is the
  // process-wide fallback inside `getCogneeSettings()`. Any org will do then.
  const any = await bypassOrg(() =>
    db.organization.findFirst({ select: { id: true }, orderBy: { createdAt: 'asc' } }),
  )
  return any?.id
}

// Resolved by the first test, then shared by the rest. It lives at module scope
// because the live tests are intentionally ORDERED (write before cross-session
// recall before delete) and each body must enter its own org context — a
// hook-entered context is discarded under Bun 1.4.2 (see `withOrg` above), so a
// `beforeAll` could not publish an org to the bodies anyway.
let liveOrgId: string | undefined

maybeDescribe('cognee live — real @cognee/cognee-ts store/recall round-trip', () => {
  test(
    'health reports enabled + connected while the live flag is set',
    async () => {
      const org = await resolveLiveOrgId()
      if (!org) {
        throw new Error(
          'RUN_COGNEE_LIVE=true but no organization exists in DATABASE_URL. ' +
            'Create/seed an org, or set LIVE_ORG_ID explicitly.',
        )
      }
      liveOrgId = org

      const health = await withOrg(org, () => cogneeHealth())

      // cogneeHealth() only reports `enabled: false` when the org's settings say
      // so. The flag being set is not enough — the AppConfig row must have
      // cogneeEnabled=true (or COGNEE_ENABLED=true as the process fallback), and
      // saying that out loud here beats debugging a silent no-op in the tests below.
      if (!health.enabled) {
        throw new Error(
          `RUN_COGNEE_LIVE=true but cognee is disabled for org ${org}. Enable it in ` +
            'Settings (AppConfig.cogneeEnabled) or set COGNEE_ENABLED=true.',
        )
      }
      expect(health.enabled).toBe(true)

      // The DECISIVE pairing, and the reason health alone is not enough: `enabled`
      // comes from settings and stays true even when every SDK call fails, while
      // `connected` reflects a client that actually built (warm-up included). A
      // backwards-incompatible @cognee/cognee-ts upgrade — exactly what the mocked
      // unit suites cannot see — fails here.
      expect(health.connected).toBe(true)
      expect(['local', 'postgres']).toContain(health.mode)
    },
    CLIENT_SETUP_TIMEOUT_MS,
  )

  test(
    'a stored fact is recalled (unique token, org-scoped memory)',
    async () => {
      if (!liveOrgId) throw new Error('No live org resolved — the health test did not run.')
      const org = liveOrgId

      await withOrg(org, async () => {
        const client = await getCogneeClient()
        if (!client) {
          // FAIL LOUDLY, by design. When the opt-in flag is set, a client that
          // cannot be built is a real failure: a silently skipped/passed test here
          // would reproduce the very "integration was never verified" problem this
          // file exists to remove.
          throw new Error(
            'getCogneeClient() returned null for org ' +
              `${org} even though RUN_COGNEE_LIVE=true. The cognee SDK could not be ` +
              'initialised (its own warning above has the cause). Common causes: ' +
              '@cognee/cognee-ts is not installed, no LlmConfig row for the org, or ' +
              'the configured LLM/embedding base URL is unreachable or blocked.',
          )
        }

        await rememberChatTurn({
          sessionId: LIVE_SESSION_ID,
          // The fact is stated in prose with an unguessable token embedded, so a
          // recall hit can only come from this write.
          userMessage:
            `Remember this internal reference for the next question: the unique ` +
            `identifier of the project is ${LIVE_TOKEN}.`,
          aiMessage: `Noted — the project identifier is ${LIVE_TOKEN}.`,
          toolRuns: [],
        })

        const recalled = await pollRecall(LIVE_TOKEN, `${LIVE_SESSION_ID}-poll`, LIVE_TOKEN)

        expect(typeof recalled).toBe('string')
        expect(recalled.length).toBeGreaterThan(0)
        expect(recalled).toContain(LIVE_TOKEN)
      })
    },
    RECALL_DEADLINE_MS + CLIENT_SETUP_TIMEOUT_MS,
  )

  test(
    'a different session id still recalls — memory is org-level, not session-bound',
    async () => {
      if (!liveOrgId) throw new Error('No live org resolved — the health test did not run.')
      const org = liveOrgId

      await withOrg(org, async () => {
        // Same fact, a session id that has never written anything. If this fails
        // while the test above passes, recall has been narrowed to per-session
        // storage — which would silently make cross-session memory (the whole point
        // of the layer) a no-op in production, with no error anywhere.
        const recalled = await pollRecall(LIVE_TOKEN, OTHER_SESSION_ID, LIVE_TOKEN)

        expect(recalled).toContain(LIVE_TOKEN)
      })
    },
    RECALL_DEADLINE_MS,
  )

  test(
    'forgetAll drops the org memory the two tests above relied on',
    async () => {
      if (!liveOrgId) throw new Error('No live org resolved — the health test did not run.')
      const org = liveOrgId

      // Precondition, stated as an assertion rather than assumed: the fact is
      // recallable BEFORE the delete. Without it this test would pass on an
      // already-empty memory and prove nothing.
      const before = await withOrg(org, () => recallContext({ query: LIVE_TOKEN, sessionId: `${OTHER_SESSION_ID}-pre` }))
      expect(before).toContain(LIVE_TOKEN)

      // `forgetAll()` runs in the test BODY, not in `afterAll`: a hook-entered org
      // context does not reach the SDK call on Bun 1.4.2 (see `withOrg` above), so a
      // hook that tried this would silently no-op and leave the fact behind. It is a
      // test and not a hook so a failure is REPORTED rather than swallowed.
      await withOrg(org, async () => {
        // forgetAll() contains its own catch and RETURNS FALSE rather than throwing,
        // so a bare `await forgetAll()` cannot fail this test — the return value is
        // the only signal that the SDK call did not error.
        const ok = await forgetAll()
        expect(ok).toBe(true)
      })

      // `forgetAll()` issues a cognee SOFT delete: the dataset record disappears
      // (verified: `datasets.list()` is empty straight after) and every subsequent
      // search for that dataset fails with "dataset not found", but at least one
      // session-indexed copy of the original text can still be returned by a plain
      // no-dataset search. So the honest assertion is the DISAPPEARANCE OF THE
      // DATASET — the thing the delete actually does and the isolation boundary
      // that matters — not "the token is nowhere in any string". Asserting the
      // latter fails against a healthy backend and would have to be deleted, which
      // is how a guard gets removed for being flaky.
      const after = await orgDatasets(org)
      expect(after).toEqual([])
    },
    CLEANUP_TIMEOUT_MS,
  )
})

// Deliberately does NOT touch cognee or the DB. It runs inside a hook frame,
// where `withOrg`'s `enterWith` does not reach the SDK call on Bun 1.4.2, so
// anything org-scoped here would silently no-op. A throwaway FILE tree, however,
// needs no org context — and the contract this file installs is that it never
// leaves data behind, including in the public `org:<id>` dataset that the write
// test above really does populate (the cleanup test deletes it).
afterAll(() => {
  if (!LIVE_ENABLED) return
  try {
    rmSync(LIVE_DATA_DIR, { recursive: true, force: true })
  } catch {
    // A leftover directory is not worth failing the run for.
  }
})
