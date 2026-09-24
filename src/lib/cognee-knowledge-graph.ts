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
  getCogneeGraphProvider,
  supportsNaturalLanguageSearch,
  getCogneeServerOptions,
} from './cognee-core'
import { cogneeRemember, cogneeRecall, cogneeForget, cogneeCognify } from './cognee-http'
import { db } from '@/lib/db'
import { logSwallowed } from '@/lib/logger'

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

  const settings = await getCogneeSettings()
  const dataset = kbDatasetFor()
  const text = args.chunks
    .slice()
    .sort((a, b) => a.chunkIndex - b.chunkIndex)
    .map((chunk) => chunk.content)
    .join('\n\n')

  // Server backend: `remember` both stores AND cognifies in one call, so there is
  // no separate add→cognify handshake. This is simpler than the SDK path below,
  // where the two steps can fail independently and leave data added-but-not-graphed.
  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    try {
      await updateDocumentCognifyStatus(args.documentId, 'processing', undefined)
      const res = await cogneeRemember(serverOpts, {
        texts: [text],
        datasetName: dataset,
        runInBackground: false,
      })
      if (res && !res.error) {
        await updateDocumentCognifyStatus(args.documentId, 'completed', undefined)
        return true
      }
      await updateDocumentCognifyStatus(args.documentId, 'failed', res?.error ?? 'cognee server rejected the write')
      return false
    } catch (err) {
      console.warn('[cognee] server cognify failed for document:', args.documentId, err)
      await updateDocumentCognifyStatus(args.documentId, 'failed', String(err))
      return false
    }
  }

  // There is no in-process client (see getCogneeClient): with no COGNEE_SERVER_URL
  // there is nothing to cognify through. Report it rather than pretending otherwise —
  // a silent success here is exactly what left documents at "ready" with 0 vectors.
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
  const serverOpts = await getCogneeServerOptions()
  // The server is the ONLY transport (see getCogneeClient): no server URL means
  // memory is off, not that another backend should be tried.
  if (!serverOpts) return { processed: 0, failed: 0, skipped: 0 }

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

    // Store + cognify, with retry.
    //
    // ONE transport now: the server's `remember` stores and cognifies in a single
    // call. The SDK branch (`add` then `cognify`) was removed with the bindings —
    // keeping it would have meant two code paths where only one can ever run.
    let batchSuccess = false
    let lastError: unknown = null
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await cogneeRemember(serverOpts, {
          texts: texts.map((t) => t.text),
          datasetName: dataset,
          runInBackground: false,
        })
        if (!res || res.error) throw new Error(res?.error ?? 'cognee server rejected the write')
        batchSuccess = true
        break
      } catch (err) {
        lastError = err
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
    if (!batchSuccess) {
      await Promise.all(
        batch.map((doc) =>
          updateDocumentCognifyStatus(doc.documentId, 'failed', String(lastError).slice(0, 500)),
        ),
      )
      failed += batch.length
      continue
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
/**
 * A `false` from `datasets.has()` is NOT proof the dataset is absent.
 *
 * MEASURED on @cognee/cognee-ts 0.1.3: `has('org:<id>')` returned false for a dataset
 * that `datasets.list()` listed and whose stored fact a raw `search()` returned. Chat
 * memory and document recall both used to `return ''` on that false, so a healthy org's
 * memory and knowledge graph were silently unreachable — nothing threw, nothing logged,
 * the bot simply claimed it had never been told. Both call sites now only warn.
 */
function warnUnreliableHas(dataset: string): void {
  console.warn(
    '[cognee] datasets.has() reported a dataset as missing, but the search will still run ' +
      '(has() is unreliable in cognee-ts 0.1.3). dataset=' + dataset,
  )
}

export async function recallKnowledgeGraph(args: {
  query: string
  topK?: number
}): Promise<string> {
  if (!(await isCogneeEnabled())) return ''

  const topK = args.topK ?? 5

  // Server backend: one HTTP call per strategy, same CHUNKS/SUMMARIES reasoning as
  // chat memory (HYBRID_COMPLETION returns one synthesized answer, not the items).
  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    const results: string[] = []
    for (const strategy of [
      { searchType: 'SUMMARIES', topK },
      { searchType: 'CHUNKS', topK },
    ]) {
      try {
        const hits = await cogneeRecall(serverOpts, {
          query: args.query,
          datasets: [kbDatasetFor()],
          searchType: strategy.searchType,
          topK: strategy.topK,
        })
        const text = (hits ?? []).map((h) => h.text ?? '').filter(Boolean).join('\n')
        if (text) results.push(text)
      } catch (e) {
        console.warn('[cognee] knowledge-graph server recall failed:', e instanceof Error ? e.message : String(e))
      }
    }
    return dedupeByPrefix(results).join('\n')
  }

  // No in-process client (see getCogneeClient): without COGNEE_SERVER_URL there
  // is no recall path, and the server branch above already returned.
  return ''
}

/** Drop results that repeat an already-seen prefix — strategies overlap heavily. */
function dedupeByPrefix(results: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const r of results) {
    const key = r.slice(0, 100)
    if (!seen.has(key)) {
      seen.add(key)
      deduped.push(r)
    }
  }
  return deduped
}

