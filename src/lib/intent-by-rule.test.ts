import { describe, expect, test } from 'bun:test'
import { intentByRule, intentModelEnabled, needsClarificationByRule } from '@/lib/intent-by-rule'
import * as pipeline from '@/lib/intent-pipeline'

describe('intentByRule', () => {
  test('an ordinary question retrieves (routing then picks the tool, or chat) and is not clarified', () => {
    expect(intentByRule('Berapa hari cuti tahunan karyawan tetap?')).toEqual({ needsRetrieval: true, needsClarification: false, confidence: 0.5 })
    expect(intentByRule('Halo, apa kabar?').needsClarification).toBe(false)
  })

  test('a pronoun with no antecedent asks WHAT to count; a vague recency asks WHEN', () => {
    expect(intentByRule('How many of those are there?')).toMatchObject({ needsClarification: true, clarificationQuestion: expect.stringContaining('What should I count') })
    expect(intentByRule('Show me the recent ones.')).toMatchObject({ needsClarification: true, clarificationQuestion: expect.stringContaining('time period') })
  })

  test('the model is opt-in', () => {
    const prev = process.env.INTENT_MODEL
    delete process.env.INTENT_MODEL
    expect(intentModelEnabled()).toBe(false)
    process.env.INTENT_MODEL = 'true'
    expect(intentModelEnabled()).toBe(true)
    if (prev === undefined) delete process.env.INTENT_MODEL
    else process.env.INTENT_MODEL = prev
  })

  test('intent-pipeline still exports the same rule (public surface kept)', () => {
    expect(pipeline.needsClarificationByRule).toBe(needsClarificationByRule)
  })
})
