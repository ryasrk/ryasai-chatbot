import { NextRequest, NextResponse } from 'next/server'
import { getActiveUser, handleApiError, requireRole, writeAudit } from '@/lib/session'
import { listDocVersions, createDocVersion } from '@/lib/doc-versioning'
import { enterWithOrg } from '@/lib/prisma-tenant'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext) {
  try {
    enterWithOrg((await getActiveUser()).organizationId)
    const { id } = await ctx.params
    const versions = await listDocVersions(id)
    return NextResponse.json({ ok: true, versions })
  } catch (e) {
    return handleApiError(e, 'Failed to load document versions.')
  }
}

export async function POST(_req: NextRequest, ctx: RouteContext) {
  try {
    const user = await getActiveUser()
    enterWithOrg(user.organizationId)
    // A version snapshot/restore rewrites what the document answers with, so it is gated like PATCH/DELETE on the
    // document itself. Before 2026-10-04 any authenticated role, including viewer, could restore a version.
    requireRole(user, 'admin')
    const { id } = await ctx.params
    const snapshot = await createDocVersion(id)
    await writeAudit({
      userId: user.userId,
      action: 'DOC_VERSION_CREATE',
      severity: 'info',
      detail: { documentId: id, version: snapshot.version },
    })
    return NextResponse.json({ ok: true, version: snapshot }, { status: 201 })
  } catch (e) {
    return handleApiError(e, 'Failed to create document version.')
  }
}
