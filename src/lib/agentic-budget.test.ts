import { describe, expect, test } from 'bun:test'
import { createTokenBudget } from './agentic-budget'

describe('createTokenBudget', () => {
  test('tracks token usage', () => {
    const budget = createTokenBudget(1000)
    budget.track({ promptTokens: 100, completionTokens: 50 })
    expect(budget.total()).toBe(150)
    expect(budget.remaining()).toBe(850)
  })

  test('accumulates multiple tracks', () => {
    const budget = createTokenBudget(1000)
    budget.track({ promptTokens: 100, completionTokens: 50 })
    budget.track({ promptTokens: 200, completionTokens: 100 })
    expect(budget.total()).toBe(450)
    expect(budget.remaining()).toBe(550)
  })

  test('isExhausted is false before limit', () => {
    const budget = createTokenBudget(100)
    budget.track({ promptTokens: 40, completionTokens: 30 })
    expect(budget.isExhausted()).toBe(false)
  })

  test('isExhausted is true at limit', () => {
    const budget = createTokenBudget(100)
    budget.track({ promptTokens: 60, completionTokens: 40 })
    expect(budget.isExhausted()).toBe(true)
  })

  test('isExhausted is true over limit', () => {
    const budget = createTokenBudget(100)
    budget.track({ promptTokens: 200, completionTokens: 100 })
    expect(budget.isExhausted()).toBe(true)
    expect(budget.remaining()).toBe(0)
  })

  test('remaining never goes negative', () => {
    const budget = createTokenBudget(50)
    budget.track({ promptTokens: 100, completionTokens: 100 })
    expect(budget.remaining()).toBe(0)
  })

  test('defaults to env AGENTIC_TOKEN_BUDGET', () => {
    process.env.AGENTIC_TOKEN_BUDGET = '12345'
    const budget = createTokenBudget()
    budget.track({ promptTokens: 100, completionTokens: 0 })
    expect(budget.remaining()).toBe(12245)
    delete process.env.AGENTIC_TOKEN_BUDGET
  })
})
