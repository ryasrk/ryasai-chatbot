/**
 * License issuance after a settled QRIS order.
 * ----------------------------------------------------------------------------
 * Flow: POST {validator}/internal/licenses/generate (X-Internal-Secret) →
 * store key on order + org → immediately validateLicense(key, machineId) so the
 * persisted expiry/status come from a SIGNED response, not the unsigned
 * generate body.
 *
 * Money-state safety: the ORDER is marked settlement by the webhook BEFORE this
 * runs. If the validator is unreachable or LICENSE_INTERNAL_SECRET is missing,
 * the order stays settled with licenseKeyIssued=null and a 'license-issue'
 * BullMQ job retries — we never roll back payment state because of an
 * infrastructure failure downstream of money.
 */
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import {
  validateLicense,
  generateMachineId,
  licenseStatusFromResult,
  licenseUpdateFromResult,
} from '@/lib/license-client'
import { jobQueue } from '@/lib/redis'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('license-issue')

function validatorUrl(): string {
  return process.env.LICENSE_VALIDATOR_URL?.replace(/\/$/, '') || 'http://localhost:9000'
}

function product(): string {
  return process.env.LICENSE_PRODUCT || 'ryasai-chatbot'
}

export interface IssueOutcome {
  /** true = issued (or nothing to do); false = retryable failure. */
  ok: boolean
  reason?: string
}

/**
 * Issue (or extend) the license for a settled order and wire it onto the org.
 * Idempotent: returns ok for orders that are not settled or already have a key.
 */
export async function issueLicenseForOrder(orderId: string): Promise<IssueOutcome> {
  const order = await bypassOrg(() =>
    db.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        months: true,
        status: true,
        licenseKeyIssued: true,
        organization: { select: { id: true, slug: true } },
      },
    }),
  )
  if (!order) return { ok: false, reason: `Order ${orderId} not found` }
  if (order.status !== 'settlement') return { ok: true } // nothing to do
  if (order.licenseKeyIssued && order.organization.slug) {
    // Key already stored — periodic revalidation owns the rest.
    return { ok: true }
  }

  const secret = process.env.LICENSE_INTERNAL_SECRET
  if (!secret) {
    log.error('LICENSE_INTERNAL_SECRET is not set — cannot issue licenses (fail closed)')
    return { ok: false, reason: 'LICENSE_INTERNAL_SECRET missing' }
  }
  if (!order.organization?.slug) {
    log.error(`Order ${orderId} has no organization slug — cannot generate license`)
    return { ok: false, reason: 'missing organization slug' }
  }

  let licenseKey: string
  try {
    const res = await fetch(`${validatorUrl()}/internal/licenses/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': secret,
      },
      body: JSON.stringify({
        product: product(),
        slug: order.organization.slug,
        months: order.months,
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      log.error('License generate failed', { status: res.status, orderId })
      return { ok: false, reason: `generate returned ${res.status}` }
    }
    const data = (await res.json()) as { licenseKey?: string; expiresAt?: string }
    if (!data.licenseKey) {
      log.error('License generate response missing licenseKey', { orderId })
      return { ok: false, reason: 'response missing licenseKey' }
    }
    licenseKey = data.licenseKey

    // Persist the key + provisional org fields BEFORE validating, so even if
    // validation hiccups the key is never lost (revalidation can pick it up).
    await bypassOrg(async () => {
      await db.order.update({
        where: { id: order.id },
        data: { licenseKeyIssued: licenseKey },
      })
      await db.organization.update({
        where: { id: order.organization.id },
        data: {
          licenseKey,
          licensePlan: 'flat',
          licenseExpiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        },
      })
    })
  } catch (e) {
    log.error('License generate call failed', {
      orderId,
      error: e instanceof Error ? e.message : String(e),
    })
    return { ok: false, reason: 'generate request failed' }
  }

  // ponytail: re-validate so licenseStatus + expiry are signature-backed.
  // The payload is built by licenseUpdateFromResult() — the shared helper that
  // also serves runRevalidation, the admin revalidate route and the retry
  // route. It used to be inlined here with a note that it "mirrors
  // runRevalidation() exactly; the two must never diverge" — which is exactly
  // what happened (this site defaulted plan to 'flat', the others did not).
  try {
    const machineId = generateMachineId(order.organization.slug)
    const result = await validateLicense(licenseKey, machineId)
    const newStatus = licenseStatusFromResult(result)
    await bypassOrg(() =>
      db.organization.update({
        where: { id: order.organization.id },
        data: licenseUpdateFromResult(result, { planFallback: 'flat' }),
      }),
    )
    log.info(`License issued for order ${orderId} (${order.organization.slug}) → ${newStatus}`)
  } catch (e) {
    // Key is durably stored; mark unreachable (grace period applies) —
    // periodic revalidation will settle the status later. Not retryable here.
    await bypassOrg(() =>
      db.organization.update({
        where: { id: order.organization.id },
        data: { licenseStatus: 'unreachable' },
      }),
    )
    log.warn(`Post-issue validation failed for order ${orderId}`, {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  return { ok: true }
}

/** Named backoff strategy — implemented via Worker settings.backoffStrategy in job-processor.ts. */
export const LICENSE_ISSUE_BACKOFF_TYPE = 'license-issue-backoff'

/** Max attempts × max delay: 10 attempts spanning ~2h of wall clock, enough to ride out a multi-hour validator outage alongside the hourly 'order-reconcile' sweep. */
export const LICENSE_ISSUE_MAX_ATTEMPTS = 10

const LICENSE_ISSUE_BASE_DELAY_MS = 30_000
const LICENSE_ISSUE_MAX_DELAY_MS = 15 * 60 * 1000

/**
 * Exponential delay for retry attempt N, capped at ~15min.
 * Pure + exported for tests.
 */
export function licenseIssueBackoffDelayMs(attemptsMade: number): number {
  const exp = LICENSE_ISSUE_BASE_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1)
  return Math.min(exp, LICENSE_ISSUE_MAX_DELAY_MS)
}

/**
 * Best-effort enqueue of a bounded-retry job. Safe no-op when Redis is down —
 * the hourly 'order-reconcile' sweep re-runs issueLicenseForOrder regardless
 * (it is idempotent).
 */
export async function enqueueLicenseIssueRetry(orderId: string): Promise<void> {
  try {
    await jobQueue.add(
      'license-issue',
      { type: 'license-issue', orderId },
      {
        attempts: LICENSE_ISSUE_MAX_ATTEMPTS,
        backoff: { type: LICENSE_ISSUE_BACKOFF_TYPE },
      },
    )
  } catch (e) {
    log.error('Failed to enqueue license-issue retry', {
      orderId,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}
