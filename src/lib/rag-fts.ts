import { db } from '@/lib/db'

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
  await db.$executeRawUnsafe(`
    CREATE VIRTUAL TABLE IF NOT EXISTS DocumentChunkFts
    USING fts5(chunkId UNINDEXED, companyId UNINDEXED, content, keywords)
  `)
}

export async function upsertChunkFts(args: {
  chunkId: string
  companyId: string
  content: string
  keywords?: string | null
}) {
  await ensureRagFtsTable()
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts WHERE chunkId = ?', args.chunkId)
  await db.$executeRawUnsafe(
    'INSERT INTO DocumentChunkFts(chunkId, companyId, content, keywords) VALUES (?, ?, ?, ?)',
    args.chunkId,
    args.companyId,
    args.content,
    args.keywords ?? '',
  )
}

export async function rebuildCompanyFts(companyId: string): Promise<{ indexed: number }> {
  await ensureRagFtsTable()
  await db.$executeRawUnsafe('DELETE FROM DocumentChunkFts WHERE companyId = ?', companyId)
  const chunks = await db.documentChunk.findMany({
    where: { document: { companyId, status: 'ready' } },
    select: {
      id: true,
      content: true,
      keywords: true,
      document: { select: { companyId: true } },
    },
  })
  for (const chunk of chunks) {
    await db.$executeRawUnsafe(
      'INSERT INTO DocumentChunkFts(chunkId, companyId, content, keywords) VALUES (?, ?, ?, ?)',
      chunk.id,
      chunk.document.companyId,
      chunk.content,
      chunk.keywords ?? '',
    )
  }
  return { indexed: chunks.length }
}

export async function searchFtsChunkIds(args: {
  companyId: string
  queryTokens: string[]
  limit: number
}): Promise<string[]> {
  const match = buildFtsMatchQuery(args.queryTokens)
  if (!match) return []
  try {
    await ensureRagFtsTable()
    const rows = await db.$queryRawUnsafe<Array<{ chunkId: string; rank: number }>>(
      `
        SELECT chunkId, bm25(DocumentChunkFts) AS rank
        FROM DocumentChunkFts
        WHERE companyId = ? AND DocumentChunkFts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `,
      args.companyId,
      match,
      args.limit,
    )
    return normalizeFtsRows(rows)
  } catch {
    return []
  }
}
