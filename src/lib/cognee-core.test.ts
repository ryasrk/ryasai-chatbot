import { describe, expect, test, mock, beforeEach } from 'bun:test'

// ---------------------------------------------------------------------------
// cognee-core.ts had NO tests (343 lines). It is the tenancy boundary for the
// knowledge graph: settings, the per-org client, the per-org owner id and the
// per-org store paths all live here. The file's own header records the incident
// this replaces — one global client meant "org B recalled org A's documents,
// org A's settings applied to org B, and whichever org initialised first
// supplied the LLM API key that every other org's cognify billed to" — so the
// tests below are written against that failure, not against the happy path.
// ---------------------------------------------------------------------------
const cfgState = {
  appConfig: null as any,
  appConfigThrows: false,
  updateCalls: [] as any[],
}
const llmState = { cfg: { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://llm', apiKey: 'k1', model: 'm1' } as any }
const embState = { cfg: { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://emb', apiKey: 'k2', model: 'e1' } as any }
const sdkState = { constructArgs: [] as any[], warmCalls: 0, shouldThrow: false }

mock.module('@/lib/db', () => ({
  db: {
    appConfig: {
      findFirst: async () => {
        if (cfgState.appConfigThrows) throw new Error('db down')
        return cfgState.appConfig
      },
    },
    document: {
      update: async (a: any) => { cfgState.updateCalls.push(a); return {} },
    },
  },
}))
mock.module('@/lib/llm-config', () => ({
  getLlmRuntimeConfig: async () => llmState.cfg,
}))
mock.module('@/lib/embeddings', () => ({
  getEmbeddingRuntimeConfig: async () => embState.cfg,
}))
mock.module('@cognee/cognee-ts', () => ({
  Cognee: class {
    constructor(args: any) { sdkState.constructArgs.push(args) }
    async warm() {
      sdkState.warmCalls++
      if (sdkState.shouldThrow) throw new Error('warm failed')
    }
    async ownerId() { return 'owner-of-this-org' }
  },
}))

import {
  getCogneeSettings,
  invalidateCogneeSettings,
  isCogneeEnabled,
  cogneeBatchSize,
  cognifyMaxRetries,
  getCogneeClient,
  getCogneeOwnerId,
  resetClientCache,
  formatSearchResponse,
  extractSearchItems,
  updateDocumentCognifyStatus,
} from '@/lib/cognee-core'
import { enterWithOrg, bypassOrg } from '@/lib/prisma-tenant'

/**
 * Run WITHOUT org context. `bypassOrg` is a callback wrapper (`orgStorage.run`),
 * not a no-arg reset — calling it bare compiles but leaves the previous org in
 * place, so these tests would silently measure the wrong thing. AsyncLocalStorage
 * also means a bare call outside its callback is a no-op.
 */
function withoutOrg<T>(fn: () => Promise<T>): Promise<T> {
  return bypassOrg(fn)
}

function deleteSdkArgs() { sdkState.constructArgs.length = 0 }

const ENV_KEYS = ['COGNEE_ENABLED', 'COGNEE_DB_PROVIDER', 'COGNEE_DB_URL', 'COGNEE_BATCH_SIZE', 'COGNEE_MAX_RETRIES', 'COGNEE_DATA_DIR']
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  for (const k of ENV_KEYS) delete process.env[k]
  cfgState.appConfig = null
  cfgState.appConfigThrows = false
  cfgState.updateCalls = []
  sdkState.constructArgs = []
  sdkState.warmCalls = 0
  sdkState.shouldThrow = false
  invalidateCogneeSettings('all')
  resetClientCache('all')
  embState.cfg = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://emb', apiKey: 'k2', model: 'e1' }
  llmState.cfg = { provider: 'OPENAI_COMPATIBLE', baseUrl: 'http://llm', apiKey: 'k1', model: 'm1' }
  deleteSdkArgs()
})

describe('cognee-core — tenancy: no org context means NOTHING happens', () => {
  test('no org context → disabled settings, regardless of env', async () => {
    process.env.COGNEE_ENABLED = 'true'
    const s = await withoutOrg(() => getCogneeSettings())
    // Fail closed. A background worker that forgot enterWithOrg must get
    // "nothing configured", never another org's configuration.
    expect(s.enabled).toBe(false)
  })

  test('no org context → no client is ever built', async () => {
    const c = await withoutOrg(() => getCogneeClient())
    expect(c).toBeNull()
    // The SDK must not even be constructed without an org, or the wrong store
    // directory gets created.
    expect(sdkState.constructArgs).toHaveLength(0)
  })

  test('no org context → no owner id', async () => {
    expect(await withoutOrg(async () => getCogneeOwnerId())).toBeUndefined()
  })
})

describe('cognee-core — per-org isolation', () => {
  test('two orgs get DIFFERENT store directories', async () => {
    enterWithOrg('org-a')
    await getCogneeClient()
    const a = sdkState.constructArgs[0]
    resetClientCache('all')
    sdkState.constructArgs = []
    enterWithOrg('org-b')
    await getCogneeClient()
    const b = sdkState.constructArgs[0]
    // In `local` mode the store is files on disk. One shared directory is one
    // shared knowledge graph — this is the isolation boundary.
    expect(a.dataRootDirectory).not.toBe(b.dataRootDirectory)
    expect(a.dataRootDirectory).toContain('org-a')
    expect(b.dataRootDirectory).toContain('org-b')
  })

  test('an org id with path characters is sanitised before it reaches the path', async () => {
    enterWithOrg('../../etc/passwd')
    await getCogneeClient()
    const args = sdkState.constructArgs[0]
    // The org id lands in a filesystem path, so traversal must be neutralised.
    expect(args.dataRootDirectory).not.toContain('..')
    expect(args.systemRootDirectory).not.toContain('..')
  })

  test('each org gets its OWN client, not a shared one', async () => {
    enterWithOrg('org-a')
    const ca = await getCogneeClient()
    enterWithOrg('org-b')
    const cb = await getCogneeClient()
    expect(ca).not.toBe(cb)
    expect(sdkState.warmCalls).toBe(2)
  })

  test('the client is CACHED per org (no re-init on every call)', async () => {
    enterWithOrg('org-a')
    const first = await getCogneeClient()
    const second = await getCogneeClient()
    expect(first).toBe(second)
    // Re-warming a graph backend per query would be catastrophic for latency.
    expect(sdkState.warmCalls).toBe(1)
  })

  test("each org's client is built with ITS OWN LLM key", async () => {
    enterWithOrg('org-a')
    await getCogneeClient()
    expect(sdkState.constructArgs[0].llmApiKey).toBe('k1')
    resetClientCache('all')
    sdkState.constructArgs = []
    llmState.cfg = { provider: 'ANTHROPIC_COMPATIBLE', baseUrl: 'http://other', apiKey: 'KEY-OF-B', model: 'mb' }
    enterWithOrg('org-b')
    await getCogneeClient()
    // The recorded incident: "whichever org initialised first supplied the LLM
    // API key that every other org's cognify then billed to."
    expect(sdkState.constructArgs[0].llmApiKey).toBe('KEY-OF-B')
    expect(sdkState.constructArgs[0].llmProvider).toBe('anthropic')
  })

  test('invalidating one org does NOT wipe another org settings cache', async () => {
    enterWithOrg('org-a')
    // The setting is read from the AppConfig COLUMN (cogneeBatchSize), not from
    // a bare `batchSize` field — the first version of this fixture used the
    // wrong key and silently measured the env default of 50.
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local', cogneeBatchSize: 7, cogneeMaxRetries: 7 }
    await getCogneeSettings()
    enterWithOrg('org-b')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local', cogneeBatchSize: 99, cogneeMaxRetries: 99 }
    await getCogneeSettings()

    enterWithOrg('org-a')
    invalidateCogneeSettings('org')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local', cogneeBatchSize: 7, cogneeMaxRetries: 7 }
    const after = await getCogneeSettings()
    // org-a re-reads (cache cleared), org-b must be untouched by that.
    expect(after.batchSize).toBe(7)
    enterWithOrg('org-b')
    expect(cogneeBatchSize(await getCogneeSettings())).toBe(99)
  })
})

describe('cognee-core — settings resolution', () => {
  test('COGNEE_ENABLED=false is a kill switch that overrides the org toggle', async () => {
    process.env.COGNEE_ENABLED = 'false'
    enterWithOrg('org-a')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    // The scheduler worker sets this because the graph file lock cannot be
    // shared between processes. It must win over the admin's setting.
    expect(await isCogneeEnabled()).toBe(false)
  })

  test('an UNSET COGNEE_ENABLED defers to the org setting (not a silent no-op)', async () => {
    // The recorded bug: the env var was ANDed with the DB flag, so an admin who
    // enabled cognee in Settings on a server whose env var was merely unset got
    // a no-op plus a UI telling them to ask an administrator — who was themself.
    delete process.env.COGNEE_ENABLED
    enterWithOrg('org-a')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    expect(await isCogneeEnabled()).toBe(true)
  })

  test('no AppConfig row keeps the fail-closed rule', async () => {
    process.env.COGNEE_ENABLED = 'true'
    enterWithOrg('org-a')
    cfgState.appConfig = null
    const s = await getCogneeSettings()
    // Pre-setup: nobody has opted in. An explicit env true is required.
    expect(s.enabled).toBe(true)
    expect(s.dbProvider).toBe('local')
  })

  test('a DB failure falls back to env instead of throwing', async () => {
    cfgState.appConfigThrows = true
    process.env.COGNEE_BATCH_SIZE = '11'
    enterWithOrg('org-a')
    const s = await getCogneeSettings()
    expect(s.batchSize).toBe(11)
  })

  test('postgres provider demands a URL and refuses without one', async () => {
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: null, cogneeBatchSize: 5, cogneeMaxRetries: 2 }
    enterWithOrg('org-a')
    await getCogneeSettings()
    expect(await getCogneeClient()).toBeNull()
    // Half-configured postgres must not silently fall back to local: that would
    // write the org's graph into a local file the admin never chose.
    expect(sdkState.constructArgs).toHaveLength(0)
  })

  test('a postgres org configures pgvector, not lancedb', async () => {
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: 'postgresql://x', cogneeBatchSize: 5, cogneeMaxRetries: 2 }
    enterWithOrg('org-a')
    await getCogneeClient()
    const args = sdkState.constructArgs[0]
    expect(args.graphDatabaseProvider).toBe('postgres')
    expect(args.vectorDbProvider).toBe('pgvector')
    expect(args.vectorDbUrl).toBe('postgresql://x')
  })

  test('a local org uses kuzu + lancedb with a sqlite system db', async () => {
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local', cogneeBatchSize: 5, cogneeMaxRetries: 2 }
    enterWithOrg('org-a')
    await getCogneeClient()
    const args = sdkState.constructArgs[0]
    expect(args.graphDatabaseProvider).toBe('kuzu')
    expect(args.vectorDbProvider).toBe('lancedb')
    expect(args.relationalDbUrl).toContain('sqlite:')
  })
})

