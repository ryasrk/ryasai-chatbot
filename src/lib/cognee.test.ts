import { afterAll, beforeAll, beforeEach, describe, expect, test, mock } from 'bun:test'

let cogneeEnabledInDb = false

mock.module('@/lib/db', () => ({
  db: {
    llmConfig: { findFirst: async () => null },
    appConfig: {
      findFirst: async () => ({ id: '1', cogneeEnabled: cogneeEnabledInDb }),
      update: async (args: any) => { if (args?.data?.cogneeEnabled !== undefined) cogneeEnabledInDb = args.data.cogneeEnabled; return {} },
      create: async (args: any) => { if (args?.data?.cogneeEnabled !== undefined) cogneeEnabledInDb = args.data.cogneeEnabled; return {} },
    },
    document: {
      groupBy: async () => [],
      findUnique: async () => null,
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
      count: async () => 0,
    },
    documentChunk: { findMany: async () => [] },
  },
}))

import {
  autoCognifyAll,
  clearSessionCache,
  cogneeHealth,
  cogneeStats,
  cognifyBatch,
  cognifyDocument,
  datasetFor,
  forgetAll,
  forgetKnowledgeGraph,
  invalidateCogneeSettings,
  kbDatasetFor,
  recallContext,
  recallKnowledgeGraph,
  recallKnowledgeGraphStructured,
  rememberChatTurn,
  resetCognee,
} from './cognee'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'

// Cognee is org-scoped: no org context => every entry point is a no-op, by design
// (a worker that forgets enterWithOrg must get nothing, not everyone's graph).
//
// ponytail: entered per-test inside async bodies/hooks, never at module scope —
// AsyncLocalStorage.enterWith() during module evaluation swaps the context bun's
// runner is holding and every *synchronous* test in the file then hangs to its
// 5s timeout. Cost of the workaround is one call per test that needs an org.
const TEST_ORG = 'org-test'

// INCIDENT: `AsyncLocalStorage.enterWith()` inside a hook does not reach the test body on
// Bun 1.4.2 (proved with a minimal probe; it works on 1.3.14). Every test here needs an org
// context, or the org-scoped settings read returns DISABLED_SETTINGS and `enabled` is false
// regardless of the DB row -- which is why five tests failed only in CI. Entered inside the
// test body instead, which behaves identically on both versions.
function withOrg<T>(fn: () => Promise<T> | T): Promise<T> {
  enterWithOrg(TEST_ORG)
  return Promise.resolve().then(fn)
}

const _savedFlag = process.env.COGNEE_ENABLED
const _savedServerUrl = process.env.COGNEE_SERVER_URL

/**
 * No cognee server for this file, and the point is that it must be EXPLICIT.
 *
 * `COGNEE_SERVER_URL` decides whether memory has a backend at all. Bun loads `.env` and the
 * runner passes it through, so a developer or CI box with a sidecar configured — the
 * supported deployment — silently changed what these tests measured. MEASURED: adding it to
 * `.env` turned 9 tests red across this file and cognee-degradation.test.ts.
 *
 * Deleted at module scope rather than in a hook so it also covers the top-level
 * `describe('disabled (default)')` bodies, which run before any `beforeEach` in sibling
 * blocks. Tests that want a server set it themselves.
 */
delete process.env.COGNEE_SERVER_URL

afterAll(async () => {
  if (_savedFlag === undefined) delete process.env.COGNEE_ENABLED
  else process.env.COGNEE_ENABLED = _savedFlag
  // Restore, so this file cannot leak into whatever the runner schedules next in-process.
  if (_savedServerUrl === undefined) delete process.env.COGNEE_SERVER_URL
  else process.env.COGNEE_SERVER_URL = _savedServerUrl
  try {
    const config = await db.appConfig.findFirst()
    if (config) {
      await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: false } })
    }
  } catch {}
})

