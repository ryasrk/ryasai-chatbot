import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// llm-config: the BYOK credential resolution path.
//
// A separate file from llm-config.test.ts, which imports only the pure helpers
// (isBlockedHost, normalizeBaseUrl) and holds no mocks. This file owns the mocks
// for the database-backed resolvers.
//
// Why this path is security-relevant, not just plumbing: ryasai ships no LLM.
// Every org supplies its OWN endpoint, key and model, and `getLlmRuntimeConfig`
// is the single place those credentials are read. With no org context,
// `findFirst()` scans the whole table and returns whichever tenant's row happens
// to be first — a different org's baseUrl, model AND API key. The guard against
// that is what most of these tests hold.
// ---------------------------------------------------------------------------
const state = {
  orgContext: 'org-1' as string | undefined,
  rows: [] as any[],
  findFirstCalls: [] as any[],
  decryptThrows: false,
  decrypted: { apiKey: 'sk-secret' } as any,
  rand: 0,
}

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => state.orgContext,
  enterWithOrg: () => {},
  bypassOrg: (fn: () => unknown) => fn(),
}))
mock.module('@/lib/db', () => ({
  db: {
    llmConfig: {
      findFirst: async (a?: any) => {
        state.findFirstCalls.push(a ?? null)
        // Honours `where: { purpose }` so the purpose-scoped queries are asserted
        // on behaviour rather than on the shape of the call.
        if (a?.where?.purpose) return state.rows.find((r) => r.purpose === a.where.purpose) ?? null
        return state.rows[0] ?? null
      },
    },
  },
}))
mock.module('@/lib/crypto', () => ({
  decryptConfig: () => {
    if (state.decryptThrows) throw new Error('bad tag')
    return state.decrypted
  },
  encryptConfig: (c: any) => `enc:${JSON.stringify(c)}`,
  signSession: () => 'tok',
  verifySession: () => null,
}))

import {
  getLlmRuntimeConfig,
  getAgentLlmConfig,
  getRoleLlmConfig,
  invalidateRoleConfigCache,
  getPublicLlmConfig,
  fetchProviderModels,
  maskSecret,
} from './llm-config'

const row = (o: Record<string, unknown> = {}) => ({
  id: 'c1', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://api.own/v1',
  encryptedApiKey: 'enc-key', model: 'own-model', purpose: 'chat',
  availableModels: null, lastModelSyncAt: null, embeddingProvider: null,
  embeddingBaseUrl: null, embeddingModel: null, encryptedEmbeddingApiKey: null,
  embeddingAvailableModels: null, lastEmbeddingModelSyncAt: null,
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...o,
})

beforeEach(() => {
  state.orgContext = 'org-1'
  state.rows = [row()]
  state.findFirstCalls = []
  state.decryptThrows = false
  state.decrypted = { apiKey: 'sk-secret' }
  invalidateRoleConfigCache()
})

describe('getLlmRuntimeConfig — the credential read', () => {
  test('NO ORG CONTEXT returns null instead of reading another tenant row', async () => {
    state.orgContext = undefined
    // This is the whole guard. Without it findFirst() scans the whole table and
    // returns whichever org's row is first — and the caller then spends a
    // stranger's API key. Proven at runtime in trial/55.
    expect(await getLlmRuntimeConfig()).toBeNull()
    expect(state.findFirstCalls).toHaveLength(0)
  })

  test('the same guard applies to the agent config', async () => {
    state.orgContext = undefined
    expect(await getAgentLlmConfig()).toBeNull()
    expect(state.findFirstCalls).toHaveLength(0)
  })

  test('resolves the purpose=chat row first', async () => {
    state.rows = [row({ purpose: 'agent', model: 'agent-model' }), row({ purpose: 'chat', model: 'chat-model' })]
    const cfg = await getLlmRuntimeConfig()
    expect(cfg?.model).toBe('chat-model')
  })

  test('falls back to any row when no purpose=chat row exists', async () => {
    state.rows = [row({ purpose: 'agent', model: 'only-agent' })]
    const cfg = await getLlmRuntimeConfig()
    expect(cfg?.model).toBe('only-agent')
  })

  test('no row at all resolves to null (fail-closed, never a platform key)', async () => {
    state.rows = []
    expect(await getLlmRuntimeConfig()).toBeNull()
  })

  test('the API key is decrypted for use and never returned masked', async () => {
    const cfg = await getLlmRuntimeConfig()
    // The runtime config feeds outbound HTTP; it needs the real key.
    expect(cfg?.apiKey).toBe('sk-secret')
  })

  test('an undecryptable key throws rather than returning a usable config', async () => {
    state.decryptThrows = true
    // Returning a config with a garbage key would fail later at the provider with
    // a misleading auth error.
    await expect(getLlmRuntimeConfig()).rejects.toThrow()
  })

  test('a decrypted blob with no apiKey is refused', async () => {
    state.decrypted = { somethingElse: 1 }
    await expect(getLlmRuntimeConfig()).rejects.toThrow('Invalid LLM API key')
  })

  test('a whitespace-only decrypted key is refused', async () => {
    state.decrypted = { apiKey: '   ' }
    await expect(getLlmRuntimeConfig()).rejects.toThrow('Invalid LLM API key')
  })
})

