/**
 * license-reminder — daily expiry warnings for paid orgs.
 * ===========================================================================
 * Runs as the `license-expiry-reminder` repeatable job on the scheduler queue
 * (see ensureLicenseReminderRepeatable in scheduler-queue.ts). For every active
 * org whose license expires within 7 days, notifies via the org's configured
 * notification channel (same system scheduled runs use).
 *
 * Dedupe: the job fires once a day, and notifications are only sent when the
 * whole-days-left count is EXACTLY 7 / 3 / 1 — so restarts or re-runs on the
 * same day never spam, and each threshold is announced once.
 */
import { db } from './db'
import { bypassOrg } from './prisma-tenant'
import { sendNotificationWithRetry } from './notifications'
import { daysUntilExpiry } from './billing-ui'
import { logSwallowed } from './logger'

/** Days-left values that trigger a notification (anti-spam dedupe rule). */
export const REMINDER_DAYS_LEFT = [7, 3, 1] as const

export function shouldNotifyDaysLeft(daysLeft: number): boolean {
  return (REMINDER_DAYS_LEFT as readonly number[]).includes(daysLeft)
}

export interface ReminderOrgRow {
  id: string
  name: string
  slug: string
  licensePlan: string | null
  licenseExpiresAt: Date | null
}

export function filterReminderOrgs(orgs: ReminderOrgRow[], now: Date): ReminderOrgRow[] {
  return orgs.filter((o) => {
    if (!o.licenseExpiresAt) return false
    return shouldNotifyDaysLeft(daysUntilExpiry(o.licenseExpiresAt, now))
  })
}

export function buildReminderMessage(org: ReminderOrgRow, now: Date): string {
  const days = daysUntilExpiry(org.licenseExpiresAt as Date, now)
  const dateStr = (org.licenseExpiresAt as Date).toISOString().slice(0, 10)
  const when = days === 1 ? 'tomorrow' : `in ${days} days`
  return (
    `Subscription for "${org.name}" (${org.slug}) expires ${when} (${dateStr}).` +
    `${org.licensePlan ? ` Plan: ${org.licensePlan}.` : ''}` +
    ` Renew it in Settings → Organization → License to avoid service interruption.`
  )
}

export interface ReminderRunSummary {
  checked: number
  notified: number
  skippedNoChannel: number
  failed: number
}

/**
 * Scan all valid-license orgs and send expiry reminders. Runs outside request
 * context — bypassOrg for the scan; notification configs are read per-org.
 */
export async function runLicenseExpiryReminders(now: Date = new Date()): Promise<ReminderRunSummary> {
  const horizonEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const orgs = await bypassOrg(() =>
    db.organization.findMany({
      where: {
        licenseStatus: 'valid',
        licenseExpiresAt: { gte: now, lte: horizonEnd },
      },
      select: {
        id: true,
        name: true,
        slug: true,
        licensePlan: true,
        licenseExpiresAt: true,
      },
    }),
  )

  const summary: ReminderRunSummary = { checked: orgs.length, notified: 0, skippedNoChannel: 0, failed: 0 }

  for (const org of filterReminderOrgs(orgs as ReminderOrgRow[], now)) {
    // Most recently used active channel wins — orgs typically configure one.
    const cfg = await bypassOrg(() =>
      db.notificationConfig.findFirst({
        where: { organizationId: org.id, isActive: true },
        orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, encryptedConfig: true },
      }),
    )
    if (!cfg) {
      summary.skippedNoChannel++
      continue
    }
    const result = await sendNotificationWithRetry({
      configEncrypted: cfg.encryptedConfig,
      message: buildReminderMessage(org, now),
      title: 'Subscription expiring soon',
    })
    if (result.ok) {
      summary.notified++
      void db.notificationConfig
        .update({ where: { id: cfg.id }, data: { lastUsedAt: new Date() } })
        .catch(logSwallowed('license-reminder: notificationConfig.lastUsedAt'))
    } else {
      summary.failed++
      console.warn(`[license-reminder] notify failed for ${org.slug}: ${result.error}`)
    }
  }

  return summary
}
