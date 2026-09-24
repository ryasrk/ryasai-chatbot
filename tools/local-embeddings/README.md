# Local embeddings (no OpenAI key required)

Runs a multilingual sentence-transformers model behind an OpenAI-compatible
`/v1/embeddings` endpoint, so the app can do semantic retrieval without any
hosted embedding provider.

## Quick start

```bash
cd tools/local-embeddings
python3 -m venv .venv
.venv/bin/pip install sentence-transformers fastapi uvicorn
.venv/bin/python server.py            # http://127.0.0.1:8081
```

Then set, in the app environment:

```bash
# The SSRF blocklist refuses loopback/private hosts by default. A SELF-HOSTED
# inference server must be opted in explicitly:
LLM_ALLOWED_HOSTS=127.0.0.1
```

and configure the org's embedding settings (AI Config → Embedding):

| field    | value                                                        |
|----------|--------------------------------------------------------------|
| provider | OpenAI-Compatible                                            |
| base URL | `http://127.0.0.1:8081/v1`                                   |
| model    | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` |
| api key  | *(empty — this server does not authenticate)*                |

## Model choice — measured, not assumed

`paraphrase-multilingual-MiniLM-L12-v2` (384 dims, 50+ languages, ~470 MB).
Cross-lingual cosine on this corpus, L2-normalised:

| Indonesian question | English document | cosine |
|---|---|---|
| Berapa tarif lembur pada hari kerja? | overtime rate on a working day | 0.692 |
| Berapa hari cuti tahunan? | 12 working days of annual leave | 0.621 |
| Berapa lama jangka waktu refund? | refund within 30 days | 0.888 |

Every real ID→EN match sits far above the noise floor: the same questions against an
off-topic probe ("resep kue bolu") score **-0.040 to 0.064**, so the separation is
0.62-0.89 versus ~0.0 — not a marginal margin that a threshold could easily swallow.

> Earlier revisions of this table listed 0.543 / 0.465 / 0.748 with a "0.185 noise floor".
> Re-measured independently against the running server (same model, `normalize_embeddings=True`,
> so the vectors are unit-length and a dot product IS the cosine): the matches are HIGHER and
> the noise is LOWER than recorded. The direction and the conclusion are unchanged, and the
> corrected numbers are the stronger evidence — the old figures were pessimistic, not wrong
> in a way that flattered this design.

**Rejected: `all-MiniLM-L6-v2`.** English-only. On the same pair it scored the
*English translation* of a question **lower** than an unrelated Indonesian
sentence (0.068 vs 0.499, re-measured; the original run recorded 0.100 vs 0.359
and the direction is the same) — it would have made Indonesian retrieval worse
than lexical matching alone. Note both models are 384-dim; the reason to prefer the
multilingual one is language coverage, not size.

## The column dimension must match your model

`DocumentChunk.embedding` is declared `Unsupported("vector(384)")` to match this
model. **If the dimensions disagree, embeddings silently stop contributing to
ranking** — that is the single most important thing on this page.

What actually happens on a mismatch (measured, 384-dim model against a
`vector(1536)` column):

- `embedDocumentChunks` reports `embedded=28` and every document looks indexed.
- `DocumentChunk.embedding` stays **NULL for all rows**; vectors go to
  `embeddingJson` instead, with only a console warning.
- The pgvector leg returns an **empty candidate set**, so RRF fuses BM25 against
  nothing and `semanticSimilarity` is reporting-only.
- Retrieval still shows a healthy-looking similarity score, so nothing *looks*
  broken.

Impact on 5 hard questions (paraphrase / no shared token / unmapped vocabulary):

| setup | hits |
|---|---|
| 384-dim model **+ `vector(384)`** | **3/5** |
| 384-dim model + `vector(1536)` | 0/5 |
| no embeddings at all | 0/5 |

i.e. the mismatch was the entire reason embeddings appeared to add nothing.

### Changing the dimension

The vector type is part of the column type, so a different dimension requires
dropping and re-adding the column. **This discards every stored vector for every
organisation**, and they must all be re-embedded:

```sql
ALTER TABLE "DocumentChunk" DROP COLUMN embedding;
ALTER TABLE "DocumentChunk" ADD COLUMN embedding vector(1536);  -- your dimension
```

Then update `prisma/schema.prisma` to the same dimension, and re-embed every
document. `getEmbeddingColumnDimension()` reads the live column type, so the
app picks the change up without a restart.

For hosted providers that are all 1536-dim (`text-embedding-3-small` and most
alternatives), set the column to 1536 instead and point `embeddingBaseUrl` at
that provider.

### Re-indexing deadlock (transient)

Re-embedding a large corpus while `ensureVectorIndexes()` builds the HNSW index
can deadlock (`40P01`) between the `CREATE INDEX CONCURRENTLY` lock and concurrent
row updates. It is transient and retried by the ingestion jobs; if it persists,
build the index first and then re-embed.

## Other limitations

- **CPU only.** ~0.28 s for 8 short texts on this machine; large batches on a big
  corpus will be slower than a hosted API.
- **Tested on one gateway and one corpus** (~28 chunks, EN documents, ID
  questions). Verify against your own data before trusting it.
- 3/5 on the hard paraphrase set is an improvement, not a solution — the model is
  384-dim and `MiniLM`-class. A larger multilingual model (e.g.
  `paraphrase-multilingual-mpnet-base-v2`, 768 dims) will do better at the cost
  of speed and a column resize.

## Why the app needed a code change at all

`isBlockedHost()` refuses `localhost`, `127.0.0.0/8`, and RFC1918 addresses to
prevent SSRF. The only escape was `LLM_ALLOW_BLOCKED_HOSTS`, a **test** marker
that `env-schema.ts` rejects when `NODE_ENV=production` — so a legitimately
self-hosted model could not be configured in production at all.
`LLM_ALLOWED_HOSTS` is the operator-facing equivalent: exact-match hostnames,
comma-separated, never a wildcard or suffix.
