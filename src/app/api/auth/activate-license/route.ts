import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError } from '@/lib/session'
import { validateLicense, generateMachineId } from '@/lib/license-client'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/auth/activate-license
 *   Step 2 of signup: validate license key and activate the org.
 *   User must be logged in (session cookie from register step).
 *
 *   Body: { licenseKey, organizationName? }
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { licenseKey, organizationName } = body as Record<string, string>
    if (!licenseKey) {
      return NextResponse.json({ error: 'License key is required.' }, { status: 400 })
    }

    const org = await bypassOrg(() =>
      db.organization.findUnique({
        where: { id: user.organizationId },
        select: { id: true, slug: true, name: true },
      }),
    )
    if (!org) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 })
    }

    const machineId = generateMachineId(org.slug)
    const result = await validateLicense(licenseKey.trim(), machineId)

    if (!result.valid) {
      return NextResponse.json(
        { error: `License validation failed: ${result.message}` },
        { status: 403 },
      )
    }

    await bypassOrg(() =>
      db.organization.update({
        where: { id: org.id },
        data: {
          licenseKey: licenseKey.trim(),
          licensePlan: result.plan,
          licenseStatus: 'valid',
          licenseValidatedAt: new Date(),
          licenseExpiresAt: result.expiresAt ? new Date(result.expiresAt) : null,
          ...(organizationName ? { name: organizationName.trim() } : {}),
        },
      }),
    )

    return NextResponse.json({
      ok: true,
      license: {
        plan: result.plan,
        expiresAt: result.expiresAt,
      },
    })
  } catch (e) {
    return handleApiError(e, 'License activation failed.')
  }
}
