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
    await getActiveUser()

    const users = await db.user.findMany({
      where: {},
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
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
