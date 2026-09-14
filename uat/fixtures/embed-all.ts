/**
 * Embed every ready document chunk by calling the UAT EMBEDDING SERVICE directly
 * and writing the vectors with SQL.
 *
 * This replaces an earlier version that imported the app's `embedCompanyDocuments()`
 * and crashed Bun with a core dump: loading the full application module graph
 * outside the Next.js server is not supported here. The honest consequence is that
 * THIS SCRIPT does not exercise the app's embedding client -- only the fixture and
 * the database column do. The app's own embedding path is still exercised, later,
 * by the UAT question that must retrieve an indexed document.
 *
 * What it does verify: the chunks exist, the service returns one correctly-sized
 * vector per input (a mismatch is rejected loudly rather than written), and the
 * pgvector column accepts them.
 */
import { readFileSync } from 'node:fs'

const env = readFileSync('.env', 'utf8')
const url = env.match(/^DATABASE_URL=(.*)$/m)![1].trim().replace(/^["']|["']$/g, '')
const EMB = process.env.UAT_EMBED_URL ?? 'http://127.0.0.1:4502/v1/embeddings'
const DIM_EXPECTED = 1536

const { SQL } = await import('bun')
const pg = new SQL(url)

const chunks = (await pg.unsafe(
  `SELECT id, content FROM "DocumentChunk" WHERE content IS NOT NULL AND length(content) > 0 ORDER BY "createdAt"`,
)) as Array<{ id: string; content: string }>
console.log(`EMBED-ALL chunks to embed: ${chunks.length}`)
if (!chunks.length) { await pg.end(); process.exit(0) }

// Batch so a single request does not carry hundreds of long inputs.
const BATCH = 16
let written = 0
for (let i = 0; i < chunks.length; i += BATCH) {
  const slice = chunks.slice(i, i + BATCH)
  const res = await fetch(EMB, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'uat-deterministic-1536', input: slice.map((c) => c.content.slice(0, 4000)) }),
  })
  if (!res.ok) throw new Error(`embedding service HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const payload = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> }
  if (payload.data.length !== slice.length) {
    // The app refuses a misaligned batch; so does this, for the same reason.
    throw new Error(`misaligned: ${payload.data.length} vectors for ${slice.length} inputs`)
  }
  for (const item of payload.data) {
    const chunk = slice[item.index]
    if (!chunk) throw new Error(`embedding index ${item.index} has no chunk`)
    if (item.embedding.length !== DIM_EXPECTED) {
      throw new Error(`dimension ${item.embedding.length} != ${DIM_EXPECTED}`)
    }
    // pgvector literal form; parameterised so the vector is never string-concatenated
    // from unescaped input.
    await pg.unsafe(`UPDATE "DocumentChunk" SET embedding = $1::vector WHERE id = $2`, [
      `[${item.embedding.join(',')}]`, chunk.id,
    ] as never[])
    written++
  }
}
const check = (await pg.unsafe(
  `SELECT count(*) FILTER (WHERE embedding IS NOT NULL) AS with_emb, count(*) AS total FROM "DocumentChunk"`,
)) as Array<{ with_emb: string; total: string }>
await pg.end()
console.log(`EMBED-ALL written=${written} with_embedding=${check[0].with_emb}/${check[0].total}`)
