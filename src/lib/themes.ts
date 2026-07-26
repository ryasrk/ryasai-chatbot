/**
 * Theme definitions — ENTERPRISE BLUE system (5 themes).
 *
 * Apply by injecting the matching CSS variable block onto :root. The
 * defaults live in globals.css `:root` / `.dark`, so applying "enterprise"
 * is a no-op on first paint; other themes override with their palette.
 *
 * Each theme has light + dark variants, composed independently.
 */

export type ThemeId = 'enterprise' | 'midnight' | 'forest' | 'slate' | 'sandstone'

export interface ThemeDef {
  id: ThemeId
  name: string
  description: string
  swatch: string[]
}

export const THEMES: ThemeDef[] = [
  {
    id: 'enterprise',
    name: 'Enterprise Blue',
    description: 'Professional blue, AI purple, high accessibility',
    swatch: ['#2563EB', '#7C3AED', '#E8EEF7'],
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Night blue with cyan accents',
    swatch: ['#1E40AF', '#06B6D4', '#0F1B33'],
  },
  {
    id: 'forest',
    name: 'Forest',
    description: 'Emerald green with lime accents',
    swatch: ['#059669', '#84CC16', '#ECFDF5'],
  },
  {
    id: 'slate',
    name: 'Slate',
    description: 'Steel gray with violet accents',
    swatch: ['#475569', '#7C3AED', '#F1F5F9'],
  },
  {
    id: 'sandstone',
    name: 'Sandstone',
    description: 'Warm terracotta with gold accents',
    swatch: ['#C2410C', '#D97706', '#FDF8F3'],
  },
]

