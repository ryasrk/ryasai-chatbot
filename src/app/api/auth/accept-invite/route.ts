import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg, enterWithOrg } from '@/lib/prisma-tenant'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { handleApiError, writeAudit } from '@/lib/session'

/**
 * GET /api/auth/accept-invite?token=...
 *   Public. Returns invitation details (email, org name, role) for the invite
 *   landing page. Does not accept the invite or create a user.
 *
 * POST /api/auth/accept-invite
 *   Public. Body: { token, name, password }. Creates the user, marks the
 *   invitation accepted, sets the session cookie, audit-logs the join.
 */

async function loadPendingInvitation(token: string | null) {
  if (!token) return null
  return bypassOrg(() => db.invitation.findUnique({ where: { token } }))
}

export async function GET(req: NextRequest) {
  try {
    const invitation = await loadPendingInvitation(req.nextUrl.searchParams.get('token'))
    if (!invitation) {
      return NextResponse.json({ error: 'Invalid or expired invitation.' }, { status: 400 })
    }
    if (invitation.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Invitation has expired.' }, { status: 400 })
    }
    if (invitation.status === 'accepted') {
      return NextResponse.json({ error: 'Invitation already used.' }, { status: 400 })
    }

    const org = await bypassOrg(() =>
      db.organization.findUnique({ where: { id: invitation.organizationId } }),
    )

    return NextResponse.json({
      ok: true,
      email: invitation.email,
      organizationName: org?.name ?? null,
      role: invitation.role,
    })
  } catch (e) {
    return handleApiError(e, 'Failed to load invitation.')
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { token, name, password } = body as Record<string, string | undefined>
    if (!token || !name?.trim() || !password) {
      return NextResponse.json(
        { error: 'Token, name, and password are required.' },
        { status: 400 },
      )
    }
    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    const invitation = await loadPendingInvitation(token)
    if (!invitation) {
      return NextResponse.json({ error: 'Invalid or expired invitation.' }, { status: 400 })
    }
    if (invitation.expiresAt <= new Date()) {
      return NextResponse.json({ error: 'Invitation has expired.' }, { status: 400 })
    }
    if (invitation.status === 'accepted') {
      return NextResponse.json({ error: 'Invitation already used.' }, { status: 400 })
    }

    // Email is globally unique — re-check in case a user registered after the invite was sent
    const existingUser = await bypassOrg(() =>
      db.user.findUnique({ where: { email: invitation.email } }),
    )
    if (existingUser) {
      return NextResponse.json({ error: 'Email already registered.' }, { status: 409 })
    }

    const user = await bypassOrg(() =>
      db.user.create({
        data: {
          email: invitation.email,
          name: name.trim(),
          passwordHash: hashPassword(password),
          role: invitation.role,
          organizationId: invitation.organizationId,
          sessionVersion: 1,
        },
      }),
    )

    await bypassOrg(() =>
      db.invitation.update({ where: { token }, data: { status: 'accepted' } }),
    )

    // ponytail: safety-net AppConfig — normally created at org setup, but ensure
    // one exists so the new user doesn't hit a missing-config error.
    const appConfig = await bypassOrg(() =>
      db.appConfig.findFirst({ where: { organizationId: invitation.organizationId } }),
    )
    if (!appConfig) {
      await bypassOrg(() =>
        db.appConfig.create({
          data: { organizationId: invitation.organizationId, setupCompleted: false },
        }),
      )
    }

    // writeAudit reads getOrgContext() — set the org context for the new user's org
    // since getActiveUser() (which normally sets it) was never called on this public route.
    enterWithOrg(invitation.organizationId)
    await writeAudit({
      userId: user.id,
      action: 'INVITATION_ACCEPTED',
      detail: { email: invitation.email, role: invitation.role },
    })

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email },
    })
    res.cookies.set('x-active-user', signSession(user.id, 1), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7,
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to accept invitation.')
  }
}
