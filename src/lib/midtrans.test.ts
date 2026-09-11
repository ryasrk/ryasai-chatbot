import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import crypto from 'crypto'
import {
  createSnapTransaction,
  verifyMidtransSignature,
  midtransBaseUrl,
} from './midtrans'

const SERVER_KEY = 'SB-Mid-server-test-key-123'

function sign(orderId: string, statusCode: string, grossAmount: string, key = SERVER_KEY): string {
  return crypto
    .createHash('sha512')
    .update(`${orderId}${statusCode}${grossAmount}${key}`)
    .digest('hex')
}

const originalFetch = globalThis.fetch
const originalKey = process.env.MIDTRANS_SERVER_KEY
const originalProd = process.env.MIDTRANS_IS_PRODUCTION

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('verifyMidtransSignature', () => {
  beforeEach(() => {
    process.env.MIDTRANS_SERVER_KEY = SERVER_KEY
  })

  test('accepts a valid signature', () => {
    const sig = sign('ord-acme-1', '200', '270000.00')
    expect(verifyMidtransSignature('ord-acme-1', '200', '270000.00', sig)).toBe(true)
  })

  test('is case-insensitive on the signature hex', () => {
    const sig = sign('ord-acme-1', '200', '100000.00').toUpperCase()
    expect(verifyMidtransSignature('ord-acme-1', '200', '100000.00', sig)).toBe(true)
  })

  test('rejects a tampered payload', () => {
    const sig = sign('ord-acme-1', '200', '1.00')
    expect(verifyMidtransSignature('ord-acme-1', '200', '100000.00', sig)).toBe(false)
  })

  test('rejects an unknown order id', () => {
    const sig = sign('ord-other', '200', '100000.00')
    expect(verifyMidtransSignature('ord-acme-1', '200', '100000.00', sig)).toBe(false)
  })

  test('rejects a signature made with the wrong key', () => {
    const sig = sign('ord-acme-1', '200', '100000.00', 'attacker-key')
    expect(verifyMidtransSignature('ord-acme-1', '200', '100000.00', sig)).toBe(false)
  })

  test('rejects garbage signatures without throwing', () => {
    expect(verifyMidtransSignature('o', '200', '1', 'not-even-hex!')).toBe(false)
    expect(verifyMidtransSignature('o', '200', '1', '')).toBe(false)
  })
})

describe('createSnapTransaction', () => {
  beforeEach(() => {
    process.env.MIDTRANS_SERVER_KEY = SERVER_KEY
    process.env.MIDTRANS_IS_PRODUCTION = undefined
  })

  test('throws when MIDTRANS_SERVER_KEY is missing (fail closed)', async () => {
    delete process.env.MIDTRANS_SERVER_KEY
    await expect(
      createSnapTransaction({ orderId: 'o1', grossAmount: 100000, itemName: 'sub' }),
    ).rejects.toThrow(/MIDTRANS_SERVER_KEY/)
  })

  test('POSTs to sandbox with Basic auth and required body fields', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | null = null
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      capturedUrl = String(url)
      capturedInit = init ?? null
      return new Response(JSON.stringify({ token: 'tok-1', redirect_url: 'https://snap.app/tok-1' }), {
        status: 201,
      })
    }) as typeof fetch

    const result = await createSnapTransaction({
      orderId: 'ord-acme-abc',
      grossAmount: 270000,
      itemName: 'ryasai subscription 3 months',
    })

    expect(result).toEqual({ token: 'tok-1', redirectUrl: 'https://snap.app/tok-1' })
    expect(capturedUrl).toBe('https://app.sandbox.midtrans.com/snap/v1/transactions')

    const auth = Buffer.from(`${SERVER_KEY}:`).toString('base64')
    const headers = new Headers(capturedInit!.headers)
    expect(headers.get('Authorization')).toBe(`Basic ${auth}`)
    expect(headers.get('Accept')).toBe('application/json')

    const body = JSON.parse(String(capturedInit!.body))
    expect(body.transaction_details).toEqual({ order_id: 'ord-acme-abc', gross_amount: 270000 })
    expect(body.item_details[0].price).toBe(270000)
    expect(body.item_details[0].name).toBe('ryasai subscription 3 months')
    expect(body.expiry).toEqual({ unit: 'hours', duration: 24 })
  })

  test('uses production base URL when MIDTRANS_IS_PRODUCTION=true', async () => {
    process.env.MIDTRANS_IS_PRODUCTION = 'true'
    let capturedUrl = ''
    ;(globalThis as { fetch: typeof fetch }).fetch = (async (
      url: string | URL | Request,
    ) => {
      capturedUrl = String(url)
      return new Response(JSON.stringify({ token: 't', redirect_url: 'r' }), { status: 200 })
    }) as unknown as typeof fetch

    await createSnapTransaction({ orderId: 'o', grossAmount: 1, itemName: 'x' })
    expect(capturedUrl).toBe('https://app.midtrans.com/snap/v1/transactions')
  })

  test('throws on non-ok Midtrans response', async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('{"error":"denied"}', { status: 401 })) as unknown as typeof fetch

    await expect(
      createSnapTransaction({ orderId: 'o', grossAmount: 1, itemName: 'x' }),
    ).rejects.toThrow(/401/)
  })

  test('throws when response is missing token', async () => {
    ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
      new Response('{}', { status: 200 })) as unknown as typeof fetch

    await expect(
      createSnapTransaction({ orderId: 'o', grossAmount: 1, itemName: 'x' }),
    ).rejects.toThrow(/missing token/)
  })
})

describe('midtransBaseUrl', () => {
  test('defaults to sandbox', () => {
    process.env.MIDTRANS_IS_PRODUCTION = undefined
    expect(midtransBaseUrl()).toBe('https://app.sandbox.midtrans.com')
  })

  test("production when env is 'true'", () => {
    process.env.MIDTRANS_IS_PRODUCTION = 'true'
    expect(midtransBaseUrl()).toBe('https://app.midtrans.com')
  })
})
