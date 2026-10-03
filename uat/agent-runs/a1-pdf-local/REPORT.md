# A1 — KNOWLEDGE (RAG) path, LOCAL PDF

Agent A1 · organization `zz-agent-knowledge` · app v2.1.0 · run 2026-10-03T14:47Z–15:24Z
Scope: upload PDF → chunk → embed → store → retrieve → answer with citations.

**Verdict: the pipeline ingests and reports success, but it does not answer a single question from the document.**
9/9 questions failed. 5 answered "not found" with **zero citations** while the answer text was verifiably present in the
stored chunks; 4 never completed (the dev server wedged at 14:52:46Z and stayed unresponsive for the rest of the run).
Only **45.6%** of the extracted text is searchable, and **no chunk holds a single pgvector embedding**.

---

## Environment

| | |
|---|---|
| Org id | `zz-agent-knowledge` (user `cmusi51b80001h8dgcep7yxaj`, role admin) |
| App | http://localhost:3000 · `/api/v1/health` → `{"ok":true,"service":"ryasai","version":"2.1.0"}` |
| Server | `next-server (v16.3.8)` dev, PID 2343929, started 21:43 local (14:43Z) |
| PDF | `test-data/coates.2025.book.1996.pdf` — 2,805,059 bytes, 501 pages |
| PDF title | *2025: Scenarios of U.S. and Global Society Reshaped by Science and Technology* (Coates, Mahaffie, Hines) |
| Upload | `POST /api/documents` → **201 in 1,660 ms**, doc id `cmusic67c002fh8l5pf7pk9gy` |
| Embed wall time | **5,096 ms** (poll: 61 ms → 12/500 embedded; 5,096 ms → 500/500) — far below the 5-minute allowance |
| Final counts | `chunkCount: 500`, `embeddedChunkCount: 500`, `status: "ready"`, `cognifyStatus: null` |
| Tooling note | `pdftotext`/`pdfinfo`/`mutool` not installed; used `pypdf 6.18.0` for independent extraction, plus the app's own `contentText` and `chunks` APIs |

**Gate cleared before upload (recorded, because it changes the starting state):** the first upload attempt returned
`503 SETUP_REQUIRED` — *"Choose where the knowledge base is stored before uploading documents."* This is a legitimate
first-run gate, not a bug. It was cleared through the product's own route, `PUT /api/vector-store {provider:"INTERNAL"}`
(the route the setup wizard and the Knowledge → Storage control use; it stamps `storageChosenAt`). No guard was
modified or bypassed.

---

## Results table

Expected values were taken from the extracted PDF text and confirmed present in the app's stored chunks before asking.
"Claims doc absent" = the answer asserts the document/evidence does not contain the material.

