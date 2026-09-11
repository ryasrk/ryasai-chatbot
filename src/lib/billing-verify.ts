/**
 * Pure verification helpers for the billing/license webhook surface.
 * ----------------------------------------------------------------------------
 * Kept dependency-free so they are unit-testable without mocking the DB.
 */
import crypto from 'crypto'

/**
 * Parse Midtrans `gross_amount`, which arrives as a decimal string
 * ("100000.00"), occasionally a number, or garbage from a hostile client.
 * Returns null when the value cannot be interpreted as a finite number.
 */
export function parseGrossAmount(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const n = Number(raw.trim())
  return Number.isFinite(n) ? n : null
}

/**
 * Compare a notification's gross_amount against the order's stored IDR amount.
 * gross_amount is exactly what we charged Snap, so an exact match is expected;
 * the tolerance only absorbs float representation noise (e.g. "270000.00" →
 * 270000 vs 269999.9999). A real mismatch means tampering or a stale order.
 */
export function grossAmountMatchesIdr(raw: unknown, amountIdr: number, tolerance = 0.01): boolean {
  const parsed = parseGrossAmount(raw)
  if (parsed === null) return false
  return Math.abs(parsed - amountIdr) <= tolerance
}

/**
 * Timing-safe string comparison for shared secrets. Length differences leak
 * only the length (unavoidable), never content — crypto.timingSafeEqual
 * throws on unequal lengths, so guard first.
 */
export function safeSecretCompare(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const bufA = Buffer.from(a, 'utf8')
  const bufB = Buffer.from(b, 'utf8')
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}
