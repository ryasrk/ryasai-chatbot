import { describe, expect, test } from 'bun:test'
import { THEMES, THEME_CSS, THEME_INIT_SCRIPT } from './themes'

describe('Neo-Olympian theme (slate)', () => {
  test('THEMES still has 5 entries and slate is renamed Neo-Olympian', () => {
    expect(THEMES).toHaveLength(5)
    const slate = THEMES.find((t) => t.id === 'slate')
    expect(slate).toBeDefined()
    expect(slate!.name).toBe('Neo-Olympian')
    expect(slate!.swatch).toEqual(['#C9A45C', '#D8B76A', '#080A0B'])
  })

  test('dark palette uses primary gold oklch', () => {
    const dark = THEME_CSS.slate.dark
    // primary gold #C9A45C -> oklch(0.706 0.069 282.7)
    expect(dark).toContain('oklch(0.706 0.069 282.7)')
    // obsidian background #080A0B -> oklch(0.144 0.010 169.9)
    expect(dark).toContain('oklch(0.144 0.010 169.9)')
    // marble foreground #EDE9DF -> oklch(0.933 0.033 190.0)
    expect(dark).toContain('oklch(0.933 0.033 190.0)')
  })

  test('light palette uses marble background + obsidian foreground', () => {
    const light = THEME_CSS.slate.light
    // marble bg #E8E4DA -> oklch(0.918 0.032 190.4)
    expect(light).toContain('oklch(0.918 0.032 190.4)')
    // obsidian foreground #111416 -> oklch(0.191 0.014 167.1)
    expect(light).toContain('oklch(0.191 0.014 167.1)')
  })

  test('chart tokens are overridden (gold primary line)', () => {
    expect(THEME_CSS.slate.dark).toContain('--chart-1: oklch(0.706 0.069 282.7)')
    expect(THEME_CSS.slate.dark).toContain('--chart-5: oklch(0.467 0.097 353.8)')
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
