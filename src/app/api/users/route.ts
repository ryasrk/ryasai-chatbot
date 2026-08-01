import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, requireRole, handleApiError } from '@/lib/session'

/**
 * GET /api/users
 *   Lists all users in the active user's organization (id, name, email, role,
 *   avatarColor, isActive, createdAt). Admin-only. Used by the Settings page.
 */
export async function GET() {
  try {
    const user = await getActiveUser()
    requireRole(user, 'admin')

    const users = await db.user.findMany({
      where: {},
      orderBy: [{ name: 'asc' }],
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
    return handleApiError(err, 'Failed to load user list.')
  }
}
