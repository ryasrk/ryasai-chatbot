import { describe, expect, it, mock, beforeEach } from 'bun:test'
import { DEFAULT_SQL_RULES_PROMPT, defaultSqlRulesPrompt, resolveSqlRulesPrompt } from './prompt-settings'

/**
 * `getPromptSettings` had SEVEN production consumers (prompt-tools/route, tool-branches,
 * tool-router, admin-tools x3) and the entity function itself was NEVER EXECUTED: this file only
 * tested the two pure helpers, and all six consumer tests MOCKED it. A module that every caller
 * stubs is a module nobody has run, which is exactly how a broken DB read survives a green suite.
 *
 * The db is injected as a PARAMETER, so the test passes a stub directly -- no module mocking, and
 * no chance of the mock drifting from the real extension client the callers hand in.
 */
const appConfigFindFirst = mock(async () => null as { promptSettings?: string | null } | null)
const stubDb = { appConfig: { findFirst: appConfigFindFirst } } as unknown as typeof import('@/lib/db').db

import { parsePromptSettings, mergePromptSettings, getPromptSettings } from './prompt-settings'

describe('prompt settings', () => {
  it('returns defaults for null/garbage', () => {
    const d = parsePromptSettings(null)
    // `sqlRulesPrompt` defaults to '' — EMPTY MEANS "use DEFAULT_SQL_RULES_PROMPT", resolved at
      // call time by resolveSqlRulesPrompt. Storing the built-in text as the default here would
      // freeze it: every org would carry a copy, and shipping an improved rule would reach nobody.
      expect(d).toEqual({ systemPrompt: '', ragContextPrompt: '', sqlRulesPrompt: '', tools: { rag: true, sql: true, restApi: true } })
    expect(parsePromptSettings('{oops')).toEqual(d)
  })
  it('parses stored json and fills missing keys', () => {
    const s = parsePromptSettings('{"systemPrompt":"Jawab singkat.","tools":{"sql":false}}')
    expect(s.systemPrompt).toBe('Jawab singkat.')
    expect(s.ragContextPrompt).toBe('')
    expect(s.tools).toEqual({ rag: true, sql: false, restApi: true })
  })
  it('parses ragContextPrompt when present', () => {
    const s = parsePromptSettings('{"ragContextPrompt":"Answer only from the cited documents."}')
    expect(s.ragContextPrompt).toBe('Answer only from the cited documents.')
  })
  it('backward-compat: old payload without ragContextPrompt resolves to ""', () => {
    // Existing orgs have stored JSON that predates the key — must not
    // surface as "undefined" inside a RAG prompt.
    const s = parsePromptSettings('{"systemPrompt":"x","tools":{"rag":false}}')
    expect(s.ragContextPrompt).toBe('')
  })
  it('round-trips ragContextPrompt through merge', () => {
    const cur = parsePromptSettings(null)
    const m = mergePromptSettings(cur, { ragContextPrompt: 'Be concise.' })
    expect(m.ragContextPrompt).toBe('Be concise.')
    // Re-parsing the serialized result keeps the value.
    expect(parsePromptSettings(JSON.stringify(m)).ragContextPrompt).toBe('Be concise.')
  })
  it('merges updates over current', () => {
    const cur = parsePromptSettings(null)
    const m = mergePromptSettings(cur, { tools: { rag: false } })
    expect(m.tools).toEqual({ rag: false, sql: true, restApi: true })
    expect(m.systemPrompt).toBe('')
    expect(m.ragContextPrompt).toBe('')
  })
  it('merge ignores non-string ragContextPrompt', () => {
    const cur = parsePromptSettings('{"ragContextPrompt":"keep-me"}')
    const m = mergePromptSettings(cur, { ragContextPrompt: 42 })
    expect(m.ragContextPrompt).toBe('keep-me')
  })
})

