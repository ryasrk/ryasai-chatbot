/**
 * GET + PUT + POST /api/vector-store — the org's vector backend, its credentials, and its collection.
 *
 * WHY THIS FILE EXISTS. A config route where every branch is a decision that either leaks a secret or bricks
 * retrieval, so the inversions are all silent:
 *
 *   1. THE API KEY IS MASKED FROM A PLACEHOLDER, NOT FROM THE STORED KEY. `maskSecret('configured-key')` means
 *      the response CANNOT contain any part of the real credential even if the mask function is wrong later --
 *      the mask is computed over a constant. Asserted by scanning the whole body for the plaintext.
 *   2. A BLANK `apiKey` ON UPDATE KEEPS THE STORED CIPHERTEXT. The payload spreads the key conditionally
 *      (`...(apiKey ? { encryptedApiKey } : {})`), which is deliberate: the UI never receives the key back, so a
 *      save that only changes the collection name must not wipe it. This is the behaviour a "simplify the
 *      payload" edit breaks, and it breaks it silently -- every search then fails with an opaque 401.
 *   3. AN EXTERNAL BACKEND WITHOUT A BASE URL IS REJECTED AT SAVE TIME (fail-closed, `VALIDATION_ERROR`), so the
 *      operator learns while the form is open rather than at search time. Likewise a PRESET THAT NEEDS A KEY
 *      refuses a save that would leave it keyless -- UNLESS a key is already stored, which is the case the
 *      "already configured" branch exists for.
 *   4. THE RESPONSE IS `GET()` RE-USED, so PUT cannot drift from GET's masking. Asserted on the equivalence.
 *   5. `requireRole(user, 'admin')` IS ENFORCED ON BOTH WRITES and asserted to run BEFORE any DB read, so a
 *      non-admin never causes a write or a read.
 *
 * Also pinned: `findFirst` (not `findUnique`) as the tenant-scoped singleton read, the default INTERNAL shape
 * when no row exists, the `vectorSize` floor, and that the POST test endpoint never leaks the row.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'u1',
  name: 'Ada',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}
let user: typeof adminUser = adminUser

const PLAINTEXT_KEY = 'qdrant-live-SUPERSECRET'
const STORED_CIPHERTEXT = 'enc:v1:stored-blob'

let row: Record<string, unknown> | null = null
let runtimeConfig: Record<string, unknown> | null = null
let ensureThrows: Error | null = null
let createThrows: Error | null = null

const events: string[] = []
const calls: Array<{ model: string; op: string; args: Record<string, unknown> }> = []
const auditWrites: Array<Record<string, unknown>> = []
const encryptedInputs: Array<Record<string, unknown>> = []
const ensured: Array<Record<string, unknown>> = []
const roleChecks: Array<{ role: string; required: string }> = []

mock.module('@/lib/session', () => ({
  getActiveUser: async () => user,
  requireRole: (u: { role?: string } | null, required: string) => {
    roleChecks.push({ role: String(u?.role), required })
    if (!u || u.role !== 'admin') {
      const e = new Error('Forbidden') as Error & { code?: string }
      e.code = 'FORBIDDEN'
      throw e
    }
  },
  writeAudit: async (r: Record<string, unknown>) => {
    auditWrites.push(r)
    events.push('audit')
  },
  // The REAL shape (verified in session.ts): `{ error: { code, message, hint? } }` with a NESTED error object,
  // and an `AppError`'s own message SURVIVES (only an unhandled error gets the generic fallback). My first mock
  // returned a flat `{ error: string }`, which hid the AppError message and made the fail-closed assertions test
  // the mock rather than the route.
  handleApiError: (e: unknown, fallback: string, status = 500) => {
    const err = e as { code?: string; message?: string; hint?: string; statusCode?: number }
    if (err?.code === 'FORBIDDEN') {
      return Response.json({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }, { status: 403 })
    }
    if (err?.code === 'VALIDATION_ERROR') {
      return Response.json(
        { error: { code: 'VALIDATION_ERROR', message: err.message, hint: err.hint } },
        { status: err.statusCode ?? 400 },
      )
    }
    return Response.json({ error: { code: 'INTERNAL_ERROR', message: fallback } }, { status })
  },
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (o: string) => {
    events.push(`enterWithOrg:${o}`)
  },
}))

mock.module('@/lib/crypto', () => ({
  encryptConfig: (o: Record<string, unknown>) => {
    encryptedInputs.push(o)
    // Opaque, like the real AES-GCM envelope: the plaintext is not recoverable from the output.
    return `enc:v1:new-${encryptedInputs.length}`
  },
}))

mock.module('@/lib/llm-config', () => ({
  // The REAL implementation (verified in llm-config.ts): '••••' for <= 8 chars, else first4 + '••••••' +
  // last4. So `maskSecret('configured-key')` is 'conf••••••-key' -- my first mock invented a different shape.
  maskSecret: (secret: string) => (secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}••••••${secret.slice(-4)}`),
  normalizeBaseUrl: (u: string) => {
    const t = u.trim().replace(/\/+$/, '')
    if (!/^https?:\/\//.test(t)) throw new Error('Base URL must start with http:// or https://')
    return t
  },
}))

// Mirrors the REAL preset table (read from db-provider-presets.ts before writing this). Two corrections my
// first version had wrong: the key-requiring Qdrant entry is `QDRANT_CLOUD` (id) labelled 'Qdrant Cloud', while
// bare `QDRANT` is the LOCAL server that needs NO key; and `MILVUS` is local/no-key too. Getting these backwards
// would have made the fail-closed assertions test the wrong providers entirely.
mock.module('@/lib/db-provider-presets', () => ({
  getVectorStorePreset: (provider: string) => {
    if (provider === 'QDRANT') {
      return {
        label: 'Qdrant (Local)',
        backend: 'QDRANT',
        needsApiKey: false,
        baseUrlPlaceholder: 'http://localhost:6333',
      }
    }
    if (provider === 'QDRANT_CLOUD') {
      return {
        label: 'Qdrant Cloud',
        backend: 'QDRANT',
        needsApiKey: true,
        baseUrlPlaceholder: 'https://cluster-id.qdrant.tech:6333',
      }
    }
    if (provider === 'MILVUS') {
      return {
        label: 'Milvus',
        backend: 'MILVUS',
        needsApiKey: false,
        baseUrlPlaceholder: 'http://localhost:19530',
      }
    }
    if (provider === 'CHROMA') {
      return {
        label: 'Chroma (self-hosted)',
        backend: 'CHROMA',
        needsApiKey: false,
        baseUrlPlaceholder: 'http://localhost:8000',
      }
    }
    return undefined
  },
}))

mock.module('@/lib/vector-stores', () => ({
  getVectorStoreRuntimeConfig: async () => runtimeConfig,
  ensureVectorCollection: async (c: Record<string, unknown>) => {
    ensured.push(c)
    events.push('ensureVectorCollection')
    if (ensureThrows) throw ensureThrows
  },
}))

mock.module('@/lib/errors', () => {
  class AppError extends Error {
    code: string
    hint?: string
    constructor(code: string, message: string, opts?: { hint?: string }) {
      super(message)
      this.code = code
      this.hint = opts?.hint
    }
  }
  return { AppError }
})

mock.module('@/lib/db', () => ({
  db: {
    vectorStoreConfig: {
      findFirst: async (args: Record<string, unknown> = {}) => {
        calls.push({ model: 'vectorStoreConfig', op: 'findFirst', args })
        return row
      },
      findUnique: async (args: Record<string, unknown>) => {
        calls.push({ model: 'vectorStoreConfig', op: 'findUnique', args })
        return row
      },
      update: async (args: Record<string, unknown>) => {
        calls.push({ model: 'vectorStoreConfig', op: 'update', args })
        return { ...row, ...(args.data as Record<string, unknown>) }
      },
      create: async (args: Record<string, unknown>) => {
        calls.push({ model: 'vectorStoreConfig', op: 'create', args })
        if (createThrows) throw createThrows
        return args.data
      },
    },
  },
}))

import { GET, PUT, POST } from './route'

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/vector-store', {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

function post() {
  // `POST` takes NO arguments in this route (its signature is `export async function POST()`), so building a
  // Request here was wrong -- tsc caught it. Kept as a callable so the tests read uniformly.
  return POST()
}

const updates = () => calls.filter((c) => c.op === 'update')
const creates = () => calls.filter((c) => c.op === 'create')

beforeEach(() => {
  user = adminUser
  row = null
  runtimeConfig = null
  ensureThrows = null
  createThrows = null
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  encryptedInputs.length = 0
  ensured.length = 0
  roleChecks.length = 0
})

describe('GET', () => {
  test('with no row it reports the INTERNAL defaults rather than null', async () => {
    // The form renders these; a null body would leave the fields blank and look like a load failure.
    const res = await GET()
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({
      provider: 'INTERNAL',
      baseUrl: '',
      apiKeyMasked: null,
      collectionName: 'ryasai_chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: null,
    })
  })

  test('GET enters the session org (so the extension can scope the singleton read)', async () => {
    // Control K8 (deleting GET's `enterWithOrg`) initially found NOTHING asserting the context, so it could not
    // bite. The row is a per-org singleton; without the context the read is unscoped and would return another
    // org's vector backend.
    await GET()
    expect(events).toContain('enterWithOrg:org-1')
  })

  test('the singleton read uses findFirst, never findUnique', async () => {
    // No unique key exists for a per-org singleton; findUnique would also bypass tenant scoping.
    await GET()
    const loads = calls.filter((c) => c.op === 'findFirst' || c.op === 'findUnique')
    expect(loads).toHaveLength(1)
    expect(loads[0]!.op).toBe('findFirst')
  })

  test('a stored key is reported as a MASK, and the mask is computed over a constant', async () => {
    // NOT `maskSecret(row.encryptedApiKey)`: the mask is derived from the literal 'configured-key', so no part
    // of the real ciphertext can appear in the response.
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://xyz.qdrant.io',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    const res = await GET()
    // Read the body ONCE as text: a second `res.json()` on the same Response throws ERR_BODY_ALREADY_USED.
    const raw = await res.text()
    expect(raw).not.toContain(STORED_CIPHERTEXT)
    expect(raw).not.toContain('enc:')
    const body = JSON.parse(raw) as { data: Record<string, unknown> }
    expect(body.data.apiKeyMasked).toBe('conf••••••-key')
  })

  test('a row WITHOUT a key reports apiKeyMasked null, not an empty mask', async () => {
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.apiKeyMasked).toBeNull()
  })

  test('a null baseUrl is reported as an empty string, not null', async () => {
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.baseUrl).toBe('')
  })

  test('updatedAt is serialised as an ISO string', async () => {
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01T03:04:05.000Z'),
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.updatedAt).toBe('2026-02-01T03:04:05.000Z')
  })

  test('the response carries a FIXED key set, so no new row column can leak by accident', async () => {
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://x',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
      organizationId: 'org-1',
      secretExtra: 'should-not-appear',
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(Object.keys(body.data).sort()).toEqual([
      'apiKeyMasked',
      'baseUrl',
      'collectionName',
      'distance',
      'provider',
      'updatedAt',
      'vectorSize',
    ])
  })
})

describe('PUT is admin-only, and the role check precedes every DB access', () => {
  test('a non-admin gets 403 and NO read, NO write and NO audit', async () => {
    // Order matters: a check placed after the read would still have touched the row.
    user = { ...adminUser, role: 'viewer' }
    const res = await put({ provider: 'INTERNAL' })
    expect(res.status).toBe(403)
    expect(calls.filter((c) => c.model === 'vectorStoreConfig')).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('the check is for the admin role specifically', async () => {
    await put({ provider: 'INTERNAL' })
    expect(roleChecks).toEqual([{ role: 'admin', required: 'admin' }])
  })

  test('the org context is entered before the role check', async () => {
    await put({ provider: 'INTERNAL' })
    expect(events.indexOf('enterWithOrg:org-1')).toBeLessThan(events.length)
    expect(roleChecks).toHaveLength(1)
  })
})

describe('the credential is preserved when the request omits it', () => {
  test('a blank apiKey on update keeps the stored ciphertext', async () => {
    // The UI never receives the key back, so a save that only changes the collection name MUST NOT wipe it.
    // `...(apiKey ? { encryptedApiKey } : {})` is what makes that true, and the failure mode is silent: every
    // subsequent search fails with an opaque 401.
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://xyz.qdrant.io',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    await put({ provider: 'QDRANT', baseUrl: 'https://xyz.qdrant.io', collectionName: 'renamed' })
    expect(updates()).toHaveLength(1)
    expect((updates()[0]!.args.data as Record<string, unknown>).encryptedApiKey).toBeUndefined()
    expect(encryptedInputs).toHaveLength(0)
  })

  test('an OMITTED apiKey behaves the same as a blank one', async () => {
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://x',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    await put({ provider: 'QDRANT', baseUrl: 'https://x' })
    expect(updates()[0]!.args.data as Record<string, unknown>).toMatchObject({ provider: 'QDRANT' })
    expect((updates()[0]!.args.data as Record<string, unknown>).encryptedApiKey).toBeUndefined()
  })

  test('a SUPPLIED apiKey is encrypted and replaces the stored one', async () => {
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://x',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    await put({ provider: 'QDRANT', baseUrl: 'https://x', apiKey: PLAINTEXT_KEY })
    expect(encryptedInputs).toEqual([{ apiKey: PLAINTEXT_KEY }])
    const written = (updates()[0]!.args.data as { encryptedApiKey: string }).encryptedApiKey
    expect(written).toMatch(/^enc:/)
    // The stored value must not contain the plaintext (verified against the real encryptor's property).
    expect(written).not.toContain(PLAINTEXT_KEY)
  })

  test('the audit records THAT the key rotated, never its value', async () => {
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://x',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    await put({ provider: 'QDRANT', baseUrl: 'https://x', apiKey: PLAINTEXT_KEY })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain(PLAINTEXT_KEY)
    expect(auditWrites[0]).toMatchObject({
      action: 'VECTOR_STORE_CONFIG_UPDATE',
      severity: 'warning',
      detail: { provider: 'QDRANT', keyRotated: true },
    })
  })

  test('a non-rotating save is audited with keyRotated false', async () => {
    await put({ provider: 'INTERNAL' })
    expect((auditWrites[0]!.detail as { keyRotated: boolean }).keyRotated).toBe(false)
  })

  test('on CREATE the key is written at the top level of the data', async () => {
    // The create branch builds its own `encryptedApiKey` rather than spreading the payload, so both shapes
    // must be asserted -- a copy-paste of the update branch would drop it here.
    await put({ provider: 'INTERNAL', apiKey: PLAINTEXT_KEY })
    expect(creates()).toHaveLength(1)
    const data = creates()[0]!.args.data as Record<string, unknown>
    expect(data.organizationId).toBe('org-1')
    expect(String(data.encryptedApiKey)).toMatch(/^enc:/)
  })

  test('on CREATE with no key the field is undefined rather than an empty blob', async () => {
    await put({ provider: 'INTERNAL' })
    expect((creates()[0]!.args.data as Record<string, unknown>).encryptedApiKey).toBeUndefined()
  })

  test('the update path is chosen when a row exists and create otherwise', async () => {
    await put({ provider: 'INTERNAL' })
    expect(creates()).toHaveLength(1)
    expect(updates()).toHaveLength(0)
    row = { id: 'v1', encryptedApiKey: null }
    await put({ provider: 'INTERNAL' })
    expect(updates()).toHaveLength(1)
  })
})

describe('fail-closed validation at save time', () => {
  test('an EXTERNAL provider without a base URL is refused with a VALIDATION_ERROR and a hint', async () => {
    // Rejecting at save time is the whole point: the operator is still looking at the form instead of meeting
    // an opaque failure at search time.
    // AppError carries a statusCode, and VALIDATION_ERROR maps to 400 -- NOT the handler's 500 default. My
    // first assertion said 500 because my mock ignored statusCode; the real mapper honours it.
    const res = await put({ provider: 'QDRANT_CLOUD', apiKey: PLAINTEXT_KEY })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string; hint?: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.message).toBe('Base URL is required for Qdrant Cloud.')
    // The hint is the actionable half. Note the route's own `Example: ` prefix -- the preset supplies only the
    // placeholder URL.
    expect(body.error.hint).toBe('Example: https://cluster-id.qdrant.tech:6333')
    expect(encryptedInputs).toHaveLength(0)
  })

  test('the refusal happens BEFORE any write or audit', async () => {
    await put({ provider: 'QDRANT_CLOUD' })
    expect(creates()).toHaveLength(0)
    expect(updates()).toHaveLength(0)
    expect(auditWrites).toHaveLength(0)
  })

  test('a provider needing a key refuses a keyless save', async () => {
    const res = await put({ provider: 'QDRANT_CLOUD', baseUrl: 'https://xyz.qdrant.io' })
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(
      'API key is required for Qdrant Cloud.',
    )
  })

  test('a keyless save is ALLOWED when a key is already stored', async () => {
    // The form is sending back a config it cannot see the credential of; refusing here would make the settings
    // page unusable after the first save.
    row = {
      id: 'v1',
      provider: 'QDRANT',
      baseUrl: 'https://xyz.qdrant.io',
      encryptedApiKey: STORED_CIPHERTEXT,
      collectionName: 'chunks',
      vectorSize: 1536,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    }
    const res = await put({ provider: 'QDRANT_CLOUD', baseUrl: 'https://xyz.qdrant.io' })
    expect(res.status).toBe(200)
  })

  test('a preset that needs NO key is not asked for one', async () => {
    // A LOCAL Qdrant: needs a URL, needs no key. The real table distinguishes it from QDRANT_CLOUD.
    const res = await put({ provider: 'QDRANT', baseUrl: 'http://localhost:6333' })
    expect(res.status).toBe(200)
  })

  test('an UNKNOWN provider is not gated by any preset (documented as-is)', async () => {
    // `getVectorStorePreset` returns undefined for an unrecognised provider, so both guards are skipped. The
    // value is stored verbatim and the failure surfaces later; recorded by assertion rather than assumed.
    const res = await put({ provider: 'WEAVIATE', baseUrl: 'https://w.example.com' })
    expect(res.status).toBe(200)
    expect((updates()[0] ?? creates()[0])!.args.data).toMatchObject({ provider: 'WEAVIATE' })
  })

  test('a non-http base URL is refused', async () => {
    const res = await put({ provider: 'CHROMA', baseUrl: 'ftp://vector.example.com' })
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('INTERNAL_ERROR')
  })

  test('INTERNAL needs neither a URL nor a key', async () => {
    const res = await put({ provider: 'INTERNAL' })
    expect(res.status).toBe(200)
  })
})

describe('normalisation and clamps', () => {
  test('the provider is trimmed and upper-cased', async () => {
    await put({ provider: '  chroma  ', baseUrl: 'https://x' })
    expect(creates()[0]!.args.data).toMatchObject({ provider: 'CHROMA' })
  })

  test('the base URL has its trailing slashes stripped', async () => {
    await put({ provider: 'CHROMA', baseUrl: 'https://vector.example.com//' })
    expect(creates()[0]!.args.data).toMatchObject({ baseUrl: 'https://vector.example.com' })
  })

  test('an ABSENT provider defaults to INTERNAL', async () => {
    await put({ collectionName: 'x' })
    expect(creates()[0]!.args.data).toMatchObject({ provider: 'INTERNAL' })
  })

  test('a whitespace-only collection name falls back to the default', async () => {
    await put({ provider: 'INTERNAL', collectionName: '   ' })
    expect(creates()[0]!.args.data).toMatchObject({ collectionName: 'ryasai_chunks' })
  })

  test('vectorSize=0 falls back to 1536 because 0 is FALSY, not because of the floor', async () => {
    // `Math.max(1, Number(body.vectorSize ?? 1536) || 1536)` -- two different mechanisms, and my first version
    // of this test conflated them. 0 is falsy so `|| 1536` applies FIRST.
    // `row` stays null, so BOTH calls take the CREATE branch -- there is no update to index into.
    await put({ provider: 'INTERNAL', vectorSize: 0 })
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 1536 })
  })

  test('a NEGATIVE vectorSize is floored to 1, NOT to 1536', async () => {
    // Found by running the control rather than by reading: -10 is TRUTHY, so `|| 1536` does NOT apply and the
    // `Math.max(1, ...)` floor is what clamps it -- to 1, a dimension no embedding model produces.
    //
    // Recorded as the current behaviour, and flagged: a 1-dimension collection is accepted here and will only
    // fail later at upsert time, which is the opposite of what the route's fail-closed comment promises for the
    // base-URL and API-key cases. Pinned by assertion so a change to bound the low end is deliberate.
    await put({ provider: 'INTERNAL', vectorSize: -10 })
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 1 })
  })

  test('an explicit plausible vectorSize is stored unchanged', async () => {
    await put({ provider: 'INTERNAL', vectorSize: 3072 })
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 3072 })
  })

  test('a non-numeric vectorSize falls back to 1536', async () => {
    await put({ provider: 'INTERNAL', vectorSize: 'abc' as unknown as number })
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 1536 })
  })

  test('a whitespace-only distance falls back to Cosine', async () => {
    await put({ provider: 'INTERNAL', distance: '   ' })
    expect(creates()[0]!.args.data).toMatchObject({ distance: 'Cosine' })
  })

  test('an empty body is accepted and stores the INTERNAL defaults', async () => {
    // Documented as-is: unlike the resource editors there is no "no fields provided" 400 here, because the
    // route has a full default set and the form can legitimately save an empty state.
    const res = await put({})
    expect(res.status).toBe(200)
    expect(creates()[0]!.args.data).toMatchObject({ provider: 'INTERNAL', collectionName: 'ryasai_chunks' })
  })

  test('a malformed JSON body behaves as an empty body', async () => {
    // `await req.json().catch(() => ({}))` -- deliberately not a 400.
    const res = await put('not json')
    expect(res.status).toBe(200)
  })

  test('a whitespace-only baseUrl is treated as absent', async () => {
    // A stored blank string would satisfy `!baseUrl` nowhere and break the guard's intent.
    await put({ provider: 'INTERNAL', baseUrl: '   ' })
    expect(creates()[0]!.args.data).toMatchObject({ baseUrl: null })
  })
})

describe('the PUT response is the GET response', () => {
  test('PUT delegates to GET, so the masking cannot drift', async () => {
    row = null
    const res = await put({ provider: 'INTERNAL' })
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> }
    expect(body.ok).toBe(true)
    expect(Object.keys(body.data).sort()).toEqual([
      'apiKeyMasked',
      'baseUrl',
      'collectionName',
      'distance',
      'provider',
      'updatedAt',
      'vectorSize',
    ])
  })

  test('the PUT response never echoes the plaintext key that was just submitted', async () => {
    const res = await put({ provider: 'INTERNAL', apiKey: PLAINTEXT_KEY })
    const raw = await res.text()
    expect(raw).not.toContain(PLAINTEXT_KEY)
  })
})

describe('POST — test the vector backend', () => {
  test('with no runtime config it reports INTERNAL without calling ensure', async () => {
    // Not an error: an unconfigured org is legitimately on the internal store, and the UI shows that.
    runtimeConfig = null
    const res = await post()
    expect(await res.json()).toEqual({ ok: true, data: { provider: 'INTERNAL' } })
    expect(ensured).toHaveLength(0)
  })

  test('it ensures the collection and reports the provider and collection name', async () => {
    runtimeConfig = { provider: 'QDRANT', collectionName: 'chunks', backend: 'QDRANT' }
    const res = await post()
    expect(ensured).toHaveLength(1)
    expect(await res.json()).toEqual({
      ok: true,
      data: { provider: 'QDRANT', collectionName: 'chunks' },
    })
  })

  test('the response omits the credentials the runtime config carries', async () => {
    // The config object holds the decrypted apiKey; only the provider + collection may cross the wire.
    runtimeConfig = { provider: 'QDRANT', collectionName: 'chunks', apiKey: PLAINTEXT_KEY, apiKeyEncrypted: STORED_CIPHERTEXT }
    const raw = await (await post()).text()
    expect(raw).not.toContain(PLAINTEXT_KEY)
    expect(raw).not.toContain(STORED_CIPHERTEXT)
  })

  test('a backend failure is a 502 (upstream), not a 500', async () => {
    // The provider is the upstream; reporting our own 500 would send the operator to the wrong logs.
    runtimeConfig = { provider: 'QDRANT', collectionName: 'chunks' }
    ensureThrows = new Error('connection refused')
    const res = await post()
    expect(res.status).toBe(502)
    expect(await res.text()).not.toContain('connection refused')
  })

  test('POST is admin-only and reads the runtime config only after the check', async () => {
    user = { ...adminUser, role: 'viewer' }
    const res = await post()
    expect(res.status).toBe(403)
    expect(ensured).toHaveLength(0)
  })

  test('POST is NOT gated on a stored row existing', async () => {
    // The test must work on a fresh install where the internal store is the only backend.
    row = null
    runtimeConfig = { provider: 'INTERNAL', collectionName: 'ryasai_chunks' }
    expect((await post()).status).toBe(200)
  })
})

describe('internal failures', () => {
  test('a GET failure is 500 without leaking the error text', async () => {
    // A database seam that throws, rather than a deliberately malformed row: the point is the error boundary,
    // not the serialiser.
    row = { id: 'v1', provider: 'QDRANT', updatedAt: { toISOString: () => { throw new Error('connection reset') } } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('connection reset')
  })

  test('a create failure is 500', async () => {
    createThrows = new Error('unique constraint')
    const res = await put({ provider: 'INTERNAL' })
    expect(res.status).toBe(500)
    expect(auditWrites).toHaveLength(0)
  })
})
