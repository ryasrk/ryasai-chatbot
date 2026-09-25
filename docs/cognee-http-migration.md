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

  Measured (sections below, and note the retraction): memory in the routing prompt shifts
  decisions in BOTH directions and is shape-sensitive. The first headline claimed a large
  benefit (5/20 → 20/20) — **that number is retracted**, because the memory text used to
  produce it contained the author's own hint. What survives measurement: memory moves a
  document-answerable question from SQL (wrong) to RAG (right) 14/15 vs 0/10 without it, and
  pulls a counting question off SQL 3 times in 10. Two prompt-level variants have now been
  measured at **zero** further effect, so "change what gets injected" is NOT established as
  sufficient — see "Attempt 2 measured" for the full result.
- **The graph write path still rejects valid JSON.** Measured from the sidecar's own log over
  the life of the current container: **160** `ValidationError: 1 validation error for
  KnowledgeGraph` events. Classified by the rejected input, not by guesswork:

  | rejected input | count | what it means |
  |---|---|---|
  | prose ("Halo! Saya asisten AI…", "Understood — I'll treat…") | 136 | the E2E **mock LLM** answering in sentences. Test artefact, not a production defect. |
  | `\`\`\`json` … `\`\`\`` | **24** | a **real** model wrapping its JSON in a markdown fence. cognee does not strip it. |

  The 24 are the real finding, and they cost real time: a rejected extraction is retried
  (measured `Retrying … in 16.5 seconds`), and one write against a fresh dataset measured
  **228 seconds** — a number I reported earlier as 9s because that figure came from a warm
  store, not from the first write. The same class of failure is why the session opened with a
  `Deserialization error: … Raw: This chunk is about:` in `pipeline_runs`.

  **FIXED for the fence cases** — see "The fence defect, found and patched" below. The prose
  cases remain: those are the mock LLM and, in production, a model answering instead of
  extracting. There is nothing to patch for those; they need the extraction prompt or model
  to change, which is a separate decision.

### The fence defect, found and patched

Root cause, established by reading the vendored code rather than guessing:

`native_adapter.py` already ships `_strip_json_fence`, added for exactly this failure (its
comment references ticket `CLO-596`). But its regex was anchored to the WHOLE response:

    \A\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*\Z

so it fires only when the fence is the entire message. Measured against the shapes this
deployment actually produced:

| model output | upstream strip |
|---|---|
| `` ```json … ``` `` (fence wraps everything) | works |
| "Here you go:" + `` ```json … ``` `` | **falls through** (prose before) |
| `` ```json … ``` `` + "Hope this helps!" | **falls through** (prose after) |
| clean JSON, no fence | works (unchanged) |

Two independent defects, both needed fixing: the pattern was anchored `\A...\Z`, AND the call
site used `.match()` (position 0 only), so prose BEFORE the block was never examined even
after the pattern was widened.

**Which shapes actually occurred, counted rather than assumed.** Of 155 `KnowledgeGraph`
rejections in one container's log, 28 contained a fence:

| shape | count | handled by upstream? |
|---|---|---|
| starts with the fence | **24** | yes — `\Z` is satisfied when the fence is the tail |
| starts with **prose**, fence later | **4** | **no** — `.match()` never looks past position 0 |

So the anchoring that bit us in practice was `.match()`, not `\A`: the 24 fenced rejections
began AT the fence, and the 4 that began with prose are the ones position-0 matching cannot
see. One of those four is verbatim:

    input_value='Fixed the field names (`...  }\n    }\n  ]\n}\n```'

**What is evidence and what is reasoning.** The four prose-first payloads are in the log and
are quoted above. The "prose AFTER the fence" row is reasoning about the same anchored
pattern, not something observed here — no captured payload had trailing prose, partly because
pydantic truncates the value it reports. It is listed as a shape the fix handles, not as a
failure this deployment was measured to suffer.

pydantic truncates the middle of long values (`...`), so these payloads prove what they START
with and how they END, and nothing about the middle.

`tools/cognee-server/patch-fence-strip.sh` widens the pattern and switches the call to
`.search()`. It is applied at container start, so it is visible here rather than buried in a
Dockerfile layer, and it should be deleted when upstream widens the regex (the script refuses
to patch if the pattern is no longer anchored, which is how you will know).

