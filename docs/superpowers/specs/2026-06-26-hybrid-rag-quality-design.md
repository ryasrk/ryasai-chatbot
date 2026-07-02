# Hybrid RAG Quality Design

Date: 2026-06-26
Project: `/home/ryasr/ryasai/Chatbot`

## Goal

Improve RAG answer quality by adopting production patterns from PrivateGPT, Dify, and Open WebUI while keeping RyasAI dedicated, simple, and API-only.

## Reference Patterns To Adopt

- PrivateGPT: API-first retrieval/chat separation, source-backed answers, chunk-level provenance.
- Dify: knowledge management, retrieval tester, metadata filtering, retrieval observability.
- Open WebUI: simple admin UX, visible knowledge/source controls, practical RAG prompt behavior.

## Non-Goals

- No local model inference.
- No local embedding model.
- No workflow builder clone.
- No external vector DB in this phase.
- No multi-user/RBAC expansion.

## Phase Strategy

Phase 1 improves quality without schema migration risk:

- keep current `Document` and `DocumentChunk` models,
- improve chunking and scoring,
- add reusable retrieval helpers,
- return score breakdown,
- cite document + chunk index + snippet,
- expose better retrieval tester data,
- keep fallback keyword-only behavior.

Phase 2 can add API embeddings:

- add embedding fields to `DocumentChunk`,
- call OpenAI-compatible `/embeddings`,
- score vector similarity + lexical score,
- optional LLM rerank.

## Current Problems

- Retrieval scoring is duplicated between `/api/documents/search` and Chat RAG.
- Scoring is only content hit + keyword hit.
- Query token matching uses substring search, which can inflate weak matches.
- Citations are document-level only.
- No score breakdown is visible to admin.
- Chunking now has size guard, but no overlap.
- RAG answer prompt does not receive source labels per chunk.

## Phase 1 Design

### RAG Module

Create focused helpers in `src/lib/rag.ts`:

- `chunkText(content, options?)`
  - paragraph split,
  - max chunk chars,
  - overlap chars.
- `scoreChunk(query, chunk)`
  - exact token hits,
  - phrase hits,
  - keyword hits,
  - filename/category boosts when metadata exists.
- `retrieveRelevantChunks(args)`
  - loads ready docs/chunks,
  - computes score breakdown,
  - sorts by total score,
  - returns topK candidates.

### Retrieval Score

Use a simple weighted score:

- exact token hit: `+1`
- keyword exact hit: `+2`
- phrase hit: `+3`
- document/category boost: `+1`

No embeddings yet. This keeps behavior explainable and testable.

### Citations

RAG citations should include:

- `type: DOCUMENT`
- `source: document name`
- `query_used: chunk #N`
- `snippet: first relevant snippet`
- score metadata where useful.

The UI can ignore unknown fields today, but API clients get richer provenance.

### Search Tester

`POST /api/documents/search` returns:

- query tokens,
- top chunks,
- score,
- score breakdown,
- chunk index,
- snippet.

This mirrors Dify-style retrieval tester without adding UI complexity yet.

### Chat RAG

Chat RAG branch should use the same retrieval helper as search route. Answer context should include chunk labels:

```text
[Source: document-name, chunk #3, score 8]
chunk text...
```

Prompt rule:

- answer only from retrieved chunks,
- say evidence is insufficient when chunks do not support the answer,
- cite source naturally.

## Testing

- Chunk overlap test.
- Long paragraph chunking still bounded.
- Score breakdown test.
- Phrase match beats scattered weak token matches.
- Search route returns score breakdown.
- Chat RAG citations include chunk index.
- Live fixture: paraphrased query retrieves correct audit document.

## Rollout

Phase 1 is low risk because it changes only retrieval/chunk logic and response metadata. Existing documents keep working. New uploads get overlap chunks. Existing chunks still retrieve; re-upload/rebuild can improve them later.
