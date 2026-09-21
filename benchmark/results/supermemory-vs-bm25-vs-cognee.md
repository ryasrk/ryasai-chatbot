# supermemory vs BM25 vs cognee — retrieval comparison on identical input

**Question answered:** is supermemory worth migrating to from cognee?

**Short answer: no — and the more important finding is that BM25 beats both.**

All three arms ran the **same 1200-document corpus** and the **same 1000 questions**,
graded by the **same evidence rule** (`evidence_hit@k` = *every* evidence document present
in the top-k). The corpus and questions come from one committed artifact
(`benchmark/results/cognee-1000-results.json`), so no arm re-generated its own input.

---

## Head-to-head, recall@10, top-10 window

| arm | recall@5 | recall@10 | answer@1 | MRR | p50 latency | ingest |
|---|---|---|---|---|---|---|
| **BM25** (lexical only, no LLM, no graph) | **0.2290** | **0.2300** | **0.1660** | **0.2078** | ~0 ms (in-process) | **none** |
| cognee 1.5.4 (`CHUNKS`) | 0.0810 | 0.1030 | 0.0390 | 0.0579 | 3 426 ms | 1 246 s (1 038 ms/doc) |
| supermemory 0.0.8 (`superrag`) | 0.0740 | 0.0780 | 0.0580 | 0.0721 | **60 ms** | **6 s submitted** (queue ~24 min) |

### Per tier

| arm | easy | medium | hard | complex |
|---|---|---|---|---|
| BM25 | **1.0000** | **0.0400** | 0.0033 | **0.3250** |
| cognee | 0.2733 | 0.0000 | 0.0000 | 0.3100 |
| supermemory | 0.2933 | 0.0000 | 0.0000 | 0.1700 |

**BM25 wins every tier except hard** (where all three are ~0). On **easy** — one evidence
document, the answer is a literal token — BM25 is **1.0000** against supermemory 0.2933
and cognee 0.2733. A lexical index answers perfectly what two graph/vector systems get
wrong ~70% of the time.

---

## Why supermemory lost — measured, not guessed

### 1. The embedding model cannot separate these documents

Probing with a known document's **exact text**, the correct document scored `sim=1.000`
but four **unrelated** documents scored `0.920–0.926`. Across all 10 000 returned hits:

| statistic | value |
|---|---|
| similarity p10 / p50 / p90 | 0.697 / 0.740 / 0.803 |
| within-question spread (max−min of 10 hits) | p50 **0.0301**, p90 0.0520 |

A median spread of **0.03** over 10 candidates means the ranker barely differentiates them;
ordering among near-equal vectors is close to arbitrary. This is `Xenova/bge-base-en-v1.5`
(768d), the **local English** default. It is the load-bearing component and it is the
weakest link.

### 2. Retrieval collapses onto a small subset

| | value |
|---|---|
| distinct documents ever returned (of 1200) | **399 (33%)** |
| share of all 10 000 hits from the top 50 documents | **63.1%** |
| most-returned single document | 303 times out of 1000 questions |
| medium+hard questions where the evidence doc appeared *anywhere* in the top 10 | 252 / 650 |

The system keeps returning the same few documents regardless of the question.

### 3. Multi-hop still collapses to single-hop

`medium` and `hard` are **0.0000** on all three arms. For supermemory, 252/650 medium+hard
questions did retrieve *the evidence document*, but never *both* required documents. That is
the same single-hop signature measured on cognee — the failure mode is shared, not specific
to either vendor.

---

## Negative controls (the numbers above are real)

Four controls were run, because a "0 everywhere" pattern is exactly what a broken harness
has looked like twice in this effort:

| control | result | what it rules out |
|---|---|---|
| every hit resolved to a corpus doc id | **10000 / 10000** | text-matching artefacts |
| returned ids that are NOT corpus ids | **0** (399 distinct, all real) | hallucinated/garbage ids |
| distinct id-signatures across 10 questions | **10 / 10** | a frozen/cached response scored 1000× |
| questions with an API error | **0** | errors scored as misses |

So the 0.0780 is a real measurement of this build with this embedding model.

---

