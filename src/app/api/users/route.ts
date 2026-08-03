import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

/**
 * GET /api/users
 *   Lists all users in the active user's organization (id, name, email, role,
 *   avatarColor, isActive, createdAt). Any authenticated org member can view
 *   the team roster; mutations (role change, deactivate, invite) are admin-only.
 */
export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
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
