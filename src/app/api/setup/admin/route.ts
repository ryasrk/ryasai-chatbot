import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/passwords'
import { signSession } from '@/lib/crypto'
import { normalizeSetupAdminInput, getSetupState } from '@/lib/setup'
import { writeAudit, handleApiError } from '@/lib/session'

/**
 * POST /api/setup/admin (public, but 409 once setupCompleted)
 *   Body: { name, email, password (min 8 chars) }
 *   Creates the singleton AppConfig if missing, upserts the admin
 *   user with a scrypt hash, auto-logs-in (sets the session cookie), and writes
 *   a SETUP_ADMIN_CREATED audit.
 */
export async function POST(req: NextRequest) {
  try {
    const state = await getSetupState(db)
    if (state.setupCompleted) {
      return NextResponse.json({ error: 'Setup sudah selesai.' }, { status: 409 })
    }
    const input = normalizeSetupAdminInput(await req.json().catch(() => null))
    if (!input) {
      return NextResponse.json(
        { error: 'Nama, email, dan password (min. 8 karakter) wajib diisi.' },
        { status: 400 },
      )
    }

    let appConfig = await db.appConfig.findFirst()
    if (!appConfig) appConfig = await db.appConfig.create({ data: {} })

    const user = await db.user.upsert({
      where: { email: input.email },
      create: {
        email: input.email,
        name: input.name,
        passwordHash: hashPassword(input.password),
        isActive: true,
      },
      update: {
        name: input.name,
        passwordHash: hashPassword(input.password),
        isActive: true,
      },
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
    return handleApiError(e, 'Gagal membuat akun admin.')
  }
}
