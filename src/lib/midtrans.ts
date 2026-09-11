/**
 * Midtrans Snap client — server-only.
 * ----------------------------------------------------------------------------
 * Env: MIDTRANS_SERVER_KEY (required at call time — fail-closed)
 *      MIDTRANS_IS_PRODUCTION ('true' → production base URL, else sandbox)
 *
 * QRIS payments go through Snap: the app creates a transaction token, the
 * frontend opens Snap (popup/redirect), and Midtrans notifies our webhook on
 * payment state changes. Signature check is sha512(order_id + status_code +
 * gross_amount + ServerKey), hex, compared case-insensitively + constant-time.
 */
import crypto from 'crypto'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('midtrans')

export function midtransBaseUrl(): string {
  // ponytail: test seam — e2e points this at the mock Snap server; never set
  // in production installs (install.sh/.env.example don't ship it).
  if (process.env.MIDTRANS_BASE_URL) return process.env.MIDTRANS_BASE_URL
  return process.env.MIDTRANS_IS_PRODUCTION === 'true'
    ? 'https://app.midtrans.com'
    : 'https://app.sandbox.midtrans.com'
}

function serverKey(): string {
  const key = process.env.MIDTRANS_SERVER_KEY
  if (!key) {
    throw new Error('MIDTRANS_SERVER_KEY is not configured — billing operations fail closed.')
  }
  return key
}

export interface SnapTransactionParams {
  orderId: string
  /** Amount in IDR (integer). */
  grossAmount: number
  itemName: string
}

export interface SnapTransactionResult {
  token: string
  redirectUrl: string
}

/**
 * Create a Snap transaction token. All payment methods available on the
 * merchant account are shown (QRIS is enabled by default for Snap).
 * Token expires after `expiry` below — unpaid orders become stale Snap links.
 */
export async function createSnapTransaction(params: SnapTransactionParams): Promise<SnapTransactionResult> {
  const auth = Buffer.from(`${serverKey()}:`).toString('base64')
  const res = await fetch(`${midtransBaseUrl()}/snap/v1/transactions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      transaction_details: {
        order_id: params.orderId,
        gross_amount: params.grossAmount,
      },
      item_details: [
        {
          id: params.orderId,
          price: params.grossAmount,
          quantity: 1,
          name: params.itemName,
        },
      ],
      expiry: { unit: 'hours', duration: 24 },
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    log.error('Snap createTransaction failed', { status: res.status, detail: detail.slice(0, 500) })
    throw new Error(`Midtrans Snap returned ${res.status}`)
  }

  const data = (await res.json()) as { token?: string; redirect_url?: string }
  if (!data.token || !data.redirect_url) {
    throw new Error('Midtrans Snap response is missing token/redirect_url.')
  }
  return { token: data.token, redirectUrl: data.redirect_url }
}

/** Notification payload posted by Midtrans to our webhook. */
export interface MidtransNotification {
  order_id: string
  status_code: string
  /** Decimal string, e.g. "270000.00" — must be used VERBATIM for signature. */
  gross_amount: string
  signature_key: string
  transaction_status: string
  fraud_status?: string
  transaction_id?: string
  payment_type?: string
  transaction_time?: string
  expiry_time?: string
  [key: string]: unknown
}

/**
 * Verify the webhook signature: sha512(order_id + status_code + gross_amount +
 * ServerKey) hex, compared case-insensitively and in constant time.
 * Throws when MIDTRANS_SERVER_KEY is unset — callers must treat that as
 * verification failure (fail-closed).
 */
export function verifyMidtransSignature(
  orderId: string,
  statusCode: string,
  grossAmount: string,
  signature: string,
): boolean {
  const expected = crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${serverKey()}`)
    .digest('hex')
  const a = Buffer.from(expected.toLowerCase())
  const b = Buffer.from(String(signature ?? '').toLowerCase())
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
