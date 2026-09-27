import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * An API key's DOCUMENT SCOPE must survive the agentic delegation.
 *
 * DEFECT (found by an audit of the scoping feature, then verified against the shipped image).
 * `/api/v1/chat/completions` passes `allowMultiStepDag: true` and `documentIds: <key scope>`.
 * `runNonStreamingChatCompletion` takes the agentic branch whenever `chatHistory` is non-empty — which
 * is every session from the SECOND TURN onward — and that branch built an EXPLICIT argument object that
 * omitted `documentIds`.
 *
 * The loop then re-entered with `documentIds: undefined`, which `retrieveRelevantChunks` documents as
 * "every document". A key scoped to one document set read the whole org from turn two onward, the cache
 * key became the unrestricted `*` segment, and the answers looked CORRECT — they were simply built from
 * documents the key was not allowed to read. Fail-open, silent, ordinary trigger.
 *
 * The streaming sibling passed `...args` and therefore carried the field by ACCIDENT — the two
 * transports diverged, so reading either one alone would not reveal it.
 *
 * WHY THIS GUARD IS SHAPED THIS WAY. The obvious test (call the router with the loop mocked) needs a
 * complete surface stub: the router also imports `runMultiStepDag`, and a partial mock fails at module
 * load with `Export named 'runMultiStepDag' not found` — a configuration error that reads like a code
 * defect. A first attempt at a runtime probe hit exactly that. So this asserts the ARGUMENT OBJECT's
 * shape at the delegation, which is the hop that broke, and it asserts it for BOTH transports so the
 * asymmetry cannot return. The behavioural proof that retrieval honours the scope lives in
 * `rag-retrieval.test.ts` (cross-scope cache isolation) and `api-key-scope.test.ts`.
 */
const src = readFileSync(join(import.meta.dir, 'tool-router.ts'), 'utf-8')

/**
 * Blank full-line comments.
 *
 * LOAD-BEARING in this file: the fix's own notes quote the old call and NAME THE FIELD, so a raw scan
 * matches the explanation instead of the implementation. This repo has been bitten by that repeatedly.
 */
function stripComments(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l
    })
    .join('\n')
}

const code = stripComments(src)

describe('the router forwards the API-key document scope into the agentic loops', () => {
  test('the NON-STREAMING delegation passes documentIds', () => {
    // This is the hop that dropped it. Anchor on the call to `runAgenticLoop` and inspect its own
    // argument object — not on the file as a whole, where the field appears in type declarations too.
    const at = code.indexOf('await runAgenticLoop(')
    expect(at).toBeGreaterThan(-1)
    const call = code.slice(at, code.indexOf('}, runNonStreamingChatCompletion)', at))
    expect(call).toContain('documentIds: args.documentIds')
  })

  test('the STREAMING delegation carries it as well', () => {
    const at = code.indexOf('return runStreamingAgenticLoop(')
    expect(at).toBeGreaterThan(-1)
    const call = code.slice(at, code.indexOf('}, runStreamingChatCompletion)', at))
    // EITHER the spread carries the field, OR the explicit list names it.
    //
    // A bare `includes('...args')` check was NOT ENOUGH and its negative control proved it: deleting the
    // `...args` line left `skipClarification:` and `systemPromptPrefix:` behind, and the guard still
    // passed with `documentIds` gone — the spread was checked as a WORD rather than as the thing that
    // carries the scope. So the test requires the spread to be PRESENT AS A STANDALONE PROPERTY
    // (its own line, not mentioned in prose) or the field to be named on its own.
    const spreadCarries = /^\s*\.\.\.args,\s*$/m.test(call)
    const namedExplicitly = call.includes('documentIds: args.documentIds')
    expect(spreadCarries || namedExplicitly).toBe(true)
  })

  test('BOTH loops DECLARE the field, so the argument is not silently discarded', () => {
    /*
     * COUNTED, NOT MATCHED. A `toMatch(/documentIds\?:/)` passed while the NON-STREAMING declaration was
     * deleted, because the streaming one still satisfied it — the guard could not fail for the defect it
     * covered. The same weakness let a deleted internal forward pass. So both quantities are pinned: a
     * missing declaration or a missing forward changes the count.
     */
    const agentic = stripComments(readFileSync(join(import.meta.dir, 'tool-router-agentic.ts'), 'utf-8'))

    /*
     * MEASURED counts, not guessed ones: an earlier version of this guard asserted `toBe(2)` and failed
     * against CORRECT code, because each loop declares the field TWICE — once on its own args object and
     * once on the inline callback parameter type it invokes.
     */
    const declarations = agentic.match(/documentIds\?: string\[\] \| null/g) ?? []
    const callbackDecls = agentic.match(/systemPromptPrefix\?: string; documentIds\?: string\[\] \| null/g) ?? []
    // One forward per internal call site: two for runCompletion, two for runStreaming.
    const forwards = agentic.match(/documentIds: args\.documentIds/g) ?? []

    // Counts are MEASURED, never guessed: an earlier version of this guard asserted numbers from before the
    // multi-step DAG was scoped and failed against correct code.
    expect(declarations.length).toBe(5) // 2 agentic loops x args + callback, plus runMultiStepDag's own args
    expect(callbackDecls.length).toBe(2) // both inline callback types
    expect(forwards.length).toBe(5) // 4 internal re-entries + runMultiStepDag -> executePlan
  })
})

