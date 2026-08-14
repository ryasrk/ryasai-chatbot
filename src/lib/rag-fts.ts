import { db } from '@/lib/db'
import { getDbProvider } from '@/lib/db-provider'
import { getOrgContext } from '@/lib/prisma-tenant'

// ponytail: lazy check so mock.module('@/lib/db-provider') works in tests.
const isPostgres = () => getDbProvider() === 'postgresql'

// ponytail: DDL (CREATE TABLE / ADD COLUMN / CREATE INDEX) runs once per process —
// the statements are idempotent but a round-trip on every upsert/search was pure waste.
const ftsDdlDone = new Set<string>()

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
  const backend = isPostgres() ? 'postgres' : 'sqlite'
  if (ftsDdlDone.has(backend)) return
  if (isPostgres()) {
    await db.$executeRawUnsafe(`ALTER TABLE "DocumentChunk" ADD COLUMN IF NOT EXISTS tsv tsvector`)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "DocumentChunk_tsv_idx" ON "DocumentChunk" USING GIN(tsv)`)
  } else {
    // ponytail: legacy `companyId UNINDEXED` column removed — it was always ''
    // and is org-unsafe. Searches now join DocumentChunk to filter by org instead.
    await db.$executeRawUnsafe(`
      CREATE VIRTUAL TABLE IF NOT EXISTS DocumentChunkFts
      USING fts5(chunkId UNINDEXED, content, keywords)
    `)
  }
  ftsDdlDone.add(backend)
}

export async function upsertChunkFts(args: {
  chunkId: string
  content: string
  keywords?: string | null
}) {
  await ensureRagFtsTable()
  if (isPostgres()) {
    await db.$executeRawUnsafe(
      `UPDATE "DocumentChunk" SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, '')) WHERE id = $1`,
      args.chunkId,
    )
    return
  }
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts WHERE chunkId = ?', args.chunkId)
  await db.$executeRawUnsafe(
    'INSERT INTO DocumentChunkFts(chunkId, content, keywords) VALUES (?, ?, ?)',
    args.chunkId,
    args.content,
    args.keywords ?? '',
  )
}

export async function rebuildFts(): Promise<{ indexed: number }> {
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
    `)
    // ponytail: refresh corpus-level document frequency for BM25. ts_stat reads
    // from the tsv column (GIN-indexed source of truth) — one grouped query per
    // rebuild instead of per search. Dollar-quoting avoids the nested-escape
    // mess a plain string literal needs. Capped vocabulary guards pathological
    // corpora; ranking falls back to pool-local IDF when this is stale/empty.
    try {
      const stats = await db.$queryRawUnsafe<Array<{ word: string; ndoc: number }>>(
        `SELECT word, ndoc FROM ts_stat($query$
           SELECT tsv FROM "DocumentChunk" c
           JOIN "Document" d ON c."documentId" = d."id"
           WHERE d."status" = 'ready' AND d."isEnabled" = true
         $query$)
         ORDER BY ndoc DESC
         LIMIT 50000`,
      )
      const { CORPUS_DF, CORPUS_N } = await import('@/lib/rag-ranking')
      CORPUS_DF.clear()
      for (const row of stats) CORPUS_DF.set(row.word, Number(row.ndoc))
      CORPUS_N.total = chunks.length
    } catch (e) {
      console.warn('[rag-fts] corpus stats refresh failed (BM25 falls back to pool-local IDF):', e)
    }
    return { indexed: chunks.length }
  }
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts')
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
      const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
        `
          SELECT id AS "chunkId", -ts_rank(tsv, plainto_tsquery('simple', $1)) AS rank
          FROM "DocumentChunk"
          WHERE tsv @@ plainto_tsquery('simple', $1)
            AND "organizationId" = $2
          ORDER BY rank ASC
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
        ORDER BY rank ASC
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
