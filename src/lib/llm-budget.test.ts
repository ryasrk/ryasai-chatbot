import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'

// --- Mocks: keep the db/session chain off a real Prisma client and Redis ---
interface AggregateArgs {
  where?: { organizationId?: string; createdAt?: { gte?: Date } }
  _sum?: Record<string, boolean>
}
const aggregateMock = mock(async (_args?: AggregateArgs) => ({ _sum: undefined as unknown }))
mock.module('@/lib/db', () => ({
  db: {
    llmUsageLog: { aggregate: aggregateMock },
    user: { findUnique: mock(async () => null) },
    auditLog: { create: mock(async () => ({})) },
  },
}))
interface RateLimitResult {
  allowed: boolean
  remaining: number
}
const rateLimitMock = mock(async (_key?: string, _max?: number) => ({
  allowed: true,
  remaining: 29,
} as RateLimitResult | null))
mock.module('@/lib/redis', () => ({
  rateLimit: rateLimitMock,
}))
mock.module('@/lib/crypto', () => ({
  verifySession: mock(() => null),
  extractSessionVersion: () => 0,
}))
mock.module('next/headers', () => ({
  cookies: async () => ({ get: () => undefined }),
}))

import {
  DEFAULT_CHAT_RATE_LIMIT_PER_MIN,
  DEFAULT_LLM_BUDGET_WINDOW_HOURS,
  assertChatSendRateLimit,
  assertWithinBudget,
  getChatSendRateLimit,
  getLlmBudgetConfig,
} from './llm-budget'
import { AppError } from './errors'

function setEnv(vars: Record<string, string | undefined>) {
  delete process.env.LLM_DAILY_TOKEN_BUDGET
  delete process.env.LLM_BUDGET_WINDOW_HOURS
  delete process.env.CHAT_RATE_LIMIT_PER_MIN
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v
  }
}

beforeEach(() => {
  aggregateMock.mockImplementation(async () => ({
    _sum: { promptTokens: 0, completionTokens: 0 },
  }))
  rateLimitMock.mockImplementation(async () => ({ allowed: true, remaining: 29 }))
})

afterEach(() => setEnv({}))

describe('getLlmBudgetConfig', () => {
  test('unset env → disabled by default, window defaults to 24h', () => {
    const cfg = getLlmBudgetConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.tokenCap).toBe(0)
    expect(cfg.windowHours).toBe(DEFAULT_LLM_BUDGET_WINDOW_HOURS)
    expect(DEFAULT_LLM_BUDGET_WINDOW_HOURS).toBe(24)
  })

  test('positive LLM_DAILY_TOKEN_BUDGET enables the cutoff', () => {
    const cfg = getLlmBudgetConfig({ LLM_DAILY_TOKEN_BUDGET: '500000' })
    expect(cfg.enabled).toBe(true)
    expect(cfg.tokenCap).toBe(500000)
  })

  test('zero / negative / garbage budget values stay disabled', () => {
    expect(getLlmBudgetConfig({ LLM_DAILY_TOKEN_BUDGET: '0' }).enabled).toBe(false)
    expect(getLlmBudgetConfig({ LLM_DAILY_TOKEN_BUDGET: '-5' }).enabled).toBe(false)
    expect(getLlmBudgetConfig({ LLM_DAILY_TOKEN_BUDGET: 'abc' }).enabled).toBe(false)
    expect(getLlmBudgetConfig({ LLM_DAILY_TOKEN_BUDGET: '' }).enabled).toBe(false)
  })

  test('LLM_BUDGET_WINDOW_HOURS overrides the window; invalid falls back', () => {
    expect(getLlmBudgetConfig({ LLM_BUDGET_WINDOW_HOURS: '6' }).windowHours).toBe(6)
    expect(
      getLlmBudgetConfig({ LLM_BUDGET_WINDOW_HOURS: '0' }).windowHours,
    ).toBe(DEFAULT_LLM_BUDGET_WINDOW_HOURS)
    expect(
      getLlmBudgetConfig({ LLM_BUDGET_WINDOW_HOURS: 'nope' }).windowHours,
    ).toBe(DEFAULT_LLM_BUDGET_WINDOW_HOURS)
  })
})