describe('the MULTI-STEP DAG also carries the document scope', () => {
  /**
   * THE THIRD UNSCOPED ENTRY, found by adversarial review of this branch after the first two were fixed.
   *
   * `runMultiStepDag` builds its own plan and calls `runNonStreamingChatCompletion` per step, so it needed the
   * scope as its own argument — the chat route sets `allowMultiStepDag: true`, which reaches this whenever the
   * selector reports multiple tools or fails to choose.
   *
   * Counted rather than matched, for the same reason as the block above: a `toContain` is satisfied by a
   * comment naming the field, and the fix's own comments DO name it.
   */
  test('runMultiStepDag declares documentIds and forwards it into executePlan', () => {
    const agentic = stripComments(readFileSync(join(import.meta.dir, 'tool-router-agentic.ts'), 'utf-8'))
    const dag = agentic.slice(agentic.indexOf('export async function runMultiStepDag'))
    // Take a generous window rather than cutting at the first `\n}` — the function's first closing brace is at
    // depth 1, so slicing there excluded the `executePlan` call the assertion is about. That is why this test
    // failed against code that was already correct.
    const body = dag.slice(0, 3000)
    expect(body).toMatch(/documentIds\?: string\[\] \| null/)
    expect(body).toMatch(/documentIds: args\.documentIds/)
  })

  test('executePlan and executeStep both carry it, and selfCorrect does too', () => {
    /*
     * The chain is four hops, and every one has to hold: executePlan -> executeStep -> the router call, plus
     * the self-correction retry. A break ANYWHERE restores the fail-open behaviour, and the retry is the
     * subtlest — a correction that escaped the scope would be a route to other documents, reached by failing
     * first.
     */
    const planner = stripComments(readFileSync(join(import.meta.dir, 'planner.ts'), 'utf-8'))
    const planFn = planner.slice(planner.indexOf('export async function executePlan'))
    const planBody = planFn.slice(0, planFn.indexOf('\n}'))
    expect(planBody).toMatch(/documentIds\?: string\[\] \| null/)

    const stepFn = planner.slice(planner.indexOf('async function executeStep'))
    expect(stepFn.slice(0, 400)).toMatch(/documentIds\?: string\[\] \| null/)

    const selfFn = planner.slice(planner.indexOf('async function selfCorrect'))
    expect(selfFn.slice(0, 500)).toMatch(/documentIds\?: string\[\] \| null/)

    // Both router calls must pass it — the step call AND the corrected retry.
    /*
     * ASSERTED BY LOCATION, not by a total.
     *
     * A bare count of 3 SURVIVED the negative control that deleted the `selfCorrect` forward: the other two
     * call sites still supplied the count, so the guard could not fail for the hop it was written for. Each
     * hop is now named, which is the only form that fails when that SPECIFIC link is removed.
     */
    const selfCall = planner.slice(planner.indexOf('const corrected = await selfCorrect({'))
    expect(selfCall.slice(0, 400)).toMatch(/documentIds: args\.documentIds/)

    // executeStep's router call: the block between its own `runNonStreamingChatCompletion(` and the
    // `hasFailedTool` check that follows it.
    const stepAt = planner.indexOf('const completion = await runNonStreamingChatCompletion({\n      question,')
    expect(stepAt).toBeGreaterThan(-1)
    expect(planner.slice(stepAt, stepAt + 220)).toMatch(/documentIds: args\.documentIds/)

    // selfCorrect's router call.
    const fixAt = planner.indexOf('question: fixedQuestion.trim(),')
    expect(fixAt).toBeGreaterThan(-1)
    expect(planner.slice(fixAt, fixAt + 160)).toMatch(/documentIds: args\.documentIds/)
  })
})

