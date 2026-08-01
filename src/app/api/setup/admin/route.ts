import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { normalizeSetupAdminInput, getSetupState } from '@/lib/setup'
import { writeAudit, handleApiError } from '@/lib/session'
import { bypassOrg } from '@/lib/prisma-tenant'

/**
 * POST /api/setup/admin (public, but 409 once setupCompleted)
 *   Body: { name, email, password (min 8 chars) }
 *   Creates the first Organization + AppConfig if missing, upserts the admin
 *   user with a scrypt hash, auto-logs-in (sets the session cookie), and writes
 *   a SETUP_ADMIN_CREATED audit.
 */
export async function POST(req: NextRequest) {
  try {
    const state = await bypassOrg(() => getSetupState(db))
    if (state.setupCompleted) {
      return NextResponse.json({ error: 'Setup already completed.' }, { status: 409 })
    }
    const input = normalizeSetupAdminInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json(
        { error: 'Name, email, and password (min. 8 characters) are required.' },
        { status: 400 },
      )
    }

    // ponytail: setup runs before any org context exists — bypassOrg for all
    // queries, create the first Organization explicitly.
    const user = await bypassOrg(async () => {
      let org = await db.organization.findFirst()
      if (!org) {
        org = await db.organization.create({
          data: { name: 'Default Organization', slug: 'default' },
        })
      }

      const existing = await db.appConfig.findFirst({ where: { organizationId: org.id } })
      if (!existing) {
        await db.appConfig.create({ data: { organizationId: org.id } })
      }

      return db.user.upsert({
        where: { email: input.email },
        create: {
          email: input.email,
          name: input.name,
          passwordHash: hashPassword(input.password),
          isActive: true,
          organizationId: org.id,
        },
        update: {
          name: input.name,
          passwordHash: hashPassword(input.password),
          isActive: true,
        },
      })
    })

    await writeAudit({
      userId: user.id,
      action: 'SETUP_ADMIN_CREATED',
      detail: { email: user.email },
    })

    const res = NextResponse.json({ ok: true }, { status: 201 })
    res.cookies.set('x-active-user', signSession(user.id), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 60 * 60 * 24 * 7, // 7 days
      path: '/',
    })
    return res
  } catch (e) {
    return handleApiError(e, 'Failed to create admin account.')
  }
}
