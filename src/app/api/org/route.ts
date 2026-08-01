import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, handleApiError, requireRole, writeAudit } from '@/lib/session'

const ORG_SELECT = {
  id: true,
  name: true,
  slug: true,
  brandingJson: true,
  licensePlan: true,
  licenseStatus: true,
  licenseExpiresAt: true,
} as const

/**
 * GET /api/org
 *   Returns the current user's organization info. Any authenticated user.
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    const organization = await bypassOrg(() =>
      db.organization.findUnique({
        where: { id: user.organizationId },
        select: ORG_SELECT,
      }),
    )
    if (!organization) {
      return NextResponse.json({ error: 'Organization not found.' }, { status: 404 })
    }
    return NextResponse.json({ ok: true, organization })
  } catch (e) {
    return handleApiError(e, 'Failed to load organization.')
  }
}

interface PatchBody {
  name?: string
  brandingJson?: string
}

/**
 * PATCH /api/org
 *   Update org name and/or branding. Admin only.
 */
export async function PATCH(req: NextRequest) {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')

    const body = (await req.json().catch(() => ({}))) as PatchBody
    const data: { name?: string; brandingJson?: string } = {}
    if (typeof body.name === 'string' && body.name.trim()) {
      data.name = body.name.trim()
    }
    if (typeof body.brandingJson === 'string') {
      data.brandingJson = body.brandingJson
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const updated = await bypassOrg(() =>
      db.organization.update({
        where: { id: user.organizationId },
        data,
        select: ORG_SELECT,
      }),
    )

    await writeAudit({
      userId: user.userId,
      action: 'ORG_UPDATED',
      detail: { fields: Object.keys(data) },
    })

    return NextResponse.json({ ok: true, organization: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update organization.')
  }
}
