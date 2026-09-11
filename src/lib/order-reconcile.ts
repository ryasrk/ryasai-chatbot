/**
 * Durable order reconciliation sweep — 'order-reconcile' repeatable job.
 * ===========================================================================
 * Safety net for license issuance after a settled QRIS order. The webhook
 * path (issue → bounded BullMQ retries) can still lose an issuance when the
 * process crashes between acking Midtrans and enqueuing the retry, or when
 * the retry budget exhausts during a long validator outage.
 *
 * This job runs hourly on the document-processing queue (ensured by
 * startJobWorker, same healing pattern as ensureLicenseReminderRepeatable):
 * it scans settled orders that never got a license key and are older than a
 * grace window (~2 min — lets the normal fire-and-forget issuance finish
 * first), then re-runs issueLicenseForOrder, which is idempotent.
 */
import { db } from './db'
import { bypassOrg } from './prisma-tenant'
import { issueLicenseForOrder } from './license-issue'
import { scopedLogger } from './logger'

const log = scopedLogger('order-reconcile')

export const ORDER_RECONCILE_JOB_NAME = 'order-reconcile'
export const ORDER_RECONCILE_CRON = '0 * * * *'

/** Settled orders younger than this are left to the webhook's inline issuance. */
export const ORDER_RECONCILE_MIN_AGE_MS = 2 * 60 * 1000

export interface ReconcilableOrderRow {
  id: string
  status: string
  licenseKeyIssued: string | null
  paidAt: Date | null
  updatedAt: Date
}

/**
 * Pure eligibility filter: settled + no key + old enough that the inline
 * issuance path had its chance. Exported for tests.
 */
export function selectReconcilableOrders(
  orders: ReconcilableOrderRow[],
  now: Date,
  minAgeMs: number = ORDER_RECONCILE_MIN_AGE_MS,
): ReconcilableOrderRow[] {
  const cutoff = now.getTime() - minAgeMs
  return orders.filter((o) => {
    if (o.status !== 'settlement') return false
    if (o.licenseKeyIssued) return false
    const stamp = (o.paidAt ?? o.updatedAt).getTime()
    return stamp <= cutoff
  })
}

export interface ReconcileRunSummary {
  scanned: number
  eligible: number
  issued: number
  failed: number
}

/**
 * Scan and re-issue. Runs outside request context — bypassOrg for the scan;
 * issueLicenseForOrder handles its own bypassOrg internally.
 */
export async function runOrderReconciliation(now: Date = new Date()): Promise<ReconcileRunSummary> {
  const orders = await bypassOrg(() =>
    db.order.findMany({
      where: { status: 'settlement', licenseKeyIssued: null },
      select: {
        id: true,
        status: true,
        licenseKeyIssued: true,
        paidAt: true,
        updatedAt: true,
      },
    }),
  )

  const eligible = selectReconcilableOrders(orders as ReconcilableOrderRow[], now)
  const summary: ReconcileRunSummary = {
    scanned: orders.length,
    eligible: eligible.length,
    issued: 0,
    failed: 0,
  }

  for (const order of eligible) {
    try {
      const outcome = await issueLicenseForOrder(order.id)
      // ok=false means retryable failure (validator down etc.) — next hourly
      // tick picks it up again; nothing is lost because money-state is safe.
      if (outcome.ok) summary.issued++
      else summary.failed++
    } catch (e) {
      summary.failed++
      log.error('order-reconcile iteration failed', {
        orderId: order.id,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (summary.eligible > 0) {
    log.info('order-reconcile sweep finished', { ...summary })
  }
  return summary
}
