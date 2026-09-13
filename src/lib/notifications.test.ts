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
    expect(url).toBe('https://api.telegram.org/bot123:abc/sendMessage') // nosemgrep — test file, deterministic test token
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

  test('email → without RESEND_API_KEY returns clear error', async () => {
    delete process.env.RESEND_API_KEY
    const result = await sendNotification({
      configEncrypted: enc({ type: 'email', to: 'a@b.com' }),
      message: 'hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('RESEND_API_KEY')
  })

  test('email → without recipient returns error', async () => {
    process.env.RESEND_API_KEY = 're_test'
    const result = await sendNotification({
      configEncrypted: enc({ type: 'email' }),
      message: 'hi',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('recipient')
    delete process.env.RESEND_API_KEY
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

// ===========================================================================
// The dispatch catch, the email channel, and retry exhaustion
// ===========================================================================

describe('sendNotification dispatch — the catch that keeps a bad channel from crashing the caller', () => {
  test('a channel that THROWS becomes ok:false with its message, not a rejection', async () => {
    // Lines 53-54. The scheduler calls this for every tenant; one broken webhook
    // must come back as a failed RESULT, since a thrown error here would abort the
    // whole batch and silently skip the other tenants' notifications.
    global.fetch = mock(() => { throw new Error('socket hang up') }) as unknown as typeof fetch

    const r = await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('socket hang up')
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  test('a NON-Error throw is stringified rather than becoming undefined', async () => {
    // `e instanceof Error ? e.message : String(e)` -- a channel rejecting with a
    // bare object/string would otherwise land in error as "[object Object]"/undefined.
    global.fetch = mock(() => { throw 'plain string failure' }) as unknown as typeof fetch

    const r = await sendNotification({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('plain string failure')
  })
})

describe('sendNotification email channel (Resend) — via SUBPROCESS', () => {
  // RESEND_API_KEY is a MODULE-LEVEL const read at import time, and this repo's .env
  // does not set it, so the email send path is unreachable in-process.
  //
  // The first version of these tests used `await import('./notifications?' + random)`
  // to get a fresh evaluation. That is WRONG and I proved it: a query-string suffix
  // creates a SEPARATE module instance (`a === b` is false), so the code it executes is
  // NOT reported as coverage of notifications.ts -- the module's measured coverage
  // FELL from 100/112 to 48/90. A test that raises no coverage while claiming to test
  // a branch is exactly the failure mode this suite exists to avoid.
  //
  // So the env is set in a SUBPROCESS and the OBSERVABLE result is asserted here. The
  // email body/header assertions therefore run against the real module, and the
  // coverage they would have added is declared out of reach in the section below.
  const BUN = process.execPath

  function runEmail(script: string): { status: number; stdout: string; stderr: string } {
    const full = `
      import { encryptConfig } from '@/lib/crypto'
      const { sendNotification } = await import('@/lib/notifications')
      globalThis.fetch = async (url, init) => {
        globalThis.__seen = { url: String(url), init: { method: init.method, headers: init.headers, body: String(init.body), hasSignal: !!init.signal } }
        return ${script}
      }
      const cfg = encryptConfig({ type: 'email', to: 'user@example.com' })
      const r = await sendNotification({ configEncrypted: cfg, message: 'hello body', title: 'Hello' })
      console.log(JSON.stringify({ result: r, seen: globalThis.__seen }))
    `
    const r = Bun.spawnSync([BUN, '--eval', full], {
      env: { ...process.env, RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'from@ryasai.test' },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      cwd: process.cwd(),
    })
    return {
      status: r.exitCode ?? -1,
      stdout: r.stdout?.toString() ?? '',
      stderr: r.stderr?.toString() ?? '',
    }
  }

  function parse(out: { status: number; stdout: string; stderr: string }) {
    const line = out.stdout.split('\n').find((l) => l.startsWith('{"result"'))
    if (!line) throw new Error(`subprocess produced no JSON. exit=${out.status} stderr=${out.stderr.slice(0, 400)}`)
    return JSON.parse(line) as {
      result: { ok: boolean; error?: string; latencyMs: number }
      seen: { url: string; init: { method: string; headers: Record<string, string>; body: string; hasSignal: boolean } }
    }
  }

  test('a successful send POSTs to Resend with the key, from-address and recipient', () => {
    const out = runEmail(`({ ok: true, status: 200 })`)
    const { result, seen } = parse(out)
    expect(result.ok).toBe(true)
    expect(seen.url).toBe('https://api.resend.com/emails')
    expect(seen.init.method).toBe('POST')
    expect(seen.init.headers.Authorization).toBe('Bearer re_test_key')
    expect(seen.init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(seen.init.body)).toEqual({
      from: 'from@ryasai.test',
      to: ['user@example.com'],
      subject: 'Hello',
      text: 'hello body',
    })
    // An unresponsive Resend must not hold the scheduler slot open forever.
    expect(seen.init.hasSignal).toBe(true)
  })

  test('a NON-OK Resend response reports the status AND a 160-char slice of the body', () => {
    // The body carries the reason ("domain not verified"), so dropping it leaves an
    // operator with just "HTTP 403".
    const out = runEmail(`({ ok: false, status: 403, text: async () => 'domain is not verified' })`)
    const { result } = parse(out)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Resend API HTTP 403')
    expect(result.error).toContain('domain is not verified')
  })

  test('the body excerpt is CAPPED at 160 chars', () => {
    // An HTML error page from a proxy must not be echoed in full into the log line.
    const out = runEmail(`({ ok: false, status: 502, text: async () => 'X'.repeat(1000) })`)
    const { result } = parse(out)
    expect(result.error!.length).toBeLessThanOrEqual('Resend API HTTP 502 '.length + 160)
    expect(result.error!.endsWith('X')).toBe(true)
  })

  test('a body that FAILS TO READ still reports the HTTP status', () => {
    // `res.text().catch(() => '')` -- a truncated body must not lose the status code
    // that explains the failure.
    const out = runEmail(`({ ok: false, status: 500, text: async () => { throw new Error('aborted') } })`)
    const { result } = parse(out)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('Resend API HTTP 500 ')
  })

  test('a missing title falls back to the default subject', () => {
    const b = `
      import { encryptConfig } from '@/lib/crypto'
      const { sendNotification } = await import('@/lib/notifications')
      let body = ''
      globalThis.fetch = async (u, init) => { body = String(init.body); return { ok: true, status: 200 } }
      await sendNotification({ configEncrypted: encryptConfig({ type: 'email', to: 'u@e.com' }), message: 'm' })
      console.log(JSON.stringify({ result: { ok: true, latencyMs: 0 }, seen: { url: '', init: { method: '', headers: {}, body, hasSignal: false } } }))
    `
    const r = Bun.spawnSync([BUN, '--eval', b], {
      env: { ...process.env, RESEND_API_KEY: 'k' },
      stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', cwd: process.cwd(),
    })
    const line = (r.stdout?.toString() ?? '').split('\n').find((l) => l.startsWith('{"result"'))
    expect(line).toBeDefined()
    expect(JSON.parse(line!).seen.init.body).toContain('ryasai notification')
  })
})

describe('sendNotificationWithRetry — exhaustion', () => {
  test('a permanently failing channel retries up to the cap and returns the LAST error', async () => {
    // Lines 189-190. The final result must carry the delivery error, not the
    // placeholder, or the caller sees "No attempt made." after several real attempts.
    let calls = 0
    global.fetch = mock(() => {
      calls++
      return Promise.resolve({
        ok: false, status: 503, text: () => Promise.resolve('temporarily unavailable'),
      } as Response)
    }) as unknown as typeof fetch

    const r = await sendNotificationWithRetry({
      configEncrypted: enc({ type: 'webhook', url: 'https://example.com/hook' }),
      message: 'm',
    })

    expect(r.ok).toBe(false)
    expect(r.error).toContain('503')
    // MEASURED: NOTIFICATION_MAX_RETRIES is 3 but the loop is `attempt <= MAX`, so
    // there are FOUR total attempts (1 initial + 3 retries), not 3. My first
    // assertion said 3 and was wrong. The backoff is 2000ms * 2**attempt, so this
    // test really does sleep ~14s -- that is the cost of pinning the real schedule.
    expect(calls).toBe(4)
    expect(r.error).not.toContain('No attempt made')
  }, 20000)
})
