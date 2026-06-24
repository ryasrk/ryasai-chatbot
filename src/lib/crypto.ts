/**
 * 4.2 — Credential Cryptography (AES-256-GCM)
 * ----------------------------------------------------------------------------
 * Adapted from the spec's Python `cryptography.hazmat.primitives.ciphers.aead.AESGCM`.
 *
 * Implementation uses Node's built-in `crypto` module:
 *   - 32-byte (256-bit) key derived from ENCRYPTION_SECRET_KEY env (hex or passphrase).
 *   - 12-byte random nonce per encryption (GCM standard).
 *   - Output stored as hex(nonce || ciphertext || authTag), mirroring the spec's
 *     `(nonce + encrypted_bytes).hex()` (authTag is appended by Node's GCM).
 *
 * SECURITY: This module MUST only be imported by server-side code (route handlers,
 * the socket.io mini-service, server libs). Never import in client components.
 */
import crypto from 'crypto'

const ENC_KEY_ENV = process.env.ENCRYPTION_SECRET_KEY

function getKey(): Buffer {
  const raw = ENC_KEY_ENV || '4a66613634353037323533373531343135343431353233363333343334363337'
  // If the env value is valid 64-char hex, use it directly (matches spec docker env).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex')
  }
  // Otherwise derive a 32-byte key via SHA-256 (deterministic) so any passphrase works.
  return crypto.createHash('sha256').update(raw).digest()
}

const KEY = getKey()

/** Encrypt an arbitrary JSON-serialisable config object → hex string. */
export function encryptConfig(config: Record<string, unknown>): string {
  const nonce = crypto.randomBytes(12)
  const data = Buffer.from(JSON.stringify(config), 'utf-8')
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce)
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
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, nonce)
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
