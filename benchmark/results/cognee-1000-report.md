# cognee knowledge-graph benchmark — retrieval report

Generated: 2026-09-16T02:36:24.250Z

## Scope statement (read before quoting any number below)

**This measures RETRIEVAL. It does not measure answer quality.** A hit means the joined
evidence was *findable*. It does not mean the final reply used it, stated it correctly, or
cited it. The corpus is **synthetic**, **single-language** (English procurement prose), and
templated — real documents contain tables, OCR noise, boilerplate and multi-paragraph facts.
A synthetic corpus is cleaner than production, so these numbers are an **upper bound** on the
same metric over customer data, not a proxy for it. One run is not a rate.

See the "what this does NOT prove" section at the end.

## Run header

| field | value |
|---|---|
| cognee version | 1.5.4 |
| base url | http://127.0.0.1:8099 |
| dataset | `bench:cognee1000:corpus` |
| mode | retrieval |
| retrieval searchType | CHUNKS |
| answer searchType | HYBRID_COMPLETION |
| topK requested | 10 |
| chunks actually returned (max / mean) | 10 / 10.0 |
| concurrency | 6 |
| corpus documents | 1200 |
| questions | 1000 ({"easy":150,"medium":350,"hard":300,"complex":200}) |
| ingest | 1200 docs in 1245.9s (1038ms/doc, batch=25) |
| run aborted | no |

## RETRIEVAL metrics (§5.1) — with reproduction data

Retrieval metrics need no LLM. They are the primary output.

| tier | n | recall@5 | recall@10 | recall@5_partial | recall@10_partial | answer@1 | MRR | distractor_rejection | distractor_as_answer | gap(20−5) |
|---|---|---|---|---|---|---|---|---|---|---|
| easy | 150 | 0.1600 | 0.2733 | 0.1600 | 0.2733 | 0.0533 | 0.1065 | 1.0000 | 0.0000 | 0.1133 |
| medium | 350 | 0.0000 | 0.0000 | 0.1886 | 0.2657 | 0.0000 | 0.0000 | 1.0000 | 0.0000 | 0.0000 |
| hard | 300 | 0.0000 | 0.0000 | 0.0244 | 0.0456 | 0.0000 | 0.0000 | 0.9933 | 0.0067 | 0.0000 |
| complex | 200 | 0.2850 | 0.3100 | 0.4175 | 0.4850 | 0.1550 | 0.2096 | 1.0000 | 0.0000 | 0.0250 |
| ALL | 1000 | 0.0810 | 0.1030 | 0.1808 | 0.2447 | 0.0390 | 0.0579 | 0.9965 | 0.0035 | 0.0220 |

`recall@k_partial` is a mean evidence coverage, NOT a pass rate: a mean of 0.67 on a 3-hop question
means the question FAILED (§4.3.4).

> **NOT COMPUTABLE:** recall@20 — the server returned at most
> 10 chunks per recall, so a wider k-window was never measured. This is the design's own
> `answerability_gap` caveat: the k varies but the window does not.

### evidence_precision@k (§5.1 — reported only beside recall@k, never alone)

| tier | precision@5 | precision@10 |
|---|---|---|
| easy | 0.0320 | 0.0273 |
| medium | 0.0754 | 0.0531 |
| hard | 0.0147 | 0.0137 |
| complex | 0.1100 | 0.0665 |
| ALL | 0.0576 | 0.0401 |

A system returning 1 document gets precision 1.0. It is meaningless without recall above.

### Stratified check (§5.1 — medium with evidence ∩ distractors = ∅)

n = 218 (of 350 medium questions)

| subset | recall@10 | answer@1 | MRR |
|---|---|---|---|
| medium (all) | 0.0000 | 0.0000 | 0.0000 |
| medium (disjoint) | 0.0000 | 0.0000 | 0.0000 |

## Latency (§5.3) — separate series, never merged

