# ADR 0017: Documents Before General Knowledge, and Every Hop of a Compound Question in the Context

**Status:** Accepted
**Date:** 2026-10-05

## Context

Two classes of wrong answers remained after the 2026-10-05 live RAG eval (303 questions, independent judge):

- **General knowledge over the organisation's document.** Questions about an uploaded book, phrased like general
  knowledge ("What accord … was established in 2016?"), were routed to plain chat and answered from the model's
  memory — contradicting the document. The intent model and the selector cannot know what the documents contain.
- **One hop of two.** Most wrong multi-hop answers were a false "not found" with the right document cited. Measured
  with `benchmark/eval-live/retrieval-recall.ts` (is the verbatim evidence in the 4-chunk answer context?): 59.0% of
  multi-hop questions had all their evidence in context, against 92.4% for single facts. The regex split cut
  questions into fragments without their subject, and the union of the sub-retrievals was reranked once against the
  whole question, so the hop the reranker preferred crowded out the other.

## Decision

1. **A cheap lexical probe before general knowledge** (`kb-probe.ts`): on a turn headed for chat, one org- and
   scope-bound full-text statement, no model call. "Strong" when one chunk holds ≥ 60% and ≥ 3 of the question's
   content words — calibrated with the real module on the eval corpus: 20 of 24 book questions, 1 of 40
   general-knowledge questions. A strong probe sends the turn to retrieval with `chatIfUnsupported`: when reflection
   judges the evidence insufficient, the turn is answered as the chat it was, so an accidental match never produces
   "not found in the documents" for a general question.
2. **A compound question is retrieved hop by hop** (`rag-decompose.ts`). For questions that relate two facts, a
   model writes 2–3 standalone sub-questions (one call; the regex split is the fallback). Each hop is expanded,
   retrieved, and reranked against **its own** sub-question; each contributes its top 2 chunks, and `coverageMerge`
   keeps every hop's best chunk through the later cuts. The context grows to max(4, 2 × hops).
3. **Kill switches restore the previous paths exactly:** `RAG_MODEL_DECOMPOSE=false`; a probe that fails or finds
   nothing changes nothing.

## Consequences

- One extra full-text statement on chat turns of an organisation with documents; one decomposition call and one
  rerank per hop on compound questions only. Simple questions take the unchanged path.
- Retrieval quality is now measured at the unit the answer model reads (chunk-level evidence recall), not only by
  document-level citation hit.