| # | Question (lang) | Expected (verified in PDF) | Actual (verbatim, trimmed) | Verdict | firstTokenMs | Citations |
|---|---|---|---|---|---|---|
| Q1 | "According to this document, what was the total world population projected for 2025, and what was World 2's share?" (EN) | Total 8.4 bn; World 2 = 5.1 bn. PDF p9 table; **present in chunk 5** (`Total5.6 billion8.4 billion … World 23.5 billion5.1 billion`) | "I could not find these figures in the retrieved evidence. …neither a projected total world population for 2025 nor a percentage share for World 2 appears in them." | **WRONG** (evidence was retrievable; answer says not found) | 7,784 | **0** |
| Q2 | "Who won the 2016 Nobel prize for the economics of information according to this document, and which university or institution is not mentioned?" (EN) | Lee and Richovsky. PDF p67 "Laureates Lee and Richovsky"; p74 timeline "2016 Nobel prize to Lee and Richovsky"; **present in chunks 169 & 184** | "I could not find an answer to either part … no 2016 Nobel economics laureate is identified anywhere in the evidence" | **WRONG** | 7,021 | **0** |
| Q3 | "Which think tank conducted the project this document came from, and where is it located?" (EN) | Coates and Jarratt, Inc., a Washington, D.C. think tank. PDF p11; **present in chunk 9** | "none of them names the think tank that carried out the project or states where it was located … I won't guess at either." | **WRONG** | 20,438 | **0** |
| Q4 | "What does the document say about the combined value of information technologies in an upscale home and car around 2025, compared with 1990?" (EN) | "$40,000 … compared with $5,000 in 1990". PDF p28; **split across chunks 91/92** | "the key sentence is cut off mid-word … today's upscale home and car have a 'com-…' before the text breaks off … the specific figure … does not appear in the evidence I retrieved." | **WRONG** | 6,388 | **0** |
| Q5 | "Which person is quoted at the start of the SMART LIVING chapter, and which company do they represent?" (EN) | Margaret Hunter-Chang, Housetex Corporation. PDF p24; **present in chunk 85** | "Saya tidak menemukan ini dalam dokumen yang terambil. …none of them include the opening quotation of that chapter or the name of the person and company it is attributed to." | **WRONG** | 5,203 | **0** |
| Q6 | "What was the full-time work week reduced to by the Reduced Time Act of 2000, and what did the later amendment reduce it to?" (EN) | 36 hours, then amended to 34 hours (PDF p475) — **beyond the 45.6% indexing cutoff, so unanswerable by design** | *(empty)* `error: "stream read threw: AbortError: The operation was aborted."` | **NO ANSWER** (request aborted at 175 s) | `null` | 0 |
| Q7 | "Who received the 2018 Nobel Prize in economics for reorganizing work categories, and in what year did the Census Bureau and Bureau of Labor Statistics adopt their system?" (EN) | Smith and Garcia; adopted 1999 (PDF p478) — beyond cutoff | *(empty)* `harness threw: TimeoutError: The operation timed out.` | **NO ANSWER** (server already wedged) | `null` | 0 |
| Q8 | "Bagaimana dokumen ini membagi populasi dunia menjadi beberapa kelompok, dan apa nama masing-masing kelompok?" (ID) | World 1 (affluent: Europe/US/Japan), World 2 (middle), World 3 (destitute). PDF p8; **present in chunk 1** | *(empty)* `TimeoutError` | **NO ANSWER** | `null` | 0 |
| Q9 | "Organisasi apa yang dibentuk di Munich pada tahun 2000 untuk mengoordinasikan upaya global melawan pemanasan global, dan apa singkatan namanya?" (ID) | International Global Warming Federation (IGWF), Munich 2000. PDF p125 | *(empty)* `TimeoutError` | **NO ANSWER** | `null` | 0 |
| X1 | "What is the exact date of birth of the author Joseph F. Coates, and at which university did he earn his doctorate?" (EN) | **Not in the PDF** — must decline, must not fabricate | *(not reached — server wedged)* | **NOT TESTED** | — | — |
| X2 | "Berapa harga ritel buku ini dan apa nomor ISBN-nya?" (ID) | **Not in the PDF** — must decline, must not fabricate | *(not reached — server wedged)* | **NOT TESTED** | — | — |

**Fabrication check:** no answer fabricated a fact. Every answer that produced text returned "not found". That is the
one thing the path did get right, and it is worth stating plainly — the failure mode here is silence, not invention.

**No answer claimed the document does not exist.** The "claims doc absent" failure class did not occur; the answers
said the *evidence* was not retrieved, and in Q3/Q5 they even referred to the source correctly by filename.

**Retrieval quality vs language:** Q1–Q5 (EN, from the indexed 45.6%) all failed identically with 0 citations.
Q8/Q9 (ID, from the indexed 45.6%) could not be measured because the server was down by then, so this run provides
**no evidence that Indonesian degrades retrieval** — the English results were already at the floor. Q6 (EN, beyond the
cutoff) hung instead of answering. Language is not the differentiator here; index coverage and the wedge are.

---

## Findings

### F1 — BLOCKER: `DocumentChunk.embedding` is empty for every chunk; the doc reports "fully embedded"

**Evidence (read-only, from Postgres):**

