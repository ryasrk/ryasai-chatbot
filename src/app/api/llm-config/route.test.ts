/**
 * GET + PUT /api/llm-config — the tenant's own LLM credential. BYOK, so this row IS the customer's money.
 *
 * WHY THIS FILE EXISTS. Same orphan backlog, and this route is the one that stores a billable secret. Two
 * properties matter far more than the field plumbing:
 *
 *   1. THE KEY NEVER LEAVES. GET must return the MASKED public view (`getPublicLlmConfig`), never the row.
 *      A single `NextResponse.json(await db.llmConfig.findFirst())` regression here leaks a live API key
 *      to any viewer-role session. Asserted by scanning the whole serialised response for the plaintext.
 *   2. A BLANK apiKey ON UPDATE ROTATES NOTHING. The edit form does not echo the stored key back, so it
 *      submits an empty string; treating that as "set the key to empty" would silently disable the
 *      customer's chatbot on an unrelated edit. The route keeps `existing.encryptedApiKey` -- and, on
 *      CREATE with no key at all, refuses with 400 rather than storing a config that cannot work.
 *
 * Also pinned: the provider whitelist (an unknown value must NOT be persisted verbatim), the embedding
 * key fallback to the chat key, admin-only writes, and the audit row's rotation flags.
 */
import { describe, expect, test, beforeEach, mock } from 'bun:test'

const adminUser = {
  userId: 'admin-1',
  name: 'Admin',
  email: 'a@t.com',
  role: 'admin',
  organizationId: 'org-1',
  plan: null,
}

const PLAINTEXT_KEY = 'sk-live-SUPERSECRET-1234567890'

let activeUser: typeof adminUser = adminUser
let existingRow: Record<string, unknown> | null = null
const findFirstArgs: Array<Record<string, unknown>> = []
const createArgs: Array<Record<string, unknown>> = []
const updateArgs: Array<Record<string, unknown>> = []
const auditWrites: Array<Record<string, unknown>> = []
const enteredOrgs: string[] = []
const encrypted: Array<Record<string, unknown>> = []
/** When true, the mocked mask helper throws -- to exercise the route's catch block. */
let maskThrows = false

mock.module('@/lib/session', () => ({
  getActiveUser: async () => activeUser,
  requireRole: (user: { role: string }, role: string) => {
    if (user.role !== role) {
      const e = new Error('Forbidden') as Error & { statusCode?: number }
      e.statusCode = 403
      throw e
    }
  },
  writeAudit: async (row: Record<string, unknown>) => {
    auditWrites.push(row)
  },
  handleApiError: (e: unknown, msg: string) =>
    Response.json({ error: msg }, { status: (e as { statusCode?: number })?.statusCode ?? 500 }),
}))

mock.module('@/lib/prisma-tenant', () => ({
  enterWithOrg: (orgId: string) => {
    enteredOrgs.push(orgId)
  },
}))

// The real encryptor is lossless enough to assert on: it round-trips the plaintext into a `v1:` envelope.
mock.module('@/lib/crypto', () => ({
  encryptConfig: (obj: Record<string, unknown>) => {
    encrypted.push(obj)
    return `enc:${Buffer.from(JSON.stringify(obj)).toString('base64url')}`
  },
}))

mock.module('@/lib/llm-config', () => ({
  getPublicLlmConfig: async () => {
    if (maskThrows) throw new Error('mask failed')
    return existingRow
      ? {
          provider: existingRow.provider,
          baseUrl: existingRow.baseUrl,
          model: existingRow.model,
          hasApiKey: Boolean(existingRow.encryptedApiKey),
          apiKeyMasked: existingRow.encryptedApiKey ? 'sk-l••••••••' : '',
          embeddingProvider: existingRow.embeddingProvider,
          embeddingBaseUrl: existingRow.embeddingBaseUrl,
          embeddingModel: existingRow.embeddingModel,
          hasEmbeddingApiKey: Boolean(existingRow.encryptedEmbeddingApiKey),
        }
      : null
  },
  // Only the two accepted shapes pass; anything else throws, exactly like the real normaliser.
  normalizeBaseUrl: (raw: string) => {
    const s = String(raw ?? '').trim()
    if (!s) throw new Error('Base URL is required.')
    if (!/^https?:\/\//i.test(s)) throw new Error('Base URL must start with http:// or https://')
    if (/\s/.test(s)) throw new Error('Base URL must not contain spaces.')
    return s.replace(/\/+$/, '')
  },
}))

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      findFirst: async (args?: Record<string, unknown>) => {
        findFirstArgs.push(args ?? {})
        return existingRow
      },
      create: async (args: Record<string, unknown>) => {
        createArgs.push(args)
        return {}
      },
      update: async (args: Record<string, unknown>) => {
        updateArgs.push(args)
        return {}
      },
    },
  },
}))

