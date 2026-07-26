/**
 * 4.2 — Credential Cryptography (AES-256-GCM)
 * ----------------------------------------------------------------------------
 * Adapted from the spec's Python `cryptography.hazmat.primitives.ciphers.aead.AESGCM`.
 *
 * Implementation uses Node's built-in `crypto` module:
 *   - 32-byte (256-bit) key resolved from the ENCRYPTION_SECRET_KEY env var.
 *   - 12-byte random nonce per encryption (GCM standard).
 *   - Output stored as hex(nonce || ciphertext || authTag), mirroring the spec's
 *     `(nonce + encrypted_bytes).hex()` (authTag is appended by Node's GCM).
 *
 * SECURITY:
 *   - The key is REQUIRED (fail-closed). There is NO hardcoded fallback — a
 *     missing/empty ENCRYPTION_SECRET_KEY throws at first use instead of
 *     silently encrypting with a publicly-visible key. Generate one with
 *     `openssl rand -hex 32`.
 *   - This module MUST only be imported by server-side code (route handlers,
 *     the socket.io mini-service, server libs). Never import in client components.
 */
import crypto from 'crypto'
import { getEncryptionKey } from '@/lib/config'

// ponytail: lazy key — read at call time so tests can set env vars after import.
function key(): Buffer { return getEncryptionKey() }

/** Encrypt an arbitrary JSON-serialisable config object → hex string. */
export function encryptConfig(config: Record<string, unknown>): string {
  const nonce = crypto.randomBytes(12)
  const data = Buffer.from(JSON.stringify(config), 'utf-8')
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), nonce)
  const ct = Buffer.concat([cipher.update(data), cipher.final()])
  const tag = cipher.getAuthTag()
  // hex(nonce || ciphertext || tag)  — tag is 16 bytes
  return Buffer.concat([nonce, ct, tag]).toString('hex')
}

/** Decrypt a hex string previously produced by `encryptConfig` → config object. */
export function decryptConfig(encryptedHex: string): Record<string, unknown> {
  const buf = Buffer.from(encryptedHex, 'hex')
  const nonce = buf.subarray(0, 12)
  const tag = buf.subarray(buf.length - 16)
  const ct = buf.subarray(12, buf.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), nonce)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return JSON.parse(pt.toString('utf-8'))
}

/** Mask a config for safe display (hide password, shorten tokens). */
export function maskConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config }
  for (const k of Object.keys(out)) {
    const v = out[k]
    if (typeof v === 'string') {
      const lower = k.toLowerCase()
      if (lower.includes('password') || lower.includes('secret') || lower.includes('token') || lower.includes('key')) {
        out[k] = v.length > 4 ? v.slice(0, 2) + '••••••' + v.slice(-2) : '••••'
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Session cookie signing (HMAC-SHA256)
// ---------------------------------------------------------------------------
// The active-user cookie used to be plain JSON trusting `userId` verbatim,
// which allowed trivial impersonation (IDs leak via /api/me/users). It is now a
// `userId.sessionVersion.signature` token; the server only trusts `userId` if
// the HMAC verifies AND the sessionVersion matches the user's current version
// in DB. Incrementing sessionVersion on login invalidates all prior cookies.
function sessionHmac(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url')
}

/** Sign a user id + session version into a verifiable session token. */
export function signSession(userId: string, sessionVersion: number = 0): string {
  const payload = `${userId}.${sessionVersion}`
  return `${payload}.${sessionHmac(payload)}`
}

/** Verify a session token and return the user id, or null if invalid/unsigned. */
export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null
  const parts = token.split('.')
  // ponytail: accept both 2-part (legacy, no version) and 3-part (with version) tokens.
  // Legacy tokens are rejected once users re-login (version mismatch in session.ts).
  if (parts.length < 2) return null
  const sig = parts[parts.length - 1]
  const payload = parts.slice(0, -1).join('.')
  const expected = sessionHmac(payload)
  if (sig.length !== expected.length) return null
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  // Return userId (first part) — version check happens in session.ts against DB
  return parts[0]
}

/** Extract the session version from a token (for DB comparison). Returns 0 for legacy tokens. */
export function extractSessionVersion(token: string | undefined | null): number {
  if (!token) return 0
  const parts = token.split('.')
  if (parts.length < 3) return 0
  const v = Number.parseInt(parts[1], 10)
  return Number.isFinite(v) ? v : 0
}
