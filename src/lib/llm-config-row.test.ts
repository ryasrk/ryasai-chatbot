import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * ONE row resolver for the chat config, used by every path that reads or writes it.
 *
 * INCIDENT (user-reported): "setelah model dipilih lalu user pindah menu dan kembali. Model pilihan
 * kosong."
 *
 * MEASURED on the install: TWO `LlmConfig` rows existed —
 *
 *   purpose: 'chat'  → model `cbcn/deepseek-v4-flash`, `availableModels` EMPTY, never synced
 *   purpose: 'agent' → model `cbcn/deepseek-v4.1-flash`, `availableModels` = 37 entries, synced
 *
 * `getPublicLlmConfig()` (what the AI Configuration screen READS) used a bare `findFirst()`, while
 * `PUT` (what that screen WRITES) used `findFirst({ purpose: 'chat' })`. Postgres has no implicit
 * ORDER BY for an unfiltered `findFirst`, so which row the screen read was the planner's decision, not
 * the code's — and the read and write could land on different rows.
 *
 * The empty `availableModels` is the visible half: with no list, the screen renders a free-text Input
 * instead of a dropdown, so the "picked model" the user saw was text that had never been persisted.
 */
const libSrc = readFileSync(join(import.meta.dir, 'llm-config.ts'), 'utf-8')
const putSrc = readFileSync(join(import.meta.dir, '..', 'app', 'api', 'llm-config', 'route.ts'), 'utf-8')
const modelsSrc = readFileSync(join(import.meta.dir, '..', 'app', 'api', 'llm-config', 'models', 'route.ts'), 'utf-8')

/** Comments stripped — the fix's notes quote the OLD unfiltered call. */
const strip = (s: string) =>
  s
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') ? '' : l
    })
    .join('\n')


/**
 * The AI Configuration view, stripped, at MODULE SCOPE.
 *
 * WHY MODULE SCOPE: a `describe`-local declaration is invisible to a LATER `describe`, so the
 * unmount-safety block below threw `ReferenceError: viewSrc is not defined` at COLLECTION time and
 * every test in it failed — a test-configuration mistake that reads exactly like a code defect.
 * The same trap caught a `root` constant in a sibling file.
 */
const VIEW_SRC = strip(
  readFileSync(join(import.meta.dir, '..', 'components', 'views', 'ai-configuration-view.tsx'), 'utf-8'),
)

describe('llm config — the chat row is resolved in exactly one place', () => {
  test('the resolver filters on purpose, with a documented fallback', () => {
    const src = strip(libSrc)
    expect(src).toMatch(/export async function resolveChatConfigRow/)
    expect(src).toMatch(/findFirst\(\{ where: \{ purpose: 'chat' \} \}\)/)
  })

  test('getPublicLlmConfig uses the resolver, not a bare findFirst', () => {
    const src = strip(libSrc)
    const fn = src.slice(src.indexOf('export async function getPublicLlmConfig'))
    const body = fn.slice(0, fn.indexOf('const row = await resolveChatConfigRow()'))
    // The bare call must not appear in this function at all.
    expect(body).not.toMatch(/db\.llmConfig\.findFirst\(\)/)
    expect(fn).toMatch(/const row = await resolveChatConfigRow\(\)/)
  })

  test('the writer and the model-sync route use the SAME resolver', () => {
    // Read and write disagreeing is the defect; both must go through one function.
    expect(strip(putSrc)).toMatch(/resolveChatConfigRow\(\)/)
    expect(strip(modelsSrc)).toMatch(/resolveChatConfigRow\(\)/)
  })

  test('neither route resolves the row itself any more', () => {
    expect(strip(putSrc)).not.toMatch(/db\.llmConfig\.findFirst\(\{ where: \{ purpose: 'chat' \} \}\)/)
    expect(strip(modelsSrc)).not.toMatch(/const existing = await db\.llmConfig\.findFirst\(\)/)
  })
})

