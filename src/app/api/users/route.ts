import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'

/**
 * GET /api/users
 *   Lists all users in the active user's company (id, name, email, role,
 *   avatarColor, isActive). Used by the Settings page.
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
        createdAt: true,
      },
    })

    return NextResponse.json({ items: users })
  } catch (err) {
    return handleApiError(err, 'Gagal memuat daftar pengguna.')
  }
}