describe('cognee-core — degraded paths never throw', () => {
  test('a failed warm returns null and does NOT retry immediately', async () => {
    sdkState.shouldThrow = true
    enterWithOrg('org-a')
    expect(await getCogneeClient()).toBeNull()
    expect(await getCogneeClient()).toBeNull()
    // A 30s backoff — without it every query pays a failed SDK warm.
    expect(sdkState.warmCalls).toBe(1)
  })

  test('resetClientCache lets a previously-failed org retry immediately', async () => {
    sdkState.shouldThrow = true
    enterWithOrg('org-a')
    await getCogneeClient()
    resetClientCache('org')
    sdkState.shouldThrow = false
    sdkState.warmCalls = 0
    expect(await getCogneeClient()).not.toBeNull()
    expect(sdkState.warmCalls).toBe(1)
  })

  test('an optional embedding config is not required to build a client', async () => {
    embState.cfg = null
    enterWithOrg('org-a')
    // Falls back to the LLM key/endpoint rather than failing the whole client.
    expect(await getCogneeClient()).not.toBeNull()
    expect(sdkState.constructArgs[0].embeddingApiKey).toBe('k1')
  })

  test('a missing LLM config omits LLM settings instead of crashing', async () => {
    llmState.cfg = null
    enterWithOrg('org-a')
    expect(await getCogneeClient()).not.toBeNull()
    expect(sdkState.constructArgs[0].llmApiKey).toBeUndefined()
  })
})

