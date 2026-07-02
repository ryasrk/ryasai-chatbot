/**
 * Password hashing (scrypt, node:crypto — no external dependency).
 * ----------------------------------------------------------------------------
 * Stored format: `scrypt$<salt b64url>$<hash b64url>`.
 *
 * Why scrypt (not bcrypt): node ships `crypto.scryptSync` natively, so there is
 * zero new runtime dependency. The cost (N=16384, r=8, p=1) matches OWASP's
 * recommended minimum and completes in a few tens of milliseconds.
 *
 * SECURITY: `verifyPassword` never throws — it returns `false` for malformed or
 * legacy values (e.g. `demo-bcrypt-placeholder`) so login routes can treat any
 * non-matching stored hash uniformly.
 */
import crypto from 'crypto'

const SCRYPT = { N: 16384, r: 8, p: 1 }
const KEYLEN = 32

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(password, salt, KEYLEN, SCRYPT)
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = crypto.scryptSync(password, salt, expected.length, SCRYPT)
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
