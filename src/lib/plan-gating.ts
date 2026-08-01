/**
 * Plan-based feature gating — limits features by license plan.
 * ----------------------------------------------------------------------------
 * Plans: starter < pro < enterprise
 * Used by routes to gate premium features.
 *
 * ponytail: simple string comparison on plan rank. Upgrade to a permissions
 * matrix when plans get complex (per-feature toggles, add-ons, etc.).
 */
const PLAN_RANK: Record<string, number> = {
  starter: 0,
  pro: 1,
  enterprise: 2,
}

export type Plan = 'starter' | 'pro' | 'enterprise'

export function hasPlan(userPlan: string | null | undefined, minPlan: Plan): boolean {
  const userRank = PLAN_RANK[userPlan ?? 'starter'] ?? 0
  const requiredRank = PLAN_RANK[minPlan] ?? 0
  return userRank >= requiredRank
}

// Feature matrix — which features each plan includes
export const PLAN_FEATURES: Record<Plan, { maxUsers: number; maxIntegrations: number; maxDocuments: number; mcp: boolean; schedules: boolean; agent: boolean; sso: boolean }> = {
  starter: { maxUsers: 3, maxIntegrations: 1, maxDocuments: 25, mcp: false, schedules: false, agent: false, sso: false },
  pro: { maxUsers: 10, maxIntegrations: 5, maxDocuments: 250, mcp: true, schedules: true, agent: true, sso: true },
  enterprise: { maxUsers: 100, maxIntegrations: 50, maxDocuments: 10000, mcp: true, schedules: true, agent: true, sso: true },
}
