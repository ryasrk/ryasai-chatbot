# Cognee over HTTP (server pinned at v1.6.0)

**Status: MIGRATED AND PINNED AT v1.6.0. The HTTP server is the ONLY backend — the
in-process `@cognee/cognee-ts` SDK has been REMOVED from the project.**

Evidence below was measured on this machine against a real `cognee==1.5.4` server
(FastAPI), not read from documentation. **Those measurements still describe the API
contract, which is what they were taken for, but the pinned version is now 1.6.0.**
Where a number is specific to 1.5.4 the line says so; do not re-read it as a v1.6.0
measurement. The v1.6.0 upgrade is measured separately, at the bottom of this page.

WHY ONLY ONE VERSION, EVER. Two cognee lineages exist and they are NOT the same
implementation: the Python server (`topoteretes/cognee`) and the Rust/TS bindings
(`topoteretes/cognee-rs`, npm `@cognee/cognee-ts`). Running both against one store
mixes two writers with different on-disk formats and different bugs — which is exactly
how this deployment produced a LanceDB collection sized 1536 while the configured
embedder returned 384, and a graph with 0 nodes after a write reported success. One
lineage, one version, one writer.

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
| Python (server + library) | `topoteretes/cognee` | **1.6.0** | THE backend |
| Rust + TS bindings | `topoteretes/cognee-rs` | 0.1.3 (npm `@cognee/cognee-ts`, latest 0.2.0) | **REMOVED** — no longer a dependency |

## Measured: the server works end-to-end

Server: `cognee==1.5.4` at the time of these measurements, sqlite + kuzu + lancedb,
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

