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

const _savedFlag = process.env.COGNEE_ENABLED
afterAll(async () => {
  if (_savedFlag === undefined) delete process.env.COGNEE_ENABLED
  else process.env.COGNEE_ENABLED = _savedFlag
  try {
    const config = await db.appConfig.findFirst()
    if (config) {
      await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: false } })
    }
  } catch {}
})

describe('cognee memory layer — disabled (default)', () => {
  beforeEach(async () => {
    delete process.env.COGNEE_ENABLED
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: false } })
    } catch {}
    invalidateCogneeSettings()
  })

  test('rememberChatTurn is a silent no-op', async () => {
    await expect(
      rememberChatTurn({
        userMessage: 'hi',
        aiMessage: 'hello',
        toolRuns: [],
      }),
    ).resolves.toBeUndefined()
  })

  test('recallContext returns empty string when disabled', async () => {
    const result = await recallContext({ query: 'x' })
    expect(result === '' || result === null).toBe(true)
  })

  test('forgetAll returns false', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await forgetAll()).toBe(false)
  })

  test('cogneeHealth reports disabled + disconnected', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await cogneeHealth()).toEqual({ enabled: false, connected: false, mode: 'disabled' })
  })

  test('cognifyDocument returns false', async () => {
    delete process.env.COGNEE_ENABLED
    expect(
      await cognifyDocument({
        documentId: 'd1',
        documentName: 'doc.txt',
        chunks: [{ content: 'hello', chunkIndex: 0 }],
      }),
    ).toBe(false)
  })

  test('recallKnowledgeGraph returns empty string', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await recallKnowledgeGraph({ query: 'x' })).toBe('')
  })

  test('recallKnowledgeGraphStructured returns empty array', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await recallKnowledgeGraphStructured({ query: 'x' })).toEqual([])
  })

  test('forgetKnowledgeGraph returns false', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await forgetKnowledgeGraph()).toBe(false)
  })

  test('cogneeStats reports disabled', async () => {
    delete process.env.COGNEE_ENABLED
    const stats = await cogneeStats()
    expect(stats.enabled).toBe(false)
    expect(stats.documents.total).toBe(0)
  })

  test('resetCognee returns false when disabled', async () => {
    delete process.env.COGNEE_ENABLED
    expect(await resetCognee()).toBe(false)
  })

  test('cognifyBatch returns all skipped when disabled', async () => {
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

  test('autoCognifyAll returns zeros when disabled', async () => {
    delete process.env.COGNEE_ENABLED
    const result = await autoCognifyAll()
    expect(result.processed).toBe(0)
    expect(result.failed).toBe(0)
    expect(result.skipped).toBe(0)
  })
})

describe('cognee — COGNEE_ENABLED env var', () => {
  test('COGNEE_ENABLED=false → disabled even if DB says enabled', async () => {
    process.env.COGNEE_ENABLED = 'false'
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
    } catch {}
    invalidateCogneeSettings()
    const health = await cogneeHealth()
    expect(health.enabled).toBe(false)
  })

  test('COGNEE_ENABLED=true → enabled when DB also says enabled', async () => {
    process.env.COGNEE_ENABLED = 'true'
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
    } catch {}
    invalidateCogneeSettings()
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
  })

  test('COGNEE_ENABLED unset → defaults to enabled (safe default)', async () => {
    delete process.env.COGNEE_ENABLED
    try {
      const config = await db.appConfig.findFirst()
      if (config) await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
    } catch {}
    invalidateCogneeSettings()
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
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
  test('invalidateCogneeSettings → does not throw', () => {
    expect(() => invalidateCogneeSettings()).not.toThrow()
  })

  test('invalidateCogneeSettings forces settings re-read from DB', async () => {
    delete process.env.COGNEE_ENABLED
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

describe('cognee memory layer — enabled (package installed, graceful degradation)', () => {
  beforeAll(async () => {
    process.env.COGNEE_ENABLED = 'true'
    try {
      const config = await db.appConfig.findFirst()
      if (config) {
        await db.appConfig.update({ where: { id: config.id }, data: { cogneeEnabled: true } })
      } else {
        await db.appConfig.create({ data: { cogneeEnabled: true } })
      }
    } catch {}
    invalidateCogneeSettings()
  })

  test('rememberChatTurn does not throw', async () => {
    await expect(
      rememberChatTurn({
        sessionId: 's1',
        userMessage: 'test question for cognee',
        aiMessage: 'test answer from cognee',
        toolRuns: [{ type: 'SQL', status: 'ok', latencyMs: 12 }],
      }),
    ).resolves.toBeUndefined()
  }, 30000)

  test('recallContext returns string (empty if no data)', async () => {
    const result = await recallContext({ query: 'test question' })
    expect(typeof result === 'string' || result === null).toBe(true)
  }, 30000)

  test('cogneeHealth reports enabled', async () => {
    const health = await cogneeHealth()
    expect(health.enabled).toBe(true)
    expect(health.mode === 'local' || health.mode === 'postgres').toBe(true)
  })

  test('cogneeStats returns document stats', async () => {
    const stats = await cogneeStats()
    expect(stats.enabled).toBe(true)
    expect(typeof stats.documents.total).toBe('number')
    expect(typeof stats.documents.cognified).toBe('number')
    expect(typeof stats.batchSize).toBe('number')
    expect(typeof stats.maxRetries).toBe('number')
  })

  test('cognifyDocument does not throw and returns boolean', async () => {
    const result = await cognifyDocument({
      documentId: 'test-cognee-doc',
      documentName: 'test.txt',
      chunks: [
        { content: 'Apple is a fruit. It is red and sweet.', chunkIndex: 0 },
        { content: 'Banana is another fruit. It is yellow and rich in potassium.', chunkIndex: 1 },
      ],
    })
    expect(typeof result).toBe('boolean')
  }, 60000)

  test('recallKnowledgeGraph returns string', async () => {
    const result = await recallKnowledgeGraph({ query: 'fruit' })
    expect(typeof result).toBe('string')
  }, 30000)

  test('recallKnowledgeGraphStructured returns array', async () => {
    const result = await recallKnowledgeGraphStructured({ query: 'fruit', topK: 3 })
    expect(Array.isArray(result)).toBe(true)
  }, 30000)

  test('forgetKnowledgeGraph returns boolean', async () => {
    const result = await forgetKnowledgeGraph()
    expect(typeof result).toBe('boolean')
  })

  test('forgetAll returns boolean when enabled', async () => {
    const result = await forgetAll()
    expect(typeof result).toBe('boolean')
  }, 30000)

  test('cognifyBatch returns result object when enabled', async () => {
    const result = await cognifyBatch({
      documents: [
        { documentId: 'batch-1', documentName: 'a.txt', chunks: [{ content: 'x', chunkIndex: 0 }] },
      ],
    })
    expect(typeof result.processed).toBe('number')
    expect(typeof result.failed).toBe('number')
    expect(typeof result.skipped).toBe('number')
  }, 60000)

  test('resetCognee returns boolean when enabled', async () => {
    const result = await resetCognee()
    expect(typeof result).toBe('boolean')
  }, 30000)
})

describe('cognee dataset isolation', () => {
  test('datasetFor returns fixed default', () => {
    expect(datasetFor()).toBe('default')
  })

  test('kbDatasetFor returns fixed default:kb', () => {
    expect(kbDatasetFor()).toBe('default:kb')
    expect(kbDatasetFor()).not.toBe(datasetFor())
  })
})
