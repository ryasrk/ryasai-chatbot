import { describe, expect, test, mock, afterEach } from 'bun:test'

import { sendNotification, sendNotificationWithRetry } from './notifications'
import { encryptConfig } from './crypto'

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

function enc(cfg: Record<string, unknown>): string {
  return encryptConfig(cfg)
}

describe('sendNotification', () => {
  test('webhook → POSTs JSON, returns ok', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'hello',
      title: 'T',
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.com/hook')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(init.body as string)
    expect(body.message).toBe('hello')
    expect(body.title).toBe('T')
    expect(typeof body.timestamp).toBe('string')
  })

  test('webhook with auth token → sends Authorization: Bearer header', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook', token: 'abc123' }),
      message: 'm',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer abc123')
  })

  test('webhook with signatureSecret → sends X-Signature-256 HMAC header', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook', signatureSecret: 'mysecret' }),
      message: 'signed-msg',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Signature-256']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  test('webhook without signatureSecret → no X-Signature-256 header', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['X-Signature-256']).toBeUndefined()
  })

  test('webhook error response (HTTP 500) → ok false with status', async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 500 } as Response)) as unknown as typeof fetch

    const result = await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('500')
  })

  test('webhook HTTP 403 → ok false with 403', async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 403 } as Response)) as unknown as typeof fetch

    const result = await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('403')
  })

  test('telegram → calls Telegram API, returns ok', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await sendNotification({
      configEncrypted: enc({ type: 'telegram', botToken: '123:abc', chatId: '456' }),
      message: 'hi',
      title: 'Alert',
    })

    expect(result.ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage')
    const body = JSON.parse(init.body as string)
    expect(body.chat_id).toBe('456')
    expect(body.text).toContain('Alert')
    expect(body.text).toContain('hi')
    expect(body.parse_mode).toBe('Markdown')
  })

  test('telegram without title → no markdown bold prefix', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    await sendNotification({
      configEncrypted: enc({ type: 'telegram', botToken: '123:abc', chatId: '456' }),
      message: 'just a message',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.text).toBe('just a message')
  })

  test('telegram error response (HTTP 400) → ok false', async () => {
    global.fetch = mock(() => Promise.resolve({ ok: false, status: 400 } as Response)) as unknown as typeof fetch

    const result = await sendNotification({
      configEncrypted: enc({ type: 'telegram', botToken: 'bad', chatId: 'invalid' }),
      message: 'hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('400')
  })

  test('email → returns ok false (SMTP not configured)', async () => {
    const result = await sendNotification({
      configEncrypted: enc({ type: 'email', to: 'a@b.com' }),
      message: 'hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('SMTP')
  })

  test('invalid config → ok false with error', async () => {
    const result = await sendNotification({
      configEncrypted: '00'.repeat(32),
      message: 'm',
    })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
  })

  test('unknown type → ok false with error', async () => {
    const result = await sendNotification({
      configEncrypted: enc({ type: 'fax', number: '555' }),
      message: 'm',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown notification type')
    expect(result.error).toContain('fax')
  })
})

describe('sendNotificationWithRetry', () => {
  test('success on first try → no retries, returns ok', async () => {
    const fetchMock = mock(() => Promise.resolve({ ok: true, status: 200 } as Response))
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await sendNotificationWithRetry({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })

    expect(result.ok).toBe(true)
    expect(fetchMock.mock.calls.length).toBe(1)
  })

  test('retry on failure then success → returns ok after 1 retry', async () => {
    let calls = 0
    global.fetch = mock(() => {
      calls++
      if (calls < 2) return Promise.resolve({ ok: false, status: 500 } as Response)
      return Promise.resolve({ ok: true, status: 200 } as Response)
    }) as unknown as typeof fetch

    const result = await sendNotificationWithRetry({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })

    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  }, 15000)

  test('config error → no retry (returns immediately)', async () => {
    const result = await sendNotificationWithRetry({
      configEncrypted: '00'.repeat(32),
      message: 'm',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid notification configuration')
  })

  test('unknown type → no retry (returns immediately)', async () => {
    const result = await sendNotificationWithRetry({
      configEncrypted: enc({ type: 'carrier-pigeon' }),
      message: 'm',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Unknown notification type')
  })
})
