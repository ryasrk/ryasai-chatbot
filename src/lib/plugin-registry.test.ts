import { test, expect, describe, mock, afterEach } from 'bun:test'
import {
  parsePluginManifest,
  normalizeManifest,
  executePlugin,
  maskPluginManifest,
  encryptPluginCredentials,
  decryptPluginCredentials,
} from '@/lib/plugin-registry'

const VALID_MANIFEST = {
  paramDescription: '{ "input": "text" }',
  executorType: 'webhook' as const,
  endpoint: 'https://example.com/hook',
  method: 'POST',
  authType: 'NONE' as const,
  timeoutMs: 5000,
  description: 'Test plugin',
}

describe('parsePluginManifest', () => {
  test('valid JSON → returns manifest', () => {
    const json = JSON.stringify(VALID_MANIFEST)
    const m = parsePluginManifest(json)
    expect(m).not.toBeNull()
    expect(m!.endpoint).toBe('https://example.com/hook')
    expect(m!.method).toBe('POST')
  })

  test('invalid JSON → returns null', () => {
    expect(parsePluginManifest('not json')).toBeNull()
  })

  test('missing endpoint → returns null', () => {
    const m = { ...VALID_MANIFEST, endpoint: '' }
    expect(parsePluginManifest(JSON.stringify(m))).toBeNull()
  })

  test('wrong executorType → returns null', () => {
    const m = { ...VALID_MANIFEST, executorType: 'lambda' }
    expect(parsePluginManifest(JSON.stringify(m))).toBeNull()
  })

  test('invalid authType → returns null', () => {
    const m = { ...VALID_MANIFEST, authType: 'BASIC' }
    expect(parsePluginManifest(JSON.stringify(m))).toBeNull()
  })

  test('timeout below minimum (1000) → returns null', () => {
    const m = { ...VALID_MANIFEST, timeoutMs: 500 }
    expect(parsePluginManifest(JSON.stringify(m))).toBeNull()
  })

  test('timeout above maximum (120000) → returns null', () => {
    const m = { ...VALID_MANIFEST, timeoutMs: 200000 }
    expect(parsePluginManifest(JSON.stringify(m))).toBeNull()
  })

  test('missing timeoutMs → uses default 15000', () => {
    const { timeoutMs: _, ...rest } = VALID_MANIFEST
    const m = parsePluginManifest(JSON.stringify(rest))
    expect(m).not.toBeNull()
    expect(m!.timeoutMs).toBe(15000)
  })
})

describe('normalizeManifest', () => {
  test('valid input → returns clean manifest', () => {
    const result = normalizeManifest(VALID_MANIFEST)
    expect('error' in result).toBe(false)
  })

  test('invalid URL → returns error', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'not-a-url' })
    expect('error' in result).toBe(true)
  })

  test('wrong method → returns error', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, method: 'DELETE' })
    expect('error' in result).toBe(true)
  })

  test('invalid authType → returns error', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, authType: 'OAUTH' })
    expect('error' in result).toBe(true)
  })

  test('timeout below minimum → returns error', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, timeoutMs: 100 })
    expect('error' in result).toBe(true)
  })

  test('timeout above maximum → returns error', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, timeoutMs: 500000 })
    expect('error' in result).toBe(true)
  })

  test('SSRF — localhost endpoint → blocked', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'http://localhost/hook' })
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('blocked')
  })

  test('SSRF — 127.0.0.1 endpoint → blocked', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'http://127.0.0.1/hook' })
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('blocked')
  })

  test('SSRF — 169.254.x.x (metadata) endpoint → blocked', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'http://169.254.169.254/latest' })
    expect('error' in result).toBe(true)
    expect((result as { error: string }).error).toContain('blocked')
  })

  test('SSRF — 10.x private endpoint → blocked', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'http://10.0.0.1/hook' })
    expect('error' in result).toBe(true)
  })

  test('SSRF — 192.168.x private endpoint → blocked', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, endpoint: 'http://192.168.1.1/hook' })
    expect('error' in result).toBe(true)
  })

  test('non-object input → returns error', () => {
    const result = normalizeManifest('not-an-object')
    expect('error' in result).toBe(true)
  })

  test('lowercase method coerced to uppercase before validation', () => {
    const result = normalizeManifest({ ...VALID_MANIFEST, method: 'get' })
    expect('error' in result).toBe(false)
  })
})

