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
): Promise<{ version: number; restored: boolean }> {
  const version = await db.documentVersion.findFirst({
    where: { id: versionId, documentId },
  })
  if (!version) throw new Error(`Version not found: ${versionId}`)

  const doc = await db.document.findUnique({
    where: { id: documentId },
    select: { id: true, uploadPath: true, name: true, type: true, mimeType: true, organizationId: true },
  })
  if (!doc) throw new Error(`Document not found: ${documentId}`)

  // Update version number
  await db.document.update({
    where: { id: documentId },
    data: { version: version.version },
  })

  if (doc.uploadPath) {
    // Re-read and re-embed from the original uploaded file.
    const { readFile } = await import('fs/promises')
    try {
      const buffer = await readFile(doc.uploadPath)
      const { extractFileText } = await import('@/lib/rag')
      const { chunkText } = await import('@/lib/rag-chunking')
      const file = new File([buffer], doc.name, { type: doc.mimeType || 'application/octet-stream' })
      const { text } = await extractFileText(file)
      const chunks = chunkText(text)

      // Delete existing chunks, then re-insert the restored content.
      await db.documentChunk.deleteMany({ where: { documentId } })
      await db.documentChunk.createMany({
        data: chunks.map((c, i) => ({
          organizationId: doc.organizationId,
          documentId,
          chunkIndex: i,
          content: c,
          tokenCount: Math.ceil(c.length / 4),
        })),
      })

      // Re-embed the restored chunks.
      const { embedDocumentChunks } = await import('@/lib/embeddings')
      await embedDocumentChunks({ documentId })

      return { version: version.version, restored: true }
    } catch {
      // ponytail: original file no longer on disk — can't restore content,
      // but the version pointer is still updated above.
      return { version: version.version, restored: false }
    }
  }

  return { version: version.version, restored: false }
}