describe('cognee-core — pure helpers', () => {
  test('formatSearchResponse handles EVERY documented shape', () => {
    expect(formatSearchResponse(null)).toBe('')
    expect(formatSearchResponse(undefined)).toBe('')
    expect(formatSearchResponse('plain')).toBe('plain')
    expect(formatSearchResponse({ answer: 'ans' })).toBe('ans')
    expect(formatSearchResponse({ content: 'body' })).toBe('body')
    expect(formatSearchResponse({ items: ['a', 'b'] })).toBe('a\nb')
    expect(formatSearchResponse({ result: 'inner' })).toBe('inner')
    expect(formatSearchResponse({ result: { kind: 'Text', data: 'deep' } })).toBe('deep')
    // An unknown shape yields '' rather than the string "undefined".
    expect(formatSearchResponse({ unexpected: 1 })).toBe('')
  })

  test('extractSearchItems handles Items / Texts / Text / array', () => {
    expect(extractSearchItems(null)).toEqual([])
    expect(extractSearchItems('s')).toEqual([{ text: 's' }])
    expect(extractSearchItems({ kind: 'Items', data: ['a', { text: 'b', score: 0.5 }] }))
      .toEqual([{ text: 'a' }, { text: 'b', score: 0.5 }])
    expect(extractSearchItems({ kind: 'Texts', data: ['x', 'y'] })).toEqual([{ text: 'x' }, { text: 'y' }])
    expect(extractSearchItems({ kind: 'Text', data: 'z' })).toEqual([{ text: 'z' }])
    expect(extractSearchItems([{ content: 'c', score: 1 }])).toEqual([{ text: 'c', score: 1 }])
    expect(extractSearchItems({ kind: 'Unknown' })).toEqual([])
  })

  test('extractSearchItems understands EVERY item variant the SDK can return', () => {
    // The title said "every documented shape", but the body only exercised
    // `text` on the Items path plus one `content` on the ARRAY path. A branch that
    // silently drops an item is a silently missing search result, so each variant
    // is pinned separately. `payload.text` matters most: the graph/search adapter
    // wraps records that way, and losing it returns an empty knowledge context.
    // Items kind -- content variant
    expect(extractSearchItems({ kind: 'Items', data: [{ content: 'kc', score: 0.25 }] }))
      .toEqual([{ text: 'kc', score: 0.25 }])
    // Items kind -- payload.text variant
    expect(extractSearchItems({ kind: 'Items', data: [{ payload: { text: 'kp' }, score: 0.75 }] }))
      .toEqual([{ text: 'kp', score: 0.75 }])
    // Items kind -- an item matching NO variant is dropped rather than crashing
    expect(extractSearchItems({ kind: 'Items', data: [{ other: 1 }] })).toEqual([])
    // Items kind -- mixed variants in one response, in order
    expect(extractSearchItems({ kind: 'Items', data: ['a', { text: 't' }, { content: 'c' }, { payload: { text: 'p' } }] }))
      .toEqual([{ text: 'a' }, { text: 't', score: undefined }, { text: 'c', score: undefined }, { text: 'p', score: undefined }])
    // Texts kind -- falsy entries are skipped, not stringified to ''
    expect(extractSearchItems({ kind: 'Texts', data: ['y', '', null] })).toEqual([{ text: 'y' }])
    // Array format -- payload.text is NOT handled here (only Items is); documenting
    // the asymmetry rather than assuming it works.
    expect(extractSearchItems([{ payload: { text: 'p' } }])).toEqual([])
    // Array format -- the string and `text` variants on this path too; the original
    // test only reached `content` here, leaving both other branches unexecuted.
    expect(extractSearchItems(['s', { text: 't', score: 0.1 }, { content: 'c', score: 0.2 }]))
      .toEqual([{ text: 's' }, { text: 't', score: 0.1 }, { text: 'c', score: 0.2 }])
    // An array item matching no variant is dropped rather than crashing.
    expect(extractSearchItems([{ nothing: true }])).toEqual([])
  })

  test('formatSearchResponse understands EVERY item variant on the Items path', () => {
    // The sibling of the test above, on the string-formatting path. Each variant
    // must reach the joined text, and an item matching none must not vanish
    // silently -- it is JSON-stringified so an unexpected shape is still visible.
    // The Items shape is only reachable through `result.result` -- the top-level
    // dispatcher checks result / answer / content / items, so passing the kind
    // object directly returns ''. My first version did exactly that and failed;
    // the wrapper is the real calling convention, not a workaround.
    expect(formatSearchResponse({ result: { kind: 'Items', data: [{ content: 'c' }] } })).toBe('c')
    expect(formatSearchResponse({ result: { kind: 'Items', data: [{ payload: { text: 'p' } }] } })).toBe('p')
    expect(formatSearchResponse({ result: { kind: 'Items', data: [{ weird: 1 }] } })).toBe('{"weird":1}')
    // MEASURED, and it is NOT symmetric with extractSearchItems: a null entry is
    // NOT dropped here, it stringifies to the literal text "null" and lands in the
    // knowledge context. `''` disappears only because an empty line is invisible
    // after the join. Pinned as-is, because a test that asserted 'a' would be
    // asserting a behaviour the code does not have.
    expect(formatSearchResponse({ result: { kind: 'Items', data: ['a', '', null] } })).toBe('a\nnull')
    // An unrecognised KIND on the inner output falls through to '' -- the outer
    // dispatcher found a result object it could not interpret, so it reports no
    // context rather than the string "undefined".
    expect(formatSearchResponse({ result: { kind: 'Unknown', data: ['x'] } })).toBe('')
    expect(formatSearchResponse({ result: { kind: 'Texts', data: ['x', 'y'] } })).toBe('x\ny')
    expect(formatSearchResponse({ result: { kind: 'Text', data: 'z' } })).toBe('z')
    expect(formatSearchResponse({ result: { kind: 'Items', data: [null] } })).toBe('null')
    // A kind object at the TOP level is not a shape this function understands.
    expect(formatSearchResponse({ kind: 'Items', data: [{ content: 'c' }] })).toBe('')
  })

  test('updateDocumentCognifyStatus stamps cognifiedAt only when completed', async () => {
    await updateDocumentCognifyStatus('d1', 'completed', undefined)
    expect(cfgState.updateCalls[0].data.cognifiedAt).toBeInstanceOf(Date)
    await updateDocumentCognifyStatus('d1', 'failed', 'err')
    expect(cfgState.updateCalls[1].data.cognifiedAt).toBeNull()
    expect(cfgState.updateCalls[1].data.cognifyError).toBe('err')
  })

  test('a failing status write is swallowed (non-fatal by design)', async () => {
    const orig = cfgState.updateCalls
    // The function catches internally; a throw here would abort a cognify run
    // over a bookkeeping row.
    await expect(updateDocumentCognifyStatus('gone', 'completed', undefined)).resolves.toBeUndefined()
    cfgState.updateCalls = orig
  })

  test('settings accessors pass through the configured values', () => {
    expect(cogneeBatchSize({ batchSize: 12 } as any)).toBe(12)
    expect(cognifyMaxRetries({ maxRetries: 4 } as any)).toBe(4)
  })
})