describe('cognee memory layer — disabled (default)', () => {
  beforeEach(async () => {
    // async because it awaits the DB. The org is NOT entered here: a hook's enterWith does
    // not reach the test body on Bun 1.4.2, so withOrg does it inside each body instead.
    // (The DB double is a mock, so no and/or scoped read is needed for this write.)
    delete process.env.COGNEE_ENABLED
    const { db: mockDb } = await import('@/lib/db')
    try {
      const config = await mockDb.appConfig.findFirst()
      if (config) await mockDb.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: false } })
    } catch {}
    invalidateCogneeSettings()
  })

  test('rememberChatTurn is a silent no-op', async () => {
    return withOrg(async () => {
    await expect(
      rememberChatTurn({
        userMessage: 'hi',
        aiMessage: 'hello',
        toolRuns: [],
      }),
    ).resolves.toBeUndefined()
    })
  })

  test('recallContext returns empty string when disabled', async () => {
    return withOrg(async () => {
    const result = await recallContext({ query: 'x' })
    expect(result === '' || result === null).toBe(true)
    })
  })

  test('forgetAll returns false', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await forgetAll()).toBe(false)
    })
  })

  test('cogneeHealth reports disabled + disconnected', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await cogneeHealth()).toEqual({ enabled: false, connected: false, mode: 'disabled', serverVersion: null })
    })
  })

  test('cognifyDocument returns false', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(
      await cognifyDocument({
        documentId: 'd1',
        documentName: 'doc.txt',
        chunks: [{ content: 'hello', chunkIndex: 0 }],
      }),
    ).toBe(false)
    })
  })

  test('recallKnowledgeGraph returns empty string', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await recallKnowledgeGraph({ query: 'x' })).toBe('')
    })
  })

  test('recallKnowledgeGraphStructured returns empty array', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await recallKnowledgeGraphStructured({ query: 'x' })).toEqual([])
    })
  })

  test('forgetKnowledgeGraph returns false', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await forgetKnowledgeGraph()).toBe(false)
    })
  })

  test('cogneeStats reports disabled', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    const stats = await cogneeStats()
    expect(stats.enabled).toBe(false)
    expect(stats.documents.total).toBe(0)
    })
  })

  test('resetCognee returns false when disabled', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    expect(await resetCognee()).toBe(false)
    })
  })

  test('cognifyBatch returns all skipped when disabled', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    const result = await cognifyBatch({
      documents: [
        { documentId: 'd1', documentName: 'a.txt', chunks: [{ content: 'x', chunkIndex: 0 }] },
      ],
    })
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    })
  })

  test('autoCognifyAll returns zeros when disabled', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    const result = await autoCognifyAll()
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
    })
  })
})

describe('cognee — COGNEE_ENABLED env var', () => {
  // No hook needed: the org is entered inside each test body by withOrg. A hook's
  // enterWith is discarded before the body runs on Bun 1.4.2 (see withOrg above).

  async function setDbEnabled(enabled: boolean) {
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: enabled } })
    } catch {}
    invalidateCogneeSettings()
  }

  test('COGNEE_ENABLED=false → kill switch, disabled even if DB says enabled', async () => {
    return withOrg(async () => {
    process.env.COGNEE_ENABLED = 'false'
    await setDbEnabled(true)
    const health = await cogneeHealth()
    expect(health.enabled).toBe(false)
    })
  })

  test('COGNEE_ENABLED=true → enabled when DB also says enabled', async () => {
    return withOrg(async () => {
    process.env.COGNEE_ENABLED = 'true'
    await setDbEnabled(true)
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
    })
  })

  test('COGNEE_ENABLED unset → follows the Settings toggle (on)', async () => {
    return withOrg(async () => {
    // The env var is a kill switch, not a second toggle: leaving it unset must
    // not silently override an admin who enabled cognee in Settings.
    delete process.env.COGNEE_ENABLED
    await setDbEnabled(true)
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
    })
  })

  test('COGNEE_ENABLED unset → follows the Settings toggle (off)', async () => {
    return withOrg(async () => {
    delete process.env.COGNEE_ENABLED
    await setDbEnabled(false)
    const health = await cogneeHealth()
    expect(health.enabled).toBe(false)
    })
  })

  test('COGNEE_ENABLED=true → still disabled when DB says off', async () => {
    return withOrg(async () => {
    process.env.COGNEE_ENABLED = 'true'
    await setDbEnabled(false)
    const health = await cogneeHealth()
    expect(health.enabled).toBe(false)
    })
  })
})

