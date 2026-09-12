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
| Berapa tarif lembur pada hari kerja? | overtime rate on a working day | 0.543 |
| Berapa hari cuti tahunan? | 12 working days of annual leave | 0.465 |
| Berapa lama jangka waktu refund? | refund within 30 days | 0.748 |
| *(off-topic)* resep kue bolu | — | **0.185** |

Every real ID→EN match sits far above the 0.185 noise floor.

**Rejected: `all-MiniLM-L6-v2`.** English-only. On the same pairs it scored the
*English translation* of a question (0.100) **lower** than an unrelated
Indonesian sentence (0.359) — it would have made Indonesian retrieval worse than
lexical matching alone. Note both models are 384-dim; the reason to prefer the
multilingual one is language coverage, not size.

## Known limitations — read before relying on this

1. **384 dims vs the schema's `vector(1536)`.** `DocumentChunk.embedding` is
   `vector(1536)`, and that is the column the pgvector leg queries. A 384-dim
   model cannot be written there, so embeddings land in `embeddingJson` only and
   the app logs a warning. **Consequence, measured:** the vector leg returns an
   EMPTY candidate set, so ranking is driven entirely by BM25 — semantic
   similarity is computed for reporting but does not order results. On 5
   paraphrase / no-shared-token questions the score was 0/5 with embeddings ON
   and 0/5 with them OFF.

   To actually use a 384-dim model you must resize the column:

   ```sql
   ALTER TABLE "DocumentChunk" DROP COLUMN embedding;
   ALTER TABLE "DocumentChunk" ADD COLUMN embedding vector(384);
   ```
   then update `prisma/schema.prisma` to match and re-embed every document.
   **This is destructive** — it discards existing vectors, and any org already
   embedded at 1536 dims must be re-embedded.

2. **CPU only.** ~0.28 s for 8 short texts on this machine; large batches on a
   big corpus will be slower than a hosted API.

3. **Tested on one gateway.** Verify against your own corpus before trusting it.

## Why the app needed a code change at all

`isBlockedHost()` refuses `localhost`, `127.0.0.0/8`, and RFC1918 addresses to
prevent SSRF. The only escape was `LLM_ALLOW_BLOCKED_HOSTS`, a **test** marker
that `env-schema.ts` rejects when `NODE_ENV=production` — so a legitimately
self-hosted model could not be configured in production at all.
`LLM_ALLOWED_HOSTS` is the operator-facing equivalent: exact-match hostnames,
comma-separated, never a wildcard or suffix.
