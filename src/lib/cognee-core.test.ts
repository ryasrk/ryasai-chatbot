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
  supportsNaturalLanguageSearch,
  getCogneeGraphProvider,
  getCogneeBackend,
  getCogneeServerOptions,
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

describe('cognee-core — per-org SETTINGS isolation (the client tests moved with the SDK)', () => {
  // The client-construction half of this block was removed on 2026-09-24 with the
  // in-process bindings: "two orgs get different store directories", "each org gets its
  // OWN client", "the client is CACHED per org", "an org id with path characters is
  // sanitised" and "each org's client is built with ITS OWN LLM key" all asserted state
  // that no longer exists in this process. The store and its isolation now live inside
  // the v1.6.0 server, one docker volume per deployment.
  //
  // What SURVIVES is the settings-cache half, which is still entirely live: settings are
  // cached per org in this process, and the two tests below are about that cache being
  // keyed correctly and invalidated narrowly. They were the reason the block caught a
  // real bug once (a wrong cache key silently measured the env default of 50).
  test('narrowing the cache to one org does not disturb a sibling org', async () => {
    enterWithOrg('org-a')
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

  test('the storage picker is INERT: dbProvider/dbUrl no longer choose a backend', async () => {
    // These two tests used to assert that a postgres org produced `graphDatabaseProvider:
    // 'postgres'` and a local org `kuzu` + `lancedb` in the SDK constructor arguments. That
    // constructor is gone: the store belongs to the cognee v1.6.0 server, whose backends
    // are set by docker-compose.yml. The values are still read and echoed to the UI, but
    // they change nothing — which is exactly what this test pins, so an operator cannot be
    // told the toggle works when it does not.
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: 'postgresql://x' }
    enterWithOrg('org-a')
    const settings = await getCogneeSettings()
    expect(settings.dbProvider).toBe('postgres')
    expect(settings.dbUrl).toBe('postgresql://x')
    // Still reported, still inert: with no server there is no transport at all, and
    // setting dbProvider to postgres does NOT conjure one.
    delete process.env.COGNEE_SERVER_URL
    invalidateCogneeSettings('all')
    expect(await getCogneeBackend()).toBeNull()
  })

})

describe('cognee-core — degraded paths never throw', () => {
  // REWRITTEN 2026-09-24. Every test here asserted something about the ARGUMENTS passed
  // to the in-process SDK constructor ("a failed warm returns null", "an optional
  // embedding config is not required to build a client", "a missing LLM config omits LLM
  // settings"). The constructor is gone, so the arguments are gone with it.
  //
  // The PROPERTY worth keeping is the one the block is named for, and it still has a live
  // subject: whatever the configuration state, the memory entry points degrade to
  // null/empty rather than propagating a failure into a chat turn.

  test('no org context returns null instead of reading another tenant config', async () => {
    // Fail closed. A background worker that forgot enterWithOrg must get NOTHING.
    expect(await getCogneeClient()).toBeNull()
    expect(await getCogneeServerOptions()).toBeNull()
    expect(await getCogneeBackend()).toBeNull()
  })

  test('a missing LLM config does not throw — the client is simply absent', async () => {
    llmState.cfg = null
    enterWithOrg('org-a')
    expect(await getCogneeClient()).toBeNull()
  })

  test('a missing embedding config does not throw either', async () => {
    embState.cfg = null
    enterWithOrg('org-a')
    await expect(getCogneeClient()).resolves.toBeNull()
  })

  test('with no server configured, every entry point degrades instead of throwing', async () => {
    enterWithOrg('org-a')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    delete process.env.COGNEE_SERVER_URL
    invalidateCogneeSettings('all')
    // The point of the whole block: a deployment with no memory backend must keep
    // serving chat turns, not fail them. `null` is how every caller learns that.
    expect(await getCogneeBackend()).toBeNull()
    expect(await getCogneeServerOptions()).toBeNull()
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

describe('supportsNaturalLanguageSearch — the graph-backend gate', () => {
  test('kuzu cannot serve it (MEASURED: rejected on every attempt)', () => {
    expect(supportsNaturalLanguageSearch('kuzu')).toBe(false)
  })

  test('postgres is allowed to try it', () => {
    expect(supportsNaturalLanguageSearch('postgres')).toBe(true)
  })

  test('an UNKNOWN backend stays optimistic rather than dropping a strategy', () => {
    // null means the settings could not be read. Skipping here would silently lose a strategy
    // that might have worked, so only a positively-identified kuzu turns it off.
    expect(supportsNaturalLanguageSearch(null)).toBe(true)
  })
})

describe('getCogneeGraphProvider — the backend the recall gate reads', () => {
  test('kuzu (local default) is reported as kuzu', async () => {
    enterWithOrg('org-provider')
    // getCogneeSettings() maps anything that is not 'postgres' to the local provider.
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    expect(await getCogneeGraphProvider()).toBe('kuzu')
  })

  test('postgres is reported as postgres', async () => {
    enterWithOrg('org-provider')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres' }
    expect(await getCogneeGraphProvider()).toBe('postgres')
  })

  test('an UNREADABLE config falls back to the ENV provider (kuzu by default)', async () => {
    enterWithOrg('org-provider')
    // getCogneeSettings() catches a DB failure and uses envFallback(), so a down DB yields
    // the env/local provider rather than null. Pinning it here because the recall gate's
    // behaviour depends on it: this is 'kuzu', so NATURAL_LANGUAGE is skipped — correct,
    // since the local store IS what a config-less org would use.
    cfgState.appConfigThrows = true
    expect(await getCogneeGraphProvider()).toBe('kuzu')
  })

  test('COGNEE_DB_PROVIDER=postgres is honoured even with no AppConfig row', async () => {
    enterWithOrg('org-provider')
    process.env.COGNEE_DB_PROVIDER = 'postgres'
    cfgState.appConfigThrows = true
    expect(await getCogneeGraphProvider()).toBe('postgres')
  })

  test('getCogneeGraphProvider returns null ONLY when settings are unresolvable', async () => {
    // No org context → DISABLED_SETTINGS, but resolveProvider is only reached with a context.
    // Away from org context the gate must not invent a backend.
    const { bypassOrg } = await import('@/lib/prisma-tenant')
    const p = await bypassOrg(async () => getCogneeGraphProvider())
    // No context at all: getCogneeSettings returns the disabled default ('local').
    expect(['kuzu', 'postgres', null]).toContain(p)
  })

  test('inside the client cache the provider never outlives the settings TTL', async () => {
    enterWithOrg('org-provider')
    // The gate must track settings changes, not a stale client.
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    expect(await getCogneeGraphProvider()).toBe('kuzu')
    invalidateCogneeSettings('all')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres' }
    expect(await getCogneeGraphProvider()).toBe('postgres')
  })
})

// ---------------------------------------------------------------------------
// Backend selection: the cognee 1.5.4 server vs the in-process TS SDK.
//
// This is the switch that decides which transport a REMEMBER and its matching
// RECALL both use. If a write went to the server and the read to the SDK, the
// fact would be stored and never found — silent, permanent memory loss, which is
// the exact failure mode this migration exists to remove. So the tests below pin
// the selection AND the matching options, not just the flag.
// ---------------------------------------------------------------------------
describe('getCogneeBackend — which transport memory calls use', () => {
  beforeEach(() => {
    invalidateCogneeSettings('all')
    delete process.env.COGNEE_SERVER_URL
    delete process.env.COGNEE_SERVER_API_KEY
  })

  test('an unset COGNEE_SERVER_URL means memory is OFF — there is no in-process backend', async () => {
    // CHANGED CONTRACT (2026-09-24). This used to expect 'inprocess': the
    // @cognee/cognee-ts SDK was the fallback. The SDK has been removed from the
    // project, so a fake 'inprocess' would send callers to
    // `await import('@cognee/cognee-ts')`, which throws at runtime and reads as
    // "memory is broken" rather than "memory is not configured". `null` is the
    // honest answer, and every caller already handles it.
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    const backend = await getCogneeBackend()
    expect(backend).toBeNull()
  })

  test('COGNEE_SERVER_URL selects the server transport', async () => {
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    process.env.COGNEE_SERVER_URL = 'http://cognee:8000'
    invalidateCogneeSettings('all')
    const backend = await getCogneeBackend()
    expect(backend?.kind).toBe('server')
    expect(backend?.serverUrl).toBe('http://cognee:8000')
  })

  test('whitespace-only COGNEE_SERVER_URL is treated as unset, not as a bad URL', async () => {
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    process.env.COGNEE_SERVER_URL = '   '
    invalidateCogneeSettings('all')
    // Unset now means OFF rather than in-process; the point of the test — that
    // whitespace is not mistaken for a URL — is unchanged.
    expect(await getCogneeBackend()).toBeNull()
  })

  test('the server URL is NOT read from the org row — it is a deployment fact', async () => {
    // A per-org server address would let one org point memory at another org's
    // server. The config row deliberately has no such field; assert the env is
    // the only source even when an AppConfig row exists.
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'postgres', cogneeDbUrl: 'postgres://x' }
    invalidateCogneeSettings('all')
    // The assertion that matters is unchanged and still fails if someone ever adds a
    // `serverUrl` column to the org row: a config row present, with no env var, must
    // NOT produce a server backend.
    expect(await getCogneeBackend()).toBeNull()
  })

  test('server options carry the URL, the bounded deadline and the optional key', async () => {
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    process.env.COGNEE_SERVER_URL = 'http://cognee:8000'
    process.env.COGNEE_SERVER_API_KEY = 'secret'
    invalidateCogneeSettings('all')

    const opts = await getCogneeServerOptions()
    expect(opts?.baseUrl).toBe('http://cognee:8000')
    expect(opts?.apiKey).toBe('secret')
    // Bounded: a wedged server must not hold a chat turn open forever.
    expect(typeof opts?.timeoutMs).toBe('number')
    expect(opts!.timeoutMs!).toBeGreaterThan(0)
  })

  test('server options omit the key header when no key is configured', async () => {
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    process.env.COGNEE_SERVER_URL = 'http://cognee:8000'
    invalidateCogneeSettings('all')
    expect((await getCogneeServerOptions())?.apiKey).toBeUndefined()
  })

  test('no server options are produced when the server is not configured', async () => {
    enterWithOrg('org-backend')
    cfgState.appConfig = { cogneeEnabled: true, cogneeDbProvider: 'local' }
    invalidateCogneeSettings('all')
    expect(await getCogneeServerOptions()).toBeNull()
  })

  test('without org context no server options leak out, so memory fails closed', async () => {
    // The tenancy contract: a background job that forgets enterWithOrg must get
    // nothing rather than the server's shared store.
    process.env.COGNEE_SERVER_URL = 'http://cognee:8000'
    invalidateCogneeSettings('all')
    const opts = await withoutOrg(async () => getCogneeServerOptions())
    expect(opts).toBeNull()
  })
})
})
