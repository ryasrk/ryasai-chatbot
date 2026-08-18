# Neo-Olympian Theme (Replace `slate`) — Design

Date: 2026-08-05
Status: Approved (brainstorming complete)

## Problem

The app has 5 themes in `src/lib/themes.ts` (`enterprise`, `midnight`, `forest`, `slate`, `sandstone`). The `slate` theme is a plain steel-gray + violet palette. The user wants to replace it with **NEO-OLYMPIAN / Divine Intelligence** — a premium aesthetic: obsidian + marble + brushed gold, classical serif headings × modern telemetry, glassmorphism cards, and an obsidian-void background. The reference spec describes a far richer system than a color swap.

## Goal

Replace the `slate` theme's CSS variable block with the Neo-Olympian palette (oklch), add Cinzel + Cormorant Garamond serif fonts activated **only** when this theme is active, and add 3 CSS-only utility classes (`.obsidian-void`, `.orbital-loader`, `.gold-card`) that deliver the obsidian/glass/orbital effects. The theme id stays `'slate'` so existing user preferences and storage keep working.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| How Neo-Olympian is installed | Replace existing `slate` theme (id `'slate'` stays; name/description/swatch/palette change) |
| Serif typography | Add Cinzel (display) + Cormorant Garamond (serif) via `next/font/google`; activate conditionally via `:root[data-theme="slate"]` selector — `--font-sans` is NOT overridden globally; components opt in via `font-display` / `font-serif` utilities |
| Visual effects | 3 CSS-only utility classes (`.obsidian-void`, `.orbital-loader`, `.gold-card`); no JS canvas / particles animation |
| Chart palette | Override `--chart-1..5` when Neo-Olympian active (gold / marble / gray / bright-gold / crimson) |
| Implementation approach | A — full slate override + conditional fonts via `data-theme` selector + utility classes |
| Backend / components | Untouched — only `themes.ts`, `layout.tsx`, `globals.css`, + new test file |

## Palette (oklch — converted from reference hex)

### Dark (primary mode — Obsidian + Gold)

| Token | oklch | Reference |
|---|---|---|
| `--background` | `oklch(0.144 0.010 169.9)` | #080A0B near-black obsidian |
| `--card` | `oklch(0.191 0.014 167.1)` | #111416 surface |
| `--popover` | `oklch(0.191 0.014 167.1)` | #111416 surface |
| `--foreground` | `oklch(0.933 0.033 190.0)` | #EDE9DF text |
| `--card-foreground` | `oklch(0.933 0.033 190.0)` | text |
| `--popover-foreground` | `oklch(0.933 0.033 190.0)` | text |
| `--muted` | `oklch(0.22 0.012 169.9)` | surface-tinged muted |
| `--muted-foreground` | `oklch(0.608 0.022 192.5)` | #85837C muted text |
| `--primary` | `oklch(0.706 0.069 282.7)` | #C9A45C primary gold |
| `--primary-foreground` | `oklch(0.144 0.010 169.9)` | obsidian (text on gold) |
| `--secondary` | `oklch(0.24 0.015 167.1)` | surface-elevated |
| `--secondary-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--accent` | `oklch(0.760 0.070 275.8)` | #D8B76A AI glow (secondary gold) |
| `--accent-foreground` | `oklch(0.144 0.010 169.9)` | obsidian |
| `--destructive` | `oklch(0.467 0.097 353.8)` | #8F4141 muted crimson |
| `--destructive-foreground` | `oklch(0.933 0.033 190.0)` | text |
| `--success` | `oklch(0.60 0.10 155)` | jade (compatible with gold palette) |
| `--success-foreground` | `oklch(0.144 0.010 169.9)` | obsidian |
| `--warning` | `oklch(0.75 0.12 70)` | warm amber |
| `--warning-foreground` | `oklch(0.144 0.010 169.9)` | obsidian |
| `--info` | `oklch(0.70 0.06 250)` | muted blue-gray (keeps contrast on gold UI) |
| `--info-foreground` | `oklch(0.144 0.010 169.9)` | obsidian |
| `--border` | `oklch(0.25 0.015 169.9)` | thin gray-gold |
| `--input` | `oklch(0.25 0.015 169.9)` | same as border |
| `--ring` | `oklch(0.706 0.069 282.7)` | primary gold focus ring |
| `--sidebar` | `oklch(0.165 0.010 169.9)` | slightly darker than bg |
| `--sidebar-foreground` | `oklch(0.933 0.033 190.0)` | text |
| `--sidebar-primary` | `oklch(0.706 0.069 282.7)` | gold |
| `--sidebar-primary-foreground` | `oklch(0.144 0.010 169.9)` | obsidian |
| `--sidebar-accent` | `oklch(0.22 0.012 169.9)` | muted |
| `--sidebar-accent-foreground` | `oklch(0.933 0.033 190.0)` | text |
| `--sidebar-border` | `oklch(0.25 0.015 169.9)` | border |
| `--sidebar-ring` | `oklch(0.706 0.069 282.7)` | gold |
| `--hover` | `oklch(0.215 0.012 169.9)` | hover surface |
| `--chart-1` | `oklch(0.706 0.069 282.7)` | gold primary line |
| `--chart-2` | `oklch(0.918 0.032 190.4)` | marble secondary |
| `--chart-3` | `oklch(0.608 0.022 192.5)` | gray tertiary |
| `--chart-4` | `oklch(0.846 0.063 273.0)` | #F2D28A bright gold |
| `--chart-5` | `oklch(0.467 0.097 353.8)` | muted crimson |

