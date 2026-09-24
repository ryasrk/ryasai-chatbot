import { describe, expect, test } from 'bun:test'
import { probePhrase, readinessSample } from './supermemory-arm'

describe('supermemory readiness gate', () => {
  const ids = Array.from({ length: 1200 }, (_, i) => `doc-${String(i + 1).padStart(4, '0')}`)

  test('samples the requested count, spread across the whole corpus', () => {
    const s = readinessSample(ids, 50)
    expect(s.length).toBe(50)
    expect(s[0]).toBe('doc-0001')
    expect(s[s.length - 1]).toBe('doc-1200')
    // A queue that drains in order must not pass on early documents only.
    expect(s.filter((id) => id > 'doc-0600').length).toBeGreaterThanOrEqual(20)
  })

  test('is deterministic', () => {
    expect(readinessSample(ids, 50)).toEqual(readinessSample(ids, 50))
  })

  test('returns every document when the corpus is smaller than the sample', () => {
    expect(readinessSample(['a', 'b'], 50)).toEqual(['a', 'b'])
  })

  test('probe phrase is the opening words of the document', () => {
    expect(probePhrase('one two   three')).toBe('one two three')
    expect(probePhrase(Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')).split(' ').length).toBe(12)
  })
})
