import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { VIEW_KEYS } from './view-routing'

/**
 * Navigation invariants — the sidebar grouping and the reachability of AI Memory.
 *
 * WHY THIS EXISTS. The reported symptom was "AI Memory submenu tidak bisa diakses". Two things
 * caused it, and both are structural rather than visual, so a screenshot test would not have caught
 * either:
 *
 *   1. The Dashboard banner said "enable in Settings", and Settings has NO memory tab — the card
 *      lived under AI Configuration and Knowledge. The instruction itself pointed at a dead end.
 *   2. The card was reachable only by first navigating to Knowledge and then finding a tab. Nothing
 *      linked to it directly, so "reachable" depended on the reader guessing the right parent menu.
 *
 * A THIRD problem was the reason for the grouping: twelve peer sidebar items gave no answer to
 * "where would X be?", and five of them read as "settings" (AI Configuration, Prompt & Tools, Tools,
 * Integration API, Settings). The guard below pins the grouping AND the invariant that made it worth
 * doing — every navigation key appears exactly once, so a future edit cannot silently drop a view.
 */
const root = join(import.meta.dir, '..', '..')
const pageSrc = readFileSync(join(root, 'src', 'app', 'page.tsx'), 'utf-8')
const dashboardRaw = readFileSync(join(root, 'src', 'components', 'views', 'dashboard-view.tsx'), 'utf-8')

/**
 * Strip comments before matching DASHBOARD copy.
 *
 * LOAD-BEARING, and caught by this file's own negative control: the assertion below looks for the
 * string that sent operators to the wrong menu, and after the fix that string still existed — in the
 * comment explaining why it was removed. A guard that cannot tell prose from code reports a fault
 * that is not there, which trains people to ignore it. Same class as the release-image guard, whose
 * negative control once passed for exactly this reason.
 */
const stripComments = (src: string) =>
  src
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
      const i = line.indexOf('//')
      return i === -1 ? line : line.slice(0, i)
    })
    .join('\n')

const dashboardSrc = stripComments(dashboardRaw)

const aiConfigSrc = readFileSync(
  join(root, 'src', 'components', 'views', 'ai-configuration-view.tsx'),
  'utf-8',
)
const knowledgeSrc = readFileSync(
  join(root, 'src', 'components', 'views', 'knowledge-base-view.tsx'),
  'utf-8',
)

describe('sidebar: grouped, and every view appears exactly once', () => {
  test('NAV_GROUPS is defined and every item key is a real view', () => {
    const keys = [...pageSrc.matchAll(/\{ key: '([a-z-]+)', label:/g)].map((m) => m[1])
    expect(keys.length).toBeGreaterThan(0)
    const unknown = keys.filter((k) => !(VIEW_KEYS as readonly string[]).includes(k))
    expect(unknown, `sidebar references unknown view key(s): ${unknown.join(', ')}`).toEqual([])
  })

  test('no view is listed twice — a duplicate is how a menu silently loses an entry', () => {
    const keys = [...pageSrc.matchAll(/\{ key: '([a-z-]+)', label:/g)].map((m) => m[1])
    const seen = new Set<string>()
    const dupes = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)))
    expect(dupes, `duplicate sidebar entries: ${dupes.join(', ')}`).toEqual([])
  })

  test('the flat NAV is DERIVED from the groups, not maintained beside them', () => {
    // Two hand-written lists is the defect this repo catalogs: they drift, and the drift is only
    // visible as a missing menu item. `NAV` must be built from `NAV_GROUPS`.
    expect(pageSrc).toContain('const NAV: NavItem[] = NAV_GROUPS.flatMap')
  })

  test('the four group titles are present and non-empty', () => {
    for (const title of ['Workspace', 'Data & Knowledge', 'AI & Automation', 'System']) {
      expect(pageSrc, `missing group: ${title}`).toContain(`title: '${title}'`)
    }
  })
})

