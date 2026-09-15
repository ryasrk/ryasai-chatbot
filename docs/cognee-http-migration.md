# Migrating to the cognee HTTP server (cognee 1.5.4)

**Status: MIGRATED. The server is the default backend when `COGNEE_SERVER_URL` is set.**
Evidence below was measured on this machine against a real `cognee==1.5.4`
server (FastAPI), not read from documentation.

## Why this document exists

We ship `@cognee/cognee-ts` 0.1.3 (in-process Rust/Neon bindings). Two things
forced a re-think:

1. **0.2.0 is unusable.** `remember()` reports `PipelineRunCompleted` in ~25 ms
   and writes nothing, then marks the dataset complete — a mark that persists in
   `cognee.db`, so even downgrading does not recover. See
   `scripts/cognee-upgrade-check.md`.
2. **The TS binding's graph path is weak on kuzu.** `NATURAL_LANGUAGE` fails on
   every attempt and `GRAPH_COMPLETION` was measured failing after 193 s, so the
   graph — the whole reason for cognee — was barely usable.

The Python server is the project's primary, actively released artifact (v1.5.4,
`topoteretes/cognee`).

## How the switch works

`src/lib/cognee-core.ts` resolves one backend for BOTH a write and its matching
read, so the two can never diverge:

| `COGNEE_SERVER_URL` | Backend | Transport |
|---|---|---|
| set (`http://cognee:8000`) | `server` | `src/lib/cognee-http.ts` |
| empty / unset | `inprocess` | `@cognee/cognee-ts` SDK |

The URL is read from the ENVIRONMENT only — deliberately not from the per-org
`AppConfig` row. A per-org server address would let one organization point its
memory at another organization's server, which is exactly the cross-tenant leak
this module already had to fix once.

`docker-compose.yml` sets `COGNEE_SERVER_URL=http://cognee:8000` on **app and
scheduler** explicitly (not just via `.env`), so an existing `.env` cannot
silently leave the deployment on the weaker in-process path.

## Two release tracks — do not conflate them

| Track | Repo | Version | What we use it for |
|---|---|---|---|
| Python (server + library) | `topoteretes/cognee` | **1.5.4** | the migrated-to backend |
| Rust + TS bindings | `topoteretes/cognee-rs` | 0.1.3 (npm `@cognee/cognee-ts`, latest 0.2.0) | the fallback path |

## Measured: the server works end-to-end

Server: `cognee==1.5.4`, sqlite + kuzu + lancedb, LLM via the local gateway,
embeddings via a local OpenAI-compatible endpoint.

```
GET /health   -> {"status":"ready","health":"healthy","version":"1.5.4"}
```

Write then recall, on a fresh store:

```
POST /api/v1/remember   (multipart: raw_data=... , datasetName=org:probe)
  -> 200  {"status":"completed","dataset_id":"4fb2de5b-...",
           "pipeline_run_id":"3b88f6ab-...","items_processed":1,
           "elapsed_seconds":20.1}
      wall clock 19.9 s  <- a REAL pipeline, not a 25 ms false success

POST /api/v1/recall     {"query":"...","datasets":["org:probe"],"topK":10}
  -> 200  [{"kind":"graph_completion","search_type":"HYBRID_COMPLETION",
            "text":"MATCH-1789485504","source":"graph"}]
      4.3 s, token found
```

**Cross-session proof through our own code** (`rememberChatTurn` → `recallContext`
with a DIFFERENT session id, so only long-term memory can supply the answer):

```
WROTE=MEM-1789485969388
FOUND=true      <- recalled from a brand-new session
LEN=969
```

A second write landed too (`items_processed: 1`, 6.1 s) and is visible to
`CHUNKS`/`SUMMARIES`.

## API contract differences that shape the client

Each one cost a real debugging cycle.

- **`remember` is `multipart/form-data`, not JSON.** Fields include
  `raw_data` (an array of strings), `datasetName`, `datasetId`, `node_set`,
  `run_in_background`, `chunk_size`, `chunks_per_batch`, `index_vectors`.
  Sending JSON returns `400 "Either datasetId or datasetName must be provided."`
- **`add` accepts file uploads only**, unlike `remember`. Passing text to `data`
  returns `400 "...'data' accepts file uploads only..."`. Use `remember` for text.
- **`recall` and `search` are JSON** and accept `searchType`, `datasets`,
  `query`, `topK`, `sessionId`, `onlyContext`, `verbose`, `includeReferences`.
- **No `datasets.has()` equivalent is needed.** The TS binding's `has()` reports a
  present dataset as missing; `GET /api/v1/datasets` lists it correctly. The old
  advisory-only workaround is NOT ported — it only ever existed to tolerate the
  SDK's bug.
- **`searchType` semantics differ from what the TS binding implied.**

  Measured on two stored facts, query "kode proyek rahasia dan cadangan":

  | searchType | results | fact 1 | fact 2 |
  |---|---|---|---|
  | `CHUNKS` | 2 | yes | yes |
  | `SUMMARIES` | 2 | yes | yes |
  | `HYBRID_COMPLETION` | 1 | yes | yes |

  `HYBRID_COMPLETION` is the SERVER DEFAULT and returns ONE LLM-synthesized
  answer, so its `results.length` is not a recall count — both facts are present
  inside that single `text`. Our recall therefore requests `CHUNKS` + `SUMMARIES`
  explicitly: the output is injected as memory context into further LLM prompts,
  where spending an LLM call to re-word facts we then paste into another prompt
  is pure waste, and where a single synthesized blob can hide one of the facts.

