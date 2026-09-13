import { describe, expect, test, mock, beforeEach } from 'bun:test'
import crypto from 'crypto'

// ponytail: per-file bun subprocess (mock.module leaks across files).
// DB is a controllable fake; license issuance + retry enqueue are spies so the
// tests can assert exactly when issuance does / does not fire.
const calls = {
  findUnique: [] as Array<Record<string, unknown>>,
  update: [] as Array<Record<string, unknown>>,
  updateMany: [] as Array<Record<string, unknown>>,
}
let findUniqueResult: Record<string, unknown> | null = null
let updateManyResult = { count: 1 }

const issueCalls: string[] = []
let issueOutcome: { ok: boolean; reason?: string } = { ok: true }
/** When true the mocked issuer THROWS instead of returning a verdict. */
let issueThrows = false
const retryEnqueueCalls: string[] = []

mock.module('@/lib/db', () => ({
  db: {
    order: {
      findUnique: async (args: Record<string, unknown>) => {
        calls.findUnique.push(args)
        return findUniqueResult
      },
      update: async (args: Record<string, unknown>) => {
        calls.update.push(args)
        return {}
      },
      updateMany: async (args: Record<string, unknown>) => {
        calls.updateMany.push(args)
        return updateManyResult
      },
    },
  },
}))
mock.module('@/lib/prisma-tenant', () => ({
  bypassOrg: async <T,>(fn: () => T) => fn(),
  enterWithOrg: () => {},
}))
mock.module('@/lib/license-issue', () => ({
  issueLicenseForOrder: async (orderId: string) => {
    issueCalls.push(orderId)
    if (issueThrows) throw new Error('license service unreachable')
    return issueOutcome
  },
  enqueueLicenseIssueRetry: async (orderId: string) => {
    retryEnqueueCalls.push(orderId)
  },
}))
mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}))

const { POST } = await import('./route')

const SERVER_KEY = 'SB-Mid-server-test-key-123'
process.env.MIDTRANS_SERVER_KEY = SERVER_KEY

