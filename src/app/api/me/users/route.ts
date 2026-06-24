import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser } from '@/lib/session'

/**
 * GET /api/me/users
 *   Returns all users in the active user's company — used to populate the
 *   user-switcher dropdown in the UI.
 */
export async function GET() {
  try {
    const user = await getActiveUser()

    const users = await db.user.findMany({
      where: { companyId: user.companyId },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarColor: true,
        isActive: true,
      },
    })

    return NextResponse.json({ items: users, currentUserId: user.userId })
  } catch (err) {
    console.error('[api/me/users] error:', err)
    return NextResponse.json(
      { error: 'Gagal memuat daftar pengguna.' },
      { status: 500 }
    )
  }
}
