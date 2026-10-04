import { describe, expect, test } from 'bun:test'
import corpus from './data/readiness-corpus.json'
describe('demonstration corpus ground truth', () => {
  test('forty distinct questions reference eight policy documents with supporting answer terms', () => {
    expect(corpus.questions.length).toBeGreaterThanOrEqual(40)
    expect(new Set(corpus.questions.map(q=>q.question)).size).toBe(corpus.questions.length)
    expect(new Set(corpus.questions.map(q=>q.id)).size).toBe(corpus.questions.length)
    expect(corpus.documents.length).toBe(8)
    for(const q of corpus.questions) {
      const doc=corpus.documents.find(d=>d.name===q.expectedSource)
      expect(doc).toBeDefined()
      for (const term of q.expectedAnswer.toLowerCase().split(/\s+/)) expect(doc!.content.toLowerCase()).toContain(term)
    }
  })
})
