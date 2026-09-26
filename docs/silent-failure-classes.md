# Silent-failure classes found by probing

> Moved out of `AGENTS.md` on 2026-09-26. **Reason, measured:** `AGENTS.md` had grown past the
> 65536-byte workspace read budget, and truncation keeps the HEAD — so the material at the END of
> the file stopped being read. That is the same failure this catalogue documents, applied to the
> document itself.
>
> `AGENTS.md` keeps a one-line index of these classes plus the rules derived from them. Read this
> file when you are about to trust a guard, reverse an existing test's expectation, or change how a
> prompt is delivered.

## Silent-failure classes found by probing (2026-09-25)

Thirteen defects across eight rounds shared one shape: **the code reported success for work it had
not done, or dropped data on the way out** — and every one was found by executing a probe, not
by reading the code.

1. **A guard that matched a WORD, not a CALL.** `invariants.test.ts` asserted
   `toContain('startJobWorker')`, so deleting the call left it green (the name survives in the
   `import` above). Now strips comments and requires an invocation, negative-controlled.

2. **A wipe reported as done when the forget failed.** `resetCognee` wrapped
   `cogneeForget(...)` in `catch {}` and returned `true`, so "forget everything" cleared every
   `cognifyStatus` and wrote a success audit row while the memory was still there. Its siblings
   `forgetAll`/`forgetKnowledgeGraph` already returned `false`; it was the lone outlier.

3. **A field SELECTED but never MAPPED** — the same shape as the dropped hint, one round
   earlier. `GET /api/documents/[id]` selected `cognifyStatus` and
   `cognifyError` and then built the response by hand without them, so a failed memory-index
   looked like a healthy document. The field was in Prisma, in the `select`, in the client type,
   and in the sibling list route — and still never reached the client.

4. **A classified error whose `hint` is dropped on the last hop.** `classifyProviderFailure`
   produces the actionable half of a BYOK failure ("re-enter the key", "add credit", "pick a model
   your provider serves"), `toTypedError` carries it across the wire — and `extractError` (48
   callers) returned only `message`. A test asserted that as CORRECT (`toBe('Invalid credentials')`
   for an object carrying `hint: 'Check password'`), so the vague half was pinned in place.
   `fetchProviderModels` was worse: it threw `Failed to fetch models (HTTP 401)` without reading
   the body, so the classifier could not run at all on the first feedback a pasted key ever gets.

5. **A defence that is correct and TESTED while callers bypass it.** `evidence-boundary.ts` had
   the lowest line coverage in the repo (46.7%) and was the prompt-injection boundary. Its own
   tests were good; the defect was that `reflexion.ts` and `intent-pipeline.ts` interpolated the
   same untrusted document text RAW. Testing the wrapper proves the wrapper works, never that
   anyone calls it — so the guard now reads the CALLER files.

6. **A null that means two different things.** `cogneeRecall` returns `null` on HTTP failure and
   never throws, so a dead sidecar and an empty dataset took the same `if (!hits?.length) continue`
   branch, silently. Recall is best-effort and stays non-fatal; what changed is that an outage is
   now a different code path from an empty result, and only the outage warns.

7. **A keyword list that hijacks a routing decision.** The `datetime` plugin declares the bare
   keyword "tahun", so any question containing a time word scored above the promotion threshold and
   was moved OFF the route the classifier had chosen. 5 of 6 database questions carrying a time word
   were hijacked, and the WRONG answer scored higher than a right one ("Tampilkan pesanan per jam."
   0.415 vs "Hitung 15% dari 2 juta." 0.383) — so a threshold could not separate them. Fixed with a
   quality gate: a match must be the question's SUBJECT, not a qualifier inside it.

8. **A documented rule that a LATER guard silently overrides.** The intent prompt has always
   listed two ambiguity cases requiring clarification, and a heuristic guard beneath it suppresses
   clarification whenever the question contains 'berapa' / 'how many' — which is exactly what both
   ambiguous shapes contain. So the rule never fired: "Berapa banyak itu?" was answered with a
   confident "Jumlahnya 2.405 (total stok)" picked from one of three connected databases, and the
   user could not tell it was a guess. When a prompt states a rule, check what happens AFTER it
   returns — a downstream guard can make it unreachable.

9. **A fix placed where it can never run.** The replacement rule was correct and detected all four
   cases in isolation, and still changed nothing, because it was inserted inside the suppression's
   own `if (parsed.needsClarification …)` block — and the model returns `needsClarification=false`
   for precisely those questions. Test the PURE FUNCTION separately from the integration, or a
   placement bug looks like a logic bug.

10. **A branch on prose.** The clarification caller compared the human-readable `reason` string;
   when that text gained a suffix the comparison stopped matching, and a TIME question was answered
   with the COUNT clarification. Branch on a stable key; treat a `reason` field as documentation.

