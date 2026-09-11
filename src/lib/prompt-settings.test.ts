import { describe, expect, it } from 'bun:test'
import { parsePromptSettings, mergePromptSettings } from './prompt-settings'

describe('prompt settings', () => {
  it('returns defaults for null/garbage', () => {
    const d = parsePromptSettings(null)
    expect(d).toEqual({ systemPrompt: '', ragContextPrompt: '', tools: { rag: true, sql: true, restApi: true } })
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
