/**
 * billing-ui — pure, client-safe helpers for the subscription purchase flow.
 * ===========================================================================
 * No server imports (this module is imported by client components AND by the
 * server-side license reminder). Everything here must stay deterministic so
 * the unit tests are exact.
 *
 * ponytail: the billing API routes (/api/billing/*) are owned by another work
 * stream — these types intentionally mirror ONLY the documented response
 * shapes ({orderId, token, redirectUrl}, {status, months, amountIdr}) instead
 * of importing route-owned types.
 */

/** Midtrans transaction statuses surfaced by GET /api/billing/orders/[id]. */
export type OrderStatus =
  | 'pending'
  | 'settlement'
  | 'expire'
  | 'deny'
  | 'cancel'
  | 'failure'

export const ORDER_TERMINAL_STATUSES: ReadonlySet<OrderStatus> = new Set([
  'settlement',
  'expire',
  'deny',
  'cancel',
  'failure',
])

export function isTerminalOrderStatus(status: string): boolean {
  return ORDER_TERMINAL_STATUSES.has(status as OrderStatus)
}

export type PollOutcome =
  | { stop: true; result: 'settled' | 'failed' }
  | { stop: false }

/**
 * Decide whether the purchase poller should keep polling.
 * Anything unknown/unrecognized is treated as still-pending so a transient
 * API hiccup never aborts a payment the user may have completed.
 */
export function pollOutcome(status: string): PollOutcome {
  if (status === 'settlement') return { stop: true, result: 'settled' }
  if (isTerminalOrderStatus(status)) return { stop: true, result: 'failed' }
  return { stop: false }
}

export const POLL_INTERVAL_MS = 3_000

/** Compact IDR formatting: Rp100.000 (dot thousands separator, no decimals). */
export function formatIdr(amount: number): string {
  const grouped = Math.trunc(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  return `Rp${grouped}`
}

/** Whole days remaining until expiry (ceil — today counts as a day). */
export function daysUntilExpiry(expiresAt: Date | string, now: Date): number {
  const t = typeof expiresAt === 'string' ? new Date(expiresAt) : expiresAt
  const DAY_MS = 24 * 60 * 60 * 1000
  return Math.ceil((t.getTime() - now.getTime()) / DAY_MS)
}

/**
 * Human label for the Settings billing surface. Negative = already expired.
 */
export function expiryCountdownLabel(expiresAt: Date | string, now: Date): string {
  const days = daysUntilExpiry(expiresAt, now)
  if (days < 0) return 'Expired'
  if (days === 0) return 'Expires today'
  if (days === 1) return 'Expires tomorrow'
  return `Expires in ${days} days`
}

/** Snap loader script domain depends on environment. */
export function snapScriptUrl(isProduction: boolean): string {
  return isProduction
    ? 'https://app.midtrans.com/snap/snap.js'
    : 'https://app.sandbox.midtrans.com/snap/snap.js'
}
