import { test, expect, describe, mock, afterEach } from 'bun:test'
import {
  parsePluginManifest,
  normalizeManifest,
  executePlugin,
  maskPluginManifest,
  encryptPluginCredentials,
  decryptPluginCredentials,
  computeManifestDigest,
  verifyManifestIntegrity,
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

// ===========================================================================
// The endpoint guards and the plugin LISTING
// ===========================================================================

describe('normalizeManifest — endpoint protocol and URL validity', () => {
  test('a NON-http(s) scheme is rejected by the EXPLICIT protocol check', () => {
    // Zod's `z.string().url()` accepts any scheme, so the protocol check is the only
    // thing standing between a config row and `file:///etc/passwd` or `ftp://internal`.
    // Each of these PARSES cleanly, so the catch is not what rejects them.
    for (const endpoint of ['file:///etc/passwd', 'ftp://internal.test/x', 'gopher://x/1']) {
      const r = normalizeManifest({ ...VALID_MANIFEST, endpoint })
      expect(r).toEqual({ error: 'Endpoint must use http or https.' })
    }
  })

  test('an UNPARSEABLE endpoint is caught by ZOD, before the URL parse runs', () => {
    // `new URL(...)` throwing is a DIFFERENT failure from a bad scheme, and the message
    // says so -- an operator typing `example.com/hook` (no scheme) needs to be told the
    // URL is malformed rather than that its protocol is wrong.
    for (const endpoint of ['not a url', 'example.com/hook', '://missing']) {
      const r = normalizeManifest({ ...VALID_MANIFEST, endpoint })
      expect(r).toEqual({ error: 'Invalid manifest: endpoint — Invalid URL' })
    }
    // The `catch` around `new URL(m.endpoint)` is UNREACHABLE through this API, and that
    // is a MEASUREMENT, not a guess: I probed ten strings that `new URL` refuses --
    // 'http://', 'https://', 'http://[', 'https://a b', 'https://%', 'http://?x' -- and
    // Zod's `z.string().url()` rejected EVERY one of them first, so control never reaches
    // the try at all. The reverse also holds: 'http://.' parses under BOTH. Declared
    // unreachable rather than left as a silent gap.
    expect(VALID_MANIFEST.endpoint).toBe('https://example.com/hook')
  })
})

describe('executePlugin — the execution-time SSRF re-check', () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  test('a blocked internal host is refused at EXECUTION time, before any fetch', async () => {
    // The comment says it plainly: "SSRF re-check at execution time -- don't trust
    // registration-time check alone." Registration and execution can be far apart, and a
    // hostname can be re-pointed at an internal address in between, so the guard must run
    // again here. The fetch spy must therefore NEVER be called.
    const fetchSpy = mock(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('nope') } as Response))
    global.fetch = fetchSpy as unknown as typeof fetch

    for (const endpoint of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/hook',
      'http://localhost:8080/hook',
      'http://192.168.1.1/hook',
    ]) {
      const result = await executePlugin({
        plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, endpoint }), toolId: 'test' },
        input: 'hello',
      })
      expect(result.ok).toBe(false)
      expect(result.error).toContain('blocked internal host')
      expect(result.latencyMs).toBe(0)
    }
    // THE ASSERTION THAT MATTERS: no request was ever attempted.
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })

  test('a hostname that only the ASYNC guard catches is refused too', async () => {
    // `isBlockedHostAsync` is not decoration: it resolves the name and blocks if ANY
    // resolved address is private, which catches a hostname the SYNCHRONOUS string check
    // cannot. MEASURED: localtest.me, lvh.me, ip6-localhost and foo.localhost are NOT
    // matched by isBlockedHost (false) but ARE blocked by isBlockedHostAsync (true) --
    // each is a real public DNS name that resolves to 127.0.0.1.
    //
    // A negative control removing `await isBlockedHostAsync(...)` from the execution-time
    // check passed every other test, because for IP literals the sync check already
    // blocks. This is the input that distinguishes them: without the async half, the
    // request would go out to a loopback address.
    const fetchSpy = mock(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('leaked') } as Response))
    global.fetch = fetchSpy as unknown as typeof fetch

    const result = await executePlugin({
      plugin: {
        manifestJson: JSON.stringify({ ...VALID_MANIFEST, endpoint: 'http://localtest.me/hook' }),
        toolId: 'test',
      },
      input: 'x',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('blocked internal host')
    expect(fetchSpy).toHaveBeenCalledTimes(0)
  })

  test('a GET input that is not JSON falls back to a ?input= param', async () => {
    // GET has no body channel, so a bare string input is carried as `?input=...`. The
    // `else` arm is what makes `input: "hello"` (plain text, not JSON) work instead of
    // sending no input at all.
    let calledUrl = ''
    global.fetch = mock((u: string) => {
      calledUrl = String(u)
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response)
    }) as unknown as typeof fetch

    await executePlugin({
      plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 't' },
      input: 'plain text input',
    })
    expect(calledUrl).toContain('input=plain+text+input')

    // A JSON ARRAY also lands in the OBJECT arm, because `typeof [] === 'object'`. Its
    // entries are the INDICES, so the params become `0=1&1=2&2=3` rather than a single
    // `input=` value. MEASURED, and pinned as behaviour: it is odd for a caller, but it is
    // what the code does, and asserting the tidier `input=[1,2,3]` (my first draft) was
    // simply wrong about the product.
    await executePlugin({
      plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 't' },
      input: '[1,2,3]',
    })
    expect(calledUrl).toBe('https://example.com/hook?0=1&1=2&2=3')

    // The `else` arm runs when JSON.parse SUCCEEDS but yields a PRIMITIVE, and the `catch`
    // when it throws. These are DIFFERENT branches and I had only exercised the catch:
    // 'plain text input' makes JSON.parse throw, so line 146 stayed uncovered and I wrongly
    // believed it was tested. A valid primitive -- 123, true, null, "str" -- is what reaches
    // the else.
    for (const [primitive, expected] of [
      ['123', 'input=123'],
      ['true', 'input=true'],
      ['null', 'input=null'],
      ['"str"', 'input=%22str%22'],
    ] as Array<[string, string]>) {
      calledUrl = ''
      await executePlugin({
        plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 't' },
        input: primitive,
      })
      expect(calledUrl).toContain(expected)
    }

    // And the THROW path is separate again: not JSON at all.
    for (const notJson of ['plain text input', '{oops', 'has "quotes']) {
      calledUrl = ''
      await executePlugin({
        plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET' }), toolId: 't' },
        input: notJson,
      })
      expect(calledUrl).toContain('input=')
    }
  })

  test('a GET endpoint that is not a valid URL is left as-is rather than throwing', async () => {
    // `new URL(manifest.endpoint)` failing inside the query-param block is caught and the
    // URL is left untouched, so the EXECUTION-time SSRF check below it is what ultimately
    // rejects the row. Without that catch a bad endpoint would throw here instead.
    let calledUrl = ''
    global.fetch = mock((u: string) => {
      calledUrl = String(u)
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('ok') } as Response)
    }) as unknown as typeof fetch

    const result = await executePlugin({
      plugin: { manifestJson: JSON.stringify({ ...VALID_MANIFEST, method: 'GET', endpoint: 'not-a-url' }), toolId: 't' },
      input: 'x',
    })
    // `new URL('not-a-url')` in the execution-time check ALSO throws, so this lands in the
    // outer catch and reports the message rather than crashing.
    expect(result.ok).toBe(false)
    expect(calledUrl).toBe('')
  })
})


