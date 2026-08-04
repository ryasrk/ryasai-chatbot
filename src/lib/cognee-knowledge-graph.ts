/**
 * Cognee — knowledge graph: cognify, graph-grounded recall, forget/reset.
 * Depends on: cognee-types, cognee-core, external (db).
 */
import type { GraphSearchResult } from './cognee-types'
import { kbDatasetFor } from './cognee-types'
import {
  isCogneeEnabled,
  getCogneeClient,
  getCogneeSettings,
  cogneeBatchSize,
  cognifyMaxRetries,
  getCogneeOwnerId,
  formatSearchResponse,
  extractSearchItems,
  updateDocumentCognifyStatus,
  resetClientCache,
} from './cognee-core'
import { db } from '@/lib/db'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Knowledge graph — cognify documents
// ---------------------------------------------------------------------------

/**
 * Cognify a single document — extracts entities + relationships, builds graph.
 * Uses retry logic for transient FK constraint errors.
 * Tracks cognify status in Document table for incremental processing.
 */
export async function cognifyDocument(args: {
  documentId: string
  documentName: string
  chunks: Array<{ content: string; chunkIndex: number }>
}): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false

  const settings = await getCogneeSettings()
  const dataset = kbDatasetFor()
  const text = args.chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((chunk) => chunk.content)
    .join('\n\n')

  // Add data to dataset first — this creates the dataset record
  // ponytail: graceful degradation — falls back to failed status when cognee add/cognify fails
  try {
    await c.add([{ type: 'text', text }], dataset)
  } catch (err) {
    console.warn('[cognee] add failed for document:', args.documentId, err)
    await updateDocumentCognifyStatus(args.documentId, 'failed', String(err))
    return false
  }

  // Cognify with retry — FK constraint errors are transient in SQLite backend
  const maxRetries = cognifyMaxRetries(settings)
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await updateDocumentCognifyStatus(args.documentId, 'processing', undefined)
      await c.cognify(dataset)
      await updateDocumentCognifyStatus(args.documentId, 'completed', undefined)
      return true
    } catch (err) {
      const errStr = String(err)
      const isTransient = errStr.includes('FOREIGN KEY') || errStr.includes('constraint') || errStr.includes('locked')
      if (attempt < maxRetries && isTransient) {
        console.warn(`[cognee] cognify attempt ${attempt}/${maxRetries} failed (transient), retrying...`)
        await sleep(1000 * attempt)
        continue
      }
      console.warn(`[cognee] cognify failed after ${attempt} attempts:`, err)
      await updateDocumentCognifyStatus(args.documentId, 'failed', errStr.slice(0, 500))
      return false
    }
  }
  return false
}

/**
 * Batch cognify — process multiple documents in a single cognify call.
 * This is the scalability path: instead of 1 cognify per document (expensive),
 * we batch up to COGNEE_BATCH_SIZE documents into one cognify pipeline run.
 * Only processes documents with cognifyStatus != 'completed'.
 */
export async function cognifyBatch(args: {
  documents: Array<{
    documentId: string
    documentName: string
    chunks: Array<{ content: string; chunkIndex: number }>
  }>
}): Promise<{ processed: number; failed: number; skipped: number }> {
  if (!(await isCogneeEnabled())) return { processed: 0, failed: 0, skipped: 0 }
  const c = await getCogneeClient()
  if (!c) return { processed: 0, failed: 0, skipped: 0 }

  const settings = await getCogneeSettings()
  const dataset = kbDatasetFor()
  const batchSize = cogneeBatchSize(settings)
  const maxRetries = cognifyMaxRetries(settings)

  // Filter out already-completed documents (incremental processing)
  const docIds = args.documents.map((d) => d.documentId)
  const completed = await db.document.findMany({
    where: { id: { in: docIds }, cognifyStatus: 'completed' },
    select: { id: true },
  }).catch(() => [])
  const completedSet = new Set(completed.map((d) => d.id))

  const pending = args.documents.filter((d) => !completedSet.has(d.documentId))
  if (pending.length === 0) {
    return { processed: 0, failed: 0, skipped: args.documents.length }
  }

  let processed = 0
  let failed = 0

  // Process in batches
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize)
    const texts = batch.map((doc) => ({
      type: 'text' as const,
      text: doc.chunks
        .slice()
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
        .map((chunk) => chunk.content)
        .join('\n\n'),
    }))

    // Mark all as processing
    await Promise.all(
      batch.map((doc) =>
        updateDocumentCognifyStatus(doc.documentId, 'processing', undefined),
      ),
    )

    // Add batch to dataset
    try {
      await c.add(texts, dataset)
    } catch (err) {
      console.warn('[cognee] batch add failed:', err)
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'failed', String(err).slice(0, 500)),
        ),
      )
      failed += batch.length
      continue
    }

    // Cognify with retry
    let batchSuccess = false
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await c.cognify(dataset)
        batchSuccess = true
        break
      } catch (err) {
        const errStr = String(err)
        const isTransient = errStr.includes('FOREIGN KEY') || errStr.includes('constraint') || errStr.includes('locked')
        if (attempt < maxRetries && isTransient) {
          console.warn(`[cognee] batch cognify attempt ${attempt}/${maxRetries} failed (transient), retrying...`)
          await sleep(1000 * attempt)
          continue
        }
        console.warn(`[cognee] batch cognify failed after ${attempt} attempts:`, err)
        break
      }
    }

    if (batchSuccess) {
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'completed', undefined),
        ),
      )
      processed += batch.length
    } else {
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'failed', 'batch cognify failed'),
        ),
      )
      failed += batch.length
    }
  }

  return { processed, failed, skipped: completedSet.size }
}

