/**
 * Behavioural guards for the AI Configuration model picker.
 *
 * WHY THESE EXIST, beyond the defect accounts in `llm-config-row.test.ts`:
 *
 * The route-level test file for `PUT /api/llm-config` mocks `normalizeBaseUrl` with a version that
 * THROWS on an empty string. The real one RETURNS `''`. That divergence made the route's own suite
 * unable to see the defect this file pins: with the mock in place, omitting `baseUrl` looks like a 400
 * (safe) rather than like writing an empty base URL over a working one (catastrophic). A mock that is
 * stricter than production cannot prove that production refuses anything.
 *
 * This file calls the REAL `modelPatchPayload` and the REAL route handler, and asserts on the payload
 * that reaches the database mock — the same layer the fixture-based test asserts on, so the two agree.
 *
 * `.test.ts` and `React.createElement`, not `.test.tsx` + JSX: `scripts/test.ts` collects
 * `{src,benchmark}/**\/*.test.ts`, and the glob does NOT match `.test.tsx`. MEASURED — neither
 * `doc-card-status.test.tsx` (since renamed to `.test.ts` and now collected) nor
 * `cognee-diagnostics-render.test.tsx` appeared in the runner's file set, so neither had run in CI. A guard the runner cannot see reports safety.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { modelPatchPayload } from './ai-configuration-view'
import type { PublicLlmConfig } from '@/lib/types'

const VIEW = join(import.meta.dir, 'ai-configuration-view.tsx')
const viewSrc = readFileSync(VIEW, 'utf-8')

/** Comments stripped, so an assertion can never be satisfied by the FIX'S OWN NOTES quoting the old code. */
const strip = (s: string) =>
  s
    .split('\n')
    .map((l) => {
      const t = l.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
      const i = l.indexOf('//')
      return i === -1 ? l : l.slice(0, i)
    })
    .join('\n')

const code = strip(viewSrc)