```
$ psql -tA -F'|' -c "SELECT count(*), count(embedding), count(\"embeddingJson\"), count(\"embeddingModel\"), min(\"embeddingModel\") FROM \"DocumentChunk\" WHERE \"documentId\"='cmusic67c002fh8l5pf7pk9gy';"
500|0|500|500|uat-deterministic-1536
```

500 chunks, **0 with a pgvector `embedding`**, 500 with `embeddingJson`. The completeness field is defined against the
*other* column — `src/app/api/documents/route.ts:96`:
`embeddedChunkCount: d.chunks.filter((c) => c.embeddingJson !== null).length`. So `GET /api/documents` reports
`embeddedChunkCount: 500 == chunkCount: 500` and `waitEmbedded()` returns `ok: true` while the vector column is
entirely empty. Re-measured 15 minutes after ingestion — still 0.

**Cause, from the server's own log (emitted once, then suppressed by `_dimensionWarned`):**

```
[embeddings] embedding model returns 1536 dims but DocumentChunk.embedding is vector(384). Storing embeddingJson only — pgvector search is disabled until the column matches. Fix with:
  ALTER TABLE "DocumentChunk" DROP COLUMN embedding;
  ALTER TABLE "DocumentChunk" ADD COLUMN embedding vector(1536);
```

Chain: the org's embedding model is `uat-deterministic-1536` at `http://localhost:4502/v1`, which really does return
**1536** dims (verified by direct `POST /v1/embeddings`). The column is `vector(384)` (`GET /api/vector-store` →
`storedVectorSize: 384`; `prisma/schema.prisma:279` → `Unsupported("vector(384)")`). `canWriteVectorColumn()`
(`src/lib/embeddings.ts:304`) therefore takes the `embeddingJson`-only branch on **every** write.

This is by design and documented — `prisma/schema.prisma:274-277` states the mismatch "does NOT error … retrieval
then silently degrades to lexical-only ranking". So the semantic leg is legitimately inert here. **The defect is not
that the vector is missing; it is that nothing in the API, the UI, or `waitEmbedded` distinguishes "vectorised" from
"JSON only".** `embeddedChunkCount` is a proxy for a column that a different code path writes. Severity is BLOCKER
because this is exactly the "status meaning 'accepted' read as 'ready'" class the repo documents, and a reader of
`GET /api/documents` would conclude semantic search is live when it contributes nothing.

Note the API *does* surface the mismatch elsewhere: `GET /api/vector-store` returns
`embeddingStampVerdict: "mismatch"` (stored model `paraphrase-multilingual-MiniLM-L12-v2` vs configured
`uat-deterministic-1536`). The two endpoints disagree about health. **Reproducible: yes** — deterministic from a
1536-dim embedder + `vector(384)` column.

### F2 — BLOCKER: only 45.6% of the extracted document is indexed; the API calls the document `ready`

Measured against the app's **own** `contentText` (fetched from `GET /api/documents/{id}`), not my extractor:

```
contentText chars        = 1136715
stored chunks            = 500
stored chunk chars       = 585027
LAST chunk tail found in contentText at offset 518099 of 1136715
=> coverage fraction      = 45.6%
=> unindexed tail chars   = 618536
```

The cutoff is a hard 500-chunk cap in the upload route — `src/app/api/documents/route.ts:252` `const MAX_CHUNKS = 500`,
passed to `chunkText(contentText, { maxChunks: MAX_CHUNKS })`, which returns early once 500 chunks exist
(`src/lib/rag-chunking.ts:82`). The content cap above it is 2,000,000 chars, so this document passes that gate and is
silently half-truncated. `MAX_EXTRACTED_TEXT_CHARS` is never reached; `MAX_CHUNKS` is what bites.

Three independent checks that the tail is genuinely absent, not merely mis-ordered: `pdf-raw.txt` (my extraction)
contains "Reduced TimeAct of 2000" at **94.8%** of the text and "34 hours"; neither string exists anywhere in the 500
stored chunks. Same for "Smith and Garcia … received the Nobel". The document still reports `status: "ready"`,
`isEnabled: true`, `chunkCount: 500`, `embeddedChunkCount: 500` with **no truncation flag, no partial flag, no warning**
in the response. A user asking about the last ~55% of the book gets "I could not find this in the retrieved evidence"
for content the install believes it has ingested. **Reproducible: yes** for any document exceeding 500 chunks.