describe('AI Memory is reachable without guessing its parent menu', () => {
  test('the AI Configuration view has a memory tab wired to the card', () => {
    expect(aiConfigSrc).toContain('TabsTrigger value="memory"')
    expect(aiConfigSrc).toContain('<CogneeCard />')
  })

  test('Knowledge does NOT duplicate the memory card — one configuration surface only', () => {
    // INCIDENT: the full AI Memory card rendered in BOTH Knowledge and AI Configuration, so the same
    // settings existed in two menus with no way to tell which was authoritative. Knowledge now shows a
    // status card that LINKS to the editor; the editor exists in exactly one place.
    expect(knowledgeSrc).toContain('<MemoryStatusCard />')
    expect(knowledgeSrc).not.toContain('<CogneeCard')
    // The tab is gone too — a tab with no editable content would be a dead end.
    expect(knowledgeSrc).not.toContain('TabsTrigger value="cognee"')
  })

  test('a retired `?tab=cognee` link FORWARDS instead of rendering a blank panel', () => {
    // Found by reading this file's own failure output: `applyTab` still accepted 'cognee' after the
    // tab was deleted, so `setTab('cognee')` selected a non-existent tab and rendered NOTHING. A
    // bookmark or a dashboard link would have looked broken rather than moved.
    expect(knowledgeSrc).toMatch(/raw === 'cognee'/)
    expect(knowledgeSrc).toMatch(/detail: \{ view: 'ai-config', tab: 'memory' \}/)
  })

  test('the dashboard banner NAVIGATES instead of naming a menu', () => {
    // The original copy said "enable in Settings" and there is no memory tab there. Asserting on the
    // DISPATCH rather than on the words: prose can be reworded, but a missing event cannot navigate.
    expect(
      dashboardSrc,
      'the AI Memory card must dispatch a navigate-view event targeting the memory tab',
    ).toMatch(/new CustomEvent\('navigate-view',\s*\{\s*detail:\s*\{\s*view:\s*'ai-config',\s*tab:\s*'memory'/)
  })

  test('the dashboard no longer tells the operator to look in Settings', () => {
    // Negative control for the fix: the exact string that sent people to the wrong menu.
    expect(dashboardSrc).not.toContain('enable in Settings')
  })

  test('both target views accept an externally selected tab', () => {
    // A controlled Tabs is what makes the deep link work at all: with `defaultValue` the incoming
    // target is ignored and the user lands on the first tab, which looks like the link is broken.
    for (const [name, src] of [
      ['ai-config', aiConfigSrc],
      ['knowledge', knowledgeSrc],
    ] as const) {
      expect(src, `${name} must listen for navigate-view with a tab`).toContain("addEventListener('navigate-view'")
      expect(src, `${name} must use a controlled Tabs value`).toMatch(/<Tabs value=\{tab\} onValueChange=\{setTab\}/)
    }
  })

  test('tab targets are validated before being applied', () => {
    // An unvalidated `setTab(detail.tab)` would accept any string and leave the view on a tab with
    // no content — a blank panel that reads as a broken page.
    expect(aiConfigSrc).toMatch(/raw === 'llm' \|\| raw === 'embedding' \|\| raw === 'memory'/)
    // Knowledge validates its OWN two tabs. 'cognee' is handled separately as a FORWARD, asserted
    // above — accepting it here would select a tab that does not exist.
    expect(knowledgeSrc).toMatch(/raw === 'documents' \|\| raw === 'vector'\) setTab/)
  })
})

describe('memory: EVERY exit path of the non-streaming pipeline must write the turn', () => {
  /**
   * INCIDENT (2026-09-27), found by exercising a REAL chat against the production install.
   *
   * A chat sent through `/api/v1/chat/completions` produced NO `remember` request in the cognee log,
   * and a recall 180 seconds later found nothing. The cause was placement: the `void
   * rememberChatTurn(...)` call sat AFTER the branch dispatch, so the four `return` statements above it
   * — the agentic loop, the multi-step DAG, the clarification reply, and the plain CHAT branch —
   * skipped memory entirely. Memory looked wired and stored nothing for the two most common kinds of
   * turn ("hello", and anything answered conversationally).
   *
   * The unit tests did not catch it because they assert on branch RESULTS, and a turn whose answer is
   * correct looks identical whether or not it was remembered.
   */
  const src = readFileSync(join(import.meta.dir, 'tool-router.ts'), 'utf-8')
    .split('\n')
    .map((l) => (l.trimStart().startsWith('//') || l.trimStart().startsWith('*') || l.trimStart().startsWith('/*') ? '' : l))
    .join('\n')

  /** The body of `_runNonStreamingChatCompletion` only — the streaming twin has its own exits. */
  function nonStreamingBody(): string {
    const start = src.indexOf('async function _runNonStreamingChatCompletion')
    expect(start).toBeGreaterThan(-1)
    const next = src.indexOf('export async function runStreamingChatCompletion', start)
    return src.slice(start, next === -1 ? undefined : next)
  }

  test('a raw `return` of a CompletionResult does not exist outside the wrapper', () => {
    // The wrapper itself returns the value it was handed, so `return answer` is allowed INSIDE it.
    // What must not exist is returning a freshly built answer object directly from the pipeline body.
    const body = nonStreamingBody()
    const rawReturns = [...body.matchAll(/return\s+(\{[^}]*answer:|await run[A-Z]\w*Branch\()/g)].map((m) => m[0])
    expect(rawReturns).toEqual([])
  })

  test('the wrapper is called on each branch that returns an answer', () => {
    const body = nonStreamingBody()
    // At least four call sites: agentic, DAG, clarification, CHAT. A regression that deletes one shows
    // up here as a smaller count rather than as a passing suite.
    const calls = [...body.matchAll(/return remember\(/g)].length
    expect(calls).toBeGreaterThanOrEqual(4)
  })

  test('the DAG branch specifically goes through the wrapper', () => {
    // NAMED SEPARATELY, and this test exists because the count above SURVIVED its own negative
    // control: deleting `remember` from the DAG path still left four `return remember(` calls, so the
    // count was satisfied by the others. A guard that cannot fail for the case it was written for is
    // worse than no guard — it reports safety. This pins the specific branch.
    expect(nonStreamingBody()).toMatch(/return remember\(dagResult\)/)
  })

  test('the agentic branch specifically goes through the wrapper', () => {
    expect(nonStreamingBody()).toMatch(/return remember\(\{ answer: result\.answer/)
  })

  test('the clarification branch specifically goes through the wrapper', () => {
    // A clarification reply is a turn the user saw. Omitting it leaves a hole in the transcript that a
    // later "what were we discussing?" would fall into.
    expect(nonStreamingBody()).toMatch(/return remember\(\{ answer: intent\.clarificationQuestion/)
  })

  test('the CHAT branch specifically goes through the wrapper', () => {
    // Named separately because it is the one that actually broke: the plain conversational turn.
    expect(nonStreamingBody()).toMatch(/return remember\(await runChatBranch\(/)
  })
})

describe('memory: BOTH transports of the external API write the turn', () => {
  /**
   * MEASURED GAP (2026-09-27). `/api/v1/chat/completions` has two transports:
   *
   *   stream:false → `runNonStreamingChatCompletion`, which writes through `tool-router`.
   *   stream:true  → `runStreamingChatCompletion`, whose prepaers NEVER call `rememberChatTurn`.
   *
   * The web chat is unaffected because `chat/sessions/[id]/send` writes memory itself at its own call
   * site — but this route had no equivalent, so an integrator using `stream: true` received correct
   * answers and no memory, with the two responses indistinguishable from the outside.
   */
  const v1Src = readFileSync(join(import.meta.dir, '..', 'app', 'api', 'v1', 'chat', 'completions', 'route.ts'), 'utf-8')

  test('the streaming transport writes the turn', () => {
    // Asserting on the INVOCATION, not on the identifier: the import alone would satisfy a `toContain`,
    // which is the vacuous-guard shape this repo has been bitten by repeatedly.
    expect(v1Src).toMatch(/void rememberChatTurn\(\{/)
    // And it must be inside the streaming branch, after the answer has been assembled.
    const at = v1Src.indexOf('void rememberChatTurn(')
    const streamAt = v1Src.indexOf('runStreamingChatCompletion(')
    expect(streamAt).toBeGreaterThan(-1)
    expect(at).toBeGreaterThan(streamAt)
  })

  test('the streaming write is fire-and-forget, never awaited', () => {
    // Awaiting it would hold the SSE stream open for 5.6-9.7s (85s on a fresh dataset) past the 120s
    // idle watchdog, turning a working answer into a timeout.
    expect(v1Src).not.toMatch(/await rememberChatTurn\(/)
  })
})

describe('sidebar layout: every menu stays REACHABLE, which a clip used to prevent', () => {
  /**
   * MEASURED BUG, found from a user screenshot showing the sidebar ending at "Integration API" with "Settings" cut
   * off. Playwright at the user's own viewport width (1907) showed the cause was NOT a missing entry — `Settings` is in
   * NAV_GROUPS and always was:
   *
   *     viewport 620px:  shell ended at y=620, the nav inside it ended at y=669 (49px LOWER),
   *                      and "Settings" sat at y=625..661 — permanently below the fold.
   *     the nav reported `scrollHeight === clientHeight`, so there was nothing to scroll: the overflow was created
   *     ONE LEVEL UP by `h-full` on a wrapper that shares the shell with a header, and `overflow-hidden` on the shell
   *     then discarded the excess instead of making it reachable.
   *
   * So the assertions below are about the two properties that made it unreachable, and about the entries a reviewer
   * would notice missing.
   */
  const src = readFileSync(join(import.meta.dir, '..', 'app', 'page.tsx'), 'utf8')

  test('the nav wrapper uses flex-1 + min-h-0, not h-full', () => {
    // `h-full` = 100% of the shell, which the header already occupies part of -> the pair overflows the shell.
    // `min-h-0` is the load-bearing half: a flex child defaults to min-height:auto and refuses to shrink below its
    // content, so `flex-1` alone cannot constrain the nav and nothing becomes scrollable.
    expect(src).toMatch(/flex flex-col flex-1 min-h-0/)
    expect(src).not.toMatch(/flex flex-col h-full/)
  })

  test('the nav is the scroll container, so a short viewport scrolls instead of clipping', () => {
    // MEASURED after the fix: nav bottom == shell bottom at every height tested (876 down to 500), and Settings is
    // reachable at all of them (visible above ~660, scrollable below).
    expect(src).toMatch(/<nav className="flex-1 min-h-0 p-2 overflow-y-auto">/)
  })

  test('Settings is still in the navigation, so a layout fix cannot have dropped it', () => {
    // The user's report was "Settings is not visible"; the cheapest wrong fix would have been to remove it.
    expect(src).toMatch(/key: 'settings', label: 'Settings'/)
    expect(VIEW_KEYS).toContain('settings')
  })

  test('the compact row height is a measured value, not a preference', () => {
    /*
     * py-2 (36px/row) instead of py-2.5 (40px): MEASURED, twelve rows so 48px reclaimed, which is what moved the
     * sidebar's requirement from 640px of content down to 564px and put Settings back inside a laptop's fold without
     * shrinking the icon or the label.
     */
    expect(src).toMatch(/rounded-md px-3 py-2 text-left transition-colors/)
    expect(src).not.toMatch(/rounded-md px-3 py-2\.5 text-left transition-colors/)
  })
})
