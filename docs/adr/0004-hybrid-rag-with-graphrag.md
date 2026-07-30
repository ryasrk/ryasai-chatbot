# ADR 0004: Hybrid RAG with GraphRAG

**Status:** Accepted  
**Date:** 2026-07-30

## Context

Single retrieval methods have known weaknesses: pure lexical search (FTS) misses semantic matches (synonyms, paraphrases); pure semantic (vector) search misses exact keyword matches (product codes, names); neither captures entity relationships across documents. Enterprise queries span structured data (SQL) and unstructured documents (policies, SOPs) with cross-references.

## Decision

Use a hybrid retrieval pipeline combining five signals: (1) lexical full-text search (FTS5/tsvector), (2) semantic vector similarity (pgvector/embeddings), (3) external vector store (Qdrant/Milvus) for scale, (4) GraphRAG via Cognee `recallKnowledgeGraph` for entity-relation retrieval, (5) LLM reranker (opt-in) for final relevance scoring. All signals run in parallel and merge by chunkId with deduplication.

## Consequences

- **Positive:** Better recall — catches both "leave policy" (lexical) and "vacation rules" (semantic). GraphRAG answers multi-hop questions ("who reports to the person who approved SOP-42?"). Graceful degradation: each signal works independently if others fail.
- **Negative:** More complexity — five retrieval paths to maintain. Higher latency (mitigated by parallelization). More LLM cost when reranker is enabled.

## Alternatives

- **Vector-only:** Rejected — misses exact keyword matches (invoice numbers, SKU codes).
- **FTS-only:** Rejected — misses semantic paraphrases. No relationship awareness.
- **GraphRAG-only:** Rejected — loses granular chunk-level evidence. Graph construction is expensive.
