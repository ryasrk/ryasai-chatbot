# ADR 0006: Agentic Confidence-Gated Loop

**Status:** Accepted  
**Date:** 2026-07-30

## Context

Complex enterprise questions require multiple tool calls ("compare Q3 revenue across regions, then summarize the top performer's policy docs"). Single-pass tool execution produces shallow answers — the router picks one tool and stops. Unbounded agentic loops are expensive and can spiral (repeated tool calls without convergence).

## Decision

Implement a confidence-gated agentic loop: route → execute → evaluate confidence → repeat, with a hard maximum of 3 iterations. An LLM evaluates the answer confidence after each tool execution. A heuristic pre-check skips the LLM confidence call for obvious cases (saves cost). When confidence is low and iterations remain, the evaluator provides a `nextToolHint` injected into the next iteration. Implemented in `runAgenticLoop()` / `runStreamingAgenticLoop()`.

## Consequences

- **Positive:** Better answers for multi-step questions. Bounded cost (max 3 iterations). Heuristic pre-check reduces LLM calls. Cross-source fallback (SQL → RAG → Chat) when one source is insufficient.
- **Negative:** More LLM cost (up to 3x confidence evaluations per question). Higher latency for complex queries. The max-3 limit can truncate very complex multi-step questions.

## Alternatives

- **Single-pass only:** Rejected — cannot answer multi-step questions.
- **Unbounded loop:** Rejected — cost and latency spiral. No convergence guarantee.
- **Fixed DAG (no confidence gating):** Rejected — the planner must know all steps upfront. Confidence gating adapts based on intermediate results.