// ---------------------------------------------------------------------------
// Knowledge graph — recall with structured output for RAG integration
// ---------------------------------------------------------------------------

export async function recallKnowledgeGraphStructured(args: {
  query: string
  topK?: number
}): Promise<GraphSearchResult[]> {
  if (!(await isCogneeEnabled())) return []

  const topK = args.topK ?? 5

  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    const results: GraphSearchResult[] = []
    const strategies: Array<{ searchType: string; source: GraphSearchResult['source'] }> = [
      { searchType: 'SUMMARIES', source: 'summary' },
      { searchType: 'CHUNKS', source: 'chunk' },
    ]
    for (const strategy of strategies) {
      try {
        const hits = await cogneeRecall(serverOpts, {
          query: args.query,
          datasets: [kbDatasetFor()],
          searchType: strategy.searchType,
          topK,
        })
        for (const hit of hits ?? []) {
          if (hit.text) {
            results.push({
              text: hit.text,
              source: strategy.source,
              score: hit.score ?? undefined,
            })
          }
        }
      } catch {
        // try next strategy
      }
    }
    return dedupeByText(results)
  }

  if (!serverOpts) return []

  // The `datasets.has()` guard is gone with the SDK, and NOTHING is lost: it was
  // already advisory-only because it lied (returned false for a dataset that listed
  // and searched fine), so it could never have switched recall off. The server
  // branch above returns before this line.

  // No SDK search path exists any more (see getCogneeClient). The server branch
  // above already returned its results, so there is nothing left to try.
  return []
}

/** Deduplicate by text content — strategies intentionally overlap. */
function dedupeByText(results: GraphSearchResult[]): GraphSearchResult[] {
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

  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    // ponytail: graceful degradation — returns false when cognee forget fails, does not throw
    try {
      const ok = await cogneeForget(serverOpts, { everything: true })
      if (!ok) return false
      await db.document.updateMany({
        data: { cognifyStatus: null },
      }).catch(logSwallowed('cognee: document.updateMany (forgetAll)'))
      return true
    } catch (err) {
      console.warn('[cognee] forget failed:', err)
      return false
    }
  }

  // No server means nothing cognee owns was forgotten HERE, so the document statuses
  // must NOT be cleared: reporting "true" after a no-op wipe is the failure mode this
  // whole area exists to avoid — a caller would believe memory was erased when it was
  // still on disk. The server branch above does the real work and resets the statuses.
  return false
}

export async function forgetKnowledgeGraph(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false

  const serverOpts = await getCogneeServerOptions()
  if (serverOpts) {
    // ponytail: graceful degradation — returns false when cognee forget fails, does not throw
    try {
      const ok = await cogneeForget(serverOpts, { dataset: kbDatasetFor() })
      if (!ok) return false
      await db.document.updateMany({
        where: { cognifyStatus: { not: null } },
        data: { cognifyStatus: null },
      }).catch(logSwallowed('cognee: document.updateMany (forgetKnowledgeGraph)'))
      return true
    } catch (err) {
      console.warn('[cognee] forgetKnowledgeGraph failed:', err)
      return false
    }
  }

  // Same rule as forgetAll: no server, no wipe, no status reset, and `false` rather
  // than a success the caller cannot verify.
  return false
}

/**
 * Full reset — forgets everything and resets local state. Admin only.
 *
 * On the server backend the local store does NOT belong to this process, so there
 * is nothing to delete on disk: `forget({everything:true})` is the reset. The
 * in-process path (and its client cache) is gone with the SDK.
 */
export async function resetCognee(): Promise<boolean> {
  if (!(await isCogneeEnabled())) return false
  try {
    const serverOpts = await getCogneeServerOptions()
    if (serverOpts) {
      try {
        await cogneeForget(serverOpts, { everything: true })
      } catch {}
      await db.document.updateMany({
        data: { cognifyStatus: null },
      }).catch(logSwallowed('cognee: document.updateMany (resetCognee)'))
      return true
    }

    // No SDK client to forget through; the server path above handled it.
    // Reset client cache so next call re-initializes
    resetClientCache()
    // Reset all document cognify statuses
    await db.document.updateMany({
      data: { cognifyStatus: null },
    }).catch(logSwallowed('cognee: document.updateMany (resetCognee)'))
    return true
  } catch (err) {
    console.warn('[cognee] reset failed:', err)
    return false
  }
}
