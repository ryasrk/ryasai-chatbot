import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface RoleBody {
  role?: string
}

const VALID_ROLES = ['admin', 'analyst', 'viewer'] as const

/**
 * PATCH /api/users/[id]/role
 *   Change a team member's role. Admin-only. The tenant extension scopes the
 *   target lookup to the admin's organization, so a cross-org id yields a 404.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const { id } = await ctx.params
    const body = (await req.json().catch(() => ({}))) as RoleBody

    const newRole = body.role
    if (
      !newRole ||
      !VALID_ROLES.includes(newRole as (typeof VALID_ROLES)[number])
    ) {
      return NextResponse.json(
        { ok: false, error: 'Invalid role. Must be one of: admin, analyst, viewer.' },
        { status: 400 },
      )
    }

    const existing = await db.user.findFirst({ // nosemgrep
      where: { id },
      select: { id: true, role: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 })
    }

    const oldRole = existing.role
    const updated = await db.user
      .update({
        where: { id: existing.id },
        data: { role: newRole },
        select: { id: true, name: true, email: true, role: true, avatarColor: true, isActive: true },
      })
      .catch((e: unknown) => {
        if (isPrismaNotFound(e)) return null
        throw e
      })
    if (!updated) {
      return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 })
    }

    await writeAudit({
      userId: user.userId,
      action: 'USER_ROLE_CHANGED',
      severity: 'warning',
      detail: { userId: id, oldRole, newRole },
    })

    return NextResponse.json({ ok: true, user: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update user role.')
  }
}
