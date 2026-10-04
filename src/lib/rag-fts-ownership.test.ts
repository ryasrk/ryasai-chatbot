import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'

const sqlite = new Database(':memory:')
let orgId: string | undefined = 'org-a'
sqlite.exec('CREATE TABLE DocumentChunk (id TEXT PRIMARY KEY, organizationId TEXT NOT NULL)')
sqlite.exec('CREATE VIRTUAL TABLE DocumentChunkFts USING fts5(chunkId UNINDEXED, content, keywords)')
mock.module('@/lib/db-provider', () => ({ getDbProvider: () => 'sqlite' }))
mock.module('@/lib/prisma-tenant', () => ({ getOrgContext: () => orgId }))
mock.module('@/lib/db', () => ({ db: {
  $executeRawUnsafe: async (sql: string, ...params: unknown[]) => sqlite.query(sql).run(...params as string[]).changes,
} }))
const { upsertChunkFts } = await import('./rag-fts')

beforeEach(() => {
  orgId = 'org-a'
  sqlite.exec('DELETE FROM DocumentChunk; DELETE FROM DocumentChunkFts')
  sqlite.query('INSERT INTO DocumentChunk VALUES (?, ?)').run('own', 'org-a')
  sqlite.query('INSERT INTO DocumentChunk VALUES (?, ?)').run('foreign', 'org-b')
  sqlite.query('INSERT INTO DocumentChunkFts VALUES (?, ?, ?)').run('foreign', 'protected', '')
})
afterAll(() => sqlite.close())

test('foreign SQLite FTS entry cannot be deleted or replaced', async () => {
  await upsertChunkFts({ chunkId: 'foreign', content: 'overwrite', keywords: 'changed' })
  expect(sqlite.query('SELECT content, keywords FROM DocumentChunkFts WHERE chunkId = ?').all('foreign'))
    .toEqual([{ content: 'protected', keywords: '' }])
})

test('own SQLite FTS entry is inserted and replaced without duplication', async () => {
  await upsertChunkFts({ chunkId: 'own', content: 'first' })
  await upsertChunkFts({ chunkId: 'own', content: 'replacement', keywords: 'keyword' })
  expect(sqlite.query('SELECT content, keywords FROM DocumentChunkFts WHERE chunkId = ?').all('own'))
    .toEqual([{ content: 'replacement', keywords: 'keyword' }])
})

test('missing tenant context leaves the index untouched', async () => {
  orgId = undefined
  await expect(upsertChunkFts({ chunkId: 'foreign', content: 'overwrite' })).rejects.toThrow('organization context')
  expect(sqlite.query('SELECT content FROM DocumentChunkFts').all()).toEqual([{ content: 'protected' }])
})