import { GET, PUT } from './route'

function put(body: unknown) {
  return PUT(
    new Request('http://localhost/api/llm-config', {
      method: 'PUT',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }) as never,
  )
}

const validBody = {
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://api.example.com/v1',
  apiKey: PLAINTEXT_KEY,
  model: 'gpt-4o-mini',
}

beforeEach(() => {
  activeUser = adminUser
  existingRow = null
  findFirstArgs.length = 0
  createArgs.length = 0
  updateArgs.length = 0
  auditWrites.length = 0
  enteredOrgs.length = 0
  encrypted.length = 0
  maskThrows = false
})

describe('GET /api/llm-config — the credential must not leave', () => {
  test('the response NEVER contains the stored ciphertext or a plaintext key', async () => {
    // The regression this guards: swapping getPublicLlmConfig() for the raw row. A viewer session could
    // then read a live billable key straight out of the API.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      encryptedApiKey: 'enc:SUPERSECRETCIPHERTEXT',
      encryptedEmbeddingApiKey: 'enc:EMBEDCIPHERTEXT',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.example.com/v1',
      embeddingModel: 'text-embedding-3-small',
    }
    const res = await GET()
    const raw = await res.text()
    expect(raw).not.toContain('SUPERSECRETCIPHERTEXT')
    expect(raw).not.toContain('EMBEDCIPHERTEXT')
    expect(raw).not.toContain(PLAINTEXT_KEY)
    expect(raw).not.toContain('encryptedApiKey')
    expect(raw).not.toContain('encryptedEmbeddingApiKey')
  })

  test('it reports a MASK and a has-key boolean instead', async () => {
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      encryptedApiKey: 'enc:x',
      encryptedEmbeddingApiKey: 'enc:y',
      embeddingProvider: 'OPENAI_COMPATIBLE',
      embeddingBaseUrl: 'https://api.example.com/v1',
      embeddingModel: 'text-embedding-3-small',
    }
    const res = await GET()
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.hasApiKey).toBe(true)
    expect(body.data.hasEmbeddingApiKey).toBe(true)
    expect(body.data.apiKeyMasked).toBe('sk-l••••••••')
  })

  test('an unconfigured org gets a null config, not a leak of someone else', async () => {
    existingRow = null
    const res = await GET()
    const body = (await res.json()) as { ok: boolean; data: unknown }
    expect(body.ok).toBe(true)
    expect(body.data).toBeNull()
  })

  test('the org context is entered before the config read', async () => {
    await GET()
    // Only the org entry is observable here: the read goes through getPublicLlmConfig, which this file
    // mocks, so no db call happens. That is the honest scope of this test -- the DB-level identity between
    // `findFirst` and the scoped read is llm-config.ts's own test's job, not this route's.
    expect(enteredOrgs).toEqual(['org-1'])
  })

  test('a failure inside the mask helper is reported, not leaked', async () => {
    // Covers the route's catch. A crash while building the public view must become the typed error
    // response -- crucially it must NOT fall back to returning the raw row.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      encryptedApiKey: 'enc:SUPERSECRETCIPHERTEXT',
    }
    maskThrows = true
    const res = await GET()
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('SUPERSECRET')
  })
})

