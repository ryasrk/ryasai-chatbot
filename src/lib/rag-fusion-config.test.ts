/**
 * Tests for the RRF `k` seam (`rag-fusion-config.ts`).
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * ----------------------------------------------------------------------------
 * The default must not drift, because an installation that sets nothing has to
 * behave exactly as it did before this existed — that is the whole safety argument
 * for shipping a flag instead of a changed constant. And the request override must
 * stay unreachable on a deployment that did not opt in: without that gate any
 * client could choose the ranking configuration, which turns a measurement seam
 * into a client-controlled retrieval setting.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { RRF_K } from './rag-ranking'
import {
  DEFAULT_FUSION_K,
  MAX_FUSION_K,
  MIN_FUSION_K,
  enterWithFusionK,
  envFusionK,
  fusionCacheTag,
  fusionOverrideAllowed,
  parseFusionK,
  resetFusionConfig,
  resolveFusionConfig,
  resolveFusionK,
  withFusionK,
} from './rag-fusion-config'

const ORIGINAL = process.env.RAG_FUSION_K

beforeEach(() => {
  delete process.env.RAG_FUSION_K
  resetFusionConfig()
})

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.RAG_FUSION_K
  else process.env.RAG_FUSION_K = ORIGINAL
  resetFusionConfig()
})

describe('parseFusionK', () => {
  test('accepts integers inside the bounds', () => {
    expect(parseFusionK(1)).toBe(1)
    expect(parseFusionK('10')).toBe(10)
    expect(parseFusionK(' 60 ')).toBe(60)
    expect(parseFusionK(MIN_FUSION_K)).toBe(MIN_FUSION_K)
    expect(parseFusionK(MAX_FUSION_K)).toBe(MAX_FUSION_K)
  })

  test('rejects zero and negatives — k=0 would make the score exactly 1/rank', () => {
    expect(parseFusionK(0)).toBeNull()
    expect(parseFusionK('-1')).toBeNull()
    expect(parseFusionK(-60)).toBeNull()
  })

  test('rejects non-integers rather than truncating them', () => {
    // parseInt('12abc') is 12 and parseInt('1.9') is 1 — silent truncation of a
    // typo into a valid-looking constant is worse than a rejection.
    expect(parseFusionK('1.9')).toBeNull()
    expect(parseFusionK('12abc')).toBeNull()
    expect(parseFusionK('abc')).toBeNull()
    expect(parseFusionK('')).toBeNull()
    expect(parseFusionK(null)).toBeNull()
    expect(parseFusionK(undefined)).toBeNull()
  })

  test('rejects NaN and Infinity', () => {
    expect(parseFusionK('NaN')).toBeNull()
    expect(parseFusionK('Infinity')).toBeNull()
    expect(parseFusionK(Number.NaN)).toBeNull()
    expect(parseFusionK(Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('rejects values above the upper rail', () => {
    expect(parseFusionK(MAX_FUSION_K + 1)).toBeNull()
  })
})

describe('the local default matches the fusion module', () => {
  test('DEFAULT_FUSION_K equals RRF_K — the drift guard', () => {
    // The constant is duplicated on purpose (see the note in rag-fusion-config.ts:
    // importing it couples this module to the one it configures, and breaks every
    // test that mocks `rag-ranking`). Duplication is only safe with an assertion
    // that fails when the two diverge, which is this one.
    expect(DEFAULT_FUSION_K).toBe(RRF_K)
  })
})

describe('default behaviour — nothing set', () => {
  test('resolves to RRF_K, the documented default', () => {
    const config = resolveFusionConfig()
    expect(config.k).toBe(RRF_K)
    expect(config.source).toBe('default')
    expect(resolveFusionK()).toBe(RRF_K)
  })

  test('the override is NOT allowed', () => {
    expect(fusionOverrideAllowed()).toBe(false)
    expect(enterWithFusionK('1')).toBe(false)
    // The decisive assertion: a header cannot change the effective value.
    expect(resolveFusionK()).toBe(RRF_K)
    expect(resolveFusionConfig().source).toBe('default')
  })
})

describe('RAG_FUSION_K set', () => {
  test('resolves to the env value and reports its source', () => {
    process.env.RAG_FUSION_K = '10'
    expect(envFusionK()).toBe(10)
    expect(resolveFusionConfig()).toEqual({ k: 10, source: 'env' })
  })

  test('allows the request override, and the request wins over the env', async () => {
    process.env.RAG_FUSION_K = '10'
    expect(fusionOverrideAllowed()).toBe(true)
    await withFusionK(3, async () => {
      expect(resolveFusionConfig()).toEqual({ k: 3, source: 'request' })
    })
  })

  test('an invalid env value is ignored AND leaves the override disabled', () => {
    // The typo must not (a) change ranking or (b) become a way to enable the seam.
    process.env.RAG_FUSION_K = '0'
    expect(envFusionK()).toBeNull()
    expect(resolveFusionK()).toBe(RRF_K)
    expect(fusionOverrideAllowed()).toBe(false)
    expect(enterWithFusionK('1')).toBe(false)
    expect(resolveFusionK()).toBe(RRF_K)
  })

  test('an invalid request value falls back to the env value, not to the default', async () => {
    process.env.RAG_FUSION_K = '20'
    expect(enterWithFusionK('nonsense')).toBe(false)
    expect(resolveFusionK()).toBe(20)
  })

  test('a request value outside the bounds is rejected', () => {
    process.env.RAG_FUSION_K = '20'
    expect(enterWithFusionK('0')).toBe(false)
    expect(enterWithFusionK(String(MAX_FUSION_K + 1))).toBe(false)
    expect(resolveFusionK()).toBe(20)
  })
})

describe('fusionCacheTag', () => {
  test('differs for different k, so two configs cannot share a cache entry', () => {
    expect(fusionCacheTag(60)).not.toBe(fusionCacheTag(1))
    expect(fusionCacheTag(60)).not.toBe(fusionCacheTag(10))
  })

  test('is stable for the same k, so equal configs DO share an entry', () => {
    expect(fusionCacheTag(10)).toBe(fusionCacheTag(10))
  })

  test('cannot collide with the numeric segments around it in the key', () => {
    // The key is rag:<org>:<tag>:<topK>:<query>. A bare number here would make
    // k=1,topK=60 and k=60,topK=1 produce the same string.
    const a = `rag:org:${fusionCacheTag(1)}:60:q`
    const b = `rag:org:${fusionCacheTag(60)}:1:q`
    expect(a).not.toBe(b)
  })
})

describe('request scope does not leak between calls', () => {
  test('a value entered inside withFusionK does not persist afterwards', async () => {
    process.env.RAG_FUSION_K = '10'
    await withFusionK(2, async () => {
      expect(resolveFusionK()).toBe(2)
    })
    // AsyncLocalStorage.run restores the previous store, so the outer scope is the
    // env value again. A leaked store would silently pin every later request.
    expect(resolveFusionK()).toBe(10)
  })
})

describe('the env schema and the code agree on the accepted range', () => {
  // The ALIGNMENT_CHECK incident: the schema accepted one set of values while the
  // call sites compared against another, so setting the DOCUMENTED value silently
  // disabled the guardrail. The defense is a test that reads the schema's own
  // declaration and compares it to the constants the code enforces — not two lists
  // that merely happen to match today.
  const schemaSrc = readFileSync(new URL('./env-schema.ts', import.meta.url), 'utf8')

  test('RAG_FUSION_K is declared in the env schema at all', () => {
    // Without a declaration it is unvalidated (and, in production, a typo is
    // silently accepted because only the schema's parse rejects anything).
    expect(schemaSrc).toContain('RAG_FUSION_K')
  })

  test('the schema bounds are the same identifiers the code enforces', () => {
    // Target the DECLARATION, not the first mention: taking `indexOf` found the
    // import comment instead, so the assertions below read a snippet that contained
    // none of the bounds and passed for the wrong reason.
    const match = /RAG_FUSION_K:\s*z[\s\S]{0,240}?\.optional\(\)/.exec(schemaSrc)
    expect(match).not.toBeNull()
    const snippet = match![0]
    expect(snippet).toContain('MIN_FUSION_K')
    expect(snippet).toContain('MAX_FUSION_K')
    // An integer, not a float and not a coerced string: `z.string()` would accept
    // '1.5' and let a fractional k reach 1/(k+rank).
    expect(snippet).toContain('.int()')
  })

  test('the code bounds are a sane, non-empty interval', () => {
    expect(MIN_FUSION_K).toBeGreaterThanOrEqual(1)
    expect(MAX_FUSION_K).toBeGreaterThan(MIN_FUSION_K)
  })
})
