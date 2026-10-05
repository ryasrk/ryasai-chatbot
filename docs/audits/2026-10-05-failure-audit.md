# Failure audit — the 16 questions the final build got wrong, 2026-10-05 (d)

Scope: every failure of the isolated final run ([`2026-10-05-c-rag-fts-or.json`](2026-10-05-c-rag-fts-or.json); 14 of
255 answerable wrong or partial, 2 of 48 unanswerable not refused). Each cause below was checked against the code or
reproduced, and each hypothesis that did NOT hold is recorded as well. Probes were throwaway scripts against the eval
database; the numbers they produced are quoted with the command shape. Engineering record, not a certification.

## Every failure, classified

| Id | Category | What happened | Cause (§) | Other runs today |
|---|---|---|---|---|
| q151 | cross-language | false "not found"; evidence 0/1 in context | §3, §4 | failed in all 3 |
| q166 | cross-language | false "not found"; 0/1 | §3, §4 | failed in all 3 |
| q167 | cross-language | false "not found"; 0/1 | §3, §4 | failed 1 of 2 others |
| q170 | multi-hop | partial; one hop not retrieved (judge said sufficient) | not isolated (§1 or §4) | correct in both |
| q174 | multi-hop | partial; one hop not retrieved | not isolated (§1 or §3) | correct in both |
| q179 | multi-hop | partial; the JKT-02 table row was never endorsed by the reranker | **§1 (verified)** | failed in all 3 |
| q183 | multi-hop | question does not name its "two policy documents" | §7 | failed 1 of 2 |
| q185 | multi-hop | evidence found on pass 2, answered "only one figure available" | **§2 (verified)** | failed 1 of 2 |
| q186 | multi-hop | one hop missed: English sub-question, Indonesian evidence | §3, §1 | correct in both |
| q278 | multi-hop | both hops missed; "1.240 karyawan" is in many policies, the named one not chosen | §4 | failed in all 3 |
| q223 | distractor-book | answered from the web; correct when re-asked without load | §5, §6 | correct in both |
| q235 | distractor-book | answered from the web; correct when re-asked without load | §5, §6 | correct in both |
| q241 | distractor-book | the selector picks `web_search`; the documents are never tried — reproduces without load | **§5 (verified)** | failed 1 of 2 |
| q232 | distractor-book | evidence 0/1; "GDPgrowth" splits wrongly (§8) | §8 | failed 1 of 2 |
| q257 | unanswerable | answered "Yes" with related certification facts | §7 | refused in both |
| q296 | unanswerable | refused, then padded with facts its citations do not support | §7 | refused in both |

## Causes, with the evidence for each

### §1 The reranker reads the first 300 characters of each chunk

`rag-retrieval.ts:327` builds the rerank prompt from `content.slice(0, 300)`. Measured over the corpus: of 267 evidence
quotes located in a chunk, **146 (55%) start after character 300** — multi-hop 32 of 69, factual 82 of 136, distractor
19 of 24. For those, the reranker judges a chunk whose answer it cannot see. q179 is the verified case: the insurance
table chunk opens with its header and five fleet rows; the JKT-02 row is ~1,000 characters in, the hop's rerank endorsed
the neighbouring chunk (BPN-05 row) instead, and the merged sufficiency verdict ("reranker verdict") inherited the
blindness — 3 of 3 probes insufficient. This also explains a result of the morning: reranking only compound hops raised
correctness 12 points because single questions stopped being reranked blind (`ed6a471`).

### §2 The sufficiency verdict is not re-taken after the second pass

`retrieveWithReflection` (intent-pipeline.ts ~585–608) judges the first pass; when that says insufficient it retrieves
again, merges, and returns **the first verdict** with `retrievalPasses: 2`. `rag-pipeline.ts:75` then appends
`INSUFFICIENT_EVIDENCE_NOTE` ("if the answer is not in the evidence, say your search did not find it") and reports
`supported: false` — which on a probe-routed turn falls back to chat. Measured: 33 of 255 questions take a second pass;
**in 20 of them every evidence quote is in the final context**, and they still carry the stale note (12 multi-hop). In
the final run 4 of those 20 were wrong or unfaithful: q185 (answered "I can't compute the ratio") and q271, q273, q281
(correct, unfaithful).

### §3 Cross-language retrieval

