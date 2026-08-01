import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { handleApiError } from '@/lib/session'

/**
 * POST /api/auth/register
 *   Step 1 of signup: create user account with email + password.
 *   Creates a "pending" org (no license) and admin user.
 *   Sets session cookie. User then proceeds to license activation.
 *
 *   Body: { name, email, password }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { name, email, password } = body as Record<string, string>

    if (!name || !email || !password) {
      return NextResponse.json({ error: 'Name, email, and password are required.' }, { status: 400 })
    }

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()

    // Check email not taken
    const existing = await bypassOrg(() =>
      db.user.findUnique({ where: { email: normalizedEmail } }),
    )
    if (existing) {
      return NextResponse.json({ error: 'Email is already registered.' }, { status: 409 })
    }

    // Create pending org (no license yet)
    const slug = `org-${Date.now().toString(36)}`
    const org = await bypassOrg(() =>
      db.organization.create({
        data: {
          name: `${name}'s Organization`,
          slug,
          licenseStatus: 'none',
        },
      }),
    )

    // Create admin user
    const user = await bypassOrg(() =>
      db.user.create({
        data: {
          email: normalizedEmail,
          name: name.trim(),
          passwordHash: hashPassword(password),
          role: 'admin',
          organizationId: org.id,
          sessionVersion: 1,
        },
      }),
    )

    // Create AppConfig
    await bypassOrg(() =>
      db.appConfig.create({
        data: {
          organizationId: org.id,
          setupCompleted: false,
          organizationName: `${name}'s Organization`,
        },
      }),
    )

    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email },
      organization: { id: org.id, name: org.name, slug: org.slug },
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
    return handleApiError(e, 'Registration failed.')
  }
}
