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

/**
 * Exposed so the parse guard can be EXERCISED. `publicConfig` reads process.env at module load,
 * so a test cannot vary the input through the exported object without manipulating the module
 * cache. Every existing test only read the DEFAULT, which means the `Number.isFinite` branch --
 * the reason this function exists rather than an inline `Number(...)` -- never ran.
 */
export const __publicIntForTest = publicInt

export const publicConfig = {
  /**
   * Version shown in the UI footer/sidebar.
   *
   * The fallback matches the shipped version rather than a placeholder. MEASURED drift this
   * was: the same value was set in four places with THREE different numbers (package.json
   * 0.4.0, .env.example 2.0.0, install.sh 0.5.0), and the two code fallbacks disagreed too
   * (`'0.0.0'` here, `'0.4.0'` in the topbar) — so a build without the env var displayed
   * whatever this file happened to say, which is how a customer reports the wrong version.
   * All five now say 1.0.0; keep them in step when releasing.
   */
  appVersion: process.env.NEXT_PUBLIC_APP_VERSION ?? '1.0.0',
  /** WebSocket port the browser client connects to (via the Caddy gateway). */
  wsPort: publicInt('NEXT_PUBLIC_WS_PORT', 3003),
} as const