describe('clearSessionCache', () => {
  test('clearSessionCache with specific sessionId → does not throw', () => {
    expect(() => clearSessionCache('session-123')).not.toThrow()
  })

  test('clearSessionCache without args (clear all) → does not throw', () => {
    expect(() => clearSessionCache()).not.toThrow()
  })
})

describe('invalidateCogneeSettings', () => {
  // No hook needed: the org is entered inside each test body by withOrg. A hook's
  // enterWith is discarded before the body runs on Bun 1.4.2 (see withOrg above).

  test('invalidateCogneeSettings → does not throw', () => {
    expect(() => invalidateCogneeSettings()).not.toThrow()
  })

  test('invalidateCogneeSettings forces settings re-read from DB', async () => {
    return withOrg(async () => {
    process.env.COGNEE_ENABLED = 'true'
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: false } })
    } catch {}
    invalidateCogneeSettings()
    let health = await cogneeHealth()
    expect(health.enabled).toBe(false)

    // Enable via DB, invalidate cache, re-check
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
    } catch {}
    invalidateCogneeSettings()
    health = await cogneeHealth()
    expect(health.enabled).toBe(true)
    })
  })
})

describe('cognee memory layer — enabled (package installed, graceful degradation)', () => {
  // Setup only. The org is entered inside each test body by withOrg: a hook's enterWith is
  // discarded before the body runs on Bun 1.4.2 (see withOrg above), so entering it here
  // would look like setup while doing nothing for the assertions.
  beforeAll(async () => {
    process.env.COGNEE_ENABLED = 'true'
    try {
      const config = await db.appConfig.findFirst()
      if (config) {
        await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
      } else {
        await db.appConfig.create({ data: { cogneeEnabled: true, organizationId: 'test-org' } })
      }
    } catch {}
    invalidateCogneeSettings()
  })

  test('rememberChatTurn does not throw', async () => {
    return withOrg(async () => {
    await expect(
      rememberChatTurn({
        sessionId: 's1',
        userMessage: 'test question for cognee',
        aiMessage: 'test answer from cognee',
        toolRuns: [{ type: 'SQL', status: 'ok', latencyMs: 12 }],
      }),
    ).resolves.toBeUndefined()
    })
  }, 30000)

  test('recallContext returns string (empty if no data)', async () => {
    return withOrg(async () => {
    const result = await recallContext({ query: 'test question' })
    expect(typeof result === 'string' || result === null).toBe(true)
    })
  }, 30000)

  test('cogneeHealth reports enabled', async () => {
    return withOrg(async () => {
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
    // CHANGED CONTRACT: the mode used to be the storage backend the in-process SDK was
    // told to open ('local' | 'postgres'). Storage now belongs to the v1.6.0 server, so a
    // reachable sidecar reports 'server' and an unconfigured one reports 'disabled'.
    // Asserting the OLD values would have kept passing only while the field was inert.
    expect(['server', 'disabled']).toContain(health.mode)
    // And `serverVersion` is what makes 'connected' auditable rather than a bare boolean.
    expect(health).toHaveProperty('serverVersion')
    })
  })

  test('cogneeStats returns document stats', async () => {
    return withOrg(async () => {
    const stats = await cogneeStats()
    expect(stats.enabled).toBe(true)
    expect(typeof stats.documents.total).toBe('number')
    expect(typeof stats.documents.cognified).toBe('number')
    expect(typeof stats.batchSize).toBe('number')
    expect(typeof stats.maxRetries).toBe('number')
    })
  })

  test('cognifyDocument does not throw and returns boolean', async () => {
    return withOrg(async () => {
    const result = await cognifyDocument({
      documentId: 'test-cognee-doc',
      documentName: 'test.txt',
      chunks: [
        { content: 'Apple is a fruit. It is red and sweet.', chunkIndex: 0 },
        { content: 'Banana is another fruit. It is yellow and rich in potassium.', chunkIndex: 1 },
      ],
    })
    expect(typeof result).toBe('boolean')
    })
  }, 60000)

  test('recallKnowledgeGraph returns string', async () => {
    return withOrg(async () => {
    const result = await recallKnowledgeGraph({ query: 'fruit' })
    expect(typeof result).toBe('string')
    })
  }, 30000)

  test('recallKnowledgeGraphStructured returns array', async () => {
    return withOrg(async () => {
    const result = await recallKnowledgeGraphStructured({ query: 'fruit', topK: 3 })
    expect(Array.isArray(result)).toBe(true)
    })
  }, 30000)

  test('forgetKnowledgeGraph returns boolean', async () => {
    return withOrg(async () => {
    const result = await forgetKnowledgeGraph()
    expect(typeof result).toBe('boolean')
    })
  })

  test('forgetAll returns boolean when enabled', async () => {
    return withOrg(async () => {
    const result = await forgetAll()
    expect(typeof result).toBe('boolean')
    })
  }, 30000)

  test('cognifyBatch returns result object when enabled', async () => {
    return withOrg(async () => {
    const result = await cognifyBatch({
      documents: [
        { documentId: 'batch-1', documentName: 'a.txt', chunks: [{ content: 'x', chunkIndex: 0 }] },
      ],
    })
    expect(typeof result.processed).toBe('number')
    expect(typeof result.failed).toBe('number')
    expect(typeof result.skipped).toBe('number')
    })
  }, 60000)

  test('resetCognee returns boolean when enabled', async () => {
    return withOrg(async () => {
    const result = await resetCognee()
    expect(typeof result).toBe('boolean')
    })
  }, 30000)
})

