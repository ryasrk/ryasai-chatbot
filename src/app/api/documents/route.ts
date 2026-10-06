import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { documentVisibilityWhere, normalizeRole } from '@/lib/access-scope'
import {
  chunkText,
  detectDocType,
  extractFileText,
  extractKeywords,
  invalidateRagCache,
} from '@/lib/rag'
import { upsertChunkFts } from '@/lib/rag-fts'
import { MAX_EXTRACTED_TEXT_CHARS, emptyDocumentContent } from '@/lib/rag-chunking'
import { enqueueOrSync } from '@/lib/job-processor'
import { mapWithConcurrency } from '@/lib/bounded-concurrency'
import { invalidateSourceEmbeddingCache } from '@/lib/smart-router'
import { indexChunkKnowledgeGraph } from '@/lib/knowledge-graph'
import { enterWithOrg, requireOrgContext } from '@/lib/prisma-tenant'
import { checkQuota, quotaExceededMessage } from '@/lib/plan-gating'
import { getKnowledgeStorageChoice } from '@/lib/vector-stores'
import { AppError } from '@/lib/errors'
import { RAG_MAX_CHUNKS_PER_UPLOAD } from '@/lib/constants'

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
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { searchParams } = new URL(req.url)
    const category = searchParams.get('category')

    // A role sees only the documents it may retrieve (Document.allowedRoles); admin sees all.
    const where: Record<string, unknown> = { ...documentVisibilityWhere(normalizeRole(user.role)) }
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
        cognifyError: true,
        allowedRoles: true,
        createdAt: true,
        _count: { select: { chunks: true } },
      },
    })

    /*
     * How many chunks have a VECTOR, read with raw SQL because the column is `Unsupported(...)` to Prisma.
     *
     * `embeddedChunkCount` used to count `embeddingJson !== null`, which made the field a PROXY for a column a
     * DIFFERENT code path writes. MEASURED on a real install: a 1536-dim embedder beside the schema's
     * `vector(384)` column wrote 500 `embeddingJson` values and ZERO vector values — pgvector search fully disabled —
     * while this count reported 500/500 and the document read as "fully embedded" to the UI and to every test
     * waiting on it. The dimension mismatch was logged server-side and never reached the operator.
     *
     * The vector column is what retrieval actually searches, so it is what this count reports. The JSON-only
     * remainder stays visible as its own field: real information (a mismatched install still ranks lexically), but
     * never mistakable for searchability.
     */
    const vectorCounts = new Map<string, number>()
    try {
      const rows = await db.$queryRaw<Array<{ documentId: string; n: bigint }>>`
        SELECT "documentId", COUNT(*) AS n
        FROM "DocumentChunk"
        WHERE "organizationId" = ${requireOrgContext()} AND embedding IS NOT NULL
        GROUP BY "documentId"
      `
      for (const row of rows) vectorCounts.set(row.documentId, Number(row.n))
    } catch {
      // A vector-less install (no pgvector) must still list documents; the count then reads 0, which is TRUE.
    }

    /*
     * How many chunks have embeddingJson, counted via raw SQL aggregate instead of selecting
     * `chunks: { select: { embeddingJson: true } }` into memory. Loading large vector JSON strings
     * across thousands of chunks can consume hundreds of megabytes of heap.
     */
    const jsonCounts = new Map<string, number>()
    try {
      const rows = await db.$queryRaw<Array<{ documentId: string; n: bigint }>>`
        SELECT "documentId", COUNT(*) AS n
        FROM "DocumentChunk"
        WHERE "organizationId" = ${requireOrgContext()} AND "embeddingJson" IS NOT NULL
        GROUP BY "documentId"
      `
      for (const row of rows) jsonCounts.set(row.documentId, Number(row.n))
    } catch {
      // A DB failure or empty chunk table falls back cleanly; count reads 0.
    }

    const data = docs.map((d) => {
      const vectorCount = vectorCounts.get(d.id) ?? 0
      const jsonCount = jsonCounts.get(d.id) ?? 0
      return {
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
        cognifyError: d.cognifyError,
        createdAt: d.createdAt,
        chunkCount: d._count.chunks,
        embeddedChunkCount: vectorCount,
        embeddedJsonOnlyChunkCount: Math.max(0, jsonCount - vectorCount),
      }
    })

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
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // Viewer read access is fine for documents, but mutating the corpus is admin-only.
    requireRole(user, 'admin')

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

    // Quota check before extraction/embedding — those are the expensive steps,
    // and refusing after paying for them would waste an embedding call per
    // over-quota upload.
    const docCount = await db.document.count()
    const quota = checkQuota(user.plan, 'maxDocuments', docCount)
    if (!quota.allowed) {
      return NextResponse.json(
        { ok: false, error: quotaExceededMessage('maxDocuments', quota), code: 'QUOTA_EXCEEDED' },
        { status: 402 },
      )
    }

    /*
     * STORAGE CHOICE GATE.
     *
     * A document is not just a row: it is embedded into a store, and the operator has to have said WHICH store. That
     * question used to have no answer anyone could point at — a fresh install quietly took documents into the
     * bundled pgvector store, `VectorStoreConfig` appeared only if an admin happened to visit the vector panel, and
     * "what is our knowledge base running on?" could only be answered by reading the data. Now it is an explicit
     * first-run step (setup wizard) and a Knowledge → Storage control, and upload refuses until it is answered.
     *
     * WHERE this check sits is the point: after the session/role/quota checks (so it never masks a cheaper, more
     * actionable refusal) and BEFORE `extractFileText` — a refused upload must not cost a parse, an embedding call or
     * a chunk write. Fail-closed, so a missing row (nobody has ever saved) refuses rather than defaulting to
     * internal: silently choosing a store on the operator's behalf is the behaviour this replaces.
     *
     * `SETUP_REQUIRED` (503) rather than a 4xx: nothing about the request is malformed — the install is not
     * finished — and the UI keys on the code to offer the setup link instead of a red validation message.
     */
    const storage = await getKnowledgeStorageChoice()
    if (!storage.chosen) {
      throw new AppError(
        'SETUP_REQUIRED',
        'Choose where the knowledge base is stored before uploading documents.',
        {
          hint: 'Open Knowledge → Storage and pick Internal (bundled PostgreSQL) or an external vector database.',
        },
      )
    }

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
    // so retrieval has something to match against the filename/category —
    // but see `isPlaceholderChunk`: that marker is deliberately excluded from
    // answer EVIDENCE, because passing it as evidence made the bot disclaim
    // answers it actually had.
    const contentText =
      extracted && extracted.length > 0
        ? extracted
        : emptyDocumentContent(file.name)

    // Semantic-ish chunking: split on double-newlines, filter empties.
    // Parent-doc chunking: small child chunks + parent window context (opt-in).
    // Cap chunks per upload to avoid pathological files filling the DB.
    const useParentDoc = !!process.env.PARENT_DOC_CHILD_SIZE
    const chunkResult = useParentDoc
      ? (await import('@/lib/rag-chunking')).chunkTextParentDoc(contentText, { maxChunks: RAG_MAX_CHUNKS_PER_UPLOAD + 1 })
      : null
    let chunks: string[]
    let chunkContextPrefixes: (string | null)[]
    if (chunkResult) {
      chunks = chunkResult.map((c) => c.content)
      chunkContextPrefixes = chunkResult.map((c) => c.contextPrefix)
    } else {
      chunks = chunkText(contentText, { maxChunks: RAG_MAX_CHUNKS_PER_UPLOAD + 1 })
      chunkContextPrefixes = chunks.map(() => null)
    }
    // If chunking yielded nothing (e.g., a one-paragraph doc), use the whole text.
    if (chunks.length === 0) { chunks = [contentText]; chunkContextPrefixes = [null] }

    // Probe one extra chunk so the bound cannot silently discard a document's tail.
    if (chunks.length > RAG_MAX_CHUNKS_PER_UPLOAD) {
      return NextResponse.json({
        error: `Document exceeds ${RAG_MAX_CHUNKS_PER_UPLOAD.toLocaleString()} chunks. Split it into smaller documents and upload each part.`,
      }, { status: 413 })
    }

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
