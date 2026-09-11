/**
 * POST /api/billing/webhook — Midtrans payment notification receiver.
 * PUBLIC endpoint: no session — authenticity comes from the sha512 signature
 * check (order_id + status_code + gross_amount + ServerKey).
 *
 * ponytail: money-state is persisted FIRST (status + raw notification), and we
 * respond 200 right after that. License issuance runs fire-and-forget; if it
 * fails the order stays settled with licenseKeyIssued=null and a bounded
 * 'license-issue' BullMQ job retries (plus an hourly 'order-reconcile' sweep).
 *
 * Settlement claim: the status transition uses ONE conditional updateMany
 * (status != settlement → settlement). Two concurrent replays can both pass the
 * read-only pre-check, but exactly one updateMany claims count=1 — only that
 * request proceeds to license issuance. An unconditional read-then-update here
 * once allowed double-settlement and double license issuance.
 */
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import {
  verifyMidtransSignature,
  type MidtransNotification,
} from '@/lib/midtrans'
import { grossAmountMatchesIdr } from '@/lib/billing-verify'
import { issueLicenseForOrder, enqueueLicenseIssueRetry } from '@/lib/license-issue'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('billing-webhook')

const TERMINAL_FAILURES = new Set(['expire', 'deny', 'cancel', 'failure'])

export async function POST(req: NextRequest) {
  const raw = await req.text()

  let notification: MidtransNotification
  try {
    notification = JSON.parse(raw) as MidtransNotification
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body.' }, { status: 400 })
  }
  if (!notification.order_id) {
    return NextResponse.json({ ok: false, error: 'order_id is required.' }, { status: 400 })
  }

  // Fail-closed: missing MIDTRANS_SERVER_KEY makes verification throw → 403.
  let signatureOk = false
  try {
    signatureOk = verifyMidtransSignature(
      notification.order_id,
      notification.status_code,
      notification.gross_amount,
      notification.signature_key,
    )
  } catch (e) {
    log.error('Signature verification error (fail closed)', {
      error: e instanceof Error ? e.message : String(e),
    })
  }
  if (!signatureOk) {
    log.warn('Webhook signature rejected', { orderId: notification.order_id })
    return NextResponse.json({ ok: false, error: 'Invalid signature.' }, { status: 403 })
  }

  const order = await bypassOrg(() =>
    db.order.findUnique({
      where: { midtransOrderId: notification.order_id },
      select: { id: true, status: true, amountIdr: true },
    }),
  )
  if (!order) {
    return NextResponse.json({ ok: false, error: 'Order not found.' }, { status: 404 })
  }

  const status = String(notification.transaction_status ?? '').toLowerCase()
  const isSettlement =
    status === 'settlement' ||
    (status === 'capture' && String(notification.fraud_status ?? '').toLowerCase() === 'accept')

  if (isSettlement) {
    // gross_amount must equal what we charged. The sha512 signature already
    // covers gross_amount, so a mismatch here means a VALIDLY-SIGNED
    // notification for a different amount than our order row (stale order,
    // repaid order id, or a compromised/buggy integration). Never settle it.
    // Respond 200 so Midtrans stops retrying, keep a full audit trail.
    if (!grossAmountMatchesIdr(notification.gross_amount, order.amountIdr)) {
      log.error('gross_amount mismatch on settlement notification — NOT settling', {
        orderId: order.id,
        midtransOrderId: notification.order_id,
        notifiedAmount: String(notification.gross_amount),
        storedAmountIdr: order.amountIdr,
      })
      await bypassOrg(() =>
        db.order.update({
          where: { id: order.id },
          data: { rawNotificationJson: raw },
        }),
      )
      return NextResponse.json({
        ok: false,
        reason: 'gross_amount_mismatch',
        message: 'Notification amount does not match the order. Recorded for audit; order not settled.',
      })
    }

    // Atomic claim: only ONE concurrent replay flips pending→settlement.
    const claimed = await bypassOrg(() =>
      db.order.updateMany({
        where: { id: order.id, status: { not: 'settlement' } },
        data: {
          status: 'settlement',
          paidAt: new Date(),
          rawNotificationJson: raw,
        },
      }),
    )
    if (claimed.count === 0) {
      // Lost the race or genuine idempotent replay — never re-issue.
      return NextResponse.json({ ok: true, idempotent: true })
    }

    // Money state is durably recorded AND exclusively claimed — ack now,
    // issue license async.
    void (async () => {
      try {
        const outcome = await issueLicenseForOrder(order.id)
        if (!outcome.ok) await enqueueLicenseIssueRetry(order.id)
      } catch {
        await enqueueLicenseIssueRetry(order.id)
      }
    })()

    return NextResponse.json({ ok: true })
  }

  if (TERMINAL_FAILURES.has(status)) {
    // Never downgrade an already-settled order (late failure notification).
    // The conditional update keeps this safe even under concurrency.
    await bypassOrg(() =>
      db.order.updateMany({
        where: { id: order.id, status: { not: 'settlement' } },
        data: { status, rawNotificationJson: raw },
      }),
    )
    return NextResponse.json({ ok: true })
  }

  // pending / capture-with-challenge / unknown → keep status, record payload.
  await bypassOrg(() =>
    db.order.update({
      where: { id: order.id },
      data: { rawNotificationJson: raw },
    }),
  )
  return NextResponse.json({ ok: true })
}
