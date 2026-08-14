import { NextRequest, NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { getActiveUser, requireRole, handleApiError, writeAudit } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const VALID_ROLES = new Set(['admin', 'analyst', 'viewer'])

/**
 * POST /api/auth/invite
 *   Admin-only. Invites a team member by email.
 *   Body: { email: string, role?: string }  (role defaults to 'viewer')
 *
 *   - Validates email format, normalizes to lowercase
 *   - Rejects if email already belongs to a user in this org ("User already in
 *     this organization.") or another org ("Email already registered.")
 *   - Generates a 32-byte hex token, 7-day expiry
 *   - Creates (or refreshes an accepted/expired) Invitation record
 *   - Audit: USER_INVITED
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        requireRole(user, 'admin')

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { email, role } = body as Record<string, string | undefined>
    const normalizedEmail = email?.trim().toLowerCase()
    if (!normalizedEmail || !EMAIL_RE.test(normalizedEmail)) {
      return NextResponse.json({ error: 'A valid email is required.' }, { status: 400 })
    }

    const finalRole = role ?? 'viewer'
    if (!VALID_ROLES.has(finalRole)) {
      return NextResponse.json({ error: 'Invalid role.' }, { status: 400 })
    }

    // Global email uniqueness check (email is globally unique across orgs)
    const existingUser = await bypassOrg(() =>
      db.user.findUnique({ where: { email: normalizedEmail } }),
    )
    if (existingUser) {
      if (existingUser.organizationId === user.organizationId) {
        return NextResponse.json({ error: 'User already in this organization.' }, { status: 409 })
      }
      return NextResponse.json({ error: 'Email already registered.' }, { status: 409 })
    }

    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)

    // ponytail: @@unique([organizationId, email]) blocks re-creating an invite for
    // the same org+email. Refresh an existing accepted/expired invitation instead
    // of creating; reject only if a pending, unexpired one already exists.
    const existingInvite = await bypassOrg(() =>
      db.invitation.findUnique({
        where: {
          organizationId_email: { organizationId: user.organizationId, email: normalizedEmail },
        },
      }),
    )
    if (existingInvite && existingInvite.status === 'pending' && existingInvite.expiresAt > new Date()) {
      return NextResponse.json(
        { error: 'A pending invitation already exists for this email.' },
        { status: 409 },
      )
    }
    if (existingInvite) {
      await bypassOrg(() =>
        db.invitation.update({
          where: { id: existingInvite.id },
          data: { token, role: finalRole, expiresAt, status: 'pending', invitedBy: user.userId },
        }),
      )
    } else {
      await bypassOrg(() =>
        db.invitation.create({
          data: {
            organizationId: user.organizationId,
            email: normalizedEmail,
            role: finalRole,
            token,
            invitedBy: user.userId,
            expiresAt,
          },
        }),
      )
    }

    await writeAudit({
      userId: user.userId,
      action: 'USER_INVITED',
      detail: { email: normalizedEmail, role: finalRole },
    })

    const origin = req.nextUrl.origin
    return NextResponse.json({
      ok: true,
      inviteUrl: `${origin}/api/auth/accept-invite?token=${token}`,
      token,
    })
  } catch (e) {
    return handleApiError(e, 'Invitation failed.')
  }
}