11. **An instruction that is never DELIVERED, which looks like a model ignoring it.** The intent
   system prompt was 2872 characters and the provider DISCARDS a system message above ~2100 —
   measured: 1900 chars reports `prompt_tokens: 269`, 2300 reports `44` (the user message alone),
   3/3 identical in both directions. So `analyzeIntent` never received its own instructions, replied
   in prose, failed to parse, and returned safe defaults after seconds of work. Every symptom
   pointed at the model; the model was never told. **If a prompt seems ignored, verify it was
   DELIVERED — check `prompt_tokens` against the text you sent, not just the code path.**

12. **A rule set delivered in the wrong ROLE — and a single sample nearly hid it.** The provider
   discards a system message above ~2000 characters (see 11). Auditing every system message the app
   sends found TWO production prompts over the line: the Text-to-SQL specialist (3033 chars) and
   memory context (2606 chars). So the SQL RULES — including rules 13-16 that encode real fixed bugs
   — were discarded on EVERY request, and recall from prior turns was dropped while still costing
   the call that produced it. Both moved to USER messages, where there is no ceiling (12000 chars
   reports 1558 prompt_tokens and a system instruction is still obeyed). Memory context moved for a
   second reason too: it is derived from earlier user turns, so it is untrusted input and a system
   message gives it the highest authority — fencing alone would not have fixed that.
   **Beware the lucky sample.** An early probe showed the 3033-char SQL prompt reporting 548
   prompt_tokens, apparently delivered, which would have justified leaving the defect in place.
   Re-running the same shape three times showed it dropped 3/3, and sweeping 1800/2000/2100/2200
   located the boundary between 2000 and 2100. One favourable sample is not a measurement.

**A local note that generalises:** three rounds of "the model ignores this rule" ended here. Round 7
moved the ambiguity rule into code because a prompt rewrite changed nothing (0/4) — the right
outcome, for a reason I did not know: there was nothing to ignore. When a prompt change has EXACTLY
zero effect twice, suspect delivery before trying a third wording.

**A prompt is not always the lever.** Rewriting the intent prompt — narrowing the conflicting rule
and explaining the failure inline — changed the measurement by 0/4. The rule moved into code because
a model cannot be relied on to gate itself. Try the prompt, but MEASURE it before believing it, and
be willing to conclude that the enforcement belongs somewhere else.

**A note on measuring a model-in-the-loop path.** The same routing suite read 8/10, then 15/21, then
5/5 for a single question run alone. It was measuring the CUSTOMER'S classifier variance, not the
change under test. Pin fixes like this with a DETERMINISTIC test on the pure function (scorer +
gate), and report any model-in-the-loop number as the model's behaviour rather than as the fix's
effect. Chasing such numbers by tuning a prompt is how the over-correction happened here: the first
tokenizer dropped "berapa"/"what" as stop-words and broke legitimate plugin matches.

13. **A mechanism fed nothing, because two different meanings shared one value.** `pg_class.reltuples`
   returns -1 for a table that has never been ANALYZEd — the normal state for a freshly created or
   freshly loaded table. The reflection query coerced that to 0, and the enrichment guard skipped
   rowCount `<= 0` as empty. So on this deployment ALL 11 reflected tables were skipped and no
   distinct values were ever collected — while `describeSchema` was perfectly able to render them
   (`-- values: SDM, Keuangan, ...`) and simply had nothing to render. The user-visible result:
   "Berapa jumlah karyawan di departemen HR?" answered "0 orang", because the model could not map
   "HR" to the real value "SDM". A correct query against a wrong assumption.
   **When one value carries two meanings ("unknown" and "empty"), check every comparison against
   it.** Better: keep "unknown" distinct, so a guard cannot mistake it for a measurement. The
   existing test that guarded this was right about the RISK (an unbounded `SELECT DISTINCT` is
   expensive) and wrong about the remedy; the cost is now bounded by the pool's 30s `query_timeout`
   plus `LIMIT 21`.


14. **A dead schedule that reports itself healthy.** A BullMQ repeatable job stops rescheduling once
   it exhausts its attempts, and NOTHING recorded that: the `ScheduledRun` row kept `isActive: true`
   and a `nextRunAt` that simply stopped moving. MEASURED on this deployment: a daily 06:00 run died
   on 2026-09-11 (the embedding baseUrl pointed at `localhost` while the operator allowlist held only
   `127.0.0.1`, so `normalizeBaseUrl` threw on every run and the job burned all 3 attempts). 41 days
   later the UI rendered it as an ordinary date with a relative time. An admin would believe the
   daily report was being delivered.
   **The failure mode is "a state nobody can observe", not "a bug in the scheduler".** When a
   mechanism can stop permanently, the record it leaves behind must be able to say so — otherwise
   "not running" and "running fine" are the same row.
   Worth separating from the cause: the CONFIG was wrong, but the fact that a wrong config produced
   a silent, permanent, invisible stop is the defect. A misconfiguration should be loud.

15. **The same question, two different routes, and one sample.** A sales question once returned a
   `PLUGIN` tool run whose output was raw Wikipedia search JSON. That looked like a repeat of class
   7/12 (a keyword list hijacking a routing decision), so the plugin gate was probed with the REAL
   `Plugin` rows: business questions produced ZERO candidates, and "Jam berapa sekarang?" still
   matched datetime and dominated correctly. Re-running the question gave SQL 3/3 with substantive
   answers. The single odd result was the CUSTOMER'S model choosing differently on that run.
   Recorded because the temptation was to "fix" a gate that was already correct — and because
   classes 7 and 12 were real, so the prior is strong and has to be checked against the current
   measurement, not assumed from it.