The repo's own `AGENTS.md` verification ritual for this area ("confirm: chunkCount > 100") is satisfied by a
truncated corpus — 500 > 100 passes while 55% of the book is missing. That is a guard that cannot fail.

### F3 — MAJOR: answers say "not found" with zero citations for text that is present in the stored chunks

Q1–Q5 ask for facts that are in chunks 5, 9, 85, 91/92 — verified by substring-matching the stored chunk text
(`app-chunks-flat.txt`), which is the exact corpus retrieval reads. All five returned **0 citations** and a
"not found" answer. Streaming itself was healthy (`firstTokenMs` 5,203–20,438 ms, all `HTTP 200`, no SSE `error`
event), so this is a retrieval/ranking failure, not a transport one.

Q2 and Q3 are the strongest evidence, because the model's reasoning shows it looking straight at chunks that do not
contain the phrase while chunks 169/184 and 9 — which do — were never surfaced: Q2 names "the other two chunks deal
with asteroid watching, moon mining, and the phases of the Information Age"; Q3 says "I looked through all three
chunks". With the semantic leg inert (F1) retrieval is lexical-only, and the corpus it searches is a **scrambled,
column-interleaved** rendering of the page (F4) — so a phrase like "Lee and Richovsky" sits fragmented and never
matches. The model was handed 3 chunks of noise and correctly reported it had nothing.

I could not isolate F3 from F4/F1 offline because retrieval is only reachable over HTTP and the server was wedged;
the causal attribution above is inferred from the chunk text, not from a captured retrieval trace. What is certain:
**the answer text was in the store and the system returned nothing.** **Reproducible: yes** (5/5 identical).

### F4 — MAJOR: the PDF extraction scrambles reading order, interleaving columns across the page

The word inventory is intact (0.85% of ≥5-char words absent vs my extraction) but the **order is not**. Distinct
symptoms, all measured against `pdf-raw.txt`:

- **Sentence integrity: 1,662/4,478 = 37.1%** of sampled sentences survive intact in the app's `contentText`.
- **Word-pair adjacency: 32,820/35,984 = 91.2%** — the loss is not deletion but local reordering.
- **Column interleaving.** App `contentText`: `"These four drivers of information technology, materials technology, genetics, and energy technology."` The PDF reads `"These four drivers of change are information technology, materials technology, genetics, and energy technology."` The words are all present; the fragment `"of change are"` has been pushed **150+ characters away**. Another: `"…for insurers, who have had to come up with locked-tight contracts for the retailer of more risky sports. Government policy week to 34 hours."` — the middle of the sentence (`"for reducing unemployment has led to mandates for shorter workweeks. The Reduced TimeAct of 2000 reduced the full-time work week to 36 hours. Ten years later the act was amended to further reduced the work"`) is displaced elsewhere on the page.
- **Word-joining.** `"Reduced Time Act"` is stored as `"Reduced TimeAct"` and `"information and communications technology"` as `"information to net communicationstechnology"` — spaces are dropped where the PDF splits a word across a text-run boundary, so exact-phrase search for the correct name fails even inside the indexed region.

The route is explicit that there is no fallback: `AGENTS.md` invariant #4, `document-parsers.ts` never "falls back"
to dumping printable ASCII. `extractPdfTextFromBuffer` is a content-stream scanner that concatenates text operators
in stream order (`src/lib/document-parsers.ts:26-76`) with no page layout reconstruction, so reading order is whatever
order the operator's drawing commands appear in — which for a two-column PageMaker book is not reading order.

The user-visible consequence is in Q4's answer verbatim: *"the key sentence is cut off mid-word … have a 'com-…'
before the text breaks off."* **16 of 500 chunks end mid-word** (trailing hyphen with no wrap — idx 7, 15, 45, 71,
126, 142, 188, 253, 266, 302, 349, 392, 437, 449, 462, 467) and **322 of 500 chunks begin with a lower-case
fragment**, i.e. most chunk boundaries fall inside a word or mid-sentence. **Reproducible: yes.**

