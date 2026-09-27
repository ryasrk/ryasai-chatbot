import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The card must never claim a document is still processing once the server says otherwise.
 *
 * INCIDENT (user-reported, 2026-09-27): "kenapa processing sangat lamaaa" on a document whose row read
 * `status = ready`, `cognifyStatus = completed`, with 4 chunks and an empty `cognifyError`. Nothing was
 * running — the card was showing a stale optimistic value.
 *
 * Two causes, both fixed here:
 *
 *   1. The card scheduled EXACTLY ONE refresh, 8 seconds after a reprocess. Cognify measures 45-148s on
 *      this deployment, so that single look always landed mid-job and the card kept "processing"
 *      indefinitely. It now polls until the state is TERMINAL.
 *   2. The list was fetched once on mount and never again, so an upload from another tab, or a job that
 *      finished while the view was open, could never update the screen.
 *
 * Asserting on the SOURCE rather than rendering, because the defect is about control flow (when does
 * polling stop) and a render of a static prop cannot observe a timer that never fires.
 */
/*
 * RENAMED FROM `.tsx` SO IT ACTUALLY RUNS.
 *
 * MEASURED: `scripts/test.ts` collects `{src,benchmark}/**\/*.test.ts`, and that glob does not match
 * `.test.tsx`. This file (and `cognee-diagnostics-render.test.tsx`) were therefore absent from the
 * runner's file set — they had NEVER RUN IN CI. A test the runner cannot see is worse than no test,
 * because it reports safety. This file contains no JSX, so the extension was the only obstacle.
 *
 * The assertions below are still SOURCE-level, and two of them were negative-controlled this session:
 * the ceiling and terminal-state guards do fail when their defect is planted. Where an assertion could
 * not be made to fail (`null counts as UNSETTLED`), it has been rewritten to read the actual rule and the
 * polling CONSEQUENCE is asserted by request count in `doc-card-polling.test.ts`.
 */
const src = readFileSync(join(import.meta.dir, 'doc-card.tsx'), 'utf-8')
const viewSrc = readFileSync(join(import.meta.dir, '..', 'knowledge-base-view.tsx'), 'utf-8')

/** Comments stripped: the fix's own notes quote the old 8s timer and the word "processing". */
const code = src
  .split('\n')
  .map((l) => {
    const t = l.trimStart()
    return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l
  })
  .join('\n')

describe('doc card — polling must continue until the state is terminal', () => {
  test('the poll interval constant is what schedules every tick', () => {
    // A STRING SEARCH FOR '8_000' WAS USELESS HERE, and this test replaces it. The first version asserted
    // `not.toContain('8_000)')`; restoring the defect as `setTimeout(pollOnce, 8_000)` — no closing paren
    // after the literal — left the suite at 10 pass / 0 fail. The guard could not fail for the bug it was
    // written for, which is worse than no guard because it reports safety.
    //
    // So it checks the STRUCTURE instead: the only reschedule must pass the named interval constant. A
    // hardcoded delay fails this regardless of how it is spelled, and the constant is also what makes the
    // interval legible in one place.
    const reschedules = [...code.matchAll(/setTimeout\(pollOnce,\s*([^)]+)\)/g)].map((m) => m[1]!.trim())
    // TWO sites by design: the first tick, and the loop's continue-branch. Both must use the named
    // constant — a hardcoded delay at EITHER site fails this, however it is spelled.
    expect(reschedules.length).toBeGreaterThanOrEqual(1)
    for (const delay of reschedules) expect(delay).toBe('POLL_INTERVAL_MS')
    // And the chain must not be started twice: a  next to the first timeout would run
    // two independent chains, each polling the same document.
    expect(code).not.toMatch(/void pollOnce\(\)/)
  })

  test('the poll reschedules itself while the state is unsettled', () => {
    // A self-rescheduling chain is what makes this a poll rather than a single look.
    expect(code).toMatch(/setTimeout\(pollOnce,\s*POLL_INTERVAL_MS\)/)
  })

  test('it stops at a TERMINAL state, not after a fixed number of looks', () => {
    /*
     * ANCHORED ON THE INVOCATION PLUS THE `return` IT GUARDS, not on the inline comparison.
     *
     * The old expectation was `/next\.cognifyStatus === 'completed' \|\| next\.cognifyStatus === 'failed'/`
     * — it pinned ONE SPELLING of the terminal rule rather than the behaviour, so centralising that rule
     * into the exported `isCognifySettled()` predicate broke the assertion while the polling was still
     * correct. Text that merely restates the implementation cannot survive the implementation moving,
     * which is the same failure mode this file already documents for `8_000)`.
     *
     * The rule's TRUTH TABLE is asserted behaviourally, and negative-controlled, in
     * `doc-card-polling.test.ts`. What is checked here is that the loop USES it and actually stops.
     */
    expect(code).toMatch(/if \(isCognifySettled\(next\.cognifyStatus\)\) \{[\s\S]{0,200}?return/)
  })

  test('the poll is bounded, so a job that never settles cannot spin forever', () => {
    expect(code).toMatch(/POLL_CEILING_MS/)
    expect(code).toMatch(/Date\.now\(\) - startedAt < POLL_CEILING_MS/)
  })

  test('null counts as UNSETTLED, so a row with no status yet keeps polling', () => {
    /*
     * REWRITTEN AFTER A NEGATIVE CONTROL SHOWED IT PROVED NOTHING.
     *
     * It used to slice the source from `const cognifySettled` and demand the two terminal comparisons be
     * present in that slice. Adding `|| status === null` to the terminal rule — the exact defect the test
     * names in its own title — left the suite at 10 pass / 0 fail. The slice began at the RENDER call
     * site, but the rule had since been extracted into `isCognifySettled`, so the assertions were
     * checking a region that could not contain what they claimed to guard. Third-recurrence of the
     * weakness this file's header already documents for `8_000)`.
     *
     * The TRUTH TABLE is now asserted on the real predicate, and the POLLING CONSEQUENCE is asserted by
     * request count in `doc-card-polling.test.ts` ("a NULL status keeps the poll going") — where planting
     * `|| status === null` produces 1 fail. This assertion stays here only as a fast, local statement of
     * the invariant.
     */
    const rule = code.slice(code.indexOf('export function isCognifySettled'))
    const body = rule.slice(0, rule.indexOf('\n}'))
    expect(body).toContain("=== 'completed'")
    expect(body).toContain("=== 'failed'")
    // A null check must NOT be part of the terminal rule.
    expect(body).not.toMatch(/=== null/)
    expect(body).not.toMatch(/!\s*status/)
  })
})

describe('doc card — the label must explain the wait', () => {
  test('elapsed time is shown once the wait is long enough to need explaining', () => {
    // "processing" with no scale is what produced the complaint. 20s is past the short end of the
    // measured 45-148s range.
    expect(code).toMatch(/elapsed >= 20/)
    expect(code).toMatch(/Building graph/)
  })

  test('a completed document says Graph, not a raw status word', () => {
    expect(code).toMatch(/'completed'\s*\?\s*'Graph'/)
  })
})

describe('knowledge view — the list must refresh while anything is pending', () => {
  test('an interval polls the list', () => {
    expect(viewSrc).toMatch(/setInterval\(\(\) => \{/)
  })

  test('polling is conditional on something actually being pending', () => {
    // Polling always would be a battery drain and a needless request stream on a settled list.
    expect(viewSrc).toMatch(/if \(!anyPending\) return/)
  })

  test('the list poll is bounded too', () => {
    expect(viewSrc).toMatch(/POLL_CEILING_MS/)
  })
})