### Light (marble variant)

| Token | oklch | Note |
|---|---|---|
| `--background` | `oklch(0.918 0.032 190.4)` | #E8E4DA marble |
| `--card` | `oklch(0.97 0.01 190)` | off-white marble surface |
| `--popover` | `oklch(0.97 0.01 190)` | same |
| `--foreground` | `oklch(0.191 0.014 167.1)` | #111416 obsidian text |
| `--card-foreground` | `oklch(0.191 0.014 167.1)` | obsidian |
| `--popover-foreground` | `oklch(0.191 0.014 167.1)` | obsidian |
| `--muted` | `oklch(0.90 0.015 190)` | muted marble |
| `--muted-foreground` | `oklch(0.45 0.02 192)` | mid marble-gray |
| `--primary` | `oklch(0.65 0.085 282.7)` | gold (slightly deeper for light bg contrast) |
| `--primary-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--secondary` | `oklch(0.88 0.02 190)` | secondary marble |
| `--secondary-foreground` | `oklch(0.25 0.015 167.1)` | obsidian |
| `--accent` | `oklch(0.70 0.07 275.8)` | AI glow gold |
| `--accent-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--destructive` | `oklch(0.45 0.10 353.8)` | muted crimson |
| `--destructive-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--success` | `oklch(0.52 0.12 155)` | jade |
| `--success-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--warning` | `oklch(0.68 0.13 70)` | amber |
| `--warning-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--info` | `oklch(0.60 0.06 250)` | blue-gray |
| `--info-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--border` | `oklch(0.85 0.015 190)` | marble border |
| `--input` | `oklch(0.85 0.015 190)` | same |
| `--ring` | `oklch(0.65 0.085 282.7)` | gold ring |
| `--sidebar` | `oklch(0.94 0.012 190)` | marble sidebar |
| `--sidebar-foreground` | `oklch(0.25 0.015 167.1)` | obsidian |
| `--sidebar-primary` | `oklch(0.65 0.085 282.7)` | gold |
| `--sidebar-primary-foreground` | `oklch(0.918 0.032 190.4)` | marble |
| `--sidebar-accent` | `oklch(0.90 0.015 190)` | muted marble |
| `--sidebar-accent-foreground` | `oklch(0.191 0.014 167.1)` | obsidian |
| `--sidebar-border` | `oklch(0.85 0.015 190)` | border |
| `--sidebar-ring` | `oklch(0.65 0.085 282.7)` | gold |
| `--hover` | `oklch(0.93 0.012 190)` | hover marble |
| `--chart-1..5` | (same hues as dark, slightly deeper lightness) | gold/marble/gray/bright-gold/crimson |

`--radius` stays `16px` (consistent with other themes; "small–medium radius" per reference).

## Typography

**New fonts via `next/font/google` in `src/app/layout.tsx`:**

```ts
const cinzel = Cinzel({ variable: "--font-cinzel", subsets: ["latin"], preload: false });
const cormorant = Cormorant_Garamond({ variable: "--font-cormorant", subsets: ["latin"], preload: false });
```

Add both `.variable` to `<body>` className alongside the existing `inter.variable` + `jetbrains.variable`.

**Conditional activation (globals.css):**

```css
@theme inline {
  /* ...existing tokens... */
  --font-display: var(--font-inter);   /* default fallback = Inter for non-Olympian themes */
  --font-serif: var(--font-inter);     /* default fallback = Inter */
}

:root[data-theme="slate"] {
  --font-display: var(--font-cinzel);
  --font-serif: var(--font-cormorant);
}
```

This makes `font-display` / `font-serif` Tailwind utilities available app-wide; they resolve to Cinzel / Cormorant **only** when `data-theme="slate"` is on `<html>`. The `--font-sans` token is NOT overridden globally — existing components keep Inter. Headings that want the serif identity opt in via `className="font-serif"` or `className="font-display"`.