- pinned image `cognee/cognee:1.6.0` (never `:latest` — the app must
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


---

## The v1.6.0 move (2026-09-24) — what it took, measured

The bindings were removed and the server pinned at v1.6.0. Every number below was measured
on this machine against a real sidecar and a real store, not read from a changelog.

### Getting the sidecar to accept our embedding endpoint took three corrections

1. **The model id must be `openai/<name>`.** With a bare
   `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`, EVERY write failed after
   exactly 30s with "Embedding connection test timed out". The embedding endpoint was up the
   whole time and answered a direct request from inside the container in **0.47s at 384
   dimensions** — and the server's own access log showed cognee never called it even once.
   litellm reads the provider from the model string, so a bare `sentence-transformers/...`
   was parsed as a provider named `sentence-transformers`. Same shape as `anthropic/claude-…`.
2. **The container must be able to reach the endpoint.** Our local embedding server bound
   `127.0.0.1:4503`, which a container cannot see; it needs `0.0.0.0` and
   `host.docker.internal:host-gateway`. Symptom was the same 30s timeout, which is why (1)
   had to be ruled out by checking the server's access log rather than trusting the message.
3. **Tokenizer.** cognee warns it cannot map that model to a TikToken encoding and falls back
   to approximate counts. `HUGGINGFACE_TOKENIZER` did not change it, and the warning is
   non-fatal (it affects chunk sizing, not correctness), so it is left as a known warning
   rather than hacked around.

### The real latency defect was a feature we do not use

Before configuration: **write 22–30s, search 24–95s** (two consecutive searches, 81s each).
The server log said retrieval was never the cost — `Found 3 chunks from vector search` took
**49ms** — and the timeout was `SessionTurnAnalysis` calling the LLM, failing schema
validation and retrying:

```
litellm_native validation retry 1/3: 1 validation error for SessionTurnAnalysis
```

six times in one log. With `AUTO_FEEDBACK=false`, `IMPROVE_AUTO_ENABLED=false` and
`USAGE_LOGGING=false`: **write 9s, search 0.21s**, same facts recalled. These are set in
`docker-compose.yml`, `install.sh` and `.env.example`. Someone re-enabling them should expect
to re-measure, not to get the old numbers back.

Warm recall through the whole app layer, on a seeded database: **0.35–0.43s**.

### End-to-end, through app code rather than curl

`cogneeHealth()` → `connected=true mode=server version=1.6.0-local`; two turns written in two
sessions, both recalled from a third; both sentinel tokens FOUND. Cross-session memory works,
which it did not before this change — the previous state returned `len=0` on every attempt
while the write resolved successfully.

### Two defects this surfaced, both fixed

- **The chat-turn write blocked the answer.** `tool-router.ts` `await`ed `rememberChatTurn`
  before returning, so `/api/v1/chat/completions` hung past a 90s timeout on a 5.6–9.7s write
  (85s on a brand-new dataset). Now `void`, matching `send/route.ts`. Same spec: 13.1s → 13.4s.
- **`recallContext` had no deadline**, and four call sites await it mid-turn — `tool-router.ts`
  inside a `Promise.all`, so it gated the entire turn. `.catch(() => '')` handles rejection,
  not a call that never settles, and the transport timeout is 240s. Now bounded inside
  `recallContext` so no caller can forget.

### Open, and NOT fixed

- **Memory reaches tool selection, and its effect is measured — see the section below.**
  `tool-router.ts` passes `memoryContext` into `selectToolWithLlm`, which renders it as
  `Context from memory:` in the routing prompt; the `routeQuery` fallback renders it too
  (`Memory from prior interactions:`). So an earlier session's remembered facts can change
  which tool the router picks.

  An earlier version of this note claimed the E2E citation failure was this effect ("the RAG
  branch was not taken"). **That was wrong and is retracted**: in that failing run the tool run
  was `RAG|success` and the citations were present in the database. The rendering failure has a
  different cause, not yet identified. The routing effect below is real but was established by
  direct measurement, not by that E2E run.

  Measured (section below): memory in the routing prompt **helps a lot** on document-answerable
  questions (5/20 → 20/20 correct) and **hurts** when the injected text is conversation-shaped
  (the selector returned NULL 7/8). So the answer is not "remove it" — it is "change what gets
  injected", which is a behaviour change that needs its own measurement and should beat the
  recorded baseline.
- `e2e/07-agentic.spec.ts` fails 2 tests. **Pre-existing and unrelated**: reproduced at commit
  `646bbc9` with memory off. Its `signIn()` helper times out waiting for either `#email` or the
  Dashboard heading.

---

## Does memory in the routing prompt help or hurt? Measured

Asked directly, so measured directly. Same model, same questions, **conditions interleaved
alternately** so provider drift lands on both sides equally. `routeQuery`-style fallbacks are
counted separately (`NULL` = the selector returned nothing, so routing fell through to the
heuristic router).

### 1. It clearly HELPS when the answer lives in a document

Question: *"What is the primary distribution hub code?"* — answerable from an uploaded
document, so `RAG` is correct. 20 pairs:

| | SQL (wrong) | RAG (right) | NULL |
|---|---|---|---|
| without memory | **14/20** | 5/20 | 1/20 |
| with memory | 0/20 | **20/20** | 0/20 |

Without memory the router sends this to SQL two times in three and the document is never
searched. This is the single biggest routing effect measured here, and it is a **strong
argument for keeping memory in the prompt.**

### 2. It clearly HURTS when the memory is conversation-shaped

`rememberChatTurn` writes chat turns; `recallContext` returns recalled chunks that look like
them. Question as above, 8 pairs per condition:

| memory injected | RAG (right) | SQL | CHAT | NULL |
|---|---|---|---|---|
| none | 3/8 | 5/8 | 0/8 | 0/8 |
| **conversation-shaped** (`Events: chat turn / Roles: user, assistant`) | 0/8 | 1/8 | 0/8 | **7/8** |
| document-shaped (`This chunk is about the warehouse manual…`) | 6/8 | 0/8 | 1/8 | 1/8 |

Conversation-shaped memory — **exactly what this system writes by default** — pushed the
selector to return nothing 7 times out of 8. `NULL` is survivable, not fatal: it falls through
to `routeQuery`, which is conservative. But a router that has stopped deciding is not doing its
job, and this is the shape of memory a real install accumulates.

### 3. It can HURT a question that should go to SQL

*"how many documents are uploaded?"* — 6 pairs:

| | SQL (right) | RAG (wrong) |
|---|---|---|
| without memory | 5/6 | 1/6 |
| with memory | 3/6 | 1/6 (+2 NULL) |

Smaller and noisier than the effects above, but it points the wrong way: memory containing
document-ish text pulls a counting question toward document search.

### What this means

The honest summary is **mixed, and shape-dependent, not "good" or "bad"**:

- Memory in the routing prompt is doing real work that the base prompt cannot do. On a
  document-answerable question it moved routing from 5/20 to 20/20 correct. Removing it outright
  would be a measurable regression.
- But what gets injected is currently *whatever recall happens to return*, and recalled chat
  turns are a poor routing signal: they pushed the selector to `NULL` 7/8.
- The prompt placement compounds it: memory is rendered directly beneath *"Reply in text only
  when the question needs no data at all: … a message that refers to earlier turns."* A block of
  remembered conversation sitting under that instruction is an invitation to answer from memory
  instead of calling a tool.

**The likely fix is not to remove memory from routing but to change WHAT is injected** — a
distilled summary of remembered topic, or document-shaped recall only — and to measure it the
same way. That is a prompt/behaviour change affecting every install, so it is recorded here
rather than guessed at. The runs above are the baseline any change should beat.
