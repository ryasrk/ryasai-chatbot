import { test, expect, describe, mock, afterEach } from 'bun:test'
import {
  parsePluginManifest,
  normalizeManifest,
  executePlugin,
  maskPluginManifest,
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
    expect(result.error).toContain('tidak valid')
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
})
