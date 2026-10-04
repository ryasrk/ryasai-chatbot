import { db } from '@/lib/db'
import { getDbProvider } from '@/lib/db-provider'
import { getOrgContext } from '@/lib/prisma-tenant'

// ponytail: lazy check so mock.module('@/lib/db-provider') works in tests.
const isPostgres = () => getDbProvider() === 'postgresql'

let sqliteFtsReady = false
let sqliteFtsPending: Promise<void> | undefined

export function buildFtsMatchQuery(tokens: string[]): string {
  return tokens
    .map((token) => token.replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .filter(Boolean)
    .slice(0, 12)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ')
}

export function normalizeFtsRows(rows: Array<{ chunkId: string; rank: number }>): string[] {
  return [...rows]
    .sort((a, b) => a.rank - b.rank)
    .map((row) => row.chunkId)
    .filter(Boolean)
}

export async function ensureRagFtsTable() {
  // PostgreSQL migrations and Prisma schema push own tsv and its GIN index.
  // Runtime ALTER TABLE acquires an exclusive lock and can deadlock with HNSW creation.
  if (isPostgres() || sqliteFtsReady) return
  // ponytail: legacy `companyId UNINDEXED` column removed — it was always ''
  // and is org-unsafe. Searches join DocumentChunk to filter by org instead.
  sqliteFtsPending ??= db.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS DocumentChunkFts
    USING fts5(chunkId UNINDEXED, content, keywords)
  `).then(() => {
    sqliteFtsReady = true
  }).finally(() => {
    sqliteFtsPending = undefined
  })
  await sqliteFtsPending
}

export async function upsertChunkFts(args: {
  chunkId: string
  content: string
  keywords?: string | null
}) {
  const orgId = getOrgContext()
  if (!orgId) throw new Error('FTS upsert requires an organization context')
  await ensureRagFtsTable()
  if (isPostgres()) {
    await db.$executeRawUnsafe(
      `UPDATE "DocumentChunk" SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, '')) WHERE id = $1 AND "organizationId" = $2`,
      args.chunkId,
      orgId,
    )
    return
  }
  await db.$executeRawUnsafe(
    'DELETE FROM DocumentChunkFts WHERE chunkId = ? AND chunkId IN (SELECT id FROM DocumentChunk WHERE organizationId = ?)',
    args.chunkId,
    orgId,
  )
  await db.$executeRawUnsafe(
    'INSERT INTO DocumentChunkFts(chunkId, content, keywords) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM DocumentChunk WHERE id = ? AND organizationId = ?)',
    args.chunkId,
    args.content,
    args.keywords ?? '',
    args.chunkId,
    orgId,
  )
}

export async function rebuildFts(): Promise<{ indexed: number }> {
  const orgId = getOrgContext()
  if (!orgId) throw new Error('FTS rebuild requires an organization context')
  await ensureRagFtsTable()
  const chunks = await db.documentChunk.findMany({
    where: { document: { status: 'ready', isEnabled: true } },
    select: { id: true, content: true, keywords: true },
  })
  if (isPostgres()) {
    await db.$executeRawUnsafe(`
      UPDATE "DocumentChunk"
      SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, ''))
      FROM "Document" d
      WHERE "DocumentChunk"."documentId" = d."id" AND d."status" = 'ready' AND d."isEnabled" = true
        AND "DocumentChunk"."organizationId" = $1
    `, orgId)
    // ponytail: refresh corpus-level document frequency for BM25. ts_stat reads
    // from the tsv column (GIN-indexed source of truth) — one grouped query per
    // rebuild instead of per search. Dollar-quoting avoids the nested-escape
    // mess a plain string literal needs. Capped vocabulary guards pathological
    // corpora; ranking falls back to pool-local IDF when this is stale/empty.
    try {
      const stats = await db.$queryRawUnsafe<Array<{ word: string; ndoc: number }>>(
        `SELECT word, ndoc FROM ts_stat(format($query$
           SELECT tsv FROM "DocumentChunk" c
           JOIN "Document" d ON c."documentId" = d."id"
           WHERE d."status" = 'ready' AND d."isEnabled" = true
             AND c."organizationId" = %L
         $query$, $1::text))
         ORDER BY ndoc DESC, word ASC
         LIMIT 50000`,
        orgId,
      )
      const { getCorpusStats } = await import('@/lib/rag-ranking')
      const { df: CORPUS_DF, n: CORPUS_N } = getCorpusStats()
      CORPUS_DF.clear()
      for (const row of stats) CORPUS_DF.set(row.word, Number(row.ndoc))
      CORPUS_N.total = chunks.length
    } catch (e) {
      console.warn('[rag-fts] corpus stats refresh failed (BM25 falls back to pool-local IDF):', e)
    }
    return { indexed: chunks.length }
  }
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts WHERE chunkId IN (SELECT id FROM DocumentChunk WHERE organizationId = ?)', orgId)
  for (const chunk of chunks) {
    await db.$executeRawUnsafe(
      'INSERT INTO DocumentChunkFts(chunkId, content, keywords) VALUES (?, ?, ?)',
      chunk.id,
      chunk.content,
      chunk.keywords ?? '',
    )
  }
  return { indexed: chunks.length }
}

export async function searchFtsChunkIds(args: {
  queryTokens: string[]
  limit: number
}): Promise<string[]> {
  // Raw SQL bypasses the Prisma tenant extension — never query across orgs. If
  // there's no org context (worker, tests) return [] rather than leak other orgs' rows.
  const orgId = getOrgContext()
  if (!orgId) return []

  if (isPostgres()) {
    const query = args.queryTokens.join(' ').trim()
    if (!query) return []
    try {
      await ensureRagFtsTable()
      // `rank` ties are common (equal ts_rank for repeated terms), and SQL gives no defined
      // order among them, so the same query could return ties in a different order run to run
      // and the fused result would drift. The id tie-break makes the order total and stable.
      const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
        `
          SELECT id AS "chunkId", -ts_rank(tsv, plainto_tsquery('simple', $1)) AS rank
          FROM "DocumentChunk"
          WHERE tsv @@ plainto_tsquery('simple', $1)
            AND "organizationId" = $2
          ORDER BY rank ASC, id ASC
          LIMIT $3
        `,
        query,
        orgId,
        args.limit,
      )
      return normalizeFtsRows(rows)
    } catch (e) {
      console.warn('[rag-fts] searchFtsChunkIds failed:', e)
      return []
    }
  }
  const match = buildFtsMatchQuery(args.queryTokens)
  if (!match) return []
  try {
    await ensureRagFtsTable()
    // FTS virtual table has no org column — join back to DocumentChunk to scope by org.
    const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
      `
        SELECT f.chunkId, bm25(DocumentChunkFts) AS rank
        FROM DocumentChunkFts f
        JOIN DocumentChunk c ON c.id = f.chunkId
        WHERE DocumentChunkFts MATCH ? AND c."organizationId" = ?
        ORDER BY rank ASC, f.chunkId ASC
        LIMIT ?
      `,
      match,
      orgId,
      args.limit,
    )
    return normalizeFtsRows(rows)
  } catch (e) {
    console.warn('[rag-fts] searchFtsChunkIds failed:', e)
    return []
  }
}