The bridge is a 39-entry synonym table (`query-expansion.ts`) plus a 384-dimension `paraphrase-multilingual-MiniLM-L12-v2`
embedding. Chunk-level recall: cross-language 83.3% against factual 98.6%. The misses are English questions over
Indonesian documents and the reverse (q151 "Employee Compensation and Allowance Policy" ↔ `hr-02-kompensasi-tunjangan`;
q166 "SOP asuransi kargo" ↔ English `risk-02-asuransi-klaim`; q186's hop "backup data retention" ↔ "masa retensi arsip
cadangan").

### §4 A question that names a document is not anchored to it

q151, q166, q278 (and q167's "Section 1" of the tariff) name the policy; retrieval returns other documents with similar
sentences ("1.240 karyawan" appears in several policies). `CONTEXTUAL_RETRIEVAL` exists but is off — **0 of 1,336 chunks**
carry a `contextPrefix` — and where on, the prefix reaches the embedding only, never `tsv`.

### §5 A web pick bypasses "documents before general knowledge"

ADR 0017's probe redirects a `CHAT` verdict only (`tool-router.ts:262`). `web_search`/`web_fetch` map to `PLUGIN`
(`tool-selector.ts:126`), so a question the documents hold is answered from the web when the selector reaches for it.
q241 reproduces this with no load (2 of 2 re-asks: web, wrong). Its probe is STRONG (3/3 terms) and, when retrieval is
run, the judge says sufficient 3 of 3.

### §6 Under load, routing is unrecorded

q223 and q235 were answered from the web in the concurrency-16 run and correctly (RAG) when re-asked alone. The server
log shows `tool-selector: LLM call failed — timed out` at 12:09:25–40, when those questions ran; the fallback
(`routeQueryOrDegrade`) is another model call. Which route each turn took is not recorded anywhere — not in
`tool_runs`, not in the log — so the path cannot be confirmed after the fact.

### §7 Eval-set and grading cases

- q183 asks about "kedua dokumen kebijakan" without naming them — the question is under-specified; the reference
  assumes two particular policies.
- q296 refused correctly, then listed related facts its citations do not hold; graded fabricated. q257 answered "Yes"
  from related certification rules. Both are padding after (or instead of) an abstention.

### §8 A defect in this session's glued-word split

"GDPgrowth" splits as "GD Pgrowth": the acronym rule assumes `HTMLParser` (last capital starts the next word), which is
wrong when the next word is lower-case. q232's evidence sits in that span.

## Hypotheses that did NOT hold

- *The sufficiency judge rejects the distractor-book evidence (q223/q235/q241).* No: retrieval puts the evidence at
  rank 0 and the judge says sufficient in 9 of 9 probes. The failures are routing (§5, §6).
- *The judge's 8,000-character window cuts the evidence off (q185).* No: the evidence starts at 2,743 characters.
- *`reasoning_effort: none` weakens the judge.* No: the same verdicts with the model's default reasoning (6 of 6).

## Best practice for each cause

| § | Practice | Source | Applied here as |
|---|---|---|---|
| 1 | Judge relevance on the part of the passage that matches the query, not its opening: query-biased summaries let readers judge relevance without the full text | [Tombros & Sanderson, SIGIR 1998](https://ir.webis.de/anthology/1998.sigirconf_conference-98.2) | Give the reranker a query-biased window (the span with the densest query-term overlap, deterministic, same token budget) or the whole chunk on compound hops |
| 2 | Decide from the context the generator will actually see; abstain only when THAT context is insufficient | [Joren et al., *Sufficient Context*, ICLR 2025](https://arxiv.org/abs/2411.06037); iterative retrieval re-assesses after each round — [IRCoT, ACL 2023](https://arxiv.org/abs/2212.10509) | Re-judge (or re-derive the verdict) on the merged second-pass context before the note and `supported` are set |
| 3 | Cross-lingual retrieval: translate the question into the corpus languages, and/or use a retriever trained for cross-lingual search | [Multilingual RAG, arXiv 2504.03616](https://arxiv.org/abs/2504.03616) (question translation vs multilingual retrieval); [BGE-M3, arXiv 2402.03216](https://arxiv.org/abs/2402.03216) (MIRACL, MKQA) | A translated variant of the question (ID↔EN) as one more retrieval query; evaluate BGE-M3 against MiniLM on `retrieval-recall.ts` before any migration (384 → 1024 dims re-embeds every chunk) |
| 4 | Contextualise chunks for BOTH the embedding and the BM25 index | [Anthropic, *Contextual Retrieval*](https://anthropic.com/news/contextual-retrieval): −35% failed retrievals with contextual embeddings, −49% with contextual BM25 added, −67% with reranking | A static, model-free prefix (document title, both languages where known) into `tsv` and the embedding text; the LLM summary stays optional |
| 5 | Go to the web only when the knowledge base does not hold the answer | [CRAG, arXiv 2401.15884](https://arxiv.org/abs/2401.15884): web search is triggered by an "Incorrect" retrieval verdict | Apply the kb-probe to `web_search`/`web_fetch` picks too, with the web as the fallback when retrieval is unsupported (as `chatIfUnsupported` does for chat) |
| 6 | Record each agent decision and tool execution as a span with its operation and tool name | [OpenTelemetry GenAI semantic conventions](https://openobserve.ai/blog/opentelemetry-genai-semantic-conventions.md) (`gen_ai.operation.name`, `execute_tool`; agent conventions still in Development) | Put the route, its source (selector / fallback / probe) and the selector failure on the turn's trace |
| 7 | Guided abstention: answer only from sufficient context, abstain briefly otherwise | Joren et al. (above): selective generation raised accuracy-when-answering 2–10% | Fix q183's wording in the question set; an abstention instruction that forbids padding with facts not in the cited evidence |
| 8 | — | — | Emit BOTH splits for an acronym run followed by lower case ("GDP growth" and "GD Pgrowth"); the index is additive, so the extra variant is harmless |

## Recommended order

1. **§2 stale verdict** — smallest change, 20 questions affected, measurable with `retrieval-recall.ts` plus the eval.
2. **§1 rerank window** — deterministic, no new model call; measure multi-hop chunk recall and answer correctness.
3. **§5 web picks honour the probe** — reproduces deterministically (q241); needs care for a user who explicitly asks
   for the web.
4. **§6 record the route** — needed to confirm §5/§6 under load.
5. **§4 then §3** — contextual prefix in `tsv` + embedding (re-embed 1,336 eval chunks), then query translation; the
   embedding-model swap only after a recall comparison.
6. §7 and §8 — question-set and split-rule fixes.

The audit itself changed no code; the fixes below came after it, each with its own test and negative control.

## Fixes applied, and what each measured

| § | Change | Module | Unit evidence (negative-controlled) | Measured |
|---|---|---|---|---|
| 2 | The verdict is re-taken on the second-pass context when that pass added a chunk | `intent-pipeline.ts` | re-judged on the merged context; unchanged context → no extra call | 29 second-pass questions: 8 with all evidence now judged sufficient (0 before, by construction); 1 new sufficient verdict on missing evidence (q145) |
| 1 | The reranker sees a query-biased window (+ heading / table header), not the first 300 characters | `rerank-window.ts` | the prompt carries a row 1,000 characters into a chunk | evidence visible to the reranker 103/272 → 228/272 (3 lost); q179's chunk recall 1/2 → 2/2; multi-hop chunk recall flat overall (61.5 → 59.0%, quotes 76.9 → 76.9%) |
| 5 | A web pick — one call or a plan of web calls — goes to the documents first when the probe is strong; the web is the fallback; an explicit web request or a URL is honoured | `tool-router.ts`, `tool-router-routing.ts`, both RAG branches | both transports; mixed web+data plans still run as plans | q241 replayed in-process: web 3/3 before → documents, "8.2%", 3/3 after (the selector chose `web_fetch` every time) |
| 6 | One `route decided` log line per turn: decision, gated decision, tool, probe, web pick, DAG, and the route's SOURCE (selector / fallback / fallback-degraded) — never the question or model prose | `tool-router.ts` | the line, its source on a selector failure, no question text | it is what located q241's real path: a DAG of `web_fetch` steps, entered before any single-tool check |
| 3 | On a second pass, the question is also searched in the corpus's other language; its best chunk is guaranteed a place | `query-translate.ts`, `intent-pipeline.ts` | translation searched, its best chunk kept; `RAG_TRANSLATE_ON_MISS=false` makes no call | cross-language chunk recall 83.3% → **100%**; q151, q166 (failed in every earlier run) answered |
| 8 | Both readings of an acronym run into a word ("GDP growth" and "GD Pgrowth") | `glued-words.ts` + migration | TS and SQL agree on a real Postgres | q232 answered in round 3 |

Hypothesis that did NOT hold after the fix (§5 first version): routing a single `web_search` pick through the probe did
not fix q241 — the route line showed the turn never reached that check. It was the multi-tool DAG.

Full eval, 303 questions, same judge, 0 failed judgements, 0 errors, concurrency 16:

| Metric | Final build before (R2) | §1+§2+§5(single)+§6 (R3) | + §3 + §8 (R4) | + §5 for web plans (R5, all) |
|---|---:|---:|---:|---:|
| Answer correctness | 94.5% | 94.1% | **96.9%** [93.9–98.4] | 94.9% [91.5–97.0] |
| Faithfulness | 90.2% | 91.0% | 89.8% | 88.6% |
| Citation hit | 97.3% | — | — | 98.8% |
| Refusal (n=48) | 95.8% | 93.8% | 91.7% | **97.9%** |
| cross-language (n=24) | 87.5% | 87.5% | **100.0%** | **100.0%** |
| multi-hop (n=39) | 82.1% | 76.9% | 89.7% | 69.2% (see below) |
| distractor-book (n=24) | 83.3% | 91.7% | 87.5% | **100.0%** |
| factual (n=144) | 100.0% | 99.3% | 99.3% | 99.3% |
| Failed questions (of 303) | 16 | 18 | 12 | 14 |

**Multi-hop is noise at this n, measured rather than assumed.** R5's 69.2% prompted two more multi-hop-only runs on the
SAME build ([1](2026-10-05-d-multihop-rerun1.json), [2](2026-10-05-d-multihop-rerun2.json)): 27, 34 and 31 of 39 correct
(69.2 / 87.2 / 79.5%, mean 78.6%); 8 questions flip between runs. Today's runs of earlier builds span 74.4–89.7%. No fix
here moved multi-hop measurably; the route log shows R5's change touched 2 of 375 turns (`webPick: true`). Wrong in all
three runs of the final build: q176, q179, q183 (§7, the question), q278 — and multi-hop faithfulness is 59–62% in the
two reruns. Those are the next items.

What R5 settled: every distractor-book question answered (q225, q235, q241 — the web-routing family — now from the
documents), and the refusal misses down to one (q257).

Refusal, R4's four unanswerable misses, two kinds: q247 and q263 say "not found" and then add a related fact the judge
finds unsupported by the cited documents (§7's padding); q257 and q284 ANSWER with a related but different fact — q284
names the cargo insurer when asked for the fleet-vehicle insurer, the exact case the judge prompt describes. Both kinds
moved between runs today (q284 failed in R2, passed in R3). Not changed: the answer prompt — an open item.

First token (serial, streaming, [file](2026-10-05-d-ttft.json)): document median 4.1 / 4.3 / 4.5 s in R3 / R4 / R5 (4.2 s
before), p95 7.2 / 10.0 / 8.0 s; multi-hop 13.2 / 11.9 / 11.1 s. The database median — a path no fix touches — moved
7.8 → 9.0 → 8.8 s over the same hour (provider drift), so sub-second differences are not attributed.

## Agentic eval, and the two defects it found (R6)

The live agentic eval (`run-agentic.ts`, 110 compound and scope questions, one at a time) on R5 found two defects; both
were fixed, negative-controlled, and re-measured as R6 ([R5](2026-10-05-d-agentic-r5.json),
[R6](2026-10-05-d-agentic-final.json), RAG re-run [R6](2026-10-05-d-rag-final.json)).

- **The SQL second chance accepted documents that merely cited something.** "Which warehouse stores the product ordered
  the most in the ERP Demo database?" — the relevance judge rejected correct rows 2 of 2 times and the documents
  answered "not found" from an IT-security policy. The documents now take over only when their evidence is judged
  SUFFICIENT (`runSqlBranch` and `prepareSqlStream`, the evidence passed through so nothing is retrieved twice).
- **The API transport's multi-step hand-off never cancelled the speculative retrieval.** A database-only compound
  question paid for decomposition, two reranks, two judges and a translation it never used (6 of its 14 calls).

| Agentic | Audit (13:48) | R5 | **R6** |
|---|---:|---:|---:|
| Parts correct (n=170) | 96.5% | 97.6% | **97.6%** [94–99] |
| All parts correct (n=80) | 92.5% | 95.0% | **95.0%** [88–98] |
| Silent drops | 0 | 0 | 0 |
| Scope leaks (n=10) | 0 | 0 | 0 |
| Out-of-scope part flagged | 70% | 60% | 80% |
| Latency p50 / p95 | 18.6 / 73.9 s | 13.2 / 25.7 s | **12.2 / 23.3 s** |
| LLM calls / tokens per question | 7.8 / 16,597 | 13.2 / 22,189 | **9.4 / 16,474** |

The remaining +1.6 calls per question are the relevance judge on each SQL step and the re-taken verdict. RAG at R6:
correctness 95.7%, faithfulness 89.0%, refusal 93.8% (q247 and q284 flip between runs, as above), distractor-book 100%,
q095/q116/q134 still answered from the documents; 14 of 303 failed.
