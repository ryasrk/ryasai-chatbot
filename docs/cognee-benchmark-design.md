# Design: a 1000-question benchmark for the cognee memory layer

**Status: DESIGN ONLY. Nothing below has been run. No number in this file is a
measurement.** Every figure here is either a *target*, a *bound derived from
arithmetic*, or a *control threshold chosen before the run* — never a result.
Where a number is arithmetic (corpus sizes, rank probabilities), the derivation is
shown so it can be checked without a run.

Companion documents, and what each one already settles:

| Document | What it establishes | What it does NOT establish |
|---|---|---|
| `docs/cognee-http-migration.md` | The mechanism: write persists, recall returns it in a different session. A 3-question multi-hop probe scored 3/3 at rank #1 on a 16-item corpus. | Graph *quality* at scale. That doc's own "Known limits — do not overstate" says so. |
| `scripts/cognee-quality-probe.ts` | The methodology: 3 scenarios, filler corpus, per-question decoy, unanswerable control. Its comments record a real failure — a 100% score that was uninterpretable because "return everything" also scored 100% on a 6-item store. | Anything statistical. 3 questions cannot support a rate. |
| `benchmark/cognee-corpus.ts` | The corpus: a seeded, deterministic synthetic enterprise world with typed ground-truth relations beside the prose (verified by running it — see §2). | That any question set exists. It generates documents and relations, not questions. |
| `README.md` (Measured Results) | 800 questions at 99.38% on routing + SQL/REST, run with `SIMPLE_PIPELINE=1` which **bypasses cognee entirely**. The README states plainly this is not memory evidence. | Memory. Do not cite it here, and do not cite this document there. |

This design scales the probe's *method* to a corpus and question count where the
numbers become falsifiable. It does not reuse the probe's numbers.

### Repo evidence that changed this design

Recorded here because two assumptions this document was drafted on turned out to be
false against the repository, and a reader is entitled to see the corrections:

1. **A corpus generator already exists.** `benchmark/cognee-corpus.ts` (1,459
   lines) was written against the same two failures this design's §7.1 and §7.3
   target, and it emits typed ground-truth relations. The design was rewritten to
   consume it (§2) rather than propose a duplicate. Consequence: the deliverable
   is a *question* generator, not a corpus generator.
2. **That corpus is not one-fact-per-document, and 34% of its two-edge chains fit
   in a single document.** Measured on a real run
   (`--docs=2000`): 364 of 1,068 two-edge chains have both edges in the *same*
   document. A naive question generator would have labelled those "2-hop" while a
   one-document retriever answers them. §2.2 and §7.5 check 1 exist solely because
   of this measurement.
3. **The benchmark's `--docs` does not scale the world.** The entity pool is
   fixed (`VENDOR_COUNT = 40`, `PERSON_COUNT = 80`, …), so a larger `--docs` makes
   the same world *thinner per entity*, not richer. §2.1 records this; it is a
   real limit on what "12,000 documents" means here.

---

## 1. What is being measured, and what is not

Two families of metric exist and they must never be averaged together:

- **RETRIEVAL metrics** — given a question, did the memory layer surface the
  minimal supporting evidence, and where did it rank it? These are what this
  harness computes directly. They need no LLM.
- **ANSWER-quality metrics** — given the retrieved evidence, does a synthesized
  answer state the right thing? These need an LLM and a judge, and they are a
  *secondary* output here.

**This harness measures RETRIEVAL. It reports one answer-quality number, and
labels it as judged, not verified.** Retrieval recall is necessary but not
sufficient for a correct answer: a question can hit at rank #1 while the final
chat reply is still wrong. This is the same scope statement the probe makes
(`scripts/cognee-quality-probe.ts` lines 31–34) and it holds identically at 1000
questions. More questions buy precision; they do not buy a different metric.

The unit of grading is the **retrieved evidence set**, not prose.

---

## 2. Corpus design

**The corpus generator already exists: `benchmark/cognee-corpus.ts` (1,459 lines,
untracked at the time of writing).** This design consumes it; it does not propose
a second one. Its existence was verified by running it, not by reading it:

```
$ bun benchmark/cognee-corpus.ts --docs=2000 --out=/tmp/corpus-probe.json
docs: 2000 (hot 784, filler 1216)     characters: 667030     sentences: 6000
relations: 1109    distinct entities: 766
  vendor: 40   person: 80   project: 30   warehouse: 15   invoice: 220
  purchase_order: 60   batch: 300   serial: 900   audit_finding: 60
  incident: 32   delivery: 120   approval: 60
wrote /tmp/corpus-probe.json (1923226 bytes)
```

