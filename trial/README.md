# Live subsystem trial (2026-09)

Ad-hoc trial harness, not part of the test suite or CI. Measures retrieval,
routing, SQL and agentic behaviour against a **seeded local Postgres** with a
**mock LLM**.

## What this can and cannot prove

The LLM in this environment is a mock returning canned text. Therefore:

- **Measurable** (LLM-independent): retrieval recall/precision, chunk ranking,
  which documents are reached, SQL generation inputs, tool routing inputs,
  tenant isolation, vector search, citation wiring. These are computed from
  real embeddings + real Postgres + the real scoring functions.
- **NOT measurable**: answer quality, faithfulness, relevance, RAGAS. Any
  number produced for those would be scoring the mock, not the product. The
  harness refuses to emit them.

## Why it exists

User-reported symptom: *"the LLM sometimes says it doesn't know even though the
answer IS in the knowledge base, and it answers once you name the source."*

That is reproducible without a real model, because the mechanism is in the
retrieval/reflection layer, not the model: `reflectionNote` in
`tool-branches.ts:143` injects *"If the evidence doesn't contain the answer, say
so"* into the answer prompt whenever the reflection LLM judges evidence
"insufficient". A vague query retrieves weaker evidence -> judged insufficient ->
the model is instructed to disclaim. A query that names the source retrieves
unambiguous evidence -> judged sufficient -> no disclaimer.
