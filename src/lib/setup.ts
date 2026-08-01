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
 */
// ponytail: accept the tenant-extended db (not plain PrismaClient) so callers
// can pass the $extends client without a cast.
export async function getSetupState(db: typeof import('@/lib/db').db) {
  const appConfig = await db.appConfig.findFirst({ select: { setupCompleted: true } })
  const admin = await db.user.findFirst({
    where: { isActive: true, passwordHash: { startsWith: 'scrypt$' } },
    select: { id: true },
  })
  return { setupCompleted: appConfig?.setupCompleted ?? false, hasAdmin: !!admin }
}
