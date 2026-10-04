import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getLockdownReason } from '@/lib/license-client'

/** Resolve entitlement independently of a request session or queued admission time. */
export async function backgroundLockdownReason(organizationId: string) {
  if (!organizationId) return getLockdownReason('invalid', null)
  const org = await bypassOrg(() => db.organization.findUnique({
    where: { id: organizationId },
    select: { licenseStatus: true, licenseValidatedAt: true },
  }))
  return getLockdownReason(org?.licenseStatus ?? 'invalid', org?.licenseValidatedAt ?? null)
}
