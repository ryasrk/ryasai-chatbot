/**
 * The vector leg of hybrid retrieval: embed the query, score chunks by cosine similarity through the configured store
 * (an external vector store, or pgvector's HNSW index scoped by organization), and keep that index present. Every
 * failure here degrades to the lexical leg — `rag-retrieval.ts` fuses whatever this returns, including nothing.
 */
import { db } from '@/lib/db'
import { scopedLogger } from '@/lib/logger'
import { getOrgContext } from '@/lib/prisma-tenant'
import { embedTexts, getEmbeddingRuntimeConfig } from '@/lib/embeddings'
import { getVectorStoreRuntimeConfig, searchVectorStore, UnsupportedVectorProviderError } from '@/lib/vector-stores'

const log = scopedLogger('rag')

export async function resolveQueryEmbedding(query: string): Promise<{ vector: number[]; model: string } | null> {
  try {
    const config = await getEmbeddingRuntimeConfig()
    if (!config) return null
    const [embedding] = await embedTexts(config, [query])
    return embedding ? { vector: embedding, model: config.model } : null
  } catch (e) {
    log.warn('resolveQueryEmbedding failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

/**
 * Minimum rows a vector leg must return before we accept it as complete.
 *
 * HNSW applies the org filter AFTER its approximate scan, so a query for N
 * neighbours returns far fewer than N when the org is a minority of the shared
 * table — the scan never enters the org's region and the filter discards what
 * it did find. Measured (trial/92, 20k vectors across 100 orgs, each 1% of the
 * table, asking for 80): the DEFAULT hnsw.ef_search of 40 returned **0 rows**;
 * ef_search=1000, the maximum, returned 5. pgvector documents the shape of this
 * ("filtering is applied after the index is scanned… only 4 rows will match on
 * average" at 10% selectivity) and requires hnsw.iterative_scan — added in
 * 0.8.0 — to keep scanning until enough rows survive the filter. 0.6.0 has no
 * such option.
 *
 * Without this check the failure was invisible: `pgScores.size > 0` counted as
 * success, so a partial (or empty) vector leg silently won and the external
 * vector store — which is exact — was never tried. Fusion then treated the
 * survivors as the whole candidate set.
 *
 * So an under-filled vector leg is a FAILURE, not a result.
 */
const MIN_VECTOR_LEG_ROWS = 8

export async function resolveVectorScores(args: { vector: number[] | null; topK: number }): Promise<Map<string, number>> {
  if (!args.vector) return new Map()

  const wanted = Math.max(args.topK * 8, 16)
  let pgScores = new Map<string, number>()
  try {
    // Fire-and-forget: never make a user query wait on an index build.
    void ensureVectorIndexes()
    pgScores = await pgvectorSimilaritySearch(args.vector, wanted)
    if (pgScores.size >= Math.min(wanted, MIN_VECTOR_LEG_ROWS)) return pgScores
    if (pgScores.size > 0) {
      // Partial. Prefer a complete answer from the external store when one is
      // configured; keep these rows as a floor when it is not.
      log.warn('pgvector returned fewer rows than requested (HNSW filter truncation)', {
        requested: wanted,
        received: pgScores.size,
      })
    }
  } catch (e) {
    // WARN, not debug. At the default LOG_LEVEL=info a `debug` here is invisible, and
    // this is the one path where retrieval silently loses half its inputs: the leg comes
    // back empty, fusion proceeds with BM25 alone, and every downstream signal (answers,
    // citations, similarity scores) still looks healthy. MEASURED cost of this being
    // invisible: a dimension mismatch and an SSRF-blocked embedder each took hours to
    // find, and both presented as "retrieval works, it just isn't very good".
    log.warn('pgvector search unavailable, trying external vector store', { error: e instanceof Error ? e.message : String(e) })
  }

  try {
    const config = await getVectorStoreRuntimeConfig()
    if (!config) return pgScores
    const hits = await searchVectorStore({ config, vector: args.vector, limit: wanted })
    if (hits.length === 0) return pgScores
    return new Map(hits.map((hit) => [hit.chunkId, hit.score]))
  } catch (e) {
    // A MISCONFIGURED PROVIDER MUST NOT DEGRADE INTO "NO RESULTS". Every other failure here is legitimately
    // absorbed: an unreachable store should fall back to pgvector rather than fail the whole search, because
    // pgvector results are still real. An UNSUPPORTED provider is different in kind -- it is a configuration
    // error that no retry will fix, and swallowing it made the two look identical: zero hits, HTTP 200, and a
    // model that answers as if the corpus were empty. Propagated so the caller can name the provider.
    if (e instanceof UnsupportedVectorProviderError) throw e
    log.warn('resolveVectorScores failed', { error: e instanceof Error ? e.message : String(e) })
    return pgScores
  }
}

/**
 * Does this Postgres have hnsw.iterative_scan (pgvector 0.8.0+)?
 *
 * `null` = not probed yet. Probed once per process: the answer cannot change
 * without a server restart, and the probe costs a round trip per query if
 * repeated. When true we get a real fix for HNSW filter truncation; when false
 * we fall back to the largest ef_search the server accepts.
 */
let _iterativeScanSupported: boolean | null = null

async function hasIterativeScan(): Promise<boolean> {
  if (_iterativeScanSupported !== null) return _iterativeScanSupported
  try {
    /*
     * `current_setting(name, true)` — the SECOND ARGUMENT is the fix, not a nicety.
     *
     * `SHOW hnsw.iterative_scan` on a build without that GUC (pgvector < 0.8.0, which is what this install has)
     * raises 42704. The catch below handled it, so the FUNCTION was correct — but Postgres still reported the error
     * to the driver, and Prisma logs every server error it sees at `prisma:error` level. MEASURED effect on this
     * install: `Raw query failed. Code: 42704. unrecognized configuration parameter "hnsw.iterative_scan"` printed
     * once per process, and it appeared in the retrieval log path — which cost real time during this investigation,
     * because it reads as "the vector search just failed" when in fact the vector search returned a FULL result set
     * (96 of 96) on every query measured. That is the worst kind of noise: a message that describes a failure which
     * is not happening, on the path where a real failure would matter most.
     *
     * `missing_ok = true` returns NULL for an unknown parameter instead of raising, so the probe answers the same
     * question with no server error and nothing to log.
     */
    const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT current_setting('hnsw.iterative_scan', true) AS v`)
    const value = rows[0]?.v
    _iterativeScanSupported = typeof value === 'string' && value.length > 0
  } catch {
    // A driver/permission failure is a different thing from "unsupported": still answer false (the safe branch).
    _iterativeScanSupported = false
  }
  return _iterativeScanSupported
}

/** Test seam — resets the cached capability probe. */
export function _resetIterativeScanProbe(): void {
  _iterativeScanSupported = null
}

/**
 * Test seam — forgets the memoised index build.
 *
 * `retrieveRelevantChunks` fires `void ensureVectorIndexes()` on its vector path,
 * so by the time a later test calls the function the memo is populated and it
 * returns the cached promise WITHOUT issuing DDL. A test that wants to observe the
 * DDL has to clear the memo first; otherwise the assertion silently measures the
 * memo instead of the statement.
 */
export function _resetVectorIndexBuild(): void {
  _vectorIndexBuild = null
}

async function pgvectorSimilaritySearch(queryVector: number[], limit: number): Promise<Map<string, number>> {
  const vectorStr = `[${queryVector.join(',')}]`
  const orgId = getOrgContext()

  // HNSW filters AFTER the approximate scan, so `ef_search` (default 40) must
  // exceed `limit` for the org's rows to survive. On pgvector >= 0.8.0
  // iterative_scan does this properly — keep scanning until the filter yields
  // enough rows. On 0.6.x the only lever is ef_search, capped at 1000 by the
  // server (a larger value is rejected with 22023), so we ask for as much as
  // the server allows and let resolveVectorScores treat a short result as a
  // failure rather than a success.
  const iterative = await hasIterativeScan()
  const efSearch = Math.min(Math.max(limit * 4, 100), 1000)
  const setLocal = iterative
    ? `SET LOCAL hnsw.iterative_scan = relaxed_order; SET LOCAL hnsw.ef_search = ${efSearch};`
    : `SET LOCAL hnsw.ef_search = ${efSearch};`

  try {
    // SET LOCAL only applies inside a transaction, so the two must share one.
    return await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(setLocal)
      // Org-scoped (prevents cross-tenant ranking interference) + HNSW index
      // makes the ORDER BY embedding <=> a bounded ANNS scan, not full-corpus O(n).
      const rows = await tx.$queryRaw<Array<{ id: string; similarity: number }>>`
        SELECT id, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
        FROM "DocumentChunk"
        WHERE embedding IS NOT NULL
          AND "organizationId" = ${orgId ?? ''}
          AND "documentId" IN (
            SELECT id FROM "Document" WHERE status = 'ready' AND "isEnabled" = true
          )
        ORDER BY embedding <=> ${vectorStr}::vector
        LIMIT ${limit}
      `
      return new Map(rows.map((row) => [row.id, row.similarity]))
    })
  } catch (e) {
    // A rejected SET LOCAL (older/newer GUC name) must not lose the query.
    log.debug('pgvector ef_search transaction failed, retrying with plain query', {
      error: e instanceof Error ? e.message : String(e),
    })
    const rows = await db.$queryRaw<Array<{ id: string; similarity: number }>>`
      SELECT id, 1 - (embedding <=> ${vectorStr}::vector) AS similarity
      FROM "DocumentChunk"
      WHERE embedding IS NOT NULL
        AND "organizationId" = ${orgId ?? ''}
        AND "documentId" IN (
          SELECT id FROM "Document" WHERE status = 'ready' AND "isEnabled" = true
        )
      ORDER BY embedding <=> ${vectorStr}::vector
      LIMIT ${limit}
    `
    return new Map(rows.map((row) => [row.id, row.similarity]))
  }
}

/**
 * Build the HNSW index on DocumentChunk.embedding, once per process.
 *
 * CONCURRENTLY matters: plain CREATE INDEX takes an ACCESS EXCLUSIVE lock on
 * DocumentChunk, so on a populated table the first search after every restart
 * froze all reads AND writes — uploads included — until the build finished.
 *
 * The index is table-wide, not per-org; the old per-org memo just made N orgs
 * each re-issue the same statement.
 *
 * Returns the in-flight build so callers CAN await it (rebuild jobs), but the
 * search path deliberately does not — a missing index means a slower scan, which
 * is a far better failure mode than a blocked query.
 */
let _vectorIndexBuild: Promise<void> | null = null

export function ensureVectorIndexes(): Promise<void> {
  if (_vectorIndexBuild) return _vectorIndexBuild
  _vectorIndexBuild = db
    .$executeRawUnsafe(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "DocumentChunk_embedding_hnsw"
      ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `)
    .then(() => undefined)
    .catch((e: unknown) => {
      // Non-fatal — vector search degrades to a sequential scan. Deliberately NOT
      // retried with a plain (blocking) CREATE INDEX: that is the failure mode
      // this function exists to avoid. Two known causes, both operator-fixable:
      //   - the driver ran it inside a transaction block (CONCURRENTLY forbids it)
      //   - a previous CONCURRENTLY build left an INVALID index needing DROP first
      _vectorIndexBuild = null
      log.warn(
        'ensureVectorIndexes failed — vector search will sequential-scan. ' +
          'Create it once by hand during a maintenance window:\n' +
          '  CREATE INDEX CONCURRENTLY IF NOT EXISTS "DocumentChunk_embedding_hnsw"\n' +
          '  ON "DocumentChunk" USING hnsw (embedding vector_cosine_ops)\n' +
          '  WITH (m = 16, ef_construction = 64);',
        { error: e instanceof Error ? e.message : String(e) },
      )
    })
  return _vectorIndexBuild
}
