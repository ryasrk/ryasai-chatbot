/**
 * Unit tests for ground-truth linter (gt-lint).
 *
 * Pins the mechanical checks required by the benchmark audit:
 * - Negative relations rejected from multi-hop chains
 * - Raw entity IDs (like dlv-001) rejected from question text
 * - Answer leaks rejected
 * - Missing hop documents or entities rejected
 */
import { describe, expect, test } from 'bun:test'
import { lintGroundTruth } from './cognee-gt-lint'

const corpus = {
  docs: [
    {
      id: 'doc-0001',
      title: 'Doc 1',
      text: 'Ratna Wibowo authorized the emergency intake of batch B-2291 at the site.',
    },
    {
      id: 'doc-0002',
      title: 'Doc 2',
      text: 'Item B-2291 originated from vendor PT Sinar Abadi.',
    },
    {
      id: 'doc-0003',
      title: 'Doc 3',
      text: 'Reconciliation note for Project Alpha: no incident was filed for incident IR-001.',
    },
  ],
}

describe('gt-lint mechanical checks', () => {
  test('passes on valid multi-hop question with positive links', () => {
    const questions = [
      {
        id: 'medium-00001',
        tier: 'medium' as const,
        submechanism: null,
        question: 'Which vendor is associated with the intake involving Ratna Wibowo?',
        answer: 'Sinar Abadi',
        answerAliases: ['PT Sinar Abadi', 'Sinar Abadi'],
        evidenceDocIds: ['doc-0001', 'doc-0002'],
        hopChain: [
          { from: 'Ratna Wibowo', via: 'authorized', to: 'B-2291', docId: 'doc-0001' },
          { from: 'B-2291', via: 'from_vendor', to: 'Sinar Abadi', docId: 'doc-0002' },
        ],
        distractorDocIds: [],
        distractorStrings: [],
        mustAppearTokens: ['Sinar Abadi'],
        mustNotAppearTokens: [],
        asOf: null,
        answerIsNegative: false,
      },
    ]

    const result = lintGroundTruth(corpus, questions)
    expect(result.passed).toBe(true)
    expect(result.violations.length).toBe(0)
  })

  test('fails if chain contains a negative relation (Audit Fix 1)', () => {
    const questions = [
      {
        id: 'medium-00002',
        tier: 'medium' as const,
        submechanism: null,
        question: 'Which item is connected to Project Alpha?',
        answer: 'Sinar Abadi',
        answerAliases: ['Sinar Abadi'],
        evidenceDocIds: ['doc-0003', 'doc-0002'],
        hopChain: [
          { from: 'Project Alpha', via: 'no_record_for', to: 'IR-001', docId: 'doc-0003' },
          { from: 'IR-001', via: 'involved_batch', to: 'B-2291', docId: 'doc-0002' },
        ],
        distractorDocIds: [],
        distractorStrings: [],
        mustAppearTokens: ['Sinar Abadi'],
        mustNotAppearTokens: [],
        asOf: null,
        answerIsNegative: false,
      },
    ]

    const result = lintGroundTruth(corpus, questions)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.check === 'negative-relation-in-chain')).toBe(true)
  })

  test('fails if question contains raw unrendered entity ID like dlv-001 (Audit Fix 3)', () => {
    const questions = [
      {
        id: 'complex-00001',
        tier: 'complex' as const,
        submechanism: 'supersession',
        question: 'A later memo corrects arrival for dlv-001. Which vendor applies?',
        answer: 'Sinar Abadi',
        answerAliases: ['Sinar Abadi'],
        evidenceDocIds: ['doc-0001'],
        hopChain: [{ from: 'dlv-001', via: 'was_late', to: 'timing', docId: 'doc-0001' }],
        distractorDocIds: [],
        distractorStrings: [],
        mustAppearTokens: ['Sinar Abadi'],
        mustNotAppearTokens: [],
        asOf: null,
        answerIsNegative: false,
      },
    ]

    const result = lintGroundTruth(corpus, questions)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.check === 'raw-id-in-question')).toBe(true)
  })

  test('fails if question text leaks the answer', () => {
    const questions = [
      {
        id: 'easy-00001',
        tier: 'easy' as const,
        submechanism: null,
        question: 'Which vendor is PT Sinar Abadi associated with?',
        answer: 'Sinar Abadi',
        answerAliases: ['Sinar Abadi'],
        evidenceDocIds: ['doc-0002'],
        hopChain: [{ from: 'B-2291', via: 'from_vendor', to: 'Sinar Abadi', docId: 'doc-0002' }],
        distractorDocIds: [],
        distractorStrings: [],
        mustAppearTokens: ['Sinar Abadi'],
        mustNotAppearTokens: [],
        asOf: null,
        answerIsNegative: false,
      },
    ]

    const result = lintGroundTruth(corpus, questions)
    expect(result.passed).toBe(false)
    expect(result.violations.some((v) => v.check === 'question-leaks-answer')).toBe(true)
  })
})
