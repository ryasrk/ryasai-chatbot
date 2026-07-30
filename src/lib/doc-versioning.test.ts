import { describe, expect, test, mock, beforeEach } from 'bun:test'

const mockDocFindUnique = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => ({ id: 'doc-1', version: 1 }),
)
const mockChunkFindMany = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(
  async () => [
    { id: 'c1', content: 'hello' },
    { id: 'c2', content: 'world' },
  ],
)
const mockVersionCreate = mock<(...args: unknown[]) => Promise<Record<string, unknown>>>(
  async () => ({
    id: 'ver-1',
    documentId: 'doc-1',
    version: 2,
    contentHash: 'abc',
    chunkCount: 2,
    createdAt: new Date('2026-01-01'),
  }),
)
const mockDocUpdate = mock(async () => ({}))
const mockVersionFindMany = mock<(...args: unknown[]) => Promise<Array<Record<string, unknown>>>>(
  async () => [],
)
const mockVersionFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => null,
)
const mockEmbedDocumentChunks = mock(async () => ({ embedded: 2, skipped: 0, provider: 'x', model: 'y' }))

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findUnique: mockDocFindUnique,
      update: mockDocUpdate,
    },
    documentChunk: { findMany: mockChunkFindMany },
    documentVersion: {
      create: mockVersionCreate,
      findMany: mockVersionFindMany,
      findFirst: mockVersionFindFirst,
    },
  },
}))

mock.module('@/lib/embeddings', () => ({
  embedDocumentChunks: mockEmbedDocumentChunks,
}))

import { createDocVersion, listDocVersions, restoreDocVersion } from './doc-versioning'

beforeEach(() => {
  mockDocFindUnique.mockImplementation(async () => ({ id: 'doc-1', version: 1 }))
  mockChunkFindMany.mockImplementation(async () => [
    { id: 'c1', content: 'hello' },
    { id: 'c2', content: 'world' },
  ])
  mockVersionCreate.mockImplementation(async () => ({
    id: 'ver-1',
    documentId: 'doc-1',
    version: 2,
    contentHash: 'abc',
    chunkCount: 2,
    createdAt: new Date('2026-01-01'),
  }))
  mockDocUpdate.mockImplementation(async () => ({}))
  mockVersionFindMany.mockImplementation(async () => [
    { id: 'ver-2', documentId: 'doc-1', version: 3, contentHash: 'def', chunkCount: 2, createdAt: new Date('2026-01-02') },
    { id: 'ver-1', documentId: 'doc-1', version: 2, contentHash: 'abc', chunkCount: 2, createdAt: new Date('2026-01-01') },
  ])
  mockVersionFindFirst.mockImplementation(async () => null)
  mockEmbedDocumentChunks.mockImplementation(async () => ({ embedded: 2, skipped: 0, provider: 'x', model: 'y' }))
})

describe('createDocVersion', () => {
  test('snapshots current chunks, increments version, creates row', async () => {
    const snap = await createDocVersion('doc-1')
    expect(snap.version).toBe(2)
    expect(snap.chunkCount).toBe(2)
    expect(snap.contentHash).toBe('abc')

    const createArg = (mockVersionCreate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    expect(createArg.data.version).toBe(2)
    expect(createArg.data.chunkCount).toBe(2)
    expect(typeof createArg.data.contentHash).toBe('string')
    expect(createArg.data.contentHash).toHaveLength(64)

    const updateArg = (mockDocUpdate.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0]
    expect(updateArg.where.id).toBe('doc-1')
    expect(updateArg.data.version).toBe(2)
  })

  test('throws when document not found', async () => {
    mockDocFindUnique.mockImplementation(async () => null)
    expect(createDocVersion('missing')).rejects.toThrow(/Document not found/)
  })
})

describe('listDocVersions', () => {
  test('returns versions ordered by version desc', async () => {
    const list = await listDocVersions('doc-1')
    expect(list).toHaveLength(2)
    expect(list[0].version).toBe(3)
    expect(list[1].version).toBe(2)
    const arg = (mockVersionFindMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; orderBy: Record<string, string> }])[0]
    expect(arg.where.documentId).toBe('doc-1')
    expect(arg.orderBy.version).toBe('desc')
  })
})

describe('restoreDocVersion', () => {
  test('sets document version and re-embeds chunks', async () => {
    mockVersionFindFirst.mockImplementation(async () => ({
      id: 'ver-1',
      documentId: 'doc-1',
      version: 2,
      contentHash: 'abc',
      chunkCount: 2,
      createdAt: new Date('2026-01-01'),
    }))
    const result = await restoreDocVersion('doc-1', 'ver-1')
    expect(result.version).toBe(2)
    expect(result.embedded).toBe(2)

    const updateArg = (mockDocUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    expect(updateArg.data.version).toBe(2)
    expect(mockEmbedDocumentChunks.mock.calls.length).toBe(1)
  })

  test('throws when version not found', async () => {
    mockVersionFindFirst.mockImplementation(async () => null)
    expect(restoreDocVersion('doc-1', 'missing')).rejects.toThrow(/Version not found/)
  })
})
