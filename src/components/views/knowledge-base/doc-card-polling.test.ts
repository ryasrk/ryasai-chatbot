/**
 * Behavioural guards for the document card's reprocess poll.
 *
 * WHY THIS FILE EXISTS AT ALL, and why it is a `.test.ts` rather than a `.test.tsx`:
 *
 *   1. `doc-card-status.test.ts` (renamed from `.tsx`; see the note in its header) asserted control flow by
 *      REGEX over the source. That is weak in exactly
 *      the way this repo keeps re-learning — a guard can be satisfied by a nearby word rather than by the
 *      behaviour. Two of its assertions were confirmed VACUOUS by negative control: planting the defect
 *      each claimed to catch left the suite at 10 pass / 0 fail. Details on each rewritten assertion are
 *      in that file.
 *
 *   2. `scripts/test.ts` collects `{src,benchmark}/**\/*.test.ts` — the glob does NOT match `.test.tsx`.
 *      MEASURED: the two component tests that existed as `.test.tsx` were both absent from the runner's
 *      file set, so NEITHER HAD EVER RUN IN CI. That file has since been RENAMED to `.test.ts` (it uses
 *      no JSX, so the extension was the only obstacle) and now runs; `cognee-diagnostics-render.test.tsx`
 *      is in the cognee-card area, outside this file's scope. A test file that the runner
 *      cannot see is strictly worse than no test file, because it reports safety. This file uses
 *      `React.createElement` (no JSX) precisely so it can live under the collected extension.
 *
 * WHAT IS ASSERTED: the lifecycle, driven for real — mount, click, advance a mocked clock, unmount — with
 * `fetch` counted. Not "does the source contain `clearTimeout`", but "after unmount, are any more requests
 * sent". Each guard here was negative-controlled; the observed numbers are recorded beside it.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { DocCard } from './doc-card'
import type { DocumentItem } from '@/lib/types'

/* ---------------------------------------------------------------- DOM harness */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.navigator = dom.window.navigator
// React logs a warning and skips act() batching without this.
g.IS_REACT_ACT_ENVIRONMENT = true

const act = (React as unknown as { act: (cb: () => void | Promise<void>) => Promise<void> }).act
const el = () => dom.window.document.getElementById('root')!

/** A failed document — the only state the Retry button renders in. */
function failedDoc(): DocumentItem {
  return {
    id: 'doc-1',
    name: 'laporan.pdf',
    type: 'pdf',
    sizeBytes: 1024,
    mimeType: 'application/pdf',
    status: 'error',
    category: null,
    description: null,
    cognifyStatus: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    chunkCount: 0,
    isEnabled: true,
  }
}

interface Sent {
  reprocess: number
  detail: number
}

let sent: Sent
let root: Root | null
let realFetch: typeof globalThis.fetch

/** Resolve control for the NEXT detail GET, so a request can be held in flight across an unmount. */
let holdDetail: { promise: Promise<Response>; release: (r: Response) => void } | null = null

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Install a counting `fetch`.
 *
 * `detailStatus` is the `cognifyStatus` every detail GET reports, so a test can decide when the job
 * looks finished. Note the reprocess POST deliberately returns 200 with a body — the 409/404 paths are
 * covered separately.
 */
function installFetch(detailStatus: string | null, opts?: { holdFirstDetail?: boolean }) {
  sent = { reprocess: 0, detail: 0 }
  g.fetch = async (input: unknown): Promise<Response> => {
    const url = String(input)
    if (url.endsWith('/reprocess')) {
      sent.reprocess++
      return json({ ok: true, mode: 'queued' })
    }
    sent.detail++
    if (opts?.holdFirstDetail && sent.detail === 1 && holdDetail) return holdDetail.promise
    return json({ document: { status: 'ready', cognifyStatus: detailStatus } })
  }
}

function deferredResponse() {
  let release!: (r: Response) => void
  const promise = new Promise<Response>((res) => {
    release = res
  })
  holdDetail = { promise, release }
}

/** Mount the card and return its root element. */
async function mount(doc: DocumentItem = failedDoc()): Promise<HTMLElement> {
  root = createRoot(el())
  await act(async () => {
    root!.render(
      React.createElement(DocCard, {
        doc,
        onDetail: () => {},
        onDelete: () => {},
        onToggle: () => {},
      }),
    )
  })
  return el()
}

function retryButton(host: HTMLElement): HTMLButtonElement {
  const btn = Array.from(host.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('Retry'),
  )
  if (!btn) throw new Error('Retry button not rendered — the card is not in a failed state')
  return btn as HTMLButtonElement
}

