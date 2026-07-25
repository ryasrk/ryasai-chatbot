import { getActiveUser, handleApiError } from '@/lib/session'
import { getRoutingScores } from '@/lib/smart-router'

export async function GET() {
  try {
    await getActiveUser()
    const data = await getRoutingScores()
    return Response.json({ ok: true, ...data })
  } catch (e) {
    return handleApiError(e, 'Gagal memuat routing scores.')
  }
}
