import { describe, expect, test, mock, afterEach } from 'bun:test'

const mockGetRoleLlmConfig = mock(async (): Promise<unknown> => null)
const mockChatOnce = mock(async () => '0.5')

mock.module('@/lib/logger', () => ({
  scopedLogger: () => ({ debug: () => {}, warn: () => {}, info: () => {}, error: () => {} }),
}))
mock.module('@/lib/llm-client', () => ({ chatOnce: mockChatOnce }))
mock.module('@/lib/llm-config', () => ({ getRoleLlmConfig: mockGetRoleLlmConfig }))
mock.module('@/lib/rag', () => ({
  retrieveRelevantChunks: async () => ({ chunks: [], queryTokens: [], candidatesScanned: 0, graphContext: '' }),
}))
mock.module('@/lib/ai', () => ({ generateAnswer: async () => 'mock answer', generateChat: async () => 'mock' }))
mock.module('@/lib/observability', () => ({ postLangfuseScore: () => {} }))

import { runRagEvaluation, checkCIThresholds, scoreFaithfulness, scoreAnswerRelevance, scoreContextPrecision, scoreContextDensity, scoreContextRecall } from './rag-eval'
import type { LlmRuntimeConfig } from '@/lib/llm-config'

describe('judge response validation', () => {
  const cfg = { id: 'judge', provider: 'OPENAI_COMPATIBLE', baseUrl: 'https://example.test/v1', apiKey: 'fixture', model: 'judge' } satisfies LlmRuntimeConfig
  test('malformed or out-of-range responses are unjudged across all four metrics', async () => {
    // A fabricated 0.5 counted as a completed judgement; clamping infinity/9 fabricated perfect scores.
    for (const output of ['', 'not a score', 'Infinity', 'NaN', '9', '-0.1', '0.9 garbage']) {
      mockChatOnce.mockImplementation(async () => output)
      const scores = await Promise.all([
        scoreFaithfulness('question', 'answer', 'context', cfg),
        scoreAnswerRelevance('question', 'answer', cfg),
        scoreContextDensity('question', 'context', cfg),
        scoreContextPrecision('question', 'expected', ['context'], cfg),
        scoreContextRecall('question', 'expected', 'context', cfg),
      ])
      expect(scores.every(Number.isNaN)).toBe(true)
    }
  })
  test('chunk precision uses binary usefulness and fails on partial judgement', async () => {
    mockChatOnce.mockImplementationOnce(async () => '0').mockImplementationOnce(async () => '1')
    expect(await scoreContextPrecision('q', 'reference', ['irrelevant', 'relevant'], cfg)).toBe(0.5)
    mockChatOnce.mockImplementationOnce(async () => '1').mockImplementationOnce(async () => '0.5')
    expect(await scoreContextPrecision('q', 'reference', ['relevant', 'unknown'], cfg)).toBeNaN()
  })
  test('a valid numeric response retains the measured score', async () => {
    mockChatOnce.mockImplementation(async () => ' 0.85\n')
    expect(await scoreFaithfulness('question', 'answer', 'context', cfg)).toBe(0.85)
  })
  test('CI rejects a self-judge before spending generation or judge calls', async () => {
    const keys = ['EVAL_ORG_ID', 'RAGAS_JUDGE_BASE_URL', 'RAGAS_JUDGE_KEY', 'RAGAS_JUDGE_MODEL']
    const saved = keys.map(key => process.env[key])
    try {
      keys.forEach(key => delete process.env[key])
      process.env.EVAL_ORG_ID = 'eval-fixture'
      mockGetRoleLlmConfig.mockImplementation(async () => cfg)
      mockChatOnce.mockClear()
      await expect(runRagEvaluation(undefined, true)).rejects.toThrow('independent judge before')
      expect(mockChatOnce).not.toHaveBeenCalled()
    } finally {
      keys.forEach((key, index) => saved[index] === undefined ? delete process.env[key] : process.env[key] = saved[index])
      mockGetRoleLlmConfig.mockImplementation(async () => null)
    }
  })
})

afterEach(() => {
  delete process.env.RAGAS_MIN_FAITHFULNESS
  delete process.env.RAGAS_MIN_ANSWER_RELEVANCE
  delete process.env.RAGAS_MIN_CONTEXT_PRECISION
  delete process.env.RAGAS_MIN_CONTEXT_RECALL
})

describe('checkCIThresholds', () => {
  test('passes when all scores meet thresholds', () => {
    const exitSpy = mock(() => { throw new Error('should not exit') })
    const origExit = process.exit
    process.exit = exitSpy as never
    try {
      checkCIThresholds({
        avgFaithfulness: 0.90,
        avgAnswerRelevance: 0.85,
        avgContextPrecision: 0.82,
        avgContextRecall: 0.81,
      })
      expect(exitSpy).not.toHaveBeenCalled()
    } finally {
      process.exit = origExit
    }
  })

  test('exits when faithfulness below threshold', () => {
    const origExit = process.exit
    let exitCode = -1
    process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('EXIT') }) as never
    try {
      expect(() => checkCIThresholds({
        avgFaithfulness: 0.70,
        avgAnswerRelevance: 0.90,
        avgContextPrecision: 0.90,
        avgContextRecall: 0.90,
      })).toThrow('EXIT')
      expect(exitCode).toBe(1)
    } finally {
      process.exit = origExit
    }
  })

  test('exits when any metric below threshold', () => {
    const origExit = process.exit
    process.exit = ((code?: number) => { throw new Error(`EXIT_${code}`) }) as never
    try {
      expect(() => checkCIThresholds({
        avgFaithfulness: 0.90,
        avgAnswerRelevance: 0.70,
        avgContextPrecision: 0.90,
        avgContextRecall: 0.90,
      })).toThrow('EXIT_1')
    } finally {
      process.exit = origExit
    }
  })

  test('uses custom thresholds from env', () => {
    process.env.RAGAS_MIN_FAITHFULNESS = '0.95'
    const origExit = process.exit
    process.exit = ((code?: number) => { throw new Error(`EXIT_${code}`) }) as never
    try {
      expect(() => checkCIThresholds({
        avgFaithfulness: 0.90,
        avgAnswerRelevance: 0.90,
        avgContextPrecision: 0.90,
        avgContextRecall: 0.90,
      })).toThrow('EXIT_1')
    } finally {
      process.exit = origExit
    }
  })

  test('passes with custom low thresholds from env', () => {
    process.env.RAGAS_MIN_FAITHFULNESS = '0.50'
    const origExit = process.exit
    process.exit = (() => { throw new Error('should not exit') }) as never
    try {
      checkCIThresholds({
        avgFaithfulness: 0.60,
        avgAnswerRelevance: 0.80,
        avgContextPrecision: 0.80,
        avgContextRecall: 0.80,
      })
    } finally {
      process.exit = origExit
    }
  })
})
