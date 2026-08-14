import { getActiveUser, handleApiError } from '@/lib/session'
import { getRoutingScores } from '@/lib/smart-router'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET() {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const data = await getRoutingScores()
    return Response.json({ ok: true, ...data })
  } catch (e) {
    return handleApiError(e, 'Failed to load routing scores.')
  }
}
