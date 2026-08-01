import crypto from 'crypto'
import { db } from '@/lib/db'
import { getOrgContext } from '@/lib/prisma-tenant'

export interface DocVersionSnapshot {
  id: string
  documentId: string
  version: number
  contentHash: string
  chunkCount: number
  createdAt: Date
}

export async function createDocVersion(documentId: string): Promise<DocVersionSnapshot> {
  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, version: true },
  })
  if (!doc) throw new Error(`Document not found: ${documentId}`)

  const chunks = await db.documentChunk.findMany({
    where: { documentId },
    orderBy: { chunkIndex: 'asc' },
    select: { id: true, content: true },
  })

  const hash = crypto
    .createHash('sha256')
    .update(chunks.map((c) => c.content).join('\n\n'))
    .digest('hex')

  const nextVersion = doc.version + 1

  const snapshot = await db.documentVersion.create({
    data: {
      organizationId: getOrgContext()!,
      documentId,
      version: nextVersion,
      contentHash: hash,
      chunkCount: chunks.length,
    },
  })

  await db.document.update({
    where: { id: documentId },
    data: { version: nextVersion },
  })

  return snapshot
}

export async function listDocVersions(documentId: string): Promise<DocVersionSnapshot[]> {
  return db.documentVersion.findMany({
    where: { documentId },
    orderBy: { version: 'desc' },
  })
}

export async function restoreDocVersion(
  documentId: string,
  versionId: string,
): Promise<{ version: number; embedded: number }> {
  const version = await db.documentVersion.findFirst({
    where: { id: versionId, documentId },
  })
  if (!version) throw new Error(`Version not found: ${versionId}`)

  await db.document.update({
    where: { id: documentId },
    data: { version: version.version },
  })

  const { embedDocumentChunks } = await import('@/lib/embeddings')
  const result = await embedDocumentChunks({ documentId })

  return { version: version.version, embedded: result.embedded }
}
