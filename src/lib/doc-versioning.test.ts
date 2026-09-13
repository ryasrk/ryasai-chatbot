import { describe, expect, test, mock, beforeEach } from 'bun:test'

/**
 * The SCOPED document read. Kept as a separate mock from `mockDocFindUnique` on purpose: the whole fix is that the
 * document load uses a FILTER operation so the tenant extension can append the caller's org, and a test harness that
 * routed both names to one function could not tell them apart.
 */
const mockDocFindFirst = mock<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
  async () => ({ id: 'doc-1', version: 1 }),
)
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
      // Retained so a regression to the unscoped operation fails an ASSERTION rather than crashing the file.
      findUnique: mockDocFindUnique,
      findFirst: mockDocFindFirst,
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
  // Clear every mock's CALL LOG, not just its implementation. Without this the logs accumulate
  // across tests in this file, so a positional assertion (`mock.calls[0]`) reads a call from an
  // earlier test, and a content assertion can be satisfied by a different test's call.
  mockDocFindUnique.mockClear()
  mockDocFindFirst.mockClear()
  mockDocUpdate.mockClear()
  mockChunkFindMany.mockClear()
  mockVersionCreate.mockClear()
  mockVersionFindFirst.mockClear()
  mockVersionFindMany.mockClear()
  mockChunkDeleteMany.mockClear()
  mockChunkCreateMany.mockClear()
  mockReadFile.mockClear()
  mockExtractFileText.mockClear()
  mockChunkText.mockClear()
  mockEmbedDocumentChunks.mockClear()
  mockDocFindUnique.mockImplementation(async () => ({ id: 'doc-1', version: 1 }))
  mockDocFindFirst.mockImplementation(async () => ({ id: 'doc-1', version: 1 }))
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

  test('throws when the document is not resolvable IN THIS ORG', async () => {
    // "Not found" now means "not in the caller's org", because the load goes through the org-scoped read: a
    // cross-tenant id is indistinguishable from a missing one, which is the point. The unscoped operation must not
    // be consulted as a fallback.
    mockDocFindFirst.mockImplementation(async () => null)
    expect(createDocVersion('missing')).rejects.toThrow(/Document not found/)
    expect(mockDocFindUnique).not.toHaveBeenCalled()
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
    mockDocFindFirst.mockImplementation(async () => ({
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

  test('a FAILED restore still moves the version pointer, and says restored: false', async () => {
    // The catch covers the case the comment names: the version row exists and the doc still carries
    // an uploadPath, but the original file is gone from disk (or the re-embed call fails). Without
    // the catch this THROWS out of restoreDocVersion, and the operator loses the fact that the
    // version pointer had already been updated -- leaving the doc's metadata claiming v2 while its
    // chunks are still v1.
    mockVersionFindFirst.mockImplementation(async () => ({
      id: 'ver-1',
      documentId: 'doc-1',
      version: 2,
      contentHash: 'abc',
      chunkCount: 2,
      createdAt: new Date('2026-01-01'),
    }))
    mockDocFindFirst.mockImplementation(async () => ({
      id: 'doc-1',
      uploadPath: '/tmp/gone.txt',
      name: 'gone.txt',
      type: 'txt',
      mimeType: 'text/plain',
      organizationId: 'org-1',
    }))
    mockReadFile.mockImplementation(async () => {
      throw new Error('ENOENT: no such file or directory')
    })
    const deletesBefore = mockChunkDeleteMany.mock.calls.length
    const createsBefore = mockChunkCreateMany.mock.calls.length
    const embedsBefore = mockEmbedDocumentChunks.mock.calls.length

    const result = await restoreDocVersion('doc-1', 'ver-1')
    // The pointer move is NOT rolled back -- the caller is told it did not get its content back.
    expect(result.version).toBe(2)
    expect(result.restored).toBe(false)
    // The version pointer WAS written, even though the content restore failed. Exactly ONE update
    // call, and it sets the version -- a strict assertion now that beforeEach clears the call logs.
    const updates = mockDocUpdate.mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>
    expect(updates).toHaveLength(1)
    expect(updates[0]![0].data.version).toBe(2)
    // Nothing downstream of the failure ran: no chunk wipe, no re-embed. A partial restore that
    // deleted the OLD chunks and then failed to insert new ones would leave the document empty.
    // Counted as a DELTA: these mock call logs are not cleared between tests in this file, so an
    // absolute assertion would depend on which tests ran first.
    expect(mockChunkDeleteMany.mock.calls.length - deletesBefore).toBe(0)
    expect(mockChunkCreateMany.mock.calls.length - createsBefore).toBe(0)
    expect(mockEmbedDocumentChunks.mock.calls.length - embedsBefore).toBe(0)
  })

  test('a failure during RE-EMBED is caught the same way', async () => {
    // The failure point matters: chunks are already replaced at this stage, so this pins that the
    // call still returns rather than rejecting.
    mockVersionFindFirst.mockImplementation(async () => ({
      id: 'ver-1',
      documentId: 'doc-1',
      version: 2,
      contentHash: 'abc',
      chunkCount: 2,
      createdAt: new Date('2026-01-01'),
    }))
    mockDocFindFirst.mockImplementation(async () => ({
      id: 'doc-1',
      uploadPath: '/tmp/doc.txt',
      name: 'doc.txt',
      type: 'txt',
      mimeType: 'text/plain',
      organizationId: 'org-1',
    }))
    mockEmbedDocumentChunks.mockImplementation(async () => {
      throw new Error('embedding provider rejected the batch')
    })
    const createsBefore = mockChunkCreateMany.mock.calls.length

    const result = await restoreDocVersion('doc-1', 'ver-1')
    expect(result.version).toBe(2)
    expect(result.restored).toBe(false)
    // The chunks WERE replaced before the re-embed failed -- that ordering is the point.
    expect(mockChunkCreateMany.mock.calls.length - createsBefore).toBe(1)
  })

  test('throws when version not found', async () => {
    mockVersionFindFirst.mockImplementation(async () => null)
    expect(restoreDocVersion('doc-1', 'missing')).rejects.toThrow(/Version not found/)
  })
})
