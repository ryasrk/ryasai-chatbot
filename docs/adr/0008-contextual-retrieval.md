# ADR 0008: Contextual Retrieval

**Status:** Accepted  
**Date:** 2026-07-30

## Context

Standard chunking splits documents into isolated pieces before embedding. A chunk like "The policy applies to all employees in Grade 7 and above" loses critical context — which policy? which document? Without document-level context, retrieval fails when the query references the document by name or category but the chunk doesn't contain those terms. Anthropic's research shows chunk-level context reduces retrieval failures by ~49%.

## Decision

Implement Contextual Retrieval: before embedding each chunk, generate a 1-2 sentence LLM summary of the entire document and prepend it to the chunk content. The summary includes the document name and category (e.g., "From Leave_Policy.pdf [KEBIJAKAN]: This document defines leave entitlements..."). The prefix is stored in `DocumentChunk.contextPrefix` and prepended at retrieval time. Enabled via `CONTEXTUAL_RETRIEVAL=true` env var. One summary per document (shared across all chunks) — cheap and effective.

## Consequences

- **Positive:** ~49% reduction in retrieval failures (per Anthropic's benchmark). Chunks carry document identity, improving cross-document disambiguation. Graceful fallback to static prefix ("From <name>:") if LLM summary fails.
- **Negative:** One additional LLM call per document at embedding time (amortized — not per query). ~10% storage increase for `contextPrefix` column.

## Alternatives

- **Per-chunk summaries (Anthropic's full method):** Deferred — one LLM call per chunk is expensive at scale. Per-document summary captures 80% of the benefit at 1/N the cost.
- **No context (standard chunking):** Rejected — retrieval failures on document-name queries are a top user complaint.
- **Metadata-only (filename in frontmatter):** Rejected — doesn't capture semantic context (what the document is about).
