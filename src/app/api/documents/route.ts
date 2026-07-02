import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'
import {
  chunkText,
  detectDocType,
  extractFileText,
  extractKeywords,
} from '@/lib/rag'
import { embedDocumentChunks } from '@/lib/embeddings'
import { upsertChunkFts } from '@/lib/rag-fts'

export const runtime = 'nodejs'

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB — spec §8
const VALID_CATEGORIES = ['SOP', 'KEBIJAKAN', 'FINANSIAL', 'INVOICE', 'LAINNYA']

/**
 * GET /api/documents?category=SOP
 * List all documents for the active user's company, with chunk counts.
 */
export async function GET(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const { searchParams } = new URL(req.url)
    const category = searchParams.get('category')

    const where: { companyId: string; category?: string } = { companyId: user.companyId }
    if (category && VALID_CATEGORIES.includes(category)) {
      where.category = category
    }

    const docs = await db.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        type: true,
        sizeBytes: true,
        mimeType: true,
        status: true,
        category: true,
        description: true,
        createdAt: true,
        _count: { select: { chunks: true } },
      },
    })

    const data = docs.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      sizeBytes: d.sizeBytes,
      mimeType: d.mimeType,
      status: d.status,
      category: d.category,
      description: d.description,
      createdAt: d.createdAt,
      chunkCount: d._count.chunks,
    }))

    return NextResponse.json({ documents: data, total: data.length })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat daftar dokumen.')
  }
}

/**
 * POST /api/documents  (multipart/form-data)
 * Fields: file (File), category (string), description (string)
 * - Enforces 50 MB max (spec §8).
 * - Extracts text, chunks on double-newlines, writes DocumentChunk rows.
 * - Writes DOC_UPLOAD audit log.
 */
export async function POST(req: NextRequest) {
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json(
      { error: 'Expected multipart/form-data request' },
      { status: 400 },
    )
  }

  const file = formData.get('file')
  const category = (formData.get('category') as string | null)?.trim() || 'LAINNYA'
  const description = (formData.get('description') as string | null)?.trim() || ''

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 })
  }
  if (!VALID_CATEGORIES.includes(category)) {
    return NextResponse.json(
      { error: `Invalid category. Allowed: ${VALID_CATEGORIES.join(', ')}` },
      { status: 400 },
    )
  }
  if (file.size <= 0) {
    return NextResponse.json({ error: 'File is empty' }, { status: 400 })
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: 'File exceeds 50 MB limit (spec §8)',
        sizeBytes: file.size,
        limitBytes: MAX_BYTES,
      },
      { status: 413 },
    )
  }

  try {
    const user = await getActiveUser()

    const docType = detectDocType(file.name)
    const { text: extracted, isPlaceholder } = await extractFileText(file)

    // Build the content text. For placeholders we still keep a single "chunk"
    // so retrieval has something to match against the filename/category.
    const contentText =
      extracted && extracted.length > 0
        ? extracted
        : `[Empty document: ${file.name}]`

    // Create the document with status='ready'.
    const doc = await db.document.create({
      data: {
        companyId: user.companyId,
        name: file.name,
        type: docType,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        status: 'ready',
        category,
        description,
        contentText,
        uploadPath: null,
      },
    })

    // Semantic-ish chunking: split on double-newlines, filter empties.
    let chunks = chunkText(contentText)
    // If chunking yielded nothing (e.g., a one-paragraph doc), use the whole text.
    if (chunks.length === 0) chunks = [contentText]

    // Cap chunks per upload to avoid pathological files filling the DB.
    const MAX_CHUNKS = 500
    if (chunks.length > MAX_CHUNKS) {
      chunks = chunks.slice(0, MAX_CHUNKS)
    }

    // Persist chunks with token estimate + keyword tags.
    const chunkRows = chunks.map((content, idx) => ({
        documentId: doc.id,
        chunkIndex: idx,
        content,
        tokenCount: Math.ceil(content.length / 4),
        keywords: extractKeywords(content, 8),
      }))
    await db.documentChunk.createMany({
      data: chunkRows,
    })
    const persistedChunks = await db.documentChunk.findMany({
      where: { documentId: doc.id },
      select: { id: true, content: true, keywords: true },
    })
    for (const chunk of persistedChunks) {
      await upsertChunkFts({
        chunkId: chunk.id,
        companyId: user.companyId,
        content: chunk.content,
        keywords: chunk.keywords,
      })
    }

    const embedding = await embedDocumentChunks({
      companyId: user.companyId,
      documentId: doc.id,
    }).catch((error) => ({
      embedded: 0,
      skipped: chunks.length,
      provider: null,
      model: error instanceof Error ? error.message : 'embedding failed',
    }))

    await writeAudit({
      companyId: user.companyId,
      userId: user.userId,
      action: 'DOC_UPLOAD',
      severity: 'info',
      detail: {
        documentId: doc.id,
        name: doc.name,
        type: doc.type,
        category: doc.category,
        sizeBytes: doc.sizeBytes,
        chunkCount: chunks.length,
        isPlaceholder,
        embedding,
      },
    })

    const fresh = await db.document.findUnique({
      where: { id: doc.id },
      select: {
        id: true,
        name: true,
        type: true,
        sizeBytes: true,
        mimeType: true,
        status: true,
        category: true,
        description: true,
        createdAt: true,
        _count: { select: { chunks: true } },
      },
    })

    return NextResponse.json(
      {
        document: fresh
          ? {
              ...fresh,
              chunkCount: fresh._count.chunks,
            }
          : doc,
      },
      { status: 201 },
    )
  } catch (e) {
    return handleApiError(e, 'Gagal mengunggah dokumen.')
  }
}
