/**
 * Periodic license revalidation — runs every LICENSE_REVALIDATION_INTERVAL_HOURS.
 * Calls validateLicense for every org with a license key, updates status in DB.
 */
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { validateLicense, generateMachineId, REVALIDATION_INTERVAL_MS } from '@/lib/license-client'
import { scopedLogger } from '@/lib/logger'

const log = scopedLogger('license-reval')

export function startLicenseRevalidation(): () => void {
  const timer = setInterval(runRevalidation, REVALIDATION_INTERVAL_MS)
  // ponytail: run once on startup after 30s delay (let app boot first)
  setTimeout(runRevalidation, 30_000)
  log.info(`License revalidation started — every ${REVALIDATION_INTERVAL_MS / 3600_000}h`)
  return () => {
    clearInterval(timer)
  }
}

async function runRevalidation() {
  try {
    const orgs = await bypassOrg(() =>
      db.organization.findMany({
        where: { licenseKey: { not: null } },
        select: { id: true, slug: true, licenseKey: true },
      }),
    )
    log.info(`Revalidating ${orgs.length} org license(s)`)
    for (const org of orgs) {
      if (!org.licenseKey) continue
      try {
        const machineId = generateMachineId(org.slug)
        const result = await validateLicense(org.licenseKey, machineId)

        let newStatus: string
        if (result.signatureVerified && result.valid) {
          newStatus = 'valid'
        } else if (result.signatureVerified && !result.valid) {
          newStatus = result.message.includes('expired') ? 'expired'
            : result.message.includes('deactivated') ? 'suspended'
            : 'invalid'
        } else {
          // Signature failed or network error → unreachable (grace period applies)
          newStatus = 'unreachable'
        }

        await bypassOrg(() =>
          db.organization.update({
            where: { id: org.id },
            data: {
              licenseStatus: newStatus,
              licensePlan: result.signatureVerified ? result.plan : undefined,
              licenseValidatedAt: result.signatureVerified && result.valid ? new Date() : undefined,
              licenseExpiresAt: result.signatureVerified && result.expiresAt ? new Date(result.expiresAt) : undefined,
            },
          }),
        )
        log.info(`Org ${org.slug}: ${newStatus}`)
      } catch (e) {
        // Network error → unreachable, don't lock yet (grace period)
        await bypassOrg(() =>
          db.organization.update({
            where: { id: org.id },
            data: { licenseStatus: 'unreachable' },
          }),
        )
        log.warn(`Org ${org.slug}: unreachable — ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  } catch (e) {
    log.error('License revalidation cycle failed', { error: e instanceof Error ? e.message : String(e) })
  }
}
