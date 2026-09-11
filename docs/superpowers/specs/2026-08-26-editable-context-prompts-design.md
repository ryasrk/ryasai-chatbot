# Editable Context Prompts — Design

Date: 2026-08-26 · Status: APPROVED

## Goal

Let admins attach free-text "context prompts" to each knowledge document, each
database integration, and to RAG answers org-wide; and improve the existing
org-level system-prompt editor. Each prompt is injected into the LLM only when
its source is actually used for an answer.

## Decisions

- **Per-source injection** (not a single blob): document prompt → RAG answer
  synthesis; integration prompt → SQL synthesis; org RAG prompt → every RAG
  answer. Empty prompts inject nothing.
- **Editable + locked table descriptions**: existing LLM-generated per-table
  descriptions become admin-editable; once edited they carry `manualDescription`
  and `enrichSchemaDescriptions` skips them so edits survive re-enrichment.
- **Extend existing patterns** (not a new ContextPrompt model): add nullable
  columns on Document/Integration, extend the `promptSettings` JSON on AppConfig.
  Idiomatic to this codebase; smallest migration.
- System prompt: **improve the existing editor** (visibility/UX), keep its
  current injection point (`tool-router.ts:147` merges it into `systemPromptPrefix`).

## Schema (Prisma)

- `Document.contextPrompt String?` (≤ 4000 chars, trimmed at write time)
- `Integration.contextPrompt String?` (≤ 4000 chars, trimmed)
- `IntegrationSchema.manualDescription Boolean @default(false)` — when true,
  `enrichSchemaDescriptions` must not overwrite `description`.
- `AppConfig.promptSettings` JSON gains `ragContextPrompt: string` (default `''`);
  `parsePromptSettings`/`mergePromptSettings` extended with backward-compat
  default-fill for existing orgs (missing key → `''`).

Apply via `bunx prisma db push` (this repo's convention — no migration files).

## Prompt-settings lib (`src/lib/prompt-settings.ts`)

- Add `ragContextPrompt: string` to `PromptSettings` + `DEFAULTS` (`''`).
- `parsePromptSettings`: read `ragContextPrompt` (string, else `''`).
- `mergePromptSettings`: accept `ragContextPrompt` in the update shape.

## Injection

### RAG (`runRagBranch` in `src/lib/tool-branches.ts`)
After `retrieveWithReflection`, collect the distinct `documentId`s from
`topChunks`; fetch `contextPrompt` for those docs (one `findMany` by id,
`select: { id, contextPrompt, name }`). Build a `Source guidance` block:

```
[Source guidance]
<org ragContextPrompt>            ← only if non-empty
Document "<name>": <contextPrompt> ← one line per doc with a non-empty prompt
```

Budget: cap total block at **2000 chars**; if exceeded, keep prompts in
retrieval-score order, truncate each with `…` + `[truncated]`, drop the rest
with a `[N source prompts omitted]` note. Prepend the block to the `context`
passed to `generateAnswer` (so it sits with the evidence, not as a system
message — keeps `systemPromptPrefix` semantics untouched). Org `ragContextPrompt`
always applies to RAG answers; per-doc prompts apply only for docs contributing
chunks to that answer.

### SQL (`runSqlBranch` in `src/lib/tool-branches.ts`)
The `integration` row is already fetched there — `select` its `contextPrompt`.
If non-empty, append a `Context guidance:` line into the `generateSql` call's
effective prefix (after `schemaDescription`, before memory). Same 2000-char cap.
Inject into **both** the SQL-generation step and the final `generateAnswer`
step (so the answer prose respects it too).

### System prompt
Unchanged injection (merged at `tool-router.ts:147`). Only the editor UI changes.

### REST / agentic paths
Out of scope for injection (keep focused). The `systemPromptPrefix` they already
receive still carries the org system prompt.

## APIs

- `PATCH /api/documents/[id]` — accept `contextPrompt` (admin role,
  trim, ≤4000, audit-logged; existing route already accepts `description`).
- `PATCH /api/integrations/[id]` — accept `contextPrompt` (admin, trim, ≤4000,
  audit). Extend the existing PATCH body.
- `PATCH /api/integrations/[id]/schema` — accept `{ table: string, description: string }`;
  set `manualDescription=true` on the matching `IntegrationSchema` row. Add
  `DELETE`-style "reset to auto" (set `manualDescription=false` then re-run
  enrichment) OR a `resetDescription` action — pick: `PATCH …/schema` with
  `{ table, description: null }` clears manual + marks for re-enrichment.
- `PUT /api/prompt-tools` — accept `ragContextPrompt` alongside `systemPrompt`
  (extend `mergePromptSettings` usage; audit log gains `ragContextPromptLength`).

All routes: `getActiveUser()` + `enterWithOrg()` + `requireRole(user, 'admin')`
per existing admin-route convention; tenant-route-guard test must stay green.

## UI

- **Knowledge view** (`doc-card.tsx` detail / document detail panel): admin-only
  "Context prompt" textarea with Save (loading state, success toast, char
  counter `0/4000`). Non-admins see read-only or hidden.
- **Data Sources view** (integration detail): admin-only "Context prompt"
  textarea + Save; and per-table description edit (pencil) with a lock badge
  showing `manualDescription` state; "Reset to auto" link clears the lock.
- **Prompt & Tools view** (`prompt-tools-view.tsx`): improve the existing
  system-prompt editor — char counter (`0/8000`), "Where this is injected"
  explainer (chat answers + agentic runs), "Insert default template" button,
  reset-to-empty, explicit save state. Add a new "RAG context prompt" editor
  below it (same textarea pattern, bound to `ragContextPrompt`).

Compact style per PRODUCT.md; English strings; shadcn Textarea + Button.

## Testing

- Unit:
  - `parsePromptSettings`/`mergePromptSettings` new field: default `''`,
    back-compat (old JSON without key → `''`), round-trip.
  - Injection builder (new pure helper, e.g. `buildSourceGuidance(prompts, budget)`):
    distinct docs, score-order truncation, empty-prompt no-op, budget cap,
    omitted-count note.
  - `runRagBranch` with mocked retrieval: assembled `context` contains the
    guidance block; empty prompts inject nothing.
  - `runSqlBranch` with mocked connector: `generateSql`/`generateAnswer`
    receive the integration prompt.
  - `enrichSchemaDescriptions` skips rows with `manualDescription=true`.
- Route tests: PATCH validation (role, length, trim), schema description
  edit + lock + reset, prompt-tools PUT persists `ragContextPrompt`.
- Static guards: `tenant-route-guard.test.ts`, `invariants.test.ts` green.
- E2e (optional follow-up): set a doc context prompt, chat, assert the mock
  LLM received it (mock already echoes prompts in e2e).

## Out of scope

- REST/agent-path injection of per-source prompts.
- Prompt versioning / history.
- Per-document prompt for non-RAG uses (documents only feed RAG today).
- Permissions finer than admin-only editing.
