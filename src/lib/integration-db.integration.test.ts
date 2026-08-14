// Integration test — hits REAL Postgres via Prisma. No mocks.
// Proves the DB layer + core RAG retrieval pipeline work end-to-end.
// Skips gracefully when DATABASE_URL is unset or DB is unreachable (CI without DB).
import { describe, expect, test } from 'bun:test'
import { db } from '@/lib/db'
import { ensureRagFtsTable, rebuildFts, searchFtsChunkIds } from '@/lib/rag-fts'

let dbOk = false
try {
  await db.$queryRaw`SELECT 1`
  dbOk = true
} catch {
  dbOk = false
}

const it = dbOk ? test : test.skip

describe('integration: real Postgres + RAG FTS pipeline (no mocks)', () => {
  it('Prisma client connects and queries DocumentChunk', async () => {
    const count = await db.documentChunk.count()
    expect(count).toBeGreaterThan(0)
  })

  it('Prisma model query with relations — Document.chunks', async () => {
    const doc = await db.document.findFirst({
      where: { status: 'ready', isEnabled: true },
      select: {
        id: true,
        name: true,
        chunks: { select: { id: true, content: true }, take: 3 },
      },
    })
    expect(doc).not.toBeNull()
    expect(doc!.chunks.length).toBeGreaterThan(0)
    expect(doc!.chunks[0].content.length).toBeGreaterThan(0)
  })

  it('FTS pipeline: ensureRagFtsTable + rebuildFts + search returns chunk IDs', async () => {
    await ensureRagFtsTable()
    const result = await rebuildFts()
    expect(result.indexed).toBeGreaterThan(0)

    const ids = await searchFtsChunkIds({ queryTokens: ['gudang'], limit: 5 })
    expect(ids.length).toBeGreaterThan(0)
  })

  it('FTS matches real content — returned chunk contains search term', async () => {
    const ids = await searchFtsChunkIds({ queryTokens: ['keuangan'], limit: 5 })
    expect(ids.length).toBeGreaterThan(0)

    const chunk = await db.documentChunk.findUnique({
      where: { id: ids[0] },
      select: { content: true },
    })
    expect(chunk).not.toBeNull()
    expect(chunk!.content.toLowerCase()).toContain('keuangan')
  })
})
