/**
 * UAT fixture: a local OpenAI-compatible EMBEDDING service.
 *
 * Why this is needed at all: the chat gateway offers no /embeddings endpoint, so
 * `embeddingBaseUrl` fell back to it and every RAG path failed on "Base URL points
 * to a blocked internal host" -- the request never even reached a vector store.
 * Without an embedding service the vector-knowledge UAT cannot run.
 *
 * The vectors are DETERMINISTIC hashed bag-of-words, not a neural model, and that
 * is a deliberate choice for a UAT rather than a shortcut:
 *   - A deterministic function makes retrieval REPRODUCIBLE: the same question
 *     always retrieves the same chunks, so a failure is about the pipeline, not
 *     about a model's mood.
 *   - It is genuinely semantic enough to be meaningful: tokens are hashed into
 *     1536 buckets with sublinear term weighting and L2-normalised, so documents
 *     sharing vocabulary land close together under cosine distance.
 *   - It is NOT a semantic model, and results must not be read as measuring
 *     embedding QUALITY. It measures whether upload -> chunk -> embed -> store ->
 *     retrieve -> prompt -> answer works end to end, which is the UAT's job.
 *
 * 1536 dimensions because the schema hardcodes vector(1536) and
 * `validateEmbeddingResponse` rejects any other width.
 */
export const PORT = Number(process.env.UAT_EMBED_PORT ?? 4502)
export const DIM = 1536

function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  const tokens = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  for (const t of tokens) {
    // Two hashes per token reduce collisions between unrelated terms.
    const a = hash32(t) % DIM
    const b = hash32(t + '#2') % DIM
    v[a] += 1
    v[b] += 0.5
  }
  // Sublinear scaling keeps a repeated word from dominating a whole vector.
  for (let i = 0; i < DIM; i++) if (v[i] > 0) v[i] = 1 + Math.log(v[i])
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / norm)
}

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'uat-embedding-fixture', dim: DIM })
    }
    if (!url.pathname.endsWith('/embeddings')) {
      return Response.json({ error: 'not found', path: url.pathname }, { status: 404 })
    }
    const body = (await req.json().catch(() => ({}))) as { input?: unknown; model?: string }
    // OpenAI accepts a string OR an array; the app sends an array, and returning one
    // vector for an array input is exactly the misalignment the app refuses.
    const inputs = Array.isArray(body.input) ? body.input.map(String) : [String(body.input ?? '')]
    const data = inputs.map((text, index) => ({ object: 'embedding', index, embedding: embed(text) }))
    return Response.json({
      object: 'list',
      data,
      model: body.model ?? 'uat-deterministic-1536',
      usage: { prompt_tokens: inputs.join(' ').split(/\s+/).length, total_tokens: inputs.join(' ').split(/\s+/).length },
    })
  },
})

console.log(`UAT embedding fixture listening on http://0.0.0.0:${PORT} (dim=${DIM})`)
