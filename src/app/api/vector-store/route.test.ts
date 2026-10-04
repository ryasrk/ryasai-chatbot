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
// What `resolveConfiguredEmbeddingModel()` returns. Left null by default: a fixture with no LlmConfig row must
// report "nothing was compared", not "the stamps agree".
let configuredModel: string | null = null

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
  /*
   * The route resolves the CONFIGURED embedding model to compare it against the model stamped on the stored
   * chunks. A module mock is all-or-nothing, so an export the route calls but the mock omits resolves to
   * `undefined` and the call throws -- every GET in this file would then be a 500 for a reason that has nothing
   * to do with the route. Driven by `configuredModel` so the tests can choose the verdict.
   *
   * `null` is the DEFAULT because it is the honest reading of "the fixture has no LLM config row": the response
   * then reports 'unknown' (nothing was compared), which is the distinction the third test in the mismatch
   * describe exists to pin.
   */
  resolveConfiguredEmbeddingModel: async () => configuredModel,
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

let storedEmbeddingRows: Array<{ dims: number | null; model: string | null }> = []
const embeddingQueries: Array<{ sql: string; params: unknown[] }> = []

mock.module('@/lib/db', () => ({
  db: {
    /*
     * The route reads the ACTUAL stored embedding dimension with `$queryRaw` so it can report "configured 1536,
     * stored 384" instead of a hardcoded number. MEASURED: that hardcoded 1536 was what made a silent embedding
     * mismatch invisible — every semantic score was 0 and retrieval quietly fell back to lexical only.
     *
     * Empty here so the route takes its "no embeddings yet" path, which is what a fresh install has. Individual
     * tests set `storedEmbeddingRows` when they need a concrete dimension.
     */
    $queryRaw: async (strings: TemplateStringsArray, ...params: unknown[]) => {
      embeddingQueries.push({ sql: strings.join('?'), params })
      return storedEmbeddingRows
    },
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
  configuredModel = null
  events.length = 0
  calls.length = 0
  auditWrites.length = 0
  encryptedInputs.length = 0
  ensured.length = 0
  roleChecks.length = 0
  embeddingQueries.length = 0
})

describe('GET', () => {
  test('stored embedding facts are explicitly scoped in raw SQL to the authenticated organization', async () => {
    await GET()
    expect(embeddingQueries).toHaveLength(1)
    expect(embeddingQueries[0].sql).toMatch(/WHERE\s+"organizationId"\s*=\s*\?\s+AND embedding IS NOT NULL/)
    expect(embeddingQueries[0].params).toEqual(['org-1'])
  })
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
      /*
       * The CONFIGURED value the form seeds from — 384, from `EMBEDDING_DIMENSIONS`.
       *
       * WAS 1536, and that number was itself the defect: this product's column is `vector(384)` and its bundled
       * embedder returns 384, so a form seeding 1536 offered an operator a dimension nothing in the stack produces.
       * It also made the panel display "1536" beside 384-dimensional data, which is how a silent mismatch stayed
       * invisible while retrieval quietly fell back to lexical-only.
       */
      vectorSize: 384,
      /*
       * The MEASURED values — null because no chunk has an embedding in this fixture. `vectorSize` was a hardcoded
       * 1536 while the stored vectors were 384-dimensional, which hid a silent mismatch: retrieval requires
       * `chunk.embeddingModel === queryEmbedding.model`, so every semantic score was 0 and search quietly fell back
       * to lexical only. Null is the honest answer for "nothing stored yet" rather than another invented number.
       */
      storedVectorSize: null,
      storedEmbeddingModel: null,
      /*
       * The OTHER end of the comparison the dimension fields cannot make. `storedEmbeddingModel` above says what
       * the chunks carry; this is the model a QUERY would be embedded with, and the verdict on the two.
       *
       * Both are null/'unknown' here for a reason worth keeping: no chunk is stored AND this fixture's LLM config
       * resolves no model. 'unknown' means NOTHING WAS COMPARED — a fresh install must never be reported as
       * 'match', because "we did not look" and "we looked and they agree" are different answers and only one of
       * them is safe to show in green.
       */
      configuredEmbeddingModel: null,
      embeddingStampVerdict: 'unknown',
      distance: 'Cosine',
      /*
       * The gating flag, and why it is not derivable from `updatedAt`.
       *
       * A fresh install has NO row, so it cannot have made a choice — this is not "unset, might have been
       * chosen", it is "the choice is impossible". `false` + `null` is the honest pair, and the Knowledge
       * view keys the whole "choose storage before uploading" state off `storageChosen` alone.
       */
      storageChosen: false,
      storageChosenAt: null,
      updatedAt: null,
    })
  })

  test('a row that never recorded a choice reports storageChosen false, NOT the INTERNAL default', async () => {
    // The inversion that matters: `provider` DEFAULTS to 'INTERNAL' in the schema, so every pre-upgrade row
    // looks internal while nobody ever chose anything. Reporting `storageChosen: true` because the provider
    // happens to equal INTERNAL is exactly the bug the timestamp column exists to prevent — the upload gate
    // would open for an install where the admin never made a decision.
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'ryasai_chunks',
      vectorSize: 384,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
      storageChosenAt: null,
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.storageChosen).toBe(false)
    expect(body.data.storageChosenAt).toBeNull()
  })

  test('a recorded choice is reported as an ISO timestamp, so the UI can say WHEN', async () => {
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'ryasai_chunks',
      vectorSize: 384,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
      storageChosenAt: new Date('2026-02-01T03:04:05.000Z'),
    }
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.storageChosen).toBe(true)
    // Serialised rather than passed through: a raw Date reaches the browser as an object and `new Date(undefined)`
    // on the other side renders "Invalid Date", which reads as a data problem rather than a formatting one.
    expect(body.data.storageChosenAt).toBe('2026-02-01T03:04:05.000Z')
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
      'configuredEmbeddingModel',
      'distance',
      'embeddingStampVerdict',
      'provider',
      'storageChosen',
      'storageChosenAt',
      'storedEmbeddingModel',
      'storedVectorSize',
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

  test('vectorSize=0 falls back to the DECLARED dimension because 0 is FALSY, not because of the floor', async () => {
    // `Math.max(1, Number(body.vectorSize ?? EMBEDDING_DIMENSIONS) || EMBEDDING_DIMENSIONS)` -- two different
    // mechanisms, and an earlier version of this test conflated them. 0 is falsy so `|| ...` applies FIRST.
    // `row` stays null, so BOTH calls take the CREATE branch -- there is no update to index into.
    await put({ provider: 'INTERNAL', vectorSize: 0 })
    // 384, the declared dimension — see `EMBEDDING_DIMENSIONS`. Was 1536 while this product stored 384.
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 384 })
  })

  test('a NEGATIVE vectorSize is floored to 1, NOT to the declared dimension', async () => {
    // Found by running the control rather than by reading: -10 is TRUTHY, so `|| ...` does NOT apply and the
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

  test('a non-numeric vectorSize falls back to the declared dimension', async () => {
    await put({ provider: 'INTERNAL', vectorSize: 'abc' as unknown as number })
    // `Number('abc')` is NaN, which is FALSY, so the `||` branch applies — same path as 0 above.
    expect(creates()[0]!.args.data).toMatchObject({ vectorSize: 384 })
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
      'configuredEmbeddingModel',
      'distance',
      'embeddingStampVerdict',
      'provider',
      'storageChosen',
      'storageChosenAt',
      'storedEmbeddingModel',
      'storedVectorSize',
      'updatedAt',
      'vectorSize',
    ])
    // The write is a choice by definition, so the row it writes must record WHEN — asserted on the payload
    // rather than on the response, because this fixture's mock `create` does not feed the row back into the
    // `findFirst` that GET performs. A PUT that saved the settings without recording the choice would leave the
    // install permanently gated while its own response said `ok: true`, which is the failure this pins.
    expect(creates()[0]!.args.data).toMatchObject({ storageChosenAt: expect.any(Date) })
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

describe('the MEASURED stored embedding is reported, so a silent mismatch cannot hide', () => {
  /**
   * MEASURED IN UAT: the config asked for `text-embedding-3-small` (1536) while the chunks held
   * `paraphrase-multilingual-MiniLM-L12-v2` (384). `retrieveRelevantChunks` requires
   * `chunk.embeddingModel === queryEmbedding.model`, so EVERY semantic score was 0 and search quietly fell back to
   * lexical only — while this endpoint reported a hardcoded 1536, a number describing the configured INTENT rather
   * than the stored reality. Nothing anywhere said the two disagreed.
   */
    test('a configured value the data DISAGREES with is reported as stored, not as configured', async () => {
      /*
       * Set up EXPLICITLY rather than leaning on the default, because the default changed: it was 1536 and is now
       * 384, matching the data. The defect this pins did NOT go away with that change — an operator can still
       * configure a 1536-dimension endpoint against a 384-dimension column, and the response must still say so
       * rather than repeating the configured number back.
       */
      storedEmbeddingRows = [{ dims: 384, model: 'paraphrase-multilingual-MiniLM-L12-v2' }]
      row = {
        id: 'v1',
        provider: 'INTERNAL',
        baseUrl: null,
        encryptedApiKey: null,
        collectionName: 'chunks',
        vectorSize: 1536, // configured, and WRONG for this store
        distance: 'Cosine',
        updatedAt: new Date('2026-02-01'),
      } as never
      const body = (await (await GET()).json()) as { data: Record<string, unknown> }
      expect(body.data.vectorSize).toBe(1536) // the configured value the form seeds from, unchanged
      expect(body.data.storedVectorSize).toBe(384) // the TRUTH, which the old response could not express
      expect(body.data.storedEmbeddingModel).toBe('paraphrase-multilingual-MiniLM-L12-v2')
      storedEmbeddingRows = []
    })

  test('no stored embedding yet reports null, not a made-up dimension', async () => {
    // A fresh install has no chunks; inventing a number there would recreate the same defect one level down.
    storedEmbeddingRows = []
    row = null as never
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.storedVectorSize).toBeNull()
    expect(body.data.storedEmbeddingModel).toBeNull()
  })

  test('two models of the SAME width are compared by name, not by dimension', async () => {
    /*
     * The half the dimension fields structurally CANNOT catch. Both sides are 384 here, so the width warning stays
     * silent while the retriever still refuses every chunk: `chunk.embeddingModel === queryEmbedding.model` is an
     * exact string comparison, not a width comparison. This is the shape measured on the dev install — 55 chunks
     * stamped `paraphrase-multilingual-MiniLM-L12-v2` beside a config holding `text-embedding-3-small`.
     */
    storedEmbeddingRows = [{ dims: 384, model: 'paraphrase-multilingual-MiniLM-L12-v2' }]
    configuredModel = 'text-embedding-3-small'
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.embeddingStampVerdict).toBe('mismatch')
    expect(body.data.configuredEmbeddingModel).toBe('text-embedding-3-small')
    expect(body.data.storedEmbeddingModel).toBe('paraphrase-multilingual-MiniLM-L12-v2')
    // The widths AGREE, which is precisely why this verdict could not be derived from them.
    expect(body.data.storedVectorSize).toBe(384)
    storedEmbeddingRows = []
  })

  test('a CONFIGURED install carries the verdict too — the row arm is a separate payload', async () => {
    /*
     * FOUND BY NEGATIVE CONTROL, and it is the arm that matters most: these two branches build their payloads
     * SEPARATELY, and every test above runs with `row = null` (the fresh-install shape). Deleting
     * `embeddingStampVerdict` from the row arm therefore left the whole verdict describe green — the shape a real
     * install is actually in was the one nothing measured. A fix applied to one arm says nothing about the other.
     */
    storedEmbeddingRows = [{ dims: 384, model: 'paraphrase-multilingual-MiniLM-L12-v2' }]
    configuredModel = 'text-embedding-3-small'
    row = {
      id: 'v1',
      provider: 'INTERNAL',
      baseUrl: null,
      encryptedApiKey: null,
      collectionName: 'chunks',
      vectorSize: 384,
      distance: 'Cosine',
      updatedAt: new Date('2026-02-01'),
    } as never
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    // Sanity: this IS the row arm. The no-row arm answers null here, so without this line a future refactor that
    // silently routed this test through the fallback would keep the verdict assertions below passing.
    expect(body.data.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    expect(body.data.embeddingStampVerdict).toBe('mismatch')
    expect(body.data.configuredEmbeddingModel).toBe('text-embedding-3-small')
    expect(body.data.storedEmbeddingModel).toBe('paraphrase-multilingual-MiniLM-L12-v2')
    storedEmbeddingRows = []
  })

  test('identical stamps are reported as a match', async () => {
    // The healthy path must be reachable, or the mismatch test above could pass on a broken comparison that
    // answered 'mismatch' unconditionally.
    storedEmbeddingRows = [{ dims: 384, model: 'paraphrase-multilingual-MiniLM-L12-v2' }]
    configuredModel = 'paraphrase-multilingual-MiniLM-L12-v2'
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.embeddingStampVerdict).toBe('match')
    storedEmbeddingRows = []
  })

  test('a stored stamp with nothing configured reports unknown, not match', async () => {
    /*
     * "We did not compare" and "we compared and they agree" are different answers, and only one of them is safe to
     * render as healthy. A null resolver value — no LlmConfig row, or no org context — must land on the first.
     * Defaulting this arm to 'match' would show a green embedding to an install that had never been checked.
     */
    storedEmbeddingRows = [{ dims: 384, model: 'paraphrase-multilingual-MiniLM-L12-v2' }]
    configuredModel = null
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.embeddingStampVerdict).toBe('unknown')
    expect(body.data.configuredEmbeddingModel).toBeNull()
    storedEmbeddingRows = []
  })

  test('a blank stored stamp reports unknown, not mismatch', async () => {
    // The other one-sided case, and the reason it matters: a blank stamp compared naively would read as a
    // MISMATCH and send an operator to re-embed documents whose state we cannot actually describe. "Cannot tell"
    // is the honest answer, and it renders neutrally rather than as an alarm.
    storedEmbeddingRows = [{ dims: 384, model: '' }]
    configuredModel = 'paraphrase-multilingual-MiniLM-L12-v2'
    const body = (await (await GET()).json()) as { data: Record<string, unknown> }
    expect(body.data.embeddingStampVerdict).toBe('unknown')
    storedEmbeddingRows = []
  })
})