**FOUC safety:** `THEME_INIT_SCRIPT` (already in `layout.tsx <head>`) sets `data-theme` before first paint, so the `:root[data-theme="slate"]` selector is active from frame one — no Inter→serif flash.

## Utility Classes (CSS-only, theme-agnostic)

### `.obsidian-void` — radial void background

```css
.obsidian-void {
  background:
    radial-gradient(ellipse 80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 6%, transparent), transparent 60%),
    radial-gradient(ellipse 100% 80% at 50% 100%, color-mix(in oklab, var(--card) 50%, transparent), transparent 70%),
    var(--background);
  position: relative;
}
.obsidian-void::before {
  content: "";
  position: absolute; inset: 0;
  background-image: radial-gradient(circle, color-mix(in oklab, var(--primary) 20%, transparent) 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: 0.04;
  pointer-events: none;
}
```

### `.orbital-loader` — spinner ring

```css
.orbital-loader {
  width: 1.25rem; height: 1.25rem;
  border-radius: 9999px;
  border: 2px solid color-mix(in oklab, var(--primary) 25%, transparent);
  border-top-color: var(--primary);
  animation: orbital-spin 0.8s linear infinite;
}
@keyframes orbital-spin { to { transform: rotate(360deg); } }
```

Reduced-motion: covered by the existing `@media (prefers-reduced-motion: reduce)` block in globals.css (animation-duration: 0.001ms).

### `.gold-card` — glassmorphism + gold border + inner glow

```css
.gold-card {
  background: color-mix(in oklab, var(--card) 75%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid color-mix(in oklab, var(--primary) 30%, var(--border));
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 8%, transparent) inset,
              0 20px 60px color-mix(in oklab, var(--foreground) 8%, transparent);
  transition: transform 250ms var(--ease-out), box-shadow 250ms var(--ease-out), border-color 250ms var(--ease-out);
}
.gold-card:hover {
  transform: translateY(-2px);
  border-color: color-mix(in oklab, var(--primary) 50%, var(--border));
  box-shadow: 0 0 0 1px color-mix(in oklab, var(--primary) 15%, transparent) inset,
              0 24px 70px color-mix(in oklab, var(--primary) 12%, transparent);
}
```

Opt-in; does not replace the existing `.glass-card`.

## Integration

| File | Change |
|---|---|
| `src/lib/themes.ts` | Replace `THEME_CSS.slate` light+dark blocks with Neo-Olympian palette above; update `THEMES` `slate` entry name→"Neo-Olympian", description, swatch→`['#C9A45C', '#D8B76A', '#080A0B']` |
| `src/app/layout.tsx` | Import `Cinzel`, `Cormorant_Garamond` from `next/font/google`; add `variable` + `preload:false`; append both `.variable` to `<body>` className |
| `src/app/globals.css` | Add `--font-display`/`--font-serif` to `@theme inline` (default = `var(--font-inter)`); add `:root[data-theme="slate"]` override block; add `.obsidian-void`, `.orbital-loader`, `.gold-card`, `@keyframes orbital-spin` |

**Unchanged:** tailwind.config.ts, all UI components, backend, other themes, the FOUC script (it already handles arbitrary theme ids).

## Testing

- **Unit test** (`src/lib/themes.test.ts` — new file):
  - `THEME_CSS.slate.dark` contains `oklch(0.706 0.069 282.7)` (primary gold) — proves the palette swap landed
  - `THEME_CSS.slate.light` contains the marble background token
  - `THEMES` array length is still 5
  - `THEMES` `slate` entry name is "Neo-Olympian"
  - `THEME_INIT_SCRIPT` is a non-empty string containing `data-theme`
- **Manual verification:**
  - Settings → Theme → select "Neo-Olympian" → dark mode: obsidian bg, gold primary, marble text, gold-tinted borders
  - Light mode: marble bg, obsidian text, gold primary
  - Chart colors override (gold/marble/gray line in dashboard charts)
  - No FOUC (font + palette stable from first paint)
  - `.obsidian-void`, `.orbital-loader`, `.gold-card` render correctly
  - `prefers-reduced-motion` disables orbital-loader animation
  - Switch to another theme (e.g. enterprise) → serif fonts revert to Inter, palette reverts — no bleed
- **Typecheck + lint + build** clean.

## Out of Scope

- Terminology rename (Olympian Core, Deities, Oracle, Augury, Watchtower, etc.) — visual theme only
- Hero/landing page redesign with statue/orbit visual anchor
- Sidebar restructure (the "Olympian Control Room" nav tree)
- Computer-vision bounding-box gold/ivory styling
- Gold-particle micro-interactions requiring JS canvas
- These can follow as separate tasks built on this visual foundation.
