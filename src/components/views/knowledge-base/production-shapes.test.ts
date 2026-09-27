/**
 * Production-shape smoke tests for the Knowledge + AI Configuration UI.
 *
 * WHAT THIS CATCHES that a typecheck cannot: the real database contains rows that the component
 * contracts still type as valid but that exercise branches a happy-path fixture never reaches. The
 * shapes below are taken from the live install:
 *
 *   - a document WITH `cognifyStatus` set (every one of them, since the cognify column was added) and a
 *     `cognifyError` on the failed ones;
 *   - `availableModels` stored as an EMPTY STRING, which `parseModels()` maps to `[]` — so the picker
 *     must fall back to its free-text Input rather than rendering an empty dropdown;
 *   - `lastModelSyncAt` NULL — the column is only written by a model sync, and the install's chat row
 *     had never been synced;
 *   - a diagnostics payload whose LLM component is `degraded` with provider `unknown`.
 *
 * A render that THROWS or paints nothing is the failure. Asserted by mounting each component in jsdom and
 * requiring identifiable text, rather than by checking that a call did not reject.
 *
 * `.test.ts` with `React.createElement`, not `.test.tsx` with JSX: `scripts/test.ts` collects
 * `{src,benchmark}/**\/*.test.ts` and the glob does NOT match `.test.tsx` — MEASURED: the `.test.tsx` files were absent from the runner's collected file set, so they had never run
 * in CI.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { DocCard } from '@/components/views/knowledge-base/doc-card'
import { MemoryStatusCard } from '@/components/views/memory-status-card'
import { CogneeCard } from '@/components/views/cognee-card'
import { VectorStorePanel } from '@/components/views/knowledge-base/vector-store-panel'
import { versionsOutcome } from '@/components/views/knowledge-base/doc-detail-dialog'
import type { DocumentItem } from '@/lib/types'

/* ---------------------------------------------------------------- DOM harness */

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.navigator = dom.window.navigator
g.IS_REACT_ACT_ENVIRONMENT = true
/*
 * jsdom does not put its DOM constructors on globalThis by default, and Radix's portal, focus-scope and
 * presence primitives call them directly (`getComputedStyle` in react-presence, `MutationObserver` in
 * react-focus-scope). Without these three the DIALOG tests die with a ReferenceError that looks like a
 * component crash. Populated MUTATION-observer and focus-event listeners are also why these tests read
 * `document.body` rather than `#root`: `DialogContent` portals there.
 */
/*
 * COPY EVERYTHING jsdom's window exposes that globalThis is missing.
 *
 * Enumerated one name at a time this is a losing game: Radix's portal/focus/presence primitives reach for
 * `getComputedStyle`, `MutationObserver`, `NodeFilter`, `HTMLInputElement`, `DocumentFragment`,
 * `getSelection` and more, and each missing one throws a ReferenceError that a reader would mistake for
 * a genuine component crash. Mirroring the whole window is the same approach a full jsdom test
 * environment takes; the DOM globals are additive and do not affect the non-DOM tests, which never
 * consult them.
 *
 * Only the DOM window is copied — not `fetch`, `setTimeout` or the timers — so the fake-timer and
 * fetch-mocking behaviour of the other files stays under this file's control.
 */
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in (globalThis as unknown as Record<string, unknown>)) continue
  if (key === 'undefined') continue
  try {
    const value = (dom.window as unknown as Record<string, unknown>)[key]
    if (typeof value === 'function') {
      g[key] = (value as (...a: unknown[]) => unknown).bind(dom.window)
    } else {
      g[key] = value
    }
  } catch {
    // A few window properties are getters that throw outside a browsing context; skip those.
  }
}

const act = (React as unknown as { act: (cb: () => void | Promise<void>) => Promise<void> }).act

let root: Root | null
let realFetch: typeof globalThis.fetch

/**
 * Render a component and return the resulting markup.
 *
 * The `catch` is the point of the test, not defensive padding: an uncaught render error would otherwise
 * surface as an opaque rejection, and the assertion below reports WHICH component failed.
 */
async function renderComponent(node: React.ReactElement): Promise<string> {
  return (await renderComponentWithBody(node)).root
}

/**
 * Render and return BOTH the mount container and the whole `<body>`.
 *
 * Radix `Dialog`/`Select` render through a PORTAL into `document.body`, outside `#root`. Asserting on
 * the container alone therefore sees an empty string for anything inside a dialog — which is why the
 * first version of the `DocDetailDialog` tests failed with `Received: ""` against correct code, a
 * false alarm that would have read as a component crash. Reading the body catches portalled content too.
 */
