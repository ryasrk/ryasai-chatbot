import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { bypassOrg } from '@/lib/prisma-tenant'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { validateLicense, generateMachineId } from '@/lib/license-client'
import { handleApiError } from '@/lib/session'

/**
 * POST /api/auth/signup
 *   Body: { organizationName, slug, name, email, password, licenseKey }
 *
 * Flow:
 *   1. Validate license key against License-Validator
 *   2. Check slug + email are not taken
 *   3. Create Organization with license info
 *   4. Create admin User linked to org
 *   5. Create AppConfig for org
 *   6. Set session cookie → redirect to setup wizard
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })
    }

    const { organizationName, slug, name, email, password, licenseKey } = body as Record<string, string>

    if (!organizationName || !slug || !name || !email || !password || !licenseKey) {
      return NextResponse.json(
        { error: 'All fields are required: organizationName, slug, name, email, password, licenseKey.' },
        { status: 400 },
      )
    }

    const normalizedEmail = email.trim().toLowerCase()
    const normalizedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-')

    if (password.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters.' }, { status: 400 })
    }

    // 1. Validate license
    const machineId = generateMachineId(normalizedSlug)
    const licenseResult = await validateLicense(licenseKey.trim(), machineId)
    if (!licenseResult.valid) {
      return NextResponse.json(
        { error: `License validation failed: ${licenseResult.message}` },
        { status: 403 },
      )
    }

    // 2. Check uniqueness (bypass org context — no org exists yet)
    const existingOrg = await bypassOrg(() =>
      db.organization.findUnique({ where: { slug: normalizedSlug } }),
    )
    if (existingOrg) {
      return NextResponse.json({ error: 'Organization slug is already taken.' }, { status: 409 })
    }

    const existingUser = await bypassOrg(() =>
      db.user.findUnique({ where: { email: normalizedEmail } }),
    )
    if (existingUser) {
      return NextResponse.json({ error: 'Email is already registered.' }, { status: 409 })
    }

    // 3. Create organization with license info
    const org = await bypassOrg(() =>
      db.organization.create({
        data: {
          name: organizationName.trim(),
          slug: normalizedSlug,
          licenseKey: licenseKey.trim(),
          licensePlan: licenseResult.plan,
          licenseStatus: 'valid',
          licenseValidatedAt: new Date(),
          licenseExpiresAt: licenseResult.expiresAt ? new Date(licenseResult.expiresAt) : null,
        },
      }),
    )

    // 4. Create admin user
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

    // 5. Create AppConfig for org
    await bypassOrg(() =>
      db.appConfig.create({
        data: {
          organizationId: org.id,
          setupCompleted: false,
          organizationName: organizationName.trim(),
        },
      }),
    )

    // 6. Set session cookie
    const res = NextResponse.json({
      ok: true,
      user: { userId: user.id, name: user.name, email: user.email },
      organization: { id: org.id, name: org.name, slug: org.slug, plan: org.licensePlan },
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
    return handleApiError(e, 'Signup failed.')
  }
}
