# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.0] - 2026-10-03

### Latency: the retrieval no longer waits for the routing verdict

**Median time to first token 7.8 s -> 5.5 s on document questions (-31%), and the compound question
improved from 5/8 to 8/8 correct.** No accuracy loss anywhere else: the full evaluation is 63/63,
the best it has ever measured.

**What the 8 seconds was.** Decomposed from 36 document turns: [intent analysis + tool selection]
2.3 s (already overlapped), then retrieval + rerank 2.2 s, then the sufficiency reflection 1.7 s,
then the answer's first token 2.2 s. The middle stages waited for a routing verdict they never read —
`retrieveWithReflection` takes the question and the document scope, nothing else.

**Retrieval now starts alongside intent analysis** (`speculative-retrieval.ts`). A turn routes to SQL
or chat instead? The retrieval is cancelled — and cancellation reaches INTO the retrieval, so an
unused turn does not pay for the rerank either. That depth mattered: the first version only checked
between stages, so an unused rerank still ran (3.1-3.6 s), and the compound/DAG path measured
**slower** with speculation on (22.5 s -> 46.7 s median). Measured again after the fix: 43.2 s -> 23.0 s
on the same path, and SQL turns are level (9.248 s -> 9.245 s, i.e. inside the noise).

**The price, stated:** a turn that routes away spends a retrieval, and its rerank unless the cancel
beats it there (MEASURED: the rerank still fires on about half of them). `SPECULATIVE_RETRIEVAL=false`
restores the serial order.

**Scope safety, not assumed:** a speculative result is reused only for the exact request it was
started for — same question, same `topK`, same document scope (order-insensitive). A mismatch
discards it and runs a fresh retrieval, because serving a result from another scope would be a
cross-context leak with no error to find. A cancelled retrieval is never reused either: the branch
runs the real one rather than re-throwing an AbortError into its degrade-to-chat handling.

**Also in this release**