/** CSS variable blocks per theme. Injected onto :root via applyTheme. */
export const THEME_CSS: Record<ThemeId, { light: string; dark: string }> = {
  enterprise: {
    light: `
      --radius: 16px;
      --background: oklch(0.98 0.01 250); --foreground: oklch(0.20 0.03 260);
      --card: oklch(1 0 0); --card-foreground: oklch(0.20 0.03 260);
      --popover: oklch(1 0 0); --popover-foreground: oklch(0.20 0.03 260);
      --primary: oklch(0.55 0.20 255); --primary-foreground: oklch(0.98 0.01 250);
      --secondary: oklch(0.96 0.02 255); --secondary-foreground: oklch(0.30 0.03 260);
      --muted: oklch(0.96 0.01 250); --muted-foreground: oklch(0.55 0.02 260);
      --accent: oklch(0.60 0.22 290); --accent-foreground: oklch(0.98 0.01 290);
      --destructive: oklch(0.55 0.24 27); --destructive-foreground: oklch(0.98 0.01 27);
      --success: oklch(0.60 0.20 145); --success-foreground: oklch(0.98 0.01 145);
      --warning: oklch(0.65 0.18 65); --warning-foreground: oklch(0.20 0.03 65);
      --info: oklch(0.55 0.20 240); --info-foreground: oklch(0.98 0.01 240);
      --border: oklch(0.90 0.01 255); --input: oklch(0.90 0.01 255); --ring: oklch(0.55 0.20 255);
      --sidebar: oklch(0.97 0.01 255); --sidebar-foreground: oklch(0.30 0.03 260);
      --sidebar-primary: oklch(0.55 0.20 255); --sidebar-primary-foreground: oklch(0.98 0.01 250);
      --sidebar-accent: oklch(0.95 0.02 255); --sidebar-accent-foreground: oklch(0.20 0.03 260);
      --sidebar-border: oklch(0.90 0.01 255); --sidebar-ring: oklch(0.55 0.20 255);
      --hover: oklch(0.93 0.01 255);
      --chart-1: oklch(0.55 0.20 255); --chart-2: oklch(0.60 0.22 290); --chart-3: oklch(0.60 0.20 145); --chart-4: oklch(0.65 0.18 65); --chart-5: oklch(0.55 0.24 27);
    `,
    dark: `
      --radius: 16px;
      --background: oklch(0.15 0.02 260); --foreground: oklch(0.95 0.01 250);
      --card: oklch(0.20 0.02 260); --card-foreground: oklch(0.95 0.01 250);
      --popover: oklch(0.20 0.02 260); --popover-foreground: oklch(0.95 0.01 250);
      --primary: oklch(0.65 0.20 255); --primary-foreground: oklch(0.15 0.02 260);
      --secondary: oklch(0.25 0.02 260); --secondary-foreground: oklch(0.90 0.01 250);
      --muted: oklch(0.25 0.02 260); --muted-foreground: oklch(0.65 0.02 250);
      --accent: oklch(0.65 0.22 290); --accent-foreground: oklch(0.15 0.02 260);
      --destructive: oklch(0.65 0.24 27); --destructive-foreground: oklch(0.15 0.02 27);
      --success: oklch(0.65 0.20 145); --success-foreground: oklch(0.15 0.02 145);
      --warning: oklch(0.70 0.18 65); --warning-foreground: oklch(0.15 0.03 65);
      --info: oklch(0.65 0.20 240); --info-foreground: oklch(0.15 0.02 240);
      --border: oklch(0.30 0.02 260); --input: oklch(0.30 0.02 260); --ring: oklch(0.65 0.20 255);
      --sidebar: oklch(0.18 0.02 260); --sidebar-foreground: oklch(0.90 0.01 250);
      --sidebar-primary: oklch(0.65 0.20 255); --sidebar-primary-foreground: oklch(0.15 0.02 260);
      --sidebar-accent: oklch(0.25 0.02 260); --sidebar-accent-foreground: oklch(0.95 0.01 250);
      --sidebar-border: oklch(0.30 0.02 260); --sidebar-ring: oklch(0.65 0.20 255);
      --hover: oklch(0.22 0.02 260);
      --chart-1: oklch(0.65 0.20 255); --chart-2: oklch(0.65 0.22 290); --chart-3: oklch(0.65 0.20 145); --chart-4: oklch(0.70 0.18 65); --chart-5: oklch(0.65 0.24 27);
    `,
  },
  midnight: {
    light: `
      --radius: 16px;
      --background: oklch(0.98 0.01 250); --foreground: oklch(0.18 0.04 250);
      --card: oklch(1 0 0); --card-foreground: oklch(0.18 0.04 250);
      --popover: oklch(1 0 0); --popover-foreground: oklch(0.18 0.04 250);
      --primary: oklch(0.50 0.22 250); --primary-foreground: oklch(0.98 0.01 250);
      --secondary: oklch(0.96 0.02 250); --secondary-foreground: oklch(0.28 0.04 250);
      --muted: oklch(0.96 0.01 250); --muted-foreground: oklch(0.52 0.03 250);
      --accent: oklch(0.60 0.20 200); --accent-foreground: oklch(0.15 0.02 200);
      --destructive: oklch(0.55 0.24 27); --destructive-foreground: oklch(0.98 0.01 27);
      --success: oklch(0.60 0.20 145); --success-foreground: oklch(0.98 0.01 145);
      --warning: oklch(0.65 0.18 65); --warning-foreground: oklch(0.20 0.03 65);
      --info: oklch(0.55 0.20 200); --info-foreground: oklch(0.98 0.01 200);
      --border: oklch(0.90 0.01 250); --input: oklch(0.90 0.01 250); --ring: oklch(0.50 0.22 250);
      --sidebar: oklch(0.97 0.01 250); --sidebar-foreground: oklch(0.28 0.04 250);
      --sidebar-primary: oklch(0.50 0.22 250); --sidebar-primary-foreground: oklch(0.98 0.01 250);
      --sidebar-accent: oklch(0.95 0.02 250); --sidebar-accent-foreground: oklch(0.18 0.04 250);
      --sidebar-border: oklch(0.90 0.01 250); --sidebar-ring: oklch(0.50 0.22 250);
      --hover: oklch(0.93 0.02 250);
      --chart-1: oklch(0.50 0.22 250); --chart-2: oklch(0.60 0.20 200); --chart-3: oklch(0.60 0.20 145); --chart-4: oklch(0.65 0.18 65); --chart-5: oklch(0.55 0.24 27);
    `,
    dark: `
      --radius: 16px;
      --background: oklch(0.14 0.03 250); --foreground: oklch(0.93 0.02 250);
      --card: oklch(0.19 0.03 250); --card-foreground: oklch(0.93 0.02 250);
      --popover: oklch(0.19 0.03 250); --popover-foreground: oklch(0.93 0.02 250);
      --primary: oklch(0.65 0.22 250); --primary-foreground: oklch(0.14 0.03 250);
      --secondary: oklch(0.24 0.03 250); --secondary-foreground: oklch(0.88 0.02 250);
      --muted: oklch(0.24 0.03 250); --muted-foreground: oklch(0.62 0.03 250);
      --accent: oklch(0.70 0.20 200); --accent-foreground: oklch(0.14 0.03 250);
      --destructive: oklch(0.65 0.24 27); --destructive-foreground: oklch(0.14 0.02 27);
      --success: oklch(0.65 0.20 145); --success-foreground: oklch(0.14 0.02 145);
      --warning: oklch(0.70 0.18 65); --warning-foreground: oklch(0.14 0.03 65);
      --info: oklch(0.65 0.20 200); --info-foreground: oklch(0.14 0.03 200);
      --border: oklch(0.28 0.03 250); --input: oklch(0.28 0.03 250); --ring: oklch(0.65 0.22 250);
      --sidebar: oklch(0.17 0.03 250); --sidebar-foreground: oklch(0.88 0.02 250);
      --sidebar-primary: oklch(0.65 0.22 250); --sidebar-primary-foreground: oklch(0.14 0.03 250);
      --sidebar-accent: oklch(0.23 0.03 250); --sidebar-accent-foreground: oklch(0.93 0.02 250);
      --sidebar-border: oklch(0.28 0.03 250); --sidebar-ring: oklch(0.65 0.22 250);
      --hover: oklch(0.21 0.03 250);
      --chart-1: oklch(0.65 0.22 250); --chart-2: oklch(0.70 0.20 200); --chart-3: oklch(0.65 0.20 145); --chart-4: oklch(0.70 0.18 65); --chart-5: oklch(0.65 0.24 27);
    `,
  },
  forest: {
    light: `
      --radius: 16px;
      --background: oklch(0.98 0.01 155); --foreground: oklch(0.20 0.04 155);
      --card: oklch(1 0 0); --card-foreground: oklch(0.20 0.04 155);
      --popover: oklch(1 0 0); --popover-foreground: oklch(0.20 0.04 155);
      --primary: oklch(0.55 0.18 155); --primary-foreground: oklch(0.98 0.01 155);
      --secondary: oklch(0.96 0.02 155); --secondary-foreground: oklch(0.30 0.04 155);
      --muted: oklch(0.96 0.01 155); --muted-foreground: oklch(0.52 0.03 155);
      --accent: oklch(0.65 0.22 130); --accent-foreground: oklch(0.15 0.02 130);
      --destructive: oklch(0.55 0.24 27); --destructive-foreground: oklch(0.98 0.01 27);
      --success: oklch(0.60 0.20 145); --success-foreground: oklch(0.98 0.01 145);
      --warning: oklch(0.65 0.18 65); --warning-foreground: oklch(0.20 0.03 65);
      --info: oklch(0.55 0.18 180); --info-foreground: oklch(0.98 0.01 180);
      --border: oklch(0.90 0.01 155); --input: oklch(0.90 0.01 155); --ring: oklch(0.55 0.18 155);
      --sidebar: oklch(0.97 0.01 155); --sidebar-foreground: oklch(0.30 0.04 155);
      --sidebar-primary: oklch(0.55 0.18 155); --sidebar-primary-foreground: oklch(0.98 0.01 155);
      --sidebar-accent: oklch(0.95 0.02 155); --sidebar-accent-foreground: oklch(0.20 0.04 155);
      --sidebar-border: oklch(0.90 0.01 155); --sidebar-ring: oklch(0.55 0.18 155);
      --hover: oklch(0.93 0.02 155);
      --chart-1: oklch(0.55 0.18 155); --chart-2: oklch(0.65 0.22 130); --chart-3: oklch(0.60 0.20 145); --chart-4: oklch(0.65 0.18 65); --chart-5: oklch(0.55 0.24 27);
    `,
    dark: `
      --radius: 16px;
      --background: oklch(0.15 0.02 155); --foreground: oklch(0.93 0.02 155);
      --card: oklch(0.20 0.02 155); --card-foreground: oklch(0.93 0.02 155);
      --popover: oklch(0.20 0.02 155); --popover-foreground: oklch(0.93 0.02 155);
      --primary: oklch(0.65 0.18 155); --primary-foreground: oklch(0.15 0.02 155);
      --secondary: oklch(0.25 0.02 155); --secondary-foreground: oklch(0.88 0.02 155);
      --muted: oklch(0.25 0.02 155); --muted-foreground: oklch(0.62 0.03 155);
      --accent: oklch(0.70 0.22 130); --accent-foreground: oklch(0.15 0.02 155);
      --destructive: oklch(0.65 0.24 27); --destructive-foreground: oklch(0.14 0.02 27);
      --success: oklch(0.65 0.20 145); --success-foreground: oklch(0.14 0.02 145);
      --warning: oklch(0.70 0.18 65); --warning-foreground: oklch(0.14 0.03 65);
      --info: oklch(0.65 0.18 180); --info-foreground: oklch(0.14 0.02 180);
      --border: oklch(0.30 0.02 155); --input: oklch(0.30 0.02 155); --ring: oklch(0.65 0.18 155);
      --sidebar: oklch(0.18 0.02 155); --sidebar-foreground: oklch(0.88 0.02 155);
      --sidebar-primary: oklch(0.65 0.18 155); --sidebar-primary-foreground: oklch(0.15 0.02 155);
      --sidebar-accent: oklch(0.25 0.02 155); --sidebar-accent-foreground: oklch(0.93 0.02 155);
      --sidebar-border: oklch(0.30 0.02 155); --sidebar-ring: oklch(0.65 0.18 155);
      --hover: oklch(0.22 0.02 155);
      --chart-1: oklch(0.65 0.18 155); --chart-2: oklch(0.70 0.22 130); --chart-3: oklch(0.65 0.20 145); --chart-4: oklch(0.70 0.18 65); --chart-5: oklch(0.65 0.24 27);
    `,
  },
  slate: {
    light: `
      --radius: 16px;
      --background: oklch(0.98 0.01 260); --foreground: oklch(0.20 0.02 260);
      --card: oklch(1 0 0); --card-foreground: oklch(0.20 0.02 260);
      --popover: oklch(1 0 0); --popover-foreground: oklch(0.20 0.02 260);
      --primary: oklch(0.50 0.10 255); --primary-foreground: oklch(0.98 0.01 260);
      --secondary: oklch(0.96 0.01 260); --secondary-foreground: oklch(0.30 0.02 260);
      --muted: oklch(0.96 0.01 260); --muted-foreground: oklch(0.52 0.02 260);
      --accent: oklch(0.55 0.20 290); --accent-foreground: oklch(0.98 0.01 290);
      --destructive: oklch(0.55 0.24 27); --destructive-foreground: oklch(0.98 0.01 27);
      --success: oklch(0.60 0.20 145); --success-foreground: oklch(0.98 0.01 145);
      --warning: oklch(0.65 0.18 65); --warning-foreground: oklch(0.20 0.03 65);
      --info: oklch(0.50 0.15 240); --info-foreground: oklch(0.98 0.01 240);
      --border: oklch(0.90 0.01 260); --input: oklch(0.90 0.01 260); --ring: oklch(0.50 0.10 255);
      --sidebar: oklch(0.97 0.01 260); --sidebar-foreground: oklch(0.30 0.02 260);
      --sidebar-primary: oklch(0.50 0.10 255); --sidebar-primary-foreground: oklch(0.98 0.01 260);
      --sidebar-accent: oklch(0.95 0.01 260); --sidebar-accent-foreground: oklch(0.20 0.02 260);
      --sidebar-border: oklch(0.90 0.01 260); --sidebar-ring: oklch(0.50 0.10 255);
      --hover: oklch(0.93 0.01 260);
      --chart-1: oklch(0.50 0.10 255); --chart-2: oklch(0.55 0.20 290); --chart-3: oklch(0.60 0.20 145); --chart-4: oklch(0.65 0.18 65); --chart-5: oklch(0.55 0.24 27);
    `,
    dark: `
      --radius: 16px;
      --background: oklch(0.15 0.015 260); --foreground: oklch(0.93 0.01 260);
      --card: oklch(0.20 0.015 260); --card-foreground: oklch(0.93 0.01 260);
      --popover: oklch(0.20 0.015 260); --popover-foreground: oklch(0.93 0.01 260);
      --primary: oklch(0.60 0.10 255); --primary-foreground: oklch(0.15 0.015 260);
      --secondary: oklch(0.25 0.015 260); --secondary-foreground: oklch(0.88 0.01 260);
      --muted: oklch(0.25 0.015 260); --muted-foreground: oklch(0.62 0.02 260);
      --accent: oklch(0.65 0.20 290); --accent-foreground: oklch(0.15 0.015 260);
      --destructive: oklch(0.65 0.24 27); --destructive-foreground: oklch(0.14 0.02 27);
      --success: oklch(0.65 0.20 145); --success-foreground: oklch(0.14 0.02 145);
      --warning: oklch(0.70 0.18 65); --warning-foreground: oklch(0.14 0.03 65);
      --info: oklch(0.60 0.15 240); --info-foreground: oklch(0.14 0.02 240);
      --border: oklch(0.30 0.015 260); --input: oklch(0.30 0.015 260); --ring: oklch(0.60 0.10 255);
      --sidebar: oklch(0.18 0.015 260); --sidebar-foreground: oklch(0.88 0.01 260);
      --sidebar-primary: oklch(0.60 0.10 255); --sidebar-primary-foreground: oklch(0.15 0.015 260);
      --sidebar-accent: oklch(0.25 0.015 260); --sidebar-accent-foreground: oklch(0.93 0.01 260);
      --sidebar-border: oklch(0.30 0.015 260); --sidebar-ring: oklch(0.60 0.10 255);
      --hover: oklch(0.22 0.015 260);
      --chart-1: oklch(0.60 0.10 255); --chart-2: oklch(0.65 0.20 290); --chart-3: oklch(0.65 0.20 145); --chart-4: oklch(0.70 0.18 65); --chart-5: oklch(0.65 0.24 27);
    `,
  },
  sandstone: {
    light: `
      --radius: 16px;
      --background: oklch(0.98 0.01 50); --foreground: oklch(0.22 0.03 40);
      --card: oklch(1 0 0); --card-foreground: oklch(0.22 0.03 40);
      --popover: oklch(1 0 0); --popover-foreground: oklch(0.22 0.03 40);
      --primary: oklch(0.55 0.18 40); --primary-foreground: oklch(0.98 0.01 50);
      --secondary: oklch(0.96 0.02 50); --secondary-foreground: oklch(0.30 0.03 40);
      --muted: oklch(0.96 0.01 50); --muted-foreground: oklch(0.52 0.03 50);
      --accent: oklch(0.70 0.18 85); --accent-foreground: oklch(0.18 0.02 85);
      --destructive: oklch(0.55 0.24 27); --destructive-foreground: oklch(0.98 0.01 27);
      --success: oklch(0.60 0.20 145); --success-foreground: oklch(0.98 0.01 145);
      --warning: oklch(0.68 0.18 65); --warning-foreground: oklch(0.20 0.03 65);
      --info: oklch(0.55 0.18 60); --info-foreground: oklch(0.98 0.01 60);
      --border: oklch(0.90 0.01 50); --input: oklch(0.90 0.01 50); --ring: oklch(0.55 0.18 40);
      --sidebar: oklch(0.97 0.01 50); --sidebar-foreground: oklch(0.30 0.03 40);
      --sidebar-primary: oklch(0.55 0.18 40); --sidebar-primary-foreground: oklch(0.98 0.01 50);
      --sidebar-accent: oklch(0.95 0.02 50); --sidebar-accent-foreground: oklch(0.22 0.03 40);
      --sidebar-border: oklch(0.90 0.01 50); --sidebar-ring: oklch(0.55 0.18 40);
      --hover: oklch(0.93 0.02 50);
      --chart-1: oklch(0.55 0.18 40); --chart-2: oklch(0.70 0.18 85); --chart-3: oklch(0.60 0.20 145); --chart-4: oklch(0.68 0.18 65); --chart-5: oklch(0.55 0.24 27);
    `,
    dark: `
      --radius: 16px;
      --background: oklch(0.15 0.02 40); --foreground: oklch(0.93 0.02 50);
      --card: oklch(0.20 0.02 40); --card-foreground: oklch(0.93 0.02 50);
      --popover: oklch(0.20 0.02 40); --popover-foreground: oklch(0.93 0.02 50);
      --primary: oklch(0.65 0.18 40); --primary-foreground: oklch(0.15 0.02 40);
      --secondary: oklch(0.25 0.02 40); --secondary-foreground: oklch(0.88 0.02 50);
      --muted: oklch(0.25 0.02 40); --muted-foreground: oklch(0.62 0.03 50);
      --accent: oklch(0.70 0.18 85); --accent-foreground: oklch(0.15 0.02 40);
      --destructive: oklch(0.65 0.24 27); --destructive-foreground: oklch(0.14 0.02 27);
      --success: oklch(0.65 0.20 145); --success-foreground: oklch(0.14 0.02 145);
      --warning: oklch(0.70 0.18 65); --warning-foreground: oklch(0.14 0.03 65);
      --info: oklch(0.65 0.18 60); --info-foreground: oklch(0.14 0.02 60);
      --border: oklch(0.30 0.02 40); --input: oklch(0.30 0.02 40); --ring: oklch(0.65 0.18 40);
      --sidebar: oklch(0.18 0.02 40); --sidebar-foreground: oklch(0.88 0.02 50);
      --sidebar-primary: oklch(0.65 0.18 40); --sidebar-primary-foreground: oklch(0.15 0.02 40);
      --sidebar-accent: oklch(0.25 0.02 40); --sidebar-accent-foreground: oklch(0.93 0.02 50);
      --sidebar-border: oklch(0.30 0.02 40); --sidebar-ring: oklch(0.65 0.18 40);
      --hover: oklch(0.22 0.02 40);
      --chart-1: oklch(0.65 0.18 40); --chart-2: oklch(0.70 0.18 85); --chart-3: oklch(0.65 0.20 145); --chart-4: oklch(0.70 0.18 65); --chart-5: oklch(0.65 0.24 27);
    `,
  },
}

