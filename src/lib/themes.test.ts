import { describe, expect, test } from 'bun:test'
import { THEMES, THEME_CSS, THEME_INIT_SCRIPT, getStoredTheme } from './themes'

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