describe('assertWithinBudget', () => {
  test('disabled by default → no query, never throws', async () => {
    setEnv({})
    await expect(assertWithinBudget('org1')).resolves.toBeUndefined()
    expect(aggregateMock).not.toHaveBeenCalled()
  })

  test('window math: queries usage since now − windowHours', async () => {
    setEnv({ LLM_DAILY_TOKEN_BUDGET: '1000', LLM_BUDGET_WINDOW_HOURS: '6' })
    const before = Date.now()
    await assertWithinBudget('org-abc')
    expect(aggregateMock).toHaveBeenCalledTimes(1)
    const call = aggregateMock.mock.calls[0]?.[0]
    expect(call).toBeDefined()
    expect(call?._sum?.promptTokens).toBe(true)
    expect(call?._sum?.completionTokens).toBe(true)
    expect(call?.where?.organizationId).toBe('org-abc')
    const gte = call?.where?.createdAt?.gte
    expect(gte).toBeInstanceOf(Date)
    const gteMs = (gte as Date).getTime()
    const expectedMs = before - 6 * 3_600_000
    // Allow small clock drift between `before` and the internal new Date().
    expect(Math.abs(gteMs - expectedMs)).toBeLessThan(5000)
  })

  test('usage under cap → passes', async () => {
    setEnv({ LLM_DAILY_TOKEN_BUDGET: '1000' })
    aggregateMock.mockImplementation(async () => ({
      _sum: { promptTokens: 400, completionTokens: 599 },
    }))
    await expect(assertWithinBudget('org1')).resolves.toBeUndefined()
  })

  test('usage at cap → throws AppError LLM_BUDGET_EXCEEDED with 429', async () => {
    setEnv({ LLM_DAILY_TOKEN_BUDGET: '1000' })
    aggregateMock.mockImplementation(async () => ({
      _sum: { promptTokens: 600, completionTokens: 400 },
    }))
    try {
      await assertWithinBudget('org1')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e instanceof AppError).toBe(true)
      const err = e as AppError
      expect(err.code).toBe('LLM_BUDGET_EXCEEDED')
      expect(err.statusCode).toBe(429)
    }
  })

  test('usage over cap → throws even when only one token kind is logged', async () => {
    setEnv({ LLM_DAILY_TOKEN_BUDGET: '10', LLM_BUDGET_WINDOW_HOURS: '1' })
    aggregateMock.mockImplementation(async () => ({
      _sum: { promptTokens: null, completionTokens: 11 },
    }))
    try {
      await assertWithinBudget('org1')
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as AppError).code).toBe('LLM_BUDGET_EXCEEDED')
    }
  })

  test('db aggregate failure propagates as INTERNAL_ERROR-style throw (fail closed)', async () => {
    setEnv({ LLM_DAILY_TOKEN_BUDGET: '1000' })
    aggregateMock.mockImplementation(async () => {
      throw new Error('db down')
    })
    await expect(assertWithinBudget('org1')).rejects.toThrow('db down')
  })
})

describe('getChatSendRateLimit', () => {
  test('default is 30/min when unset or invalid', () => {
    expect(getChatSendRateLimit({})).toBe(30)
    expect(DEFAULT_CHAT_RATE_LIMIT_PER_MIN).toBe(30)
    expect(getChatSendRateLimit({ CHAT_RATE_LIMIT_PER_MIN: 'abc' })).toBe(30)
    expect(getChatSendRateLimit({ CHAT_RATE_LIMIT_PER_MIN: '-3' })).toBe(30)
  })

  test('env override wins', () => {
    expect(getChatSendRateLimit({ CHAT_RATE_LIMIT_PER_MIN: '120' })).toBe(120)
  })
})

describe('assertChatSendRateLimit', () => {
  test('calls rateLimit keyed by org id with the configured limit', async () => {
    setEnv({ CHAT_RATE_LIMIT_PER_MIN: '45' })
    await assertChatSendRateLimit('org-xyz')
    expect(rateLimitMock).toHaveBeenCalledWith('chat-send:org-xyz', 45)
  })

  test('allowed → passes silently', async () => {
    rateLimitMock.mockImplementation(async () => ({ allowed: true, remaining: 10 }))
    await expect(assertChatSendRateLimit('org1')).resolves.toBeUndefined()
  })

  test('denied → throws AppError RATE_LIMITED with 429', async () => {
    rateLimitMock.mockImplementation(async () => ({ allowed: false, remaining: 0 }))
    try {
      await assertChatSendRateLimit('org1')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e instanceof AppError).toBe(true)
      const err = e as AppError
      expect(err.code).toBe('RATE_LIMITED')
      expect(err.statusCode).toBe(429)
    }
  })

  test('Redis down (rateLimit returns null) → fail open like v1 routes', async () => {
    rateLimitMock.mockImplementation(async () => null)
    await expect(assertChatSendRateLimit('org1')).resolves.toBeUndefined()
  })
})
