import { describe, expect, it } from 'bun:test'
import { parsePromptSettings, mergePromptSettings } from './prompt-settings'

describe('prompt settings', () => {
  it('returns defaults for null/garbage', () => {
    const d = parsePromptSettings(null)
    expect(d).toEqual({ systemPrompt: '', tools: { rag: true, sql: true, restApi: true } })
    expect(parsePromptSettings('{oops')).toEqual(d)
  })
  it('parses stored json and fills missing keys', () => {
    const s = parsePromptSettings('{"systemPrompt":"Jawab singkat.","tools":{"sql":false}}')
    expect(s.systemPrompt).toBe('Jawab singkat.')
    expect(s.tools).toEqual({ rag: true, sql: false, restApi: true })
  })
  it('merges updates over current', () => {
    const cur = parsePromptSettings(null)
    const m = mergePromptSettings(cur, { tools: { rag: false } })
    expect(m.tools).toEqual({ rag: false, sql: true, restApi: true })
    expect(m.systemPrompt).toBe('')
  })
})