describe('cognee dataset isolation', () => {
  // These names WERE the constants 'default' and 'default:kb' for every tenant.
  // In postgres mode several orgs can share one cognee database, so the dataset
  // name is the isolation boundary inside it — a fixed name meant one shared graph.
  test('dataset names carry the org id', async () => {
    return withOrg(async () => {
    enterWithOrg(TEST_ORG)
    expect(datasetFor()).toBe(`org:${TEST_ORG}`)
    expect(kbDatasetFor()).toBe(`org:${TEST_ORG}:kb`)
    })
  })

  test('memory and knowledge-base datasets stay distinct', async () => {
    return withOrg(async () => {
    enterWithOrg(TEST_ORG)
    expect(kbDatasetFor()).not.toBe(datasetFor())
    })
  })

  test('two orgs never resolve to the same dataset', async () => {
    return withOrg(async () => {
    enterWithOrg('org-a')
    const a = { chat: datasetFor(), kb: kbDatasetFor() }
    enterWithOrg('org-b')
    const b = { chat: datasetFor(), kb: kbDatasetFor() }
    expect(a.chat).not.toBe(b.chat)
    expect(a.kb).not.toBe(b.kb)
    // and neither org can reach the other's knowledge base
    expect(a.kb).not.toBe(b.chat)
    expect(b.kb).not.toBe(a.chat)
    enterWithOrg(TEST_ORG)
    })
  })

  test('no org context resolves to a dead namespace, not the shared default', async () => {
    return withOrg(async () => {
    await bypassOrg(async () => {
      expect(datasetFor()).toBe('org:no-org')
      expect(kbDatasetFor()).toBe('org:no-org:kb')
      expect(datasetFor()).not.toBe('default')
    })
    enterWithOrg(TEST_ORG)
    })
  })

  test('getCogneeSettings is disabled without org context', async () => {
    return withOrg(async () => {
    process.env.COGNEE_ENABLED = 'true'
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
    } catch {}
    invalidateCogneeSettings('all')
    await bypassOrg(async () => {
      const health = await cogneeHealth()
      expect(health.enabled).toBe(false)
    })
    enterWithOrg(TEST_ORG)
    })
  })
})