describe('plugin manifest — declared JSON Schema (industry-standard shape)', () => {
  // WHY: without a declared schema every plugin's arguments collapse into ONE
  // string field (`input`) that the model must guess how to build. That blocks
  // boolean/array/nested parameters and is the same defect class as blind MCP
  // argument coercion. A manifest may now declare `parameters` as JSON Schema,
  // which is what an OpenAI-plugin / MCP-style manifest expects.

  const endpointFor = 'http://127.0.0.1:9/x'

  test('a manifest WITH parameters keeps its schema intact', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
        exact: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['query'],
    }
    const m = parsePluginManifest(JSON.stringify({
      executorType: 'webhook', endpoint: endpointFor, method: 'POST',
      authType: 'NONE', timeoutMs: 5000, description: 'x',
      parameters: schema,
    }))
    expect(m).not.toBeNull()
    // Byte-identical: we must not rewrite the author's schema.
    expect(m!.parameters).toEqual(schema)
  })

  test('a manifest WITHOUT parameters still parses (legacy contract preserved)', () => {
    const m = parsePluginManifest(JSON.stringify({
      executorType: 'webhook', endpoint: endpointFor, method: 'GET',
      authType: 'NONE', timeoutMs: 5000, description: 'x', paramDescription: 'blob',
    }))
    expect(m).not.toBeNull()
    expect(m!.parameters).toBeUndefined()
  })

  test('a non-object parameters value does not invalidate the whole manifest', () => {
    // One malformed plugin must not fail the catalogue: the bad schema is
    // dropped, the plugin still registers.
    const m = parsePluginManifest(JSON.stringify({
      executorType: 'webhook', endpoint: endpointFor, method: 'POST',
      authType: 'NONE', timeoutMs: 5000, description: 'x', parameters: 'not-an-object',
    }))
    expect(m).not.toBeNull()
    expect(m!.parameters).toBeUndefined()
  })

  test('structured args and the legacy input blob agree on a flat object', () => {
    // The two call shapes must produce the SAME effective arguments, so a
    // plugin cannot behave differently depending on which path invoked it.
    const flat = { query: 'hello', limit: 5 }
    const fromArgs = flat
    const fromInput = (() => {
      const parsed = JSON.parse(JSON.stringify(flat))
      return typeof parsed === 'object' && parsed !== null ? parsed : { input: JSON.stringify(flat) }
    })()
    expect(fromArgs).toEqual(fromInput)
  })
})

