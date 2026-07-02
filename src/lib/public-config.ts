/**
 * Client-safe configuration (NEXT_PUBLIC_* are inlined into the browser bundle
 * at build time). Safe to import from client components.
 *
 * Server-only secrets live in `config.ts` — never import that from a client.
 */
function publicInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v || !v.trim()) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

export const publicConfig = {
  /** Version shown in the UI footer/sidebar. */
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '0.0.0',
  /** WebSocket port the browser client connects to (via the Caddy gateway). */
  wsPort: publicInt('NEXT_PUBLIC_WS_PORT', 3003),
} as const