describe('model picker — a choice must survive navigation', () => {
  /**
   * The reported bug, second half. Even with the right row, the picker wrote only to LOCAL state:
   * `onValueChange={setModel}` staged the value and nothing sent it. Navigating away unmounted the view,
   * and the selection was never in the database to come back to — with no indication it was unsaved.
   *
   * The picker now persists immediately, and the failure path (a rejected write) keeps the value in the
   * control AND flags it, so a control never displays a value the server does not have.
   */
  const viewSrc = VIEW_SRC

  test('the dropdown commits the choice instead of staging it', () => {
    expect(viewSrc).toMatch(/onValueChange=\{\(v\) => void persistModel\(v\)\}/)
    // The old bare setter is what staged the value forever.
    expect(viewSrc).not.toMatch(/onValueChange=\{setModel\}/)
  })

  test('a saved model sends the CONFIG, never a bare { model } that would wipe baseUrl', () => {
    /*
     * REVERSED, and the reason matters. The first version of this test demanded the payload be EXACTLY
     * `{ model: next }`, on the theory that sending more could overwrite a concurrent edit. That theory
     * was wrong about this route: `PUT` resolves `baseUrl` as `normalizeBaseUrl(body.baseUrl ?? '')`, so
     * an OMITTED field is written as an EMPTY STRING.
     *
     * Measured consequence: picking a model deleted the Base URL, the embedding endpoint and the model
     * names on a working BYOK install — reducing it to an unreachable one — and the response was applied
     * to `cfg` only, so the form kept SHOWING the old URL while the database held an empty one.
     *
     * The payload therefore carries the provider, the base URL and the embedding trio, read from the
     * SERVER's last known config (`cfg`) rather than from the form inputs — so a half-typed Base URL in a
     * field cannot be smuggled into storage by a model pick. The two key fields stay OUT: omitted means
     * "keep the stored key", so a model pick can never rotate or clear a credential.
     */
    const fn = viewSrc.slice(viewSrc.indexOf('async function persistModel'))
    const body = fn.slice(0, fn.indexOf('async function handleFetchModels'))
    expect(body).toMatch(/body: JSON\.stringify\(modelPatchPayload\(/)
    // The key fields must NOT be in the patch helper's output.
    const helper = viewSrc.slice(viewSrc.indexOf('export function modelPatchPayload'))
    const helperBody = helper.slice(0, helper.indexOf('\n}'))
    expect(helperBody).not.toMatch(/apiKey/)
    expect(helperBody).not.toMatch(/encrypted/)
  })

  test('a FAILED write is surfaced and the value is not presented as saved', () => {
    const fn = viewSrc.slice(viewSrc.indexOf('async function persistModel'))
    const body = fn.slice(0, fn.indexOf('async function handleFetchModels'))
    // On failure the unsaved flag must remain set: clearing it would claim success.
    expect(body).toMatch(/setModelUnsaved\(true\)/)
    expect(body).toMatch(/setModelUnsaved\(false\)/)
    // And the user is told.
    expect(viewSrc).toMatch(/not saved yet/)
  })

  test('the free-text fallback commits on blur, not per keystroke', () => {
    // A PUT per character would persist half-typed names, which the runtime would then try to call.
    // Search from the LAST occurrence: the id appears first on SelectTrigger (the dropdown branch),
    // and a slice from there never reaches the Input. My first version measured the wrong branch and
    // failed against correct code.
    const at = viewSrc.lastIndexOf('id="llm-model"')
    expect(at).toBeGreaterThan(-1)
    const input = viewSrc.slice(at, at + 900)
    expect(input).toMatch(/onBlur=/)
    expect(input).toMatch(/void persistModel\(next\)/)
  })
})


describe('model picker — an unmount mid-edit must not lose the value', () => {
  /**
   * The free-text path had a hole the immediate save does not cover: a user can type a model and switch
   * menus WITHOUT blurring the field, so `onBlur` never fired and the value died with the component —
   * the same reported symptom through the other input.
   *
   * The view records what is owed in a REF and writes it from the unmount cleanup. A ref rather than
   * state, because the cleanup closure would otherwise read a stale value. A fetch started during a
   * CLIENT-SIDE route change still completes; this is not a page unload, so no beacon is needed.
   */
  test('a pending value is written from the unmount cleanup', () => {
    /*
     * ANCHORED ON THE RESCUE WRITE, NOT ON THE REF.
     *
     * The first version sliced 900 characters from the first `pendingModelRef` and asserted the slice
     * contained the words "owed" and "/api/llm-config". DELETING THE ENTIRE CLEANUP LEFT IT PASSING:
     * "owed" appears in the ref's own declaration, and the endpoint appears elsewhere in the window. The
     * guard could not fail for the defect it was written for — the third time this session that a
     * text-proximity assertion proved vacuous, which is why this one anchors on the CALL.
     */
    const rescue = VIEW_SRC.slice(VIEW_SRC.indexOf("void fetch('/api/llm-config'"))
    expect(rescue.length).toBeGreaterThan(0)
    const call = rescue.slice(0, 400)
    // It must send the PENDING value, not a value read from a closure that has already gone stale.
    expect(call).toContain('pending.value.trim()')
    expect(call).toContain("method: 'PUT'")
  })

  test('the debt is cleared only on a SUCCESSFUL write', () => {
    const fn = VIEW_SRC.slice(VIEW_SRC.indexOf('async function persistModel'))
    const body = fn.slice(0, fn.indexOf('async function handleFetchModels'))
    const cleared = body.indexOf('owed: false')
    const marked = body.indexOf('owed: true')
    expect(marked).toBeGreaterThan(-1)
    expect(cleared).toBeGreaterThan(marked)
    // The clear must sit after the success check, never before it.
    expect(body.indexOf('setModelUnsaved(false)')).toBeGreaterThan(-1)
  })

  test('typing marks the value as owed, so an unblurred edit is still rescued', () => {
    const at = VIEW_SRC.lastIndexOf('id="llm-model"')
    const input = VIEW_SRC.slice(at, at + 900)
    expect(input).toMatch(/onChange=/)
    expect(input).toContain('owed: true')
  })
})
