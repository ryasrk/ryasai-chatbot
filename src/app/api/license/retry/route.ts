import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError, type ActiveUser } from '@/lib/session'
import { validateLicense, generateMachineId, licenseStatusFromResult } from '@/lib/license-client'

/**
 * POST /api/license/retry
 *   Manually trigger license revalidation. Accessible even when locked down
 *   (user may still be logged in but getting 402 on other routes).
 *
 *   getActiveUser() is called with skipLicenseCheck so a locked-down org can
 *   still be revalidated — otherwise the LicenseError thrown by the license
 *   gate would be swallowed by the catch below and misreported as 401.
 */
export async function POST() {
  try {
    let user: ActiveUser
    try {
      user = await getActiveUser({ skipLicenseCheck: true })
    } catch {
      // UnauthorizedError (no valid session) — retry requires authentication.
      return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
    }

    const org = await bypassOrg(() =>
      db.organization.findUnique({
        where: { id: user.organizationId },
        select: { id: true, slug: true, licenseKey: true },
      }),
    )
    if (!org || !org.licenseKey) {
      return NextResponse.json({ error: 'No license key set.' }, { status: 400 })
    }

    const machineId = generateMachineId(org.slug)
    const result = await validateLicense(org.licenseKey, machineId)
    const newStatus = licenseStatusFromResult(result)

    await bypassOrg(() =>
      db.organization.update({
        where: { id: org.id },
        data: {
          licenseStatus: newStatus,
          licensePlan: result.signatureVerified ? result.plan : undefined,
          licenseValidatedAt: result.signatureVerified && result.valid ? new Date() : undefined,
          // Preserve last known expiry when we got no definitive answer
          // (unreachable / unsigned) — a network blip must not wipe metadata.
          licenseExpiresAt: result.signatureVerified && result.expiresAt ? new Date(result.expiresAt) : undefined,
        },
      }),
    )

    return NextResponse.json({
      ok: true,
      license: {
        status: newStatus,
        plan: result.signatureVerified ? result.plan : undefined,
        expiresAt: result.signatureVerified ? result.expiresAt : undefined,
        message: result.message,
      },
    })
  } catch (e) {
    return handleApiError(e, 'License retry failed.')
  }
}