### F5 — BLOCKER: dev server wedged during the run and never recovered (livelock, ~97% of one core)

**Timeline (exact):**

| UTC | Event |
|---|---|
| 14:48:54 | upload accepted (201) |
| 14:48:58 | embedding done (500/500), KG extraction starts (`document-kg`, concurrency 5) |
| 14:49–14:52 | `entity-relation extraction failed` every ~6 s — 43 warnings; 35 `kg-extract: provider returned an EMPTY completion after 4 attempts` |
| 14:52:43 | last log line: second `kg-extract` empty completion |
| **14:52:46** | **last write to `dev.log` — server goes silent** |
| 14:52:45 | Q5 completes (5,203 ms FT) |
| 14:55:38 | Q6 starts → aborted at 175 s |
| 15:08–15:19 | Q7, Q8, Q9 each time out at 350 s |
| 15:24 | still unresponsive |

**Measured state of PID 2343929 (`next-server v16.3.8`), 15:19–15:24Z:**

- Main thread tid 2343929 state **`R`** (running), wchan `0`, `utime` 152,803 ticks; re-sampled three times at
  **98% / 96% / 96% of one core** — an in-process livelock, not a blocked wait and not CPU starvation.
- Listener `*:3000` **`Recv-Q` climbing 333 → 358 → 363 → 426 → 482 → 512** while nothing is accepted; the
  accept backlog is saturated. `CLOSE-WAIT`/`FIN-WAIT-2` sockets accumulate.
- **No log output at all** after 14:52:46 (31 minutes of silence), so the loop emits nothing.
- Dependencies are all healthy: Postgres up (I read `DocumentChunk` from `psql` throughout), Redis up (`dbsize` 256),
  LLM gateway `:20128/v1/models` → `200 in 0.22 s`, embedder `:4502` responds. **The wedge is in the app process.**
- Redis failing residue: `bull:memory-write:failed = 208`; the log carries **381** `memory write failed … cognee
  server unreachable or rejected the write` warnings; `COGNEE_SERVER_URL=http://127.0.0.1:8099` — I confirmed nothing
  listens on 8099 (`curl` → connection refused). So the memory worker retried a dead sidecar 381 times while the
  kg-extract storm (43 failures, each retrying an empty LLM completion up to 4 times) ran on the same event loop.

I did **not** restart, kill, or alter the server: it is shared with seven other agents, and I was explicitly told not
to start anything. The wedge was still present at the last check (15:27:41Z, 35 minutes after onset): health
timed out, the same PID 2343929 was still the listener at 80.3% CPU in state `Rl`, and the accept backlog had reached
the listen-queue cap (`Recv-Q 512` against a max of 511). **F5 blocked Q7–Q9 and both out-of-PDF questions (X1, X2)**
from being tested, and **the server is still wedged for whoever picks this environment up next** — the first thing
any subsequent agent needs is for that process to be restarted. **Reproducible: not established** — F5 happened once, and I could
not retry it without disrupting the shared environment. Whether the trigger is the KG-extract storm, the cognee
retry loop, or their interaction is **not determined**.

The KG-extraction storm itself is a separate defect worth its own ticket. The upload fires
`mapWithConcurrency(persistedChunks, 5, indexChunkKnowledgeGraph)` over all 500 chunks, i.e. **500 extraction calls**
(one `extractEntitiesRelations` per chunk, `src/lib/knowledge-graph.ts:116-124`), each of which retries an empty
completion up to **4 times** — so up to 2,000 LLM requests. In this run it produced **43 `entity-relation extraction
failed` warnings and 35 `kg-extract: provider returned an EMPTY completion after 4 attempts`** lines inside ~3 minutes,
and the resulting graph covers **17 of 500 chunks** (52 `KgRelation` rows over 17 distinct `chunkId`s for my org —
**3.4% coverage**). Every exhausted retry logs a `warn` and nothing else: `indexChunkKnowledgeGraph` catches
everything, the document is never marked as having failed KG extraction, and no API field reports graph coverage.