/**
 * Auto-cognify all ready + enabled documents that haven't been cognified yet.
 * Used by the cognee settings route when cognee is newly enabled.
 */
export async function autoCognifyAll(): Promise<{ processed: number; failed: number; skipped: number }> {
  const docs = await db.document.findMany({
    where: {
      status: 'ready',
      isEnabled: true,
      OR: [
        { cognifyStatus: null },
        { cognifyStatus: { not: 'completed' } },
      ],
    },
    include: {
      chunks: { select: { content: true, chunkIndex: true }, orderBy: { chunkIndex: 'asc' } },
    },
  })
  if (docs.length === 0) return { processed: 0, failed: 0, skipped: 0 }
  return cognifyBatch({
    documents: docs.map((doc) => ({
      documentId: doc.id,
      documentName: doc.name,
      chunks: doc.chunks.map((c) => ({ content: c.content, chunkIndex: c.chunkIndex })),
    })),
  })
}

/**
 * Recall knowledge graph — graph-grounded retrieval for RAG outer ring.
 * Returns entity summaries + relationship context for multi-hop reasoning.
 */
export async function recallKnowledgeGraph(args: {
  query: string
  topK?: number
}): Promise<string> {
  if (!(await isCogneeEnabled())) return ''
  const c = await getCogneeClient()
  if (!c) return ''

  // ponytail: graceful degradation — falls back to empty string when cognee graph search fails
  const topK = args.topK ?? 5
  const strategies = [
    { searchType: 'SUMMARIES', topK },
    { searchType: 'CHUNKS', topK },
    { searchType: 'GRAPH_ENTITIES', topK: topK * 2 },
    { searchType: 'GRAPH_RELATIONSHIPS', topK: topK * 2 },
  ]

  const results: string[] = []
  for (const strategy of strategies) {
    try {
      const result = await c.search(args.query, {
        datasets: [kbDatasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: getCogneeOwnerId(),
      })
      const formatted = formatSearchResponse(result)
      if (formatted) results.push(formatted)
    } catch {
      // try next strategy
    }
  }

  // Deduplicate similar results
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const r of results) {
    const key = r.slice(0, 100)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(r)
    }
  }

  return deduped.join('\n')
}

// ---------------------------------------------------------------------------
// Knowledge graph — recall with structured output for RAG integration
// ---------------------------------------------------------------------------

export async function recallKnowledgeGraphStructured(args: {
  query: string
  topK?: number
}): Promise<GraphSearchResult[]> {
  if (!(await isCogneeEnabled())) return []
  const c = await getCogneeClient()
  if (!c) return []

  const topK = args.topK ?? 5
  const results: GraphSearchResult[] = []

  const strategies: Array<{ searchType: string; topK: number; source: GraphSearchResult['source'] }> = [
    { searchType: 'SUMMARIES', topK, source: 'summary' },
    { searchType: 'CHUNKS', topK, source: 'chunk' },
    { searchType: 'GRAPH_ENTITIES', topK: topK * 2, source: 'entity' },
    { searchType: 'GRAPH_RELATIONSHIPS', topK: topK * 2, source: 'relationship' },
  ]

  for (const strategy of strategies) {
    try {
      const result = await c.search(args.query, {
        datasets: [kbDatasetFor()],
        topK: strategy.topK,
        searchType: strategy.searchType,
        userId: getCogneeOwnerId(),
      })
      const items = extractSearchItems(result)
      for (const item of items) {
        results.push({
          text: item.text,
          source: strategy.source,
          score: item.score,
        })
      }
    } catch {
      // try next strategy
    }
  }

  // Deduplicate by text content
  const seen = new Set<string>()
  return results.filter((r) => {
    const key = r.text.slice(0, 100)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// Forget / reset
// ---------------------------------------------------------------------------

export async function forgetAll(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false
  // ponytail: graceful degradation — returns false when cognee forget fails, does not throw
  try {
    await c.forget({ kind: 'all' })
    // Reset all document cognify statuses
    await db.document.updateMany({
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] forget failed:', err)
    return false
  }
}

export async function forgetKnowledgeGraph(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  const c = await getCogneeClient()
  if (!c) return false
  // ponytail: graceful degradation — returns false when cognee forget fails, does not throw
  try {
    await c.forget({ kind: 'dataset', dataset: { name: kbDatasetFor() } })
    // Reset document cognify statuses for KB dataset
    await db.document.updateMany({
      where: { cognifyStatus: { not: null } },
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] forgetKnowledgeGraph failed:', err)
    return false
  }
}

/** Full reset — deletes .cognee/ state and re-initializes. Admin only. */
export async function resetCognee(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  try {
    // Forget all cognee data
    const c = await getCogneeClient()
    if (c) {
      try { await c.forget({ kind: 'all' }) } catch {}
    }
    // Reset client cache so next call re-initializes
    resetClientCache()
    // Reset all document cognify statuses
    await db.document.updateMany({
      data: { cognifyStatus: null },
    }).catch(() => {})
    return true
  } catch (err) {
    console.warn('[cognee] reset failed:', err)
    return false
  }
}
