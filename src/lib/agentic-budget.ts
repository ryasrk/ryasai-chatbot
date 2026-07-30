export interface TokenUsage {
  promptTokens: number
  completionTokens: number
}

export interface TokenBudget {
  track(usage: TokenUsage): void
  isExhausted(): boolean
  remaining(): number
  total(): number
}

const DEFAULT_MAX = () => Number(process.env.AGENTIC_TOKEN_BUDGET ?? 50000)

export function createTokenBudget(maxTokens: number = DEFAULT_MAX()): TokenBudget {
  let used = 0
  return {
    track(usage: TokenUsage): void {
      used += usage.promptTokens + usage.completionTokens
    },
    isExhausted(): boolean {
      return used >= maxTokens
    },
    remaining(): number {
      return Math.max(0, maxTokens - used)
    },
    total(): number {
      return used
    },
  }
}