16. **A status that means "accepted" while every reader assumes "ready".** `POST /api/documents` set
   `status: 'ready'` at upload and THEN enqueued the embed job, so `ready` never meant "searchable".
   Chunks embed in a background job, one job per document, chunk by chunk, and nothing marked the
   transition. MEASURED: a document sat at `status=ready` with `embedded=0` of `chunk=1`, and
   retrieval read a corpus missing half the document. No API field and no UI element could tell a
   fully embedded document from one still in flight, so the only symptom was an intermittently
   failing citation assertion — and flakiness is exactly how this class hides.
   **When a status word has a weaker meaning than everyone assumes, either strengthen the writer or
   expose the fact that actually matters** — here, `embeddedChunkCount` beside `chunkCount`.

17. **A guard that cannot fail — twice in one sitting, from the same instinct.** The wait added for
   class 16 was written, checked, and REMOVED twice:
     - "the card shows `Ready`" — true from upload onwards, so it could never fail.
     - "the card shows `Graph`" — implemented by writing embed progress into `cognifyStatus`, a field
       owned by the COGNIFY job. That would have given one value two meanings (class 13), recreated
       in the very act of fixing class 16.
   Both were caught by asking "what would make this assertion FALSE?" before trusting it. The third
   attempt (`embeddedChunkCount === chunkCount`) was verified against the database to differ from
   the naive value mid-run, so it can genuinely fail.

18. **A test that uploads the same fixture twice, then asserts on a retrieval ranking.** The
   citation spec uploads `e2e-answer.txt` from TWO tests. Both create a `Document` row with that
   name, `uploadDocument` waited only for the NAME to be on screen, and one duplicate could still be
   embedding while the other was fully embedded — so the assertion passed or failed depending on
   which duplicate retrieval ranked. MEASURED from the database rather than from timing:
   `chunks=2, distinct_chunkIndex=1`, two rows with the same name, one chunk vectorised and one not.
   This also explains why PASSING runs showed only 3 of 4 chunks vectorised: the assertion does not
   need every chunk, it needs the RIGHT chunk.
   **A duplicate fixture makes a retrieval assertion non-deterministic**, and the fix is to make the
   upload helper wait for the specific condition the assertion depends on — every document with that
   name fully embedded.

   **A RETRACTED intermediate finding, kept because the mistake is instructive.** An earlier version
   of this entry asserted that `playwright.prod.config.ts` starts the app before `globalSetup` runs
   the mocks, and blamed the flake on that ordering. The ordering IS real (visible in the log: the
   worker reports before "[global-setup] Starting mock LLM"), but it was NOT the cause — the seed
   cleared the queue, the job retried, and the genuine cause was the duplicate above. The lesson is
   the one this catalogue keeps repeating: an observed irregularity that COULD explain a symptom is
   not evidence that it does. After the real fix: 4 consecutive production-build runs, 16/16 each.
**Rules that follow from these:**

- Trace a value from its SOURCE to its CONSUMER and check each hop, rather than assuming that
  presence at the ends implies a path between them. Numbers 3 and 4 both had the data correct at
  BOTH ends and lost it in the middle.
- When a mechanism is built to produce an actionable message (a classifier, a hint field, a
  `code`), grep for its CONSUMERS. A classifier nobody calls and a hint nobody displays are the
  same defect as no classifier at all.
- A test that asserts the current behaviour of a lossy stage can pin the loss in place. When
  reversing one, state in the test why the old expectation was wrong — the next reader will
  otherwise "fix" it back.
- Assert on the **response body**, not on the query. 71 route tests already do; the 4 that assert on
  the `select` argument would pass while the mapping is missing. A field can be selected, typed and
  documented and still not be returned.
- `catch {}` around an operation whose RESULT YOU REPORT is a false-success bug. Either propagate
  the failure or record it in a field the UI reads. Graceful degradation is for work that is
  optional (memory recall returning `''`); it is not for work whose completion you claim.
- When one function in a family gets a rule right and a sibling does not, the outlier is the bug —
  check the family, not just the call site.
- **A test whose negative control SURVIVES is vacuous — rewrite it, do not keep it.** The first
  memory-context guard asserted only on the rendered size of the system message, so flipping the
  role back to `'system'` left it green. Asserting the property you actually mean (the ROLE and the
  fence) is what made the control fail. A guard that cannot fail is worse than no guard, because it
  reports safety.
- **Check what your PROBE returns before believing its verdict.** A probe that read `schema.tables`
  off a function returning a plain array reported "no distinct values" for a function that had them,
  and nearly sent me to fix the wrong layer. Assert the probe's own shape first: if the data source
  is unexpectedly empty, suspect the reader.
- **Sweep a suspected boundary; do not probe it once.** Stepping 1800 → 2000 → 2100 → 2200 located
  the system-message ceiling within one run. A single probe at 3033 reported the prompt as delivered.
