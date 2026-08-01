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
const mockChunkDeleteMany = mock(async () => ({ count: 2 }))
const mockChunkCreateMany = mock(async () => ({ count: 2 }))
const mockReadFile = mock(async () => Buffer.from('hello\n\nworld'))
const mockExtractFileText = mock(async () => ({ text: 'hello\n\nworld', isPlaceholder: false }))
const mockChunkText = mock((s: string) => s.split(/\n\n+/).filter(Boolean))

mock.module('@/lib/db', () => ({
  db: {
    document: {
      findUnique: mockDocFindUnique,
      update: mockDocUpdate,
    },
    documentChunk: { findMany: mockChunkFindMany, deleteMany: mockChunkDeleteMany, createMany: mockChunkCreateMany },
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
mock.module('fs/promises', () => ({ readFile: mockReadFile }))
mock.module('@/lib/rag', () => ({ extractFileText: mockExtractFileText }))
mock.module('@/lib/rag-chunking', () => ({ chunkText: mockChunkText }))

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
  mockChunkDeleteMany.mockImplementation(async () => ({ count: 2 }))
  mockChunkCreateMany.mockImplementation(async () => ({ count: 2 }))
  mockReadFile.mockImplementation(async () => Buffer.from('hello\n\nworld'))
  mockExtractFileText.mockImplementation(async () => ({ text: 'hello\n\nworld', isPlaceholder: false }))
  mockChunkText.mockImplementation((s: string) => s.split(/\n\n+/).filter(Boolean))
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
  test('sets document version; no uploadPath → restored false, no re-embed', async () => {
    mockVersionFindFirst.mockImplementation(async () => ({
      id: 'ver-1',
      documentId: 'doc-1',
      version: 2,
      contentHash: 'abc',
      chunkCount: 2,
      createdAt: new Date('2026-01-01'),
    }))
    mockDocFindUnique.mockImplementation(async () => ({ id: 'doc-1', version: 1 }))
    const result = await restoreDocVersion('doc-1', 'ver-1')
    expect(result.version).toBe(2)
    expect(result.restored).toBe(false)

    const updateArg = (mockDocUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0]
    expect(updateArg.data.version).toBe(2)
    expect(mockEmbedDocumentChunks.mock.calls.length).toBe(0)
  })

  test('uploadPath present → re-reads file, replaces chunks, re-embeds, restored true', async () => {
    mockVersionFindFirst.mockImplementation(async () => ({
      id: 'ver-1',
      documentId: 'doc-1',
      version: 2,
      contentHash: 'abc',
      chunkCount: 2,
      createdAt: new Date('2026-01-01'),
    }))
    mockDocFindUnique.mockImplementation(async () => ({
      id: 'doc-1',
      uploadPath: '/tmp/doc.txt',
      name: 'doc.txt',
      type: 'txt',
      mimeType: 'text/plain',
      organizationId: 'org-1',
    }))

    const result = await restoreDocVersion('doc-1', 'ver-1')
    expect(result.version).toBe(2)
    expect(result.restored).toBe(true)

    expect(mockReadFile.mock.calls.length).toBe(1)
    expect(mockChunkDeleteMany.mock.calls.length).toBe(1)
    expect(mockChunkCreateMany.mock.calls.length).toBe(1)
    expect(mockEmbedDocumentChunks.mock.calls.length).toBe(1)
  })

  test('throws when version not found', async () => {
    mockVersionFindFirst.mockImplementation(async () => null)
    expect(restoreDocVersion('doc-1', 'missing')).rejects.toThrow(/Version not found/)
  })
})
