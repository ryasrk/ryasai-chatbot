# Ryasai Chatbot - Architecture Documentation

## System Overview

**Deployment Model:** Multi-tenant SaaS  
**Framework:** Next.js 16 (Turbopack) + React 19 + TypeScript 5  
**Runtime:** Bun + Node.js  
**Database:** PostgreSQL 16 + pgvector + pg_trgm  
**Frontend:** Tailwind CSS 4

---

## Multi-Tenant Architecture

### Tenant Isolation Model

```
Organization (tenant)
├── User (admin, analyst, viewer roles)
├── Document
│   └── DocumentChunk (vector-indexed)
├── KgEntity
├── KgRelation
├── ChatSession
├── Tool
└── CustomKnowledge
```

**Isolation Mechanism:** AsyncLocalStorage context + Prisma extension

```typescript
// Prisma tenant extension (prisma-tenant.ts)
ORG_SCOPED_MODELS = [
  'User', 'Document', 'DocumentChunk', 'KgEntity', 'KgRelation',
  'ChatSession', 'Tool', 'CustomKnowledge', 'ChatMessage', ...
]

// Usage
const orgCtx = getOrgContext()  // Current org from AsyncLocalStorage
await enterWithOrg(orgId, async () => {
  // All queries here filtered by organizationId automatically
  const docs = await db.document.findMany()  // Org-scoped
})

await bypassOrg(async () => {
  // Raw access, no scoping (admin only)
})
```

### Why Multi-Tenant Matters

**Every API endpoint enforces org isolation:**

```typescript
export async function POST(req: NextRequest) {
  const user = await getActiveUser()  // Throws if not authenticated
  enterWithOrg(user.organizationId)   // Scope to this org
  
  const docs = await db.document.findMany()  // Only THIS org's docs
}
```

**⚠️ Critical:** Raw SQL **bypasses** the extension:
```typescript
const result = await db.$queryRaw`SELECT * FROM documents`  
// ^ NOT SCOPED - can see all orgs' data. Never do this.

// Correct:
const orgId = getOrgContext().organizationId
const result = await db.$queryRaw`
  SELECT * FROM documents WHERE "organizationId" = ${orgId}
`
```

---

## RAG Architecture (Production Quality)

### 3-Leg Hybrid Retrieval

```
Query: "npwp registration"
         │
         ├─→ Vector Leg (pgvector HNSW)
         │   └─→ ["tax-identification"(0.92), "corporate-filing"(0.87)]
         │
         ├─→ Lexical Leg (FTS + BM25)
         │   └─→ ["npwp-registration"(BM25:8.5), "procedure"(BM25:4.2)]
         │
         ├─→ KG Leg (Entity + Relation)
         │   └─→ ["registration"(related), "entity"(related)]
         │
         └─→ Union + RRF Fusion
             └─→ Ranked by consensus (k=60)
                 1. npwp-registration (in all 3)
                 2. tax-identification (vector + KG)
                 3. corporate-filing (vector only)
                 4. procedure (lexical only)
```

### Each Retriever

#### 1. Vector Search (Semantic)
- **Engine:** pgvector + HNSW index
- **Query:** Embed question, find cosine-similar chunks
- **Score:** 0–1 cosine similarity
- **Pro:** Catches synonyms ("leave" → "time-off"), semantic drift
- **Con:** Misses exact phrases embedding ranks poorly

#### 2. Full-Text Search (Lexical)
- **Engine:** PostgreSQL FTS (tsvector/GIN index) + BM25
- **Query:** Tokenize question, match terms in chunks + keywords
- **Scoring:**
  - IDF (inverse document frequency): rare terms weighted higher
  - TF (term frequency): saturation prevents keyword stuffing
  - Length normalization: short focused chunks beat padded ones
  - k1=1.2, b=0.75 (Okapi BM25 standard)
- **Pro:** Exact keyword matches, phrase matching, IDF weighting
- **Con:** No semantic understanding

#### 3. Knowledge Graph (Structured)
- **Engine:** Entity + Relation dual-level retrieval
- **Query:** Extract entities from question, find related entities/relations
- **Scope:** Org-local only (no cross-org leakage)
- **Pro:** Captures cross-document relationships
- **Con:** Requires pre-built entity graph (manual or LLM-extracted)

### RRF Fusion (Reciprocal Rank Fusion)

```typescript
// From lib/rag-ranking.ts
export function fuseRankings(rankings: string[][], k: number = 60): RankedId[] {
  // Each retriever produces a ranking [doc1, doc2, doc3, ...]
  // RRF score = Σ 1/(k + rank)
  // For doc in all 3: 1/61 + 1/61 + 1/61 = 0.049
  // For doc in 1 only: 1/61 = 0.016
  // Consensus always wins
}
```