It is seeded-deterministic, it emits **typed ground-truth relations next to the
prose** (its header states why: "a question generator that re-parses sentences
re-derives whatever the prose says, including the distractors"), and it already
solves two of the three corpus problems this design exists to control — see §2.3.
Consequences for the rest of this document:

- The question generator (`generator.ts`) becomes a **question** generator over
  `CorpusIndex.relations`; it must not generate facts.
- `evidenceDocIds` and `hopChain` are derived from `index.documents[].relations`
  (`CorpusIndexEntry`), so hop chains come from typed triples, never from parsing
  `doc.text`.
- Every per-tier predicate in §3 is expressed over the relation graph: a hop is a
  traversal `subject → predicate → object` where the question names only the first
  `subject`. This is what makes §7.5's minimality check mechanical.

### 2.1 Shape (as the existing generator produces it)

| Property | Existing generator | This design's target | Note |
|---|---|---|---|
| Entity pool | 40 vendors, 80 people, 30 projects, 15 warehouses, 220 invoices, 60 POs, 300 batches, 900 serials, 60 audit findings, 32 incidents, 120 deliveries, 60 approvals | unchanged | Fixed-size world: `--docs` does not grow the entity pool, so a larger `--docs` makes the same world *thinner per entity*, not richer |
| Predicates | 18 (`received_delivery`, `arrived_day`, `raised_against`, `signed_off`, `covers`, `approved`, `from_vendor`, `for_project`, `carried_batch`, `reported_on_time`, `contains_serial`, `raised`, `against_vendor`, `scoped_to_project`, `filed`, `at_warehouse`, `involved_batch`, `was_late`) | unchanged | These 18 predicates are the chain vocabulary the tier definitions must use |
| Hot (relation-bearing) docs | 784 at `--docs=2000`; capped at `HOT_DOCS = 900` | `--docs` large enough that all 900 hot docs exist | Below 900 the generator warns that "some ground-truth relations have no anchor document" — the runner must treat that warning as fatal |
| Filler docs | appended beyond the hot world | ≥ 11,100 | Filler reuses the same vendors/warehouses/projects but asserts nothing typeable: it raises the collision rate on purpose (§2.2) |
| **Total documents** | `--docs` | **12,000** | See §7.1 — this is the load-bearing number |
| Chunks after cognee ingest | not estimated | assume 1–3 per doc; ~20,000 chunks | Feeds §7.1 directly; the run records the actual count |
| Distractors per question | none — the generator emits candidates, not pairs | 2 minimum, chosen by `generator.ts` from the same relation set (§2.3) | §7.3 |
| Contradiction layer | 32 `correction_memo` docs, 32 relations flagged `retracted`, `CorpusIndex.corrections` | used by the complex tier (§3.1) | Off by default (`--with-contradictions`) — **the complex tier requires it on** |
| Uncertain-quantity layer | `--with-contradictions` also populates `uncertainSpellings`; 0 present in the 2000-doc probe run above | optional sub-mechanism | Not required by this design; noted so it is not mistaken for the correction layer |
| Unanswerable mirror | not emitted | a second namespace built by the same generator with a **different seed** (§7.2) | — |

### 2.2 Why the existing corpus shape is the right one — and the one trap in it

The generator's own header records the two failures it was built against, and both
are failures this design must also prevent:

1. **"Return everything."** "With fewer documents than the context budget, stuffing
   the whole corpus is a valid strategy, so recall@k and answer-quality metrics
   measure the context window, not retrieval." Same diagnosis as
   `scripts/cognee-quality-probe.ts`, arrived at independently.
2. **Keyword overlap.** "If the entity named in the question appears only in the
   document that answers it, BM25 alone matches the gold chunk and the graph layer
   is never exercised." This is the reason §7.5's single-document check is
   computed over the *whole corpus*, not just the evidence set.

It also deliberately makes the surface vocabulary of a relation reusable by
documents whose correct answer is a *different* entity ("three vendors deliver to
Project Alpha, so mentioning Alpha and a vendor does not identify which delivery
the question asks about"). That is exactly §7.3's distractor requirement, already
built into the corpus rather than bolted on by the question generator. The
question generator's job is to *select* the colliding documents, not to author
them.

**The trap: documents are NOT one-fact. This design's earlier assumption was
wrong and was measured before being discarded.** `cognee-corpus.ts` emits 0–4
relations per hot document. Measured on the probe run above
(`--docs=2000`):

```
relations-per-hot-doc histogram: {0:279, 1:134, 2:199, 3:111, 4:61}
2-edge chains found: 1068   of which BOTH edges in the SAME document: 364 (34.1%)
```

So **a third of all two-edge traversals in this corpus are answerable from a
single document**, and a question generator that walks `CorpusIndex.relations`
naively would label them "medium (2 hops)" while a one-document retriever answers
them. That would inflate every multi-edge tier and is precisely threat #3 in §9.

Consequences, all mandatory:

- `generator.ts` must compute, for each candidate chain, the **set of distinct
  documents** carrying the chain's edges, and reject any chain whose edges collapse
  into fewer than `hopChain.length` distinct documents. The tier's "docs that must
  be joined" column in §3 is enforced as a *document-count* predicate, not an
  edge-count one.
- The 279 hot documents with **zero** relations are usable only as filler-like
  context and must never appear in an evidence set.
- The same collapse must be re-checked after ingest, at chunk granularity, because
  the relation-to-chunk mapping is cognee's, not ours (§7.5 check 3).
- This is a **generator-level** filter, not a scoring adjustment: a question whose
  chain collapses is discarded and regenerated, never relabelled "easy".

### 2.3 Corpus isolation

Corpus is written to dataset `bench:cognee1000:corpus` and the unanswerable
mirror to `bench:cognee1000:mirror`. Both are created by the harness, never
produced by an application path, and are deleted by `--purge` at the end of a
run. The harness must never write to `org:<id>` or `org:<id>:kb`
(`src/lib/cognee-types.ts` lines 50–56) — a benchmark that pollutes a real
tenant's memory would be its own incident.

---

## 3. Difficulty tiers

Four tiers, defined operationally. "Hop" means: a retrieval step in which the
value needed for the next step is not present in the question and is not present
in the first document returned. "Join" means the answer is only correct if the
values from the joined documents are combined.

| Tier | Hops | Docs that must be joined | Distractor that must be REJECTED | Contradiction / update that must be RESOLVED | Target count |
|---|---|---|---|---|---|
| **easy** | 1 | exactly 1 | — (still has 1 near-miss; failure is not a tier-1 miss) | no | **150** |
| **medium** | 2 | exactly 2 | 1 required | no | **350** |
| **hard** | 3 | exactly 3 | 2 required | no | **300** |
| **complex** | 2–4 | 2–4 | 1–2 required | **yes** — an older fact about the same entity must be preferred-or-rejected by rule | **200** |

### 3.1 Operational definitions (the generator must satisfy these exactly)

**easy (150).** One document contains the answer as a literal token. The question
is a paraphrase: at most 40% of the question's content tokens appear in the
document, and the entity name is replaced by a two-step description (e.g. the
corpus stores "PT Sinar Abadi supplies project Alpha"; the easy question about
project Alpha names Alpha, not the supplier). Easy exists as a **ceiling
check**, not as an achievement: a memory layer that cannot do this on a 12,000-doc
corpus is broken, and if easy < 95% the run is invalid for all tiers (§11).
Easy questions are drawn from the single-edge relations only (the 18 predicates
whose subject and object share one document), which is what makes them genuinely
one-document.

**medium (350).** A two-edge relation path `docA(S₁ →p₁→ E₁)` and
`docB(E₁ →p₂→ answer)`, with `E₁` present in two documents. The question names
`S₁` and asks for the object of the second edge; `E₁` is **not** named in the
question. Example shape over the real predicate set:

`docA`: "…approving purchase order PO-0001 from vendor PT Sinar Abadi" — relation
`(apr-001, approved, po-0001)`.
`docB`: "…raising purchase order PO-0001 against vendor PT Sinar Abadi" —
relation `(po-0001, raised_against, ven-01)`.
`Q`: "Which vendor is the purchase order that AR-001 approved raised against?"
Neither document alone contains both the approval and the vendor. One distractor
`docD1` carries `(apr-001, approved, po-XXXX)` for a *different* PO with a
*different* vendor, so a one-hop answer keyed on the approval id returns a wrong,
plausible vendor name.

**hard (300).** Three-edge path `docA → docB → docC`, answer only in `docC`,
question naming only `S₁`. Two required distractors: `docD1` shares `S₁` and
terminates after one edge in a wrong object; `docD2` shares `E₁` and terminates
after two edges in a wrong object. A concrete chain exists in the world's
predicates, e.g.
`(dlv-001, arrived_day, day-469)` · `(wh-01, received_delivery, dlv-001)` ·
`(wh-01, scoped_to_project, prj-XX)` plus the timing/correction relations.
Rejecting `docD2` is the specific thing that separates three-edge traversal from
two-edge traversal, so for hard questions `answer_at_rank_1` is additionally
computed as "`E₁`'s doc and the answer doc are both in the top-K **and** `docD2`
is not the cited answer" (§5.3).

**complex (200).** Two to four edges, plus exactly one of four *resolution*
mechanisms, assigned round-robin so each sub-shape gets 50. Two of the four are
**already emitted by `cognee-corpus.ts` and must be used rather than rebuilt**:

1. **Supersession** — available today. `--with-contradictions` produces 32
   `correction_memo` documents, 32 relations flagged `retracted`, and a
   `CorpusIndex.corrections` array pairing `incorrectDocId`/`correctDocId` with
   `incorrectAssertion`/`correctAssertion`. The question carries an explicit
   "as of day N" qualifier. Correct behaviour: return `correctDocId` and NOT
   `incorrectDocId`. **Only 32 correction pairs exist in the fixed world**, so
   each supports several differently-worded questions; the 50 supersession
   questions must be checked for near-duplication by §7.6's token-overlap rule
   and the count reduced if the pool cannot supply 50 distinct ones.
2. **Ambiguity resolved by a second attribute** — available today. The corpus
   deliberately gives several vendors the same delivery sites and several
   projects the same vendors; `highFrequencyEntities` (empty at `--docs=2000`,
   populated as `--docs` grows) names the entities a high-recall retriever drags
   in every time. Question: two documents give the same subject two different
   objects, a third disambiguates by warehouse/site. Answer = the disambiguating
   doc plus the correct object doc.
3. **Negative evidence** — **must be added to the generator**, because the corpus
   has no "nothing recorded" documents. Requires a new `DocKind` (or a flag) and
   a matching entry in `CorpusIndex`; a distractor asserts a positive fact about
   the same subject. Answer = the negative doc, rejecting the positive distractor.
4. **Aggregation over a chain** — partially available: `contains_serial` (171
   relations) and `UncertaintyGroundTruth.sum` already encode an arithmetic step
   over a chain, with `resolvingDocId` deliberately not reachable "by matching the
   uncertain sentence's digits". Where the uncertain layer is off, the aggregate is
   a plain count over a 3-document chain; a distractor supplies a plausible partial
   sum.

Sub-mechanisms 1 and 2 therefore need only a question generator; 3 and 4 need a
small, additive change to `benchmark/cognee-corpus.ts` (this design does not
modify that file — the change is a prerequisite listed in §11).

### 3.2 Justification of the split

- **1,000 total** is fixed by the task. It is large enough that a per-tier rate
  is interpretable: at n=300, an observed 90% has a 1σ standard error of 1.73pp
  (≈ ±3.4pp at 95%); at n=150, 1σ is 2.45pp (≈ ±4.8pp at 95%). Tiers below 150
  would be too coarse to act on, which is why easy — the least informative tier —
  gets the smallest allocation. These are binomial standard errors, i.e. a
  *floor* on the uncertainty: they do not include the modality threats in §9.
- **easy 15% (150)** is the floor needed to detect a catastrophic regression
  (a 5pp drop is ~7.5 questions — detectable, not precise, and precision is not
  wanted here). It is deliberately a minority: it is a control, not a score.
- **medium 35% + hard 30% = 65%** multi-hop is the centre of mass because
  multi-hop traversal is the entire reason cognee is in the stack rather than
  plain vector RAG (README, G3: "RAG is flat chunks — no knowledge graph"; the
  probe makes the same argument at lines 14–18). A benchmark where the majority
  of questions are answerable from one document would score well and prove
  nothing.
- **hard is smaller than medium** because hard questions are 3-hop and their
  failure modes are more confounded (the extractor may have failed on any of three
  edges). More medium questions give a cleaner read on the same phenomenon with
  fewer confounds; hard is sized to establish that the phenomenon exists, not to
  measure it to ±2pp.
- **complex 20% (200)** is the newest capability and the one nothing in the repo
  currently claims. It is a fixed 200 rather than a percentage of a larger pool
  because 50 per sub-mechanism is the minimum that supports a per-mechanism rate;
  a smaller cell would force reporting a pooled number that hides which mechanism
  failed.
- **No "impossible"/adversarial tier inside the 1,000.** Unanswerable questions
  are controls, not questions, and mixing them into the tier means would let a
  system raise its score by refusing (§7.2 scores them separately).

---

## 4. Ground truth

One JSON object per question in `questions.jsonl`, produced by
`benchmark/cognee-1000/generator.ts` and **verified** (not re-authored) by
`benchmark/cognee-1000/gt-lint.ts` (§7.5).

### 4.1 Record shape

```jsonc
{
  "id": "hard-00417",
  "tier": "hard",
  "submechanism": null,           // complex only: supersession|negative|disambiguation|aggregation
  "question": "Which vendor supplied the batch that the approver of INV-4471 authorized?",
  "answer": "Sinar Abadi",         // the expected answer, a single canonical string
  "answerAliases": ["PT Sinar Abadi", "Sinar Abadi"],  // generator-derived only
  "evidenceDocIds": ["doc-000412", "doc-005518", "doc-009103"],  // MINIMAL supporting set, ordered by hop
  "hopChain": [
    { "from": "INV-4471",              "via": "approvedBy",  "to": "Ratna Wibowo", "docId": "doc-000412" },
    { "from": "Ratna Wibowo",          "via": "authorized",  "to": "batch B-2291", "docId": "doc-005518" },
    { "from": "batch B-2291",          "via": "suppliedBy",  "to": "Sinar Abadi",  "docId": "doc-009103" }
  ],
  "distractorDocIds": ["doc-007744", "doc-002201"],   // MUST NOT be the returned answer
  "distractorStrings": ["Bumi Sentosa", "Delta Prima"],// the wrong-but-plausible answers those docs carry
  "mustAppearTokens": ["Sinar Abadi"],                // tokens whose absence = miss
  "mustNotAppearTokens": ["Bumi Sentosa", "Delta Prima"], // tokens whose presence in the CITED answer = wrong
  "asOf": null,                    // complex/supersession only: ISO date
  "answerIsNegative": false        // complex/negative only
}
```

### 4.2 The minimal evidence set

`evidenceDocIds` is **minimal**, not merely sufficient: removing any element
makes the question unanswerable from the remainder. The generator guarantees this
by construction (each hop's `to` value appears in exactly one document), and
`gt-lint.ts` asserts it by re-querying the corpus: for every strict subset of
`evidenceDocIds`, the answer token must be absent from the concatenation of that
subset. A question whose evidence set is not minimal is discarded and
regenerated; it is never shipped with a corrected-looking evidence list.

### 4.3 The exact match rule

Grading runs in this order, and the first rule that produces a verdict wins:

1. **Evidence rule (RETRIEVAL).**
   `evidence_hit@k = 1` iff **every** `id ∈ evidenceDocIds` appears among the
   document ids of the top-k hits. Unordered containment on ids — never on text.
   Text containment is not used for retrieval because the corpus deliberately
   contains documents that quote each other's identifiers.
2. **Rank rule.** `rank1` iff the document containing the **final** hop
   (`evidenceDocIds[last]`) is hit #1 among the top-k. This is the probe's rule
   (`cognee-quality-probe.ts` line 225) generalized to a chain.
3. **Answer rule (ANSWER-quality, judged).** Normative pipeline:
   a. Lowercase, NFC-normalize, replace `-`/`_` with space, collapse whitespace,
      strip a leading `pt `, `cv `, `pt.`, trailing `.` and `,`.
   b. `answer_correct` iff `normalized(cited_answer)` **equals** any of
      `normalized(answerAliases)` (string equality after normalization), **or**
      `normalized(cited_answer)` **contains** `normalized(answer)` **as a whole
      token sequence** (token-boundary match, not substring).
   c. `answer_correct` is forced to `false` if any
      `normalized(mustNotAppearToken)` occurs in `normalized(cited_answer)` as a
      whole token sequence — **even when (b) also passed**. This is the
      distractor-rejection requirement, and it is why the answer rule is not
      "token containment": on this corpus, `Bumi Sentosa` contains no token of
      `Sinar Abadi`, but a system answering "PT Bumi Sentosa (formerly Sinar
      Abadi)" would satisfy (b) and must fail.
   d. `answer_correct` is forced to `true` for `answerIsNegative` questions iff
      the cited answer contains an explicit negation marker
      (`none|no |not recorded|nothing|tidak ada|tidak tercatat`) AND contains at
      least one token of the subject entity.
   e. **Substring-only matches never score.** A single common token
      (`batch`, `invoice`, `warehouse`) appearing in a citation is a miss. The
      shortest `answer` string in the whole set is required by `gt-lint.ts` to be
      ≥ 5 characters and to consist of ≥ 2 tokens; the generator rejects answers
      that are a single token appearing in > 0.5% of the corpus.
4. **No partial credit in the headline.** Partial credit is recorded separately
   as `evidence_coverage = |hits ∩ evidenceDocIds| / |evidenceDocIds|` and is
   reported in the per-tier breakdown. It is not averaged into any rate quoted as
   "accuracy", because a mean coverage of 0.67 for a 3-hop question means the
   question failed.

### 4.4 What "rejecting a distractor" means precisely

`distractor_rejected` is true iff **no** `mustNotAppearToken` occurs as a whole
token sequence in the **cited answer** — the text the system presents as its
answer — not in the raw top-k text. The raw top-k is allowed to contain
distractors; on any real retriever over 12,000 documents it will. Conflating the
two is exactly the mistake the probe's own NOTE warns against
(`cognee-quality-probe.ts` lines 301–305: "every hit came back alongside its
decoy… what matters is that the answer outranked it").

---

## 5. Metrics

Every metric below states its formula, its denominator, and what it does not
prove. Retrieval metrics and answer-quality metrics are computed and printed in
**separate blocks** and are never combined into one score.

### 5.1 RETRIEVAL metrics (no LLM; this is what the harness primarily measures)

| Metric | Definition | Denominator | What it does NOT prove |
|---|---|---|---|
| `recall@k` (k=5, 10, 20) | fraction of questions where **all** `evidenceDocIds` are in the top-k | all answerable questions | that the system can *use* the evidence; that the answer is correct |
| `recall@k_partial` | mean `evidence_coverage` at k | all answerable questions | anything about correctness; a 0.67 mean is a failure rate, not a pass rate |
| `answer_at_rank_1` | fraction where the final-hop document is hit **#1**, in a corpus where returning everything is impossible (§7.1) | all answerable questions | that ranking is *graph* ranking — vector search can also rank #1 |
| `MRR` | mean of `1/rank(first hit covering all evidenceDocIds)`; 0 if absent from top-k | all answerable questions | nothing about ranks beyond the first; MRR saturates and hides tail misses |
| `distractor_rejection_rate` | fraction where `distractor_rejected` (§4.4) is true | all questions with ≥1 distractor (all but easy) | that the *retrieved* set is clean — only the cited answer is checked |
| `evidence_precision@k` | mean `|hits ∩ evidenceDocIds| / |hits|` at k | all answerable questions | little on its own — a system returning 1 doc gets 1.0; always reported beside `recall@k` |
| `answerability_gap` | `recall@20 − recall@5` | — | a non-zero gap means the k-window, not the index, is the bottleneck; it does not tell you which |

**Per-tier breakdown is mandatory for every metric above.** A pooled number
across all four tiers is explicitly rejected: easy questions dominate any pooled
rate, and a system that scores 95% pooled while scoring 40% on hard is exactly the
shape of result this benchmark exists to expose.

**Stratified reporting.** Every tier table is printed alongside the same table
for the `medium` tier restricted to questions whose evidence set is *disjoint*
from every distractor's evidence set. If the two tables disagree, the generator's
distractors are entangled with the evidence and the run is invalid.

### 5.2 ANSWER-quality metric (one, judged, secondary)

| Metric | Definition | What it does NOT prove |
|---|---|---|
| `judged_answer_accuracy` | fraction where `answer_correct` (§4.3) is true, per tier | **faithfulness** — a correct answer can be reached from wrong evidence; the judge sees the cited answer and the gold answer, not the retrieval path |
| `judged_self_disclosure_rate` | fraction of answers with `"I don't know"`/refusal | pairs with coverage: high refusal + high coverage ⇒ synthesis is the bottleneck, not memory |

The judge is an LLM given only `{question, gold_answer, cited_answer}` and asked
for a binary verdict plus a one-sentence reason. It is **not** shown the evidence
set, so it cannot launder a retrieval failure into a pass. It is also **not**
shown the hop chain, for the same reason.

**Determinism of the judge is not assumed.** The same judge prompt is run at
`temperature=0` (or the provider's equivalent), and a 100-question stratified
subset is judged **three times**; the reported `judge_disagreement_rate` is the
fraction of the subset where the three verdicts are not unanimous. If that rate
exceeds 5%, the judged metric is reported as `null` with the disagreement rate,
never as a number.

### 5.3 Latency

Measured per question, in three separate series (they have different causes and
must not be merged):

| Series | What is timed | Note |
|---|---|---|
| `retrieval_latency` | wall clock of one recall call | the number that matters for chat UX |
| `end_to_end_latency` | question → cited answer, when synthesis is enabled | includes LLM time |
| `ingest_write_latency` | one `remember` call | reported once per corpus build, not per question |

Reported as `p50 / p90 / p99 / max / n`, per tier **and** per search strategy
(`CHUNKS`, `SUMMARIES`, and the third gated strategy — `NATURAL_LANGUAGE` on
postgres, `CHUNKS_LEXICAL` on kuzu; see `docs/cognee-http-migration.md` and
`src/lib/cognee-knowledge-graph.ts` lines 345–353). Aggregate latency across
strategies is not reported, because a fast strategy and a slow strategy have
different failure modes.

Percentile caveat: at n=150 (easy), p99 is the 2nd-slowest sample. It is
reported but marked `n_low=true`; conclusions should rest on p50/p90 at tier
level and p99 only on the full 1,000.

### 5.4 What the harness does not compute

- Retrieval-*set* relevance (nDCG) — ground truth is a minimal set, not a graded
  ranking, so nDCG would fabricate relevance grades.
- Token/cost metrics for the memory layer — the memory layer's LLM spend lands
  on the customer's provider (AGENTS.md, BYOK), and a per-question cost figure
  here would be a measurement of the test's own judge, not of cognee.
- Any routing metric. This harness does not go through `smartRoute`.

---

## 6. Baseline comparisons

**A score with no baseline is uninterpretable.** Three baselines are run on the
identical question set and the identical corpus, and are reported in every table
as the adjacent rows.

### 6.1 `oracle` (upper bound, sanity only)

The ground-truth evidence set returned verbatim at rank 1..n. This must score
`recall@k = 1.0`, `answer@1 = 1.0`, `MRR = 1.0`, `distractor_rejection = 1.0` for
every tier. If it does not, the grader or the ground truth is broken and no other
number in the run is trustworthy. It is a **harness self-test**, not a comparison.

### 6.2 `return_everything` (the specific failure the probe found)

Return the first k documents of the corpus in insertion order, no ranking.
The expected result is *bounded, not observed*:

`P(a specific 3-doc set ⊆ top-10 of 12,000 docs) = C(3,3)·C(11997,7)/C(12000,10) ≈ 4.2e-10`.

So `recall@10` for `return_everything` must be ≈ 0 and `answer@1` must be exactly
0 (the answer document is hit #1 only for questions whose evidence happens to be
inserted first — 1/12000 of them). **A non-zero `answer@1` for this baseline
means the corpus was not actually built to 12,000 documents, or that top-k is
being applied after retrieval on the server side.** Either finding invalidates
the run. This is the direct fix for the probe's recorded failure, where a 6-item
store made the baseline score 100%.

### 6.3 `random` (chance)

Return k uniformly-random documents. Expected `recall@k ≈ C(n−h, k−h)/C(n, k)`
with `n=12000`, `h=|evidenceDocIds|`; for `h=2, k=10` that is `8.3e-6`. Expected
`answer@1 = 1/12000 = 8.3e-5`. Reported to one significant figure as "≈ 0" with
the derived expectation printed beside it, so a reader can see the arithmetic
rather than a claim.

### 6.4 `bm25_naive` (the discriminating baseline — this is the real bar)

Postgres `ts_rank` (or the repo's existing FTS path, `src/lib/rag-fts.ts`)
computed over the same corpus, returning top-k by lexical score. This is the
**only** baseline that can plausibly score well, and it is the one that decides
whether the memory layer earns its place.

Expected shape — *stated as a prediction to be falsified, not as a result*, and
the falsification is the point:

| Tier | Predicted `bm25_naive recall@10` | Why |
|---|---|---|
| easy | high | the answer token is in the document |
| medium | moderate–high | the question and `docB` share the answer-adjacent vocabulary |
| hard | **low** | the question names only `docA`'s entity; `docC` has near-zero lexical overlap with the question |
| complex | **low** | resolution cues ("as of", "superseded") are not lexical matches to the answer |

**The claim this benchmark would be entitled to make** is the *gap* between
cognee and `bm25_naive` on `hard` and `complex`, and only that gap. If
`bm25_naive` matches cognee on hard and complex, then the graph layer is doing
nothing that lexical ranking was not already doing, and the correct conclusion is
that cognee is not earning its deployment cost on this workload. That is a real
possible outcome and the design must be able to produce it.

Two further baselines, cheap to add and useful as caveats:

- **`chunk_only`** — cognee recall with `searchType: 'CHUNKS'` only, versus
  `CHUNKS + SUMMARIES` (what `docs/cognee-http-migration.md` says the app
  actually requests). Isolates how much of the score comes from the graph versus
  from the flat chunk store.
- **`no_filler`** — the same questions against a 200-document corpus. This
  reproduces the probe's original mistake deliberately, as a demonstration that
  the metric moves with corpus size and is therefore not a property of the model.
  **This baseline's score must not be reported as a benchmark result**, only as
  the corpus-size control's evidence (§7.1).

---

## 7. Controls

This is the section that makes the numbers falsifiable. Each control states its
expectation *before* the run, the check that enforces it, and what a failure
would mean.

### 7.1 Corpus-size control — "return everything" must be impossible

**Argument (arithmetic, not observation).** With 12,000 documents and `k=10`:

- `return_everything` cannot satisfy `evidence ⊆ top-10` for a 3-doc set:
  `C(3,3)·C(11997,7)/C(12000,10) ≈ 4.2e-10`. For the far weaker 2-doc case it is
  `C(2,2)·C(11998,8)/C(12000,10) ≈ 6.3e-7` — still negligible.
- The probability that a *random* ranking puts a specific doc at #1 is `8.3e-5`.
- To make `answer@1` exceed 1% by accident, a corpus would need to be smaller
  than ~100 documents; 12,000 is two orders of magnitude above that.
- The probe's failure required a corpus small enough that all 6 items fitted in
  one window. Here one window is 10 of 12,000.

**Additionally required:** the harness records the actual `hits.length` and the
actual corpus document count on every question and prints
`mean(hits.length) / corpus_size`. If that ratio is ever ≥ 0.01 (i.e. the server
is returning a large fraction of the corpus), the run is marked invalid. This
catches a server-side top-k that is ignored rather than applied.

**Expected result:** `return_everything recall@10 ≈ 0`, `answer@1 = 0`.

**If it fails:** either the corpus was not built to size, or top-k is not honoured
by the server. Both invalidate every other number; the harness exits non-zero and
refuses to print a score.

### 7.2 Unanswerable questions that must miss

**Design.** 100 questions (reported separately; **never** folded into the 1,000
tier rates and never into any pooled accuracy). Each is a real question whose
evidence would exist — but is written to the **mirror dataset**
`bench:cognee1000:mirror`, and asked against `bench:cognee1000:corpus`, where its
evidence does not exist. This is the probe's `CROSS_CONTROL`
(`cognee-quality-probe.ts` lines 159–163), scaled: 100 distinct question/answer
pairs, so a single unlucky pass cannot carry them.

**Expected result:** 0/100 return any `mustNotAppearToken` as the answer, i.e.
the system reports "no evidence" or an answer containing none of the mirror
tokens. Latency is recorded too — the probe's control returned nothing in ~55 ms.

**Scoring rule.** An unanswerable question is *passed* only by declining. An
answer that contains the mirror token is a leak and a failure. An answer that
hallucinates some *other* positive fact is also a failure. Declining is not
itself scored as a "hit" anywhere.

**If it fails:** retrieval is not dataset-scoped. The probe already showed one
version of this (dataset scoping) passing; a failure here means either scoping
regressed, or the mirror questions are accidentally answerable from the corpus
(generator bug → fix the generator, do not relax the control).

### 7.3 Per-question distractors that share the question's vocabulary

**Design.** Every medium/hard/complex question carries 2 distractors minimum
(§3). Distractors are not authored — they are **selected from the corpus's own
colliding documents**: `cognee-corpus.ts` deliberately reuses relation vocabulary
across documents whose correct object is a different entity, so the candidate pool
already exists. `generator.ts` selects distractors that (a) share **≥ 60% of the
question's content tokens**, (b) terminate in an object of the same `EntityType`
as the answer (a vendor for a vendor answer, a day-offset for a date answer), and
(c) appear in a document with the same `DocKind` as the evidence. It rejects
questions whose distractors fall below the 60% overlap.
The generator's own `--with-contradictions` comment states the intent: filler
"reference[s] the same vendors/warehouses/projects as the answer-bearing documents
but assert[s] nothing typeable about them… They raise the collision rate
deliberately."

The attack this blocks is a retriever that scores on topic words. The probe's
FILLER comment makes exactly this point (`cognee-quality-probe.ts` lines
118–122: "the filler deliberately reuses the same domain vocabulary… so a
keyword-overlap retriever has to actually discriminate rather than win on topic
words alone"). At 1000 questions the requirement becomes statistical rather than
anecdotal.

**Also required: the "answered with the distractor" rate must be reported as its
own number.** `distractor_as_answer_rate` = fraction where the cited answer
contains a `mustNotAppearToken`. High `answer@1` combined with high
`distractor_as_answer_rate` is the signature of a system that retrieves the right
*neighbourhood* and reports the wrong member of it — a failure the probe could
only see on 3 questions.

**Expected result:** `distractor_as_answer_rate` at or near 0 for medium, and
materially non-zero for hard/complex if the system stops after hop 2. Either is
informative; only ~0 *and* `bm25_naive` at ~0 would be suspicious.

**If it fails on `oracle`** (the distractor is "cited" by a perfect retriever),
the grader's token-matching is wrong.

### 7.4 Baselines (see §6)

The baseline set *is* a control. Its purpose is to make a score interpretable:
`cognee 71% / bm25 68%` means something categorically different from
`cognee 71% / bm25 12%`, and without the second number the first is not a finding.
**Expected result:** `bm25_naive` beats `random` and `return_everything` by a wide
margin (i.e. the corpus is lexically recoverable at all — otherwise any cognee
score is uninterpretable for the opposite reason), and trails cognee on hard and
complex if the graph is doing work. **If `bm25_naive ≈ random`**, the questions
are not lexically grounded and the corpus is unrealistic; the easy tier should
have caught this.

### 7.5 Single-document answerability check (each question must genuinely need its hops)

This is the control that keeps the tier labels honest, and it is **static — it
runs before any model does**.

`gt-lint.ts` asserts, for every question:

1. **Document-count truth (the 34% trap, §2.2).** The number of *distinct
   documents* whose relations carry the chain's edges equals the tier's required
   doc count. `bm25_naive` was measured to find that 364/1068 two-edge chains are
   fully inside one document; any question built from one of them is rejected
   deterministically, before any model runs.
2. **Minimality.** For every strict subset `S ⊊ evidenceDocIds`, the answer token
   does not appear (as a whole token sequence) in the concatenation of `S`. A
   question failing this is discarded.
3. **Question-alone.** The answer token does not appear in the question text.
4. **Single-doc sufficiency across the corpus.** For every document in the
   *entire* corpus (not just the evidence set), require that no single document
   alone contains a token sequence matching the answer AND every entity named in
   the question. If some unrelated document — or one evidence document — contains
   the whole chain, the question is rejected. This is the check that catches both
   the corpus's own collisions and a cognee chunking choice that merged two
   evidence documents.
5. **Post-ingest chunk re-check.** After ingest, re-run check 4 at *chunk*
   granularity over the actual returned chunks, because the relation-to-chunk
   mapping is cognee's, not ours. With `--docs=12000` this is the only way to know
   the one-document trap did not reappear through chunking.
6. **Hop-chain truth.** `hopChain.length === evidenceDocIds.length`, and each
   hop's `to` value appears only in that hop's `docId` across the whole corpus
   (checked against `CorpusIndex.entitiesByType` / `documents[].relations`, not by
   search).

**Expected result:** 100% of the 1,000 questions pass, after regeneration of the
failures. The generator is expected to *discard* generated candidates — at the
measured 34% same-document rate, a discard rate materially above zero is the
normal case, and a 0% discard rate means check 1 is not running.

**If it fails:** the tier assignment is fiction and the per-tier breakdown is
worthless. This is a hard gate: the runner refuses to start on a question set
that has not passed `gt-lint` (exit non-zero), rather than printing a number with
a footnote.

### 7.6 Leakage / dataset-scoping check

Three sub-checks, each with a distinct failure meaning:

| Check | Method | Expected | Failure means |
|---|---|---|---|
| **Dataset scope** | ask a corpus question against `bench:cognee1000:mirror` (which holds a disjoint fact set) and against a freshly-created empty dataset | 0 hits carrying the answer, both times | recall is not dataset-scoped; every hit above is suspect |
| **Question→answer leak in the question text** | static: `answer` must not be a token subsequence of `question`; `answer` must not appear in any `distractorStrings` of *another* question whose answer is different | pass for all 1,000 | the question states its answer; the metric measures copying |
| **Corpus→mirror leak** | assert zero shared document ids and zero shared fact texts between the two namespaces, by hash of the fact strings | 0 shared | the "unanswerable" control is answerable |

**If the dataset-scope check fails:** the run is invalid — the probe's control
exists precisely because this failure mode is real, and it is the reason the probe
distrusts its own 100%.

### 7.7 Order/position control (insertion-order sensitivity)

Insertion order can make a `return_everything`-shaped system look non-trivial.
The control: ask 100 questions twice — once against the corpus as built, once
against a rebuild with the same facts in a shuffled insertion order (same
`seed`, `--shuffle` flag changes only ordering). **Expected:** `answer@1` differs
by ≤ 3pp; `return_everything`'s `answer@1` is 0 in **both** orders. **If
`return_everything` scores non-zero in either**, top-k is not being honoured.

### 7.8 Self-judging control

`README.md`'s RAG eval already records the reason: a judge that is the same
model as the generator inflates scores (self-preference bias) —
`benchmark/rag-eval.ts` lines 40–46 requires `RAGAS_JUDGE_*` to point at a
*different* provider or flags the run self-judged. The same rule applies here:
the run records `judge_model`, `generator_model`, and `synthesis_model`; **if the
judge equals the synthesis model, `judged_answer_accuracy` is printed with a
`SELF_JUDGED` marker and must not be quoted without it.** Retrieval metrics are
unaffected — they never call a judge. That is the main reason to lead with them.

---

## 8. Honest scope — what these numbers do NOT prove

Read this section before quoting any figure the harness prints.

1. **This measures RETRIEVAL, not faithfulness.** A hit means the joined evidence
   was *findable*. It does not mean the final reply used it, stated it correctly,
   or cited it. `judged_answer_accuracy` is a partial bridge and only a partial
   one: the judge sees a string comparison, not the reasoning.
2. **The corpus is synthetic.** It is generated from templates. Real documents
   contain tables, PDF extraction noise, OCR errors, boilerplate headers,
   duplicate uploads, and multi-paragraph facts that span chunks. None of that is
   present. A synthetic corpus is *cleaner* than production, so these numbers are
   an **upper bound** on the same metric over customer data, not a proxy for it.
3. **One language, one domain, one vocabulary family.** English, procurement. The
   deployment is bilingual (`docs/hasil-pengukuran.md` records Indonesian
   questions; `golden-set.ts` generates a bilingual set) — the bilingual case is
   out of scope here. Multi-lingual recall is not measured.
4. **Not customer scale in the dimensions that matter.** 12,000 documents is two
   orders of magnitude larger than the probe's 16 items, but `docs/cognee-http-migration.md`
   states this deployment's memory footprint has not been measured on a
   customer-sized corpus, and upstream reserves 8 GB. 12,000 short synthetic
   enterprise memos — the corpus generator's own `stats.chars` is the figure to
   quote, measured at 667,030 characters for 2,000 docs and therefore roughly
   4 MB at 12,000 — are not 12,000 real customer documents in token volume,
   entity density, or graph degree. The generated world also holds only 766
   distinct entities, so it is far denser in collisions and far *sparser* in
   entities than a real corpus of that size. **A pass here is not a capacity
   statement.**
5. **A single run is not a rate.** The repo already learned this with the
   800-question benchmark: 3 of its 5 failures answered correctly 5/5 when
   re-asked (`trial/cross/README.md`). Per-question verdicts are noisy; run
   `--trials 3` on a stratified 300 before calling any single failure a defect,
   and report the variance-corrected figure next to the raw one, as the README does.
6. **`judged_answer_accuracy` has a judge, and judges are fallible.** It is
   binary, prompt-fragile, and can be biased by answer length or phrasing. The
   `judge_disagreement_rate` (§5.2) bounds repeat-noise but not systematic bias.
   A better judge (a human, 100 stratified questions) is not in this design.
7. **A passing score is not evidence of production answer quality.** Passing means
   the evidence was retrievable and rankable ahead of vocabulary-sharing
   distractors on a synthetic corpus, in one language, in one run, against a
   lexical baseline. The shipping question — "does the assistant answer the
   customer's question correctly" — requires a judge, a real corpus, and a
   faithfulness measure. This harness provides none of the three.
8. **It says nothing about isolation in production.** §7.6 checks the benchmark's
   own two namespaces. It does not re-verify org scoping of
   `org:<id>` / `org:<id>:kb` (`src/lib/cognee-types.ts`), which is covered
   elsewhere and by different means.

---

## 9. Validity threats and mitigations

| # | Threat | How it produces a misleading number | Mitigation | Residual risk |
|---|---|---|---|---|
| 1 | **Corpus too small** | "Return everything" scores ≥ "good traversal"; the probe's actual recorded failure (100% on 6 items) | 12,000 docs; §7.1 arithmetic bound; `return_everything` baseline must score ~0; `mean(hits)/corpus_size ≥ 0.01` invalidates | Low. Leftover: if the server ignores top-k, the control catches it, but only as a whole-run abort, not a per-question signal |
| 2 | **The question leaks its answer** | The metric measures string copying, not retrieval | §7.6 static check: answer ∉ question; answer ∉ any distractor string of another question | Low. A *paraphrase* of the answer can still leak ("the company named after sunlight" → Sinar Abadi); the generator's paraphrase templates are hand-reviewed, which is a human check, not an automated one |
| 3 | **Answerable from one document** | Tier labels become fiction; a 1-edge system scores well on "3-edge" questions | §7.5 minimality over every strict subset, plus a whole-corpus single-doc check; hop chains come from typed relations, not parsed prose | Low for the generator's fact shape; medium if two relations land in one document. `cognee-corpus.ts` emits multiple relations per hot document (1,109 relations over 784 hot docs, ≈1.4/doc), so documents are **not** one-fact-per-document — the generator must verify per question that no *single* document contains the whole chain |
| 4 | **Ground truth is wrong** | Every downstream number is wrong in an unknown direction | `oracle` baseline must score exactly 1.0 (§6.1); `gt-lint` minimality; each fact traceable to a generator row | Low. The oracle check catches grader/GT *inconsistency*, not a shared misreading of the corpus |
| 5 | **Grader too lenient (substring on a common token)** | "batch" in the answer scores a hit; inflated accuracy with no real retrieval | Whole-token-sequence matching only (§4.3.3b); answers must be ≥2 tokens, ≥5 chars, and occur in <0.5% of the corpus; distractor rejection is *forced* even when the positive rule passes (§4.3.3c); `distractor_as_answer_rate` reported separately | Medium. Synonym paraphrase ("Sinar Abadi" vs "the Abadi company") is deliberately NOT accepted — this makes the grader *stricter* than a human, i.e. it under-reports. The `answerAliases` list is generator-derived, not hand-tuned after seeing results; any post-hoc alias addition must be recorded in the results JSON with the question ids touched |
| 6 | **Self-judging by the same model** | Inflated `judged_answer_accuracy` | Judge model ≠ synthesis model recorded; `SELF_JUDGED` marker (§7.8); retrieval metrics need no judge | Low for the headline (retrieval is judge-free); the judged number remains advisory |
| 7 | **Non-determinism** (LLM extraction, server-side search, synthesis sampling, judge sampling) | A single run's per-question verdicts are noisy; a defect and a sample look identical | `--trials N` with a stratified 300-question repeat; report raw **and** variance-corrected figures, exactly as `trial/cross/repeat.ts` does; `judge_disagreement_rate` at `temperature=0`; latency percentiles from the pooled trials | Medium. The memory layer's own ingest is non-deterministic and is *not* re-run per trial; a trial re-measures retrieval on a fixed graph, so ingest-level variance is invisible. Mitigation: `--rebuild` runs a full re-ingest for at least one trial |
| 8 | **Question phrasing is ambiguous** | The model is right and the question is wrong; the score under-reports | The 800-question benchmark learned this the hard way — "phrase around ambiguity, do not score it" (`trial/cross/README.md`), and three questions there had 2–3 defensible answers | Medium. The generator's templates reduce but do not eliminate this. Mitigation: a 50-question hand-read gate per tier before a published run; any question with a second defensible answer is removed and the removal count is reported |
| 9 | **Unevaluated k** | Reporting only `k=10` hides whether the ranker or the window is the bottleneck | `recall@5/10/20` plus `answerability_gap` (§5.1) | Low |
| 10 | **Rate-limiter artifact published as a low score** | Empty/throttled responses score as misses | The README records this happening once: 196/200 refusals. Harness must abort after 5 consecutive HTTP 429s with `accuracy: null` (the `trial/cross/run.ts` pattern), and both chat limiters must be raised — `CHAT_RATE_LIMIT_PER_MIN` (org, in-handler) *and* `RATE_LIMIT_CHAT_PER_MIN` (per-IP, in middleware, default 30) | Low, if the abort is actually implemented; this is a named, previously-observed failure, not a hypothetical |
| 11 | **Distractors entangled with evidence** | Distractor docs accidentally contain evidence; rejection rate becomes meaningless | §5.1 stratified table: medium-tier rate recomputed on questions whose evidence and distractor sets are disjoint; disagreement invalidates the run | Low |
| 12 | **Insertion order acts as a hidden ranker** | `return_everything` scores non-zero | §7.7 shuffled rebuild; baseline must be 0 in both orders | Low |
| 13 | **Graph-backend mismatch** | Run on kuzu while the deployment ships postgres (or vice versa); the third recall strategy differs (`CHUNKS_LEXICAL` vs `NATURAL_LANGUAGE`) | Record `graph_provider` and `cognee_version` in the results JSON header; refuse to compare runs with different values; pin the image (`docker-compose.yml` pins the sidecar; it was `cognee/cognee:1.5.4.dev20260914` when this design was written and is `cognee/cognee:1.6.0` now — record the version in the run header rather than trusting this line) | Low. But note: results from the local SQLite+kuzu dev mode are **not** transferable to the postgres deployment, and the harness must say so in its own output |
| 14 | **Ingest silently failed** | Questions score 0 for a data-availability reason, read as a retrieval failure | Assert `remember` returned `items_processed > 0` AND independently assert the corpus document count via `GET /api/v1/datasets` / a counting recall before grading; `docs/cognee-http-migration.md` records 0.2.0 reporting `PipelineRunCompleted` in 25 ms while writing nothing | Low, if the independent count is a hard gate. **A `status: "completed"` response must never be the only evidence of a write** — that is the migration doc's central lesson |

**What cannot be fully ruled out.** (a) The synthetic corpus is systematically
easier than production, so all rates are optimistic — no control fixes this
without a real corpus. (b) A sufficiently good lexical retriever that we did not
think to baseline could outperform cognee on hard/complex and we would not know;
`bm25_naive` is one baseline, not a search over the baseline space.
(c) Non-determinism in the memory layer's *ingest* is measured at most once per
run (§9.7).

---

## 10. File and harness layout

**Two existing files are inputs, not deliverables:**
`benchmark/cognee-corpus.ts` (the corpus generator, §2) and, read-only,
`scripts/cognee-quality-probe.ts` (the 3-question probe whose controls this design
scales). Everything new lives under `benchmark/cognee-1000/` and follows the
existing conventions in `benchmark/` (`--flag=value` parsing, JSON output to
`benchmark/results/`, a console summary).

| File | Responsibility | Must not do |
|---|---|---|
| `benchmark/cognee-corpus.ts` **(exists; additively extended)** | Emit the corpus + typed ground-truth relations. Already emits `docs[]`, `index.relations`, `index.documents[]`, `index.corrections`, `index.entitiesByType`, `index.stats`. **Prerequisite change: add the "negative evidence" doc kind required by complex sub-mechanism 3 (§3.1).** | Grow the entity pool (`--docs` must not silently thin the world). Change the seeded output for an existing seed. |
| `benchmark/cognee-1000/generator.ts` | Build the **1,000 questions** from `CorpusIndex.relations`. Emits `questions.jsonl` (§4.1) + a copy of the corpus manifest it was built against. Applies the §3 document-count predicates, the §2.2 chain-collapse filter, and the §7.3 distractor selection. Writes nothing to cognee. | Generate facts (the corpus generator owns them). Call cognee or an LLM. Emit a question that has not passed its own checks. |
| `benchmark/cognee-1000/gt-lint.ts` | Static verifier: §7.5 checks 1–4 and 6, §7.6 question-leak and corpus/mirror disjointness, `mustAppearTokens`/`mustNotAppearTokens` sanity, answer length/rarity rules, and a per-tier **discard-rate report**. Exit non-zero on any failure. | Repair ground truth. It fails; the generator or a human fixes it. |
| `benchmark/cognee-1000/ingest.ts` | Write the corpus into `bench:cognee1000:corpus` and the different-seed mirror into `bench:cognee1000:mirror` via `cogneeRemember` (`src/lib/cognee-http.ts`, multipart). Assert `items_processed > 0` per batch and independently re-count documents. Run §7.5's **post-ingest chunk re-check**. Emits `ingest-manifest.json`. | Grade. Touch any `org:*` dataset. Assume `status === 'completed'` means written. |
| `benchmark/cognee-1000/runner.ts` | Run the questions through retrieval (and optionally synthesis), collecting hits, cited answer, latencies, and raw returned text per question. Writes one JSON per run to `benchmark/results/cognee1000-<iso>.json`. Paces requests; aborts on 5 consecutive 429s with `accuracy: null`. | Score. Compute a number that the grader owns. |
| `benchmark/cognee-1000/baselines.ts` | Implement and run `oracle`, `return_everything`, `random`, `bm25_naive`, `chunk_only`, `no_filler` over the identical questions and corpus. Implements the §7.1 `mean(hits)/corpus_size` guard. | Participate in the headline score. Baselines are reported beside it. |
| `benchmark/cognee-1000/grader.ts` | Pure functions: `normalize()`, `evidenceHitAtK()`, `rankOfFinalHop()`, `mrr()`, `distractorRejected()`, `answerCorrect()` (§4.3), and the answer-rule forces. No I/O, no LLM. Exports per-question verdicts. | Fetch. Read files. Call a model. It must be re-runnable over saved raw output — the README's "raw answers committed, re-scorable" property. |
| `benchmark/cognee-1000/judge.ts` | The single LLM judge call (§5.2), a **separate** judge config (`COGNEE_BENCH_JUDGE_BASE_URL/_KEY/_MODEL`, mirroring `RAGAS_JUDGE_*` in `benchmark/rag-eval.ts`), the 3× repeat on the 100-question subset, and `judge_disagreement_rate`. | Grade retrieval. Rewrite the ground truth. |
| `benchmark/cognee-1000/reporter.ts` | Emit `report.json` and a console table: per-tier × per-metric, baselines as adjacent rows, latency percentiles per strategy, the control results block (§7) with PASS/FAIL and the registered expectation, and a mandatory `scope` block copying §8 verbatim. Exits non-zero if any hard gate failed. | Print a headline number when a hard gate failed. |
| `benchmark/cognee-1000/README.md` | How to build, ingest, run, and read it; the corpus-size arithmetic; the 34%-collapse measurement; the list of claims this run may and may not support. Same shape as `trial/cross/README.md`. | Restate any number as a result before a run exists. |

Nothing outside `benchmark/cognee-1000/`, `benchmark/results/`,
`benchmark/cognee-corpus.ts` (additive), and `docs/cognee-benchmark-design.md` is
touched. No `src/lib` file changes; the harness consumes `cogneeRecall` /
`cogneeRemember` as they are.

### 10.1 CLI flags

```
# 0. Corpus (EXISTING tool). 12,000 docs; corrections ON for the complex tier.
#    Verify it reports hot >= 900 (else ground truth has no anchor docs) and
#    no "some ground-truth relations have no anchor document" warning.
bun benchmark/cognee-corpus.ts --seed=20240917 --docs=12000 \
    --with-contradictions --out=benchmark/cognee-1000/data/corpus.json

# 1. Questions (deterministic, no cognee, no LLM) — built FROM the corpus index
bun benchmark/cognee-1000/generator.ts --corpus=benchmark/cognee-1000/data/corpus.json \
    --out=benchmark/cognee-1000/data --seed=hash-2026
    --tiers=easy:150,medium:350,hard:300,complex:200
    --distractors=2                  # minimum per question
    --shuffle=false                  # §7.7 ordering control
    # prints the per-tier discard rate (expected > 0; see §2.2 the 34% trap)

# 2. Verify ground truth BEFORE anything is ingested (hard gate)
bun benchmark/cognee-1000/gt-lint.ts --data=benchmark/cognee-1000/data
    --check-minimality --check-leak --check-corpus-disjoint
    # exit != 0 => runner refuses to start

# 3. Ingest
bun benchmark/cognee-1000/ingest.ts --base=http://127.0.0.1:8099
    --corpus-dataset=bench:cognee1000:corpus
    --mirror-dataset=bench:cognee1000:mirror
    --batch=50 --purge=first

# 4. Run
bun benchmark/cognee-1000/runner.ts --base=http://127.0.0.1:8099
    --tiers=medium,hard --limit=0     # limit=0 => all
    --topk=5,10,20
    --search-types=CHUNKS,SUMMARIES   # matches the app's actual recall
    --synthesize=false                # retrieval only by default
    --trials=1 --rebuild=false
    --pace-ms=0 --out=benchmark/results/cognee1000-<iso>.json

# 5. Baselines (same questions, same corpus)
bun benchmark/cognee-1000/baselines.ts --data=benchmark/cognee-1000/data
    --only=oracle,return_everything,random,bm25_naive,chunk_only

# 6. Judge (secondary; refuses if judge == synthesis model without a marker)
bun benchmark/cognee-1000/judge.ts --results=benchmark/results/cognee1000-<iso>.json
    --repeat=3 --repeat-subset=100 --stratified

# 7. Report
bun benchmark/cognee-1000/reporter.ts --results=benchmark/results/cognee1000-<iso>.json
    --baselines=benchmark/results/cognee1000-baselines.json
    --out=benchmark/results/cognee1000-report.json
```

Conventions kept from the existing harnesses: long flags `--name=value`
(`benchmark/runner.ts`, `scripts/cognee-quality-probe.ts`) or `--name value`
(`benchmark/sql-eval.ts`) — pick `--name=value` throughout for consistency with
the runner — results under `benchmark/results/` which is already gitignored per
AGENTS.md, and a `--limit` that defaults to running everything.

### 10.2 Validity gates (machine-enforced; a failed gate means no headline number)

1. `gt-lint` exit 0.
2. `ingest` reports `corpus_documents ≥ 12,000` and every batch
   `items_processed > 0`, confirmed by an independent count.
3. `return_everything` `answer@1 == 0` and `recall@10 ≤ 0.001`.
4. `mean(hits.length)/corpus_documents < 0.01`.
5. Unanswerable controls: 0/100 leaks.
6. Dataset-scope check returns 0 hits carrying the answer.
7. `answerability_gap` computed; `recall@20 ≥ recall@10 ≥ recall@5` (monotonic — a
   violation means the runner's k handling is broken).
8. `oracle` scores 1.0 on every retrieval metric, every tier.
9. Zero abort-triggering 429 streaks; zero empty responses counted as misses
   without an explicit `aborted` flag in the results JSON.

Any gate failing ⇒ `reporter.ts` prints the gate table and exits non-zero
**without a score**, on the principle that a number published next to a failure
gets quoted without the failure (the same reason `README.md` reports
`accuracy: null` for a throttled run).

---

## 11. Implementation order

The order matters: each step is usable as a check on the previous one.

0. **Corpus prerequisite.** Extend `benchmark/cognee-corpus.ts` with the negative-
   evidence doc kind (§3.1 sub-mechanism 3), and confirm `--docs=12000
   --with-contradictions` runs, emits ≥900 hot docs, and warns about nothing.
   Re-run the §2.2 collapse measurement at `--docs=12000` and record it — if the
   same-document chain rate rises with filler volume, the generator's filters must
   get correspondingly stricter.
1. `generator.ts` + `gt-lint.ts` (no cognee dependency at all — the whole
   benchmark's correctness is decided here). Report the per-tier discard rate.
2. `grader.ts` + `oracle` baseline. If `oracle` is not exactly 1.0, stop.
3. `ingest.ts` + the corpus-count assertion + the post-ingest chunk re-check.
4. `baselines.ts` `return_everything` / `random` / `bm25_naive`.
5. `runner.ts` and the unanswerable controls.
6. `judge.ts` (optional, last — the retrieval numbers do not depend on it).
7. `reporter.ts` and the validity gates.

Steps 1 and 2 can be developed with no cognee server at all, which is deliberate:
the part of this harness most likely to be wrong is the ground truth, and it is
testable without the system under test.

## 12. What this design deliberately does not do

- **It does not re-measure what `docs/cognee-http-migration.md` already proved**
  (write persistence, cross-session recall, the mechanism). Those are settled; a
  1,000-question run adds nothing to them.
- **It does not extend the 800-question SQL/REST benchmark**, and it must not be
  merged with it. That benchmark runs with `SIMPLE_PIPELINE=1` and bypasses cognee;
  the README already forbids citing it as memory evidence. The two result sets must
  never be combined into one figure.
- **It does not benchmark the router, the planner, or the agentic loop.** A
  question here goes to the memory layer directly. If later runs add synthesis,
  the routing path taken is recorded but not scored, because the 800-question
  benchmark already established that "routing agreement" is not an accuracy
  measure.
- **It does not produce a single headline number.** The deliverable is a
  per-tier × per-metric table with three baselines beside it and a control block
  underneath. A design whose output is one number would be repeatable by a
  README edit, which is exactly the failure mode the probe's comments warn about.