const STORAGE_KEY = 'ryasai-theme'
const DARK_KEY = 'ryasai-dark-mode'

/** Get saved theme or default. */
export function getStoredTheme(): ThemeId {
  if (typeof window === 'undefined') return 'enterprise'
  return (localStorage.getItem(STORAGE_KEY) as ThemeId) || 'enterprise'
}

/** Get saved dark mode preference (dark is the default). */
export function getStoredDarkMode(): boolean {
  if (typeof window === 'undefined') return true
  const stored = localStorage.getItem(DARK_KEY)
  if (stored !== null) return stored === 'true'
  return true
}

/** Apply theme + dark mode to document. Call on mount and on change. */
export function applyTheme(theme: ThemeId, dark: boolean) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const css = THEME_CSS[theme]
  const vars = dark ? css.dark : css.light

  root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', dark)

  const styleId = 'ryasai-theme-vars'
  let styleEl = document.getElementById(styleId) as HTMLStyleElement | null
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = styleId
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = `:root{${vars}}`
}

/** Save theme + dark mode to localStorage and apply. */
export function setTheme(theme: ThemeId, dark: boolean) {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, theme)
  localStorage.setItem(DARK_KEY, String(dark))
  applyTheme(theme, dark)
}

/** Inline script to prevent FOUC — reads localStorage, injects theme CSS vars. */
export const THEME_INIT_SCRIPT = `
(function(){
  try {
    var root = document.documentElement;
    var t = localStorage.getItem('ryasai-theme') || 'enterprise';
    var d = localStorage.getItem('ryasai-dark-mode');
    var dark = d === null ? true : d === 'true';
    root.setAttribute('data-theme', t);
    if (dark) root.classList.add('dark');

    var css = ${JSON.stringify(THEME_CSS)};
    var vars = dark ? css[t].dark : css[t].light;
    var style = document.createElement('style');
    style.id = 'ryasai-theme-vars';
    style.textContent = ':root{' + vars + '}';
    document.head.appendChild(style);
  } catch(e){
    var root = document.documentElement;
    root.setAttribute('data-theme', 'enterprise');
    root.classList.add('dark');
  }
})();
`
