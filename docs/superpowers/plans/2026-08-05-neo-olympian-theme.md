# Neo-Olympian Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `slate` theme with "Neo-Olympian" — obsidian + marble + gold palette, conditional Cinzel/Cormorant serif fonts, and 3 CSS-only utility classes (`.obsidian-void`, `.orbital-loader`, `.gold-card`).

**Architecture:** Override the `slate` entry in `THEME_CSS` (oklch palette). Add Cinzel + Cormorant via `next/font/google` in layout.tsx; activate them only under `:root[data-theme="slate"]` so other themes stay Inter-only. Add 3 utility classes + 1 keyframe to globals.css. Theme id stays `'slate'` so existing user preferences keep working.

**Tech Stack:** Next.js App Router, React 19, Tailwind v4 (`@theme inline`, `@custom-variant`), next/font/google, oklch colors, bun:test.

**Spec:** `docs/superpowers/specs/2026-08-05-neo-olympian-theme-design.md`

## Global Constraints

- Theme id stays `'slate'` — do NOT rename it (user preferences + FOUC script + storage key depend on it).
- Only 3 files change + 1 new test file: `src/lib/themes.ts`, `src/app/layout.tsx`, `src/app/globals.css`, `src/lib/themes.test.ts`.
- No other themes (`enterprise`, `midnight`, `forest`, `sandstone`) may be modified.
- `--font-sans` is NOT overridden globally — serif identity is opt-in via `font-display` / `font-serif` utilities so existing components keep Inter.
- Palette values are oklch (the app's color space). Hex values from the reference are already converted in the spec — use them verbatim.
- `--radius` stays `16px` (consistent with other themes).
- Chart tokens `--chart-1..5` ARE overridden when Neo-Olympian is active (gold / marble / gray / bright-gold / crimson).
- Commit style: conventional commits (see `git log`).
- Tests run via `bun scripts/test.ts` (NOT `bun test src/` — see AGENTS.md testing quirks); single file via `bun test src/lib/themes.test.ts`.

## File Structure

- **Modify** `src/lib/themes.ts` — replace `THEME_CSS.slate` light+dark blocks; update `THEMES` `slate` entry metadata.
- **Modify** `src/app/layout.tsx` — import Cinzel + Cormorant_Garamond, add variables to body className.
- **Modify** `src/app/globals.css` — add `--font-display`/`--font-serif` to `@theme inline`, add `:root[data-theme="slate"]` block, add 3 utility classes + keyframe.
- **Create** `src/lib/themes.test.ts` — unit test asserting the palette swap, theme metadata, FOUC script integrity.

No other files change.

---

### Task 1: Replace `slate` theme palette + metadata in `themes.ts`

**Files:**
- Modify: `src/lib/themes.ts` (lines 40-50 `THEMES` slate entry; lines 187-230 `THEME_CSS.slate`)

**Interfaces:**
- Consumes: existing `ThemeId`, `ThemeDef`, `THEME_CSS` structure (Record<ThemeId, {light, dark}>).
- Produces: updated `THEME_CSS.slate` with Neo-Olympian oklch values; updated `THEMES` slate metadata (name "Neo-Olympian", description, swatch). Task 2 and Task 3 do NOT depend on each other's exact values, but Task 3's test asserts the values written here.

- [ ] **Step 1: Update the `THEMES` array slate entry**

In `src/lib/themes.ts`, replace the slate object (around lines 40-44):

```ts
  {
    id: 'slate',
    name: 'Neo-Olympian',
    description: 'Obsidian, marble, and brushed gold — divine intelligence',
    swatch: ['#C9A45C', '#D8B76A', '#080A0B'],
  },
```

- [ ] **Step 2: Replace the `THEME_CSS.slate` block (light)**

In `src/lib/themes.ts`, replace the `slate` key's `light:` string (starts around line 188) with:

```ts
    light: `
      --radius: 16px;
      --background: oklch(0.918 0.032 190.4); --foreground: oklch(0.191 0.014 167.1);
      --card: oklch(0.97 0.01 190); --card-foreground: oklch(0.191 0.014 167.1);
      --popover: oklch(0.97 0.01 190); --popover-foreground: oklch(0.191 0.014 167.1);
      --primary: oklch(0.65 0.085 282.7); --primary-foreground: oklch(0.918 0.032 190.4);
      --secondary: oklch(0.88 0.02 190); --secondary-foreground: oklch(0.25 0.015 167.1);
      --muted: oklch(0.90 0.015 190); --muted-foreground: oklch(0.45 0.02 192);
      --accent: oklch(0.70 0.07 275.8); --accent-foreground: oklch(0.918 0.032 190.4);
      --destructive: oklch(0.45 0.10 353.8); --destructive-foreground: oklch(0.918 0.032 190.4);
      --success: oklch(0.52 0.12 155); --success-foreground: oklch(0.918 0.032 190.4);
      --warning: oklch(0.68 0.13 70); --warning-foreground: oklch(0.918 0.032 190.4);
      --info: oklch(0.60 0.06 250); --info-foreground: oklch(0.918 0.032 190.4);
      --border: oklch(0.85 0.015 190); --input: oklch(0.85 0.015 190); --ring: oklch(0.65 0.085 282.7);
      --sidebar: oklch(0.94 0.012 190); --sidebar-foreground: oklch(0.25 0.015 167.1);
      --sidebar-primary: oklch(0.65 0.085 282.7); --sidebar-primary-foreground: oklch(0.918 0.032 190.4);
      --sidebar-accent: oklch(0.90 0.015 190); --sidebar-accent-foreground: oklch(0.191 0.014 167.1);
      --sidebar-border: oklch(0.85 0.015 190); --sidebar-ring: oklch(0.65 0.085 282.7);
      --hover: oklch(0.93 0.012 190);
      --chart-1: oklch(0.65 0.085 282.7); --chart-2: oklch(0.918 0.032 190.4); --chart-3: oklch(0.50 0.02 192); --chart-4: oklch(0.846 0.063 273.0); --chart-5: oklch(0.45 0.10 353.8);
    `,
```

- [ ] **Step 3: Replace the `THEME_CSS.slate` block (dark)**

Replace the `dark:` string (starts around line 209) with:

```ts
    dark: `
      --radius: 16px;
      --background: oklch(0.144 0.010 169.9); --foreground: oklch(0.933 0.033 190.0);
      --card: oklch(0.191 0.014 167.1); --card-foreground: oklch(0.933 0.033 190.0);
      --popover: oklch(0.191 0.014 167.1); --popover-foreground: oklch(0.933 0.033 190.0);
      --primary: oklch(0.706 0.069 282.7); --primary-foreground: oklch(0.144 0.010 169.9);
      --secondary: oklch(0.24 0.015 167.1); --secondary-foreground: oklch(0.918 0.032 190.4);
      --muted: oklch(0.22 0.012 169.9); --muted-foreground: oklch(0.608 0.022 192.5);
      --accent: oklch(0.760 0.070 275.8); --accent-foreground: oklch(0.144 0.010 169.9);
      --destructive: oklch(0.467 0.097 353.8); --destructive-foreground: oklch(0.933 0.033 190.0);
      --success: oklch(0.60 0.10 155); --success-foreground: oklch(0.144 0.010 169.9);
      --warning: oklch(0.75 0.12 70); --warning-foreground: oklch(0.144 0.010 169.9);
      --info: oklch(0.70 0.06 250); --info-foreground: oklch(0.144 0.010 169.9);
      --border: oklch(0.25 0.015 169.9); --input: oklch(0.25 0.015 169.9); --ring: oklch(0.706 0.069 282.7);
      --sidebar: oklch(0.165 0.010 169.9); --sidebar-foreground: oklch(0.933 0.033 190.0);
      --sidebar-primary: oklch(0.706 0.069 282.7); --sidebar-primary-foreground: oklch(0.144 0.010 169.9);
      --sidebar-accent: oklch(0.22 0.012 169.9); --sidebar-accent-foreground: oklch(0.933 0.033 190.0);
      --sidebar-border: oklch(0.25 0.015 169.9); --sidebar-ring: oklch(0.706 0.069 282.7);
      --hover: oklch(0.215 0.012 169.9);
      --chart-1: oklch(0.706 0.069 282.7); --chart-2: oklch(0.918 0.032 190.4); --chart-3: oklch(0.608 0.022 192.5); --chart-4: oklch(0.846 0.063 273.0); --chart-5: oklch(0.467 0.097 353.8);
    `,
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: 0 errors (themes.ts is type-safe; only string contents changed)

- [ ] **Step 5: Commit**

```bash
git add src/lib/themes.ts
git commit -m "feat(theme): replace slate palette with Neo-Olympian (obsidian/marble/gold)"
```

---

### Task 2: Add Cinzel + Cormorant fonts + conditional activation

**Files:**
- Modify: `src/app/layout.tsx` (imports + body className)
- Modify: `src/app/globals.css` (`@theme inline` additions + `:root[data-theme="slate"]` block)

**Interfaces:**
- Consumes: Task 1's `slate` theme id (the `data-theme="slate"` selector matches what `applyTheme` already sets).
- Produces: two Tailwind utilities (`font-display`, `font-serif`) available app-wide; they resolve to Cinzel/Cormorant only under `[data-theme="slate"]`, Inter elsewhere.

- [ ] **Step 1: Import the two serif fonts in `layout.tsx`**

In `src/app/layout.tsx`, add to the existing `next/font/google` import (line 2):

```ts
import { Inter, JetBrains_Mono, Cinzel, Cormorant_Garamond } from "next/font/google";
```

Add the two font definitions after the `jetbrains` definition (after line 19):

```ts
const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  preload: false,
});

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  preload: false,
});
```

- [ ] **Step 2: Add the font variables to the body className**

In `src/app/layout.tsx`, update the `<body>` className (line 47) to include both new variables:

```tsx
      <body
        className={`${inter.variable} ${jetbrains.variable} ${cinzel.variable} ${cormorant.variable} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
```

- [ ] **Step 3: Add font tokens to `@theme inline` in `globals.css`**

In `src/app/globals.css`, inside the `@theme inline { ... }` block (after `--font-mono: var(--font-jetbrains);` on line 15), add:

```css
  --font-display: var(--font-inter);
  --font-serif: var(--font-inter);
```

(Default fallback = Inter for all themes; overridden only for slate below.)

- [ ] **Step 4: Add the conditional override block in `globals.css`**

Add this block in `globals.css` after the `:root { ... }` block (after line 100, before `.dark { ... }`):

```css
/* Neo-Olympian serif activation — Cinzel/Cormorant only when slate theme is active */
:root[data-theme="slate"] {
  --font-display: var(--font-cinzel);
  --font-serif: var(--font-cormorant);
}
```

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit` && `bunx eslint src/app/layout.tsx`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/app/layout.tsx src/app/globals.css
git commit -m "feat(theme): add Cinzel + Cormorant fonts, activate on slate theme only"
```

---

### Task 3: Add 3 utility classes + keyframe in `globals.css`

**Files:**
- Modify: `src/app/globals.css` (append after the `.glass-card:hover` block, around line 213)

**Interfaces:**
- Consumes: existing `--primary`, `--card`, `--border`, `--background`, `--foreground`, `--radius-md`, `--ease-out` tokens (all already defined).
- Produces: three opt-in CSS classes (`.obsidian-void`, `.orbital-loader`, `.gold-card`) usable by any component; theme-agnostic (use `var(--*)` so they adapt to the active theme, with strongest effect under Neo-Olympian).

- [ ] **Step 1: Add the utility classes + keyframe**

Append this block to `src/app/globals.css` (after the existing `.glass-card:hover` rule, before the `[data-slot="tabs-content"]` animation block):

```css
/* ── Neo-Olympian utility classes (theme-agnostic via var(--*)) ─────────── */

/* Obsidian void — radial background + faint geometric dust (CSS-only, static) */
.obsidian-void {
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 6%, transparent), transparent 60%),
    radial-gradient(ellipse 100% 80% at 50% 100%, color-mix(in oklab, var(--card) 50%, transparent), transparent 70%),
    var(--background);
  position: relative;
}
.obsidian-void::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, color-mix(in oklab, var(--primary) 20%, transparent) 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: 0.04;
  pointer-events: none;
}

/* Orbital loader — spinner ring (AI "calculating" feel); reduced-motion safe */
.orbital-loader {
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 9999px;
  border: 2px solid color-mix(in oklab, var(--primary) 25%, transparent);
  border-top-color: var(--primary);
  animation: orbital-spin 0.8s linear infinite;
}
@keyframes orbital-spin {
  to { transform: rotate(360deg); }
}

/* Gold card — glassmorphism + gold border + inner glow (opt-in; not a glass-card replacement) */
.gold-card {
  background: color-mix(in oklab, var(--card) 75%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid color-mix(in oklab, var(--primary) 30%, var(--border));
  border-radius: var(--radius-md);
  box-shadow:
    0 0 0 1px color-mix(in oklab, var(--primary) 8%, transparent) inset,
    0 20px 60px color-mix(in oklab, var(--foreground) 8%, transparent);
  transition: transform 250ms var(--ease-out), box-shadow 250ms var(--ease-out), border-color 250ms var(--ease-out);
}
.gold-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
  box-shadow:
    0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent) inset,
    0 24px 70px color-mix(in oklab, var(--primary) 12%, transparent);
}

/* ── end Neo-Olympian utilities ─────────────────────────────────────────── */
```

- [ ] **Step 2: Lint (globals.css is not in eslint's JS scope, but verify the build doesn't choke)**

Run: `bunx tsc --noEmit`
Expected: 0 errors (CSS-only change; TS unaffected)

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat(theme): add obsidian-void, orbital-loader, gold-card utility classes"
```

---

### Task 4: Unit test for the Neo-Olympian palette + metadata

**Files:**
- Create: `src/lib/themes.test.ts`

**Interfaces:**
- Consumes: Task 1's `THEME_CSS.slate`, `THEMES`, `THEME_INIT_SCRIPT` exports from `src/lib/themes.ts`.
- Produces: none (test-only file).

- [ ] **Step 1: Write the failing test**

Create `src/lib/themes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `bun test src/lib/themes.test.ts`
Expected: PASS (6 tests). If any fails, the palette string in `themes.ts` doesn't match — fix the source, not the test (the test encodes the spec's required values).

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `bun run test`
Expected: 103/103 files pass (now including the new themes.test.ts → 104 files, 0 fail)