**The script patches BOTH package copies.** The image ships the package twice
(`/app/cognee` and `/app/.venv/lib/python3.12/site-packages/cognee`) and which one a process
imports depends on how it was started. I patched one and tested the other and briefly
believed the fix had failed — recorded because the next person will hit it too.

It also carries a behavioural check, not just a syntax check: it exercises the four shapes
above on the file it just wrote and refuses to report success if any fails.

**Measured effect.**

| | before | after | how it was obtained |
|---|---|---|---|
| first write on a fresh dataset | **228.0 s** | **67 s** | `228004ms` is saved in the probe output; the 67 s is a clean in-container measurement on the compose sidecar, a fresh dataset |
| fence payloads rejected | **24** | **0** | counted from the container logs |
| `_strip_json_fence` behaviour | 1/4 shapes | **4/4** | run live in the patched container |

**An earlier figure of 35.5 s is RETRACTED.** It came from a manual container that has since
been removed, was never written to a file, and cannot be reproduced — the same mistake as
trusting a summary line. The clean measurement on the container that actually ships is
**67 s**, which is still a large improvement over 228 s but is not the number I first reported.

The zero is verified by timestamp as well as by count, because `docker logs` retains earlier
containers' output: the raw total for a fresh container still read 29 until filtered. The one
remaining `KnowledgeGraph` rejection in the patched compose container is **prose**
(`Baik, saya catat: kode h…`) — a model answering instead of extracting, which no fence fix
addresses — and it produced **0** retries.

### Two configuration gaps this work exposed

Both would have left memory non-functional on a customer's compose install while looking
healthy, and neither was visible from the code.

1. **The sidecar had no LLM credentials.** `docker-compose.yml` reads
   `COGNEE_LLM_API_KEY`/`COGNEE_EMBEDDING_*`, and this deployment's `.env` had none — so the
   container started, passed its health check, and failed every write with
   `LLM API key is not set. [LLMAPIKeyNotSetError]`. The app's own `LlmConfig` row cannot be
   read from inside the container, so there is no fallback. `.env` now carries them, with a
   comment saying they are REQUIRED.
2. **The container could not reach the host.** Local model servers live on the host
   (`127.0.0.1:4503`, `127.0.0.1:20128`) and a container cannot resolve that to its host.
   `docker-compose.yml` had no `extra_hosts`, so writes would have failed with a connection
   error naming the endpoint rather than the cause. Added
   `host.docker.internal:host-gateway`, which is Docker's portable alias.

### The remaining `KnowledgeGraph` rejections: what they actually are

Counted on a live sidecar after the fence patch: **58** rejections, **0** of them fence-shaped
(the patch holds). Classified by the rejected input:

    '**Turn 1**\n\n**User:** ...edia dan siap diproses.'
    'Berikut contoh turn perc...lah yang ingin dipesan.'

These are PROSE. `KnowledgeGraph` requires `summary` and `description` as plain strings
alongside `nodes`/`edges` (`shared/data_models.py`), so a model that starts answering the
summary in sentences never reaches the structured part — and the whole reply fails validation.

**I first attributed this to cognee routing summarisation through the structured path, and
that was wrong.** `KnowledgeGraph` IS the graph-extraction model; there is no summarisation
task in that path. What the model actually does, tested directly against this endpoint:

| prompt | reply |
|---|---|
| short extraction prompt, with `json_object` | clean JSON |
| short extraction prompt, WITHOUT `json_object` | clean JSON |
| long schema-in-prompt extraction, with `json_object` | **empty string** |
| the real cognee calls (long prompts, real documents) | **prose** |

