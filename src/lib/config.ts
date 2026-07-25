/**
 * Centralised, typed runtime configuration (SERVER-ONLY).
 * ----------------------------------------------------------------------------
 * All environment-dependent values resolve through here. Never import this
 * module from a client component — it touches secrets. Client-safe values live
 * in `public-config.ts` (NEXT_PUBLIC_*).
 *
 * Fail-closed philosophy: missing secrets throw with a clear message instead
 * of silently falling back to insecure defaults.
 */
import crypto from 'crypto'

function requiredString(name: string): string {
  const v = process.env[name]
  if (!v || !v.trim()) {
    throw new Error(
      `[config] Missing required env var: ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    )
  }
  return v.trim()
}

function optionalString(name: string, fallback: string): string {
  const v = process.env[name]
  return v && v.trim() ? v.trim() : fallback
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v || !v.trim()) return fallback
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

function optionalBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]
  if (v === undefined) return fallback
  return v === '1' || v.toLowerCase() === 'true'
}

/** Resolve the AES-256-GCM key (fail-closed). Lazily evaluated + cached. */
let _key: Buffer | null = null
export function getEncryptionKey(): Buffer {
  if (_key) return _key
  const raw = requiredString('ENCRYPTION_SECRET_KEY')
  // 64-char hex → use directly. Otherwise derive via SHA-256 so any passphrase works.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    _key = Buffer.from(raw, 'hex')
  } else {
    // ponytail: SHA-256 derivation; upgrade to a KDF (e.g. scrypt) if keys are human-chosen secrets.
    _key = crypto.createHash('sha256').update(raw).digest()
  }
  return _key
}

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export const serverConfig = {
  isProduction: process.env.NODE_ENV === 'production',
  isTest: process.env.NODE_ENV === 'test',

  /** socket.io chat mini-service port. */
  wsPort: optionalInt('WS_PORT', 3003),

  /** Prisma query logging (noisy + leaks params). Off by default. */
  dbQueryLog: optionalBool('DB_QUERY_LOG', false),

  /**
   * Demo auth fallback: when no session cookie is present, impersonate the first
   * admin so the demo UI works without a login screen. Must be OFF in production.
   * Defaults to OFF; enable explicitly with AUTH_DEMO_FALLBACK=true.
   */
  authDemoFallback: optionalBool('AUTH_DEMO_FALLBACK', false),

  /** WebSocket CORS allow-list (comma-separated). Empty list = reflect Origin. */
  wsCorsOrigins: parseCorsOrigins(optionalString('WS_CORS_ORIGIN', '')),

  logRetentionDays: optionalInt('LOG_RETENTION_DAYS', 90),
} as const
