import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import {
  chunkText,
  detectDocType,
  extractFileText,
  extractKeywords,
  invalidateRagCache,
} from '@/lib/rag'
import { upsertChunkFts } from '@/lib/rag-fts'
import { MAX_EXTRACTED_TEXT_CHARS } from '@/lib/rag-chunking'
import { enqueueOrSync } from '@/lib/job-processor'
import { mapWithConcurrency } from '@/lib/bounded-concurrency'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'
import { indexChunkKnowledgeGraph } from '@/lib/knowledge-graph'
import { enterWithOrg } from '@/lib/prisma-tenant'

export const runtime = 'nodejs'

const MAX_BYTES = 50 * 1024 * 1024 // 50 MB — spec §8

const ALLOWED_EXTENSIONS = new Set(['.txt', '.pdf', '.docx', '.xlsx', '.md', '.csv', '.json'])
const ALLOWED_MIME_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/json',
])

/**
 * GET /api/documents?category=Foo
 * List all documents, optionally filtered by category.
 */
export async function GET(req: NextRequest) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { searchParams } = new URL(req.url)
    const category = searchParams.get('category')

    const where: { category?: string } = {}
    if (category) {
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
        isEnabled: true,
        category: true,
        description: true,
        cognifyStatus: true,
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
      isEnabled: d.isEnabled,
      category: d.category,
      description: d.description,
      cognifyStatus: d.cognifyStatus,
      createdAt: d.createdAt,
      chunkCount: d._count.chunks,
    }))

    return NextResponse.json({ documents: data, total: data.length })
  } catch (e) {
    return handleApiError(e, 'Failed to load document list.')
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
  const category = (formData.get('category') as string | null)?.trim() || 'Uncategorized'
  const description = (formData.get('description') as string | null)?.trim() || ''

  if (!file || !(file instanceof File)) {
    return NextResponse.json({ error: 'Missing "file" field' }, { status: 400 })
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

  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? ''
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: `File type ${ext} is not allowed. Accepted: ${[...ALLOWED_EXTENSIONS].join(', ')}` },
      { status: 400 },
    )
  }
  // Check MIME type if provided (some browsers don't set it correctly).
  // ponytail: compare the media type only — clients routinely append parameters
  // ("text/plain;charset=utf-8"), which failed the old exact-match check and
  // rejected uploads the extension list explicitly allows.
  if (file.type) {
    const mimeType = file.type.split(';')[0].trim().toLowerCase()
    if (!ALLOWED_MIME_TYPES.has(mimeType) && mimeType !== 'application/octet-stream') {
      return NextResponse.json({ error: `MIME type ${file.type} is not allowed.` }, { status: 400 })
    }
  }

  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // Viewer read access is fine for documents, but mutating the corpus is admin-only.
    requireRole(user, 'admin')

    const docType = detectDocType(file.name)
    const { text: extracted, isPlaceholder } = await extractFileText(file)

    // Cap extracted text BEFORE chunking — a huge text bloats the payload, DB rows,
    // and in-memory chunk arrays. Binary parsers already cap inside limitExtractedText;
    // this guards plain text/csv/json uploads too.
    if (extracted.length > MAX_EXTRACTED_TEXT_CHARS) {
      return NextResponse.json(
        {
          error: `Extracted text exceeds ${MAX_EXTRACTED_TEXT_CHARS.toLocaleString()} characters.`,
        },
        { status: 413 },
      )
    }

    // Build the content text. For placeholders we still keep a single "chunk"
    // so retrieval has something to match against the filename/category.
    const contentText =
      extracted && extracted.length > 0
        ? extracted
        : `[Empty document: ${file.name}]`

    // Create the document with status='ready'.
    const doc = await db.document.create({
      data: {
        organizationId: user.organizationId,
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
    // Parent-doc chunking: small child chunks + parent window context (opt-in).
    // Cap chunks per upload to avoid pathological files filling the DB.
    const MAX_CHUNKS = 500
    const useParentDoc = !!process.env.PARENT_DOC_CHILD_SIZE
    const chunkResult = useParentDoc
      ? (await import('@/lib/rag-chunking')).chunkTextParentDoc(contentText, { maxChunks: MAX_CHUNKS })
      : null
    let chunks: string[]
    let chunkContextPrefixes: (string | null)[]
    if (chunkResult) {
      chunks = chunkResult.map((c) => c.content)
      chunkContextPrefixes = chunkResult.map((c) => c.contextPrefix)
    } else {
      chunks = chunkText(contentText, { maxChunks: MAX_CHUNKS })
      chunkContextPrefixes = chunks.map(() => null)
    }
    // If chunking yielded nothing (e.g., a one-paragraph doc), use the whole text.
    if (chunks.length === 0) { chunks = [contentText]; chunkContextPrefixes = [null] }

    // Persist chunks with token estimate + keyword tags.
    const chunkRows = chunks.map((content, idx) => ({
        organizationId: user.organizationId,
        documentId: doc.id,
        chunkIndex: idx,
        content,
        contextPrefix: chunkContextPrefixes[idx],
        tokenCount: Math.ceil(content.length / 4),
        keywords: extractKeywords(content, 8),
      }))
    await db.documentChunk.createMany({
      data: chunkRows,
    })
    await invalidateRagCache()
    invalidateSourceEmbeddingCache()
    const persistedChunks = await db.documentChunk.findMany({
      where: { documentId: doc.id },
      select: { id: true, content: true, keywords: true },
    })
    for (const chunk of persistedChunks) {
      await upsertChunkFts({
        chunkId: chunk.id,
        content: chunk.content,
        keywords: chunk.keywords,
      })
    }

    // ponytail: heavy processing (embeddings + cognify + KG extraction) moved to background.
    // Falls back to synchronous when Redis is down — graceful degradation.
    await enqueueOrSync('document-embed', { type: 'document-embed', documentId: doc.id, organizationId: user.organizationId })
    void enqueueOrSync('document-cognify', { type: 'document-cognify', documentId: doc.id, organizationId: user.organizationId }).catch(() => null)
    // ponytail: LightRAG-style entity-relation extraction — fire-and-forget, enhances RAG with KG.
    // BOUNDED: 500 chunks used to fire 500 simultaneous LLM calls (Promise.all
    // over the whole list), bypassing every queue and rate limit. 5 at a time
    // matches the doc-worker's throughput shape; errors are per-chunk and
    // non-fatal (allSettled semantics).
    void mapWithConcurrency(persistedChunks, 5, (c) =>
      indexChunkKnowledgeGraph({ chunkId: c.id, content: c.content }),
    ).catch(() => null)

    // ponytail: LLM first-scan — when the uploader gave no description, have the
    // LLM read the content and write one. Descriptions feed the intent router,
    // which decides RAG-vs-SQL-vs-REST; a file name alone ("scan_001.pdf")
    // carries no routing signal. Fire-and-forget, never blocks the upload.
    if (!description) {
      const { initDocumentContext } = await import('@/lib/source-init')
      void initDocumentContext(doc.id).catch(() => null)
    }

    await writeAudit({
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
        jobsQueued: true,
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
    return handleApiError(e, 'Failed to upload document.')
  }
}