/** Click and let the resulting microtasks settle. */
async function click(btn: HTMLElement) {
  await act(async () => {
    btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Advance the mocked clock, letting each due callback's promises settle. */
async function advance(ms: number, stepMs = 5_000) {
  for (let t = 0; t < ms; t += stepMs) {
    await act(async () => {
      jest.advanceTimersByTime(stepMs)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  realFetch = globalThis.fetch
  jest.useFakeTimers()
  holdDetail = null
  root = null
})

afterEach(() => {
  g.fetch = realFetch
  jest.useRealTimers()
  dom.window.document.body.innerHTML = '<div id="root"></div>'
})

/* ---------------------------------------------------------------- the guards */

describe('doc card — the reprocess poll stops', () => {
  test('it keeps polling while the state is unsettled', async () => {
    // The baseline the other two guards are a bound on. Without it, "no more requests after unmount"
    // would pass trivially on a card that never polls at all.
    installFetch('processing')
    const host = await mount()
    await click(retryButton(host))
    await advance(20_000)
    // No tick before the first interval elapses; one every 5s after. 20s → 4 detail GETs.
    expect(sent.detail).toBe(4)
  })

  test('it STOPS after unmount, even with a request in flight', async () => {
    /*
     * The leak this pins. `pollOnce` AWAITS its fetch, so the unmount cleanup can run while a request is
     * suspended. The continuation then re-armed a fresh timer with `pollTimer.current = setTimeout(...)`
     * — AFTER the only handle anyone could clear had already been cleared. The chain became unreachable
     * and kept issuing requests until the ceiling, calling setState on a dead component.
     *
     * THE ADVANCE HERE IS 60s, DELIBERATELY, AND NOT 600s. The first version of this test advanced past
     * the 10-minute ceiling while looking for the leak — which meant the leak could NOT show, because the
     * ceiling branch is a `return` that arms nothing either way. The negative control exposed it: deleting
     * the `alive` guard left this test GREEN. It was passing for a reason unrelated to what it claimed to
     * check, which is the same "assert on the wrong object" failure this repo catalogues. Staying well
     * inside the ceiling makes the only thing that can stop the chain the guard under test.
     *
     * OBSERVED — defect planted (`if (!alive.current) return` deleted from the continuation): 13 detail
     * GETs, i.e. a poll that resumed after unmount and kept going. With the guard: 1.
     */
    installFetch('processing', { holdFirstDetail: true })
    deferredResponse()
    const host = await mount()
    await click(retryButton(host))

    // Start the first poll and leave its fetch unresolved.
    await act(async () => {
      jest.advanceTimersByTime(5_000)
      await Promise.resolve()
    })
    expect(sent.detail).toBe(1)

    // Unmount with that request still open, then let it answer.
    await act(async () => {
      root!.unmount()
      holdDetail!.release(json({ document: { status: 'ready', cognifyStatus: 'processing' } }))
      await Promise.resolve()
      await Promise.resolve()
    })
    const atUnmount = sent.detail

    // 60s — a leaking chain fires every 5s inside this window; a correct one fires never.
    await advance(60_000)
    expect(sent.detail).toBe(atUnmount)
  })

  test('a NULL status keeps the poll going instead of ending it', async () => {
    /*
     * `null` means "the row has no cognify status yet" — a document queued but not yet started. Treating
     * it as terminal is how the card stops looking BEFORE the job it just queued has reported anything,
     * leaving the optimistic "Building graph" on screen with nothing left to correct it.
     *
     * THIS IS THE ASSERTION THE OLD SOURCE-REGEX VERSION CLAIMED TO MAKE AND COULD NOT. Verified by
     * negative control: adding `|| status === null` to `isCognifySettled` left the old test at
     * 10 pass / 0 fail. The slice it read (from `const cognifySettled`) lands in the RENDER code, where
     * the comparison it demanded no longer lives — so it was asserting on a region that could not contain
     * the defect. Here the server reports null and the REQUEST COUNT proves whether polling continued.
     *
     * OBSERVED — defect planted (`isCognifySettled` also returns true for null): silence after the first
     * look. Correct code: 4 detail GETs in 20s.
     */
    installFetch(null)
    const host = await mount()
    await click(retryButton(host))
    await advance(20_000)
    expect(sent.detail).toBe(4)
  })

  test('it stops at a TERMINAL state instead of polling a settled row', async () => {
    // `completed` must end the loop. OBSERVED, defect planted (the terminal branch made unreachable):
    // 1 detail GET at 5s and 121 by the ceiling, instead of exactly 1.
    installFetch('completed')
    const host = await mount()
    await click(retryButton(host))
    await advance(600_000)
    expect(sent.detail).toBe(1)
  })

  test('it stops at the CEILING when the job never settles', async () => {
    /*
     * The other half of "bounded". A job that dies without writing a status must not be polled forever.
     *
     * OBSERVED, defect planted (`Date.now() - startedAt < POLL_CEILING_MS` forced true): the count grows
     * without bound — 121 requests in 10 minutes and still climbing. With the ceiling: 120.
     */
    installFetch('processing')
    const host = await mount()
    await click(retryButton(host))
    await advance(600_000)
    const atCeiling = sent.detail
    expect(atCeiling).toBe(120)

    // And it must stay stopped: another 5 minutes adds nothing.
    await advance(300_000)
    expect(sent.detail).toBe(atCeiling)
  })
})

describe('doc card — a double click is one write', () => {
  test('two clicks in the same tick queue ONE reprocess, not two', async () => {
    /*
     * The guard was `if (retrying) return` against React STATE, which the second click still reads as
     * `false` because no re-render has happened yet. Two queued `document-embed` + `document-cognify`
     * pairs for one document, and two independent poll chains, from one double-click.
     *
     * OBSERVED, defect planted (state check only): 2 reprocess POSTs. With the ref latch: 1.
     */
    installFetch('processing')
    const host = await mount()
    const btn = retryButton(host)
    await act(async () => {
      // Same tick, before React can re-render: the case a state guard cannot see.
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(sent.reprocess).toBe(1)
  })
})

describe('doc card — the optimistic state must not outlive the server answer', () => {
  test('the override is retired when the properties it guessed about change', async () => {
    /*
     * The override used to win over the prop UNCONDITIONALLY, so once the parent list learned the truth
     * this card ignored it. If the card's own poll was dead — ceiling reached, or its handle overwritten
     * by a second Retry — nothing remained to correct the badge.
     *
     * Sequence: a failed doc is reprocessed (badge → "Building graph"), then the LIST refetch reports the
     * job finished. The card must believe the server.
     */
    installFetch('processing')
    const host = await mount()
    await click(retryButton(host))
    await advance(10_000)
    expect(host.textContent).toContain('Building graph')

    // The parent list now knows the job completed.
    await act(async () => {
      root!.render(
        React.createElement(DocCard, {
          doc: { ...failedDoc(), status: 'ready', cognifyStatus: 'completed' },
          onDetail: () => {},
          onDelete: () => {},
          onToggle: () => {},
        }),
      )
      await Promise.resolve()
    })
    expect(host.textContent).toContain('Graph')
    expect(host.textContent).not.toContain('Building graph')
  })

  test('after the ceiling the badge stops claiming a live measurement', async () => {
    /*
     * "Building graph · 600s" after the app has stopped watching reads as a live measurement. The badge
     * must distinguish "still being tracked" from "we gave up", or the original complaint — an endless
     * unexplained "processing" — returns in a new costume.
     *
     * Note the elapsed counter only appears from 20s; at the 600s ceiling it is well past that.
     */
    installFetch('processing')
    const host = await mount()
    await click(retryButton(host))
    await advance(600_000)
    expect(host.textContent).toContain('Graph status unknown')
    expect(host.textContent).not.toContain('Building graph ·')
  })
})

describe('doc card — the status change reaches a screen reader', () => {
  test('a live region carries the cognify state and is present BEFORE it changes', async () => {
    /*
     * The badge mutates on its own for minutes while a user waits, and a `<span>` is not announced. The
     * region must exist in the DOM from the first render — a live region inserted at the same moment as
     * its text is frequently not announced at all — so the FIRST assertion is on the freshly-mounted card,
     * before any click.
     *
     * OBSERVED, defect planted (the `role="status"` element deleted): no live region on mount.
     */
    installFetch('processing')
    const host = await mount()
    const live = host.querySelector('[role="status"][aria-live="polite"]')
    expect(live).not.toBeNull()
    // Present and empty while nothing is happening.
    expect(live!.getAttribute('aria-atomic')).toBe('true')

    await click(retryButton(host))
    expect(host.querySelector('[role="status"][aria-live="polite"]')!.textContent).toBe(
      'Building the knowledge graph.',
    )

    // Once the elapsed counter passes 20s the announcement gains the scale as well as the state.
    await advance(25_000)
    expect(host.querySelector('[role="status"][aria-live="polite"]')!.textContent).toContain(
      'seconds so far',
    )
  })
})

describe('doc card — a refused reprocess is reported, not silently swallowed', () => {
  test('a 409 from the server surfaces and does NOT show optimistic progress', async () => {
    /*
     * The failure path only `console.error`ed. The user saw the button return to idle with no
     * explanation, and — because the override was set only on success — no misleading "processing"
     * either. What was missing was the REPORT.
     *
     * OBSERVED, defect planted (the `toast.error` call replaced by a bare `return`): the card renders
     * exactly as before with no visible change, which is the swallowed-failure behaviour.
     */
    sent = { reprocess: 0, detail: 0 }
    g.fetch = async (input: unknown): Promise<Response> => {
      const url = String(input)
      if (url.endsWith('/reprocess')) {
        sent.reprocess++
        // The REAL shape: the route's refusal is a non-2xx status, which is what `res.ok` reads. A body
        // carrying `error` at HTTP 200 would be a *different* contract and the card would be right to
        // treat it as success.
        return new Response(
          JSON.stringify({
            error: { message: 'Document is not in a failed state.', hint: 'Reload the list.' },
          }),
          { status: 409, headers: { 'content-type': 'application/json' } },
        )
      }
      sent.detail++
      return json({ document: { status: 'ready', cognifyStatus: 'processing' } })
    }
    // Sonner renders toasts through a portal that this harness does not mount, so the assertion is on
    // the CONSEQUENCE that is observable in the card: the optimistic override must not be applied and
    // no poll may start.
    const host = await mount()
    await click(retryButton(host))
    await advance(30_000)
    expect(sent.reprocess).toBe(1)
    expect(sent.detail).toBe(0)
    expect(host.textContent).toContain('Retry Processing')
  })
})
