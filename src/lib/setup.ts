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
 * Without a session (pre-login — the caller's org isn't known yet),
 * setupCompleted is reported true so the pre-login screen falls through to
 * the normal login/signup flow instead of blocking on an arbitrary org's
 * incomplete wizard. The real per-org check happens once this is re-fetched
 * after login.
 */
// ponytail: accept the tenant-extended db (not plain PrismaClient) so callers
// can pass the $extends client without a cast.
export async function getSetupState(db: typeof import('@/lib/db').db, organizationId?: string) {
  const appConfig = organizationId
    ? await db.appConfig.findFirst({ where: { organizationId }, select: { setupCompleted: true } })
    : null
  const admin = await db.user.findFirst({
    where: { isActive: true, passwordHash: { startsWith: 'scrypt$' } },
    select: { id: true },
  })
  return {
    setupCompleted: organizationId ? (appConfig?.setupCompleted ?? false) : true,
    hasAdmin: !!admin,
  }
}