async function renderComponentWithBody(
  node: React.ReactElement,
): Promise<{ root: string; body: string }> {
  const el = dom.window.document.getElementById('root')!
  const failures: unknown[] = []
  root = createRoot(el, {
    onUncaughtError: (e) => failures.push(e),
    onCaughtError: (e) => failures.push(e),
  })
  await act(async () => {
    root!.render(node)
    // Let the mount effects' fetches settle.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  if (failures.length > 0) {
    throw new Error(`render threw: ${String(failures[0])}`)
  }
  return { root: el.innerHTML, body: dom.window.document.body.innerHTML }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** A document as the list route returns it: cognify fields present, counts real. */
function liveDoc(overrides: Partial<DocumentItem> = {}): DocumentItem {
  return {
    id: 'doc-live',
    name: 'SOP Retur 2026.pdf',
    type: 'pdf',
    sizeBytes: 2_730_000,
    mimeType: 'application/pdf',
    status: 'ready',
    category: 'SOP',
    description: null,
    cognifyStatus: 'completed',
    cognifyError: null,
    createdAt: '2026-09-27T04:00:00.000Z',
    chunkCount: 4,
    isEnabled: true,
    ...overrides,
  }
}

beforeEach(() => {
  realFetch = globalThis.fetch
  root = null
  g.fetch = async () => json({ ok: true, data: {} })
})

afterEach(() => {
  g.fetch = realFetch
  dom.window.document.body.innerHTML = '<div id="root"></div>'
})

/* ---------------------------------------------------------------- documents */

describe('DocCard survives every live cognify shape', () => {
  const noop = () => {}

  test('a COMPLETED document with a chunk count renders its badge and name', async () => {
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc(),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('SOP Retur 2026.pdf')
    // "Graph", not a raw status word — the completed label this card deliberately uses.
    expect(html).toContain('Graph')
    expect(html).not.toContain('undefined')
    expect(html).not.toContain('NaN')
  })

  test('a PROCESSING document renders without a crash', async () => {
    g.fetch = async () => json({ document: liveDoc({ cognifyStatus: 'processing' }) })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({ cognifyStatus: 'processing' }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('Building graph')
  })

  test('a FAILED document with a LONG multiline error still renders', async () => {
    // The error text is shown in the DETAIL dialog; the card must at minimum survive the row, and must
    // offer the Retry control that the detail dialog's copy tells the user to press.
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({
          status: 'error',
          cognifyStatus: 'failed',
          cognifyError:
            'LLM API key is not set.\nSet LLM_API_KEY in your .env\n(Status code: 422)\nprovider: unknown',
          chunkCount: 0,
        }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('Retry Processing')
    expect(html).toContain('Error')
  })

  test('a document with a NULL cognifyStatus renders', async () => {
    // The pre-cognify-era row, and every row on an install with memory off.
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({ cognifyStatus: null }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('SOP Retur 2026.pdf')
    expect(html).not.toContain('undefined')
  })

  test('an UNCategorised document with no description renders', async () => {
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({ category: null, description: null, chunkCount: 0 }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('Uncategorized')
  })

  test('an UNKNOWN file type falls back to the generic icon instead of throwing', async () => {
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({ type: 'pptx' }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('SOP Retur 2026.pdf')
  })

  test('an UNKNOWN status value falls back to the error badge rather than a blank cell', async () => {
    // `STATUS_BADGE[status] ?? STATUS_BADGE.error` — an unrecognised status must not render nothing.
    g.fetch = async () => json({ document: liveDoc() })
    const html = await renderComponent(
      React.createElement(DocCard, {
        doc: liveDoc({ status: 'queued' }),
        onDetail: noop,
        onDelete: noop,
        onToggle: noop,
      }),
    )
    expect(html).toContain('Error')
  })
})

/* ---------------------------------------------------------------- memory status */

describe('MemoryStatusCard renders every live memory state', () => {
  test('ENABLED + reachable names the memory as running', async () => {
    g.fetch = async () =>
      json({ ok: true, data: { enabled: true, connected: true, diagnostics: { components: [] } } })
    const html = await renderComponent(React.createElement(MemoryStatusCard))
    expect(html).toContain('AI Memory')
    expect(html).toContain('Active')
  })

  test('ENABLED but the extraction LLM is degraded says "Cannot store"', async () => {
    // The measured live state: /health answers, LLM_API_KEY is unset, nothing is stored.
    g.fetch = async () =>
      json({
        ok: true,
        data: {
          enabled: true,
          connected: true,
          diagnostics: {
            status: 'degraded',
            components: [
              {
                name: 'llm_provider',
                status: 'degraded',
                provider: 'unknown',
                details: 'LLM API key is not set.',
                responseTimeMs: 17,
              },
            ],
          },
        },
      })
    const html = await renderComponent(React.createElement(MemoryStatusCard))
    expect(html).toContain('Cannot store')
  })

  test('a NULL diagnostics payload does not crash', async () => {
    g.fetch = async () => json({ ok: true, data: { enabled: true, connected: false, diagnostics: null } })
    const html = await renderComponent(React.createElement(MemoryStatusCard))
    expect(html).toContain('Unreachable')
  })

  test('a FAILED status request must not claim memory is OFF', async () => {
    /*
     * DEFECT PINNED. The card's own comment says "the card simply does not render" when the request
     * fails, but the code renders the SAME branch as a genuinely-disabled install: the "Off" badge plus
     * the sentence "documents are searchable by keyword and embeddings, without cross-session memory".
     * A 500 from /api/cognee therefore reads as a definite statement about the customer's memory, which
     * is the one thing an operator would use to decide whether to investigate — and it tells them not to.
     *
     * OBSERVED, defect present: html contains "Off" and "without cross-session memory".
     */
    g.fetch = async () => json({ error: { message: 'Failed to get cognee stats.' } }, 500)
    const html = await renderComponent(React.createElement(MemoryStatusCard))
    expect(html).toContain('Status unknown')
    expect(html).not.toContain('without cross-session memory')
  })

  test('a NETWORK failure is also "unknown", not "off"', async () => {
    g.fetch = async () => {
      throw new Error('network down')
    }
    const html = await renderComponent(React.createElement(MemoryStatusCard))
    expect(html).toContain('Status unknown')
    expect(html).not.toContain('without cross-session memory')
  })
})

/* ---------------------------------------------------------------- vector store */

describe('VectorStorePanel — a failed load must not look like a saved config', () => {
  test('a 500 from the config endpoint shows the overwrite warning and DISABLES Save', async () => {
    /*
     * DEFECT PINNED. `handleApiError` returns `{ error }` with a 500 for every server-side failure, and
     * the loader only checked `json.ok` — returning silently. The panel then painted its DEFAULTS
     * (INTERNAL / ryasai_chunks / 1536 / Cosine) with no banner and Save ENABLED. One click would write
     * those placeholders over a working Qdrant/Milvus/Pinecone/Chroma configuration.
     *
     * The warning this gates already existed and already said the right thing; the path that needed it
     * most was the one that skipped it. Save is asserted DISABLED because a warning next to an armed
     * button still lets the destructive click through.
     *
     * OBSERVED, defect restored (the early `return` without `setLoadError`): no warning text renders and
     * Save is enabled — 1 fail. Fixed: passes.
     */
    g.fetch = async () => json({ error: 'Failed to load vector DB configuration.' }, 500)
    const html = await renderComponent(React.createElement(VectorStorePanel))
    expect(html).toContain('Failed to load vector DB configuration')
    expect(html).toContain('Saving may overwrite existing configuration')

    const save = Array.from(
      dom.window.document.querySelectorAll('button'),
    ).find((b) => ((b as HTMLButtonElement).textContent ?? '').trim() === 'Save')
    expect(save).toBeDefined()
    expect((save as HTMLButtonElement).disabled).toBe(true)
  })

  test('a healthy load renders the stored provider without a warning', async () => {
    g.fetch = async () =>
      json({
        ok: true,
        data: {
          provider: 'QDRANT',
          baseUrl: 'https://qdrant.internal:6333',
          collectionName: 'ryasai_chunks',
          vectorSize: 1536,
          distance: 'Cosine',
        },
      })
    const html = await renderComponent(React.createElement(VectorStorePanel))
    expect(html).toContain('https://qdrant.internal:6333')
    expect(html).not.toContain('Saving may overwrite existing configuration')
  })
})

/* ---------------------------------------------------------------- cognee card */

describe('CogneeCard renders every live stats shape', () => {
  test('the disabled shape (zeroes, null config) renders without a crash', async () => {
    g.fetch = async () =>
      json({
        ok: true,
        data: {
          enabled: false,
          connected: false,
          mode: 'disabled',
          documents: { total: 0, cognified: 0, pending: 0, failed: 0 },
          batchSize: 0,
          maxRetries: 0,
          config: null,
          diagnostics: null,
          embedding: null,
        },
      })
    const html = await renderComponent(React.createElement(CogneeCard))
    expect(html).toContain('Disabled')
  })

  test('the enabled shape with an unhealthy LLM and a dimension MISMATCH renders both warnings', async () => {
    // `matches: false` is a REAL mismatch (the embedder disagrees with the column width); `null` means
    // unknown. Conflating them is a documented past defect, so both are exercised here.
    g.fetch = async () =>
      json({
        ok: true,
        data: {
          enabled: true,
          connected: true,
          mode: 'postgres',
          documents: { total: 12, cognified: 4, pending: 7, failed: 1 },
          batchSize: 50,
          maxRetries: 3,
          config: { enabled: true, dbProvider: 'postgres', dbUrl: 'postgres://x', batchSize: 50, maxRetries: 3 },
          diagnostics: {
            status: 'degraded',
            version: '1.6.0-local',
            uptimeSeconds: 254,
            components: [
              {
                name: 'llm_provider',
                status: 'degraded',
                provider: 'unknown',
                details: 'LLM API key is not set.\n(Status code: 422)',
                responseTimeMs: 17,
              },
            ],
          },
          embedding: { columnDimension: 384, modelDimension: 1536, matches: false },
        },
      })
    const html = await renderComponent(React.createElement(CogneeCard))
    expect(html).toContain('Cannot store')
    expect(html).toContain('1536')
    expect(html).toContain('384')
  })

  test('a 500 from /api/cognee leaves the card in its DISABLED state rather than crashing', async () => {
    /*
     * DEFECT PINNED (low severity, same class as the memory card): `fetchStats` catches and does nothing,
     * so `stats` stays null and every `stats?.enabled` check falls through to the "Memory layer is
     * disabled" panel. On an install with memory fully ON, a transient API failure tells the operator
     * their memory layer is off.
     *
     * Asserted as the CURRENT honest minimum — it must not crash — and the message is recorded here as
     * the reason a misleading-state guard is wanted. Fixing it needs a loading/unknown branch, which is a
     * UI decision this audit does not make unilaterally.
     */
    g.fetch = async () => json({ error: { message: 'Failed to get cognee stats.' } }, 500)
    const html = await renderComponent(React.createElement(CogneeCard))
    expect(html).toContain('Memory layer is disabled')
  })
})

/* ---------------------------------------------------------------- version history */

describe('versionsOutcome — "none" and "unknown" are different answers', () => {
  test('a non-OK response is FAILED, never an empty list', () => {
    /*
     * DEFECT PINNED. `load` swallowed every failure and left `versions` at its initial `[]`, so a 500
     * rendered the identical "No snapshots yet." as a document that genuinely has no snapshots. That is a
     * definite claim about the customer's data made from no evidence, in the REASSURING direction: an
     * admin told there is nothing to restore does not retry.
     *
     * OBSERVED, defect present (`versionsOutcome` reduced to `{ outcome: 'loaded', versions: [] }`): 3 of
     * these fail. Fixed: all pass.
     *
     * Tested here rather than through the component because `DocDetailContent` lives inside a Radix
     * Dialog, whose portal/focus/dismissable-layer primitives dispatch real `CustomEvent`s across the
     * jsdom realm and throw "parameter 1 is not of type 'Event'" in this harness. Extracting the decision
     * is what makes it reachable; see the note on `versionsOutcome`.
     */
    expect(versionsOutcome(false, { error: { message: 'Failed to list versions.' } }).outcome).toBe('failed')
  })

  test('an OK response whose body has no array is FAILED', () => {
    // A 200 with `{ error }` or a truncated body is still not a list of versions.
    expect(versionsOutcome(true, { error: 'nope' }).outcome).toBe('failed')
    expect(versionsOutcome(true, {}).outcome).toBe('failed')
    expect(versionsOutcome(true, null).outcome).toBe('failed')
    expect(versionsOutcome(true, 'not json').outcome).toBe('failed')
  })

  test('a genuinely EMPTY list is LOADED, so the honest "No snapshots yet." still shows', () => {
    const r = versionsOutcome(true, { versions: [] })
    expect(r.outcome).toBe('loaded')
    expect(r.outcome === 'loaded' && r.versions).toEqual([])
  })

  test('a real list is passed through unchanged', () => {
    const list = [{ id: 'v2', version: 2, createdAt: '2026-01-02T00:00:00.000Z' }]
    const r = versionsOutcome(true, { versions: list })
    expect(r.outcome === 'loaded' && r.versions).toEqual(list)
  })
})
