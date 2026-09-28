import { NextRequest, NextResponse } from 'next/server'
import { db, isPrismaNotFound } from '@/lib/db'
import { getActiveUser, requireRole, writeAudit, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface ProfileBody {
  name?: string
  avatarColor?: string
}

/**
 * PATCH /api/users/[id]
 *   Update a user's profile (name, avatarColor). Any user can update their
 *   own profile; admins can update anyone. The tenant extension scopes the
 *   target lookup to the caller's organization, so a cross-org id yields 404.
 */
export async function PATCH(req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    const { id } = await ctx.params

    if (user.userId !== id) {
      requireRole(user, 'admin')
    }

    const body = (await req.json().catch(() => ({}))) as ProfileBody
    const data: { name?: string; avatarColor?: string } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.avatarColor === 'string' && body.avatarColor.trim()) {
      data.avatarColor = body.avatarColor.trim()
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No fields provided for update.' },
        { status: 400 },
      )
    }

    const existing = await db.user.findFirst({ // nosemgrep
      where: { id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 })
    }

    const updated = await db.user
      .update({
        where: { id: existing.id },
        data,
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
      action: 'USER_PROFILE_UPDATE',
      severity: 'info',
      detail: { userId: id, changes: data },
    })

    return NextResponse.json({ ok: true, user: updated })
  } catch (e) {
    return handleApiError(e, 'Failed to update user.')
  }
}

/**
 * DELETE /api/users/[id]
 *   Deactivate a user (soft delete: isActive = false). Admin-only. An admin
 *   cannot deactivate their own account. The tenant extension scopes the
 *   target lookup to the admin's organization, so a cross-org id yields 404.
 */
export async function DELETE(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    requireRole(user, 'admin')

    const { id } = await ctx.params

    if (user.userId === id) {
      return NextResponse.json(
        { ok: false, error: 'You cannot deactivate your own account.' },
        { status: 400 },
      )
    }

    const existing = await db.user.findFirst({ // nosemgrep
      where: { id },
      select: { id: true },
    })
    if (!existing) {
      return NextResponse.json({ ok: false, error: 'User not found.' }, { status: 404 })
    }

    await db.user
      .update({
        where: { id: existing.id },
        data: { isActive: false },
      })
      .catch((e: unknown) => {
        if (isPrismaNotFound(e)) return null
        throw e
      })

    await writeAudit({
      userId: user.userId,
      action: 'USER_DEACTIVATED',
      severity: 'warning',
      detail: { userId: id },
    })

    /*
     * The response SAYS WHAT HAPPENED. MEASURED IN UAT: this endpoint deactivates (a deliberate soft delete with its
     * own `USER_DEACTIVATED` audit action) but replied with a bare `{ ok: true }` — so a caller reading a 200 on a
     * DELETE verb as "the row is gone" was wrong.
     *
     * The row is NOT deleted, for a reason worth stating: `User.email` is `@unique` GLOBALLY, so a hard delete is the
     * only way to free an address for re-invite — and hard-deleting a user would orphan their audit history, chat
     * sessions and tool runs. Deactivation is the safer trade; the defect was the silence about it.
     */
    return NextResponse.json({
      ok: true,
      deactivated: true,
      note: 'The account is deactivated, not deleted: the row is kept so its audit history stays intact, and the email stays reserved.',
    })
  } catch (e) {
    return handleApiError(e, 'Failed to deactivate user.')
  }
}