describe('the TOOL EXECUTORS carry the document scope — the last unscoped entry', () => {
  /**
   * Found by adversarial review after four other entries were closed. `SQL_TOOL`, `RAG_TOOL` and `REST_TOOL`
   * each call `runNonStreamingChatCompletion` themselves, and none passed a scope — so on `/api/v1/agent/run` a
   * key whose `allowedDocumentIds` named one document still retrieved across the whole org. The orchestration
   * around the tools was scoped; the executors were not.
   *
   * TWO SEPARATE GUARANTEES, and this file guards both because they fail independently:
   *   - `allowedTools` filters which families are OFFERED (a filter on the list),
   *   - `documentIds` filters what a permitted tool may READ (a filter on the query).
   * A family can be allowed AND scoped, so scoping the list does not scope the tool.
   */
  const unified = stripComments(readFileSync(join(import.meta.dir, 'unified-tools.ts'), 'utf-8'))
  const orch = stripComments(readFileSync(join(import.meta.dir, 'agent-orchestrator.ts'), 'utf-8'))
  const route = stripComments(
    readFileSync(join(import.meta.dir, '..', 'app', 'api', 'v1', 'agent', 'run', 'route.ts'), 'utf-8'),
  )

  test('the context carries the scope and all THREE router calls consume it', () => {
    const ctx = unified.slice(unified.indexOf('export interface ToolExecutionContext'))
    expect(ctx.slice(0, 900)).toMatch(/documentIds\?: string\[\] \| null/)
    // Counted because the three executors are near-identical: a per-site assertion would be three copies of the
    // same line, and a count fails loudly if one is dropped while the others stay.
    const uses = unified.match(/documentIds: context\.documentIds/g) ?? []
    expect(uses.length).toBe(3)
  })

  test('the orchestrator builds the context WITH the scope, not without it', () => {
    // The context being able to carry it is useless if the constructor omits it — the same "declared but not
    // forwarded" shape as the agentic loop that started this whole review.
    const at = orch.indexOf('const toolExecutionContext: ToolExecutionContext = {')
    expect(at).toBeGreaterThan(-1)
    expect(orch.slice(at, at + 600)).toMatch(/documentIds: options\.documentIds/)
    expect(orch).toMatch(/documentIds\?: string\[\] \| null/)
  })

  test('the route sets BOTH axes from the resolved scope', () => {
    const at = route.indexOf('runAgentOrchestrator({')
    expect(at).toBeGreaterThan(-1)
    const call = route.slice(at, at + 1200)
    expect(call).toMatch(/allowedTools: resolveScope\(identity\.scope\)\.tools/)
    expect(call).toMatch(/documentIds: resolveScope\(identity\.scope\)\.documentIds/)
  })
})
