/**
 * POST /api/llm-config/models — model discovery against the org's own provider.
 *
 * WHY THIS FILE EXISTS. BYOK means the credential is the CUSTOMER's, so the interesting behaviour is which
 * credential is used and whether a failure is attributed to them:
 *
 *   1. THE PROVIDED KEY WINS, THE STORED ONE IS THE FALLBACK. A caller re-pointing the base URL must be able to
 *      supply a key for THAT endpoint; silently reusing the stored key would send the customer's credential to a
 *      host they did not intend. Asserted by capturing the argument the fetch seam receives, not by trusting the
 *      response.
 *   2. THE CACHE WRITE IS CREATE-OR-UPDATE. With no config row yet, a stub is created — and the stub ENCRYPTS the
 *      key through `encryptConfig`. A plaintext key written into `encryptedApiKey` would be stored in the clear
 *      and every later read would fail to decrypt it. Asserted by scanning the whole create argument for the
 *      plaintext.
 *   3. THE BASE URL GOES THROUGH `normalizeBaseUrl`, and its failure is a 400 the CALLER can act on (a bad URL is
 *      their typo), while an upstream discovery failure is a 502 — our view of the provider, not their request.
 *   4. AN ABSENT KEY IS A 400, not a call with an empty Authorization header that returns a confusing 401.
 *
 * Also pinned: the stored `availableModels` is a JSON STRING; a successful sync does NOT rotate the key on an
 * existing row (it only refreshes the model cache); the audit records the COUNT and the base URL, never the key.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: 'pro',
}

// ---- mutable seams, declared before every mock.module ----
let user: typeof adminUser = adminUser
let storedConfig: { baseUrl?: string; apiKey?: string } | null = null
let existingRow: { id: string } | null = null
let models: string[] = ['gpt-4o', 'gpt-4o-mini']
let normalizeThrows: Error | null = null
let fetchThrows: Error | null = null
let storedKeyThrows = false
const STORED_KEY = 'sk-stored-CUSTOMER-KEY'
const PROVIDED_KEY = 'sk-provided-NEW-KEY'
const CIPHERTEXT = 'enc:v1:opaque'

const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const audits: Array<Record<string, unknown>> = []
const fetchArgs: Array<Record<string, unknown>> = []
const normalized: string[] = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    if (!u || u.role !== 'admin') {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
    void required
  },
  writeAudit: async (r: Record<string, unknown>) => {
    audits.push(r)
  },
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ ok: false, error: 'Forbidden' }, { status: 403 })
    }
    return Response.json({ ok: false, error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

const events: string[] = []

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/llm-config', () => ({
  normalizeBaseUrl: (raw: string) => {
    if (normalizeThrows) throw normalizeThrows
    normalized.push(raw)
    return raw.replace(/\/+$/, '')
  },
  getLlmRuntimeConfig: async () => {
    if (storedKeyThrows) throw new Error('decrypt failed')
    return storedConfig
  },
  fetchProviderModels: async (args: Record<string, unknown>) => {
    fetchArgs.push(args)
    if (fetchThrows) throw fetchThrows
    return models
  },
}))

const encryptInputs: string[] = []

mock.module('@/lib/crypto', () => ({
  // Opaque on purpose: a mock that echoed its input would make a plaintext write indistinguishable from correct
  // encryption (this bit me once already with encryptConfig).
  //
  // MY FIRST VERSION THREW on any input containing 'sk-', which is exactly what a real API key looks like -- so
  // the create path 502'd and I nearly recorded "the create branch is broken" as a route defect. A mock must not
  // refuse its own valid input; it records it and lets the TEST assert that the OUTPUT is opaque.
  encryptConfig: (input: unknown) => {
    encryptInputs.push(JSON.stringify(input))
    return CIPHERTEXT
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      findFirst: async (args: Record<string, unknown> = {}) => {
        calls.push({ model: 'llmConfig', op: 'findFirst', args })
        return existingRow
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'llmConfig', op: 'update', args })
        return {}
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'llmConfig', op: 'create', args })
        return {}
      },
    },
  },
}))

// DYNAMIC: a static import would be evaluated before the mocks above and bypass every one of them.
const { POST } = await import('./route')

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/llm-config/models', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const updateData = () =>
  (calls.find((c) => c.op === 'update')?.args.data as Record<string, unknown>) ?? null
const createData = () =>
  (calls.find((c) => c.op === 'create')?.args.data as Record<string, unknown>) ?? null

beforeEach(() => {
  user = adminUser
  storedConfig = { baseUrl: 'https://api.example.com/v1', apiKey: STORED_KEY }
  existingRow = { id: 'c1' }
  models = ['gpt-4o', 'gpt-4o-mini']
  normalizeThrows = null
  fetchThrows = null
  storedKeyThrows = false
  calls.length = 0
  audits.length = 0
  fetchArgs.length = 0
  normalized.length = 0
  encryptInputs.length = 0
  events.length = 0
})

describe('authorisation', () => {
  test('an analyst is refused before any provider call', async () => {
    user = { ...adminUser, role: 'analyst' }
    const res = await post({})
    expect(res.status).toBe(403)
    expect(fetchArgs).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test('an admin is allowed', async () => {
    expect((await post({})).status).toBe(200)
  })
})

describe('the org context and guard order', () => {
  test('the org context is entered from the SESSION user', async () => {
    // Control M15 (deleting it) initially did NOT bite -- I had mocked the seam without recording it, so the
    // route could have called it with anything, or not at all, and the suite stayed green.
    await post({})
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test('the context is entered BEFORE the role check', async () => {
    // Ordering is observable through the event log: a refused caller must still have established its context, so
    // that the refusal itself is not a cross-org read.
    user = { ...adminUser, role: 'analyst' }
    await post({})
    expect(events).toEqual(['enterWithOrg:org-1'])
  })

  test('the context follows the session org, not a constant', async () => {
    user = { ...adminUser, organizationId: 'org-other' }
    await post({})
    expect(events).toEqual(['enterWithOrg:org-other'])
  })
})

describe('credential resolution', () => {
  test('the PROVIDED key wins over the stored one', async () => {
    // Silently reusing the stored key while a caller re-points the base URL would send the customer's credential
    // to a host they did not choose.
    await post({ baseUrl: 'https://other.example.com', apiKey: PROVIDED_KEY })
    expect(fetchArgs[0]).toEqual({ baseUrl: 'https://other.example.com', apiKey: PROVIDED_KEY })
  })

  test('the STORED decrypted key is the fallback when none is supplied', async () => {
    await post({})
    expect(fetchArgs[0]).toEqual({ baseUrl: 'https://api.example.com/v1', apiKey: STORED_KEY })
  })

  test('a WHITESPACE-only provided key falls back to the stored one', async () => {
    await post({ apiKey: '   ' })
    expect(fetchArgs[0]!.apiKey).toBe(STORED_KEY)
  })

  test('a non-string apiKey is ignored rather than coerced', async () => {
    await post({ apiKey: 42 })
    expect(fetchArgs[0]!.apiKey).toBe(STORED_KEY)
  })

  test('with NO key anywhere it is 400 and the provider is never called', async () => {
    // Calling with an empty Authorization header returns a confusing 401 that reads like a provider outage.
    storedConfig = null
    const res = await post({})
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe(
      'API key is required to fetch the model list.',
    )
    expect(fetchArgs).toHaveLength(0)
  })

  test('an EMPTY-STRING stored key is also 400', async () => {
    storedConfig = { baseUrl: 'https://x', apiKey: '' }
    expect((await post({})).status).toBe(400)
    expect(fetchArgs).toHaveLength(0)
  })

  test('a THROWING getLlmRuntimeConfig escapes to the 502 handler, NOT the actionable 400', async () => {
    // FOUND BY RUNNING, not by reading: I assumed the `catch { /* fall through */ }` inside the key block covered
    // this, but `getLlmRuntimeConfig()` is called OUTSIDE that block -- it is `let stored; try { stored = ... }`
    // only around the DECRYPT, not around the config load. A config-load throw therefore leaves the handler and
    // lands on the 502 ("Failed to fetch model list."), which tells the admin their PROVIDER is unreachable when
    // in fact our own config read failed. Recorded as the current behaviour; the assertion would need inverting
    // if the load is ever moved inside the key guard (which is the fix a 400 would require).
    storedKeyThrows = true
    const res = await post({})
    expect(res.status).toBe(502)
    expect(fetchArgs).toHaveLength(0)
  })

  test('a DECRYPT failure that the inner catch DOES cover falls through to the 400', async () => {
    // The inner `catch` covers only the stored-key READ. Simulated by handing back a config whose apiKey getter
    // throws -- the shape the inner block actually guards.
    storedConfig = {
      baseUrl: 'https://api.example.com/v1',
      get apiKey(): string {
        throw new Error('decrypt failed')
      },
    }
    const res = await post({})
    expect(res.status).toBe(400)
    expect(fetchArgs).toHaveLength(0)
  })
})

describe('base URL resolution', () => {
  test('the PROVIDED base URL wins over the stored one', async () => {
    await post({ baseUrl: 'https://override.example.com' })
    expect(fetchArgs[0]!.baseUrl).toBe('https://override.example.com')
  })

  test('the stored base URL is the fallback, and an EMPTY string with no stored row is still passed through the normalizer', async () => {
    storedConfig = null
    await post({ apiKey: PROVIDED_KEY })
    expect(normalized).toEqual([''])
  })

  test('the resolved URL is the NORMALIZED one, not the raw input', async () => {
    await post({ baseUrl: 'https://trailing.example.com///', apiKey: PROVIDED_KEY })
    expect(fetchArgs[0]!.baseUrl).toBe('https://trailing.example.com')
  })

  test('a normalization failure is 400 with the thrown message', async () => {
    // A bad URL is the CALLER's typo, so it must be 400 and act on, not a 5xx.
    normalizeThrows = new Error('Base URL must use https.')
    const res = await post({ baseUrl: 'ftp://x', apiKey: PROVIDED_KEY })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body).toEqual({ ok: false, error: 'Base URL must use https.' })
    expect(fetchArgs).toHaveLength(0)
  })

  test('a non-Error normalization failure still yields a usable message', async () => {
    normalizeThrows = 'weird' as unknown as Error
    const res = await post({ apiKey: PROVIDED_KEY })
    expect(((await res.json()) as { error: string }).error).toBe('Base URL is invalid.')
  })
})

describe('the model cache write', () => {
  test('an EXISTING row is UPDATED with the JSON string and a sync timestamp', async () => {
    models = ['a', 'b']
    await post({})
    expect(updateData()).toMatchObject({ availableModels: '["a","b"]' })
    expect(updateData()!.lastModelSyncAt).toBeInstanceOf(Date)
    expect(calls.filter((c) => c.op === 'create')).toHaveLength(0)
  })

  test('the update targets the FOUND row id', async () => {
    existingRow = { id: 'row-9' }
    await post({})
    expect(calls.find((c) => c.op === 'update')!.args.where).toEqual({ id: 'row-9' })
  })

  test('an existing row is NOT re-keyed -- only the model cache changes', async () => {
    // Key rotation is a separate, deliberate action; discovery must not silently replace a working credential.
    await post({ apiKey: PROVIDED_KEY })
    expect(updateData()!.encryptedApiKey).toBeUndefined()
  })

  test('with NO existing row a stub is CREATED and the plaintext key is ENCRYPTED', async () => {
    // A plaintext value written into `encryptedApiKey` would sit in the clear and fail every later decrypt.
    existingRow = null
    const res = await post({ baseUrl: 'https://api.example.com/v1', apiKey: PROVIDED_KEY })
    expect({ status: res.status, calls: calls.map((c) => c.op) }).toEqual({ status: 200, calls: ['findFirst', 'create'] })
    const data = createData()!
    expect(data).toMatchObject({
      organizationId: 'org-1',
      purpose: 'chat',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      encryptedApiKey: CIPHERTEXT,
    })
    // The INPUT was the plaintext key; the OUTPUT is opaque. Asserting both is the only way to know the write is
    // encrypted rather than merely different.
    expect(encryptInputs).toEqual([JSON.stringify({ apiKey: PROVIDED_KEY })])
    expect(JSON.stringify(data)).not.toContain(PROVIDED_KEY)
  })

  test('the stub defaults its model to the FIRST discovered one', async () => {
    existingRow = null
    models = ['first', 'second']
    await post({ apiKey: PROVIDED_KEY })
    expect(createData()!.model).toBe('first')
  })

  test('the stub with an EMPTY model list stores an empty model rather than undefined', async () => {
    existingRow = null
    models = []
    await post({ apiKey: PROVIDED_KEY })
    expect(createData()!.model).toBe('')
  })

  test('the stub also caches the models and the sync time', async () => {
    existingRow = null
    models = ['x']
    await post({ apiKey: PROVIDED_KEY })
    expect(createData()).toMatchObject({ availableModels: '["x"]' })
    expect(createData()!.lastModelSyncAt).toBeInstanceOf(Date)
  })
})

describe('the response, the audit and upstream failures', () => {
  test('it answers the models and their count', async () => {
    models = ['a', 'b', 'c']
    const body = (await (await post({})).json()) as { ok: boolean; data: { models: string[]; count: number } }
    expect(body).toEqual({ ok: true, data: { models: ['a', 'b', 'c'], count: 3 } })
  })

  test('an EMPTY model list is a success, not an error', async () => {
    // A provider that answers `{data: []}` is reachable; reporting failure would send the admin chasing the wrong
    // problem.
    models = []
    const body = (await (await post({})).json()) as { ok: boolean; data: { count: number } }
    expect(body.ok).toBe(true)
    expect(body.data.count).toBe(0)
  })

  test('the audit records the count and the base URL, never the key', async () => {
    await post({ apiKey: PROVIDED_KEY })
    expect(audits[0]).toMatchObject({
      userId: 'u1',
      action: 'LLM_MODELS_SYNC',
      severity: 'info',
      detail: { baseUrl: 'https://api.example.com/v1', count: 2 },
    })
    const logged = JSON.stringify(audits[0])
    expect(logged).not.toContain(PROVIDED_KEY)
    expect(logged).not.toContain(STORED_KEY)
  })

  test('an upstream discovery failure is 502, not 500', async () => {
    // Upstream means the PROVIDER, so a 500 would read as our bug.
    fetchThrows = new Error('ECONNREFUSED')
    const res = await post({})
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('ECONNREFUSED')
  })

  test('an upstream failure writes NO cache and NO audit row', async () => {
    fetchThrows = new Error('boom')
    await post({})
    expect(calls.filter((c) => c.op === 'update' || c.op === 'create')).toHaveLength(0)
    expect(audits).toHaveLength(0)
  })

  test('a malformed JSON body falls back to the STORED config rather than failing', async () => {
    // Pinned as-is: an empty body is the common "just sync what I have" call.
    const res = await post('not json')
    expect(res.status).toBe(200)
    expect(fetchArgs[0]!.apiKey).toBe(STORED_KEY)
  })
})
