export interface SetupAdminInput {
  name: string
  email: string
  password: string
}

/**
 * Validate + normalise the setup-admin form body.
 * Returns null on any validation failure so route handlers can map directly to
 * a 400 without leaking *which* field failed (avoids enumeration).
 */
export function normalizeSetupAdminInput(body: unknown): SetupAdminInput | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const name = typeof b.name === 'string' ? b.name.trim() : ''
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : ''
  const password = typeof b.password === 'string' ? b.password : ''
  if (!name || !email || password.length < 8) return null
  return { name, email, password }
}

/**
 * Read the setup state: whether AppConfig.setupCompleted is true AND whether an
 * active admin with a scrypt$ password hash exists. `hasAdmin` keys on the hash
 * prefix so a legacy/demo user (no password) does not count.
 *
 * `organizationId`, when known (an active session), scopes the AppConfig
 * lookup to that org. This is a multi-tenant app — every signup
 * (`/api/auth/register`) creates its own Organization + AppConfig row — so an
 * unscoped findFirst() picks up whichever org's row happens to be physically
 * first in the table and reports THAT org's setupCompleted, not the caller's.
 * A logged-in admin who had genuinely finished their own wizard would then get
 * bounced back into it on every refresh because some unrelated org (an old
 * demo signup, an e2e test run, another trial) never finished theirs.
 *
 * Without a session (pre-login — the caller's org isn't known yet) we must not
 * report an arbitrary org's `setupCompleted`, but we also must not report `true`
 * unconditionally: a genuinely fresh install has NO org at all and still has to
 * reach the signup screen. So the anonymous answer is "has anything been set up
 * yet?" — a single `count()` over AppConfig. `false` on an empty database is
 * what lets `page.tsx` mount the signup form; once a session exists the real
 * per-org check takes over.
 *
 * INCIDENT (2026-09): this previously hardcoded `setupCompleted: true` for
 * anonymous callers. On a fresh install (0 users, 0 orgs, 0 AppConfig rows —
 * exactly what `install.sh` produces before the first signup) the setup-status
 * response claimed setup was complete, so `page.tsx` skipped its entire
 * `if (!setup.setupCompleted)` signup block and rendered the app shell with no
 * session. A brand-new customer never got a Sign Up form and the deployment was
 * unusable. Reproduced on a clean `prisma db push` database.
 */
// ponytail: accept the tenant-extended db (not plain PrismaClient) so callers
// can pass the $extends client without a cast.
export async function getSetupState(db: typeof import('@/lib/db').db, organizationId?: string) {
  const admin = await db.user.findFirst({
    where: { isActive: true, passwordHash: { startsWith: 'scrypt$' } },
    select: { id: true },
  })

  // Per-org answer when the caller's org is known (post-login).
  if (organizationId) {
    const appConfig = await db.appConfig.findFirst({
      where: { organizationId },
      select: { setupCompleted: true },
    })
    return {
      setupCompleted: appConfig?.setupCompleted ?? false,
      hasAdmin: !!admin,
    }
  }

  // Anonymous: "has ANY setup ever been completed?" — a count() cannot be
  // skewed by row ordering, which was the original reason for the hardcode.
  const completedConfigs = await db.appConfig.count({ where: { setupCompleted: true } })
  return {
    setupCompleted: completedConfigs > 0,
    hasAdmin: !!admin,
  }
}
