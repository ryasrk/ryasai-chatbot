import { describe, expect, test, mock } from 'bun:test'

// Two cross-tenant defects found by RUNNING the system (not by reading it),
// both in code that looked org-scoped because its caller was.
//
// 1. getLlmRuntimeConfig / getEmbeddingRuntimeConfig called `findFirst()` with no
//    org filter. The tenant extension only scopes a query when an org context is
//    active, so a context-FREE call scanned the whole table and returned the
//    FIRST row in it — another tenant's baseUrl, model and API key. Proven at
//    runtime (trial/55): org B's call returned org A's embedding model and
//    endpoint.
//
// 2. The question-embedding cache was keyed on the question string alone. It is
//    module-scope, i.e. process-wide, so two orgs asking the SAME question shared
//    one entry and the second received the first's vectors (trial/50 showed
//    byte-identical vectors from different configured models).
//
// The guards below assert the MECHANISM (no config without an org) rather than
// the presence of an identifier, and are negative-controlled: reverting either
// fix fails them.

type Row = Record<string, unknown>

let findFirstCalls: unknown[] = []
const OTHER_TENANT_ROW: Row = {
  id: 'cfg-other',
  organizationId: 'org-OTHER',
  provider: 'OPENAI_COMPATIBLE',
  baseUrl: 'https://other-tenant.example/v1',
  model: 'other-tenant-model',
  encryptedApiKey: 'deadbeef',
  embeddingProvider: 'OPENAI_COMPATIBLE',
  embeddingBaseUrl: 'https://other-tenant.example/v1',
  embeddingModel: 'other-tenant-embedding',
  encryptedEmbeddingApiKey: 'deadbeef',
}

const mockDb = {
  llmConfig: {
    findFirst: mock(async (args?: unknown) => {
      findFirstCalls.push(args)
      // Simulates the real hazard: an unscoped findFirst returns A row regardless
      // of tenant. If production code filters by org it must not reach this.
      return OTHER_TENANT_ROW
    }),
    findMany: mock(async () => [OTHER_TENANT_ROW]),
  },
}

mock.module('@/lib/db', () => ({ db: mockDb }))
mock.module('@/lib/crypto', () => ({ decryptConfig: () => ({ apiKey: 'sk-other' }) }))

let orgCtx: string | null = null

mock.module('@/lib/prisma-tenant', () => ({
  getOrgContext: () => orgCtx,
  enterWithOrg: (id: string) => { orgCtx = id },
  bypassOrg: async (fn: () => unknown) => fn(),
}))

const { getLlmRuntimeConfig, getAgentLlmConfig } = await import('@/lib/llm-config')
const { getEmbeddingRuntimeConfig } = await import('@/lib/embeddings')

describe('LLM/embedding config is never read without an org context', () => {
  test('getLlmRuntimeConfig refuses with no org context', async () => {
    orgCtx = null
    findFirstCalls = []
    const cfg = await getLlmRuntimeConfig()
    expect(cfg).toBeNull()
    // The mechanism: it must not even attempt a query.
    expect(findFirstCalls.length).toBe(0)
  })

  test('getEmbeddingRuntimeConfig refuses with no org context', async () => {
    orgCtx = null
    findFirstCalls = []
    const cfg = await getEmbeddingRuntimeConfig()
    expect(cfg).toBeNull()
    expect(findFirstCalls.length).toBe(0)
  })

  test('getAgentLlmConfig refuses with no org context', async () => {
    orgCtx = null
    findFirstCalls = []
    expect(await getAgentLlmConfig()).toBeNull()
    expect(findFirstCalls.length).toBe(0)
  })

  test('an org context is required but sufficient to resolve config', async () => {
    orgCtx = 'org-A'
    findFirstCalls = []
    const cfg = await getLlmRuntimeConfig()
    expect(cfg).not.toBeNull()
    expect(findFirstCalls.length).toBeGreaterThan(0)
  })
})

describe('question embedding cache is scoped per org and per embedding config', () => {
  test('same question, different scope, does not reuse the cached vector', async () => {
    const { getQuestionEmbedding } = await import('@/lib/smart-router-helpers')
    const embedCalls: string[] = []
    const embedTexts = mock(async (_cfg: unknown, texts: string[]) => {
      embedCalls.push(texts[0])
      // Distinguishable vectors so a cache hit is observable.
      return texts.map(() => new Array(384).fill(embedCalls.length))
    })
    mock.module('@/lib/embeddings', () => ({
      getEmbeddingRuntimeConfig: async () => ({ provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }),
      embedTexts,
      cosineSimilarity: () => 0,
    }))

    const cfgA = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://a/v1', apiKey: 'k', model: 'model-a' } as never
    const cfgB = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://b/v1', apiKey: 'k', model: 'model-b' } as never

    orgCtx = 'org-A'
    const a = await getQuestionEmbedding('berapa total penjualan', cfgA)
    orgCtx = 'org-B'
    const b = await getQuestionEmbedding('berapa total penjualan', cfgB)

    // Different scope must mean a fresh embed, never org A's vector.
    expect(b).not.toEqual(a)
    expect(embedCalls.length).toBe(2)
  })
})
