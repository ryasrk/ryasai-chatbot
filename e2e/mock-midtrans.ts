/**
 * Standalone Midtrans Snap stub for the e2e purchase-flow spec.
 *
 * Endpoints:
 *   POST /snap/v1/transactions   → { token, redirect_url }. Mirrors the real
 *                                  Snap create-transaction API loosely: the
 *                                  Basic Authorization header must be present
 *                                  (the app always sends it). The token→order
 *                                  mapping is recorded so the settle endpoint
 *                                  can find the order later.
 *   POST /__test/settle-by-token → TEST-ONLY. Simulates the customer paying:
 *                                  builds a Midtrans-style settlement
 *                                  notification with a VALID sha512 signature
 *                                  and POSTs it to the app's REAL webhook.
 *   POST /__test/settle          → same, addressed by order_id directly.
 *
 * Signature: sha512(order_id + status_code + gross_amount + MIDTRANS_SERVER_KEY),
 * hex — exactly what src/lib/midtrans.ts verifyMidtransSignature() computes.
 * The ServerKey is a fixed test value that global-setup injects into BOTH this
 * mock and the app under test (process.env mutations are inherited by the
 * Playwright webServer, which spawns after globalSetup).
 *
 * Implemented with Node's http module (same pattern as mock-llm.ts) so it runs
 * under both the Node-based global-setup and `bun run e2e/mock-midtrans.ts`.
 */
import http from 'http'
import crypto from 'crypto'

/** Fixed test-only ServerKey — global-setup sets the same value on the app. */
export const E2E_MIDTRANS_SERVER_KEY = 'SB-MockServerKey-e2e'

/** App under test — the webServer in playwright.config.ts listens here. */
const APP_BASE_URL = process.env.E2E_APP_URL ?? 'http://localhost:3105'

interface PendingTransaction {
  orderId: string
  /** Verbatim decimal string from the create request — reused in the notification. */
  grossAmount: string
}

export function startMockMidtrans(port = 4547): http.Server {
  // token → transaction. Process-local; the whole suite shares one worker.
  const pending = new Map<string, PendingTransaction>()
  // orderId → transaction (for /__test/settle by order_id).
  const byOrderId = new Map<string, PendingTransaction>()

  async function settle(tx: PendingTransaction): Promise<{ status: number; body: string }> {
    const statusCode = '200'
    const notification = {
      order_id: tx.orderId,
      status_code: statusCode,
      gross_amount: tx.grossAmount,
      signature_key: crypto
        .createHash('sha512')
        .update(`${tx.orderId}${statusCode}${tx.grossAmount}${E2E_MIDTRANS_SERVER_KEY}`)
        .digest('hex'),
      transaction_status: 'settlement',
      fraud_status: 'accept',
      payment_type: 'qris',
      transaction_id: `e2e-txn-${crypto.randomBytes(6).toString('hex')}`,
      transaction_time: new Date().toISOString(),
    }
    try {
      const res = await fetch(`${APP_BASE_URL}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(notification),
        signal: AbortSignal.timeout(15_000),
      })
      return { status: res.status, body: await res.text() }
    } catch (e) {
      return {
        status: 502,
        body: `webhook call failed: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.writeHead(404).end()
      return
    }
    const url = new URL(req.url, `http://localhost:${port}`)

    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const rawBody = Buffer.concat(chunks).toString('utf-8')

    // --- Snap create transaction ---
    if (url.pathname === '/snap/v1/transactions' && req.method === 'POST') {
      // Loose auth check: the app sends `Basic base64(serverKey + ':')`.
      if (!req.headers.authorization?.startsWith('Basic ')) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'missing Basic authorization' }))
        return
      }
      let orderId = ''
      let grossAmount = ''
      try {
        const body = JSON.parse(rawBody) as {
          transaction_details?: { order_id?: string; gross_amount?: number }
        }
        orderId = body.transaction_details?.order_id ?? ''
        const amount = body.transaction_details?.gross_amount
        grossAmount = typeof amount === 'number' ? `${amount}.00` : String(amount ?? '')
      } catch {
        /* handled below */
      }
      if (!orderId || !grossAmount) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'transaction_details.order_id/gross_amount required' }))
        return
      }
      const token = `mock-snap-token-${crypto.randomBytes(8).toString('hex')}`
      const tx = { orderId, grossAmount }
      pending.set(token, tx)
      byOrderId.set(orderId, tx)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          token,
          redirect_url: `${url.origin}/snap/pay/${token}`,
        }),
      )
      return
    }

    // --- Test-only settlement triggers ---
    if (url.pathname === '/__test/settle-by-token' && req.method === 'POST') {
      let token = ''
      try {
        token = (JSON.parse(rawBody) as { token?: string }).token ?? ''
      } catch {
        /* handled below */
      }
      const tx = pending.get(token)
      if (!tx) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `unknown token ${token}` }))
        return
      }
      const outcome = await settle(tx)
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' })
      res.end(outcome.body)
      return
    }

    if (url.pathname === '/__test/settle' && req.method === 'POST') {
      let orderId = ''
      try {
        orderId = (JSON.parse(rawBody) as { orderId?: string }).orderId ?? ''
      } catch {
        /* handled below */
      }
      const tx = byOrderId.get(orderId)
      if (!tx) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `unknown order_id ${orderId}` }))
        return
      }
      const outcome = await settle(tx)
      res.writeHead(outcome.status, { 'Content-Type': 'application/json' })
      res.end(outcome.body)
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  server.listen(port)
  return server
}

// When run directly via bun (standalone debugging without Playwright)
if ((globalThis as Record<string, unknown>).Bun && process.argv[1]?.includes('mock-midtrans')) {
  startMockMidtrans()
  console.log('mock midtrans on :4547')
}
