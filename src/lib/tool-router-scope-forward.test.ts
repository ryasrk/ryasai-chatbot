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

    expect(declarations.length).toBe(4) // 2 loops x (args object + callback type)
    expect(callbackDecls.length).toBe(2) // both callback types
    expect(forwards.length).toBe(4) // every internal re-entry
  })
})
