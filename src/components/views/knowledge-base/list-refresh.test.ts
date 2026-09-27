/**
 * Guards for the Knowledge view's list poll.
 *
 * WHY THIS FILE EXISTS. `knowledge-base-view.tsx` polls `/api/documents` every 5s while any document is
 * pending. That poll called `fetchDocs()` — the SAME function the initial load uses — which does
 * `setLoading(true)`. The render branch for `loading` replaces the whole card grid with
 * `CardGridSkeleton` (or with nothing, before `useDelayedLoading`'s 200ms threshold trips). So every
 * tick UNMOUNTED every `DocCard`: each card's optimistic override, elapsed counter and its own poll chain
 * were discarded, and the grid flickered to a skeleton and back every five seconds.
 *
 * The defect is a CONTROL-FLOW one — which state setters run on the poll path — so it is asserted by
 * reading the two call sites and the guard around the user-visible setters, with the poll's call
 * anchored on its ARGUMENT rather than on a nearby word.
 *
 * `.test.ts`, not `.test.tsx`: `scripts/test.ts` collects `{src,benchmark}/**\/*.test.ts`, and the glob
 * does not match `.test.tsx`.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, '..', 'knowledge-base-view.tsx'), 'utf-8')

/** Comments stripped, so the fix's own explanation cannot satisfy an assertion. */
const code = src
  .split('\n')
  .map((l) => {
    const t = l.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
    const i = l.indexOf('//')
    return i === -1 ? l : l.slice(0, i)
  })
  .join('\n')

describe('knowledge view — the list poll must not blank the grid', () => {
  test('the poll refreshes QUIETLY', () => {
    // Anchored on the ARGUMENT at the call site. A test that only looked for `fetchDocs()` nearby would
    // be satisfied by the initial-load call two effects above.
    const poll = code.slice(code.indexOf('if (!anyPending) return'))
    expect(poll).toMatch(/void fetchDocs\(\{ quiet: true \}\)/)
  })

  test('a quiet refresh cannot set the user-visible loading state', () => {
    // The guard must gate BOTH setters on the poll path. `setLoading(true)` unmounts every card;
    // `setLoadError(true)` would replace a good list with a full-page error because one background
    // request failed.
    const fn = code.slice(code.indexOf('const fetchDocs = useCallback'))
    const body = fn.slice(0, fn.indexOf('}, [])'))
    expect(body).toMatch(/if \(!quiet\) \{\s*setLoading\(true\)/)
    expect(body).toMatch(/if \(!quiet\) setLoading\(false\)/)
    expect(body).toMatch(/else if \(!quiet\) \{/)
    expect(body).toMatch(/if \(!quiet\) \{\s*setLoadError\(true\)/)
  })

  test('the initial load still announces itself', () => {
    // The other direction: `quiet` must not have been applied to the mount fetch, or the view would
    // paint an empty state while its first request is in flight.
    expect(code).toMatch(/useEffect\(\(\) => \{\s*fetchDocs\(\)\s*\}, \[fetchDocs\]\)/)
  })

  test('the pending predicate and the card agree on what terminal means', () => {
    // One exported rule, used by both, so they cannot drift again.
    expect(code).toMatch(/import \{ DocCard, isCognifySettled \}/)
    expect(code).toMatch(/!isCognifySettled\(d\.cognifyStatus\)/)
  })
})