describe('getAgentLlmConfig — agent-purpose resolution', () => {
  test('prefers the purpose=agent row when present', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' }), row({ purpose: 'agent', model: 'agent-model' })]
    expect((await getAgentLlmConfig())?.model).toBe('agent-model')
  })

  test('falls back to the chat config when no agent row is configured', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getAgentLlmConfig())?.model).toBe('chat-model')
  })

  test('agent config is org-guarded on the fallback path too', async () => {
    state.orgContext = undefined
    state.rows = []
    expect(await getAgentLlmConfig()).toBeNull()
  })
})

describe('getRoleLlmConfig — role overrides with cache', () => {
  test('chat and agent roles delegate to their resolvers', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('chat'))?.model).toBe('chat-model')
  })

  test('a role-specific row wins for that role', async () => {
    state.rows = [row({ purpose: 'query', model: 'query-model' }), row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('query'))?.model).toBe('query-model')
  })

  test('a role with no row falls back to the chat config (opt-in)', async () => {
    state.rows = [row({ purpose: 'chat', model: 'chat-model' })]
    expect((await getRoleLlmConfig('keyword'))?.model).toBe('chat-model')
  })

  test('the second read is served from cache, not the database', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('extract')
    const afterFirst = state.findFirstCalls.length
    await getRoleLlmConfig('extract')
    // Caching is the point of this layer; without it every extraction request
    // re-reads config.
    expect(state.findFirstCalls.length).toBe(afterFirst)
  })

  test('invalidateRoleConfigCache forces a fresh read', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('extract')
    const afterFirst = state.findFirstCalls.length
    invalidateRoleConfigCache()
    await getRoleLlmConfig('extract')
    expect(state.findFirstCalls.length).toBeGreaterThan(afterFirst)
  })

  test('chat/agent roles are not cached, so a config change is seen immediately', async () => {
    state.rows = [row({ purpose: 'chat' })]
    await getRoleLlmConfig('chat')
    const n = state.findFirstCalls.length
    await getRoleLlmConfig('chat')
    expect(state.findFirstCalls.length).toBeGreaterThan(n)
  })
})