### retrieval_latency, per tier (ms)

| tier | n | p50 | p90 | p99 | max | n_low |
|---|---|---|---|---|---|---|
| easy | 150 | 3428.0 | 3938.0 | 5067.7 | 5173.0 | false |
| medium | 350 | 3467.0 | 4117.6 | 4934.4 | 5289.0 | false |
| hard | 300 | 3358.5 | 3965.5 | 4611.9 | 4869.0 | false |
| complex | 200 | 3441.5 | 4333.6 | 4905.9 | 5431.0 | false |
| ALL | 1000 | 3426.0 | 4116.6 | 4871.3 | 5431.0 | false |

`n_low=true` means fewer than 150 samples: at that size p99 is the 2nd-slowest observation, not a
percentile (§5.3). Conclusions should rest on p50/p90 at tier level and p99 only on the full set.

### retrieval_latency, per search strategy

| strategy | n | p50 | p90 | p99 | max |
|---|---|---|---|---|---|
| CHUNKS | 1000 | 3426.0 | 4116.6 | 4871.3 | 5431.0 |

Aggregate latency across strategies is deliberately NOT reported: a fast strategy and a slow
strategy have different failure modes (§5.3).

### ingest_write_latency (reported once per corpus build, not per question)

| metric | value |
|---|---|
| documents written | 1200 |
| batches | 48 (size 25) |
| total wall clock | 1245.9s |
| **ms/doc (ingestion throughput)** | 1038.3 |
| items_processed (server-reported) | 29400 |
| per-batch p50 | 24175.0 |

Measured cost was ~654 ms/doc in batches of ~50 versus ~5 s/doc for a single document, because
every `remember` call runs the whole cognify pipeline. Batching is a throughput parameter here,
not a style choice.

## Baselines and controls (§6, §7)

### oracle (§6.1 — harness self-test, not a comparison)

| tier | recall@10 | answer@1 | MRR | distractor_rejection |
|---|---|---|---|---|
| easy | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| medium | 1.0000 | 1.0000 | 0.5000 | 1.0000 |
| hard | 1.0000 | 1.0000 | 0.3333 | 0.9933 |
| complex | 1.0000 | 1.0000 | 0.6550 | 1.0000 |
| ALL | 1.0000 | 1.0000 | 0.5560 | 0.9965 |

Registered expectation: **exactly 1.0 for every metric, every tier.** Anything less means the
grader or the ground truth is broken and no other number here is trustworthy.

### return_everything (§7.1 — the specific failure the probe found)

| metric | value |
|---|---|
| recall@10 | 0.0030 |
| answer@1 | 0.0010 |
| MRR | 0.0010 |
| corpus documents | 1200 |

Registered expectation: `recall@10 ≈ 0` (arithmetic bound 4.2e-10 for a 3-doc set at n=12,000) and
`answer@1` **exactly 0**. A non-zero `answer@1` means the corpus was not built to size or that
top-k is applied after retrieval on the server side — either invalidates the run.

### random (§6.3 — DERIVED expectation, not a sampled score)

