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
  /**
   * A member's role. Admin-only, and never your own — see the guards in PATCH. MEASURED IN UAT: this was ABSENT from
   * both the UI and the API, so a team could not promote a colleague at all; the finding was filed as "no UI path"
   * when the capability was missing one layer deeper.
   */
  role?: 'admin' | 'analyst' | 'viewer'
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
    const data: { name?: string; avatarColor?: string; role?: 'admin' | 'analyst' | 'viewer' } = {}

    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim()
    if (typeof body.avatarColor === 'string' && body.avatarColor.trim()) {
      data.avatarColor = body.avatarColor.trim()
    }
    /*
     * ROLE CHANGE, and it was genuinely absent: MEASURED IN UAT, a team with a new analyst had no way to make them
     * one — PATCH accepted only `name` and `avatarColor`, so the API could not do it either, and the finding was filed
     * as "no UI path" when the capability was missing one layer deeper.
     *
     * TWO GUARDS, because an unguarded role change is a privilege-escalation foot-gun:
     *   - only an ADMIN may set a role. `requireRole(user,'admin')` above runs only when the caller edits SOMEONE
     *     ELSE, which is exactly this case, so it already covers it;
     *   - an admin cannot change their OWN role. Otherwise the last admin locks the whole organisation out of user
     *     management with one request and no way back in. Self-service edits of name/avatar stay allowed.
     */
    if (body.role !== undefined) {
      const ROLES = ['admin', 'analyst', 'viewer'] as const
      if (typeof body.role !== 'string' || !(ROLES as readonly string[]).includes(body.role)) {
        return NextResponse.json(
          { ok: false, error: `Invalid role. Expected one of: ${ROLES.join(', ')}.` },
          { status: 400 },
        )
      }
      if (user.userId === id) {
        return NextResponse.json(
          { ok: false, error: 'You cannot change your own role. Ask another admin.' },
          { status: 400 },
        )
      }
      data.role = body.role as 'admin' | 'analyst' | 'viewer'
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