describe('getPublicLlmConfig — what reaches the browser', () => {
  test('an unconfigured org reports configured:false with empty defaults', async () => {
    state.rows = []
    const pub = await getPublicLlmConfig()
    expect(pub.configured).toBe(false)
    expect(pub.apiKeyMasked).toBeNull()
    expect(pub.baseUrl).toBe('')
  })

  test('THE API KEY IS MASKED, never returned in clear text', async () => {
    state.decrypted = { apiKey: 'sk-live-abcdef123456' }
    const pub = await getPublicLlmConfig()
    // A clear key in this payload hands every credential to the browser.
    expect(pub.apiKeyMasked).not.toBe('sk-live-abcdef123456')
    expect(pub.apiKeyMasked).toContain('•')
    expect(JSON.stringify(pub)).not.toContain('sk-live-abcdef123456')
  })

  test('a decryption failure shows a placeholder mask, not the ciphertext', async () => {
    state.decryptThrows = true
    const pub = await getPublicLlmConfig()
    // Degrading here must not leak enc:... or crash the settings page.
    expect(pub.apiKeyMasked).toBe('••••')
  })

  test('the embedding key is masked independently of the chat key', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: 'enc-emb' })]
    state.decrypted = { apiKey: 'sk-live-abcdef123456' }
    const pub = await getPublicLlmConfig()
    expect(pub.embeddingApiKeyMasked).not.toBeNull()
    expect(pub.embeddingApiKeyMasked).toContain('•')
  })

  test('a failed embedding key decryption does not break the whole payload', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: 'enc-emb' })]
    state.decryptThrows = true
    const pub = await getPublicLlmConfig()
    expect(pub.configured).toBe(true)
    expect(pub.embeddingApiKeyMasked).toBe('••••')
  })

  test('no embedding key configured leaves the mask null', async () => {
    state.rows = [row({ encryptedEmbeddingApiKey: null })]
    expect((await getPublicLlmConfig()).embeddingApiKeyMasked).toBeNull()
  })

  test('embedding settings fall back to the chat ones', async () => {
    const pub = await getPublicLlmConfig()
    // Most orgs run one endpoint for both; empty boxes would look unconfigured.
    expect(pub.embeddingBaseUrl).toBe('https://api.own/v1')
    expect(pub.embeddingModel).toBe('text-embedding-3-small')
  })

  test('an explicitly set embedding endpoint overrides the chat one', async () => {
    state.rows = [row({ embeddingBaseUrl: 'https://emb.own/v1', embeddingModel: 'emb-x' })]
    const pub = await getPublicLlmConfig()
    expect(pub.embeddingBaseUrl).toBe('https://emb.own/v1')
    expect(pub.embeddingModel).toBe('emb-x')
  })

  test('the model list is parsed from JSON and a corrupt value yields []', async () => {
    state.rows = [row({ availableModels: '["a","b"]' })]
    expect((await getPublicLlmConfig()).availableModels).toEqual(['a', 'b'])
    state.rows = [row({ availableModels: 'not json' })]
    expect((await getPublicLlmConfig()).availableModels).toEqual([])
  })

  test('sync timestamps are serialised as ISO strings, not Date objects', async () => {
    state.rows = [row({ lastModelSyncAt: new Date('2026-02-02T00:00:00Z') })]
    const pub = await getPublicLlmConfig()
    expect(typeof pub.lastModelSyncAt).toBe('string')
    expect(pub.lastModelSyncAt).toBe('2026-02-02T00:00:00.000Z')
    expect(typeof pub.updatedAt).toBe('string')
  })
})

describe('fetchProviderModels', () => {
  const originalFetch = global.fetch
  test('requires an API key before making any request', async () => {
    let called = false
    global.fetch = (async () => { called = true; return { ok: true, json: async () => ({}) } }) as any
    await expect(fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: '  ' })).rejects.toThrow('API key is required')
    expect(called).toBe(false)
    global.fetch = originalFetch
  })

  test('reads both OpenAI `data` and legacy `models` shapes, deduped and sorted', async () => {
    global.fetch = (async () => ({
      ok: true,
      json: async () => ({ data: [{ id: 'b' }, { id: 'a' }], models: ['a', { id: 'c' }, { name: 'd' }, 42] }),
    })) as any
    const models = await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })
    // Providers differ here; missing one shape makes the model picker empty.
    expect(models).toEqual(['a', 'b', 'c', 'd'])
    global.fetch = originalFetch
  })

  test('a non-2xx response throws with the status', async () => {
    global.fetch = (async () => ({ ok: false, status: 401, json: async () => ({}) })) as any
    await expect(fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).rejects.toThrow('401')
    global.fetch = originalFetch
  })

  test('the key is sent as a Bearer token to the normalised /models URL', async () => {
    let seen: any = null
    global.fetch = (async (url: string, init: any) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ data: [] }) }
    }) as any
    await fetchProviderModels({ baseUrl: 'https://x/v1/', apiKey: ' k ' })
    expect(seen.url).toBe('https://x/v1/models')
    expect(seen.init.headers.Authorization).toBe('Bearer k')
    global.fetch = originalFetch
  })

  test('an entries-less payload yields an empty list rather than throwing', async () => {
    global.fetch = (async () => ({ ok: true, json: async () => ({}) })) as any
    expect(await fetchProviderModels({ baseUrl: 'https://x/v1', apiKey: 'k' })).toEqual([])
    global.fetch = originalFetch
  })
})

describe('maskSecret', () => {
  test('never returns the original string', () => {
    const secret = 'sk-live-abcdef123456'
    expect(maskSecret(secret)).not.toBe(secret)
    expect(maskSecret(secret)).toContain('•')
  })

  test('keeps a recognisable head so an operator can tell keys apart', () => {
    const masked = maskSecret('sk-live-abcdef123456')
    expect(masked.startsWith('sk-l')).toBe(true)
  })
})
