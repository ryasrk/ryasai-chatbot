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

import { checkCIThresholds } from './rag-eval'

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
