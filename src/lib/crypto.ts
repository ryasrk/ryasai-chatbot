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
// `userId.signature` token; the server only trusts `userId` if the HMAC verifies.
function sessionHmac(userId: string): string {
  return crypto.createHmac('sha256', key()).update(userId).digest('base64url')
}

/** Sign a user id into a verifiable session token. */
export function signSession(userId: string): string {
  return `${userId}.${sessionHmac(userId)}`
}

/** Verify a session token and return the user id, or null if invalid/unsigned. */
export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null
  const idx = token.lastIndexOf('.')
  if (idx < 1) return null
  const userId = token.slice(0, idx)
  const sig = token.slice(idx + 1)
  const expected = sessionHmac(userId)
  if (sig.length !== expected.length) return null
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  } catch {
    return null
  }
  return userId
}