### F6 — MINOR: `cognifyStatus` is `null`, not a status, so the ingestion report cannot say what happened

`GET /api/documents` returns `"cognifyStatus": null` for this document while `status: "ready"`. The DTO does select and
map `cognifyStatus`/`cognifyError` (`src/app/api/documents/route.ts:73-80`), so the `null` is the stored value, not a
field lost in the middle. Because `null` cannot be distinguished from "not attempted" or "not configured", a reader
cannot tell whether cognify ran and did nothing, never ran, or is disabled. Given F5's 381 cognee-unreachable warnings,
this field is exactly where that failure should have surfaced. **Reproducible: yes.**

### F7 — MINOR: the pre-existing org's rows are unscoped in the vector-store health read, cross-org data appears in the response

`GET /api/vector-store` for `zz-agent-knowledge` returned stored-embedding facts belonging to a **different
organization**: `storedVectorSize: 384`, `storedEmbeddingModel: "paraphrase-multilingual-MiniLM-L12-v2"`. My org has
**0 rows in the `embedding` column** (F1, all 500 chunks are JSON-only), so 384/`MiniLM` cannot describe my data — it
describes the only other org in the database, `cmsst1wd20000h8h2k8bp70s4` (55 vectorised chunks, 384 dims,
`paraphrase-multilingual-MiniLM-L12-v2`). `readStoredEmbeddingFacts()` (`src/app/api/vector-store/route.ts`) uses
`db.$queryRaw` with no `organizationId` predicate, and the tenant extension only intercepts Prisma model operations
(`$allOperations` over an ORG_SCOPED_MODELS set, `src/lib/prisma-tenant.ts:212`) — raw SQL is passed through
unscoped. This is **read-only exposure of embedding metadata** (no vector, no text, no ids returned), and it is
diagnostic rather than business data, hence MINOR not MAJOR. It also means the panel's dimension/stamp warning can
describe another tenant's corpus. **Reproducible: yes**, unconditional on any query.

### F8 — MINOR: the upload-time completeness signal is racy and the reported state is ambiguous

The upload response returns `status: "ready"` and `chunkCount: 500` **1,660 ms before any embedding exists**
(`src/app/api/documents/route.ts:241` sets `status: 'ready'` at upload). At the first poll (61 ms after upload) the
same document reported `embeddedChunkCount: 12 / 500` with `status: "ready"` and no error. The repo knows this and says
so in a code comment, and `embeddedChunkCount` is the documented mitigation — but a caller reading only `status` is
told "ready" while 2.4% of the corpus is vectorised. Not a correctness bug on its own (it is documented, and
retrieval does search the 12 chunks it has); recorded because it is the same "accepted read as ready" shape as F1, and
F1 shows the mitigation can itself be misleading. **Reproducible: yes** (the 12/500 state was observed directly).

---

## What worked

Stated plainly, because a report of nine failures should not imply nothing functioned:

- **Upload, extraction, chunking, persistence and FTS indexing are sound.** `POST /api/documents` → 201 in 1,660 ms
  for a 2.7 MB / 501-page book; 500 chunks persisted; all 500 have populated `tsv` (`count(tsv) = 500`), and
  `to_tsvector` search finds the right chunks (e.g. `plainto_tsquery('simple','Jarratt')` → 1 hit, `'Housetex'` → 1
  hit, `'Reduced'` → 24 hits). The 500-chunk truncation (F2) and scrambled order (F4) are the chunker/parser's
  doing, not a persistence failure.
- **The storage gate failed closed, correctly.** Uploading before a storage choice returned `503 SETUP_REQUIRED` with
  an actionable hint, and the refusal was placed *before* extraction/embedding, so the refused upload cost nothing.
- **Embedding throughput is fine and the progress signal works.** 500 chunks in 5,096 ms, with `waitEmbedded()`
  reporting honestly at each step (12/500 → 500/500).
- **The model did not fabricate.** All five answers that produced text declined to invent an answer, one of them
  explicitly reasoning "I won't guess at either". Citation count is 0 rather than a wrong citation.