- Two coverage floors the PR #45 merge left behind: the pull request's new tests were committed while
  the floors they earn were not (the merge resolved `coverage-gate.ts` to dev's side), leaving
  `mcp-client.ts` floored at 51 against a measured 84.50% and `plugin-registry.ts` at 65 against
  77.08%. `coverage-floor-consistency.test.ts` — which refuses to let a floor stop guarding — caught it.
- `intent-pipeline.ts`'s floor re-derived 64 -> 63: the module gained the `signal` plumbing, so the
  denominator moved 574 -> 609 while hits rose 373 -> 388.

### Verified
- tsc 0 · lint 0 errors · 323 files, 7,983 pass, 0 fail · coverage gate OK (209 modules) · build ·
  e2e 19 · e2e:prod 19 · evaluation **63/63** (was 61/63), first-token median 5.7 s, p95 46.1 s.
- Every new guard negative-controlled with both directions observed. One control **failed to fail**
  (the inner-retrieval signal threading had no test), and one wiring guard was absent entirely (the
  non-streaming transport) — both were found by running the controls and are now covered.
- 19 new tests across three modules; `speculative-retrieval.ts` gated at 68% against a measured 68.63%.

## [2.1.0] - 2026-10-03

### Latency: the retrieval no longer waits for the routing verdict

**Median time to first token 7.8 s -> 5.5 s on document questions (-31%), and the compound question
improved from 5/8 to 8/8 correct.** No accuracy loss anywhere else: the full evaluation is 63/63,
the best it has ever measured.

**What the 8 seconds was.** Decomposed from 36 document turns: [intent analysis + tool selection]
2.3 s (already overlapped), then retrieval + rerank 2.2 s, then the sufficiency reflection 1.7 s,
then the answer's first token 2.2 s. The middle stages waited for a routing verdict they never read —
`retrieveWithReflection` takes the question and the document scope, nothing else.

**Retrieval now starts alongside intent analysis** (`speculative-retrieval.ts`). A turn routes to SQL
or chat instead? The retrieval is cancelled — and cancellation reaches INTO the retrieval, so an
unused turn does not pay for the rerank either. That depth mattered: the first version only checked
between stages, so an unused rerank still ran (3.1-3.6 s), and the compound/DAG path measured
**slower** with speculation on (22.5 s -> 46.7 s median). Measured again after the fix: 43.2 s -> 23.0 s
on the same path, and SQL turns are level (9.248 s -> 9.245 s, i.e. inside the noise).

**The price, stated:** a turn that routes away spends a retrieval, and its rerank unless the cancel
beats it there (MEASURED: the rerank still fires on about half of them). `SPECULATIVE_RETRIEVAL=false`
restores the serial order.

**Scope safety, not assumed:** a speculative result is reused only for the exact request it was
started for — same question, same `topK`, same document scope (order-insensitive). A mismatch
discards it and runs a fresh retrieval, because serving a result from another scope would be a
cross-context leak with no error to find. A cancelled retrieval is never reused either: the branch
runs the real one rather than re-throwing an AbortError into its degrade-to-chat handling.

**Also in this release**

- Two coverage floors the PR #45 merge left behind: the pull request's new tests were committed while
  the floors they earn were not (the merge resolved `coverage-gate.ts` to dev's side), leaving
  `mcp-client.ts` floored at 51 against a measured 84.50% and `plugin-registry.ts` at 65 against
  77.08%. `coverage-floor-consistency.test.ts` — which refuses to let a floor stop guarding — caught it.
- `intent-pipeline.ts`'s floor re-derived 64 -> 63: the module gained the `signal` plumbing, so the
  denominator moved 574 -> 609 while hits rose 373 -> 388.

### Verified
- tsc 0 · lint 0 errors · 323 files, 7,983 pass, 0 fail · coverage gate OK (209 modules) · build ·
  e2e 19 · e2e:prod 19 · evaluation **63/63** (was 61/63), first-token median 5.7 s, p95 46.1 s.
- Every new guard negative-controlled with both directions observed. One control **failed to fail**
  (the inner-retrieval signal threading had no test), and one wiring guard was absent entirely (the
  non-streaming transport) — both were found by running the controls and are now covered.
- 19 new tests across three modules; `speculative-retrieval.ts` gated at 68% against a measured 68.63%.

## [2.0.0] - 2026-10-03

### Security architecture (why this is a major)

Six streams, built in parallel, each verified by an independent integration review before landing.
That review found three real defects in the first pass — a script that crashed on a live database its
tests modelled as a fantasy catalog, a "distributed" limiter that never reached Redis because of the
Edge runtime, and a verifier that exited 0 on the one case it existed to catch. All three are fixed
with the measurement recorded.

**1. A stuck memory sidecar can no longer pile jobs unbounded.** Past 1,000 pending writes (counting
retries in backoff, the signature of an outage), new writes are dropped with a logged reason — not
queued, not run inline. About 3,600 jobs an hour would otherwise accumulate, each carrying two
message bodies.

**2. The expensive LLM routes now share one rate-limit counter in Redis.** `next dev`'s middleware
runs on the Edge runtime, where `node:net` is stubbed out — the Redis client could never connect, so
the shared counter silently degraded to the per-instance bucket while shipping ~700 KB of dead
ioredis. The middleware now declares `runtime = 'nodejs'`; MEASURED: the same 22-request burst went
from per-instance 429s to a Redis `ratelimit:*` key appearing and the limit enforced once. Redis down
falls back to the in-memory bucket, which still bounds a single instance.

**3. The audit log is now tamper-evident.** `scripts/verify-audit-chain.ts` re-derives a SHA-256
chain over each organization's AuditLog and compares it against a stored snapshot; any edited or
deleted row changes every subsequent hash. Exit codes are the contract: tamper, growth, a stale
snapshot and a malformed snapshot all exit 1. An empty-log baseline used to exit 0 on the first
appended row — found by review, fixed, and measured exiting 1.

**4. Opt-in PostgreSQL row-level security.** `scripts/enable-rls.ts` enables and forces RLS with a
per-table policy on every table carrying `organizationId`, discovered from the database rather than
hardcoded. Report mode by default; `--apply` and `--drop` are explicit. The first version crashed in
report mode on a real Postgres — `IN (${array})` binds as one parameter and `information_schema.tables`
has no `table_owner` column — because its unit test modelled a catalog that does not exist. Both are
fixed and the test now fails if the query regresses. ADR-0009 records why RLS is opt-in: the Prisma
pool cannot set a per-request GUC without a connection-per-request.

**5. Per-organization daily token and request budgets.** `ORG_DAILY_TOKEN_BUDGET` and
`ORG_DAILY_REQUEST_BUDGET` cap an organization's aggregate LLM usage from LlmUsageLog, with a 5-second
cache so a turn's burst does not re-query. Unset means unlimited and performs NO database call at all —
the hot path stays free.

**6. A consolidated tool-policy layer.** `evaluateToolPolicy` returns an ALLOW/DENY decision with a
reason for every requested action — the primary plus each extra source a compound question asked
for — distinguishing "source absent" from "tool toggled off". Behaviour-compatible with the existing
`applyToolGating` across a 32-case cross-product; the router does not consult it yet, so adoption is
a deliberate follow-up rather than a silent behaviour change.

### Also in this release

- `SECURITY.md` no longer names a version line (it said `0.4.x` through the entire 1.x series).
- Four ADRs record decisions that previously lived only in comments: tenant isolation (0009), MCP
  isolation limits (0010), dependency security as invariants (0011), rate limiting (0012).
- `install.sh` accepts `APP_IMAGE`/`SCHEDULER_IMAGE`/`EMBEDDINGS_IMAGE` for digest pinning;
  byte-identical when unset.
- MCP sandbox directory sizing uses a native fs walk instead of `execSync('du -sb')`.
- PR #45 merged: UI fixes, orphaned smartRoute helper cleanup, and new tests for mcp-client resources
  and plugin-registry stdio. Its dropped `allowIds` scoping was restored — that removal would have
  reopened the API-key cross-scope leak the filter exists to close.

### Verified
- tsc 0 · lint 0 errors · 322 files, 7,938 pass, 0 fail · coverage gate OK (208 modules) · build ·
  **e2e 19 and e2e:prod 19** (after an environment failure was diagnosed to a zombie server on port
  3000 stealing BullMQ jobs with the wrong DATABASE_URL — reproduced, killed, and both suites green).
- Evaluation 61/63; both misses are `majemuk-dok-db`, measured at 60% across 45 historical samples.

## [1.7.10] - 2026-10-02

### Fixed
Four weaknesses from an external review, each first verified against the code — of the review's fourteen
claims, eight did not survive measurement (a cited SQL bypass was blocked when actually run; a "type
safety gap" typechecked clean), and these four did. Fixes, each negative-controlled:

- **A stuck memory sidecar can no longer pile jobs unbounded.** The write queue drains at one job per
  process while a write takes 45-148s, so with cognee down every chat turn kept adding to a queue nothing
  drained — about 3,600 jobs an hour, each carrying two message bodies, on a queue whose own doc calls
  memory optional. Past 1,000 pending (counting retries in backoff, the signature of an outage) new
  writes are now dropped with a logged reason, not queued and not run inline — inline would fire one
  more HTTP call per turn at a sidecar that is not answering.
- **A missing org context now fails with an error naming the cause.** Seventeen call sites wrote
  `getOrgContext()!`, whose failure mode is a TypeError that names neither the org nor the fix.
  `requireOrgContext()` throws an error that says both. The change exposed that seven router tests and
  ten other harnesses had never established an org at all — the `!` had been writing
  `organizationId: undefined` into their mocks silently.
- **The SQL repair loop counts the clock, not just attempts.** One attempt is an LLM call plus a query,
  ~30s each, so a third attempt could begin at t=100s on a turn whose 120s deadline was spent — the user
  got a timeout instead of the failure the branch had already diagnosed. A retry now only starts when a
  full attempt's worst case still fits. The first version of the guard test passed with the check
  deleted: its first attempt succeeded, so no retry was ever attempted either way.
- **A failed retrieval is now recorded, not silent.** The RAG→CHAT fallback left a plain CHAT tool run,
  indistinguishable from a turn that never wanted documents — a policy question during a knowledge
  outage got an un-cited answer with no way to tell why. The run now carries `DEGRADED from RAG` and the
  failure reason. An EMPTY retrieval is deliberately not marked: a small corpus is a legitimate chat
  answer, and labelling it degraded would cry wolf.

### Verified
- 315 files, 7,733 pass, 0 fail · coverage gate OK (204 modules) · build · e2e 19 · e2e:prod 19.
- Evaluation 62/63; the single miss is the compound doc+db question, measured historically at 22/34 —
  an A/B at n=8 gave 6/8 (old) vs 5/8 (new), inside that question's own noise.

## [1.7.9] - 2026-10-02

### Fixed
- **The knowledge-graph scan now survives a graph that grows.** The entity lookup ran an infix pattern
  (`%token%`) against btree indexes that cannot serve infix matches, so the scan was proportional to the number
  of relations — measured at one million rows with a selective token: **502 ms without an index, 0.054 ms with
  one**. Two trigram indexes are created at startup like the existing full-text one, and the query is now written
  as one condition per pattern, because the previous `ILIKE ANY` form is never converted to an index scan by the
  planner — the indexes would have existed and done nothing.
- **The REST router prompt was the one prompt that grew without limit.** Every enabled endpoint of every active
  connector was listed with its full sample payload, an operator-entered JSON string. The list is now capped at
  40 endpoints (with the true count stated to the model), the example payload is cut to its first 200 characters,
  and the parameter schema stays complete because it is the contract.
- **The data-instruction boundary is stated once per prompt, not once per block.** It was repeated for every
  context block — documents, knowledge graph, database rows — so an ordinary document answer paid it twice
  before any evidence arrived. It now lives in the answer prompt's system message; the fence and the source
  label still travel with each block.
- **Chat history is bounded at 6 turns of 800 characters** (was 10 of 2,000). The worst case drops from
  ~5,500 to ~1,300 tokens re-sent per turn; turns older than the window are still covered by the rolling
  session summary, which exists for exactly that.

### Verified
- The full evaluation ran **63/63 correct** — the highest result recorded, and one more than before these changes.
- Every change is negative-controlled; two controls are worth recording. Removing the fences from the context
  blocks initially left the tests green, and strengthening one assertion fixed that. And the fallback from a
  concurrent index build to a blocking one first measured zero statements, because the test threw for every
  statement rather than only the concurrent builds — an earlier version of it passed for no reason.

## [1.7.8] - 2026-10-01

### Fixed
- **A question about a policy could be answered with transaction figures instead of the rule.** Where a
  database and a document set cover the same subject (an HR database beside HR policy documents), a question
  phrased like a data query was routed to the database and answered from it — "Total cuti tahunan: 37 hari"
  from six leave requests, where the policy says 12. Two changes, both measured:
  - The database and document tools now state what each is FOR: records versus rules. Reverting that wording
    dropped the correct choice on four such questions from 20/20 to 13/20 (65%); with it, 240/240 at 40 tries
    per question, and genuine database questions still went to the database in every try.
  - When the database cannot answer — no rows, a row of NULLs, or a result that is only a message saying the
    data is unavailable — the documents are tried before the user is told nothing is available. The verdict is
    read from the rows, never from the answer's wording, and a database the user pinned is never overridden.
    On the affected questions: 49/60 → 56/60. Genuine database questions were unaffected (24/24 still
    answered from the database, none diverted).
- **A question with two parts was answered from one source.** The router acted on the first tool the model
  asked for and discarded the rest — measured on the model's own output, it asked for BOTH documents and
  database on 5 of 16 tries of a two-part question. Every requested tool is now resolved, and a question
  needing several sources goes through the existing multi-source planner. On that question: 4/12 → 11/12,
  and a new two-part question that needs both a policy figure and a database total: 6/12.

### Note
- The existing multi-source trigger could never fire: it reads a marker out of the model's text, and a reply
  that carries tool calls has no text at all. Measured over 40 selections it fired zero times. It is kept, but
  the signal that works is the one read from the calls themselves.

## [1.7.7] - 2026-10-01

### Fixed
- **Sources listed passages that had been rejected.** The result was topped up to the requested size with
  whatever the relevance check had refused, so more than half of a reply's cited sources were passages the
  system itself had judged not to answer the question. Measured over 17 questions: 2.24 passages endorsed on
  average, 4.65 returned. On the question that prompted this, two of three sources were about annual leave.
  Only endorsed passages are returned now (3.18 on the same set), capped per document as the other path already
  was. If the check endorses *nothing* the original order is still returned, so a corpus that holds the answer
  is never reported as empty.
- **The relevance check could not tell passages apart on installs using contextual retrieval.** Every passage
  of a document carried the same 377-character summary header while the check reads only the first 300
  characters, so it saw an identical header for every candidate and never the passage itself. It is now shown
  the passage's own text.
- **Replies no longer end with "Sumber: …" — measured, not assumed.** With the organisation's own instructions
  from production ("Cite sources when using retrieved knowledge") and a real retrieval context, 9 of 10 replies
  ended with that line before the 1.7.6 rule and 0 of 10 do with it, with all 10 still giving the right answer.

### Not changed, on purpose
- When the evidence is judged insufficient, a second wider pass still adds unranked passages. Those are the
  questions that are genuinely only partly answerable, so the wider list is kept.

## [1.7.6] - 2026-10-01

### Changed
- **Sources no longer take over the conversation.** The list of sources under an answer used to start
  expanded, so three cited passages pushed the answer itself off the screen. It now shows a single line
  ("Sources (3)") and opens when you want to check the evidence. It is kept rather than removed because it
  is the only place a wrong result is visible — on the question that prompted this, two of the three
  passages were about annual leave and had nothing to do with overtime pay.
- **Answers no longer end with a "Sumber: …" sentence.** The interface already shows the sources as
  metadata, so repeating them in prose was redundant, and the wording varied between replies for the same
  citations. The answer text now stops at the answer. Grounding is unchanged: answers are still written from
  the retrieved context, and still say when that context did not contain the answer.
  - Worth knowing: the sentence was also being requested by the organisation's own assistant instructions in
    Settings ("Cite sources when using retrieved knowledge"), which override the built-in wording. The
    built-in instruction now states the rule for both the streamed and non-streamed paths, so it wins for
    streamed replies; an operator who wants it back can add it there again.

## [1.7.5] - 2026-10-01

### Fixed
- **The build's own checks passed locally while failing on the server.** Three modules grew during
  these releases, and the coverage floors guarding them had become unreachable: the framework counts
  comment lines in a file's total, and one module gained 48 lines of explanation for 20 of code, so no
  amount of testing could have reached its floor. The floors are re-derived from the measurement, with
  the reason and the evidence for the new code recorded next to each — not lowered to make a failure
  go away. No product code changed in this release.

## [1.7.4] - 2026-10-01

### Fixed
- **A retried request could leave its previous connection open.** When a provider answered with a server
  error and the request was retried, the response being abandoned was never released, so a single question
  could strand up to three upstream connections until the runtime collected them. Each abandoned response is
  now released before the retry. Measured: four attempts, three releases.
- The documentation for the retry helper now states what it actually does when every attempt fails — the
  server-error response is handed back to the caller, which decides what it means — instead of leaving that
  to be inferred.

## [1.7.3] - 2026-10-01

### Security
- **The last two known advisories are closed: `bun audit` now reports none.** Both sat in the database
  command-line tool that runs when the application starts, and both were pinned exactly by that tool's own
  configuration package, so a normal update could not move them. They had been accepted as low-risk; they are
  now fixed instead, after checking what the fix does to the one command that matters. The real start-up
  command was run, unchanged, inside the actual scheduler image built from the new lockfile: it applied the
  schema and a second run reported nothing to do. The replacement merge library returned identical output to
  the old one on every case a configuration file exercises.
- The test that guards this no longer lists them as accepted. It now fails if any of the three held-back
  packages resolves below its fixed version, in the lockfile or in what is installed.

## [1.7.2] - 2026-10-01

### Fixed
- **Cancelling a request was treated as a provider stall.** The retry change in 1.7.1 grouped a request
  the caller cancelled with a request that timed out, and described both as the provider being slow. They
  are different: a timeout means the provider took the whole budget, a cancellation means nobody is waiting
  any more. Neither is retried, but each is now identified for the right reason.
- **A safety check that reported success while checking nothing.** The test that confirms two known
  advisories never reach the shipped image asserted that a file was absent — and with no build on disk every
  file is absent, so it passed on a clean checkout, which is exactly where continuous integration runs it.
  It now confirms it can see a real package first, and reports itself as skipped, not passed, when there is
  no build to inspect.
- Removed an unused parameter from the retry helper whose own comment claimed a caller used it. None did.

## [1.7.1] - 2026-10-01

### Security
- **Two unauthenticated remote-code-execution flaws in the web framework, and 127 other advisories.**
  `next` 16.1.3 → 16.3.8 fixes both criticals, which are fixed only in 16.3.3 and above: one on
  Windows-hosted servers, and one through the Image Optimization API when AVIF is used. The second
  is live here — the login screen renders an image through that optimizer, so it answers before
  anyone signs in. The dependency range has been raised too: it allowed a version older than the
  fix, so a fresh install could have pulled a vulnerable one back in. `bun audit` reported 130
  advisories before 1.7.1 and reports 2 after 1.7.2; both are in the database command-line tool, which
  runs only at start-up and is not part of the application image.
- `prismjs` is pinned to 1.30.0. The syntax highlighter pulls a version with a DOM-clobbering flaw,
  and that copy was being shipped to the browser.

### Fixed
- **A slow answer could take four times as long as the configured limit, and sometimes ended in a
  shrug instead of an answer.** A request that timed out was retried — up to four times — even
  though a timeout means the request already used its whole budget. Measured on a fixed question
  set, the worst-case wait for the first word fell from 43.3 s to 11.3 s. It also cost correct
  answers: three of twelve source-selection calls gave up on a timeout and fell back to the older
  keyword router. A server error and a refused connection still retry, because those come back
  immediately.
- **Restoring a document version left the knowledge graph pointing at passages that no longer
  existed.** Measured: 131 of 131 graph rows in a development database were left orphaned this way.
  Retrieval then found nothing for them, which read as "no matching entity" rather than as a broken
  graph. `bun run scripts/cleanup-kg-orphans.ts` reports an installation that already has orphans,
  and with `--apply` removes them.
- **Answer sources all showed the same text.** Every passage of a document carries the same
  summary, and the source preview was the first 240 characters — so three different sources from one
  document displayed one identical summary and none showed the passage that matched. Previews now
  show the passage.
- **A documented setting did nothing.** A comment offered `TOOL_SELECTION=heuristic` as a way to turn
  off per-turn source selection; nothing read that variable. The comment now names the settings that
  work.

### Changed
- **The knowledge base is a little faster on every question.** Two memory lookups that ran one after
  another now run together (~1.1 s saved per turn, measured on a deployment), and a question is
  ranked once over the combined results instead of once per phrasing. A query for the document list
  now has the index it needs.
- Every answer reports how long the first word took and how many AI calls preceded it, in the stream
  and on `/api/metrics`, so a slow turn can be diagnosed instead of guessed at.

## [1.7.0] - 2026-10-01

### Changed
- **Document questions are answered about a fifth faster, with no answer getting worse.** The wait before the first
  word of an answer was dominated by several AI calls made one after another. Two of them no longer queue behind
  each other: the assistant now picks which source to use at the same moment it works out what you are asking, and
  a question that is searched in several phrasings now ranks the combined results once instead of once per phrasing.
  Measured on 15 policy questions run 3 times each, on the same machine: the median wait for the first word fell
  from 9.3 s to 7.6 s, and the AI calls made before it from 6 to 4. All 45 answers stayed correct.
  - The price, stated: a message that turns out to be plain conversation or a request for clarification now spends
    one source-selection call it did not need, on your own AI provider key. Set `SPECULATIVE_ROUTING=false` to run
    the two steps back to back instead.
  - The slowest answers are not faster: the worst-case wait (95th percentile) is dominated by occasional provider
    stalls of 30-60 s that this change does not address.

### Added
- **A per-turn timing breakdown.** Every chat reply now reports, in its final event, how long the first word took,
  how many AI calls ran before it, and how long each kind of call took. The same figures are exported as
  `chat_first_token_ms`, `chat_turn_total_ms` and `chat_pre_token_llm_calls` on `/api/metrics`. Without this the
  question "where did the wait go" could only be guessed at.
- **`bun run benchmark/latency-eval.ts`**, a harness that runs the real chat pipeline on a fixed question set and
  checks each answer against the fact in the document, so a speed change can be rejected if it makes one answer
  wrong. It includes questions the documents cannot answer, because a pipeline that got faster by trusting weak
  evidence would show up there as an invented figure.

### Fixed
- **Source previews showed the document summary instead of the matching passage.** Every passage of one document
  starts with the same summary, and a preview is the first 240 characters, so three different sources displayed the
  identical text and none showed what actually matched. Previews now show the passage itself; the answer still
  receives the summary as context.
- **A documented setting that did nothing.** A code comment promised `TOOL_SELECTION=heuristic` as a way to switch
  off per-turn source selection. Nothing ever read that variable. The comment now names the two settings that do
  work, and a test fails if a promise like it returns.

### Known
- A question that combines something the documents answer with something they do not ("how many days of leave, and
  what is the director's salary?") is answered correctly only about half the time, before and after this change.
  It is sometimes sent to the database tool instead of the documents. Not addressed here.

## [1.6.2] - 2026-10-01

### Fixed
- **A memory-service warning that fired on every save and could not be silenced.** It told you to add
  `OPENAI_API_BASE` to `.env.cognee`, on installations that already had that line. The check read a field the
  memory service's settings API never stores, so it was always true — and it also asserted the service would call
  the wrong provider, which was not something it could know. It now asks the memory service whether it can
  actually reach its provider, and speaks only when the answer is no. Dismissing a warning that is always on is
  how a real one gets missed.

## [1.6.1] - 2026-10-01

### Fixed
- **The memory screen offered several Reload buttons for one action.** Up to three copies could appear depending
  on the state, because each had been added to a different part of the card. There is now one, in a position that
  is present in every state.
- **The manual "share provider now" button had become unreachable.** It lives inside the memory operations card,
  which moved to Knowledge → Storage → AI Memory → Details, so it ended up two menus away from the screen where
  you are standing when you have just changed memory's provider. It is now also on the AI Memory Configuration
  screen, where it belongs.
- **Two labels described a screen that no longer exists.** One said memory reuses the chat model (untrue since
  memory gained its own model), and one pointed at an "LLM" tab that was renamed to "Chat Configuration".

## [1.6.0] - 2026-10-01

A security release. Every fix below was found by an audit of this codebase, reproduced before being
accepted, and left with a regression test.

### Security
- **A tenant could read another tenant's billing order state.** `Order` was missing from the list of
  models the database layer scopes to the organization, so a request naming an order id returned
  whatever order that id belonged to — across tenants. The route's own comment asserted the opposite,
  which is why it had gone unnoticed. Fixed, and a new guard now fails the build if any future model
  with an organization column is left unscoped.
- **A signed-in user could read every tenant's prompts and answers.** The recent-call trace list is
  held in the server's memory rather than in the database, and it carried no record of which
  organization each call belonged to; the endpoint that served it only required a signed-in session.
  It is now recorded per organization, filtered on read, and restricted to administrators.
- **Six ways around the 100-row limit on generated SQL.** The row limit is the only thing bounding how
  much data a model-written query can return, and `LIMIT ALL`, `LIMIT NULL`, MySQL's two-number
  form, `FETCH FIRST`, SQL Server's `TOP`, and digit separators such as `1_000_000` each slipped past
  it. All now clamp correctly. Two long-standing corruptions were fixed alongside them: a value inside
  a string literal or a bracketed column name could be rewritten (`WHERE note = 'LIMIT 999999'` became
  `WHERE note = 'LIMIT 100'`, and `[Credit Limit 5000]` became a different column).

### Fixed
- **The planner's instructions were never reaching the model.** They were sent as a system message of
  3023 characters, and the provider discards a system message above roughly 2000 in one piece — so
  the entire rule set was being thrown away before the model saw it. Moved to a message role that has
  no such limit, as this codebase already does elsewhere.
- **Long conversations lost part of their context.** The signpost that introduces prior turns repeated
  the whole history inside a system message, reaching 20,116 characters on a ten-turn conversation and
  being discarded every time — with the same text also sent, and paid for, twice.
- **The container reported itself healthy with the database down.** The health probe the container
  checked touched no dependency and always answered "ok", so an orchestrator would never restart a
  broken install. It now checks the database, and reports the memory service and local embeddings
  too, while treating only the database as fatal — the rest are optional by design and a blip must not
  restart a healthy container.
- **A license could silently reduce a paying customer's limits.** An unrecognised plan name from the
  license server was stored as-is and then interpreted as the most restrictive tier: 3 users, one data
  source, 25 documents, and refusals on scheduled runs, tools and the agentic console. Unrecognised
  plan names are now rejected and logged instead of being applied.

### Changed
- **The test suite runs twice as fast** (about 40s to about 20s) by making the retry delay the suite
  waits on configurable. Production timing is unchanged.
- **Coverage now measures the same files the tests run.** The coverage runner and the unit runner were
  collecting different sets, so thirteen benchmark suites ran but were never counted. Both now derive
  from one definition, and a guard fails the build if they diverge again.
- **Two ways a broken test run could look like a passing one are closed:** a coverage run that failed
  internally no longer reports success, and a missing coverage report is a failure rather than a pass.

## [1.5.0] - 2026-09-30

### Changed
- **The AI Memory tab now leads with the state, not the form.** It opens by answering the question you actually
  have — is memory using its own model, or following the one that answers chat? — and only then offers the fields.
  On an install that has never set a dedicated model, the panel says plainly that following chat is a working
  setup and offers one action ("Use a dedicated model") instead of presenting an empty form. That matters more
  than it sounds: filling in a blank form would pin memory to the chat model permanently, so the fields now appear
  only when you ask for them.
- **Memory storage reads as a grid of stores rather than a sentence.** The relational store, vector store,
  knowledge graph and file store are listed individually with the backend each one reports, and the badge states
  whether the memory service is reachable. When the service does not report its backends, every store says
  "not reported" — unknown is shown as unknown, never as healthy, which is the difference between a panel that
  looks reassuring and one that is telling you the truth.
- **The endpoint that has to be set by hand is now a copyable step** rather than a sentence to retype, because the
  operator's action is literally to paste a line into a file on the server.

### Fixed
- **"Memory off" and "memory unreachable" are no longer one state.** An install with memory switched ON whose
  memory service is not answering used to be able to read as switched off, which sends an operator to check a
  setting that was already correct while the real problem is a container that is not running.

## [1.4.0] - 2026-09-30

### Added
- **AI Memory can use its own extraction model.** The memory sidecar runs its own entity/relationship extraction
  against your provider, which is a different job from answering a question: high-volume, structurally
  repetitive, and tolerant of a smaller model — what matters is the structure it returns, not the prose. You can
  now point memory at a cheaper or faster model than the one that answers chat, and both keep working. Until
  this release the only way to do that was editing `.env.cognee` and restarting a container by hand.
- **A dedicated "AI Memory Configuration" sub-menu**, beside a renamed **Chat Configuration**. The old tab was
  called "LLM" while two different tabs fed two different consumers with two different credentials, so an
  operator could not tell which model they were editing. The memory tab now holds the extraction provider,
  its own Save, and a "Clear, follow chat" action that returns memory to the chat model.
- **AI memory storage is now visible.** The memory tab reports which relational store, vector store, knowledge
  graph and file store memory actually uses — as reported by the memory service itself, not inferred — with the
  status of each. A store that is not reporting shows as unknown rather than as healthy.

### Changed
- **Memory follows the chat provider until you say otherwise.** This is the default on every install that
  upgrades into this release, and memory keeps working exactly as before. The screen states that plainly
  instead of showing an empty form, so nobody goes looking for a problem that does not exist.
- **The Embedding tab now reports the memory embedder.** AI Memory shares RAG's embedding model, which is fixed
  by the deployment. It is shown as a fact rather than offered as a field, because the memory service's settings
  API accepts no embedding parameters — a field there would save, display, and change nothing.

### Fixed
- **Memory's saved provider is pushed to the memory service immediately** on save and on clear. The service
  keeps these credentials in memory only, so a change that was not pushed would appear to apply and then stop
  taking effect at the next container restart.

### Known limits, stated rather than hidden
- **The provider endpoint cannot be set from this screen.** The memory service's settings API accepts a provider,
  a model and a key, and has no field for an endpoint — verified by attempting four spellings, all of which
  stored an empty value. The screen saves the endpoint in this application's own configuration and tells you the
  exact `.env.cognee` line to add when the two differ.
- **The memory embedding model is not configurable from the UI**, for the same reason: the service exposes no
  embedding settings over its API, so it is set by the deployment.

## [1.3.0] - 2026-09-30

### Added
- **Knowledge storage is now an explicit choice, and the install refuses uploads until one is made.** The Knowledge
  menu had conflated three different things behind one vector-store form — where AI memory lives, where uploaded
  knowledge is searched, and how to reach an external store — so nothing forced anyone to configure anything, and an
  install could accept documents into a store nobody had chosen. The storage choice is now its own tab: the bundled
  PostgreSQL/pgvector, or an external vector database (Qdrant, Milvus, Pinecone, Chroma, or an existing collection).
  Until an admin chooses, `POST /api/documents` — the only path that creates a document — returns
  `503 SETUP_REQUIRED` *before* extraction runs. The choice is recorded as a sticky `storageChosenAt` timestamp
  rather than a boolean, because a defaulted boolean invites a later backfill that would mark every install "chosen"
  and delete the gate silently.
- **AI Memory is stated as bundled, not offered as a choice.** It is always the PostgreSQL/pgvector that ships with
  the install, beside a cognee graph on its embedded Kuzu. There is no second option to offer: one database, on-prem,
  bring-your-own-key.
- **External vector databases have their own destination** instead of being a mode buried inside a form, so "point at
  the customer's existing vector DB" is a named sub-menu.
- **The setup wizard gains a Knowledge Storage step**, between Test Model and Document, with **no Skip** — the step
  after it uploads a document and would fail the gate.

### Changed
- **The memory sidecar now uses the bundled PostgreSQL** for its relational store, its vectors and its cache, instead
  of SQLite, LanceDB and its own default cache. That was a third storage technology inside an install whose premise is
  "one PostgreSQL you already back up" — invisible to the operator and absent from every backup. A one-shot
  `cognee-db-init` service creates `cognee_db` first, because a missing database is not created by the provider: it
  exits 1. **The graph deliberately stays on cognee's embedded Kuzu** — the vendor labels its Postgres graph adapter a
  demo and not production-ready — and the `cogneedata` volume holding it survives the change untouched. `install.sh`
  generates the same service block, and its pre-update backup now dumps `cognee_db` too, gated on existence so an
  install predating this change still backs up cleanly.
- **The sidebar rows are compact enough that Settings is reachable without scrolling.** Measured in a browser at the
  viewports the report implies: rows 36px → 32px, nav content 564px → 470px, zero overflow at every height from 700
  down to 584 CSS px.

### Fixed
- **A correct sign-in could be refused.** The login limiter counted *successes* — middleware cannot see an outcome,
  so every POST consumed quota — and it keyed its bucket on the session cookie, which a login request does not have,
  which collapsed every unauthenticated caller into ONE shared bucket. On a single on-prem install the eleventh person
  to sign in inside a minute was locked out, and ten wrong passwords from anywhere locked out every user. It now
  counts failures only, on two axes (per normalized account, and deliberately looser per client address), and the
  address is the *last* forwarded hop — the first hop is attacker-controlled, and trusting it would mint a fresh
  bucket per request. A successful sign-in clears the account budget and deliberately not the address budget.
- **`VectorStoreConfig.vectorSize` still defaulted to 1536** while the column it describes is `vector(384)`, so a
  config row created without an explicit size disagreed with both the schema and the embedder that fills it.
- **`prisma db push` wanted to drop the full-text index.** `DocumentChunk_tsv_idx` is created by raw DDL at runtime,
  so Prisma could not see it and treated it as drift; dropping it removes BM25 ranking from a live install silently.
  It is now declared, and `db push` emits only the `ALTER`.
- **Five failures an operator could not see**, each one a place where the product reported success for work it had not
  done: an admin could change their **own** role and lock the last administrator out of the install; the **streaming**
  RAG path did not deliver the per-source context guidance the non-streaming path did, so the same question was
  answered with different instructions depending on the transport; citations were **not stamped with their retrieval
  rank**, so a list could not be read in the order the retriever actually ranked it; four code paths still fell back
  to a **1536-dimension provider model** beside a `vector(384)` column; and the agentic loop's per-round deadline
  (60s) was **shorter than the stream budget it wraps** (120s), so a slow answer was reported as a timeout with the
  stream still in flight. The agentic deadline is now 180s and configurable via `AGENTIC_DEADLINE_MS`.
- **A stored/configured embedding-model disagreement is now visible.** When the vectors in the store were written by a
  different model than the one now configured, retrieval compares only chunks whose model matches the query's, so
  every similarity score became zero and document search silently degraded to keyword matching — with no error
  anywhere and every dimension field agreeing. The vector-store panel now reports the *measured* stored model beside
  the configured one and names both when they disagree at the same width.

## [1.2.1] - 2026-09-29

### Fixed
- **The embedding dimension defaulted to a value the data does not use.** The application assumed 1536 while the
  database column is `vector(384)`, the bundled embedding model returns 384, and both the development and production
  databases hold 384-dimensional rows. Retrieval only compares a chunk whose embedding model matches the query's, so
  that disagreement turned every similarity score into zero and silently reduced document search to keyword matching —
  with no error anywhere, and with the settings screen showing the wrong dimension next to the right data.
  The dimension is now declared once and everything reads it, and a test fails if the schema, the code and the
  packaged model ever disagree again.
- **The memory sidecar defaulted to the same wrong dimension**, which made a write fail with an error naming a
  different cause than the one that occurred.

### Documentation
- **README rewritten for the people who actually read it** — someone deciding whether to install this, and someone
  reviewing it. It now describes what the product does, where it runs, what hardware it needs and where to look next,
  rather than carrying internal engineering notes that already live in the architecture and release documents.
  Two factual errors were corrected in the process: the version badge was two releases out of date, and the capability
  table gave the bundled embedding model a dimension it does not have — the same wrong number this release removes
  from the source. Counts are stated as round numbers with the command to reproduce them, and answer quality is
  deliberately not claimed as a figure, because it depends on the customer's data and their model provider.

## [1.2.0] - 2026-09-29

### Added
- **The source picker can pin the DOCUMENT corpus.** A question can now be aimed at the knowledge base instead of a
  connected database — the one control that makes retrieval deterministic, and the case where a semantic miss cannot
  be recovered by rewording. The option appears only when documents exist.

### Fixed
- **The router prompt listed every source in the install, unscoped.** Table names, table DESCRIPTIONS and document
  names reached the prompt for a key restricted away from them. Naming is the leak: a table description is business
  content and a document name is often the most sensitive string in a deployment.
- **A pinned source never reached the router.** `integrationId` bound only AFTER the route was chosen, so a
  pinned-database question could still be answered from documents while the interface said the other sources were
  excluded. The pin now reaches the prompt, and the wording was corrected to match what actually happens.
- **A coverage-floor guard that failed in CI** because it asserted equality against an artifact the job order cannot
  refresh, making its verdict depend on which job ran first.
- **A formatter assertion in the MCP dedupe path** that could not fail on the value it named.

### Changed
- **The instruction files fit their read budget again.** `AGENTS.md` plus `CLAUDE.md` came to 97 KB against a
  65,536-byte budget, so the tail of `AGENTS.md` — including the cross-tenant IDOR rule and the silent-failure
  catalogue — was silently never delivered. Reference material moved to `docs/`, and a guard now fails when any
  section begins past the allowance.
- **Sixty-three dead files removed** (6.2 MB of UAT screenshots and probe dumps at the repo root), one duplicated
  implementation consolidated, and `.gitignore` taught the shapes so it cannot recur.
- **CI runs on pushes to `dev`**, not only to `main`.
- **The Dependabot queue is capped** so a full queue cannot block security updates.

## [1.1.1] - 2026-09-28

### Fixed
- **The MCP client reported the wrong version.** It sent a hardcoded `1.0.0` in its server handshake, so the 1.1.0
  image told every connected MCP server it was a release behind. Found by grepping the BUILT image for the previous
  version number after publishing, not by trusting the tag — it was the ninth place the version is stamped and the
  only one the release-version guard did not know about.
- **A test whose result depended on the developer's `.env`.** `mcp-client.test.ts` asserted that `localhost` is
  SSRF-blocked, which is only true where `LLM_ALLOWED_HOSTS` does not include it — and this project's own documented
  topology does include it, because the local 9router gateway is reached on `127.0.0.1`. The test now derives its
  expectation from the same predicate the implementation consults and states both outcomes.

## [1.1.0] - 2026-09-28

Six features and thirty fixes since 1.0.0, with no breaking change. Every item below was found by running the
product against real data and then verified by re-running the thing it changed.

### Added
- **API-key source scoping, complete.** A key can be restricted to specific integrations, documents and tool
  families; the restriction is enforced at the query, not merely stored and displayed.
- **Queued memory writes** with per-org serialisation and retry, so a busy org's turns are not dropped.
- **Memory diagnostics** — the card now reports WHY memory is unusable rather than only that it is.
- **Editable SQL rules with hot reload**, so an operator can change Text-to-SQL behaviour without a redeploy.
- **A separate cognee configuration file**, so memory credentials do not share the application's `.env`.
- **An admin can change a member's role.** The capability was missing from the API, not only from the interface.

### Fixed
- **A cross-tenant read**: `/api/v1/agent/run` never entered its org context, so its queries ran unscoped.
- **A cross-tenant role cache** that served one org's LLM endpoint and API key to another.
- **The document scope was dropped** in agentic delegation, so a scoped key read the whole org from turn two.
- **A fabricated SQL statement** reached users as database evidence; the guard against it had two bypasses, both
  closed.
- **Retrieval ordering** returned a correctly sorted array beside a contradictory score field.
- **Silent semantic death**: a stored-vs-configured embedding mismatch made every similarity 0 with nothing saying
  so.
- **Scheduled runs always timed out** — the guard was shorter than the LLM budget it wrapped.
- **A fabricated infrastructure failure** and **a one-sided comparison** in SQL answers, both prompt-level.
- **The incoming webhook had no org context**, and reported an unconfigured secret as the caller's bad signature.
- **A dead session rendered the AI-config form empty** with no error — the mechanism behind a user-reported
  "the model I picked disappeared".
- **The sidebar's Settings entry was unreachable** below ~700px of viewport height.
- **The webhook secret is generated by the installer**, never typed and never hardcoded.

## [1.0.0] - 2026-09-25

First version offered for sale. Everything below `### Security` was already in the tree as
`[Unreleased]`; the sections above it are the September work that made the product sellable.

### Memory (cognee) — the whole integration was replaced

- **The in-process `@cognee/cognee-ts` bindings were REMOVED** and memory now runs against a
  pinned **cognee v1.6.0 API server**. Two cognee lineages writing one store is a corruption
  mechanism, and this deployment had already produced a LanceDB collection sized 1536 while the
  configured embedder returned 384, plus a graph holding 0 nodes after a write that reported
  success. One lineage, one version, one writer.
- **Cross-session memory works.** A fact written in one session and read from another:
  write ~9s warm, recall **0.21-0.35s**, token found — and also found by a SEMANTIC query, not
  only by literal token match. Before this, `rememberChatTurn` resolved "ok" after 83-95s while
  the graph stayed empty and every recall returned ''.
- **Two defects that held answers up, both fixed**: the chat-turn write was `await`ed on the
  response path (5.6-9.7s, and 228s on a fresh dataset — it made an OpenAI-compatible endpoint
  time out), and `recallContext` had no deadline across four call sites.
- **Write latency is the customer's model, not our code** — measured: the same endpoint answers
  "Say OK" in 1.3s and an entity-extraction request in 23.7s. Writes are fire-and-forget, so an
  answer is never blocked; the cost is memory FRESHNESS.
- **Server-side flags are load-bearing**: `AUTO_FEEDBACK=false`, `IMPROVE_AUTO_ENABLED=false`,
  `USAGE_LOGGING=false`. With defaults, one search measured 24-95s; with them off, 0.21s.
- A defect in cognee's markdown-fence handling that rejected valid JSON is patched at container
  start (`tools/cognee-server/`), applied automatically by `install.sh` and compose.

### Retrieval quality — measured, not asserted

- **RAG ranking is now lexical-first with vector/KG appended** (`lex1`). On the app's own corpus:
  BM25 order alone gives recall@10 1.0000 / MRR 0.9139; the previous RRF fusion gave 0.9752 /
  0.6254. The change also fixed ties resolving arbitrarily, which had surfaced a policy document
  for a training question.
- **The chunker was the biggest defect and is fixed**: a heading was becoming its own chunk,
  which turned one document into 114 fragments (57% under the minimum useful size). Now 55
  chunks, 5% fragments, mean 244 chars. Retrieval 10/10 at rank 1.
- **Head-to-head against a standard vector-RAG baseline** (same corpus, questions, top-k,
  generation model; judge from a different model family): context precision **0.973 vs 0.925**,
  answer relevance 0.933 vs 0.917, context recall 0.917 vs 0.917, faithfulness **0.983 vs 1.000**
  — reported as a modest, MIXED result rather than a win.

### Correctness and honesty fixes

- RAGAS scorers returned a silent `0.5` on error, which produced a full table of exactly 0.500
  under a rate-limited judge and was nearly reported as a real measurement. They now return
  `NaN`, and the average excludes and counts unjudged rows.
- The test runner's skip count **was always zero** — Bun prints pass/skip/fail on separate lines
  and the runner read only the `pass` line, so 54 skipped tests reported as "0 skip". Extracted,
  unit-tested, negative-controlled; it now reports 71.
- Citation rendering: an in-flight answer could be discarded by a session reload and dropped
  silently, so `Sources` never appeared. Fixed, and the drop now logs what it loses.
- e2e now clears the BullMQ queue as well as Postgres between runs; orphaned jobs were leaving a
  document without a vector and making a citation assertion fail.

### Security
- **CRITICAL: Middleware unblocks external API endpoints** — `/api/v1/chat/completions`, `/api/v1/agent/run`, `/api/webhooks/incoming` added to `PUBLIC_API_PATHS` (were blocked by cookie gate, making Bearer auth endpoints completely non-functional)
- **CRITICAL: REST executor SSRF protection at execution time** — `isBlockedHost` + `isBlockedHostAsync` (DNS-rebinding) check before every outbound REST fetch (`tool-branches.ts`)
- **CRITICAL: Plugin executor SSRF re-check at execution time** — `isBlockedHostAsync` added to `executePlugin` (was registration-time only)
- **CRITICAL: SQL injection in KG relation insert** — replaced raw `VALUES` string interpolation with parameterized per-relation `$executeRaw` (`knowledge-graph.ts`)
- **CRITICAL: pgvector HNSW index** — `CREATE INDEX ... USING hnsw (embedding vector_cosine_ops)` on `DocumentChunk.embedding` (every vector search was a full table scan)
- **HIGH: DNS-rebinding protection** — `isBlockedHostAsync()` via `dns.lookup(all: true)`, blocks if any resolved IP is private; added `metadata.google.internal`, `metadata.aws.internal`, `metadata.azure.com` to string blocklist
- **HIGH: CORS origin via env var** — `CHAT_API_CORS_ORIGIN` env var replaces hardcoded `*` on external chat API
- **HIGH: MCP confirmation gate** — agentic npx install requires `\b(confirm|yes|proceed)\b` in user message before spawning child process
- MCP: `AbortSignal.timeout()` on all SDK calls (connect 15s, listTools 10s, callTool 30s) — configurable via env vars
- MCP: `disconnectAllMcp` wired into graceful shutdown (was dead code — stdio children orphaned on SIGTERM)
- MCP: Env var wipe-on-edit bug fixed — dialog omits `envVars` key when blank on edit; PATCH only updates when key present AND non-empty
- MCP: `MCP_ERROR` thrown as `AppError` on test failure (was dead error code)
- MCP: `headersJson` field (AES-256-GCM encrypted) for SSE/HTTP auth headers
- MCP: `transport.onclose` handler set before `connect()` for proactive failure detection
- MCP: Test connections NOT cached (closed after listTools — was leaking stdio children)
- MCP: LRU cap on connection cache (default 20, `MCP_MAX_CONNECTIONS`)
- MCP: Single-flight dedup on tools-cache cold miss
- MCP: Non-text content blocks JSON-serialized (was silently dropped)
- MCP: Silent catch blocks now `console.warn`

### Fixed
- **CRITICAL: `_lastUsage` race condition** — replaced module-level singleton with `AsyncLocalStorage` + `withUsageTracking()` wrapper (concurrent requests were clobbering each other's token usage)
- **CRITICAL: Scheduler `throw e` bypassed all failure recording** — moved notification, `lastRunAt`, `ScheduledRunLog`, and `auditLog` BEFORE the throw (failed runs left zero trace)
- **CRITICAL: Scheduler `worker.close()` never called on SIGTERM** — hoisted worker to module scope, `shutdown()` now calls `await _worker.close()` before `connection.quit()` (in-flight jobs were killed mid-execution)
- **CRITICAL: OTel `initOtel()` never called** — wired into `instrumentation.ts` `register()` (SDK was pure scaffolding)
- **CRITICAL: Citation trails dropped in streaming path** — `StreamingCompletionResult` now has `citationTrail` field; `prepareRagStream` and all agentic streaming return paths propagate it
- **HIGH: `recallContext` unguarded** — cognee outage broke all chat; now `.catch(() => '')`
- **HIGH: Document worker never closed on shutdown** — `docWorker.close()` added to `cleanupFns`
- **HIGH: `jobQueue` had no `defaultJobOptions`** — added `attempts: 3, backoff: exponential 5s, removeOnComplete: 100, removeOnFail: 500` (jobs got zero retries, never auto-removed from Redis)
- **HIGH: Document worker `lockDuration` too short** — 30s default expired mid-embedding causing double processing; set to 300s + `stalledInterval: 30s`
- **HIGH: `chatStream` bypassed `fetchWithRetry`** — streaming LLM calls got zero retries on transient 5xx; now uses `fetchWithRetry`
- **HIGH: No aggregate timeout on agentic loop** — added `AGENTIC_DEADLINE_MS` (90s default) deadline check at each iteration
- **HIGH: Circuit breaker livelock** — added half-open recovery: after 5min cooldown (`CIRCUIT_BREAKER_COOLDOWN_MS`), tool gets 50% score for probe attempt; `PerfMetrics` gets `lastFailureAt` field
- Silent SSE chunk catches now log warnings instead of silently dropping

### Added
- Scheduler timezone support — `ScheduledRun.timezone` field + `tz` option in BullMQ repeat (`syncSchedule` accepts `timezone`)
- `withUsageTracking()` export from `llm-client.ts` — wraps async fn in isolated AsyncLocalStorage context
- `isBlockedHostAsync()` export from `llm-config.ts` — DNS-rebinding SSRF check via `dns.lookup`
- MCP env vars: `MCP_MAX_CONNECTIONS`, `MCP_CONNECT_TIMEOUT_MS`, `MCP_LIST_TOOLS_TIMEOUT_MS`, `MCP_CALL_TOOL_TIMEOUT_MS`
- `McpServer.headersJson` Prisma field (AES-256-GCM encrypted HTTP headers for SSE/HTTP transports)
- `CHAT_API_CORS_ORIGIN` env var for external API CORS
- `AGENTIC_DEADLINE_MS` env var for agentic loop wall-clock timeout
- `CIRCUIT_BREAKER_COOLDOWN_MS` env var for circuit breaker half-open recovery cooldown

### Changed
- `instrumentation.ts` — now calls `initOtel()`, captures `docWorker` return for graceful shutdown, includes `disconnectAllMcp` in cleanup
- `tool-router.ts` — `runNonStreamingChatCompletion` and `runStreamingChatCompletion` wrapped in `withUsageTracking()` for per-request usage isolation
- `StreamingCompletionResult` interface — added `usage` and `citationTrail` fields
- `PerfMetrics` interface — added `lastFailureAt` field
- MCP quick-connect transport detection: `/mcp` → http (was misclassifying as sse)
- `prisma db push --accept-data-loss` may drop the `tsv` column — re-create via `ALTER TABLE "DocumentChunk" ADD COLUMN tsv tsvector; CREATE INDEX "DocumentChunk_tsv_idx" ON "DocumentChunk" USING gin(tsv);`

## [0.4.0] - 2026-07-30

### Removed
- Dead/redundant shelfware: `rbac.ts`, `schedule-events.ts`, `redis-rate-limit.ts`, `rate-limit.ts`, `ollama-provider.ts`, `health-checks.ts` (+ tests). RBAC unwirable without touching 75 routes (single-tenant YAGNI). Ollama provider redundant — `embeddings.ts` already supports OLLAMA via DB config. Health checks redundant — `/api/health` + `/api/v1/health` routes already implement liveness+readiness inline. Rate limit libs unused — middleware has its own inline limiter. Schedule events emitter had no SSE consumer — UI polls every 15s.

### Added
- Contextual Retrieval (Anthropic technique): LLM-generated document summaries prepended to chunks before embedding (`CONTEXTUAL_RETRIEVAL` env var)
- LLM reranker scoring: 0-10 scoring approach replacing index-ranking, with score < 3 filtering
- Langfuse trace → score linkage: `traceLlmCall` returns traceId, `postLangfuseScore` links RAGAS metrics to traces
- OpenTelemetry instrumentation: `src/lib/otel.ts` with `getTracer()` and `withSpan()` helpers, lazy SDK init via `OTEL_ENABLED`
- Property-based tests for SQL guardrails using fast-check (8 properties)
- Graceful shutdown module: `src/lib/graceful-shutdown.ts` with SIGTERM/SIGINT handlers and cleanup timeout
- Scheduler failure notifications: failed scheduled runs now send webhook/Telegram notifications with error details
- Metadata support in LLM traces: `traceLlmCall` accepts `metadata` field, forwarded to Langfuse/Helicone
- CI: Semgrep static analysis job in GitHub Actions
- Helm chart with blue-green (Argo Rollouts) and canary (Flagger + Istio) deployment support
- Disaster recovery: automated backup, restore, and backup validation scripts
- OpenAPI specification (57KB) for external API integration
- SDK package for programmatic access
- Vision/multimodal LLM support (VLM)
- Responses API + structured output
- MCP client + native function calling + prompt caching
- OpenAI-compatible multi-agent API
- Real database connectors (Postgres, MySQL, MSSQL, ClickHouse)
- RAG benchmark suite (540 questions across 5 databases)
- Cron-based scheduler with notification channels (webhook, Telegram)
- SSRF blocklist for outbound webhook/plugin/MCP calls
- Audit logging with fail-closed behavior
- Log retention with automated cleanup

### Changed
- Reranker prompt: index-ranking → 0-10 scoring with parseRerankerScores
- Instrumentation hook: delegated OTel SDK init to `src/lib/otel.ts`
- Scheduler notification logic: sends on both success and failure (was success-only)
- CI workflow: added Semgrep scan job

### Fixed
- Dynamic integration detection: no hardcoded database names
- Routing context awareness + integration detection
- 5 critical chat flow bugs: chatbot queries actual data sources
- MCP filesystem default path + test error messages
- Seed-plugins double-run
- Streaming resilience for SSE token delivery
- Typed error responses for UI

### Security
- SQL guardrails: AST anti-injection, mutation blocking, LIMIT 100 cap, statement chaining prevention
- AES-256-GCM encryption for notification configs and credentials
- HMAC-SHA256 webhook signatures (X-Signature-256)
- Fail-closed auth: deny on error, never on absence (`AUTH_DEMO_FALLBACK=false` default)
- Environment schema validation at startup with Zod
- Security hardening: removed z-ai fallback, standardized English

## [0.3.0] - 2026-07-27

### Added
- Agentic MCP installer: fetch GitHub README, parse install instructions, set credentials via chat
- Maturity roadmap P0-P3: CI, security docs, file splits, Helm, VLM, SDK
- Enhanced scheduler with time picker, dashboard notifications, output view
- Plugin/MCP merge with toggle popup
- Auto-install MCP from URL in agentic chat + Quick Add by URL in Tools

### Changed
- Removed Browse MCP tab, consolidated into agentic view
- Dashboard redesign with security tests and auto re-cognify

### Fixed
- Mobile/portrait resolution Sheet trigger for agentic view
- MCP regex matching
- .env admin email configuration

## [0.2.0] - 2026-07-25

### Added
- Wave 2: Chat plugin wiring, Redis broker, seed fix
- Wave 1: Critical UI fixes, dashboard redesign, security tests, dedup
- Phase 5: OpenAPI spec, deployment guide, LICENSE, log retention, audit fail-closed
- Phase 4: OpenAI Multi-agent API + Programmatic Tool Calling
- Phase 3: Docker, observability, Postgres code adaptation
- Phase 2: Vision/multimodal, Responses API, structured output
- Phase 1: MCP client, native function calling, prompt caching

## [0.1.0] - 2026-06-24

### Added
- Initial project setup: Next.js 16, TypeScript 5, Prisma 6, Bun
- Core AI assistant with intent → router → tool pipeline
- RAG (hybrid: lexical + semantic + FTS + vector store)
- SQL guardrails and connector
- Chat session management
- Document upload and processing
