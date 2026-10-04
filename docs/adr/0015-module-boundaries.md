# ADR 0015: Module Boundaries in `src/lib` — No Import Cycles, an 800-Line Cap, Leaves and Ports

**Status:** Accepted
**Date:** 2026-10-04

## Context

Measured on 2026-10-04 (`module-budget.test.ts`): three static import cycles in `src/lib` and nine non-test modules
over 800 lines (`real-connectors` 1,297, `ai` 1,047, `unified-tools` 1,002, `planner` 997, `mcp-client` 987,
`intent-pipeline` 948, `rag-retrieval` 863, `tool-router` 834, `admin-tools` 804). The audit of the same day rated
architecture 7.5 and named those modules and the manual ownership boundaries as the constraint.

The cycles were real coupling, not import noise:

- `errors.ts` ↔ `session.ts` — each needed a class the other defined.
- `rag.ts` → `rag-retrieval.ts` → `knowledge-graph.ts` → `rag.ts` — `rag.ts` was both the public barrel of the
  retrieval layer and the home of `tokenize`, which a member of that layer needed.
- `tool-router` → `tool-router-agentic` → `planner` → `tool-router` (and `tool-selector` → `unified-tools` →
  `tool-router`) — a planner step and a unified tool answer a sub-question by running a whole single-source
  completion, while the router depends on both of them.

The size had a cost that tests did not show: a reviewer of `tool-router.ts` read routing resolution, two transports
and the branch dispatch in one file, and the structural scope tests had to name files by what they *contained*.

## Decision

1. **No static import cycle in `src/lib`, and no module over 800 lines.** Both are absolute rules in
   `module-budget.test.ts`, not ratchets. A module that needs to grow past the cap has two responsibilities.
2. **Break a cycle with a leaf or a port, never with a list.**
   - A *leaf* holds what both sides need and imports neither: `session-errors.ts` (the session error classes),
     `rag-scoring.ts` (tokens and scoring; `rag.ts` is now a pure barrel that members never import),
     `unified-tool-core.ts` (the tool contract and name encoding), `ai-chat.ts` (completion primitives),
     `plan-model.ts` (the pure plan model), `real-connector-shared.ts` (connector plumbing).
   - A *port* makes a genuine back-edge explicit: `chat-completion-port.ts` is the one way a tool re-enters the chat
     router. It imports the router's type statically (erased) and the router itself lazily, so the dependency is
     typed and one-directional at module load, and a test that mocks `@/lib/tool-router` still intercepts it.
3. **Split along the seam the code already had, and keep the public surface.** Each original module re-exports what
   it exported before, so no importer changed: `real-connector-{postgres,mysql,mssql,clickhouse}.ts`,
   `ai-{rest,schema}.ts`, `unified-tools-{mcp,admin}.ts`, `tool-router-routing.ts`, `mcp-transport.ts`,
   `query-expansion.ts`, `rag-vector.ts`, `admin-tools-mcp.ts`.
4. **Inside a layer, import the leaf, not the barrel.** `rag-retrieval.ts` imports `rag-scoring.ts`; importing
   `rag.ts` from inside the retrieval layer is a cycle by construction.
5. **Ownership boundaries the tenant extension cannot see are swept structurally** (`raw-sql-ownership.test.ts`):
   every raw statement that touches an org-scoped table names `organizationId`; a statement built in a variable must
   be listed with its reason; nested relation writes (`connect` / `connectOrCreate`) stay at zero. The sweep found
   one write that filtered by chunk id only (the embedding `UPDATE`), now bound to the organization.

## Consequences

- Largest `src/lib` module after the change: 766 lines (`intent-pipeline.ts`). Zero cycles.
- Structural tests that read source text now read the file that holds the behaviour (`tool-router-routing.ts` for
  routing lookups, `rag-vector.ts` for the pgvector leg) or the whole family (`real-connector*.ts`).
- A dynamic `import()` remains the documented way to break a *runtime* cycle; the port is that pattern given a name
  and a type, so it is used deliberately rather than discovered.
- One load-order effect to know: a test that registers a partial `mock.module('@/lib/session')` AFTER importing
  `errors.ts` no longer gets the real session loaded as a side effect. Modules that need only an error class import
  it from `session-errors.ts`.
