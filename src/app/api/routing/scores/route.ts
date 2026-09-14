import { getActiveUser, handleApiError, requireRole } from '@/lib/session'
import { getRoutingScores } from '@/lib/smart-router'
import { enterWithOrg } from '@/lib/prisma-tenant'

export async function GET() {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // Admin-only, because the payload is a MAP OF THE ORG'S DATA SURFACE rather than a score:
    // `schemaKeywords`, `endpointKeywords` and `documentKeywords` are derived from real column names,
    // REST paths and document names, and `perfMetrics` exposes per-tool latency and failure rates.
    // That is reconnaissance a viewer has no reason to hold, and it is exactly what an attacker wants
    // before crafting a prompt-injection or a targeted query. Same gate as the other org-introspection
    // endpoints (`org`, `vector-store`, `rag/evaluate`).
    requireRole(user, 'admin')
    const data = await getRoutingScores()
    return Response.json({ ok: true, ...data })
  } catch (e) {
    return handleApiError(e, 'Failed to load routing scores.')
  }
}
