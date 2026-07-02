# Hybrid RAG Quality Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve RAG retrieval quality with shared scoring, chunk overlap, score breakdown, and chunk-level citations without adding local inference or vector DB dependencies.

**Status:** Completed on 2026-06-26 18:50 WIB. See progress entry `Phase 2.17 Hybrid RAG Quality Phase 1` and `worklog.md` task `production-core-phase-2.17-hybrid-rag-quality-phase-1`.

**Architecture:** Keep RAG logic in `src/lib/rag.ts`. Both `/api/documents/search` and Chat RAG call the same retrieval helper so quality and citations stay consistent. Existing Prisma models remain unchanged for Phase 1.

**Tech Stack:** Next.js route handlers, Prisma SQLite, Bun tests, TypeScript.

## Global Constraints

- No local model inference.
- No external vector DB in Phase 1.
- No workflow builder clone.
- Existing documents must keep working.
- Use TDD: red test before production code.
- Use `rtk` for shell commands where possible.

---

### Task 1: Chunk Overlap

**Files:**
- Modify: `src/lib/rag.ts`
- Modify: `src/lib/rag.test.ts`

**Interfaces:**
- Produces: `chunkText(content: string, options?: { maxChars?: number; overlapChars?: number }): string[]`

- [ ] **Step 1: Add failing overlap test**

Add to `src/lib/rag.test.ts`:

```ts
test('keeps overlap between adjacent long chunks', () => {
  const content = Array.from(
    { length: 80 },
    (_, index) => `token-${index} prosedur invoice pembayaran enterprise`,
  ).join(' ')

  const chunks = chunkText(content, { maxChars: 260, overlapChars: 60 })

  expect(chunks.length).toBeGreaterThan(1)
  expect(chunks[1]).toContain('invoice')
})
```

- [ ] **Step 2: Verify red**

Run:

```bash
rtk bun test src/lib/rag.test.ts
```

Expected: fail because `chunkText` does not accept options/overlap.

- [ ] **Step 3: Implement minimal overlap**

Update `chunkText` signature and split helper:

```ts
export function chunkText(
  content: string,
  options: { maxChars?: number; overlapChars?: number } = {},
): string[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHUNK_CHARS
  const overlapChars = options.overlapChars ?? 180
  if (!content) return []
  return content
    .split(/\n\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
    .flatMap((chunk) => splitLongChunk(chunk, maxChars, overlapChars))
}
```

Make `splitLongChunk` carry trailing words from previous chunk until `overlapChars`.

- [ ] **Step 4: Verify green**

Run:

```bash
rtk bun test src/lib/rag.test.ts
```

Expected: pass.

---

### Task 2: Shared Retrieval Scoring

**Files:**
- Modify: `src/lib/rag.ts`
- Modify: `src/lib/rag.test.ts`

**Interfaces:**
- Produces: `scoreChunk(queryTokens, chunk): RetrievalScore`
- Produces: `type RetrievalScore = { total: number; contentHits: number; keywordHits: number; phraseHits: number }`

- [ ] **Step 1: Add failing score tests**

Add:

```ts
test('phrase match scores higher than scattered token match', () => {
  const queryTokens = tokenize('SLA pembayaran invoice enterprise')
  const phrase = scoreChunk(queryTokens, {
    content: 'SLA pembayaran invoice enterprise wajib selesai 14 hari.',
    keywords: 'sla,pembayaran,invoice',
  })
  const scattered = scoreChunk(queryTokens, {
    content: 'SLA operasional. Pembayaran vendor. Invoice lama. Enterprise umum.',
    keywords: '',
  })

  expect(phrase.total).toBeGreaterThan(scattered.total)
  expect(phrase.phraseHits).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Verify red**

Run:

```bash
rtk bun test src/lib/rag.test.ts
```

Expected: fail because `scoreChunk` missing.

- [ ] **Step 3: Implement scoring**

Add `scoreChunk` to `src/lib/rag.ts`:

```ts
export interface RetrievalScore {
  total: number
  contentHits: number
  keywordHits: number
  phraseHits: number
}
```

Rules:
- content token exact word hit: `+1`
- keyword exact hit: `+2`
- phrase hit for adjacent query tokens in content: `+3`

- [ ] **Step 4: Verify green**

Run:

```bash
rtk bun test src/lib/rag.test.ts
```

Expected: pass.

---

### Task 3: Shared Retrieval Helper

**Files:**
- Modify: `src/lib/rag.ts`
- Modify: `src/app/api/documents/search/route.ts`
- Modify: `src/lib/tool-router.ts`
- Test: `src/lib/rag.test.ts`

**Interfaces:**
- Produces: `retrieveRelevantChunks(args: { companyId: string; query: string; topK: number }): Promise<RetrievedChunk[]>`
- Produces: `RetrievedChunk` with `chunkId`, `documentId`, `documentName`, `chunkIndex`, `content`, `score`, `scoreBreakdown`.

- [ ] **Step 1: Add failing pure helper test where possible**

Add small test for sorting helper if implemented pure:

```ts
test('sorts retrieval chunks by score then chunk index', () => {
  const rows = sortRetrievedChunks([
    { chunkIndex: 2, score: 5 },
    { chunkIndex: 1, score: 5 },
    { chunkIndex: 9, score: 7 },
  ])
  expect(rows.map((row) => row.chunkIndex)).toEqual([9, 1, 2])
})
```

- [ ] **Step 2: Verify red**

Run:

```bash
rtk bun test src/lib/rag.test.ts
```

Expected: fail because `sortRetrievedChunks` missing.

- [ ] **Step 3: Implement shared retrieval types/helpers**

In `src/lib/rag.ts`, add:

```ts
export interface RetrievedChunk {
  chunkId: string
  documentId: string
  documentName: string
  chunkIndex: number
  content: string
  score: number
  scoreBreakdown: RetrievalScore
}
```

Add `sortRetrievedChunks()`.

- [ ] **Step 4: Move DB retrieval into helper**

Move duplicate scoring logic from `tool-router.ts` and search route into `retrieveRelevantChunks()`.

- [ ] **Step 5: Verify route behavior**

Run:

```bash
rtk bun test --pass-with-no-tests
```

Expected: pass.

---

### Task 4: Chunk-Level Citations

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/tool-router.ts`
- Test: `src/lib/tool-router.test.ts` or `src/lib/rag.test.ts`

**Interfaces:**
- Extends `Citation` with optional `chunkIndex?: number`, `snippet?: string`, `score?: number`.

- [ ] **Step 1: Add failing citation metadata test**

Add helper if needed:

```ts
test('builds document citations with chunk index and snippet', () => {
  const citation = buildDocumentCitation({
    documentName: 'SOP.md',
    chunkIndex: 3,
    content: 'SLA pembayaran invoice maksimal 14 hari.',
    score: 8,
  })

  expect(citation.source).toBe('SOP.md')
  expect(citation.query_used).toBe('chunk #3')
  expect(citation.snippet).toContain('SLA pembayaran')
  expect(citation.score).toBe(8)
})
```

- [ ] **Step 2: Verify red**

Run targeted test.

- [ ] **Step 3: Implement citation helper**

Add `buildDocumentCitation()` in `src/lib/tool-router.ts` or `src/lib/rag.ts`.

- [ ] **Step 4: Use citation helper in Chat RAG branch**

Replace document-level `Set(documentName)` citations with top chunk citations.

- [ ] **Step 5: Verify green**

Run targeted and full tests.

---

### Task 5: Live Audit And Progress Log

**Files:**
- Modify: `docs/superpowers/progress/2026-06-25-production-core-phase-1.md`
- Modify: `worklog.md`

- [ ] **Step 1: Upload/live reuse RAG audit fixture**

Use existing live fixture or upload a new one.

- [ ] **Step 2: Search API audit**

Run:

```bash
rtk node - <<'NODE'
// call /api/documents/search with paraphrased SLA invoice query
NODE
```

Expected:
- top result from audit doc,
- score breakdown present.

- [ ] **Step 3: Chat RAG audit**

Ask Chat a paraphrased knowledge question.

Expected:
- `RAG/success`,
- chunk-level citation,
- answer grounded in retrieved chunk.

- [ ] **Step 4: Verification**

Run:

```bash
rtk bunx tsc --noEmit
rtk bun run lint
rtk bun test --pass-with-no-tests
```

Expected: all pass.

- [ ] **Step 5: Log progress**

Add Phase 2.17 entry with test and live audit results.

---

## Self-Review

- Spec coverage: Phase 1 covers chunk overlap, shared retrieval, score breakdown, chunk-level citations, tester output, Chat RAG reuse.
- Placeholder scan: no TBD/TODO/implement-later placeholders.
- Type consistency: `RetrievedChunk`, `RetrievalScore`, and citation extension names stay consistent across tasks.
- Live audit note: repetitive chunks from one document initially monopolized top-K; implementation adds per-document diversity with `selectTopRetrievedChunks()` so answer-bearing chunks enter Chat RAG context.
- Verification: `bun test --pass-with-no-tests`, `bunx tsc --noEmit`, and `bun run lint` passed.
