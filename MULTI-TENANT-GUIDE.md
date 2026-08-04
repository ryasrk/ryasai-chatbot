# Multi-Tenant Architecture - Quick Reference

## The Facts

✅ **This repo IS multi-tenant SaaS**  
❌ **NOT single-tenant**

---

## Org Isolation in 30 Seconds

```typescript
// Every table has organizationId
model Document {
  id String @id
  organizationId String  // The org owns this
  content String
  @@unique([id, organizationId])
}

// Prisma extension filters automatically
await db.document.findMany()
// ^ Translates to:
// SELECT * FROM documents WHERE organizationId = $1

// Raw SQL is NOT filtered (DANGER)
await db.$queryRaw`SELECT * FROM documents`
// ^ Can see ALL orgs. Must add WHERE clause yourself
```

---

## Key Rules

### ✅ DO

```typescript
// 1. Call getActiveUser() first (auth check)
const user = await getActiveUser()

// 2. Scope to org
enterWithOrg(user.organizationId, async () => {
  // 3. Query normally (extension handles filtering)
  const docs = await db.document.findMany()  // Only this org
})

// 4. For raw SQL, add WHERE
const orgId = getOrgContext().organizationId
const result = await db.$queryRaw`
  SELECT * FROM documents WHERE "organizationId" = ${orgId}
`
```

### ❌ DON'T

```typescript
// Raw SQL without org filter = data leak
await db.$queryRaw`SELECT * FROM documents`

// Query without auth = no org context
const docs = await db.document.findMany()

// Assume one org = wrong for production
const firstOrg = "hardcoded-org-id"
```

---

## Multi-Tenant Tables

```
SCOPED (auto-filtered by extension):
├── User
├── Document
├── DocumentChunk
├── KgEntity
├── KgRelation
├── ChatSession
├── ChatMessage
├── Tool
├── CustomKnowledge
├── LLMConfig
└── VectorStore

NOT SCOPED (manually filter):
├── Organization (only one per query)
├── Account (OAuth provider data)
└── Session (Clerk/NextAuth)
```

---

## RAG Retrieval is Org-Scoped

```typescript
// Query: "What is leave policy?"
// User: analyst@acme.com (acme org)

const result = await retrieveRelevantChunks({ query })

// Behind the scenes:
// 1. getActiveUser() → org = "acme"
// 2. Vector search
//    SELECT * FROM document_chunks
//    WHERE "organizationId" = 'acme'  ← Org filter
//    ORDER BY embedding <-> query_embedding
//
// 3. FTS search
//    SELECT * FROM document_chunks
//    WHERE "organizationId" = 'acme'  ← Org filter
//    AND to_tsvector(content) @@ query
//
// 4. KG retrieval
//    SELECT * FROM kg_entities
//    WHERE "organizationId" = 'acme'  ← Org filter
```

**Each org sees only their documents, nothing from other orgs.**

---

## Testing Multi-Tenant Isolation

```typescript
// Test: Org A cannot see Org B's documents

// Org A uploads doc
enterWithOrg('org-a', async () => {
  await db.document.create({
    data: { name: 'secret.pdf', ... }
  })
})

// Org B tries to query
enterWithOrg('org-b', async () => {
  const docs = await db.document.findMany()
  // Result: [] (empty, cannot see org-a's docs)
})

// Cross-org raw SQL bypass attempt
const result = await db.$queryRaw`
  SELECT * FROM documents WHERE name = 'secret.pdf'
`
// Result: Could return org-a's doc (BUG if done without WHERE)
```

---

## Org Context Sources

```typescript
// Option 1: From authenticated session
const user = await getActiveUser()
const orgId = user.organizationId

// Option 2: From current context (if already in enterWithOrg)
const context = getOrgContext()
const orgId = context.organizationId

// Option 3: Bypass (admin use only)
await bypassOrg(async () => {
  // No org scoping here
})
```

---

## Common Pitfalls

### Pitfall 1: Assuming Single Org
```typescript
// WRONG
const org = await db.organization.findFirst()
enterWithOrg(org.id)  // Could be any org!

// RIGHT
const user = await getActiveUser()
enterWithOrg(user.organizationId)  // This org only
```

### Pitfall 2: Raw SQL Data Leak
```typescript
// WRONG
const allDocs = await db.$queryRaw`
  SELECT * FROM documents
`
// ^ Returns ALL orgs' documents

// RIGHT
const orgId = getOrgContext().organizationId
const myDocs = await db.$queryRaw`
  SELECT * FROM documents WHERE "organizationId" = ${orgId}
`
```

### Pitfall 3: Cognee State Mixing
```typescript
// OLD (broken)
_ownerId = "org-1"  // Module-level mutable state
// If org-2 calls cognee concurrently, wrong ownerId used

// NEW (fixed)
getCogneeOwnerId() {  // Function, not global var
  return getOrgContext().organizationId
}
```

### Pitfall 4: OAuth Auth Bypass
```typescript
// WRONG
const docs = await db.document.findMany({
  where: { organizationId: req.query.orgId }  // User could fake this
})

// RIGHT
const user = await getActiveUser()  // Throws if not authenticated
enterWithOrg(user.organizationId)   // Use their actual org
const docs = await db.document.findMany()  // Org-filtered
```

---

## Deployment Checklist

- [ ] `getOrgContext()` works (AsyncLocalStorage set up)
- [ ] `enterWithOrg()` wraps all queries
- [ ] `getActiveUser()` called on all API routes
- [ ] No raw SQL without org filter
- [ ] Cognee uses `getCogneeOwnerId()`
- [ ] Tests verify cross-org isolation
- [ ] RBAC roles working (admin/analyst/viewer)
- [ ] Error messages don't leak org names

---

## What This Means for RAG

✅ **Documents are org-private**
- Acme's documents never appear in Zendesk's retrieval
- Each org has isolated vector/lexical/KG indexes

✅ **Queries are org-scoped**
- "What is our leave policy?" only searches org's docs
- No leakage across tenants

✅ **Evaluation is org-specific**
- `/api/rag/evaluate` runs on org's golden set only
- Recall/precision metrics per org

---

## Reference: Architecture Layers

```
┌─────────────────────────────────────┐
│       API Routes (Next.js)          │
│  POST /api/rag, /api/documents      │
│  + getActiveUser() + enterWithOrg() │
└────────┬────────────────────────────┘
         │
┌────────▼─────────────────────────────┐
│   Business Logic (Lib)               │
│  retrieveRelevantChunks()            │
│  Document cognification              │
│  Cognee extraction                   │
└────────┬─────────────────────────────┘
         │
┌────────▼──────────────────────────────┐
│  Prisma ORM (Auto-Filtered)          │
│  ├─ Document.findMany()              │
│  ├─ DocumentChunk.findMany()         │
│  └─ All queries filtered by orgId    │
└────────┬──────────────────────────────┘
         │
┌────────▼──────────────────────────────┐
│  PostgreSQL (Raw Data)               │
│  ├─ documents table                  │
│  ├─ document_chunks (vectorized)     │
│  ├─ kg_entities, kg_relations        │
│  └─ chat_sessions, users             │
└───────────────────────────────────────┘
```

Each layer enforces org isolation.

---

## See Also

- [ARCHITECTURE.md](ARCHITECTURE.md) — Full system design
- [src/lib/prisma-tenant.ts](../src/lib/prisma-tenant.ts) — Extension code
- [src/lib/session.ts](../src/lib/session.ts) — Auth + context