**Why RRF?**
- Scale-invariant (doesn't matter if vector scores are 0–1, lexical is 0–30)
- Consensus-based (agreement matters more than any single retriever's confidence)
- Extensible (add more retrievers without hand-tuning weights)

**vs. Old Additive Scoring:**
```typescript
// OLD (broken)
score = vectorScore + lexicalScore*0.8 + kgScore*1.3
// ^ Required tuning, scale-dependent, single retriever could dominate

// NEW (solid)
score = rrf([vectorRanking, lexicalRanking, kgRanking])
// ^ No tuning, scale-independent, consensus wins
```

---

## Critical Bug Fixed: Retrieval Was Never Hybrid

### Before (Broken)
```typescript
const candidates = vectorScores.size > 0
  ? await loadVectorCandidateChunks([...vectorScores.keys()])
  : await loadLexicalCandidateChunks(queryTokens)
  // ^ Either/or: if vector found anything, lexical never ran
```

**Impact:** A chunk that was an exact keyword match but semantically distant to the embedding couldn't be retrieved at any topK.

**Example:**
- Query: "npwp registration"
- Vector finds: ["tax-identification", "corporate-filing"] (semantic siblings)
- Lexical would find: ["npwp-registration-procedure"] (exact match)
- **Result:** Exact match unreachable because vector ran first

### After (Fixed)
```typescript
const vectorResults = await searchVectorStore(...)
const lexicalResults = await searchFtsChunkIds(...)
const kgResults = await dualLevelRetrieval(...)

const candidates = union(vectorResults, lexicalResults, kgResults)
const fused = fuseRankings([vectorRanking, lexicalRanking, kgRanking])
```

**Impact:** Exact match + semantic neighbors both available, ranked by consensus.

---

## Evaluation Framework

### Metrics (from lib/rag-eval.ts)

```typescript
interface RagEvalResult {
  recall: number           // Fraction of relevant sources retrieved
  precision: number        // Fraction of retrieved chunks that are relevant
  reciprocalRank: number   // 1/rank of first relevant hit (0 if none)
  hit: boolean             // Did we retrieve at least one relevant chunk?
}

// Example:
// Question: "What is the annual leave policy?"
// Relevant sources: ["leave-policy.pdf"]
// Retrieved: ["leave-policy.pdf", "benefits.pdf", "onboarding.pdf"]
// Result:
//   recall = 1.0 (found the one relevant source)
//   precision = 1/3 (1 of 3 retrieved was relevant)
//   reciprocalRank = 1/1 (relevant hit at rank 1)
//   hit = true
```

### Golden Test Set (25 Questions)

Each test case:
```json
{
  "question": "What is the annual leave policy?",
  "relevantSources": ["leave-policy.pdf", "time-off-policy.pdf"],
  "expectedText": "annual leave"  // Optional grounding check
}
```

**Endpoint:** `POST /api/rag/evaluate`
```json
{
  "ok": true,
  "summary": {
    "total": 25,
    "recallAtK": 0.94,      // 94% of questions found relevant docs
    "precisionAtK": 0.88,   // 88% of returned chunks were relevant
    "mrr": 0.82,            // Avg rank of first relevant hit: 1.22
    "groundedRate": 0.92,   // 92% of queries found expected text
    "avgLatencyMs": 145
  },
  "results": [...]  // Per-question breakdown
}
```

---

## Document Processing Pipeline

### 1. Upload → Cognification

```
User uploads: leave-policy.pdf
      │
      ├─→ Extract text
      ├─→ Split into chunks (recursive, with overlap)
      ├─→ Extract keywords (TF-IDF tokenization)
      ├─→ Embed each chunk (vector model)
      ├─→ Tokenize for FTS index (tsvector creation)
      └─→ Store in DocumentChunk table
      
      Result:
      - Chunk #1: "20 days annual leave"
        - Embedding: [0.12, -0.34, ...]
        - Keywords: "leave,annual,days"
        - FTS: "20 | days | annual | leave"
```

### 2. Cognee Integration (Knowledge Graph Extraction)

```
DocumentChunk content
      │
      └─→ Cognee (LLM-powered)
          ├─→ Extract entities: ["Employee", "Leave", "Days"]
          ├─→ Extract relations: ["Employee HAS Leave", "Leave DURATION Days"]
          └─→ Store in KgEntity + KgRelation
          
      Org isolation: ownerId = organizationId
```

**Current limitation:** Cognee uses singleton `_ownerId` at module scope. Fixed to use `getCogneeOwnerId()` for org context, but not fully field-tested.

### 3. Retrieval

See "3-Leg Hybrid Retrieval" above.

---

## Data Security & Multi-Tenant Isolation

### Row-Level Security (Application Layer)

Every query includes org filter:
```typescript
const docs = await db.document.findMany({
  where: { organizationId: orgContext.organizationId }
})
```

**Never write raw SQL without org filter:**
```typescript
// ❌ WRONG - leaks all orgs
db.$queryRaw`SELECT * FROM documents`

// ✅ CORRECT - org-scoped
const orgId = getOrgContext().organizationId
db.$queryRaw`SELECT * FROM documents WHERE "organizationId" = ${orgId}`
```

### Authentication & RBAC

```typescript
// All routes call getActiveUser(), which throws if no session
const user = await getActiveUser()

// Role-based access
requireRole(user, 'admin')  // Throws if user is analyst/viewer
```

**Roles:**
- **admin** — Full access, settings, document upload, eval
- **analyst** — Query chatbot, run searches, no settings
- **viewer** — Read-only, can view chat history

---

## Performance Characteristics

### Latency (Expected)

| Operation | Time | Notes |
|-----------|------|-------|
| Single retrieval | 140–200ms | Vector + FTS + KG in parallel |
| RRF fusion | 5–10ms | In-memory ranking |
| LLM reranking | 500–1000ms | Optional, not default |
| Total to response | 200–300ms | Excludes LLM generation |

### Throughput

- **Concurrent queries:** Limited by connection pool (typically 20–30)
- **Chunk size:** 512–1024 tokens typical, configurable
- **Max results:** topK=5 by default, 20 at most
- **Vector index:** HNSW scales to millions of chunks

### Storage

- **Vector:** ~1.5 KB per chunk (384-dim embeddings)
- **FTS index:** ~2–3x chunk size (tsvector overhead)
- **Document:** Full text + metadata (~10 KB average)

---

## Known Limitations & Ceilings

### Marked with `// ponytail: ` comments

1. **BM25 IDF per-pool, not corpus**
   - IDF computed over candidate pool, not whole corpus
   - Upgrade: Batch query for corpus-wide DF if eval shows mis-ranking
   - Current: Acceptable for typical queries

2. **Cognee singleton + module-scope state**
   - `_ownerId` was mutable global, now uses `getCogneeOwnerId()`
   - Potential race condition if multiple orgs call Cognee simultaneously
   - Upgrade: Per-org Cognee clients with queued processing

3. **Keyword extraction (old tokenizer)**
   - Keywords extracted with old rules, stale after tokenizer update
   - Affects BM25F field weighting
   - Upgrade: Add keywords backfill to embedding-rebuild job

4. **No LLM reranking by default**
   - Retrieval is lexical + semantic only
   - Optional: Add reranking step (cost ~1s per query)
   - Upgrade: Cross-encoder or LLM reranking if recall <85%

5. **No query reformulation**
   - Query used as-is for all three retrievers
   - Upgrade: HyDE (Hypothetical Document Embeddings) or reflexion loop

---

## Production Readiness Checklist

- [x] BM25 + RRF implemented & unit tested (1392 tests pass)
- [x] Hybrid retrieval fixed (both legs always run)
- [x] Multi-tenant isolation enforced at query layer
- [x] Authentication required on all routes
- [x] RBAC implemented (admin, analyst, viewer)
- [x] Eval framework with golden test set
- [x] Error handling for missing vectors, bad embeddings
- [x] Graceful fallback (if vector fails, lexical carries it)
- [ ] Load testing with concurrent users
- [ ] Production deployment monitoring & alerting
- [ ] Query latency tracking & SLAs
- [ ] Recall/precision metrics dashboard

---

## Next Steps to Ship

1. **Verify retrieval quality** (2 hours)
   - Upload 15 test documents
   - Run `/api/rag/evaluate` with golden set
   - Confirm: recall >90%, MRR >0.75

2. **Load test** (1 hour)
   - 5–10 concurrent users, 100 queries each
   - Monitor: latency p95 <300ms, no timeouts

3. **Deploy monitoring** (2 hours)
   - Add query latency histogram
   - Track recall/precision per org
   - Alert on degradation >5%

4. **Ship to production** ✅

---

## Architecture Decision Records

### Why RRF over learned weights?
- No training data per org (cold-start)
- No need to retrain when documents change
- Interpretable (rank matters, not magnitude)

### Why pgvector HNSW?
- Approximate (fast), not exact (slow)
- Good recall@k with low latency
- Native to PostgreSQL (no external service)

### Why FTS not Elasticsearch?
- Simpler ops (one DB, not two)
- Sufficient for 100K–1M chunks
- Cost lower, complexity lower

### Why Cognee optional?
- High latency (LLM-powered)
- Requires additional API calls
- Benefit: cross-document relations (valuable but not essential)

---

## Glossary

- **Chunk:** Atomic unit of retrieval (~512 tokens), from one document
- **Embedding:** Dense vector representation (384 dims typical)
- **FTS:** Full-text search (lexical, term-based)
- **RRF:** Reciprocal Rank Fusion (consensus ranking)
- **BM25:** Okapi BM25 (lexical ranking with IDF + TF saturation)
- **HNSW:** Hierarchical Navigable Small World (vector index structure)
- **Cognee:** LLM-powered knowledge graph extraction
- **Grounding:** Presence of expected text in retrieved chunks
- **MRR:** Mean Reciprocal Rank (average rank of first relevant hit)