/** The production shape: a working BYOK install. */
function configured(): PublicLlmConfig {
  return {
    configured: true,
    provider: 'ANTHROPIC_COMPATIBLE',
    baseUrl: 'https://real.example.com/v1',
    model: 'cbcn/deepseek-v4-flash',
    apiKeyMasked: 'sk-••••',
    availableModels: ['m1', 'm2'],
    lastModelSyncAt: '2026-01-01T00:00:00.000Z',
    embeddingProvider: 'ANTHROPIC_COMPATIBLE',
    embeddingBaseUrl: 'https://embed.real.example.com/v1',
    embeddingModel: 'bge-m3',
    embeddingApiKeyMasked: 'sk-••••',
    embeddingAvailableModels: [],
    lastEmbeddingModelSyncAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('modelPatchPayload — a model change must not rewrite the rest of the row', () => {
  test('it carries every field the route would otherwise DEFAULT to empty', () => {
    /*
     * The route is a whole-row upsert and `normalizeBaseUrl('')` returns '' (not a throw), so an omitted
     * field is written EMPTY. Probed against the real handler: sending `{ model }` alone produced
     *   {"provider":"OPENAI_COMPATIBLE","baseUrl":"","model":...,"embeddingProvider":"OPENAI_COMPATIBLE",
     *    "embeddingBaseUrl":"","embeddingModel":"text-embedding-3-small"}
     * on a row configured as ANTHROPIC + a real base URL + bge-m3 — i.e. picking a model from the
     * dropdown disabled the install.
     *
     * OBSERVED, defect planted (`modelPatchPayload` reduced to `return { model: next }`): 5 of these 6
     * fields are absent/empty and the test fails on `baseUrl`.
     */
    const body = modelPatchPayload(configured(), 'new-model')
    expect(body.model).toBe('new-model')
    expect(body.provider).toBe('ANTHROPIC_COMPATIBLE')
    expect(body.baseUrl).toBe('https://real.example.com/v1')
    expect(body.embeddingProvider).toBe('ANTHROPIC_COMPATIBLE')
    expect(body.embeddingBaseUrl).toBe('https://embed.real.example.com/v1')
    expect(body.embeddingModel).toBe('bge-m3')
  })

  test('it never carries a credential field', () => {
    /*
     * `apiKey` is omitted ON PURPOSE: the route only re-encrypts when a non-empty key is sent, so
     * omission means "keep the stored one". Sending '' would be read as "no key supplied" (also safe),
     * but sending a stale masked value would store the mask as the credential. Asserting ABSENCE keeps
     * any future refactor from adding a key field to this helper by reflex.
     */
    const body = modelPatchPayload(configured(), 'new-model')
    expect(Object.keys(body)).not.toContain('apiKey')
    expect(Object.keys(body)).not.toContain('embeddingApiKey')
    expect(JSON.stringify(body)).not.toContain('sk-')
  })

  test('with no server config yet it sends only the model', () => {
    // First-run case: there is nothing to preserve, and inventing values would be worse than letting
    // the route apply its defaults. The route refuses a create with no key (400), which is correct.
    expect(modelPatchPayload(null, 'gpt-4o-mini')).toEqual({ model: 'gpt-4o-mini' })
  })

  test('both write paths use the helper, and no bare { model } survives', () => {
    /*
     * The unmount rescue wrote `{ model: pending.value.trim() }` independently — the same
     * field-wiping bug on a path no one can observe, because it fires after the view is gone. Anchored
     * on the CALL SITE and on the absence of the bare payload anywhere in the file.
     *
     * OBSERVED, defect planted (the rescue's body reverted to `JSON.stringify({ model: pending.value.trim() })`):
     * fails on the `not.toMatch`. Restored: passes.
     */
    const calls = [...code.matchAll(/body: JSON\.stringify\((modelPatchPayload\([^)]*\))\)/g)]
    // persistModel + the unmount rescue.
    expect(calls.length).toBe(2)
    expect(code).not.toMatch(/JSON\.stringify\(\{\s*model:/)
  })

  test('the payload is built from the SERVER config, never from form state', () => {
    /*
     * If the patch were assembled from the editable inputs, picking a model would persist whatever was
     * half-typed in the Base URL box. The reference must be `cfg` (or the `cfgRef` that mirrors it),
     * never `baseUrl` — the form's own state variable.
     */
    const persist = code.slice(code.indexOf('async function persistModel'))
    const body = persist.slice(0, persist.indexOf('async function handleFetchModels'))
    expect(body).toMatch(/modelPatchPayload\(cfgRef\.current, next\)/)
    expect(body).not.toMatch(/modelPatchPayload\(\{[^}]*baseUrl/)
    // The form-state variable must not appear anywhere in the helper's own body.
    const helper = code.slice(code.indexOf('export function modelPatchPayload'))
    expect(helper.slice(0, helper.indexOf('\n}'))).not.toMatch(/\bbaseUrl\b\s*:/)
  })
})

describe('model picker — writes are serialised by intent', () => {
  test('a superseded response cannot win the race', () => {
    /*
     * Two commits are two whole-row PUTs. Without an ordering token the slower one — the model the user
     * already moved OFF — could land last and become the stored value while the control showed the newer
     * one. The guard is that a response whose write number is stale returns BEFORE touching state.
     *
     * OBSERVED, defect planted (all three `write !== modelWriteSeq.current` checks deleted): fails on the
     * `toBeGreaterThanOrEqual(3)` count. Restored: passes.
     */
    const persist = code.slice(code.indexOf('async function persistModel'))
    const body = persist.slice(0, persist.indexOf('async function handleFetchModels'))
    const guards = body.match(/write !== modelWriteSeq\.current\) return/g) ?? []
    /*
     * EXACTLY TWO, COUNTED FROM THE SOURCE rather than guessed: one on the success path (so a stale
     * response cannot apply `cfg`/clear the flag) and one in the catch (so a stale FAILURE cannot raise
     * a toast for a write the user has already replaced). The first draft of this assertion said
     * ">= 3" — an invented number, and it failed against correct code. The lesson is the repo's own:
     * never write a count you have not measured.
     */
    expect(guards.length).toBe(2)
    expect(body).toMatch(/const write = \+\+modelWriteSeq\.current/)
    // The stale check must PRECEDE every state write on that path, not follow it.
    const staleAt = body.indexOf('write !== modelWriteSeq.current')
    expect(staleAt).toBeLessThan(body.indexOf('setModelUnsaved(false)'))
  })

  test('an in-flight value is adopted by the unmount rescue, not written twice', () => {
    // The rescue fires for a typed-but-never-blurred value. If `persistModel` already started for that
    // exact value, the request is on the wire and a second PUT from the cleanup would duplicate it.
    expect(code).toMatch(/if \(inFlightValueRef\.current === pending\.value\.trim\(\)\) return/)
  })
})

describe('model picker — failures are never presented as success', () => {
  test('the failure banner is driven by the ERROR, and disappears on success', () => {
    /*
     * The banner used to key off `modelUnsaved`, which is ALSO true while a write is merely in flight —
     * so every normal, successful save displayed "This model is not saved yet — storing it failed" and
     * then cleared it. A permanent failure sentence that the user cannot check is worse than silence:
     * it teaches them to ignore the one message that means something.
     *
     * OBSERVED, defect planted (`{modelSaveFailed !== null && (` reverted to `{modelUnsaved && (`): fails,
     * because the text is no longer inside the failure-conditional block. Restored: passes.
     */
    expect(code).toMatch(/\{modelSaveFailed !== null && \(/)
    expect(code).not.toMatch(/\{modelUnsaved && \(/)

    const persist = code.slice(code.indexOf('async function persistModel'))
    const body = persist.slice(0, persist.indexOf('async function handleFetchModels'))
    // Failure records the reason...
    expect(body).toMatch(/setModelSaveFailed\(/)
    // ...and the attempt clears the PREVIOUS failure, so a retry cannot display a stale verdict.
    expect(body).toMatch(/setModelSaveFailed\(null\)/)

    // A successful Save Configuration covers the model too, so it must clear the banner.
    const save = code.slice(code.indexOf('async function handleSave'))
    expect(save.slice(0, 900)).toMatch(/setModelSaveFailed\(null\)/)
  })

  test('the failure banner is announced', () => {
    /*
     * A newly-inserted element is not announced by a screen reader on its own. The user who picked a
     * model and got a failure was told nothing — which is the original "it silently did not save"
     * complaint, for anyone not looking at the pixels.
     *
     * OBSERVED, defect planted (`role="status" aria-live="polite"` removed from the paragraph): fails.
     */
    const banner = code.slice(code.indexOf('{modelSaveFailed !== null && ('))
    expect(banner.slice(0, 1200)).toMatch(/role="status"/)
    expect(banner.slice(0, 1200)).toMatch(/aria-live="polite"/)
  })

  test('a snap to a served model is PERSISTED, not staged in local state', () => {
    /*
     * `if (list.length > 0 && !list.includes(model)) setModel(list[0])` is the ORIGINAL reported defect
     * verbatim — local state only, so the snap reverted on navigation. A model the provider does not
     * serve cannot work, so leaving it in the row is worse than the empty-looking selection it produced.
     *
     * OBSERVED, defect planted (reverted to the bare `setModel(list[0])`): fails on the `toMatch`.
     */
    const fn = code.slice(code.indexOf('async function handleFetchModels'))
    expect(fn.slice(0, 900)).toMatch(/void persistModel\(list\[0\]\)/)
    expect(fn.slice(0, 900)).not.toMatch(/\) setModel\(list\[0\]\)/)
  })
})