## Configuration gotchas (each one measured as a failure first)

- **litellm needs a provider prefix.** `LLM_MODEL=cbcn/deepseek-v4.1-flash`
  fails with `LLM Provider NOT provided`. Our gateway is OpenAI-compatible, so
  the working value is `LLM_MODEL=openai/cbcn/deepseek-v4.1-flash`.
- **Embedding dimensions must match the provider.** The default assumes 3072;
  our endpoint returns 1536. Mismatch fails with
  `LanceDataPoint ... List should have at least 3072 items after validation`.
  Set `COGNEE_EMBEDDING_DIMENSIONS` to what the endpoint actually returns.
- **`LITELLM_DROP_PARAMS=true`** avoids `dimensions is not supported for OpenAI
  text-embedding-3 and later models`.
- **`COGNEE_SKIP_CONNECTION_TEST=true`** skips the 30 s startup embedding probe.
  Without it a slow endpoint fails the whole `remember` with
  `Embedding connection test timed out after 30s`.
- **Provider credentials must be real for the WRITE path.** Reads work without
  them; `remember` needs a working LLM because cognify makes its own calls.

## Verifying a migration (the only test that counts)

A `status: "completed"` response is **not** evidence of a write — that is exactly
how 0.2.0 passed a superficial check while losing data. Always:

1. write a unique token,
2. recall it in a **different session** so only long-term memory can supply it,
3. assert the token is present in the response body.

For a second write, assert BOTH tokens are visible via `CHUNKS` (not via
`HYBRID_COMPLETION`'s single synthesized answer).

## Deployment

`docker-compose.yml` runs cognee as a sidecar:

- pinned image `cognee/cognee:1.5.4.dev20260914` (never `:latest` — the app must
  be able to read what the store wrote),
- local mode (sqlite + kuzu + lancedb) so there is **no second database**,
- named volume `cogneedata` so the graph survives a recreate,
- healthcheck on `/health`, `start_period: 90s` (first boot inits the stores),
- **no published port** — the app reaches it by service name, and exposing an
  unauthenticated memory API to the host is not acceptable,
- app/scheduler use `condition: service_started`, NOT `service_healthy`: memory
  is optional and degrades gracefully, so a warming graph must not block the
  chat UI from starting.

## Known limits — do not overstate

- The sidecar needs its own LLM/embedding credentials (`COGNEE_LLM_*`,
  `COGNEE_EMBEDDING_*`). They are env-level, not read from the per-org
  `LlmConfig` row the way the in-process path does. An on-prem box with several
  orgs but one cognee service therefore shares one provider key for graph work.
- A write takes 5–35 s (cognify runs its own LLM calls), which is why
  `rememberChatTurn` is fire-and-forget and the scheduler is the right place for
  bulk cognify.
- We have not measured this service's memory footprint on a customer-sized
  corpus; upstream's compose reserves 8 GB, and this file deliberately sets no
  cap.
- Multi-hop graph *quality* is now measured on a SMALL corpus (below), but not at
  customer scale, and what was measured is RETRIEVAL, not answer quality.

## Measured: multi-hop retrieval quality on a small corpus

`scripts/cognee-quality-probe.ts` plants two facts per scenario that connect only
through a shared entity, then asks a question whose answer requires following that
link. Run against a fresh cognee 1.5.4 server, dataset `probe:quality`:

| scenario | traversal required | result |
|---|---|---|
| two-hop vendor chain | approver → purchase → vendor | **rank #1** |
| org-chart hop | report → manager → approval | **rank #1** |
| shared-vendor hop | supplier → audit finding → *other* project | **rank #1** |

**3/3 answer chunks ranked FIRST**, every hit labelled `source: "graph"`, recall
2.7–3.1 s. Three controls make that number mean something:

1. **"Return everything" is ruled out.** The dataset holds 16 items with `topK` 8,
   so a retriever dumping the store could not score 100%. This was NOT true of the
   first run: with only 6 items stored, every recall returned all 6 chunks and the
   100% was *uninterpretable*. The filler corpus exists specifically to make the
   probe falsifiable — the naive version reported a meaningless perfect score.
2. **A decoy is present per scenario** — wording that shares vocabulary with the
   question but is the wrong answer (e.g. asking about "project Alpha" when the
   answer is "Beta"). The answer outranked its decoy every time. The decoy still
   appears *inside* the top-8 window; on a corpus this small that is expected, and
   ranking is the claim — not exclusivity.
3. **An unanswerable control MISSES.** The same question asked against an empty
   dataset returns 0 chunks in ~55 ms, so recall is dataset-scoped and hits are not
   leaking across namespaces.

**Paraphrase robustness (no shared vocabulary).** Re-asking with the stored words
deliberately avoided — "Who is the manager that Clara Handayani oversees?" (the
reverse of the stored edge), "PT Cahaya Timur was late on which projects?" — still
surfaced the correct chunk at rank #1 (2 of 3) and rank #2 (1 of 3). Ranking is
therefore semantic/structural, not JSON keyword overlap.

**Do not overstate this.** It is:
- **not** answer accuracy — a hit means the joined evidence was *retrievable*, not
  that the final reply used it correctly;
- **not** customer scale — 16 items, 3 scenarios, one run each; a real corpus has
  thousands of chunks and far more collisions;
- **not** a faithfulness measure — no LLM-judged scoring was applied.

