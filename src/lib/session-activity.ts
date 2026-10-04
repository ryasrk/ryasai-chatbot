import { SESSION_INACTIVITY_TIMEOUT_MS, SESSION_CLOCK_SKEW_MS } from './constants'

/** The token must already have passed HMAC verification. Missing activity cannot reset its clock. */
export function sessionActivityExpired(last: string | null, token: string, now = Date.now()): boolean {
  const issuedAt = Number(token.split('.')[2])
  const timestamp = last === null ? issuedAt : Number(last)
  // Distributed request clocks can differ slightly; a live browser run observed
  // Redis activity 705 ms ahead of its reader. Clamp accepted skew to the reader's clock.
  const maximumFuture = now + SESSION_CLOCK_SKEW_MS
  return !Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > maximumFuture || now - Math.min(timestamp, now) >= SESSION_INACTIVITY_TIMEOUT_MS
}