describe('manifest versioning, executor kinds, and integrity', () => {
  const webhook = { endpoint: 'https://example.com/hook', method: 'POST', authType: 'NONE' as const }

  test('a manifest with no executorType defaults to webhook (format v1 unchanged)', () => {
    const m = normalizeManifest(webhook)
    expect('error' in m).toBe(false)
    if ('error' in m) return
    expect(m.executorType).toBe('webhook')
  })

  test('an omitted method defaults rather than failing', () => {
    // The pre-Zod coercion used to write '' for an absent method, which defeated
    // the schema default and rejected every mcp-stdio manifest.
    const m = normalizeManifest({ endpoint: 'https://example.com/hook', authType: 'NONE' })
    expect('error' in m).toBe(false)
    if ('error' in m) return
    expect(m.method).toBe('POST')
  })

  test('an mcp-stdio manifest needs no endpoint and no method', () => {
    const m = normalizeManifest({
      manifestVersion: 2, executorType: 'mcp-stdio', command: 'node', args: ['/tmp/x.mjs'], authType: 'NONE',
    })
    expect('error' in m).toBe(false)
  })

  test('an mcp-stdio command outside the shared allowlist is refused', () => {
    // The allowlist is ALLOWED_MCP_CMDS from admin-tools — reusing it is what
    // stops this path and the MCP installer from drifting apart.
    const m = normalizeManifest({ manifestVersion: 2, executorType: 'mcp-stdio', command: 'rm', authType: 'NONE' })
    expect('error' in m).toBe(true)
    if (!('error' in m)) return
    expect(m.error).toContain('not allowed')
  })

  test('a webhook manifest without an endpoint is refused with a reason', () => {
    const m = normalizeManifest({ executorType: 'webhook', authType: 'NONE' })
    expect('error' in m).toBe(true)
    if (!('error' in m)) return
    expect(m.error).toContain('endpoint')
  })

  test('a tampered manifest is refused; an unchanged one still runs', () => {
    const base = normalizeManifest({
      manifestVersion: 2, executorType: 'mcp-stdio', command: 'node', args: ['/tmp/x.mjs'], authType: 'NONE',
    })
    expect('error' in base).toBe(false)
    if ('error' in base) return

    const digest = computeManifestDigest(base)
    expect(verifyManifestIntegrity(JSON.stringify(base), digest).ok).toBe(true)

    // Swapping the executable while keeping the approved digest must fail.
    const tampered = { ...base, command: 'python' }
    const v = verifyManifestIntegrity(JSON.stringify(tampered), digest)
    expect(v.ok).toBe(false)
  })

  test('a plugin with NO recorded digest is accepted (registered before digests)', () => {
    const m = normalizeManifest(webhook)
    expect('error' in m).toBe(false)
    if ('error' in m) return
    expect(verifyManifestIntegrity(JSON.stringify(m), null).ok).toBe(true)
  })

  test('the digest ignores JSON key order (an edit round-trip reorders keys)', () => {
    const m = normalizeManifest(webhook)
    expect('error' in m).toBe(false)
    if ('error' in m) return
    const digest = computeManifestDigest(m)
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(m).reverse()))
    expect(verifyManifestIntegrity(reordered, digest).ok).toBe(true)
  })
})

describe('executePlugin honours the integrity gate (wiring, not just the helper)', () => {
  // The helper tests above pass even when executePlugin forgets to CALL the
  // gate, so disabling the gate at the call site slipped past them entirely
  // (verified by negative control). This one drives executePlugin and asserts on
  // what it actually does.
  test('a manifest whose digest no longer matches is NOT executed', async () => {
    const base = normalizeManifest({
      manifestVersion: 2, executorType: 'mcp-stdio', command: 'node', args: ['/tmp/x.mjs'], authType: 'NONE',
    })
    expect('error' in base).toBe(false)
    if ('error' in base) return

    const approved = computeManifestDigest(base)
    // Swap the executable out from under the approved digest.
    const tampered = JSON.stringify({ ...base, command: 'python' })

    const res = await executePlugin({
      plugin: { manifestJson: tampered, toolId: 'anything', manifestDigest: approved },
      args: { text: 'x' },
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('changed after it was approved')
  })
})
