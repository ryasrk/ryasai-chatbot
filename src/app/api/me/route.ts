import { NextResponse } from 'next/server'
import { getActiveUser, handleApiError } from '@/lib/session'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        return NextResponse.json(user)
  } catch (err) {
    return handleApiError(err, 'Failed to load active user data.')
  }
}