So the capability is there and the failure is prompt-dependent, not model-dependent. The
observed shape is the model attempting the `summary` field in prose and never emitting JSON.
**I did not isolate the exact trigger**, and the two candidate explanations (prompt length vs
`response_format` in this provider's tool-calling path) were not separated by measurement.
Recorded as unresolved rather than guessed at.

**They do not block anything.** Writes were measured completing while these retries ran:

| write | elapsed | status |
|---|---|---|
| 1 | 8.9 s | completed |
| 2 | 117.3 s | completed |

So this is a **latency** defect, not a data-loss one: the extraction is retried (up to
`_MAX_VALIDATION_RETRIES`, with a 240s tenacity stop floor) and eventually succeeds. 117 s
versus 9 s is the visible cost, and it is why a fresh-dataset write can take minutes.

**Root cause narrowed by direct isolation.** Same endpoint, same model, same `json_object`,
varying only the prompt:

| prompt | reply |
|---|---|
| short ("Extract a graph. JSON only.") | clean JSON, 314 chars |
| cognee-style schema-in-prompt | **empty string** |
| cognee-style, WITHOUT `json_object` | **empty string** |
| long filler system prompt (98-638 chars) | answered in every case |

So it is neither `response_format` nor prompt LENGTH (filler up to 638 chars was answered
fine) — it is something specific to the schema-bearing prompt. The empty replies in the live
log match this exactly: the captured `input_value` for the recent failures is `''`, not prose.
**I did not isolate which element of that prompt triggers it**, and the prompt lives inside the
server, so this is recorded as the boundary rather than guessed past.

**A LATENCY FIX I ATTEMPTED, MEASURED, AND RETRACTED.** Reasoning from the empty-reply
isolation (long schema-bearing prompt → empty string), I capped the text
`rememberChatTurn` sends to cognee at 4000 chars, expecting oversized turns to stop paying
repeated extraction cost. Then I measured it, five consecutive writes against the org store:

| payload | elapsed |
|---|---|
| short (20 chars) | 47.8 s |
| long (20000 chars, capped to 4000) | 92.1 s |
| short (20 chars) | **124.8 s** |
| long (20000 chars, capped to 4000) | **41.0 s** |
| short (20 chars) | **168.3 s** |

The LONG writes were faster than the short ones. Payload size is not the driver, and the spread
(41 s to 168 s for similar work) says the variance is elsewhere — and the retry counters agree:
the same 12-minute window that contained those five slow writes logged only **8** validation
errors and **zero** empty payloads. So the latency is not retry-driven either.

The cap is KEPT because it bounds what a single turn contributes to a graph — a long answer
should not become an unbounded extraction job — but it is NOT claimed to improve latency, and
the numbers above are why. The earlier sentence in this document reading "writes measured
228s/135s/117s versus 8.9s for a small one" was a small-sample comparison across different times
and datasets; stated as if payload size explained it, which this table refutes.

**What the latency actually is: LOCATED — it is provider inference time for the extraction
task, not cognee and not our code.** Measured directly against the customer's endpoint, same
model, same temperature, varying only the task:

| prompt | latency |
|---|---|
| "Say OK" | **1.3 s** |
| an entity/relationship extraction request | **23.7 s** |

and a plain extraction call repeated four times: 19.6 s, 13.3 s, 20.4 s, 18.1 s. So the
endpoint answers trivial prompts in ~1 s and takes **13-24 s** for extraction, consistently.

That accounts for the whole write cost: a write runs several such calls (extraction, plus
cognee's own pipeline steps), so tens of seconds is the floor, and a retry adds another
13-24 s each time rather than a small overhead. It is a property of the model/endpoint the
customer brings under BYOK, not a defect in this codebase — and it is why the numbers spread
from 41 s to 168 s for nominally similar work: one to three extra extraction calls' worth of
variance.

Consequence worth stating for sales: **a self-hosted memory graph costs what the customer's own
model costs for extraction.** A small or slow model makes writes slow; a bigger one may be
faster at this task but costs more. That is a deployment choice, and the honest guidance is to
point `COGNEE_LLM_MODEL` at a model that is good at structured extraction, not necessarily the
same one used for chat.

**A per-stage extraction model would be the ideal answer, and on this pin it DOES NOT WORK —
do not advertise it.** cognee v1.6.0 declares `llm_extraction_model` in
`infrastructure/llm/config.py` and ships `infrastructure/llm/pipeline_stage.py`, whose own
docstring says it routes "every LLM call made within this block to the model configured for
`stage` (one of extraction | summarization | query)". Checked against the shipped tree:
`llm_extraction_model` appears ONLY in that declaration and in
`tests/unit/infrastructure/llm/test_stage_routing.py` — **no production code reads it**. Setting
it changes nothing, so an operator who sets it would see no effect and no error, which is the
worst shape for a config knob. Recorded so nobody sells the capability, and so the check is
repeated if the sidecar is ever bumped.

**Retries are NOT wasted, so do not "fix" this by removing them.** Counted over one
container's log:

| stage | count |
|---|---|
| validation retry 1/3 | 297 |
| retry 2/3 | 215 (so 82 recovered at attempt 2) |
| retry 3/3 | 142 |
| gave up entirely ("Retrying … in Ns") | 113 |

184 of 297 eventually succeeded on a retry. Removing retries would convert those into losses.
The cost is latency, and the fix has to be the prompt, not the retry count.

**Three framework choices were tested to remove it, and only one works on this endpoint:**

| `STRUCTURED_OUTPUT_FRAMEWORK` | result |
|---|---|
| `litellm_native` (default) | works, with the latency above |
| `instructor` | **BROKEN** — sends `tool_choice` as an OBJECT; this endpoint needs a string: `json: cannot unmarshal object into Go struct field Request.tool_choice`, HTTP 400 on every call |
| `baml` | not installed in the image |

**A fix I attempted and REVERTED.** I widened the patch to inject
`response_format={"type": "json_object"}` into the json fallback, on the theory that cognee was
asking for JSON only in prose. Reading the file showed cognee **already sends exactly that** in
that call — so the insertion was a duplicate and did nothing. Reverted rather than left in:
a patch that appears to fix something and does not is worse than no patch, because the next
reader will trust it. The measured finding stands instead: this endpoint DOES honour
`json_object` (verified with an extraction-shaped prompt returning clean JSON), so the prose
comes from calls that were never going to answer in JSON.

**Retrieval by meaning: WORKS — an earlier claim of mine that it did not is RETRACTED.**

I reported that a stored token was findable only by searching the token itself and not by a
semantic query, and listed it as an open defect. That was a MEASUREMENT ERROR: the test ran
against `probe:fencefix` in a container that had already been replaced, so it was querying a
dataset whose matching container no longer existed. Re-measured on the dataset and container
that actually pair up (`probe:compose-measure`, compose sidecar), `searchType: CHUNKS`:

| query | contains the stored token |
|---|---|
| "kode hub distribusi utama" | **yes** |
| "kode hub" | **yes** |
| "apa kode hub" | **yes** |

So memory retrieval works by meaning, not only by literal token match. The lesson joins the
others in this document: a probe that pairs a dataset with the wrong container produces a
confident false negative.

### RESOLVED: `03-knowledge-chat` — two independent defects, neither about memory

It was never a memory bug. Memory only changed which test happened to be running when the real
defects bit. Both are fixed, and `bun run e2e` is **16/16 with a sidecar configured** (was
15/16), stable across two consecutive runs of the affected spec.

**Defect 1 — the in-flight answer was being wiped, then dropped silently.**

Traced rather than guessed, and the trace is the interesting part: the SSE `answer` frame
carried `citations=2`; the store was confirmed to hold `user,ai` immediately after
`addMessage`; and by assertion time the store read `[user, ai(previous), user]` — the new
answer had nowhere to land. `finalizeLastAiMessage` saw its last row was not an AI row, took
its early return, and discarded the answer and both citations.

Cause: `selectSession` (`use-chat-sessions.ts`) did a plain `setMessages(msgs)` from the
server, and the server returns PERSISTED rows only — so any local row not yet saved was wiped,
including the streaming placeholder. It now preserves in-flight rows while server rows still
win for everything persisted. The silent early return now logs what it drops, which is how the
diagnosis was confirmed: the warning fired once, reporting "2 citation(s)", matching the frame.

**Defect 2 — queued embed jobs were stuck, so a document had no vector.**

After defect 1 was fixed the failure changed shape: `Sources (2)` rendered, but did not include
`e2e-answer.txt`. The database showed why — two rows for that filename, one with a vector and
one without, and `cognifyStatus` stuck at `processing`. Redis held **4 jobs on `wait` and 9 on
`active` with no worker registered**.

Clearing the queue made the spec pass. The underlying behaviour is not a bug — `active` orphans
are recovered by BullMQ's stalled checker, which the worker configures, and that checker runs
inside a live worker (hence a queue inspected while the app is stopped still shows them). The
9 were bookkeeping from an e2e process killed mid-run. Confirmed by the fact that the same run's
documents were fully embedded: 2/2 chunks for `e2e-answer.txt`, 1/1 for the others, zero
documents failed.

**Honest attribution.** The run that went 15/16 → 16/16 had BOTH fixes plus the queue clear.
Defect 1 turned "no Sources at all" into "Sources rendering"; defect 2 accounts for the wrong
document being cited. Neither alone explains the final result, so both are described rather
than summarised as "fixed the test".

**A naming defect found on the way.** `adoptStuckJobs` did not adopt anything — it counted the
`wait` list and logged, which the function's own call-site comment admitted. Renamed to
`reportQueuedJobsOnStartup`, with what actually recovers orphans documented at the definition.

### (historical) the earlier hypothesis for this failure, disproved

One spec fails when a sidecar is configured and passes 16/16 without one. Established by
dumping the database after a failing run rather than by reading the UI:

| run | AI message for "What is the primary distribution hub code?" |
|---|---|
| memory ACTIVE (failing) | `citations` = full JSON, 769 chars, including `e2e-answer.txt` |
| no sidecar (passing) | same shape |

So retrieval, citation construction and persistence are all CORRECT with memory on. What fails
is the rendering assertion, and the reason is in the harness:

**A cause I proposed and then DISPROVED, recorded so it is not re-proposed.** My first
explanation was that `e2e/mock-llm.ts` has no one-shot guard on its configured tool call
(it emits on every request offering tools, and the chat path calls `selectToolWithLlm` twice
per turn — `quickPick` at tool-router.ts:93 and routing at :428), so memory changed which call
consumed the tool call and the RAG branch was never reached.

**That cannot be right, and my own evidence says so.** The database after a FAILING run holds
the AI message WITH full citations (769 chars, including `e2e-answer.txt`) — which is only
possible if the RAG branch DID run and citations WERE built. A missing tool call would have
produced an empty citation list, which is exactly what the "no sidecar" runs show. So the mock
is not what blocks the branch.

The one-shot experiment corroborates it from the other side: adding the guard made citations go
from `ADA(769)` to **`KOSONG`**, i.e. it BROKE a branch that was working.

**I tried the obvious fix and it made things WORSE, which is the informative part.** Adding a
`toolCallEmitted` flag (emit once, reset on a tool result) is correct in isolation, and with it
the citations went from `ADA(769)` to **`KOSONG`** — because the first consumer is `quickPick`,
so the real routing call then got a plain text reply and no citations at all. The mock cannot
distinguish the two calls: both are identical HTTP requests offering the same tools.

Reverted. **The true cause is UNKNOWN**, and the honest statement is narrower than the one I
first wrote: with a sidecar configured, retrieval and citations work and are persisted, yet the
UI does not render the `Sources (n)` control, and only in this spec. Without a sidecar the same
spec passes, so the difference is real and reproducible (2 consecutive runs).

What is ruled OUT by measurement: retrieval, citation construction, persistence, the RAG branch
being taken, and the mock's tool-call handling. What is left to check is the render path — the
streaming `answer` frame's `citations` field versus the refetch path — and that needs an SSE
capture on this spec, which my attempts did not land.

Until then `bun run e2e` with a sidecar shows 15/16. This does NOT affect CI, which sets no
`COGNEE_SERVER_URL` and runs the suite without memory (16/16).

- `e2e/07-agentic.spec.ts` fails 2 tests. **Pre-existing and unrelated**: reproduced at commit
  `646bbc9` with memory off, and again against the production standalone build. Its `signIn()`
  helper times out waiting for either `#email` or the Dashboard heading.

### Verification status of everything above

`tsc` 0 · `lint` 0 · `bun run test` 265/265 files, 6823 pass, 0 fail, 71 skip ·
`bun run e2e` 13 passed / 3 failed (all pre-existing `07-agentic` + the cognee-active
citation case) · `bun run build` succeeds and the standalone output contains **no** `@cognee`
and still contains the traced DB drivers (invariant #3) · `bun run e2e:prod` **14 passed /
2 failed**, the two being `07-agentic` only.

`e2e:prod` is the check that had never been run against this work until now, and it is worth
noting what changed by running it: `03-knowledge-chat` and `04-api-key` — both failing under
the dev server with memory configured — **pass against the production build**. The dev-mode
failures were real (a 90s request hang on the memory write, fixed in `tool-router.ts`), but
the production artefact does not exhibit them.

---

## Does memory in the routing prompt help or hurt? Measured

Asked directly, so measured directly. Same model, same questions, **conditions interleaved
alternately** so provider drift lands on both sides equally. `routeQuery`-style fallbacks are
counted separately (`NULL` = the selector returned nothing, so routing fell through to the
heuristic router).

### 1. ~~It clearly HELPS when the answer lives in a document~~ — RETRACTED, see below

> **This result was invalid and is kept only so the retraction is legible.** The memory text
> used here was written by the author of this note and contained the sentence *"the answer came
> from the uploaded document e2e-answer.txt"* — that is a routing instruction handed to the
> router by the test, not something the system produces. It measured the test's own hint. The
> corrected measurement, with real recall output, is in "Attempt 1 at that fix" below: the
> document question reached RAG 0/6 without memory and 0/6 WITH filtered memory.

Question: *"What is the primary distribution hub code?"* — answerable from an uploaded
document, so `RAG` is correct. 20 pairs (INVALID — see the retraction above):

| | SQL (wrong) | RAG (right) | NULL |
|---|---|---|---|
| without memory | **14/20** | 5/20 | 1/20 |
| with memory (author-written hint) | 0/20 | **20/20** | 0/20 |

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

The honest summary, after the retraction above and the failed filter attempt:

- **Memory in the routing prompt is currently more harmful than helpful in the runs measured
  here.** It suppresses the RAG branch on a question whose answer is in a document (CHAT 10/14
  with relevant memory), and it makes a counting question land on REST instead of SQL.
- No measurement in this document shows memory improving a routing decision that the base
  prompt would have got wrong. The one number that claimed otherwise is retracted.
- The mechanism is visible in the outcomes: with memory present the router increasingly chooses
  to ANSWER (CHAT) rather than to fetch, which is exactly what a block of remembered
  conversation sitting under "reply in text only when…" would encourage.
- The prompt placement compounds it: memory is rendered directly beneath *"Reply in text only
  when the question needs no data at all: … a message that refers to earlier turns."* A block of
  remembered conversation sitting under that instruction is an invitation to answer from memory
  instead of calling a tool.

**The likely fix is not to remove memory from routing but to change WHAT is injected.**

---

### Attempt 1 at that fix: filter the memory. It did NOT work.

`memoryForRouting` (`src/lib/memory-routing.ts`) strips run ids, timestamps, latencies, tool
narration and the chat-turn envelope from the memory before it reaches a ROUTING prompt, and
bounds it to 600 chars. Measured effect on the captured 2019-char real recall: **457 → 141
chars**. It is used by `selectToolWithLlm` and `routeQuery` only; the ANSWER prompts still get
the full text, because there a session id is harmless and dropping detail could cost the answer.

Then it was measured, with the same interleaved harness, 6-14 pairs per condition:

| question | expected | no memory | raw memory | filtered memory |
|---|---|---|---|---|
| greeting | CHAT | 6/6 | 6/6 | 6/6 |
| "how many documents are uploaded?" | SQL | **6/6** | 4/6 | 4/6 |
| "what is the primary distribution hub code?" | RAG | 0/6 | 1/6 | 0/6 |
| same, with RELEVANT memory (14 pairs) | RAG | 1/14 | 2/14 | 2/14 |

**Filtering changed nothing that matters.** It did not recover the counting question, and it did
not make the document question reach RAG. The last row is the most damning for the whole idea:
with memory that literally states *"HUB-99 is the code for the primary distribution hub"* — the
answer to the question — the router went to RAG only 2 times in 14, and in the FULL-memory case
it went to **CHAT 10/14**, i.e. it decided to answer from memory rather than from the document.

So the defect is NOT the noise in the text. Removing the noise left the behaviour intact. What
the raw-memory row shows is the real mechanism: **a block of remembered conversation in the
routing prompt makes the router treat the question as already answered.** That is a prompt-design
problem — where memory is placed and how it is framed relative to the "reply in text only when…"
rule — not a data-cleaning problem.

**What is actually established**, and what is not:

- Established: memory in the routing prompt shifts routing in BOTH directions, it is
  shape-sensitive, and it can suppress the RAG branch on a question whose answer is in a
  document.
- Established: filtering the text does not fix that.
- NOT established: that memory helps. The earlier 5/20 → 20/20 headline came from memory text
  written by the author of this note, containing the sentence "the answer came from the uploaded
  document" — a routing hint handed to the router by the test. **That number is retracted.**

The remaining candidate fixes are prompt-level (reframe memory as background rather than as an
answer, or move it out of the decision prompt into the answer step only).

---

### Attempt 2 at that fix: reframe it. Implemented; outcome INCONCLUSIVE.

`routingMemoryBlock()` now renders the filtered memory as explicit background:

```
Background from earlier conversations (NOT an answer to the current question, and
NOT a reason to skip a tool):
<body>
Use this only to understand what the user is referring to. If answering the current
question requires data — a document, a database, an API — call that tool even when the
background above looks like it already contains an answer.
```

The wording targets the measured mechanism directly: with memory present the selector
chose to ANSWER rather than fetch (CHAT 10/14), which is what a block whose own text reads
"The assistant replied …" invites when nothing says it is a record of PAST turns.

**Four DECISION points, not two.** Grepping every `memoryContext` interpolation rather than
trusting the two I had already found turned up two more, both decision prompts and both
still receiving RAW memory under a bare heading:

| site | kind | what it decides |
|---|---|---|
| `selectToolWithLlm` | decision | which single tool to call |
| `routeQuery` | decision | SQL / RAG / REST / CHAT |
| `planner.ts` (x2) | decision | which tools to run, and in what order |
| `agent-orchestrator` | decision | the ReAct loop: whether to call a tool or answer |

The last two are arguably more exposed than the first two. The planner decides how many
steps to emit — a planner that believes it already has the answer emits zero — and the
orchestrator's prompt says "Once you have sufficient evidence, provide a thorough, accurate
and grounded final answer" immediately above the memory block, so remembered conversation
reads as that evidence. All four now use the same shared block.

**Deliberately NOT framed**, because there memory IS content rather than evidence:
`generateSql` and `generateRestCall` (memory is an example of a query that worked), and
`generateAnswer` / `generateChat` / `streamAnswer` / `streamChat` (memory is material for
the answer). Those six sites keep the full unfiltered text and their existing headings;
framing them as "background, not an answer" would be wrong. The split is by ROLE — decision
prompt vs answer prompt — not by convenience.

**What was measured, and what was not.**

One run completed (N=10 per condition, three conditions interleaved) on the
document-answerable question whose answer WAS in the memory:

| condition | RAG (correct) |
|---|---|
| no memory | 0/10 — all SQL |
| with memory, this fixture | 8-10/10 |

That run is **not usable as a comparison between framings**, and the reason is recorded
rather than quietly dropped: both memory conditions were passed through
`routingMemoryBlock`, so it compared two memory TEXTS under the SAME framing. The
"old framing" branch of that probe was a harness bug, not a control.

The controlled comparison — identical memory body, framing A vs framing B, and a second
probe for whether the framing damages the greeting/SQL/RAG routes — **did not complete**.
Both runs died mid-test with no summary (the log ends inside an MCP stdio failure), the same
way standalone probes in this repo have failed before. They are not reported as results,
because a run that produced no summary produced no evidence.

**So this change ships UNVALIDATED on its own terms.** It is kept because:

- The framing is strictly more informative than the bare `Context from memory:` heading it
  replaces; it states what the block is and is not.
- It targets the one mechanism the completed runs did point at (the router answering instead
  of fetching).
- It changes no other rule — in particular the "a message that refers to earlier turns"
  clause is untouched, deliberately, because it is load-bearing for the CONTEXTUAL_CHAT
  branch and editing it in the same pass would confound any measurement.
- Its own tests cover the framing, the filtering, and the empty case.

It is NOT kept on a claim that it improves routing, because that was not established. The
table in "Attempt 1" is still the baseline; a future run must beat it, and the next
measurement needs a harness that survives to print a summary — run it through
`scripts/test.ts`-style isolation rather than a standalone probe.

### Attempt 2 measured: framing is NEUTRAL, and the harness mystery was mine, not the repo's

The measurement that "did not complete" now has, and its answer is that the framing changes
nothing. Interleaved pairs, identical memory body, only the wrapper differs:

| question (answer in a document) | old framing | new framing |
|---|---|---|
| "what is the primary distribution hub code?" | **14/15 RAG** | **14/15 RAG** |

Identical. The 320 extra characters of framing buy nothing measurable. It is kept because it
is harmless and makes the block self-describing, NOT because it helps — and anyone reaching
for a third prompt variant should know that two have now been measured at zero effect.

**Why the earlier runs died — and it was not the repository.** Three probes in a row had
ended with no summary, and the working hypothesis was "standalone probes are unreliable
here". That was wrong, and it was worth disproving rather than repeating: a diagnostic probe
with incremental markers completed 60 LLM calls in **379 seconds** with a clean summary, and
another completed 30 calls with `memoryContext` in 222s. The harness is fine.

The actual defect was in MY probes, and it is a one-line lesson: they wrote their results
**once, at the end**, so any interruption lost everything and left no evidence of how far they
got. Writing each observation as it happened fixed it — every measurement above was produced
that way. The earlier "inconclusive" verdict was accurate about the EVIDENCE but wrong about
the CAUSE, and the difference matters because it was one edit away from being fixable.

### Collateral damage: one case improved, one unchanged, and one pre-existing bug

Same fixture (memory about a distribution hub), 10 interleaved pairs per question:

| question | correct | without memory | with framed memory |
|---|---|---|---|
| greeting | CHAT | 10/10 | 10/10 |
| "how many documents are uploaded?" | SQL | **10/10** | **7/10** |
| "list the connected integrations" | SQL | **0/10** | **0/10** |

- The greeting is unaffected, which is the main thing to check when adding text to a prompt.
- The counting question ("how many documents are uploaded?") is pulled off SQL by memory
  3 times in 10. **But SQL is not the right answer for it either**, which I got wrong twice:
  the `sql` tool queries the CUSTOMER's connected databases
  (`unified-tools.ts`: "Query structured relational data from connected databases"), while
  "how many documents are uploaded" is a question about THIS APP's own knowledge base. There is
  no chat-path tool for that — `admin:list_integrations` and friends exist only for agentic +
  admin (counted earlier in this document), and no tool counts app documents at all. So the
  "expected SQL" column in that table encodes a wrong expectation, and the memory effect there
  is smaller than the table implies.
- Correcting that expectation shrinks the memory finding rather than growing it: the only case
  where memory demonstrably changes routing for the BETTER is the document-answerable question
  (0/10 → 14/15), and the only demonstrated harm is on questions whose expected answer was
  itself wrong. Memory's net effect is therefore best described as **unproven**, not as the
  "mixed but mostly harmful" I wrote earlier.
- **The third row is a MEASUREMENT ERROR OF MINE, not a defect.** I reported
  "list the connected integrations" routing wrongly 0/10 with memory off, as a pre-existing
  router bug. It is not: `getUnifiedTools` exposes `admin:list_integrations` ONLY for
  `context === 'agentic' && isAdmin`, and I asked the question through the CHAT path.
  Counted directly:

  | context | isAdmin | tools | has admin:list_integrations |
  |---|---|---|---|
  | chat | false | 5 | no |
  | chat | true | 5 | no |
  | agentic | false | 5 | no |
  | agentic | **true** | **16** | **yes** |

  So the router had no correct answer available to give, and 0/10 was the honest outcome for
  a question asked in the wrong place. The chat path deliberately excludes admin and plugin
  tools — the comment above that gate records why (7 of 8 ordinary questions pulled in
  irrelevant plugins on the chat path). Recorded as a retracted finding rather than deleted,
  because "I measured the wrong thing" is the reusable lesson.

Net: memory in the routing prompt is **mixed**, and no prompt-level variant measured so far
removes the cost without giving up the benefit (0/10 -> 14/15 on the document question).

**Two corrections to the test evidence for this change, both caught by re-reading rather
than by trusting a summary.**

1. The framing tests were briefly LOST. Editing the test file to remove an unused helper
   truncated everything after it, including the whole `routingMemoryBlock` describe, leaving
   the symbol imported but untested. The suite still reported PASS — fewer tests, no
   failures — which is exactly how a deleted test hides. Found by noticing the runner's file
   and test counts had DROPPED (266 -> 265 files, 6824 -> 6818 tests) and asking why instead
   of accepting a green run. Restored, and the counts are now accounted for: 265 is 268
   `*.test.ts` files minus the 3 integration files the runner skips; the missing file was the
   author's own temporary probe.
2. Negative-controlling the restored framing tests shows **only 1 of the 5** fails when the
   framing is reverted to the bare `Context from memory:` heading. The other four guard
   properties that are still worth guarding (filtering still applies, no memory means no
   block, the block is bounded, the preamble stays short) but they do NOT pin the framing.
   Stated because "5 tests cover the framing" would be false: one does.