function sign(orderId: string, statusCode: string, grossAmount: string): string {
  return crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${SERVER_KEY}`)
    .digest('hex')
}

function notification(overrides: Partial<Record<string, unknown>> = {}): string {
  const body = {
    order_id: 'ord-acme-1',
    status_code: '200',
    gross_amount: '100000.00',
    signature_key: '',
    transaction_status: 'settlement',
    fraud_status: 'accept',
    ...overrides,
  }
  // Auto-sign ONLY when the caller didn't explicitly override signature_key
  // (e.g. tampered-signature tests must actually send their tampered value).
  if (overrides.signature_key === undefined) {
    body.signature_key = sign(
      String(body.order_id),
      String(body.status_code),
      String(body.gross_amount),
    )
  }
  return JSON.stringify(body)
}

function post(rawBody: string): Promise<Response> {
  const req = new Request('http://localhost/api/billing/webhook', {
    method: 'POST',
    body: rawBody,
    headers: { 'Content-Type': 'application/json' },
  })
  return POST(req as never)
}

function pendingOrder() {
  return { id: 'order-row-1', status: 'pending', amountIdr: 100000 }
}

async function settle(body?: string): Promise<Response> {
  const res = await post(body ?? notification())
  // Fire-and-forget issuance IIFE — yield the microtask queue before asserting.
  await new Promise((r) => setTimeout(r, 10))
  return res
}

beforeEach(() => {
  calls.findUnique.length = 0
  calls.update.length = 0
  calls.updateMany.length = 0
  issueCalls.length = 0
  retryEnqueueCalls.length = 0
  findUniqueResult = pendingOrder()
  updateManyResult = { count: 1 }
  issueOutcome = { ok: true }
  issueThrows = false
})

describe('POST /api/billing/webhook — settlement claim guard', () => {
  test('claims settlement via conditional updateMany and issues the license', async () => {
    const res = await settle()
    expect(res.status).toBe(200)
    expect(calls.updateMany).toHaveLength(1)
    const claim = calls.updateMany[0]
    expect((claim.where as Record<string, unknown>).status).toEqual({ not: 'settlement' })
    expect((claim.data as Record<string, unknown>).status).toBe('settlement')
    expect(issueCalls).toEqual(['order-row-1'])
  })

  test('second concurrent replay (claim count=0) is a no-op — no double issuance', async () => {
    updateManyResult = { count: 0 } // another request already claimed it
    const res = await settle()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { idempotent?: boolean }
    expect(body.idempotent).toBe(true)
    expect(issueCalls).toEqual([])
    expect(retryEnqueueCalls).toEqual([])
  })

  test('issuance failure after a successful claim enqueues a bounded retry', async () => {
    issueOutcome = { ok: false, reason: 'generate returned 503' }
    const res = await settle()
    expect(res.status).toBe(200)
    expect(updateManyResult.count).toBe(1)
    expect(retryEnqueueCalls).toEqual(['order-row-1'])
  })

  test('terminal-failure notifications never downgrade a settled order', async () => {
    findUniqueResult = { id: 'order-row-1', status: 'settlement', amountIdr: 100000 }
    const res = await post(notification({ transaction_status: 'expire' }))
    expect(res.status).toBe(200)
    // The only write is the guarded updateMany — status stays settlement.
    expect(calls.updateMany).toHaveLength(1)
    expect((calls.updateMany[0].data as Record<string, unknown>).status).toBe('expire')
    expect(calls.update).toHaveLength(0)
  })

  test('non-settlement statuses persist the raw payload without settling', async () => {
    const res = await post(notification({ transaction_status: 'pending' }))
    expect(res.status).toBe(200)
    expect(calls.updateMany).toHaveLength(0)
    expect(calls.update).toHaveLength(1)
    expect((calls.update[0].data as Record<string, unknown>).rawNotificationJson).toBeDefined()
  })
})

describe('POST /api/billing/webhook — gross_amount validation', () => {
  test('mismatch does NOT settle and records an audit trail', async () => {
    const res = await post(
      notification({
        order_id: 'ord-acme-1',
        status_code: '201',
        gross_amount: '999.00', // validly signed but ≠ amountIdr (100000)
      }),
    )
    expect(res.status).toBe(200) // ack so Midtrans stops retrying
    const body = (await res.json()) as { ok?: boolean; reason?: string }
    expect(body.ok).toBe(false)
    expect(body.reason).toBe('gross_amount_mismatch')
    expect(calls.updateMany).toHaveLength(0) // never claimed settlement
    expect(issueCalls).toEqual([])
    // Raw notification persisted for audit.
    expect(calls.update).toHaveLength(1)
    expect((calls.update[0].where as Record<string, unknown>).id).toBe('order-row-1')
  })

  test('matching amount settles normally', async () => {
    await settle()
    expect(calls.updateMany).toHaveLength(1)
    expect(issueCalls).toEqual(['order-row-1'])
  })
})

describe('POST /api/billing/webhook — request hygiene', () => {
  test('invalid JSON → 400', async () => {
    const res = await post('not-json')
    expect(res.status).toBe(400)
  })

  test('bad signature → 403', async () => {
    const res = await post(notification({ signature_key: 'deadbeef' }))
    expect(res.status).toBe(403)
    expect(calls.findUnique).toHaveLength(0)
  })

  test('unknown order → 404', async () => {
    findUniqueResult = null
    const res = await post(notification())
    expect(res.status).toBe(404)
  })
})

describe('POST /api/billing/webhook — the guards that were never reached', () => {
  test('a notification with NO order_id is refused before any signature work', async () => {
    // `order_id` is the FIRST field in the signature string, and it is also the lookup
    // key. Without this guard an absent order_id would be coerced to the string
    // "undefined" inside the signature (`${orderId}${statusCode}...`) and then looked
    // up as a real order id -- a confusing 404 at best, and on a permissive DB an
    // accidental match by the literal value.
    const res = await post(notification({ order_id: '' }))
    expect(res.status).toBe(400)
    const body = (await res.json()) as Record<string, unknown>
    // The response shape is { ok, error } -- I first read `body.order_id` here, which
    // is undefined, so the assertion failed against a field the route never sends.
    expect(body.error).toBe('order_id is required.')
    expect(body.ok).toBe(false)
    // It must not have consulted the DB at all.
    expect(calls.findUnique.length).toBe(0)
  })

  test('an EMPTY order_id and a missing one behave the same (falsy guard)', async () => {
    const res = await post(JSON.stringify({ status_code: '200', gross_amount: '1' }))
    expect(res.status).toBe(400)
    expect(calls.findUnique.length).toBe(0)
  })

  test('and it is refused even when a VALID signature is present for that literal value', async () => {
    // The strongest form of the guard: the signature is correct for order_id '', so
    // ONLY the order_id check can reject it. A negative control that removed the guard
    // would let this reach the DB lookup.
    const res = await post(notification({ order_id: '' }))
    expect(res.status).toBe(400)
    expect(calls.findUnique.length).toBe(0)
  })
})

describe('POST /api/billing/webhook — an unconfigured SERVER_KEY fails CLOSED', () => {
  test('with MIDTRANS_SERVER_KEY unset, the webhook answers 403 and never settles', async () => {
    // The route comment states this explicitly: "missing MIDTRANS_SERVER_KEY makes
    // verification throw -> 403". serverKey() throws, the throw is caught, signatureOk
    // stays false, and the response is 403. Without the catch the handler would 500 --
    // which Midtrans retries -- and without the fail-closed default a misconfigured
    // self-hosted install could settle orders with NO signature verification at all.
    const saved = process.env.MIDTRANS_SERVER_KEY
    delete process.env.MIDTRANS_SERVER_KEY
    try {
      const res = await settle()
      expect(res.status).toBe(403)
      const body = (await res.json()) as Record<string, unknown>
      expect(body.error).toBe('Invalid signature.')
      // Nothing was claimed and no license was issued for an unverified notification.
      expect(calls.updateMany.length).toBe(0)
      expect(issueCalls.length).toBe(0)
    } finally {
      process.env.MIDTRANS_SERVER_KEY = saved
    }
  })
})

describe('POST /api/billing/webhook — issuance failure is retried', () => {
  test('a THROWN issuer (not just ok:false) still enqueues a retry', async () => {
    // The async IIFE is `try { const outcome = await issueLicenseForOrder(...) ; if
    // (!outcome.ok) await enqueue(...) } catch { await enqueue(...) }`. The existing
    // test covers only the `ok: false` path. The THROW path is the one that would
    // otherwise lose a PAID order's license silently, because a fire-and-forget
    // rejection is invisible at the HTTP boundary -- the response is already 200.
    //
    // The mock's issuer returns `issueOutcome`, so the throw is injected through that
    // shared state rather than by re-mocking the module (a second mock.module for the
    // SAME path in the same file is inert -- the LAST call wins, so mine did nothing
    // until I routed the failure through the existing spy).
    findUniqueResult = pendingOrder()
    updateManyResult = { count: 1 }
    issueThrows = true
    const res = await settle()
    // The HTTP response is already 200 BEFORE issuance runs, so a throw here can only
    // be handled inside the IIFE -- which is exactly what the catch does.
    expect(res.status).toBe(200)
    expect(issueCalls).toContain('order-row-1')
    expect(retryEnqueueCalls).toContain('order-row-1')
  })
})