- [ ] **Step 4: Commit**

```bash
git add src/lib/themes.test.ts
git commit -m "test(theme): assert Neo-Olympian palette + metadata + FOUC script"
```

---

## Self-Review

**1. Spec coverage:**
- Replace `slate` palette (light+dark oklch) → Task 1 ✓
- Cinzel + Cormorant via next/font, conditional on `data-theme="slate"` → Task 2 ✓
- 3 utility classes (`.obsidian-void`, `.orbital-loader`, `.gold-card`) + keyframe → Task 3 ✓
- Chart tokens overridden → Task 1 (in the palette string) + asserted in Task 4 ✓
- `--font-sans` NOT overridden globally; opt-in utilities → Task 2 `@theme inline` defaults to `var(--font-inter)` ✓
- Other themes untouched → Task 4 test asserts enterprise + forest intact ✓
- FOUC safety (data-theme set before paint) → no change needed (existing script handles it); Task 4 asserts script references data-theme + slate ✓
- Reduced-motion for orbital-loader → covered by existing globals.css media query (animation-duration: 0.001ms) ✓

**2. Placeholder scan:** none — all steps carry full code.

**3. Type consistency:** `ThemeId` stays `'slate'`; `THEMES`/`THEME_CSS` shapes unchanged (only string contents + metadata fields). Font variable names `--font-cinzel`/`--font-cormorant` match between layout.tsx and globals.css. Utility class names `.obsidian-void`/`.orbital-loader`/`.gold-card` match spec. ✓
