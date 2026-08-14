import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, writeAudit } from '@/lib/session'
import { restoreDocVersion } from '@/lib/doc-versioning'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string; versionId: string }>
}

export async function POST(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
        const { id, versionId } = await ctx.params
    const result = await restoreDocVersion(id, versionId)
    await writeAudit({
      userId: user.userId,
      action: 'DOC_VERSION_RESTORE',
      severity: 'warning',
      detail: { documentId: id, versionId, restoredTo: result.version, restored: result.restored },
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    return handleApiError(e, 'Failed to restore document version.')
  }
}
