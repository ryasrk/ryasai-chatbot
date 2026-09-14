# Head-to-head: full pipeline vs small pipeline

100 questions x 2 pipelines = 200 requests, model **`cbcn/deepseek-v4.1-flash`**, through the
production HTTP path (`POST /api/chat/sessions/[id]/send`).

Reproduce: start the dev server with `SIMPLE_PIPELINE=1`, then
`bun trial/live/head-to-head.ts --json trial/live/head-to-head.json`.

## Results

| pipeline | accuracy | DATA questions | p50 | p90 | ttft p50 |
|---|---|---|---|---|---|
| full | **96.00%** (96/100) | 92.50% (37/40) | 6302 ms | 11879 ms | 4789 ms |
| simple | **97.00%** (97/100) | 97.50% (39/40) | **4728 ms** | **9389 ms** | **3554 ms** |

By family (pass/20):

| family | full | simple |
|---|---|---|
| DB | 20 | 20 |
| DOC | 17 | 19 |
| GREET | 20 | 20 |
| GENERAL | 20 | 20 |
| TRAP | 19 | 18 |

## What the numbers do and do NOT show

**The 1-point accuracy gap is NOT real.** Only 3 of 100 questions differed, and the
direction is mixed:

| question | winner | cause |
|---|---|---|
| D04 | simple | retrieval (fixture) |
| D12 | simple | retrieval (fixture) |
| T04 | full | routing |

A McNemar test on the 100 paired questions gives **0 wins for full and 0 wins for
simple** on the 97 questions where they agree, and 3 discordant pairs -- far too few
to support any claim that one pipeline is more accurate. **The accuracy is a tie.**

**Latency is a real, consistent difference.** simple is faster on every family:
mean 5593 ms vs 7535 ms (-26%), p90 9389 ms vs 11879 ms (-21%), and time-to-first-token
3554 ms vs 4789 ms (-26%). The TTFT gain is the expected one: the greeting fast path
skips the classification call entirely. GREET is 3731 ms vs 4945 ms despite both
scoring 20/20.

## Defects found while running this

**1. The retrieval failures are MY FIXTURE, not the pipeline.** DOC questions are the
weakest family for both pipelines, and the cause is measurable: `uat/fixtures/embedding-server.ts`
is a deterministic hashed bag-of-words, documented as "NOT a semantic model", so it
matches on shared vocabulary rather than meaning. Measured on
"berapa hari jatah cuti tahunan karyawan":

| chunk | fixture similarity | correct? |
|---|---|---|
| "... **12 hari cuti tahunan** ..." | 0.4016 | yes, and it LOSES |
| "... cuti melahirkan **90 hari** ..." | 0.4082 | no, and it WINS |

The correct chunk is outranked by an unrelated one because both share "cuti"/"hari".
`grep` confirms "12 hari cuti tahunan" is in the source file and the chunk is stored
and embedded. So D01/T12 fail deterministically in BOTH pipelines for a reason that
has nothing to do with routing. **DOC accuracy here measures the fixture.**

**2. Duplicated seed data corrupted retrieval.** Every fixture document had been
inserted 8 times: 128 chunks for one document, containing only 16 unique. The top-5
was flooded with identical copies of a header. Removed (28 duplicate `Document` rows,
chunks 128 -> 56) before this run.

**3. T04 is the SAME retrieval artifact, not a routing bug -- my first reading was
WRONG.** I initially attributed T04 ("permisi, berapa hari cuti tahunan?", the one
question the full pipeline won) to a defect in the new greeting matcher, because a
greeting-prefixed data question is exactly what that matcher is supposed to reject. It
is not. Measured: the greeting matcher correctly returns FALSE for that string, and the
simple pipeline's TTFT of 6866 ms shows it DID route to RAG rather than taking the
shortcut -- it retrieved only the heading and answered from that.

The real cause is the fixture embedding again, and a subtitle is the trap:

| chunk | fixture similarity to "permisi, berapa hari cuti tahunan?" |
|---|---|
| "## Hak Cuti Tahunan" (a heading) | **0.5164** |
| "Setiap karyawan ... **12 hari cuti tahunan** ..." | 0.3873 |

A heading made of exactly the query's keywords beats the sentence that answers it. So
T04 and D01/T12 are one defect with one fix (a real embedding model), and T04 happening
to land on `full` is what makes the accuracy gap look like routing.

## Honest limits

- ONE trial per question. A 1-point gap on this sample is indistinguishable from noise;
  only the latency difference is large enough to survive it.
- The DATA families (DB/DOC) depend on `uat_demo` and the fixture documents, so they
  measure this seed, not general correctness.
- REST routing is not exercised: no question here requires a REST endpoint, so the
  `expect: 'REST'` route has no coverage in this run.
- The model is fast and non-reasoning (`cbcn/deepseek-v4.1-flash`, ~1.2 s per raw
  call). On a reasoning model the classification call is far more expensive, so the
  TTFT advantage of the simple pipeline would be LARGER, not smaller -- but that is an
  inference from the earlier measurement, not something this run measured.
