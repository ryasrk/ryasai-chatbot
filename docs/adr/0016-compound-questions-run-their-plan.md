# ADR 0016: A Compound Question Runs Its Plan — on Every Turn, With the Tools the Model Chose

**Status:** Accepted
**Date:** 2026-10-05

## Context

The live agentic eval (`benchmark/eval-live/run-agentic.ts`, 110 compound questions with a known answer per part)
and its first smoke run found four defects that each cut a compound question short:

- **The API never ran a plan.** `/api/v1/chat/completions` (and `/api/agent/dashboard`) read the session history
  *after* storing the question, so the question was its own history: every turn looked like a follow-up and took
  the agentic loop. The loop dispatched its rounds without multi-step permission, so "annual leave days … and how
  many artists in Chinook" answered the documents half and appended "Not answered" for the database half — on every
  try, although the selector asked for both tools 3 of 3 times. The web chat had the same loop defect from turn two.
- **A step re-routed itself.** Every `sql`/`rag`/`rest` step re-entered the full router with only its question:
  intent analysis, the tool selector and a speculative rerank ran again per step (11–14 LLM calls for a two-part
  question), and a `sql` step could be re-routed to another tool.
- **A step was killed while working.** `executePlan` wrapped the whole step — a complete chat pipeline whose calls
  each have their own timeout — in the 30 s sandbox meant for one external call. 11 RAG steps ended
  `Tool "rag" timed out after 30000ms`; that was 10 of the 18 failed parts of the baseline.

## Decision

1. **History is read before the question is stored**, on every route that stores it. A first turn has no history.
2. **A round of the agentic loop may run a plan** (`agenticRound`), but never starts another loop. Only the loop sets
   it, and the loop is entered only under `allowMultiStepDag`, so the opt-in that pays for planning is unchanged.
3. **The plan's tool is final.** A built-in step carries `plannedTool` (and a SQL step its database name). The router
   skips intent analysis and the selector for it; the database name resolves among the active integrations the key
   may read, re-checked against the scope on the result. An unknown or out-of-scope name falls back to ordinary
   scoped routing — never to a guess.
4. **A step that runs the pipeline has a pipeline budget** (`PLAN_STEP_TIMEOUT_MS`, 120 s, under the 180 s agentic
   deadline). Single external calls (MCP, plugin, web, admin) keep the per-tool sandbox timeout.
5. **What is not answered is said.** A failed part is listed under "Not answered" with its reason; a part that needs
   the user is asked (PR #46). Silent drops are measured by the eval and must stay at zero.

## Consequences

- A compound question costs one plan instead of a router per step; single-source questions are unchanged (the eval's
  `single_doc`/`single_db` sets are the cost control).
- The scope guarantees of the router hold for steps: `plannedTool` resolution is scoped, and its fallback is the
  scoped router.
- Guarded by `tool-router.test.ts` (follow-up turns on both transports, planned steps, scope), `planner.test.ts`
  (planned tools, step budget), and the route tests whose database fake now returns what the request created.
