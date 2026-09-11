/**
 * Org-level LLM request guards used by the interactive chat send route:
 *
 * 1. assertWithinBudget — rolling-window token spend cutoff over LlmUsageLog
 *    (written by llm-client-utils on every call, previously never enforced).
 *    Disabled by default: unset/0/invalid LLM_DAILY_TOKEN_BUDGET means no cap,
 *    so existing deployments keep working until an operator opts in.
 * 2. assertChatSendRateLimit — per-org burst limit on chat sends via the
 *    shared Redis rateLimit() util. Fail-open when Redis is down (returns
 *    null), matching v1 external-API behaviour.
 *
 * Pure read-side enforcement — never writes usage rows and does not touch
 * llm-client-utils.
 */
import { db } from '@/lib/db'
import { AppError } from '@/lib/errors'
import { rateLimit } from '@/lib/redis'

export const DEFAULT_LLM_BUDGET_WINDOW_HOURS = 24
export const DEFAULT_CHAT_RATE_LIMIT_PER_MIN = 30

export interface LlmBudgetConfig {
  enabled: boolean
  tokenCap: number
  windowHours: number
}

type EnvSource = Record<string, string | undefined>

function parsePositiveInt(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function parsePositiveNumber(raw: string | undefined): number {
  if (!raw) return 0
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

/**
 * Budget config from env. `LLM_DAILY_TOKEN_BUDGET` (tokens) enables the cutoff;
 * `LLM_BUDGET_WINDOW_HOURS` controls the rolling window (default 24h). The env
 * name says DAILY but the window is configurable — kept for compatibility.
 */
export function getLlmBudgetConfig(env: EnvSource = process.env): LlmBudgetConfig {
  const tokenCap = parsePositiveInt(env.LLM_DAILY_TOKEN_BUDGET)
  const windowHours =
    parsePositiveNumber(env.LLM_BUDGET_WINDOW_HOURS) || DEFAULT_LLM_BUDGET_WINDOW_HOURS
  return { enabled: tokenCap > 0, tokenCap, windowHours }
}

/** Sum of input+output tokens logged for the org since `since`. */
export async function getOrgTokenUsage(
  organizationId: string,
  since: Date,
): Promise<number> {
  const agg = await db.llmUsageLog.aggregate({
    _sum: { promptTokens: true, completionTokens: true },
    where: {
      organizationId,
      createdAt: { gte: since },
    },
  })
  return (agg._sum.promptTokens ?? 0) + (agg._sum.completionTokens ?? 0)
}

/**
 * Throws AppError('LLM_BUDGET_EXCEEDED') when the org has consumed its token
 * budget within the rolling window. No-op when the budget is disabled.
 */
export async function assertWithinBudget(organizationId: string, now = new Date()): Promise<void> {
  const cfg = getLlmBudgetConfig()
  if (!cfg.enabled) return

  const since = new Date(now.getTime() - cfg.windowHours * 3_600_000)
  const used = await getOrgTokenUsage(organizationId, since)
  if (used >= cfg.tokenCap) {
    throw new AppError(
      'LLM_BUDGET_EXCEEDED',
      'LLM token budget exceeded for your organization. Please wait for the window to reset or contact your administrator to raise the limit.',
      {
        hint: `${used} tokens used in the last ${cfg.windowHours}h; budget is ${cfg.tokenCap}.`,
        statusCode: 429,
      },
    )
  }
}

/** Env-overridable chat send limit; unset/invalid falls back to 30/min/org. */
export function getChatSendRateLimit(env: EnvSource = process.env): number {
  return parsePositiveInt(env.CHAT_RATE_LIMIT_PER_MIN) || DEFAULT_CHAT_RATE_LIMIT_PER_MIN
}

/**
 * Per-org burst limit on interactive chat sends. Throws AppError('RATE_LIMITED')
 * when denied; fails open when Redis is down (rateLimit returns null) so chat
 * keeps working degraded — same contract as the v1 external API routes.
 */
export async function assertChatSendRateLimit(organizationId: string): Promise<void> {
  const maxPerMinute = getChatSendRateLimit()
  const rl = await rateLimit(`chat-send:${organizationId}`, maxPerMinute)
  if (rl && !rl.allowed) {
    throw new AppError(
      'RATE_LIMITED',
      'Too many messages sent. Please wait a moment and try again.',
      { hint: `Limit: ${maxPerMinute} messages per minute per organization.` },
    )
  }
}