describe('PUT /api/llm-config — rotating vs keeping the key', () => {
  test('a NEW org must supply a key; blank is refused rather than stored empty', async () => {
    existingRow = null
    const res = await put({ ...validBody, apiKey: '' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
    expect(encrypted).toHaveLength(0)
  })

  test('an UPDATE with a blank key KEEPS the existing ciphertext', async () => {
    // The edit form does not echo the key, so a blank submit is the NORMAL path. Interpreting it as "clear
    // the key" would disable the customer's chatbot because they renamed a model.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://old.example.com/v1',
      model: 'gpt-3.5',
      encryptedApiKey: 'enc:KEEP-ME',
      encryptedEmbeddingApiKey: 'enc:KEEP-EMBED',
    }
    const res = await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://new.example.com/v1', apiKey: '', model: 'gpt-4o' })
    expect(res.status).toBe(200)
    expect(updateArgs).toHaveLength(1)
    // The update payload must simply carry no key field at all, leaving the stored value untouched.
    expect(updateArgs[0]!.data).not.toHaveProperty('encryptedApiKey')
    expect(updateArgs[0]!.data).not.toHaveProperty('encryptedEmbeddingApiKey')
    expect(updateArgs[0]!.data).toMatchObject({ baseUrl: 'https://new.example.com/v1', model: 'gpt-4o' })
  })

  test('UPDATE with a blank key leaves the row at the SAME ciphertext value', async () => {
    // The payload must either OMIT the key field or write the old value back. Writing '' or null would
    // disable the customer's chatbot on an unrelated edit.
    //
    // MUTATION CONTROL, AND ITS LIMIT -- both verified rather than assumed. Mutating the fallback so that a
    // blank key yields '' does NOT turn this test red, and the reason is a DIFFERENT, stronger guard: the
    // payload spreads the key conditionally (`...(apiKey ? { encryptedApiKey } : {})`, line 96), so a blank
    // key means the field never enters the update at all. The mutation is therefore UNOBSERVABLE by
    // construction -- the same "the bug hides itself" situation this repo documents elsewhere. It is
    // declared here instead of being dressed up, and the test below pins the PROPERTY (a second blank-key
    // edit is a no-op on the key) rather than claiming a control that cannot bite.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      encryptedApiKey: 'enc:KEEP-ME',
      encryptedEmbeddingApiKey: 'enc:KEEP-EMBED',
    }
    const before = existingRow.encryptedApiKey
    await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.example.com/v1', apiKey: '' })
    // The route either omits the field (payload merged onto the row leaves it intact) or writes the old
    // value back -- both are correct. Writing '' or null is not.
    const data = updateArgs[0]!.data as { encryptedApiKey?: unknown }
    const after = 'encryptedApiKey' in data ? data.encryptedApiKey : before
    expect(after).toBe(before)
    expect(after).not.toBe('')
    expect(after).not.toBeNull()
  })

  test('a blank key on update does not disturb the EMBEDDING ciphertext either', async () => {
    // Same trap on the second secret: the embedding key has its own fallback chain and can be clobbered
    // independently of the chat key.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      encryptedApiKey: 'enc:KEEP-ME',
      encryptedEmbeddingApiKey: 'enc:KEEP-EMBED',
    }
    await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.example.com/v1', apiKey: '' })
    const data = updateArgs[0]!.data as { encryptedEmbeddingApiKey?: unknown }
    const after = 'encryptedEmbeddingApiKey' in data ? data.encryptedEmbeddingApiKey : 'enc:KEEP-EMBED'
    expect(after).toBe('enc:KEEP-EMBED')
    expect(after).not.toBe('')
  })

  test('two consecutive blank-key edits leave the key untouched the whole way', async () => {
    // The property, exercised end to end: whatever the route does with the payload, a config that had a
    // key STILL has the identical ciphertext after a rename and after a second rename.
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
      encryptedApiKey: 'enc:KEEP-ME',
      encryptedEmbeddingApiKey: 'enc:KEEP-EMBED',
    }
    await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://a.example.com/v1', apiKey: '' })
    await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://b.example.com/v1', apiKey: '' })
    for (const call of updateArgs) {
      const d = call.data as { encryptedApiKey?: unknown; encryptedEmbeddingApiKey?: unknown }
      if ('encryptedApiKey' in d) expect(d.encryptedApiKey).toBe('enc:KEEP-ME')
      if ('encryptedEmbeddingApiKey' in d) expect(d.encryptedEmbeddingApiKey).toBe('enc:KEEP-EMBED')
    }
    // And the payload never carries a falsy key value.
    expect(updateArgs.every((c) => (c.data as { encryptedApiKey?: unknown }).encryptedApiKey !== '')).toBe(true)
  })

  test('a NEW org that supplies ONLY an embedding key is still refused', async () => {
    // The requirement is on the chat key specifically. An embedding-only config would resolve a chat
    // backend with no credential and fail at the first message.
    existingRow = null
    const res = await put({ ...validBody, apiKey: '', embeddingApiKey: 'sk-embed-only' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('a SUPPLIED key is encrypted and only the ciphertext is written', async () => {
    existingRow = null
    await put(validBody)
    expect(createArgs).toHaveLength(1)
    const data = createArgs[0]!.data as { encryptedApiKey: string }
    expect(data.encryptedApiKey).toMatch(/^enc:/)
    expect(data.encryptedApiKey).not.toBe(PLAINTEXT_KEY)
    expect(JSON.stringify(data)).not.toContain(PLAINTEXT_KEY)
  })

  test('a supplied embedding key is encrypted SEPARATELY from the chat key', async () => {
    existingRow = null
    await put({ ...validBody, embeddingApiKey: 'sk-embed-SECRET' })
    expect(encrypted).toHaveLength(2)
    const data = createArgs[0]!.data as { encryptedApiKey: string; encryptedEmbeddingApiKey: string }
    expect(data.encryptedApiKey).not.toBe(data.encryptedEmbeddingApiKey)
    expect(JSON.stringify(data)).not.toContain('sk-embed-SECRET')
  })

  test('the embedding key falls back to the chat key VALUE, not to a re-encryption of something else', async () => {
    // Found by negative control K8: dropping the `|| apiKey` fallback left every test green because the
    // assertions only ran on paths where an explicit embedding key was supplied. Asserted here on the
    // ENCRYPTOR'S INPUT, so the fallback is proven to carry the chat key and not merely to produce some
    // ciphertext.
    existingRow = null
    await put({ ...validBody, embeddingApiKey: '' })
    expect(encrypted).toEqual([{ apiKey: PLAINTEXT_KEY }, { apiKey: PLAINTEXT_KEY }])
  })

  test('an explicit embedding key is what gets encrypted, not the chat key', async () => {
    // The other direction of the same bug: a fallback that always wins would silently ignore the key the
    // operator supplied for a separate embedding provider.
    existingRow = null
    await put({ ...validBody, embeddingApiKey: 'sk-embed-DISTINCT' })
    expect(encrypted).toEqual([{ apiKey: PLAINTEXT_KEY }, { apiKey: 'sk-embed-DISTINCT' }])
  })

  test('with no embedding key the CHAT key is reused for embeddings', async () => {
    // Auto-copy: most BYOK providers serve both. Without the fallback the embedding call would fail closed
    // and RAG would silently degrade to lexical-only.
    existingRow = null
    await put({ ...validBody, embeddingApiKey: '' })
    const data = createArgs[0]!.data as { encryptedApiKey: string; encryptedEmbeddingApiKey: string }
    expect(data.encryptedEmbeddingApiKey).toBe(data.encryptedApiKey)
  })

  test('the audit row records whether each key was ROTATED', async () => {
    // keyRotated is the security-relevant fact in the log; without it a reviewer cannot tell a rename from
    // a credential change.
    existingRow = null
    await put(validBody)
    expect(auditWrites[0]).toMatchObject({
      userId: 'admin-1',
      action: 'LLM_CONFIG_UPDATE',
      severity: 'warning',
      detail: { keyRotated: true, embeddingKeyRotated: false },
    })
  })

  test('the audit row carries NO key material', async () => {
    existingRow = null
    await put({ ...validBody, embeddingApiKey: 'sk-embed-SECRET' })
    const logged = JSON.stringify(auditWrites[0])
    expect(logged).not.toContain(PLAINTEXT_KEY)
    expect(logged).not.toContain('sk-embed-SECRET')
  })
})

describe('PUT /api/llm-config — validation and the provider whitelist', () => {
  test('an UNKNOWN provider is not persisted verbatim', async () => {
    // The value lands in a column every transport branches on. Persisting 'openaicompatible ' or 'GROQ'
    // produces a config row that reads as configured and fails at the first call.
    existingRow = null
    await put({ ...validBody, provider: 'GROQ' })
    expect((createArgs[0]!.data as { provider: string }).provider).toBe('OPENAI_COMPATIBLE')
  })

  test('provider and embeddingProvider are normalised to upper case', async () => {
    existingRow = null
    await put({ ...validBody, provider: 'anthropic_compatible', embeddingProvider: 'anthropic_compatible' })
    const data = createArgs[0]!.data as { provider: string; embeddingProvider: string }
    expect(data.provider).toBe('ANTHROPIC_COMPATIBLE')
    expect(data.embeddingProvider).toBe('ANTHROPIC_COMPATIBLE')
  })

  test('an invalid baseUrl is a 400 and nothing is written', async () => {
    existingRow = null
    const res = await put({ ...validBody, baseUrl: 'not-a-url' })
    expect(res.status).toBe(400)
    expect(createArgs).toHaveLength(0)
  })

  test('a MISSING baseUrl is a 400', async () => {
    existingRow = null
    const res = await put({ ...validBody, baseUrl: '' })
    expect(res.status).toBe(400)
  })

  test('a trailing slash is stripped so the API paths do not double up', async () => {
    existingRow = null
    await put({ ...validBody, baseUrl: 'https://api.example.com/v1///' })
    expect((createArgs[0]!.data as { baseUrl: string }).baseUrl).toBe('https://api.example.com/v1')
  })

  test('the embedding base URL falls back to the chat base URL', async () => {
    existingRow = null
    await put(validBody)
    const data = createArgs[0]!.data as { baseUrl: string; embeddingBaseUrl: string }
    expect(data.embeddingBaseUrl).toBe(data.baseUrl)
  })

  test('an explicit embedding base URL wins over the fallback', async () => {
    existingRow = null
    await put({ ...validBody, embeddingBaseUrl: 'https://embed.example.com/v1' })
    expect((createArgs[0]!.data as { embeddingBaseUrl: string }).embeddingBaseUrl).toBe(
      'https://embed.example.com/v1',
    )
  })

  test('a blank embedding model falls back to the documented default', async () => {
    existingRow = null
    await put({ ...validBody, embeddingModel: '' })
    expect((createArgs[0]!.data as { embeddingModel: string }).embeddingModel).toBe(
      'text-embedding-3-small',
    )
  })

  test('a blank model on UPDATE keeps the stored model instead of clearing it', async () => {
    existingRow = {
      id: 'cfg-1',
      provider: 'OPENAI_COMPATIBLE',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o-mini',
      encryptedApiKey: 'enc:KEEP',
    }
    await put({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.example.com/v1', model: '' })
    expect(updateArgs[0]!.data).toMatchObject({ model: 'gpt-4o-mini' })
  })

  test('a non-admin cannot write the config', async () => {
    // The customer's credential is not an analyst-editable field.
    activeUser = { ...adminUser, role: 'analyst' }
    const res = await put(validBody)
    expect(res.status).toBe(403)
    expect(updateArgs).toHaveLength(0)
    expect(createArgs).toHaveLength(0)
  })

  test('a non-admin may still READ the masked config', async () => {
    existingRow = { id: 'cfg-1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://x/v1', model: 'm' }
    activeUser = { ...adminUser, role: 'viewer' }
    const res = await GET()
    expect(res.status).toBe(200)
  })

  test('a malformed body is treated as empty, so a new org is refused with 400', async () => {
    existingRow = null
    const res = await PUT(
      new Request('http://localhost/api/llm-config', {
        method: 'PUT',
        body: 'not json',
        headers: { 'content-type': 'application/json' },
      }) as never,
    )
    expect(res.status).toBe(400)
  })

  test('the CREATE path stamps organizationId and purpose itself', async () => {
    // `organizationId` comes from the SESSION, never the body -- a body-supplied org would be a
    // cross-tenant write.
    existingRow = null
    await put(validBody)
    const data = createArgs[0]!.data as { organizationId: string; purpose: string }
    expect(data.organizationId).toBe('org-1')
    expect(data.purpose).toBe('chat')
  })

  test('a body cannot redirect the write to another organization', async () => {
    existingRow = null
    await put({ ...validBody, organizationId: 'org-EVIL' })
    expect((createArgs[0]!.data as { organizationId: string }).organizationId).toBe('org-1')
  })
})
