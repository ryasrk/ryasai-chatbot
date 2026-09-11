import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { validateLicense, generateMachineId, licenseStatusFromResult , licenseUpdateFromResult } from '@/lib/license-client'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/org/license
 *   Returns current license status for the org.
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const org = await bypassOrg(() =>
      db.organization.findUnique({
        where: { id: user.organizationId },
        select: {
          id: true, name: true, slug: true,
          licenseKey: true, licensePlan: true, licenseStatus: true,
          licenseValidatedAt: true, licenseExpiresAt: true,
        },
      }),
    )
    if (!org) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 })
    }
    return NextResponse.json({
      ok: true,
      license: {
        key: org.licenseKey,
        plan: org.licensePlan,
        status: org.licenseStatus,
        validatedAt: org.licenseValidatedAt,
        expiresAt: org.licenseExpiresAt,
      },
    })
  } catch (e) {
    return handleApiError(e, 'Failed to get license status.')
  }
}

/**
 * POST /api/org/license/revalidate
 *   Re-validates the license against the License-Validator service.
 *   Updates org license status. Admin only.
 */
export async function POST() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        if (user.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required.' }, { status: 403 })
    }

    const org = await bypassOrg(() =>
      db.organization.findUnique({
        where: { id: user.organizationId },
        select: { id: true, slug: true, licenseKey: true },
      }),
    )
    if (!org || !org.licenseKey) {
      return NextResponse.json({ error: 'No license key set for this organization.' }, { status: 400 })
    }

    const machineId = generateMachineId(org.slug)
    const result = await validateLicense(org.licenseKey, machineId)
    const newStatus = licenseStatusFromResult(result)

    await bypassOrg(() =>
      db.organization.update({
        where: { id: org.id },
        // ponytail: shared builder — see licenseUpdateFromResult(). It encodes
        // the two rules this block used to restate inline: never advance
        // licenseValidatedAt on an unsigned/unreachable answer (that would
        // silence the grace period) and never wipe a known expiry on a blip.
        data: licenseUpdateFromResult(result, { planFallback: 'flat' }),
      }),
    )

    await writeAudit({
      userId: user.userId,
      action: 'LICENSE_REVALIDATED',
      detail: { status: newStatus, message: result.message },
    })

    return NextResponse.json({
      ok: true,
      license: {
        status: newStatus,
        plan: result.plan,
        expiresAt: result.expiresAt,
        message: result.message,
      },
    })
  } catch (e) {
    return handleApiError(e, 'License re-validation failed.')
  }
}
