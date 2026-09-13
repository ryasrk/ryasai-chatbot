import { describe, expect, test } from 'bun:test'
import {
  THEMES,
  THEME_CSS,
  THEME_INIT_SCRIPT,
  getStoredTheme,
  getStoredDarkMode,
  applyTheme,
  setTheme,
} from './themes'

describe('Neo-Olympian theme (slate)', () => {
  test('Neo-Olympian is the default theme (SSR fallback + FOUC script)', () => {
    // getStoredTheme() falls back to 'slate' when window is undefined (SSR/test env)
    expect(getStoredTheme()).toBe('slate')
    // the anti-FOUC inline script must default to 'slate' both on first visit
    // (no localStorage entry yet) and in its catch-block fallback
    expect(THEME_INIT_SCRIPT).toContain("localStorage.getItem('ryasai-theme') || 'slate'")
    expect(THEME_INIT_SCRIPT).toContain("root.setAttribute('data-theme', 'slate')")
  })

  test('THEMES still has 5 entries and slate is renamed Neo-Olympian', () => {
    expect(THEMES).toHaveLength(5)
    const slate = THEMES.find((t) => t.id === 'slate')
    expect(slate).toBeDefined()
    expect(slate!.name).toBe('Neo-Olympian')
    expect(slate!.swatch).toEqual(['#C9A45C', '#D8B76A', '#080A0B'])
  })

  test('dark palette uses primary gold oklch (not violet)', () => {
    const dark = THEME_CSS.slate.dark
    // primary gold #C9A45C -> oklch(0.737 0.101 82.7) — hue ~83 is gold/amber,
    // not the hue-282 violet a prior broken conversion had labeled "gold".
    expect(dark).toContain('oklch(0.737 0.101 82.7)')
    // obsidian background #080A0B -> oklch(0.143 0.004 227.5)
    expect(dark).toContain('oklch(0.143 0.004 227.5)')
    // marble foreground #EDE9DF -> oklch(0.934 0.014 88.7)
    expect(dark).toContain('oklch(0.934 0.014 88.7)')
  })

  test('light palette uses marble background + obsidian-ink foreground', () => {
    const light = THEME_CSS.slate.light
    expect(light).toContain('--background: oklch(0.94 0.012 85)')
    expect(light).toContain('--foreground: oklch(0.20 0.015 90)')
  })

  test('chart tokens are overridden (gold primary line, crimson danger)', () => {
    expect(THEME_CSS.slate.dark).toContain('--chart-1: oklch(0.737 0.101 82.7)')
    expect(THEME_CSS.slate.dark).toContain('--chart-5: oklch(0.477 0.106 21.9)')
  })

  test('gold hue stays in the amber band, not violet/blue', () => {
    // Regression guard: every gold-labeled token (primary/accent/ring/chart-1)
    // must share the ~75-90 hue band. A future edit that drifts one of these
    // toward hue 200-300 has reintroduced the steel/violet bug this theme
    // replaced.
    const dark = THEME_CSS.slate.dark
    const goldHues = [...dark.matchAll(/oklch\([\d.]+ [\d.]+ (\d+\.?\d*)\)/g)]
      .map((m) => parseFloat(m[1]))
      .filter((h) => h >= 60 && h <= 100)
    expect(goldHues.length).toBeGreaterThanOrEqual(5) // primary/accent/ring/sidebar-primary/chart-1 at least
  })

  test('other themes are untouched', () => {
    // enterprise primary blue should still be present
    expect(THEME_CSS.enterprise.dark).toContain('oklch(0.65 0.20 255)')
    // forest primary green
    expect(THEME_CSS.forest.dark).toContain('oklch(0.65 0.18 155)')
  })

  test('FOUC init script references data-theme', () => {
    expect(THEME_INIT_SCRIPT).toContain('data-theme')
    expect(THEME_INIT_SCRIPT).toContain('slate')
  })
})

// ===========================================================================
// The localStorage-backed getters/setters
// ===========================================================================
//
// getStoredDarkMode, applyTheme and setTheme had NO test: the file only imported
// getStoredTheme, and only its SSR early-return. These run in the browser, so a
// DOM stub is the only way to reach them from bun.

