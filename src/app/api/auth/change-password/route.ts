import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyPassword, hashPassword } from '@/lib/passwords'
import { getActiveUser, writeAudit, handleApiError } from '@/lib/session'

/**
 * POST /api/auth/change-password
 *   Body: { currentPassword, newPassword }
 *   - 200 { ok: true } on success
 *   - 400 when newPassword < 8 chars or missing fields
 *   - 401 when currentPassword doesn't match
 */
export async function POST(req: NextRequest) {
  try {
    const user = await getActiveUser()
    const body = (await req.json().catch(() => ({}))) as {
      currentPassword?: string
      newPassword?: string
    }

    const currentPassword = body.currentPassword ?? ''
    const newPassword = body.newPassword ?? ''
    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { ok: false, error: 'Password lama dan baru wajib diisi.' },
        { status: 400 },
      )
    }
    if (newPassword.length < 8) {
      return NextResponse.json(
        { ok: false, error: 'Password baru minimal 8 karakter.' },
        { status: 400 },
      )
    }

    const dbUser = await db.user.findUnique({ where: { id: user.userId } })
    if (!dbUser) {
      return NextResponse.json({ ok: false, error: 'User tidak ditemukan.' }, { status: 404 })
    }

    if (!verifyPassword(currentPassword, dbUser.passwordHash)) {
      await writeAudit({
        userId: user.userId,
        action: 'PASSWORD_CHANGE_FAILED',
        severity: 'warning',
        detail: { reason: 'wrong current password' },
      })
      return NextResponse.json(
        { ok: false, error: 'Password lama salah.' },
        { status: 401 },
      )
    }

    await db.user.update({
      where: { id: user.userId },
      data: { passwordHash: hashPassword(newPassword) },
    })

    await writeAudit({
      userId: user.userId,
      action: 'PASSWORD_CHANGED',
      severity: 'info',
      detail: {},
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    return handleApiError(e, 'Gagal mengubah password.')
  }
}