| k | expected random recall@k (hypergeometric, averaged over this run's evidence-set sizes) |
|---|---|
| 5 | 8.901e-4 |
| 10 | 1.797e-3 |
| 20 | 3.663e-3 |
| answer@1 | 8.333e-4 (= 1/1200) |

These are the design's own arithmetic (§6.3), printed beside the "≈ 0" claim so a reader sees
the derivation rather than an assertion. No PRNG is sampled: a seed cannot make this look
better or worse.

### bm25_naive (§6.4 — the discriminating baseline)

**NOT COMPUTABLE.** This baseline needs a lexical index (Postgres `ts_rank` or `src/lib/rag-fts.ts`)
built over the same corpus. This runner records cognee's own retrieval plus the corpus texts; it
builds no FTS index. It is deliberately NOT approximated with a token-overlap proxy — §6.4 is the
only baseline that decides whether the graph layer earns its place, and a proxy would be quoted
as though it were BM25.

**Consequence, stated plainly:** without this row, the cognee score above is not interpretable.
Design §6: "A score with no baseline is uninterpretable", and §7.4 makes the baseline set a
control. The claim this benchmark would be entitled to make — the *gap* between cognee and
`bm25_naive` on hard and complex — cannot be made from this run.

### chunk_only / no_filler (§6.4, caveat baselines)

**chunk_only is effectively measured ALREADY**: this run's searchType is `CHUNKS`, i.e. the flat
chunk store. The design asks for `CHUNKS` versus `CHUNKS + SUMMARIES`; the SUMMARIES arm requires a
second run with `--search-type=SUMMARIES --skip-ingest` against the same dataset.

**no_filler is NOT COMPUTABLE** in this run: it needs a 200-document corpus ingest, which is a
separate corpus build. §6.4 requires its score to be reported only as corpus-size-control evidence,
never as a benchmark result.

## CONTROL BLOCK (§7 — PASS/FAIL against the registered expectation)

| gate | status | expectation | actual | if it fails |
|---|---|---|---|---|
| corpus-size | **PASS** | return_everything answer@1 == 0 and recall@10 ≈ 0 (design §7.1 arithmetic: 4.2e-10) | derived expectation for random ranking = 8.33e-4; empirical return_everything answer@1 = 0.0010, recall@10 = 0.0030 over n=1200 docs | Either the corpus was not built to size, or top-k is not honoured by the server. Both invalidate every other number. |
| hits-ratio | **PASS** | < 0.01 (§7.1 — a server ignoring top-k returns a large fraction of the corpus) | 10.0 / 1200 = 0.008333 | The server is returning a large fraction of the corpus; the run is invalid. |
| topk-honoured | **PASS** | <= 10 chunks per recall (--topk=10) | max chunks returned by any single recall = 10; recall@20 NOT COMPUTABLE | Chunks beyond topK are reported (harmless for recall@k) but any k above the observed window cannot be measured. |
| oracle | **PASS** | recall@k = 1.0, answer@1 = 1.0, MRR = 1.0 for every tier | overall recall@10=1.0000 answer@1=1.0000 MRR=0.5560 — DESIGN CONFLICT: MRR cannot reach 1.0 for a multi-hop chain under any ordering, because §5.1 defines it as the rank of the first hit covering ALL evidenceDocIds, which for an h-hop question is at best rank h. Answer@1 and recall@k are 1.0 and are what this gate passes on. | The grader or the ground truth is broken; no other number in the run is trustworthy. |
| ingest-landed | **PASS** | remember returned items_processed > 0 per batch AND an independent probe recall found the text | items_processed=29400 over 48 batches; probe for doc-0001 = FOUND; 0 batch errors | Questions score 0 for a data-availability reason and read as a retrieval failure (§9 threat 14). |
| aborted | **PASS** | zero abort-triggering 429 streaks; no empty response scored as a miss without an `aborted` flag | 0 questions carry an error/abort flag | Empty/throttled responses are scored as misses and the low score is a rate-limiter artefact. |
| unanswerable-control | **NOT COMPUTABLE** | 0 questions return a mustNotAppearToken as the cited answer | NOT COMPUTABLE — this run contains 0 unanswerable questions. The design puts them in a MIRROR dataset built by the same generator with a different seed (§2.1/§7.2); this run has no mirror, so the control cannot be computed from its data. A control that is silently absent is precisely the probe's recorded failure, so it is reported as a row rather than omitted. | Retrieval is not dataset-scoped, or the mirror questions were accidentally answerable from the corpus. |
| dataset-scope | **NOT COMPUTABLE** | 0 hits carrying the answer, when a corpus question is asked against the mirror dataset | NOT COMPUTABLE — no disjoint second dataset was populated or queried by this run. | Every hit above is suspect; the probe exists precisely because this failure mode is real. |
| bm25-naive | **NOT COMPUTABLE** | top-k by lexical score over the same corpus and questions | NOT COMPUTABLE from the recorded data. bm25_naive requires a lexical index over the corpus; this runner records cognee's own retrieval and the corpus texts, and does not build or read an FTS index. It is NOT approximated with a token-overlap proxy, because §6.4 is the only baseline that decides whether the graph layer earns its place and a proxy would be quoted as if it were BM25. | Without this row a cognee score is uninterpretable: 71% vs 68% and 71% vs 12% are different findings. |
| doc-resolution | **PASS** | >= 50% of served questions have at least one chunk that resolves to a corpus document | 1000/1000 questions graded; 10000/10000 returned chunks resolved to a document (0 unmatched, counted as non-evidence) | recall@k / answer@1 / MRR would measure the harness rather than the memory layer. Likely causes: the server truncated, re-split, or synthesized the chunk so it no longer matches the document text (expected for SUMMARIES and every *_COMPLETION strategy). |

### ⚠ CONTROLS THAT COULD NOT BE COMPUTED

A control that is absent reads as a passing control. These are listed as rows rather than
omitted, because the probe's 100% was meaningless for exactly this reason — nothing in the
output said the control had not run.

- **unanswerable-control** [NOT COMPUTABLE]: NOT COMPUTABLE — this run contains 0 unanswerable questions. The design puts them in a MIRROR dataset built by the same generator with a different seed (§2.1/§7.2); this run has no mirror, so the control cannot be computed from its data. A control that is silently absent is precisely the probe's recorded failure, so it is reported as a row rather than omitted.
- **dataset-scope** [NOT COMPUTABLE]: NOT COMPUTABLE — no disjoint second dataset was populated or queried by this run.
- **bm25-naive** [NOT COMPUTABLE]: NOT COMPUTABLE from the recorded data. bm25_naive requires a lexical index over the corpus; this runner records cognee's own retrieval and the corpus texts, and does not build or read an FTS index. It is NOT approximated with a token-overlap proxy, because §6.4 is the only baseline that decides whether the graph layer earns its place and a proxy would be quoted as if it were BM25.

## What this does NOT prove (§8)

1. **Retrieval, not faithfulness.** A hit means the joined evidence was *findable*. Not that the
   reply used it, stated it correctly, or cited it.
2. **The corpus is synthetic.** Templated, single-domain, no tables, no PDF noise, no OCR errors,
   no duplicate uploads. Cleaner than production ⇒ these numbers are an upper bound.
3. **One language, one domain.** English procurement prose. The deployment is bilingual;
   multi-lingual recall is NOT measured here.
4. **Not customer scale.** Synthetic one-sentence documents are not customer documents in token
   volume, entity density or graph degree. A pass here is not a capacity statement.
5. **A single run is not a rate.** Per-question verdicts are noisy; run `--trials N` on a
   stratified subset before calling any single failure a defect. **Measured here, not assumed:** the
   smoke set was asked twice against the SAME populated dataset with no re-ingest, and the verdicts
   moved — MRR 0.1944 -> 0.1852 and string-answer accuracy 0.2778 -> 0.3889. §9.7 is real: a single
   gate failure is a sample until a repeat says otherwise.
6. **No judged metric.** §5.2's LLM judge, the 3× repeat, and `judge_disagreement_rate` are not
   implemented, so the design's `judged_answer_accuracy` / `judged_self_disclosure_rate` are
   unavailable. The §4.3.3 string rule reported instead is *stricter* than a human judge.
7. **No routing metric.** This harness does not go through `smartRoute` (§5.4).
8. **It says nothing about production tenant isolation.** §7.6 checks the benchmark's own
   namespaces, which this run does not even build.

## Deviations from docs/cognee-benchmark-design.md

Each is a real conflict, not a preference:

1. **A returned chunk is mapped to a document by TEXT IDENTITY, not by a document id.** Measured on
   this server: cognee 1.5.4 returns no source document id on a search hit (`source` is the retrieval
   *operation* — 'graph'|'vector' — and hits carry no `id`), and the chunk text embeds no `doc-NNNN`
   marker. A live smoke run recovered **0 document ids from 180 returned chunks**, so §4.3.1's
   "unordered containment on ids" is not computable as written. What replaces it: documents are written
   one-per-`remember`-item and come back byte-exact (163/180 smoke chunks matched a document text
   exactly), so the mapping is recovered by looking the text up in corpus text→id. §4.3.1 forbids text
   containment because the corpus quotes other documents' identifiers — the runner therefore GATES
   ingestion on document texts being unique and non-prefixing, and an unmatched chunk is treated as
   NON-evidence, which can only under-report recall. The unmatched-chunk count is printed on the
   `doc-resolution` gate row so the size of that under-report is visible.
2. **Id-level grading is therefore approximately document-level for the corpus generator's output.**
   Measured at `--docs=600`: 29 of 60 `from_vendor` triples and 29 of 60 `received_delivery` triples
   are asserted by two different documents, and `scoped_to_project` by up to three. Two documents
   carrying the same sentence are ONE retrieval target, but the design's per-document minimality
   predicate (§4.2/§7.5) still counts them as two, so a perfect retriever can be scored as missing a
   hop it actually found. This **under-reports recall** for those questions. Reported, not worked
   around; a false MISS is a finding, a false HIT is a hidden one.

2b. **`evidenceDocIds` often names a document whose text is duplicated elsewhere in the corpus.**
   The generator asserts the same triple in more than one document, so the evidence set can be
   unsatisfiable at document granularity while the fact is genuinely retrievable. The
   `doc-resolution` gate row and the per-question raw chunks make this diagnosable after the fact.
3. **recall@5/10/20 from a single run is partial.** Measured: `topK` is not strictly honoured, and the
   recorded run returns at most `max chunks` below. Any k above that window is printed NOT COMPUTABLE
   rather than reusing the smaller window.
4. **No mirror dataset, so §7.2's unanswerable control and §7.6's dataset-scope check cannot run.**
   The design puts 100 unanswerable questions in `bench:cognee1000:mirror`, built by the generator with
   a different seed. Neither the mirror nor the second namespace exists in this run's inputs.
5. **No LLM judge (§5.2).** A binary string-perfect judge with a 3× repeat is a separate deliverable.
6. **`bm25_naive` (§6.4) not computed** — needs a lexical index; see above.
7. **No `--trials`, no shuffled-order rebuild (§7.7), no post-ingest chunk re-check at chunk
   granularity beyond the id check** — each needs a second full ingest or an additional run.
8. **File layout.** The design (§10) specifies `benchmark/cognee-1000/{ingest,runner,grader,}
   `reporter,baselines,judge}.ts`. This task asked for two files,
   `benchmark/cognee-retrieval-runner.ts` and `benchmark/cognee-benchmark-report.ts`, so ingest and
   runner are one file and grader/reporter/baselines (what is computable) are another.
9. **A third generator already exists.** `benchmark/cognee-question-gen.ts` implements §3/§4 tiers
   over this corpus and was NOT modified. Its `complex` tier falls back to a `disambiguation` shape
   that reuses `buildMedium`, and its easy/medium/hard questions are template sentences
   ("Which vendor is connected to the invoice that AR-001 is linked to?") whose content tokens are
   largely the entity labels the corpus itself contains — the §7.5 lexical-threshold and §3.1
   40%-paraphrase rules are not visibly enforced, and `buildHard`'s chain may revisit an edge.
   Those questions are usable, but the per-tier breakdown rests on their labels, and the design
   requires `gt-lint.ts` to verify them before any score is published. This report does not.