describe('getPromptSettings — the stored org prompt is read and parsed', () => {
  beforeEach(() => {
    appConfigFindFirst.mockClear()
    appConfigFindFirst.mockImplementation(async () => null)
  })

  it('returns DEFAULTS when the org has no appConfig row yet', async () => {
    // The first-run path for every new org. Returning undefined here would put the string
    // "undefined" into a system prompt downstream.
    const s = await getPromptSettings(stubDb)
    expect(s).toEqual(parsePromptSettings(null))
    expect(s.systemPrompt).toBe('')
  })

  it('parses the promptSettings JSON from the fetched row', async () => {
    appConfigFindFirst.mockImplementation(async () => ({
      promptSettings: '{"systemPrompt":"Jawab singkat.","tools":{"sql":false}}',
    }))
    const s = await getPromptSettings(stubDb)

    expect(s.systemPrompt).toBe('Jawab singkat.')
    expect(s.tools).toEqual({ rag: true, sql: false, restApi: true })
    expect(s.ragContextPrompt).toBe('')
  })

  it('treats a row with a NULL promptSettings column as no settings', async () => {
    // Distinct from "no row": the column exists but was never written.
    appConfigFindFirst.mockImplementation(async () => ({ promptSettings: null }))
    const s = await getPromptSettings(stubDb)
    expect(s).toEqual(parsePromptSettings(null))
  })

  it('treats a CORRUPT stored value as no settings rather than throwing', async () => {
    // A bad write must not take down every chat turn that reads the prompt.
    appConfigFindFirst.mockImplementation(async () => ({ promptSettings: '{not json' }))
    const s = await getPromptSettings(stubDb)
    expect(s).toEqual(parsePromptSettings(null))
  })

  it('issues exactly ONE query, with no filter (a single row per install)', async () => {
    // The row is fetched unconditionally; adding a filter or a second query is a behaviour change
    // worth seeing, since this runs on every tool resolution.
    await getPromptSettings(stubDb)
    expect(appConfigFindFirst).toHaveBeenCalledTimes(1)
    // The mock infers `() => never[]`, so read the recorded call through a cast via `unknown`.
    const call0 = (appConfigFindFirst.mock.calls as unknown as unknown[][])[0]!
    expect(call0[0]).toBeUndefined()
  })

  it('accepts the TENANT-EXTENDED db, which is what the callers actually pass', async () => {
    // The signature deliberately takes `typeof import('@/lib/db').db` (the $extends client) rather
    // than PrismaClient, so callers do not need a cast. This asserts the call reaches whichever
    // object is handed in rather than a module-level import.
    const otherFindFirst = mock(async () => ({ promptSettings: '{"systemPrompt":"from the other client"}' }))
    const other = { appConfig: { findFirst: otherFindFirst } } as unknown as typeof import('@/lib/db').db

    const s = await getPromptSettings(other)
    expect(s.systemPrompt).toBe('from the other client')
    // The module-level stub was NOT touched.
    expect(appConfigFindFirst).not.toHaveBeenCalled()
  })

  it('a round trip through merge is visible on the next read', async () => {
    // The admin write path is mergePromptSettings -> store; this is the read half of that pair,
    // asserted against the same serialization.
    const cur = await getPromptSettings(stubDb)
    const merged = mergePromptSettings(cur, { ragContextPrompt: 'Cite only.' })
    appConfigFindFirst.mockImplementation(async () => ({ promptSettings: JSON.stringify(merged) }))

    const reread = await getPromptSettings(stubDb)
    expect(reread.ragContextPrompt).toBe('Cite only.')
  })
})

describe('resolveSqlRulesPrompt — the org text wins, whitespace does not', () => {
  /**
   * Both `tool-branches.ts` (non-streaming) and `stream-preparers.ts` (streaming) call this on EVERY
   * SQL request, and it had no direct test — the coverage gate caught that, which is how it was found.
   *
   * The whitespace rule is the one that matters: a field holding a stray newline must NOT replace the
   * built-in rules with nothing. Sending a Text-to-SQL prompt with no rules at all fails in a way that
   * looks like a model problem, so the operator would debug the model instead of the empty field.
   */
  it('returns the org text when one is set', () => {
    expect(resolveSqlRulesPrompt('Always use ILIKE.')).toBe('Always use ILIKE.')
  })

  it('preserves the text BYTE-FOR-BYTE, not trimmed', () => {
    // Trimming the returned value would silently rewrite the operator's prompt. The trim exists only to
    // DECIDE emptiness, never to alter what is sent.
    const text = '  Line one.\n  Line two.  '
    expect(resolveSqlRulesPrompt(text)).toBe(text)
  })

  it('falls back to the built-in default for empty, whitespace-only, null and undefined', () => {
    for (const empty of ['', '   ', '\n\t ', null, undefined]) {
      expect(resolveSqlRulesPrompt(empty)).toBe(DEFAULT_SQL_RULES_PROMPT)
      // The default must actually be non-empty, or this test would pass for a broken default too.
      expect(resolveSqlRulesPrompt(empty).length).toBeGreaterThan(100)
    }
  })

  it('the fallback IS the exported default, so the two cannot drift', () => {
    expect(defaultSqlRulesPrompt()).toBe(DEFAULT_SQL_RULES_PROMPT)
  })
})