describe('encryptPluginCredentials / decryptPluginCredentials', () => {
  test('round-trip: encrypt then decrypt returns original', () => {
    const plain = 'my-secret-key-123'
    const encrypted = encryptPluginCredentials(plain)
    expect(encrypted).not.toBe(plain)
    expect(decryptPluginCredentials(encrypted)).toBe(plain)
  })

  test('decrypt of plain text (not encrypted) → returns plain text', () => {
    const plain = 'not-encrypted-at-all'
    expect(decryptPluginCredentials(plain)).toBe(plain)
  })
})

describe('maskPluginManifest', () => {
  test('masks authCredentials when present', () => {
    const m = { ...VALID_MANIFEST, authCredentials: 'secret123' }
    const masked = maskPluginManifest(m)
    expect(masked.authCredentials).toBe('••••')
  })

  test('no mask when no credentials', () => {
    const masked = maskPluginManifest(VALID_MANIFEST)
    expect(masked.authCredentials).toBeUndefined()
  })

  test('does not mutate original manifest', () => {
    const m = { ...VALID_MANIFEST, authCredentials: 'secret123' }
    const masked = maskPluginManifest(m)
    expect(m.authCredentials).toBe('secret123')
    expect(masked.authCredentials).toBe('••••')
  })
})

describe('executePlugin', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  test('successful webhook call → ok with output', async () => {
    global.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('{"result":"success"}'),
      } as Response),
    ) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(true)
    expect(result.output).toContain('success')
  })

  test('network error → ok false with error message', async () => {
    global.fetch = mock(() => Promise.reject(new Error('Connection refused'))) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Connection refused')
  })

  test('invalid manifest → ok false', async () => {
    const result = await executePlugin({
      plugin: { manifestJson: 'invalid', toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid')
  })

  test('BEARER auth → sends Authorization: Bearer header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const credentials = encryptPluginCredentials('bearer-token-xyz')
    await executePlugin({
      plugin: {
        manifestJson: JSON.stringify({ ...VALID_MANIFEST, authType: 'BEARER', authCredentials: credentials }),
        toolId: 'test',
      },
      input: 'hello',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer bearer-token-xyz')
  })

  test('API_KEY_HEADER auth → sends X-API-Key header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const credentials = encryptPluginCredentials('api-key-123')
    await executePlugin({
      plugin: {
        manifestJson: JSON.stringify({ ...VALID_MANIFEST, authType: 'API_KEY_HEADER', authCredentials: credentials }),
        toolId: 'test',
      },
      input: 'hello',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('api-key-123')
  })

  test('NONE auth → no auth header', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
    expect(headers['X-API-Key']).toBeUndefined()
  })

  test('timeout error → returns timeout error message', async () => {
    global.fetch = mock(() => {
      const err = new Error('Timed out')
      err.name = 'TimeoutError'
      return Promise.reject(err)
    }) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timeout')
  })

  test('abort error → returns timeout error message', async () => {
    global.fetch = mock(() => {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      return Promise.reject(err)
    }) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('timeout')
  })

  test('HTTP error response → returns HTTP status error', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve('') } as Response),
    ) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('502')
  })

  test('output truncated to 8000 chars', async () => {
    const longOutput = 'x'.repeat(10000)
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(longOutput) } as Response),
    ) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.ok).toBe(true)
    expect(result.output.length).toBe(8000)
  })

  test('POST with no input → sends empty JSON body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: '',
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe('{}')
  })

  test('latencyMs is non-negative', async () => {
    global.fetch = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    ) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('executePlugin GET query params', () => {
  const origFetch = global.fetch
  afterEach(() => {
    global.fetch = origFetch
  })

  test('GET + JSON object input → appends params to URL', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 'test' },
      input: JSON.stringify({ q: 'hello', page: 2 }),
    })

    const [calledUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toContain('q=hello')
    expect(calledUrl).toContain('page=2')
  })

  test('GET + plain string input → appends ?input=...', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 'test' },
      input: 'hello world',
    })

    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toContain('input=hello+world')
    expect(init.body).toBeUndefined()
  })

  test('POST → sends body, does not modify URL', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: 'hello',
    })

    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(calledUrl).toBe('https://example.com/hook')
    expect(init.body).toBe(JSON.stringify({ input: 'hello' }))
  })

  test('POST + JSON input → sends parsed JSON as body', async () => {
    const fetchMock = mock(() =>
      Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify(VALID_MANIFEST), toolId: 'test' },
      input: JSON.stringify({ key: 'value' }),
    })

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBe(JSON.stringify({ key: 'value' }))
  })
})
