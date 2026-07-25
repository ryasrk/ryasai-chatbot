import { db } from '@/lib/db'
import { getDbProvider } from '@/lib/db-provider'

const isPostgres = getDbProvider() === 'postgresql'

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
  if (isPostgres) {
    await db.$executeRawUnsafe(`ALTER TABLE "DocumentChunk" ADD COLUMN IF NOT EXISTS tsv tsvector`)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "DocumentChunk_tsv_idx" ON "DocumentChunk" USING GIN(tsv)`)
    return
  }
  await db.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS DocumentChunkFts
    USING fts5(chunkId UNINDEXED, companyId UNINDEXED, content, keywords)
  `)
}

export async function upsertChunkFts(args: {
  chunkId: string
  content: string
  keywords?: string | null
}) {
  await ensureRagFtsTable()
  if (isPostgres) {
    await db.$executeRawUnsafe(
      `UPDATE "DocumentChunk" SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, '')) WHERE id = $1`,
      args.chunkId,
    )
    return
  }
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts WHERE chunkId = ?', args.chunkId)
  await db.$executeRawUnsafe(
    'INSERT INTO DocumentChunkFts(chunkId, companyId, content, keywords) VALUES (?, ?, ?, ?)',
    args.chunkId,
    '',
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
  if (isPostgres) {
    await db.$executeRawUnsafe(`
      UPDATE "DocumentChunk"
      SET tsv = to_tsvector('simple', content || ' ' || COALESCE(keywords, ''))
      FROM "Document" d
      WHERE "DocumentChunk"."documentId" = d."id" AND d."status" = 'ready' AND d."isEnabled" = true
    `)
    return { indexed: chunks.length }
  }
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts')
  for (const chunk of chunks) {
    await db.$executeRawUnsafe(
      'INSERT INTO DocumentChunkFts(chunkId, companyId, content, keywords) VALUES (?, ?, ?, ?)',
      chunk.id,
      '',
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
  if (isPostgres) {
    const query = args.queryTokens.join(' ').trim()
    if (!query) return []
    try {
      await ensureRagFtsTable()
      const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
        `
          SELECT id AS "chunkId", -ts_rank(tsv, plainto_tsquery('simple', $1)) AS rank
          FROM "DocumentChunk"
          WHERE tsv @@ plainto_tsquery('simple', $1)
          ORDER BY rank ASC
          LIMIT $2
        `,
        query,
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
    const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
      `
        SELECT chunkId, bm25(DocumentChunkFts) AS rank
        FROM DocumentChunkFts
        WHERE DocumentChunkFts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `,
      match,
      args.limit,
    )
    return normalizeFtsRows(rows)
  } catch (e) {
    console.warn('[rag-fts] searchFtsChunkIds failed:', e)
    return []
  }
}
