import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError } from '@/lib/session'
import { validateLicense, generateMachineId } from '@/lib/license-client'

/**
 * POST /api/license/retry
 *   Manually trigger license revalidation. Accessible even when locked down
 *   (user may still be logged in but getting 402 on other routes).
 */
export async function POST() {
  try {
    const user = await getActiveUser().catch(() => null)
    if (!user) {
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

    let newStatus: string
    if (result.signatureVerified && result.valid) {
      newStatus = 'valid'
    } else if (result.signatureVerified && !result.valid) {
      newStatus = result.message.includes('expired') ? 'expired'
        : result.message.includes('deactivated') ? 'suspended'
        : 'invalid'
    } else {
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
