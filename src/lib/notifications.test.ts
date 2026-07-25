import { describe, expect, test, mock, afterEach } from 'bun:test'
import { sendNotification } from './notifications'
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
  })

  test('invalid config → ok false with error', async () => {
    // ponytail: 32-byte hex so nonce/tag are full-length and final() throws a
    // clean auth-mismatch instead of Node's sub-128-bit-tag deprecation warning.
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
    expect(result.error).toContain('tidak dikenal')
    expect(result.error).toContain('fax')
  })
})