- **Streaming transport was healthy** while the server had capacity: HTTP 200, correct SSE event sequence
  (`user_message, thinking, tool_start, tool_end, token, answer, done`), 4/5 answers with a first token under 8 s.

---

## Not verified

| | Why |
|---|---|
| **X1 / X2 — the two out-of-PDF questions** | Never reached: the server wedged at 14:52:46Z, before they were asked. The not-in-PDF *dataset* is prepared and verified absent from the whole PDF text (`ISBN` 0 hits, `retail price` 0 hits, `$29` 0 hits, no birth date or doctorate for Coates), but the **fabrication-refusal behaviour is untested**. Confirmed only indirectly: the five answers that did run fabricated nothing. |
| **Q8 / Q9 — the Indonesian questions** | Same wedge. My prompt's step 5 (does retrieval degrade in Indonesian vs English?) therefore has **no measurement**. The English arm provides no usable baseline either — it was already at the floor (0 citations, "not found"), so a language effect would be invisible even if present. |
| **Semantic retrieval, as distinct from lexical** | Untestable in this environment: the embedding model returns 1536 dims against a `vector(384)` column, so the vector leg is *structurally* inert for every document in this install (F1). Any measurement of recall here is a lexical-only measurement. The cause is the harness's embedder/column pairing, not necessarily a production-typical configuration — but the reporting defect (F1) is real regardless of which side is "wrong". |
| **Whether F5 is reproducible, and its trigger** | One occurrence, on the shared dev server, which I was not permitted to restart. The 43-failure kg-extract storm and the 381 cognee-unreachable retries are correlated in time but I did not isolate a cause; no stack trace was ever logged. |
| **Cognify / knowledge-graph quality** | `cognifyStatus` is `null` (F6) and the cognify sidecar at `:8099` was unreachable for the whole run (381 warnings), so there is nothing to evaluate. 52 `KgRelation` rows exist for my org, but 43 extraction attempts failed — a partial, unmeasured graph. |
| **Reranker / reflection behaviour** | Could not capture a retrieval trace; the endpoints that would expose it hung (F5), and I could not confirm whether reflection's "evidence insufficient" pass altered the Q1–Q5 answers. |
| **F3's exact cause** | Confirmed as a *retrieval* failure (0 citations, text present in the store) and plausibly caused by F1 + F4, but the causal split between "no semantic leg", "scrambled corpus", and "ranking/relevance" is **inferred, not measured**. |

---

## Reproduction

Artifacts in `uat/agent-runs/a1-pdf-local/`: `ingest.json` (raw upload + every poll), `answers.json` (every question,
verbatim answer, timing, events, citations), `content-text.txt` (app-extracted text), `app-chunks.json` +
`app-chunks-flat.txt` (all 500 stored chunks), `pdf-raw.txt` (independent pypdf extraction), `find.py` (grep-with-
context over PDF pages), and the numbered scripts `00`–`09` that produced each step.

Commands (run from the repo root with `set -a && . ./.env && set +a`):

```bash
PUT  /api/vector-store  {"provider":"INTERNAL"}                  # first-run storage gate; 200
POST /api/documents     multipart file=test-data/coates.2025.book.1996.pdf   # 201, 1660 ms
GET  /api/documents                                              # chunkCount 500, embeddedChunkCount 500, status ready
GET  /api/documents/cmusic67c002fh8l5pf7pk9gy                     # contentText 1,136,715 chars
GET  /api/documents/cmusic67c002fh8l5pf7pk9gy/chunks?page=N       # 500 chunks, 20/page
POST /api/chat/sessions/{id}/send  {"text":"…"}                   # SSE; 200 but 0 citations
```

```
psql: SELECT count(*), count(embedding), count("embeddingJson")        # 500|0|500   -> F1
      SELECT count(tsv)                                                # 500         -> FTS is fine
      SELECT format_type(...)                                          # vector(384) -> F1
curl:  POST http://localhost:4502/v1/embeddings                        # 1536 dims   -> F1
```