## Two defects found in the self-hosted build (worth reporting upstream)

1. **`/v3/search` is broken in 0.0.8.** It returns `{"results":[],"total":0}` for *every*
   query, including a query that is a document's own exact text — while `/v4/search` returns
   the same content with a similarity score. The published OpenAPI spec and docs still
   advertise v3. This is a route regression, and it is why this arm uses `/v4/search`.
2. **`POST /v3/documents/batch` ignores `containerTag` in its response** and the document
   read-back exposes the tag only as the deprecated plural `containerTags`. Storage was
   correct; the API surface is inconsistent.

**Correction to an earlier assessment of mine.** I previously said the self-hosted engine
was an unauditable black box. Checking the binary showed it is a **Bun executable with its
JavaScript readable**, and it contains:

```js
{error:"Usage limit reached",
 details:"Usage metering is disabled in self-hosted builds."}
process.env.SUPERMEMORY_DISABLE_TELEMETRY === "1"
{sm_self_hosted: !0, ...}
```

So: metering is **off**, telemetry is **disableable**, and the engine **is** auditable. That
materially improves the on-prem story. What it does **not** change is the retrieval result
above.

---

## What this does and does not establish

**Does establish:** on this corpus, with these 1000 questions, at this scale, **neither
supermemory nor cognee beats a plain BM25 index** on retrieval recall, and BM25 — a
zero-dependency, zero-LLM, zero-cost keyword index — is roughly **3x** supermemory and
**2x** cognee.

**Does NOT establish:**

1. **This is document retrieval, not memory quality.** supermemory is sold as agent memory
   (profiles, contradictions, "I moved to SF supersedes I live in NYC"). `taskType:
   "superrag"` was used deliberately so it would index documents rather than rewrite them
   into facts. Its core competency was **not** tested here.
2. **The embedding model is the likely bottleneck, not supermemory.** The local 768d English
   default was used with no API key. Swapping to a stronger multilingual embedding (OpenAI
   or Gemini, both supported) could move this substantially. **Re-run before drawing a final
   conclusion about supermemory itself.**
3. **One synthetic corpus, single run, no trials.** Templated one-sentence documents, no
   tables, no PDF noise.
4. **Different corpora scale differently.** supermemory ingested 1200 docs in 6 s submitted,
   cognee in 20 min of LLM calls. Cost and throughput favour supermemory by a wide margin;
   recall does not.
5. **Daftar harga metered SM token** concerns only its hosted plans; self-hosted builds have
   metering disabled, but the "lite, licensed up to 10k documents" limit printed at boot was
   **not** independently tested — that boundary matters for a customer corpus.

---

## Recommendation

1. **Migrating cognee → supermemory for document retrieval is not justified** by this data.
   It trades 0.1030 for 0.0780 while both lose to a keyword index.
2. **The real question is why we are paying an LLM-pipeline-per-document for retrieval a
   BM25 index beats.** That is the finding to act on.
3. **Before dismissing supermemory**, re-run this arm with a real multilingual embedding
   provider — that is a config change and one re-ingest, and it is the single cheapest way
   to find out whether the bottleneck is supermemory or its default embedder.
4. **Keep supermemory in consideration for conversation memory**, which this harness does
   not measure and where its on-prem story is now known to be better than first assessed
   (auditable, metering off, telemetry disableable).

## Reproduce

```bash
# server (self-hosted, fully local: local embeddings + local LLM gateway)
PORT=6767 SUPERMEMORY_DATA_DIR=/tmp/sm/data SUPERMEMORY_DISABLE_TELEMETRY=1 \
  OPENAI_BASE_URL=http://localhost:20128/v1 OPENAI_API_KEY=... \
  OPENAI_MODEL=cbcn/deepseek-v4.1-flash ./supermemory-server

# arm
bun benchmark/supermemory-arm.ts \
  --results=benchmark/results/cognee-1000-results.json \
  --base=http://127.0.0.1:6767 --api-key=<key> --tag=benchfull --limit=10

# BM25 reference (no server needed)
bun benchmark/cognee-bm25-baseline.ts --results=benchmark/results/cognee-1000-results.json
```
