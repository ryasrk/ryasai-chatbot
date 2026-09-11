/**
 * Periodic license revalidation — runs every LICENSE_REVALIDATION_INTERVAL_HOURS.
 * Calls validateLicense for every org with a license key, updates status in DB.
 */
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { validateLicense, generateMachineId, licenseStatusFromResult, licenseUpdateFromResult, REVALIDATION_INTERVAL_MS } from '@/lib/license-client'
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
        const newStatus = licenseStatusFromResult(result)

        await bypassOrg(() =>
          db.organization.update({
            where: { id: org.id },
            // ponytail: planFallback keeps a paid plan from being cleared when
            // the signed response omits `plan` — previously this site used a
            // bare `result.plan` while license-issue used `?? 'flat'`, so the
            // two paths disagreed on the same response.
            data: licenseUpdateFromResult(result, { planFallback: 'flat' }),
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
