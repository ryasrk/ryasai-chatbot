/**
 * Plan-based feature gating — limits features by license plan.
 * ----------------------------------------------------------------------------
 * Plans: starter < pro < enterprise < flat
 * 'flat' is the self-serve QRIS subscription: one price unlocks everything,
 * so it ranks above enterprise. Legacy starter/pro/enterprise keep working.
 * Used by routes to gate premium features.
 *
 * ponytail: simple string comparison on plan rank. Upgrade to a permissions
 * matrix when plans get complex (per-feature toggles, add-ons, etc.).
 */
const PLAN_RANK: Record<string, number> = {
  starter: 0,
  pro: 1,
  enterprise: 2,
  flat: 3,
}

export type Plan = 'starter' | 'pro' | 'enterprise' | 'flat'

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
  flat: { maxUsers: 100, maxIntegrations: 50, maxDocuments: 10000, mcp: true, schedules: true, agent: true, sso: true },
}

/**
 * Which quota a resource counts against. A union rather than a free string so a
 * typo is a compile error instead of a silently-unenforced limit — which is
 * exactly the failure mode this mechanism exists to prevent.
 */
export type QuotaKey = 'maxUsers' | 'maxIntegrations' | 'maxDocuments'

/**
 * Resolve a plan to its quota table.
 *
 * ponytail: an unknown/null plan falls back to `starter`, the LOWEST tier — an
 * unrecognized plan is treated as the most restrictive one. Falling back to
 * `flat` instead would let a typo'd or missing plan silently unlock the largest
 * quotas, so the fail-closed direction is deliberate. Matches `hasPlan`, which
 * applies the same fallback.
 */
export function quotaFor(userPlan: string | null | undefined): (typeof PLAN_FEATURES)[Plan] {
  const plan = (userPlan ?? 'starter') as Plan
  return PLAN_FEATURES[plan] ?? PLAN_FEATURES.starter
}

export interface QuotaDecision {
  allowed: boolean
  /** Numeric ceiling for this plan, or null when the quota is unlimited. */
  limit: number | null
  /** Units already consumed, or null when the caller passed no count. */
  current: number | null
  /** Units the caller wants to add (1 for a single create). */
  requested: number
}

/**
 * Decide whether an org may add `requested` more units of `key`.
 *
 * Deliberately a PURE predicate — the caller supplies the current count. Doing
 * the count here would need a `db` import in a module that client components
 * and tests import, and the count must in any case be taken inside the same
 * tenant context as the create.
 *
 * ponytail: this is a CHECK, not a lock. Two concurrent creates can both read
 * `current = limit - 1` and both pass, overshooting by one. Closing that needs
 * a serializable transaction or a DB constraint — larger than this gap
 * warrants, since the quota is a commercial boundary, not a security one, and
 * an off-by-one overshoot is recoverable. Do NOT describe this as race-proof;
 * if a quota ever gates something expensive or security-relevant it must be
 * re-implemented as an atomic check-and-insert.
 */
export function checkQuota(
  userPlan: string | null | undefined,
  key: QuotaKey,
  current: number,
  requested = 1,
): QuotaDecision {
  const limit = quotaFor(userPlan)[key]
  // A non-positive or non-finite limit means "unlimited" — how the matrix would
  // express an uncapped plan without changing the shape of the type.
  if (!Number.isFinite(limit) || limit <= 0) {
    return { allowed: true, limit: null, current, requested }
  }
  return { allowed: current + requested <= limit, limit, current, requested }
}

/** Human-readable refusal, used verbatim in the API 402 body and the UI. */
export function quotaExceededMessage(key: QuotaKey, decision: QuotaDecision): string {
  const noun: Record<QuotaKey, string> = {
    maxUsers: 'users',
    maxIntegrations: 'data sources',
    maxDocuments: 'documents',
  }
  return `Your plan allows up to ${decision.limit} ${noun[key]}. You currently have ${decision.current}. Upgrade your plan to add more.`
}