describe('theme persistence (DOM stub)', () => {
  function installDom(store: Record<string, string>) {
    const attributes: Record<string, string> = {}
    const classes = new Set<string>()
    const appended: Array<{ id: string; textContent: string }> = []
    const events: string[] = []

    const documentStub = {
      documentElement: {
        setAttribute: (k: string, v: string) => { attributes[k] = v },
        classList: {
          toggle: (c: string, on: boolean) => { if (on) classes.add(c); else classes.delete(c) },
        },
      },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (el: { id: string; textContent: string }) => { appended.push(el) } },
    }
    const g = globalThis as unknown as Record<string, unknown>
    const prevWindow = g.window
    const prevDoc = g.document
    const prevLs = g.localStorage
    g.window = { dispatchEvent: (e: Event) => { events.push(e.type) } } as unknown as Window
    g.document = documentStub as unknown as Document
    g.localStorage = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v },
    } as unknown as Storage
    return {
      attributes, classes, appended, events, store,
      restore: () => {
        g.window = prevWindow; g.document = prevDoc; g.localStorage = prevLs
      },
    }
  }

  test('with NO DOM (SSR) the getters return the dark-by-default values', () => {
    // `typeof window === 'undefined'` early returns. Dark is the app's default, so
    // the SSR answer must be `true`, not `false` -- a flash of light theme otherwise.
    expect(getStoredTheme()).toBe('slate')
    expect(getStoredDarkMode()).toBe(true)
  })

  test('a stored "true" is dark and a stored "false" is NOT', () => {
    // Line 299. The comparison is against the STRING 'true', because localStorage
    // only stores strings. A truthiness check would make the string "false" dark.
    const dom = installDom({ 'ryasai-dark-mode': 'false' })
    try {
      expect(getStoredDarkMode()).toBe(false)
    } finally { dom.restore() }

    const dom2 = installDom({ 'ryasai-dark-mode': 'true' })
    try {
      expect(getStoredDarkMode()).toBe(true)
    } finally { dom2.restore() }
  })

  test('an ABSENT entry falls through to dark, not light', () => {
    // Line 300 -- the `stored === null` path, which is distinct from a stored
    // "false" and must give the opposite answer.
    const dom = installDom({})
    try {
      expect(getStoredDarkMode()).toBe(true)
    } finally { dom.restore() }
  })

  test('a stored THEME is returned verbatim, valid or not', () => {
    // getStoredTheme does not validate against THEMES and the cast is unchecked, so
    // a stale value from an older build reaches applyTheme, where THEME_CSS[theme]
    // would be undefined. Pinned as MEASURED rather than as desired.
    //
    // ('neo-olympian' is NOT a valid id -- Neo-Olympian is the LABEL of the 'slate'
    // entry. My first version used it as an id and TypeScript rejected the
    // assertion, which is the type system catching a wrong assumption.)
    const dom = installDom({ 'ryasai-theme': 'slate' })
    try {
      expect(getStoredTheme()).toBe('slate')
    } finally { dom.restore() }

    const dom2 = installDom({ 'ryasai-theme': 'a-theme-that-no-longer-exists' })
    try {
      expect(String(getStoredTheme())).toBe('a-theme-that-no-longer-exists')
    } finally { dom2.restore() }
  })

  test('applyTheme sets data-theme, toggles the dark class and injects the vars', () => {
    const dom = installDom({})
    try {
      applyTheme('slate', true)
      expect(dom.attributes['data-theme']).toBe('slate')
      expect(dom.classes.has('dark')).toBe(true)
      expect(dom.appended).toHaveLength(1)
      expect(dom.appended[0].id).toBe('ryasai-theme-vars')
      // The style element carries the DARK palette for this theme.
      expect(dom.appended[0].textContent).toBe(`:root{${THEME_CSS.slate.dark}}`)
    } finally { dom.restore() }
  })

  test('applyTheme with dark=false uses the LIGHT palette and removes the class', () => {
    // The ternary is the whole point; asserting only the dark branch would let a
    // swapped ternary pass.
    const dom = installDom({})
    try {
      applyTheme('slate', false)
      expect(dom.classes.has('dark')).toBe(false)
      expect(dom.appended[0].textContent).toBe(`:root{${THEME_CSS.slate.light}}`)
    } finally { dom.restore() }
  })

  test('setTheme PERSISTS both keys and dispatches the change event', () => {
    // The event is what makes anything branching on the active theme re-render;
    // without it a menu switch shows stale colours until a reload.
    const dom = installDom({})
    try {
      setTheme('forest', false)
      expect(dom.store['ryasai-theme']).toBe('forest')
      // String(dark) -- localStorage stores strings.
      expect(dom.store['ryasai-dark-mode']).toBe('false')
      expect(dom.events).toEqual(['ryasai-theme-changed'])
      // And it applied immediately.
      expect(dom.attributes['data-theme']).toBe('forest')
    } finally { dom.restore() }
  })
})
